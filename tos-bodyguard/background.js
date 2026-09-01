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
      runPromptInMainWorld(sender.tab?.id, msg.prompt).then(sendResponse);
      return true; // async

    default:
      return false;
  }
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

async function runPromptInMainWorld(tabId, prompt) {
  if (!tabId || typeof prompt !== 'string') return { ok: false, error: 'bad-request' };
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [prompt],
      // Self-contained: no references to service-worker scope are allowed.
      func: async (promptText) => {
        try {
          let api = null;
          let availability = 'readily';

          if (window.ai?.languageModel?.create) {
            api = window.ai.languageModel;
            if (typeof api.capabilities === 'function') {
              availability = (await api.capabilities()).available;
            }
          } else if (typeof LanguageModel !== 'undefined') {
            api = LanguageModel;
            availability = await LanguageModel.availability();
          }

          if (!api) return { ok: false, error: 'ai-unavailable' };
          if (availability === 'no' || availability === 'unavailable') {
            return { ok: false, error: 'ai-unavailable' };
          }

          const session = await api.create({ temperature: 0.1, topK: 3 });
          try {
            const text = await session.prompt(promptText);
            return { ok: true, text: String(text) };
          } finally {
            try { session.destroy?.(); } catch { /* noop */ }
          }
        } catch (e) {
          return { ok: false, error: String(e?.message || e) };
        }
      },
    });
    return injection?.result ?? { ok: false, error: 'no-result' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

