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

