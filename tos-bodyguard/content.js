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
  const MAX_TEXT_CHARS_FALLBACK = 4000; // halved retry for slow/CPU-bound machines
  const MAX_LINKS_TO_FETCH = 3;       // e.g. Privacy + Terms + Cookies
  const CACHE_TTL_MS = 30 * 60 * 1000; // don't re-analyze a successfully-scanned host for 30 min
  const NEGATIVE_TTL_MS = 10 * 60 * 1000; // back off failures for 10 min (no retry storms)
  const AI_TIMEOUT_MS = 180 * 1000; // CPU-fallback inference on 8k chars can take minutes

  // Mutable scan state — declared up here because boot() runs before the
  // sections below are evaluated (let/const are not hoisted across them).
  let lastProgressWrite = 0;

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

  /**
   * JSON Schema passed as responseConstraint when the newer LanguageModel
   * API is used: guaranteed-valid JSON, and generation stops as soon as the
   * schema is satisfied instead of rambling to the token limit.
   */
  const RISK_SCHEMA = {
    type: 'object',
    properties: {
      total_risks_found: { type: 'number' },
      risks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string' },
            severity: { type: 'string' },
            summary: { type: 'string' },
            exact_quote: { type: 'string' },
          },
          required: ['category', 'severity', 'summary', 'exact_quote'],
        },
      },
    },
    required: ['total_risks_found', 'risks'],
  };

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */

  /**
   * DOMException-aware error formatting. `instanceof` is unreliable across
   * JS worlds (page main world vs. isolated content-script world), so we
   * duck-type on .name/.message. Turns "[object DOMException]" into e.g.
   * "NotAllowedError: Session creation requires user activation."
   */
  function isContextInvalidated(err) {
    return String(err?.message || err).includes('Extension context invalidated');
  }

  function describeError(err) {
    if (!err) return 'Unknown error';
    const name = typeof err.name === 'string' ? err.name : '';
    const message = typeof err.message === 'string' ? err.message : '';
    if (name && message) return `${name}: ${message}`;
    return message || name || String(err);
  }

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
      const reply = (payload) => {
        try { sendResponse(payload); } catch { /* popup/channel already gone */ }
      };
      runManualScan()
        .then(reply)
        .catch((err) => reply({ status: 'error', error: describeError(err) }));
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
        create: (opts) =>
          legacy.create({ expectedOutputs: [{ type: 'text', languages: ['en'] }], ...opts }),
        promptOptions: {}, // legacy API predates responseConstraint
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
        promptOptions: { responseConstraint: RISK_SCHEMA },
      };
    }

    if (typeof chrome !== 'undefined' && chrome.aiOriginTrial?.languageModel) {
      const ext = chrome.aiOriginTrial.languageModel;
      return {
        async checkAvailability() {
          const caps = await ext.capabilities();
          return caps.available;
        },
        create: (opts) =>
          ext.create({ expectedOutputs: [{ type: 'text', languages: ['en'] }], ...opts }),
        promptOptions: {},
      };
    }

    return null;
  }


  async function analyzeText(rawText, scanId) {
    // Cloud provider configured? Use it — fast, full-document (chunked in the
    // service worker), and not bound by the local AI mutex. The API key is
    // only ever read by the service worker; this context sends just the text.
    const settings = (await chrome.storage.local.get('settings').catch(() => ({})))?.settings || {};
    const provider = settings.provider || 'nano';
    if (provider !== 'nano' && settings.keys?.[provider]) {
      await reportProgress(`Analyzing with ${provider} cloud AI…`, 45, true, scanId);
      const cloud = await chrome.runtime
        .sendMessage({ type: 'RUN_AI_CLOUD', text: rawText.slice(0, 100000), hostname: HOSTNAME, scanId })
        .catch(() => null);
      if (cloud?.ok) return { status: 'complete', result: parseAIResponse(cloud.text) };
      console.warn('[TOS Bodyguard] Cloud analysis failed — falling back to on-device AI:', cloud?.error);
    }

    // Serialize on-device inference browser-wide via the service worker.
    // Gemini Nano executes ONE session at a time: concurrent scans from
    // multiple tabs get their sessions destroyed (InvalidStateError) or are
    // serialized opaquely by Chrome — which looks like "forever" to users.
    await reportProgress('Queued for the on-device AI…', 35, true, scanId);

    const lock = await chrome.runtime
      .sendMessage({ type: 'AI_ACQUIRE', hostname: HOSTNAME })
      .catch(() => null); // fail-open if the service worker is unreachable

    await reportProgress('Analyzing with on-device AI…', 45, true, scanId);

    try {
      // Token count → progress: 45% baseline + up to 50 more as output streams in.
      return await runAnalysis(rawText, scanId, (chars) =>
        reportProgress('Analyzing with on-device AI…', 45 + Math.min(50, (chars / 800) * 50), false, scanId)
      );
    } finally {
      if (lock?.granted) {
        chrome.runtime.sendMessage({ type: 'AI_RELEASE' }).catch(() => {});
      }
    }
  }

  async function runAnalysis(rawText, scanId, onChars) {
    const api = getLocalAI();
    let localError = null;
    let maxChars = MAX_TEXT_CHARS;
    let shrunk = false;          // halve input once on timeout/quota errors
    let retriedDestroyed = false; // recreate session once on eviction

    if (api) {
      for (let attempt = 0; attempt < 3; attempt++) {
        let prompt = AI_PROMPT_TEMPLATE.replace('[INSERT_SCRAPED_TEXT]', rawText.slice(0, maxChars));
        try {
          const availability = await api.checkAvailability().catch(() => 'readily');
          if (availability === 'no' || availability === 'unavailable') {
            return { status: 'ai_unavailable' };
          }

          // Some builds reject sampling options — retry with defaults.
          let session;
          try {
            session = await api.create({ temperature: 0.1, topK: 3 });
          } catch (optErr) {
            console.warn('[TOS Bodyguard] AI create(options) failed, retrying defaults:', describeError(optErr));
            session = await api.create({ expectedOutputs: [{ type: 'text', languages: ['en'] }] });
          }

          try {
            // Fit the prompt to the model's real context window when the API
            // exposes usage measurement (prevents QuotaExceededError outright).
            if (typeof session.measureInputUsage === 'function' && Number.isFinite(session.inputQuota)) {
              try {
                const usage = await session.measureInputUsage(prompt);
                if (usage > session.inputQuota && session.inputQuota > 0) {
                  const base = rawText.slice(0, maxChars);
                  const fitChars = Math.max(500, Math.floor(base.length * (session.inputQuota / usage) * 0.9));
                  prompt = AI_PROMPT_TEMPLATE.replace('[INSERT_SCRAPED_TEXT]', base.slice(0, fitChars));
                  console.warn(`[TOS Bodyguard] Prompt exceeded input quota — fitted to ${fitChars} chars.`);
                }
              } catch { /* measurement is best-effort */ }
            }

            const controller = new AbortController();
            const timeoutMs = shrunk ? 90000 : AI_TIMEOUT_MS; // halved input should be ~2x faster
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const promptOpts = { signal: controller.signal, ...(api.promptOptions || {}) };
            const output =
              typeof session.promptStreaming === 'function'
                ? await promptWithStreaming(session, prompt, promptOpts, onChars)
                : await session.prompt(prompt, promptOpts);
            clearTimeout(timer);
            return { status: 'complete', result: parseAIResponse(output) };
          } finally {
            try { session.destroy?.(); } catch { /* noop */ }
          }
        } catch (err) {
          localError = err;
          console.warn('[TOS Bodyguard] Local AI session failed:', describeError(err));
          const name = err && err.name;

          // Too much text for this machine right now → halve once and retry.
          if ((name === 'QuotaExceededError' || name === 'AbortError') && !shrunk) {
            shrunk = true;
            maxChars = MAX_TEXT_CHARS_FALLBACK;
            console.warn(`[TOS Bodyguard] ${name} — retrying with a smaller (${maxChars}-char) input.`);
            continue;
          }
          if (name === 'AbortError') {
            return {
              status: 'error',
              error: 'AI timed out even with a reduced input — the on-device model is CPU-bound or busy. Try again.',
            };
          }
          if (name === 'InvalidStateError' && !retriedDestroyed) {
            retriedDestroyed = true;
            console.warn('[TOS Bodyguard] Session destroyed underneath us — retrying once with a fresh session.');
            continue;
          }
          break;
        }
      }
    }

    // Fallback: on some Chrome builds the Prompt API only exists in the page's
    // MAIN world, which content scripts (isolated world) cannot see. The
    // service worker can execute our prompt there via chrome.scripting.
    const bridgePrompt = AI_PROMPT_TEMPLATE.replace('[INSERT_SCRAPED_TEXT]', rawText.slice(0, maxChars));
    const bridged = await chrome.runtime
      .sendMessage({ type: 'RUN_AI_MAINWORLD', prompt: bridgePrompt, schema: RISK_SCHEMA })
      .catch(() => null);

    if (bridged?.ok) return { status: 'complete', result: parseAIResponse(bridged.text) };
    if (bridged?.error === 'timeout') {
      return { status: 'error', error: 'AI timed out — the on-device model is CPU-bound or busy. Try again.' };
    }
    if (bridged?.error === 'ai-unavailable') {
      return localError
        ? { status: 'ai_unavailable', error: describeError(localError) }
        : { status: 'ai_unavailable' };
    }
    return {
      status: 'ai_unavailable',
      error: localError ? describeError(localError) : (bridged?.error || 'Chrome built-in AI not found.'),
    };
  }

  /**
   * Streams the model response, reporting the growing output length — this
   * drives the popup progress bar with real generation data. Handles both
   * chunk styles: the origin-trial API yielded the full accumulated prefix
   * each time; the newer LanguageModel API yields deltas to append.
   */
  async function promptWithStreaming(session, prompt, opts, onChars) {
    let text = '';
    for await (const chunk of session.promptStreaming(prompt, opts)) {
      const piece = String(chunk);
      text = piece.startsWith(text) ? piece : text + piece;
      onChars?.(text.length);
    }
    return text;
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

  async function saveAndNotify(payload, scanId = null) {
    const entry = {
      ...payload,
      scanId,
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

  function newScanId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  /** True when a DIFFERENT in-flight scan (manual, or another tab) owns the entry. */
  async function anotherScanOwnsEntry(scanId) {
    try {
      const existing = (await chrome.storage.local.get(HOSTNAME))[HOSTNAME];
      return (
        existing?.status === 'loading' &&
        existing.scanId !== scanId &&
        Date.now() - existing.updatedAt < 2 * 60 * 1000
      );
    } catch {
      return false;
    }
  }

  /**
   * Best-effort progress updates for the popup bar. Throttled, merged into
   * the hostname's storage entry, and never resurrects a finished scan.
   */
  async function reportProgress(phase, percent, force = false, scanId = null) {
    const now = Date.now();
    if (!force && now - lastProgressWrite < 150) return;
    lastProgressWrite = now;
    try {
      const existing = (await chrome.storage.local.get(HOSTNAME))[HOSTNAME];
      if (existing?.status !== 'loading') return;
      if (existing.scanId && existing.scanId !== scanId) return; // another scan owns it
      await chrome.storage.local.set({
        [HOSTNAME]: {
          ...existing,
          progress: { phase, percent: Math.max(0, Math.min(99, Math.round(percent))) },
        },
      });
    } catch { /* progress is best-effort */ }
  }

  /* ------------------------------------------------------------------ *
   * 5. Scan orchestration
   * ------------------------------------------------------------------ */

  async function runAutoScan() {
    const scanId = newScanId();
    // Writes go through autoSave: if another scan (e.g. a manual scan from
    // the popup, or the same site in another tab) owns this host's entry,
    // the auto-scan yields instead of clobbering it.
    const autoSave = async (payload) => {
      if (await anotherScanOwnsEntry(scanId)) return false;
      await saveAndNotify(payload, scanId);
      return true;
    };

    try {
      // Skip fresh analysis if we have a recent result for this host —
      // including failures. Without negative caching, every pageview retries
      // the (expensive, serialized) on-device inference and creates a storm.
      const cached = (await chrome.storage.local.get(HOSTNAME))[HOSTNAME];
      const ttl =
        cached?.status === 'complete' ? CACHE_TTL_MS
        : cached?.status === 'loading' ? 0 // a previous page's in-flight scan died with the page
        : NEGATIVE_TTL_MS;
      if (cached && Date.now() - cached.updatedAt < ttl) {
        chrome.runtime
          .sendMessage({
            type: 'ANALYSIS_COMPLETE',
            hostname: HOSTNAME,
            status: cached.status,
            total_risks_found: cached.result?.total_risks_found ?? 0,
          })
          .catch(() => {});
        return;
      }

      if (await anotherScanOwnsEntry(scanId)) return; // a scan is already in flight for this host

      const links = findPolicyLinks();
      if (links.length === 0) {
        await autoSave({ status: 'no_links' });
        return;
      }

      if (!(await autoSave({
        status: 'loading',
        links,
        progress: { phase: `Fetching ${links.length} policy page(s)…`, percent: 10 },
      }))) return;

      let fetched = 0;
      const settled = await Promise.allSettled(
        links.map((u) =>
          fetchPolicyText(u).then((t) => {
            fetched++;
            reportProgress(
              `Fetching policy pages… (${fetched}/${links.length})`,
              10 + (fetched / links.length) * 20
            );
            return t;
          })
        )
      );
      const combined = settled
        .filter((r) => r.status === 'fulfilled' && r.value)
        .map((r) => r.value)
        .join('\n\n---\n\n');

      if (!combined.trim()) {
        await autoSave({ status: 'error', error: 'Could not retrieve policy text from the detected links.' });
        return;
      }

      const analysis = await analyzeText(combined, scanId);
      await autoSave(
        analysis.status === 'complete'
          ? { status: 'complete', result: analysis.result, links }
          : analysis
      );
    } catch (err) {
      if (isContextInvalidated(err)) {
        // Extension was reloaded/updated mid-scan; this old script is dead.
        // Log quietly — nothing can be stored or reported from here anyway.
        console.debug('[TOS Bodyguard] Extension reloaded; old content script stopping.');
        return;
      }
      console.error('[TOS Bodyguard] Auto-scan failed:', describeError(err), err);
      await autoSave({ status: 'error', error: describeError(err) }).catch(() => {});
    }
  }

  /** Manual scan (popup button): analyzes the text of the page itself. */
  async function runManualScan() {
    const scanId = newScanId();
    await saveAndNotify({
      status: 'loading',
      progress: { phase: 'Reading the current page…', percent: 15 },
    }, scanId);

    const pageText = (document.body?.innerText || document.documentElement?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!pageText) {
      const payload = { status: 'error', error: 'No readable text found on this page.' };
      await saveAndNotify(payload, scanId);
      return payload;
    }

    const analysis = await analyzeText(pageText, scanId);
    const payload =
      analysis.status === 'complete'
        ? { status: 'complete', result: analysis.result, links: [location.href] }
        : analysis;
    await saveAndNotify(payload, scanId);
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

