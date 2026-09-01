/**
 * TOS Bodyguard — Service Worker
 * ------------------------------
 * 1. Updates the toolbar badge with the number of risks found
 *    (red when > 0, green when 0) and keeps it in sync across tabs.
 * 2. Relays cross-origin policy-page fetches for the content script
 *    (host permissions bypass CORS here; content scripts cannot).
 * 3. Fallback bridge that runs the Prompt API in the page's MAIN world
 *    for Chrome builds where window.ai is not exposed to content scripts.
 */
'use strict';

const BADGE_COLORS = {
  risk: '#D93025', // red — risks found
  safe: '#188038', // green — clean
  busy: '#5F6368', // gray — analyzing
  warn: '#F9AB00', // amber — error / AI unavailable
};

/* ------------------------------------------------------------------ *
 * Message handling
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  switch (msg.type) {
    case 'ANALYSIS_COMPLETE':
      applyBadge(sender.tab?.id, msg.status, msg.total_risks_found);
      sendResponse({ ok: true });
      return false;

    case 'FETCH_TEXT':
      fetchTextForContentScript(msg.url).then(sendResponse);
      return true; // async

    case 'RUN_AI_MAINWORLD':
      runPromptInMainWorld(sender.tab?.id, msg.prompt, msg.schema).then(sendResponse);
      return true; // async

    case 'RUN_AI_CLOUD':
      runCloudAnalysis(msg).then(sendResponse);
      return true; // async

    case 'CLOUD_TEST':
      cloudTest(msg).then(sendResponse);
      return true; // async

    case 'PING':
      // Lets the popup detect a stale service worker (popup/content scripts
      // reload from disk automatically; a resident SW does not).
      sendResponse({
        ok: true,
        version: chrome.runtime.getManifest().version,
        features: ['cloud', 'queue', 'mutex'],
      });
      return false;

    case 'AI_ACQUIRE':
      return acquireAiLock(sender, sendResponse, msg.hostname);

    case 'AI_RELEASE':
      releaseAiLockFor(sender);
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

/* ------------------------------------------------------------------ *
 * Browser-wide AI mutex
 * --------------------------------------------------------------------
 * Gemini Nano executes one session at a time. Without serialization,
 * concurrent scans from multiple tabs get their sessions destroyed by
 * Chrome (InvalidStateError) or queue invisibly. Content scripts acquire
 * this lock before any inference and release it when done.
 * ------------------------------------------------------------------ */

const AI_LOCK_MAX_HOLD_MS = 400000; // > worst case local(180s) + bridge(200s)
let aiLockHolder = null;            // { tabId, hostname, since, token }
const aiWaiters = [];               // FIFO: { tabId, hostname, sendResponse }
let aiLockTimer = null;

function acquireAiLock(sender, sendResponse, hostname) {
  const tabId = sender.tab?.id ?? null;
  if (!aiLockHolder) {
    grantAiLock(tabId, sendResponse, hostname);
  } else {
    aiWaiters.push({ tabId, hostname, sendResponse }); // response deferred until grant
  }
  publishQueueState();
  return true; // keep the message channel open
}

function grantAiLock(tabId, sendResponse, hostname) {
  const token = {};
  aiLockHolder = { tabId, hostname, since: Date.now(), token };
  clearTimeout(aiLockTimer);
  // Last-resort release if the holder's tab crashes without releasing.
  // (Best-effort: a suspending service worker may delay this timer; the
  // tabs.onRemoved / navigation handlers below are the reliable paths.)
  aiLockTimer = setTimeout(() => {
    if (aiLockHolder?.token === token) forceReleaseAiLock();
  }, AI_LOCK_MAX_HOLD_MS);
  try {
    sendResponse({ granted: true });
  } catch {
    forceReleaseAiLock(); // waiter vanished before grant
  }
}

function releaseAiLockFor(sender) {
  const tabId = sender.tab?.id ?? null;
  if (aiLockHolder && aiLockHolder.tabId === tabId) forceReleaseAiLock();
}

function forceReleaseAiLock() {
  aiLockHolder = null;
  clearTimeout(aiLockTimer);
  while (aiWaiters.length) {
    const next = aiWaiters.shift();
    try {
      grantAiLock(next.tabId, next.sendResponse, next.hostname);
      publishQueueState();
      return;
    } catch {
      // waiter's tab is gone — skip to the next one
    }
  }
  publishQueueState();
}

