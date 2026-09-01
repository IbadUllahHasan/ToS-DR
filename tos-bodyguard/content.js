/**
 * TOS Bodyguard — Content Script
 * ------------------------------
 * 1. Finds "Privacy Policy" / "Terms of Service" links (footer-first).
 * 2. Fetches & extracts their text (service-worker fallback for CORS-blocked URLs).
 * 3. Analyzes the text with Chrome's built-in on-device AI (Gemini Nano, Prompt API).
 * 4. Stores the parsed risk report in chrome.storage.local, keyed by hostname.
 * 5. Auto-rejects cookie banners using rules.json.
 *
 * Everything runs locally. No page text ever leaves the machine.
 */
(() => {
  'use strict';

  // Guard against double-injection (auto content script + manual inject from popup).
  if (window.__tosBodyguardLoaded) return;
  window.__tosBodyguardLoaded = true;

  // Only run in the top frame — iframes would duplicate analysis & storage writes.
  if (window.top !== window) return;

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  const HOSTNAME = location.hostname;
  const MAX_TEXT_CHARS = 8000;        // stay well inside Gemini Nano's context window
  const MAX_LINKS_TO_FETCH = 3;       // e.g. Privacy + Terms + Cookies
  const CACHE_TTL_MS = 30 * 60 * 1000; // don't re-analyze the same host for 30 min
  const AI_TIMEOUT_MS = 90 * 1000;

  /**
   * The exact analysis prompt. The scraped text is injected in place of
   * [INSERT_SCRAPED_TEXT]. (Backticks are escaped only to satisfy JS template
   * literal syntax — the runtime string is character-for-character as specified.)
   */
  const AI_PROMPT_TEMPLATE = `You are a strict privacy analyzer. Read the text and identify clauses hostile to user privacy.
Scan for these 5 categories: DATA_RESALE, INFINITE_RETENTION, AGGRESSIVE_TRACKING, LEGAL_TRAPS, SHADOW_PROFILING.

CONSTRAINTS:
- ONLY flag a risk if explicitly stated.
- Output strictly in valid JSON format.
- Do NOT wrap in markdown blocks (no \`\`\`json).

OUTPUT SCHEMA:
{
  "total_risks_found": number,
  "risks": [
    {
      "category": "String (From the 5 categories)",
      "severity": "String (HIGH or MEDIUM)",
      "summary": "String (1-sentence plain English)",
      "exact_quote": "String (Verbatim quote from text)"
    }
  ]
}

TEXT TO ANALYZE:
[INSERT_SCRAPED_TEXT]`;

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  function boot() {
    handleCookieBanner(); // fire-and-forget, independent of the scan
    runAutoScan();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'MANUAL_SCAN') {
      runManualScan()
        .then(sendResponse)
        .catch((err) => sendResponse({ status: 'error', error: String(err?.message || err) }));
      return true; // async response
    }
    return false;
  });

  /* ------------------------------------------------------------------ *
   * 1. Policy link extraction
   * ------------------------------------------------------------------ */

  function findPolicyLinks() {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const scored = [];

    for (const a of anchors) {
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 80) continue;

      const href = a.href;
      if (!/^https?:/i.test(href)) continue;

      let score = 0;
      if (/privacy\s*(policy|notice|statement)?/i.test(text)) score += 3;
      if (/terms\s*(of\s*(service|use)|and\s*conditions|&\s*conditions)?/i.test(text)) score += 3;
      if (/cookie\s*(policy|notice|preferences)/i.test(text)) score += 2;
      if (/\b(privacy|terms)\b/i.test(href)) score += 1;
      // Footer/nav placement is a strong signal for policy links.
      if (a.closest('footer, [class*="footer" i], [id*="footer" i], nav')) score += 2;

      if (score >= 3) scored.push({ href, score });
    }

    // Dedupe by URL, keeping the highest-scoring anchor for each.
    const byHref = new Map();
    for (const item of scored) {
      const prev = byHref.get(item.href);
      if (!prev || item.score > prev.score) byHref.set(item.href, item);
    }

    return Array.from(byHref.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_LINKS_TO_FETCH)
      .map((x) => x.href);
  }

  /* ------------------------------------------------------------------ *
   * 2. Text fetching & extraction
   * ------------------------------------------------------------------ */

  async function fetchPolicyText(url) {
    try {
      // Same-origin fetches work directly from the content script.
      const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return htmlToText(await res.text());
    } catch (err) {
      // Cross-origin policy hubs (e.g. trustcenter.vendor.com) are blocked by
      // CORS / page CSP in the content script — relay via the service worker,
      // which has host permissions and no CORS restriction.
      const resp = await chrome.runtime
        .sendMessage({ type: 'FETCH_TEXT', url })
        .catch(() => null);
      if (resp?.ok && resp.text) return resp.text;
      throw new Error(`Fetch failed for ${url}: ${resp?.error || err.message}`);
    }
  }

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc
      .querySelectorAll('script, style, noscript, svg, iframe, form, header, nav, footer')
      .forEach((el) => el.remove());
    return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
  }


  /* ------------------------------------------------------------------ *
   * 3. On-device AI analysis (Gemini Nano / Prompt API)
   * ------------------------------------------------------------------ */

  /**
   * Normalizes the various Prompt API surfaces Chrome has shipped:
   *   - window.ai.languageModel   (origin-trial era, Chrome 127+)
   *   - window.LanguageModel      (newer global namespace)
   *   - chrome.aiOriginTrial.*    (extension origin trial)
   * Returns null when none exist in this (isolated) world.
   */
  function getLocalAI() {
    const legacy = window.ai && window.ai.languageModel;
    if (legacy && typeof legacy.create === 'function') {
      return {
        async checkAvailability() {
          if (typeof legacy.capabilities === 'function') {
            const caps = await legacy.capabilities();
            return caps.available; // 'no' | 'readily' | 'after-download'
          }
          return 'readily';
        },
        create: (opts) => legacy.create(opts),
      };
    }

    if (typeof window.LanguageModel !== 'undefined' && typeof window.LanguageModel.create === 'function') {
      return {
        checkAvailability: () => window.LanguageModel.availability(), // 'unavailable' | 'downloadable' | 'available'
        create: (opts) =>
          window.LanguageModel.create({
            expectedOutputs: [{ type: 'text', languages: ['en'] }],
            ...opts,
          }),
      };
    }

    if (typeof chrome !== 'undefined' && chrome.aiOriginTrial?.languageModel) {
      const ext = chrome.aiOriginTrial.languageModel;
      return {
        async checkAvailability() {
          const caps = await ext.capabilities();
          return caps.available;
        },
        create: (opts) => ext.create(opts),
      };
    }

    return null;
  }


  async function analyzeText(rawText) {
    const text = rawText.slice(0, MAX_TEXT_CHARS);
    const prompt = AI_PROMPT_TEMPLATE.replace('[INSERT_SCRAPED_TEXT]', text);

    const api = getLocalAI();

    if (api) {
      const availability = await api.checkAvailability().catch(() => 'readily');
      if (availability === 'no' || availability === 'unavailable') {
        return { status: 'ai_unavailable' };
      }

      const session = await api.create({ temperature: 0.1, topK: 3 });
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
        const output = await session.prompt(prompt, { signal: controller.signal });
        clearTimeout(timer);
        return { status: 'complete', result: parseAIResponse(output) };
      } finally {
        try { session.destroy?.(); } catch { /* noop */ }
      }
    }

    // Fallback: on some Chrome builds the Prompt API only exists in the page's
    // MAIN world, which content scripts (isolated world) cannot see. The
    // service worker can execute our prompt there via chrome.scripting.
    const bridged = await chrome.runtime
      .sendMessage({ type: 'RUN_AI_MAINWORLD', prompt })
      .catch(() => null);

    if (bridged?.ok) return { status: 'complete', result: parseAIResponse(bridged.text) };
    if (bridged?.error === 'ai-unavailable') return { status: 'ai_unavailable' };
    return { status: 'ai_unavailable', error: bridged?.error || 'Chrome built-in AI not found.' };
  }

  /**
   * Strips accidental markdown fences and parses the model output.
   * Any failure degrades safely to an empty report (and logs the raw text).
   */
  function parseAIResponse(rawOutput) {
    const raw = String(rawOutput ?? '');
    try {
      let cleaned = raw.replace(/```json|```/g, '').trim();

      // Tolerate prose around the JSON by keeping the outermost { ... }.
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);

      const parsed = JSON.parse(cleaned);
      if (typeof parsed.total_risks_found !== 'number' || !Array.isArray(parsed.risks)) {
        throw new Error('Schema mismatch');
      }

      // Defensive sanitization: this data is rendered into the popup DOM.
      parsed.risks = parsed.risks.slice(0, 25).map((r) => ({
        category: String(r.category ?? 'UNKNOWN').slice(0, 60),
        severity: r.severity === 'HIGH' ? 'HIGH' : 'MEDIUM',
        summary: String(r.summary ?? '').slice(0, 500),
        exact_quote: String(r.exact_quote ?? '').slice(0, 1000),
      }));
      // Keep the headline number consistent with the sanitized list.
      parsed.total_risks_found = parsed.risks.length;
      return parsed;
    } catch (err) {
      console.error('[TOS Bodyguard] AI returned invalid JSON. Raw output:', raw, err);
      return { total_risks_found: 0, risks: [] };
    }
  }


  /* ------------------------------------------------------------------ *
   * 4. Persistence + badge notification
   * ------------------------------------------------------------------ */

  async function saveAndNotify(payload) {
    const entry = {
      ...payload,
      hostname: HOSTNAME,
      scannedUrl: location.href,
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ [HOSTNAME]: entry });

    try {
      await chrome.runtime.sendMessage({
        type: 'ANALYSIS_COMPLETE',
        hostname: HOSTNAME,
        status: payload.status,
        total_risks_found: payload.result?.total_risks_found ?? 0,
      });
    } catch { /* service worker may be restarting — badge will re-sync on tab events */ }
  }

  /* ------------------------------------------------------------------ *
   * 5. Scan orchestration
   * ------------------------------------------------------------------ */

  async function runAutoScan() {
    try {
      // Skip fresh analysis if we have a recent result for this host.
      const cached = (await chrome.storage.local.get(HOSTNAME))[HOSTNAME];
      if (cached?.status === 'complete' && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
        chrome.runtime
          .sendMessage({
            type: 'ANALYSIS_COMPLETE',
            hostname: HOSTNAME,
            status: 'complete',
            total_risks_found: cached.result?.total_risks_found ?? 0,
          })
          .catch(() => {});
        return;
      }

      const links = findPolicyLinks();
      if (links.length === 0) {
        await saveAndNotify({ status: 'no_links' });
        return;
      }

      await saveAndNotify({ status: 'loading', links });

      const settled = await Promise.allSettled(links.map(fetchPolicyText));
      const combined = settled
        .filter((r) => r.status === 'fulfilled' && r.value)
        .map((r) => r.value)
        .join('\n\n---\n\n');

      if (!combined.trim()) {
        await saveAndNotify({ status: 'error', error: 'Could not retrieve policy text from the detected links.' });
        return;
      }

      const analysis = await analyzeText(combined);
      await saveAndNotify(
        analysis.status === 'complete'
          ? { status: 'complete', result: analysis.result, links }
          : analysis
      );
    } catch (err) {
      console.error('[TOS Bodyguard] Auto-scan failed:', err);
      await saveAndNotify({ status: 'error', error: String(err?.message || err) }).catch(() => {});
    }
  }

  /** Manual scan (popup button): analyzes the text of the page itself. */
  async function runManualScan() {
    await saveAndNotify({ status: 'loading' });

    const pageText = (document.body?.innerText || document.documentElement?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!pageText) {
      const payload = { status: 'error', error: 'No readable text found on this page.' };
      await saveAndNotify(payload);
      return payload;
    }

    const analysis = await analyzeText(pageText);
    const payload =
      analysis.status === 'complete'
        ? { status: 'complete', result: analysis.result, links: [location.href] }
        : analysis;
    await saveAndNotify(payload);
    return payload;
  }

  /* ------------------------------------------------------------------ *
   * 6. Cookie-banner auto-reject (rules.json)
   * ------------------------------------------------------------------ */

  async function handleCookieBanner() {
    try {
      const res = await fetch(chrome.runtime.getURL('rules.json'));
      const rules = await res.json();

      const matched = rules.filter((r) => r && domainMatches(HOSTNAME, r.domain));
      if (matched.length === 0) return;

      // Banners often render late — try immediately, then watch the DOM briefly.
      if (tryReject(matched)) return;

      const observer = new MutationObserver(() => {
        if (tryReject(matched)) observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 10000); // stop watching after 10s
    } catch (err) {
      console.warn('[TOS Bodyguard] Cookie-banner rules failed:', err);
    }
  }

  function domainMatches(hostname, ruleDomain) {
    if (!ruleDomain) return false;
    if (ruleDomain === '*') return true;
    const d = ruleDomain.toLowerCase();
    return hostname === d || hostname.endsWith('.' + d);
  }

  function tryReject(rules) {
    for (const rule of rules) {
      let btn = null;
      try {
        btn = document.querySelector(rule.rejectSelector);
      } catch {
        continue; // invalid selector in a rule — skip it
      }
      if (btn && (btn.offsetParent !== null || btn.getClientRects().length > 0)) {
        btn.click();
        console.info(`[TOS Bodyguard] Auto-rejected cookie banner (${rule.cmp || rule.domain}).`);
        return true;
      }
    }
    return false;
  }
})();

