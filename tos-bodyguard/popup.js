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

const PROVIDER_DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash',
  groq: 'openai/gpt-oss-120b',
  openai: 'gpt-4o-mini',
  minimax: 'MiniMax-Text-01',
};

const PROVIDER_NAMES = {
  gemini: 'Google Gemini',
  groq: 'Groq',
  openai: 'OpenAI',
  minimax: 'MiniMax',
};

/** Human label for the currently-configured analysis engine. */
function engineLabel() {
  const s = state.settings;
  if (s?.provider && s.provider !== 'nano' && s.keys?.[s.provider]) {
    return `${PROVIDER_NAMES[s.provider] || s.provider} cloud AI`;
  }
  return 'on-device AI';
}

const state = {
  tab: null,
  hostname: null,
  settings: null,
  filter: { severity: 'all', category: 'all' },
  currentRisks: [],
};

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

  initTheme();
  await maybeShowOnboarding();

  // Stale-service-worker detection: popup/content scripts reload from disk
  // automatically; a resident service worker does not. If it predates the
  // cloud features, offer a one-click reload.
  const ping = await chrome.runtime.sendMessage({ type: 'PING' }).catch(() => null);
  if (!ping?.features?.includes('cloud')) {
    const banner = document.getElementById('reload-banner');
    banner.classList.remove('hidden');
    document.getElementById('reload-ext').addEventListener('click', () => chrome.runtime.reload());
  }

  await loadAndRender();
  await initSettings();

  // Live queue state (written by the service worker's AI mutex).
  const sess = await chrome.storage.session.get('aiQueue');
  renderQueue(sess.aiQueue);

  // Live-update while the popup is open (content script writes as it works).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[state.hostname]) loadAndRender();
    if (area === 'session' && changes.aiQueue) renderQueue(changes.aiQueue.newValue);
  });
}

async function loadAndRender() {
  const data = await chrome.storage.local.get(state.hostname);
  const entry = data[state.hostname];
  // Fast path: scan still loading and only the progress moved — patch the bar
  // in place instead of re-rendering (streaming writes several times a second).
  if (entry?.status === 'loading' && entry.progress && document.getElementById('progress-fill')) {
    updateProgressBar(entry.progress);
    return;
  }
  render(entry);
}

/* ------------------------------------------------------------------ *
 * Theme (light / dark; default follows the OS)
 * ------------------------------------------------------------------ */

async function initTheme() {
  const btn = document.getElementById('theme-toggle');
  const stored = await chrome.storage.local.get('theme').catch(() => ({}));
  let theme = stored.theme || 'auto';
  const media = matchMedia('(prefers-color-scheme: dark)');

  const apply = () => {
    const dark = theme === 'dark' || (theme === 'auto' && media.matches);
    document.body.classList.toggle('dark', dark);
    btn.textContent = dark ? '☀️' : '🌙';
  };
  apply();

  btn.addEventListener('click', async () => {
    theme = document.body.classList.contains('dark') ? 'light' : 'dark';
    await chrome.storage.local.set({ theme });
    apply();
  });
  media.addEventListener?.('change', () => { if (theme === 'auto') apply(); });
}

/* ------------------------------------------------------------------ *
 * First-run setup guide (shown once)
 * ------------------------------------------------------------------ */

async function maybeShowOnboarding() {
  const stored = await chrome.storage.local.get('hasSeenGuide').catch(() => ({}));
  if (stored.hasSeenGuide) return;
  const section = document.getElementById('onboarding');
  if (!section) return;
  section.classList.remove('hidden');
  document.getElementById('dismiss-onboarding').addEventListener('click', async () => {
    section.classList.add('hidden');
    await chrome.storage.local.set({ hasSeenGuide: true });
  });
}

/* ------------------------------------------------------------------ *
 * Settings: AI provider + API keys (stored locally, read only by the
 * service worker when making the actual request)
 * ------------------------------------------------------------------ */

async function initSettings() {
  const panel = document.getElementById('settings');
  const providerSel = document.getElementById('provider');
  const keyFields = document.getElementById('key-fields');
  const keyInput = document.getElementById('api-key');
  const modelInput = document.getElementById('model');
  const status = document.getElementById('settings-status');

  const stored = await chrome.storage.local.get('settings').catch(() => ({}));
  state.settings = { provider: 'nano', keys: {}, models: {}, ...(stored.settings || {}) };
  providerSel.value = state.settings.provider;
  syncProviderFields();
  updateEngineNote();

  document.getElementById('settings-toggle').addEventListener('click', () => {
    panel.classList.toggle('hidden');
  });

  providerSel.addEventListener('change', syncProviderFields);

  function syncProviderFields() {
    const p = providerSel.value;
    keyFields.classList.toggle('hidden', p === 'nano');
    keyInput.value = state.settings.keys?.[p] || '';
    modelInput.value = state.settings.models?.[p] || PROVIDER_DEFAULT_MODELS[p] || '';
    status.textContent = '';
  }

  document.getElementById('save-settings').addEventListener('click', async () => {
    const p = providerSel.value;
    state.settings = {
      provider: p,
      keys: { ...(state.settings.keys || {}), [p]: keyInput.value.trim() },
      models: { ...(state.settings.models || {}), [p]: modelInput.value.trim() || PROVIDER_DEFAULT_MODELS[p] },
    };
    await chrome.storage.local.set({ settings: state.settings });
    status.textContent = 'Saved ✓';
    updateEngineNote();
    setTimeout(() => { status.textContent = ''; }, 2500);
  });

  document.getElementById('test-key').addEventListener('click', async () => {
    status.textContent = 'Testing…';
    const resp = await chrome.runtime.sendMessage({
      type: 'CLOUD_TEST',
      provider: providerSel.value,
      apiKey: keyInput.value.trim(),
      model: modelInput.value.trim() || PROVIDER_DEFAULT_MODELS[providerSel.value],
    }).catch(() => null);
    status.textContent = resp?.ok ? 'Works ✓' : `Failed: ${resp?.error || 'no response'}`;
  });
}