/** Mirrors the live queue into storage.session so the popup can render it. */
function publishQueueState() {
  const state = {
    current: aiLockHolder
      ? { hostname: aiLockHolder.hostname || null, tabId: aiLockHolder.tabId, since: aiLockHolder.since }
      : null,
    waiting: aiWaiters.map((w) => ({ hostname: w.hostname || null, tabId: w.tabId })),
  };
  try {
    chrome.storage.session?.set({ aiQueue: state }).catch(() => {});
  } catch { /* storage.session unavailable — queue display is best-effort */ }
}

// A tab that closes or navigates releases its content scripts — and any
// lock they held.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (aiLockHolder?.tabId === tabId) forceReleaseAiLock();
  for (let i = aiWaiters.length - 1; i >= 0; i--) {
    if (aiWaiters[i].tabId === tabId) aiWaiters.splice(i, 1);
  }
  publishQueueState();
});

/* ------------------------------------------------------------------ *
 * Badge management
 * ------------------------------------------------------------------ */

async function applyBadge(tabId, status, total = 0) {
  if (!tabId) return;
  try {
    if (status === 'complete') {
      const n = Number.isFinite(total) ? total : 0;
      await chrome.action.setBadgeText({ tabId, text: n > 99 ? '99+' : String(n) });
      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: n > 0 ? BADGE_COLORS.risk : BADGE_COLORS.safe,
      });
    } else if (status === 'loading') {
      await chrome.action.setBadgeText({ tabId, text: '…' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS.busy });
    } else if (status === 'error' || status === 'ai_unavailable') {
      await chrome.action.setBadgeText({ tabId, text: '!' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS.warn });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch { /* tab may already be gone */ }
}

// Re-sync the badge whenever the user switches tabs or a tab finishes loading,
// so the number always reflects the *current* tab's stored analysis.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncBadgeWithStorage(tabId, tab.url);
  } catch { /* noop */ }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    if (aiLockHolder?.tabId === tabId) forceReleaseAiLock();
    for (let i = aiWaiters.length - 1; i >= 0; i--) {
      if (aiWaiters[i].tabId === tabId) aiWaiters.splice(i, 1);
    }
    publishQueueState();
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
  if (changeInfo.status === 'complete' && tab.url) {
    syncBadgeWithStorage(tabId, tab.url);
  }
});

async function syncBadgeWithStorage(tabId, url) {
  const host = hostnameOf(url);
  if (!host) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }
  const data = await chrome.storage.local.get(host);
  const entry = data[host];
  if (entry) {
    applyBadge(tabId, entry.status, entry.result?.total_risks_found ?? 0);
  } else {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
}

function hostnameOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Cross-origin fetch relay (no DOMParser in service workers, so the
 * HTML is stripped with regexes — a fallback path only).
 * ------------------------------------------------------------------ */

