/**
 * TOS Bodyguard — Popup
 * ---------------------
 * Reads the current tab's analysis from chrome.storage.local (keyed by
 * hostname) and renders it. All dynamic strings are assigned via
 * textContent — never innerHTML — because risk summaries and quotes are
 * derived from untrusted page text and model output.
 */
'use strict';

const CATEGORY_EMOJI = {
  DATA_RESALE: '💰',
  INFINITE_RETENTION: '♾️',
  AGGRESSIVE_TRACKING: '📡',
  LEGAL_TRAPS: '⚖️',
  SHADOW_PROFILING: '🕵️',
};

const state = { tab: null, hostname: null };

document.addEventListener('DOMContentLoaded', init);

async function init() {
  document.getElementById('scan-btn').addEventListener('click', onScanClick);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  state.hostname = hostnameOf(tab?.url);
  document.getElementById('hostname').textContent = state.hostname || 'unsupported page';

  if (!state.hostname) {
    renderInfo('🚫', 'This page can’t be scanned', 'Chrome internal pages, the Web Store, and new tabs are off-limits to extensions.');
    document.getElementById('scan-btn').disabled = true;
    return;
  }

  await loadAndRender();

  // Live-update while the popup is open (content script writes as it works).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[state.hostname]) loadAndRender();
  });
}

async function loadAndRender() {
  const data = await chrome.storage.local.get(state.hostname);
  render(data[state.hostname]);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render(entry) {
  const root = document.getElementById('content');
  root.replaceChildren();

  if (!entry || entry.status === 'loading') return renderLoading(root);

  switch (entry.status) {
    case 'complete':
      return renderResults(root, entry);
    case 'ai_unavailable':
      return renderAiUnavailable(root);
    case 'no_links':
      return renderInfo(
        '🔗',
        'No policy links found',
        'No Privacy Policy or Terms links were detected on this site’s page. Use “Scan Current Page” while viewing a policy to analyze it directly.'
      );
    case 'error':
    default:
      return renderInfo('⚠️', 'Analysis failed', entry.error || 'Something went wrong while analyzing this site.');
  }
}

function renderLoading(root) {
  root.replaceChildren();
  const wrap = el('div', 'flex flex-col items-center gap-3 py-8');
  const spinner = el('div', 'h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600');
  const label = el('p', 'text-sm text-slate-500 text-center', 'Analyzing policies with on-device AI…');
  const sub = el('p', 'text-xs text-slate-400 text-center', 'First run may take a moment while Gemini Nano warms up.');
  wrap.append(spinner, label, sub);
  root.append(wrap);
}

function renderResults(root, entry) {
  const result = entry.result || { total_risks_found: 0, risks: [] };
  const risks = Array.isArray(result.risks) ? result.risks : [];
  const total = result.total_risks_found ?? risks.length;
  const highCount = risks.filter((r) => r.severity === 'HIGH').length;

  // Risk score: HIGH counts 25, MEDIUM counts 10, capped at 100.
  const score = Math.min(100, highCount * 25 + (total - highCount) * 10);

  const header = el('div', 'mb-3 flex items-center gap-3 rounded-lg border p-3 ' +
    (total > 0 ? 'border-red-200 bg-red-50' : 'border-green-200 bg-green-50'));

  const scoreBox = el('div', 'text-center');
  scoreBox.append(
    el('div', 'text-3xl font-bold ' + (total > 0 ? 'text-red-600' : 'text-green-600'), String(score)),
    el('div', 'text-xs text-slate-500', 'risk score')
  );

  const summaryBox = el('div', 'flex-1');
  summaryBox.append(
    el('p', 'text-sm font-semibold ' + (total > 0 ? 'text-red-700' : 'text-green-700'),
      total > 0 ? `${total} hostile clause${total === 1 ? '' : 's'} found` : 'No hostile clauses found'),
    el('p', 'text-xs text-slate-500',
      total > 0 ? `${highCount} high severity · ${total - highCount} medium` : 'This policy looks clean (as far as we can tell).')
  );
  header.append(scoreBox, summaryBox);
  root.append(header);

  if (risks.length === 0) return;

  const list = el('div', 'space-y-2');
  for (const risk of risks) list.append(renderRiskCard(risk));
  root.append(list);
}

function renderRiskCard(risk) {
  const card = el('div', 'rounded-lg border border-slate-200 bg-white p-3 shadow-sm');

  const topRow = el('div', 'flex items-center justify-between gap-2');
  const emoji = CATEGORY_EMOJI[risk.category] || '⚠️';
  topRow.append(
    el('span', 'text-sm font-semibold', `${emoji} ${risk.category}`),
    el('span',
      'rounded-full px-2 py-0.5 text-xs font-bold ' +
        (risk.severity === 'HIGH' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'),
      risk.severity)
  );

  const summary = el('p', 'mt-1 text-sm text-slate-700', risk.summary);

  const details = el('details', 'mt-2');
  const toggle = el('summary', 'cursor-pointer select-none text-xs font-medium text-indigo-600', 'View exact quote');
  const quote = el('blockquote', 'mt-1 break-words border-l-2 border-slate-300 pl-2 text-xs italic text-slate-500', `“${risk.exact_quote}”`);
  details.append(toggle, quote);

  card.append(topRow, summary, details);
  return card;
}

function renderAiUnavailable(root) {
  renderInfo(
    '🤖',
    'Built-in AI unavailable',
    'Chrome Built-in AI is not enabled. Please enable it in chrome://flags.'
  );
}

function renderInfo(icon, title, message) {
  const root = document.getElementById('content');
  root.replaceChildren();
  const wrap = el('div', 'flex flex-col items-center gap-2 py-6 text-center');
  wrap.append(
    el('span', 'text-3xl', icon),
    el('p', 'text-sm font-semibold', title),
    el('p', 'text-xs text-slate-500', message)
  );
  root.append(wrap);
}

/** createElement helper — text is always assigned via textContent (XSS-safe). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}


/* ------------------------------------------------------------------ *
 * Manual scan
 * ------------------------------------------------------------------ */

async function onScanClick() {
  const btn = document.getElementById('scan-btn');
  btn.disabled = true;
  renderLoading(document.getElementById('content'));

  try {
    let resp = await sendScanMessage(state.tab.id);

    if (resp === null) {
      // Content script isn't in this tab (e.g. tab predates install) —
      // inject it programmatically, then retry once.
      await chrome.scripting.executeScript({
        target: { tabId: state.tab.id },
        files: ['content.js'],
      });
      resp = await sendScanMessage(state.tab.id);
    }

    if (resp) {
      render(resp);
    } else {
      renderInfo('⚠️', 'Cannot scan this page', 'The page may need a reload before TOS Bodyguard can attach to it.');
    }
  } catch (err) {
    renderInfo('⚠️', 'Cannot scan this page', String(err?.message || err));
  } finally {
    btn.disabled = false;
  }
}

function sendScanMessage(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'MANUAL_SCAN' }, (resp) => {
      // lastError means no content script listener on the other side.
      resolve(chrome.runtime.lastError ? null : resp);
    });
  });
}

function hostnameOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
}