function updateEngineNote() {
  const note = document.getElementById('engine-note');
  if (!note) return;
  const s = state.settings;
  if (s?.provider && s.provider !== 'nano' && s.keys?.[s.provider]) {
    note.textContent = `Engine: ${s.provider} · ${s.models?.[s.provider] || PROVIDER_DEFAULT_MODELS[s.provider]} · full-document scan`;
  } else {
    note.textContent = 'Engine: on-device Gemini Nano · 100% local · ⚙️ add a cloud API key for speed';
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render(entry) {
  const root = document.getElementById('content');
  root.replaceChildren();

  if (!entry || entry.status === 'loading') return renderLoading(root, entry);

  switch (entry.status) {
    case 'complete':
      return renderResults(root, entry);
    case 'ai_unavailable':
      return renderAiUnavailable(root, entry);
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

function renderLoading(root, entry) {
  root.replaceChildren();
  const wrap = el('div', 'flex flex-col items-center gap-3 py-8');
  const spinner = el('div', 'h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600');
  const label = el('p', 'text-sm text-slate-500 text-center', `Analyzing policies with ${engineLabel()}…`);
  wrap.append(spinner, label);
  if (entry?.progress) {
    wrap.append(buildProgressBar(entry.progress));
  } else {
    wrap.append(el('p', 'text-xs text-slate-400 text-center', 'On-device inference can take 1–3 min on CPU-only machines. Results cache for 30 min.'));
  }
  root.append(wrap);
}

function buildProgressBar(progress) {
  const box = el('div', 'mt-2 w-full');
  const label = el('p', 'mb-2 text-center text-xs text-slate-500', progress.phase || 'Working…');
  label.id = 'progress-label';
  const track = el('div', 'h-2 w-full overflow-hidden rounded-full bg-slate-200');
  const fill = el('div', 'h-2 rounded-full bg-indigo-600 transition-all');
  fill.id = 'progress-fill';
  fill.style.width = `${progress.percent || 0}%`;
  track.append(fill);
  box.append(label, track);
  return box;
}

function updateProgressBar(progress) {
  const fill = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  if (fill) fill.style.width = `${progress.percent || 0}%`;
  if (label && progress.phase) label.textContent = progress.phase;
}

/* ------------------------------------------------------------------ *
 * Live AI queue (which site is being read + which are waiting)
 * ------------------------------------------------------------------ */

function renderQueue(queueState) {
  const section = document.getElementById('queue');
  if (!section) return;
  section.replaceChildren();

  const current = queueState?.current;
  const waiting = Array.isArray(queueState?.waiting) ? queueState.waiting : [];

  if (!current && waiting.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  if (current) {
    const isMe = current.hostname === state.hostname;
    const row = el('div', 'flex items-center gap-2 text-xs text-slate-700');
    row.append(
      el('span', '', '🤖'),
      el('span', 'truncate font-semibold', current.hostname || 'unknown site'),
      el('span', 'text-slate-400', isMe ? '— reading this site now' : '— reading now')
    );
    section.append(row);
  }

  if (waiting.length > 0) {
    const names = [...new Set(waiting.map((w) => w.hostname || 'unknown site'))];
    const myPos = waiting.findIndex((w) => w.hostname === state.hostname);
    const row = el('div', 'mt-1 flex items-center gap-2 text-xs text-slate-500');
    row.append(
      el('span', '', '⏳'),
      el('span', 'truncate',
        `Queue: ${names.join(' · ')}` + (myPos >= 0 ? ` (this site is #${myPos + 1})` : ''))
    );
    section.append(row);
  }
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
  const scoreLine = el('div', 'flex items-baseline gap-1');
  scoreLine.append(
    el('span', 'text-3xl font-bold ' + (total > 0 ? 'text-red-600' : 'text-green-600'), String(score)),
    el('span', 'text-sm font-semibold text-slate-400', '/100')
  );
  scoreBox.append(scoreLine, el('div', 'text-xs text-slate-500', 'risk score'));

  const summaryBox = el('div', 'flex-1');
  summaryBox.append(
    el('p', 'text-sm font-semibold ' + (total > 0 ? 'text-red-700' : 'text-green-700'),
      total > 0 ? `${total} hostile clause${total === 1 ? '' : 's'} found` : 'No hostile clauses found'),
    el('p', 'text-xs text-slate-500',
      total > 0 ? `${highCount} high severity · ${total - highCount} medium` : 'This policy looks clean (as far as we can tell).')
  );
  header.append(scoreBox, summaryBox);
  root.append(header);

  if (entry.engine) {
    root.append(el('p', 'mb-3 text-center text-xs text-slate-400', `Analyzed by: ${entry.engine}`));
  }

  if (risks.length === 0) return;

  state.currentRisks = risks;
  root.append(buildFilterBar(risks));
  const list = el('div', 'space-y-2');
  list.id = 'risk-list';
  renderRiskList(list, risks);
  root.append(list);
}

function filteredRisks(risks) {
  return risks.filter(
    (r) =>
      (state.filter.severity === 'all' || r.severity === state.filter.severity) &&
      (state.filter.category === 'all' || r.category === state.filter.category)
  );
}

function buildFilterBar(risks) {
  const bar = el('div', 'mb-2 flex flex-wrap items-center gap-1');
  bar.id = 'filter-bar';

  const counts = {
    all: risks.length,
    HIGH: risks.filter((r) => r.severity === 'HIGH').length,
    MEDIUM: risks.filter((r) => r.severity === 'MEDIUM').length,
  };
  for (const [key, label] of [['all', 'All'], ['HIGH', '🔴 High'], ['MEDIUM', '🟡 Medium']]) {
    const chip = el('button', 'chip' + (state.filter.severity === key ? ' chip-active' : ''), `${label} (${counts[key]})`);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      state.filter.severity = key;
      refreshRiskList();
    });
    bar.append(chip);
  }

  const cats = [...new Set(risks.map((r) => r.category))];
  if (cats.length > 1) {
    const sel = el('select', 'rounded-lg border border-slate-300 px-2 py-1 text-xs');
    const allOpt = el('option', '', 'All categories');
    allOpt.value = 'all';
    sel.append(allOpt);
    for (const c of cats) {
      const o = el('option', '', `${CATEGORY_EMOJI[c] || '⚠️'} ${c}`);
      o.value = c;
      sel.append(o);
    }
    sel.value = state.filter.category;
    sel.addEventListener('change', () => {
      state.filter.category = sel.value;
      refreshRiskList();
    });
    bar.append(sel);
  }
  return bar;
}

/** Re-render only the filter bar + list (header/score stay put). */
function refreshRiskList() {
  const bar = document.getElementById('filter-bar');
  if (bar) bar.replaceWith(buildFilterBar(state.currentRisks));
  const list = document.getElementById('risk-list');
  if (list) renderRiskList(list, state.currentRisks);
}

function renderRiskList(list, risks) {
  list.replaceChildren();
  const shown = filteredRisks(risks);
  if (shown.length === 0) {
    list.append(el('p', 'py-4 text-center text-xs text-slate-400', 'No risks match this filter.'));
    return;
  }
  for (const risk of shown) list.append(renderRiskCard(risk));
}

function renderRiskCard(risk) {
  const card = el('details', 'rounded-lg border border-slate-200 bg-white p-3 shadow-sm');

  // Collapsed row: emoji + category + summary preview + severity chip.
  const row = el('summary', 'flex cursor-pointer select-none items-center justify-between gap-2');
  const left = el('span', 'min-w-0 flex-1');
  left.append(
    el('span', 'text-sm font-semibold', `${CATEGORY_EMOJI[risk.category] || '⚠️'} ${risk.category}`),
    el('span', 'block truncate text-xs font-normal text-slate-500', risk.summary)
  );
  row.append(
    left,
    el('span',
      'rounded-full px-2 py-0.5 text-xs font-bold ' +
        (risk.severity === 'HIGH' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'),
      risk.severity)
  );

  // Expanded body: AI-written explanation (when present) + verbatim quote.
  const body = el('div', 'mt-2');
  body.append(el('p', 'text-sm text-slate-700', risk.summary));
  if (risk.explanation) {
    body.append(el('p', 'mt-2 rounded bg-slate-50 p-2 text-xs text-slate-600', `💡 ${risk.explanation}`));
  }
  body.append(
    el('p', 'mt-2 text-xs font-medium text-slate-400', 'Exact quote from the policy:'),
    el('blockquote', 'mt-1 break-words border-l-2 border-slate-300 pl-2 text-xs italic text-slate-500', `“${risk.exact_quote}”`)
  );

  card.append(row, body);
  return card;
}

function renderAiUnavailable(root, entry) {
  renderInfo(
    '🤖',
    'Built-in AI unavailable',
    'Chrome Built-in AI is not enabled. Please enable it in chrome://flags.' +
      (entry?.error ? ` \u2014 Details: ${entry.error}` : '')
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