async function fetchTextForContentScript(url) {
  try {
    if (typeof url !== 'string' || !/^https?:/i.test(url)) {
      throw new Error('Unsupported URL');
    }
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return { ok: true, text: stripHtml(html) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Cloud AI providers (optional fast alternative to on-device Nano)
 * --------------------------------------------------------------------
 * The API key is read here, in the service worker, straight from storage
 * — it is never sent to or visible in any page/content-script context.
 * Long policies are analyzed in overlapping chunks (map) and merged with
 * dedupe (reduce), so the WHOLE document is checked — not just the start.
 * ------------------------------------------------------------------ */

const CLOUD_PROVIDERS = {
  gemini:  { name: 'Google Gemini', defaultModel: 'gemini-2.5-flash' },
  groq:    { name: 'Groq',          defaultModel: 'llama-3.3-70b-versatile' },
  openai:  { name: 'OpenAI',        defaultModel: 'gpt-4o-mini' },
  minimax: { name: 'MiniMax',       defaultModel: 'MiniMax-Text-01' },
};

const CLOUD_MAX_TEXT = 100000;     // ~25k tokens — plenty for full policies
const CLOUD_CHUNK_SIZE = 12000;    // chars per analysis chunk
const CLOUD_CHUNK_OVERLAP = 400;   // catch clauses split across a boundary

/**
 * Stricter, plain-language prompt for cloud models (the on-device Nano path
 * keeps the original mandated prompt verbatim).
 */
const CLOUD_PROMPT_TEMPLATE = `You are a strict privacy analyzer. Read the text and identify clauses hostile to user privacy.
Scan for these 5 categories: DATA_RESALE, INFINITE_RETENTION, AGGRESSIVE_TRACKING, LEGAL_TRAPS, SHADOW_PROFILING.

CONSTRAINTS:
- Be thorough: review the ENTIRE text section by section. Real policies usually contain several issues — do not stop at the first one.
- Flag a risk whenever the text explicitly permits the practice; do not give the policy the benefit of the doubt.
- NEVER write generic filler like "your data may be shared" or "they can track you". Name WHO gets to do WHAT, specifically.
- Write for a smart 15-year-old: zero legalese, zero jargon.
- Output strictly in valid JSON format.
- Do NOT wrap in markdown blocks (no \`\`\`json).

OUTPUT SCHEMA:
{
  "total_risks_found": number,
  "risks": [
    {
      "category": "String (From the 5 categories)",
      "severity": "String (HIGH or MEDIUM)",
      "summary": "String (ONE short plain-English sentence naming the exact practice)",
      "explanation": "String (2-3 sentences in simple everyday words: what this clause lets the company do in practice, and a concrete example of how it could affect an ordinary user)",
      "exact_quote": "String (Verbatim quote from text)"
    }
  ]
}

TEXT TO ANALYZE:
[INSERT_SCRAPED_TEXT]`;

function chunkText(text) {
  if (text.length <= CLOUD_CHUNK_SIZE) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += CLOUD_CHUNK_SIZE - CLOUD_CHUNK_OVERLAP) {
    chunks.push(text.slice(i, i + CLOUD_CHUNK_SIZE));
  }
  return chunks;
}

async function callCloudProvider(provider, model, apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    let res;
    if (provider === 'gemini') {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
          }),
          signal: controller.signal,
        }
      );
    } else {
      const endpoints = {
        groq: 'https://api.groq.com/openai/v1/chat/completions',
        openai: 'https://api.openai.com/v1/chat/completions',
        minimax: 'https://api.minimax.io/v1/chat/completions',
      };
      const body = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.1 };
      if (provider !== 'minimax') body.response_format = { type: 'json_object' };
      res = await fetch(endpoints[provider], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${provider} HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    if (provider === 'gemini') {
      return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? '';
    }
    return data?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

function tolerantParseJson(raw) {
  try {
    let cleaned = String(raw ?? '').replace(/```json|```/g, '').trim();
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s !== -1 && e > s) cleaned = cleaned.slice(s, e + 1);
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/** Merge chunk results, dedupe by quote, cap at 25 risks. */
function mergeChunkResults(texts) {
  const risks = [];
  const seen = new Set();
  for (const text of texts) {
    const parsed = tolerantParseJson(text);
    if (!parsed || !Array.isArray(parsed.risks)) continue;
    for (const r of parsed.risks) {
      const key = String(r.exact_quote || r.summary || '')
        .toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      risks.push({
        category: String(r.category ?? 'UNKNOWN').slice(0, 60),
        severity: r.severity === 'HIGH' ? 'HIGH' : 'MEDIUM',
        summary: String(r.summary ?? '').slice(0, 500),
        explanation: String(r.explanation ?? '').slice(0, 800),
        exact_quote: String(r.exact_quote ?? '').slice(0, 1000),
      });
      if (risks.length >= 25) break;
    }
    if (risks.length >= 25) break;
  }
  return JSON.stringify({ total_risks_found: risks.length, risks });
}

/** SW-side progress write, guarded by the owning scan's id. */
async function reportCloudProgress(hostname, scanId, phase, percent) {
  if (!hostname) return;
  try {
    const existing = (await chrome.storage.local.get(hostname))[hostname];
    if (existing?.status !== 'loading' || (scanId && existing.scanId !== scanId)) return;
    await chrome.storage.local.set({
      [hostname]: { ...existing, progress: { phase, percent: Math.round(percent) } },
    });
  } catch { /* best-effort */ }
}

async function runCloudAnalysis({ text, hostname, scanId }) {
  try {
    const settings = (await chrome.storage.local.get('settings')).settings || {};
    const provider = settings.provider;
    const cfg = CLOUD_PROVIDERS[provider];
    if (!cfg) return { ok: false, error: 'unknown-provider' };
    const apiKey = settings.keys?.[provider];
    if (!apiKey) return { ok: false, error: 'no-api-key' };
    const model = settings.models?.[provider] || cfg.defaultModel;

    const chunks = chunkText(String(text || '').slice(0, CLOUD_MAX_TEXT));
    const results = new Array(chunks.length);
    let done = 0;
    let cursor = 0;

    // Two chunks in flight at a time — gentle on provider rate limits.
    async function worker() {
      while (cursor < chunks.length) {
        const i = cursor++;
        const prompt = CLOUD_PROMPT_TEMPLATE.replace('[INSERT_SCRAPED_TEXT]', chunks[i]);
        results[i] = await callCloudProvider(provider, model, apiKey, prompt)
          .catch((e) => `__ERROR__:${e.message}`);
        done++;
        reportCloudProgress(
          hostname, scanId,
          `Cloud analysis (${cfg.name}) — part ${done}/${chunks.length}`,
          45 + (done / chunks.length) * 50
        );
      }
    }
    await Promise.all([worker(), worker()]);

    const good = results.filter((r) => typeof r === 'string' && !r.startsWith('__ERROR__'));
    if (good.length === 0) {
      const firstErr = results.find((r) => typeof r === 'string' && r.startsWith('__ERROR__'));
      return { ok: false, error: firstErr ? firstErr.slice('__ERROR__:'.length) : 'cloud-failed' };
    }
    return { ok: true, text: mergeChunkResults(good), engine: `${cfg.name} · ${model}` };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function cloudTest({ provider, apiKey, model }) {
  try {
    const cfg = CLOUD_PROVIDERS[provider];
    if (!cfg) return { ok: false, error: 'Unknown provider' };
    if (!apiKey) return { ok: false, error: 'Enter an API key first' };
    const out = await callCloudProvider(provider, model || cfg.defaultModel, apiKey, 'Reply with the single word: ok');
    return out && out.trim() ? { ok: true } : { ok: false, error: 'Empty response' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/* ------------------------------------------------------------------ *
 * MAIN-world Prompt API bridge
 * ------------------------------------------------------------------ */

async function runPromptInMainWorld(tabId, prompt, schema) {
  if (!tabId || typeof prompt !== 'string') return { ok: false, error: 'bad-request' };

  // Hard cap: on CPU-bound machines inference can be slow, but never infinite.
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, error: 'timeout' }), 200000)
  );

  try {
    const raced = await Promise.race([
      chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [prompt, schema ?? null],
      // Self-contained: no references to service-worker scope are allowed.
      func: async (promptText, schema) => {
        try {
          let api = null;
          let availability = 'readily';
          let isNewApi = false;

          if (window.ai?.languageModel?.create) {
            api = window.ai.languageModel;
            if (typeof api.capabilities === 'function') {
              availability = (await api.capabilities()).available;
            }
          } else if (typeof LanguageModel !== 'undefined') {
            api = LanguageModel;
            isNewApi = true;
            availability = await LanguageModel.availability();
          }

          if (!api) return { ok: false, error: 'ai-unavailable' };
          if (availability === 'no' || availability === 'unavailable') {
            return { ok: false, error: 'ai-unavailable' };
          }

          let session;
          const outputs = { expectedOutputs: [{ type: 'text', languages: ['en'] }] };
          try {
            session = await api.create({ temperature: 0.1, topK: 3, ...outputs });
          } catch {
            session = await api.create(outputs); // some builds reject sampling options
          }
          try {
            // Structured output on the new API: valid JSON + generation stops
            // when the schema is satisfied (no repetition-loop runaway).
            const promptOpts = isNewApi && schema ? { responseConstraint: schema } : {};
            const text = await session.prompt(promptText, promptOpts);
            return { ok: true, text: String(text) };
          } finally {
            try { session.destroy?.(); } catch { /* noop */ }
          }
        } catch (e) {
          return { ok: false, error: String(e?.message || e) };
        }
      },
      }),
      timeout,
    ]);
    if (!Array.isArray(raced)) return raced; // timeout won the race
    return raced[0]?.result ?? { ok: false, error: 'no-result' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

