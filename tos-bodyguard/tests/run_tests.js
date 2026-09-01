/**
 * TOS Bodyguard — unit tests (node tests/run_tests.js)
 * Runs content.js and background.js in a vm sandbox with mocked Chrome APIs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const waitFor = async (fn, timeout = 3000) => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setImmediate(r));
  }
};

/* ------------------------------------------------------------------ *
 * content.js harness
 * ------------------------------------------------------------------ */

function loadContentScript(overrides = {}) {
  const storage = { ...(overrides.initialStorage || {}) };
  const setCalls = [];
  const sentMessages = [];
  const messageListeners = [];
  const consoleErrors = [];
  const clicked = [];

  const fakeButton = overrides.cookieButton || null;

  const documentMock = {
    readyState: 'complete',
    addEventListener: () => {},
    querySelectorAll: (sel) => (sel === 'a[href]' ? overrides.anchors || [] : []),
    querySelector: (sel) => (fakeButton && sel === fakeButton.selector ? fakeButton : null),
    documentElement: { textContent: overrides.docText || '' },
    body: overrides.bodyText !== undefined ? { innerText: overrides.bodyText } : undefined,
  };

  const chromeMock = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        if (overrides.onSendMessage) return overrides.onSendMessage(msg);
        if (msg.type === 'AI_ACQUIRE') return { granted: true };
        return { ok: true };
      },
    },
    storage: {
      local: {
        get: async (key) => {
          if (overrides.storageThrows) throw new Error('Extension context invalidated');
          return key in storage ? { [key]: storage[key] } : {};
        },
        set: async (obj) => {
          if (overrides.storageThrows) throw new Error('Extension context invalidated');
          setCalls.push(obj);
          return Object.assign(storage, obj);
        },
      },
    },
  };

  class MutationObserverMock {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  }

  // Minimal DOMParser stand-in (regex strip) — exercises flow, not parsing.
  class DOMParserMock {
    parseFromString(html) {
      const text = String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
      return { body: { textContent: text }, querySelectorAll: () => ({ forEach: () => {} }) };
    }
  }

  const windowMock = {
    location: { hostname: overrides.hostname || 'example.com', href: 'https://example.com/' },
    ai: overrides.ai,
  };
  if (overrides.languageModelGlobal) windowMock.LanguageModel = overrides.languageModelGlobal;
  windowMock.top = windowMock;

  const sandbox = {
    window: windowMock,
    location: windowMock.location,
    document: documentMock,
    chrome: chromeMock,
    fetch: overrides.fetch || (async () => { throw new Error('network disabled in test'); }),
    MutationObserver: MutationObserverMock,
    DOMParser: DOMParserMock,
    console: { log: () => {}, warn: () => {}, info: () => {}, debug: () => {}, error: (...a) => consoleErrors.push(a) },
    setTimeout, clearTimeout, AbortController,
  };
  vm.createContext(sandbox);
  vm.runInContext(read('content.js'), sandbox, { filename: 'content.js' });

  const sendManualScan = () =>
    new Promise((resolve) => messageListeners[0]({ type: 'MANUAL_SCAN' }, {}, resolve));

  return { storage, setCalls, sentMessages, consoleErrors, clicked, sendManualScan, overrides };
}

const aiReturning = (text, captured) => ({
  languageModel: {
    capabilities: async () => ({ available: 'readily' }),
    create: async () => ({
      prompt: async (p) => { if (captured) captured.prompt = p; return text; },
      destroy: () => {},
    }),
  },
});

/* ------------------------------------------------------------------ *
 * content.js tests
 * ------------------------------------------------------------------ */

async function testNoPolicyLinks() {
  const { storage } = loadContentScript();
  await waitFor(() => storage['example.com']);
  assert.strictEqual(storage['example.com'].status, 'no_links');
  console.log('PASS auto-scan with no policy links stores no_links');
}

async function testAutoScanPipeline() {
  const captured = {};
  const ai = aiReturning(
    '```json\n{"total_risks_found":1,"risks":[{"category":"DATA_RESALE","severity":"HIGH","summary":"They sell your data.","exact_quote":"We sell your personal data to advertisers."}]}\n```',
    captured
  );
  const anchors = [
    { textContent: 'Privacy Policy', href: 'https://example.com/privacy', closest: () => ({}) },
  ];
  const fetchMock = async (url) => {
    if (String(url).endsWith('rules.json')) return { json: async () => [] };
    return { ok: true, text: async () => '<html><body><script>x()</script>We sell your personal data to advertisers.</body></html>' };
  };

  const { storage, sentMessages } = loadContentScript({ ai, anchors, fetch: fetchMock });
  const entry = await waitFor(() => storage['example.com'] && storage['example.com'].status === 'complete' && storage['example.com']);

  assert.strictEqual(entry.result.total_risks_found, 1);
  assert.strictEqual(entry.result.risks[0].category, 'DATA_RESALE');
  assert.deepEqual(entry.links, ['https://example.com/privacy']); // deepEqual: cross-realm array

  // Exact prompt verification.
  assert.ok(captured.prompt.startsWith('You are a strict privacy analyzer. Read the text and identify clauses hostile to user privacy.'));
  assert.ok(captured.prompt.includes('Scan for these 5 categories: DATA_RESALE, INFINITE_RETENTION, AGGRESSIVE_TRACKING, LEGAL_TRAPS, SHADOW_PROFILING.'));
  assert.ok(captured.prompt.includes('Do NOT wrap in markdown blocks (no ```json).'));
  assert.ok(!captured.prompt.includes('[INSERT_SCRAPED_TEXT]'));
  assert.ok(captured.prompt.endsWith('TEXT TO ANALYZE:\nWe sell your personal data to advertisers.'));

  const note = sentMessages.find((m) => m.type === 'ANALYSIS_COMPLETE' && m.status === 'complete');
  assert.ok(note && note.total_risks_found === 1 && note.status === 'complete');
  console.log('PASS auto-scan pipeline: link -> fetch -> AI (fences stripped) -> storage + badge msg; exact prompt verified');
}

async function testManualScanAndBadJson() {
  const captured = {};
  const ai = aiReturning('Sorry, I cannot help with that.', captured);
  const { storage, consoleErrors, sendManualScan } = loadContentScript({
    ai,
    bodyText: 'We retain your data forever.',
  });

  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'complete');
  assert.deepEqual(resp.result, { total_risks_found: 0, risks: [] }); // deepEqual: cross-realm object
  assert.ok(consoleErrors.length > 0, 'raw output should be console.error-ed');
  assert.strictEqual(storage['example.com'].status, 'complete');
  assert.ok(captured.prompt.endsWith('TEXT TO ANALYZE:\nWe retain your data forever.'));
  console.log('PASS manual scan: invalid AI JSON degrades to {0, []} and logs raw output');
}

async function testProseWrappedJson() {
  const ai = aiReturning(
    'Here is the analysis:\n{"total_risks_found":2,"risks":[{"category":"LEGAL_TRAPS","severity":"high","summary":"Forced arbitration.","exact_quote":"you waive the right to..."},{"category":"SHADOW_PROFILING","severity":"MEDIUM","summary":"Inferred profiles.","exact_quote":"we may infer your interests"}]}\nHope this helps!'
  );
  const { sendManualScan } = loadContentScript({ ai, bodyText: 'some policy text' });
  const resp = await sendManualScan();
  assert.strictEqual(resp.result.total_risks_found, 2);
  assert.strictEqual(resp.result.risks[0].severity, 'MEDIUM');
  assert.strictEqual(resp.result.risks[1].severity, 'MEDIUM');
  console.log('PASS prose-wrapped JSON salvaged via brace extraction; severities normalized');
}

async function testTruncation() {
  const captured = {};
  const ai = aiReturning('{"total_risks_found":0,"risks":[]}', captured);
  const { sendManualScan } = loadContentScript({ ai, bodyText: 'x'.repeat(9000) });
  await sendManualScan();
  assert.ok(captured.prompt.endsWith('x'.repeat(8000)));
  assert.ok(!captured.prompt.includes('x'.repeat(8001)));
  console.log('PASS scraped text truncated to 8,000 characters');
}

async function testAiUnavailable() {
  const { storage, sendManualScan } = loadContentScript({
    bodyText: 'hello',
    onSendMessage: (msg) => (msg.type === 'RUN_AI_MAINWORLD' ? { ok: false, error: 'ai-unavailable' } : { ok: true }),
  });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'ai_unavailable');
  assert.strictEqual(storage['example.com'].status, 'ai_unavailable');
  console.log('PASS missing AI API surfaces ai_unavailable status');
}

async function testCookieBannerAutoReject() {
  const clicked = [];
  const cookieButton = {
    selector: '#onetrust-reject-all-handler',
    offsetParent: {},
    getClientRects: () => [1],
    click: () => clicked.push(true),
  };
  const fetchMock = async (url) => {
    if (String(url).endsWith('rules.json')) {
      return { json: async () => [{ domain: '*', cmp: 'OneTrust', rejectSelector: '#onetrust-reject-all-handler' }] };
    }
    throw new Error('no other network in test');
  };
  loadContentScript({ fetch: fetchMock, cookieButton });
  await waitFor(() => clicked.length === 1);
  console.log('PASS cookie banner auto-rejected via rules.json selector');
}


async function testLocalAiDomExceptionFallsBackToBridge() {
  // Reproduces the reported bug: create() throws DOMException (e.g.
  // NotAllowedError while the model download requires user activation).
  const ai = {
    languageModel: {
      capabilities: async () => ({ available: 'readily' }),
      create: async () => { throw new DOMException('Session creation requires user activation.', 'NotAllowedError'); },
    },
  };
  const { sendManualScan } = loadContentScript({
    ai,
    bodyText: 'policy text',
    onSendMessage: (msg) =>
      msg.type === 'RUN_AI_MAINWORLD'
        ? { ok: true, text: '{"total_risks_found":0,"risks":[]}' }
        : { ok: true },
  });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'complete');
  assert.deepEqual(resp.result, { total_risks_found: 0, risks: [] });
  console.log('PASS local AI DOMException falls back to MAIN-world bridge');
}

async function testDomExceptionIsDescribedNotObjectified() {
  const ai = {
    languageModel: {
      capabilities: async () => ({ available: 'readily' }),
      create: async () => { throw new DOMException('Session creation requires user activation.', 'NotAllowedError'); },
    },
  };
  const { storage, sendManualScan } = loadContentScript({
    ai,
    bodyText: 'policy text',
    onSendMessage: (msg) => (msg.type === 'RUN_AI_MAINWORLD' ? { ok: false, error: 'ai-unavailable' } : { ok: true }),
  });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'ai_unavailable');
  assert.ok(resp.error.includes('NotAllowedError'), 'error should name the DOMException');
  assert.ok(resp.error.includes('user activation'), 'error should include the message');
  assert.ok(!resp.error.includes('[object'), 'must never stringify to [object DOMException]');
  assert.strictEqual(storage['example.com'].error, resp.error);
  console.log('PASS DOMException surfaces as "NotAllowedError: ..." in status + storage');
}

async function testCreateOptionsRejectedRetriesDefaults() {
  let calls = 0;
  const ai = {
    languageModel: {
      capabilities: async () => ({ available: 'readily' }),
      create: async (opts) => {
        calls++;
        if (opts) throw new DOMException('Unsupported options', 'NotSupportedError');
        return { prompt: async () => '{"total_risks_found":0,"risks":[]}', destroy: () => {} };
      },
    },
  };
  const { sendManualScan } = loadContentScript({ ai, bodyText: 'policy text' });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'complete');
  assert.strictEqual(calls, 2); // options attempt + defaults retry
  console.log('PASS create(options) rejection retries with defaults');
}


async function testAbortSkipsBridgeAndFailsFast() {
  // A timeout retries ONCE with a halved input, then fails fast — it must
  // NOT fall through to the bridge (that used to restart the inference).
  const promptLens = [];
  const ai = {
    languageModel: {
      capabilities: async () => ({ available: 'readily' }),
      create: async () => ({
        prompt: async (p) => { promptLens.push(p.length); throw new DOMException('The operation was aborted.', 'AbortError'); },
        destroy: () => {},
      }),
    },
  };
  const sentTypes = [];
  const { sendManualScan } = loadContentScript({
    ai,
    bodyText: 'x'.repeat(9000),
    onSendMessage: (msg) => { sentTypes.push(msg.type); return { ok: true }; },
  });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'error');
  assert.ok(resp.error.includes('timed out'), 'should report a timeout');
  assert.strictEqual(promptLens.length, 2, 'exactly one shrink retry');
  assert.ok(promptLens[1] < promptLens[0], 'retry uses a smaller input');
  assert.ok(!sentTypes.includes('RUN_AI_MAINWORLD'), 'bridge must not re-run after abort');
  console.log('PASS abort/timeout shrinks input once, then fails fast without bridge re-run');
}

async function testQuotaExceededShrinksInputAndSucceeds() {
  const promptLens = [];
  let calls = 0;
  const ai = {
    languageModel: {
      capabilities: async () => ({ available: 'readily' }),
      create: async () => ({
        prompt: async (p) => {
          promptLens.push(p.length);
          calls++;
          if (calls === 1) throw new DOMException('Input too large for context window', 'QuotaExceededError');
          return '{"total_risks_found":0,"risks":[]}';
        },
        destroy: () => {},
      }),
    },
  };
  const { sendManualScan } = loadContentScript({ ai, bodyText: 'y'.repeat(9000) });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'complete');
  assert.strictEqual(promptLens.length, 2, 'one shrink retry');
  assert.ok(promptLens[1] < promptLens[0], 'retry uses a smaller input');
  console.log('PASS QuotaExceededError shrinks input once then succeeds');
}

async function testContextInvalidatedIsQuiet() {
  // Simulates an old content script after an extension reload: every
  // chrome.storage call throws. Must log quietly and store nothing.
  const { consoleErrors, storage } = loadContentScript({ storageThrows: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(Object.keys(storage), [], 'nothing should be stored');
  assert.deepEqual(consoleErrors, [], 'nothing should hit console.error');
  console.log('PASS extension-context-invalidation handled quietly');
}

async function testLanguageModelNamespaceUsesResponseConstraint() {
  let seenOpts = null;
  const languageModelGlobal = {
    availability: async () => 'available',
    create: async () => ({
      prompt: async (_p, opts) => { seenOpts = opts; return '{"total_risks_found":0,"risks":[]}' ; },
      destroy: () => {},
    }),
  };
  const { sendManualScan } = loadContentScript({ languageModelGlobal, bodyText: 'policy text' });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'complete');
  assert.ok(seenOpts && seenOpts.responseConstraint, 'responseConstraint should be passed');
  assert.strictEqual(seenOpts.responseConstraint.type, 'object');
  assert.ok(seenOpts.responseConstraint.required.includes('total_risks_found'));
  console.log('PASS LanguageModel path sends responseConstraint JSON schema');
}


async function testAnalysisHoldsAndReleasesMutex() {
  const { sentMessages, sendManualScan } = loadContentScript({
    ai: aiReturning('{"total_risks_found":0,"risks":[]}'),
    bodyText: 'policy text',
  });
  await sendManualScan();
  const types = sentMessages.map((m) => m.type);
  assert.ok(types.includes('AI_ACQUIRE'), 'must acquire the AI lock');
  assert.strictEqual(sentMessages.find((m) => m.type === 'AI_ACQUIRE').hostname, 'example.com');
  assert.ok(types.includes('AI_RELEASE'), 'must release the AI lock');
  assert.ok(types.indexOf('AI_ACQUIRE') < types.indexOf('AI_RELEASE'));
  console.log('PASS analysis acquires then releases the browser-wide AI mutex');
}

async function testNegativeResultBacksOff() {
  // A recent failure must NOT trigger a fresh AI run on the next pageview.
  let aiCreated = false;
  const ai = {
    languageModel: {
      capabilities: async () => ({ available: 'readily' }),
      create: async () => { aiCreated = true; return { prompt: async () => '{}', destroy: () => {} }; },
    },
  };
  const anchors = [
    { textContent: 'Privacy Policy', href: 'https://example.com/privacy', closest: () => ({}) },
  ];
  const fetchMock = async (url) => {
    if (String(url).endsWith('rules.json')) return { json: async () => [] };
    return { ok: true, text: async () => '<body>policy</body>' };
  };
  const { sentMessages } = loadContentScript({
    ai,
    anchors,
    fetch: fetchMock,
    initialStorage: {
      'example.com': { status: 'error', error: 'AI timed out', updatedAt: Date.now() },
    },
  });
  await waitFor(() =>
    sentMessages.some((m) => m.type === 'ANALYSIS_COMPLETE' && m.status === 'error')
  );
  assert.strictEqual(aiCreated, false, 'AI must not run within the negative-cache window');
  console.log('PASS recent failure backs off instead of re-running inference');
}

async function testInvalidStateErrorRetriesOnce() {
  // Chrome destroys sessions of backgrounded tabs; a fresh session recovers.
  let creates = 0;
  const ai = {
    languageModel: {
      capabilities: async () => ({ available: 'readily' }),
      create: async () => {
        creates++;
        if (creates === 1) {
          return {
            prompt: async () => { throw new DOMException('The model execution session has been destroyed.', 'InvalidStateError'); },
            destroy: () => {},
          };
        }
        return { prompt: async () => '{"total_risks_found":0,"risks":[]}', destroy: () => {} };
      },
    },
  };
  const { sendManualScan } = loadContentScript({ ai, bodyText: 'policy text' });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'complete');
  assert.strictEqual(creates, 2, 'exactly one retry with a fresh session');
  console.log('PASS InvalidStateError retries once with a fresh session');
}


async function testStreamingDeltaChunksDriveProgress() {
  // New LanguageModel style: each chunk is a delta to append.
  const ai = {
    languageModel: {
      capabilities: async () => ({ available: 'readily' }),
      create: async () => ({
        prompt: async () => { throw new Error('streaming path should be used'); },
        promptStreaming: async function* () {
          yield '{"total_risks_found":0,';
          yield '"risks":[]}';
        },
        destroy: () => {},
      }),
    },
  };
  const { sendManualScan, setCalls } = loadContentScript({ ai, bodyText: 'policy text' });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'complete');
  assert.strictEqual(resp.result.total_risks_found, 0);
  const progresses = setCalls
    .flatMap((c) => Object.values(c))
    .map((v) => v && v.progress)
    .filter(Boolean);
  assert.ok(progresses.some((p) => p.phase.includes('Analyzing')), 'should report analyzing progress');
  assert.ok(Math.max(...progresses.map((p) => p.percent)) >= 45, 'progress should reach >= 45%');
  console.log('PASS streaming (delta chunks) parses correctly and drives the progress bar');
}

async function testStreamingLegacyPrefixChunks() {
  // Origin-trial style: each chunk is the FULL accumulated prefix.
  const full = '{"total_risks_found":1,"risks":[{"category":"LEGAL_TRAPS","severity":"HIGH","summary":"s","exact_quote":"q"}]}';
  const ai = {
    languageModel: {
      capabilities: async () => ({ available: 'readily' }),
      create: async () => ({
        promptStreaming: async function* () {
          yield full.slice(0, 25);
          yield full;
        },
        destroy: () => {},
      }),
    },
  };
  const { sendManualScan } = loadContentScript({ ai, bodyText: 'policy text' });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'complete');
  assert.strictEqual(resp.result.total_risks_found, 1);
  console.log('PASS streaming (legacy full-prefix chunks) parsed without duplication');
}


async function testCloudProviderPathSkipsMutex() {
  const sentTypes = [];
  const { sendManualScan } = loadContentScript({
    bodyText: 'policy text',
    initialStorage: { settings: { provider: 'groq', keys: { groq: 'key123' }, models: {} } },
    onSendMessage: (msg) => {
      sentTypes.push(msg.type);
      if (msg.type === 'RUN_AI_CLOUD') {
        return { ok: true, text: '{"total_risks_found":3,"risks":[{"category":"DATA_RESALE","severity":"HIGH","summary":"a","exact_quote":"q1"},{"category":"LEGAL_TRAPS","severity":"MEDIUM","summary":"b","exact_quote":"q2"},{"category":"SHADOW_PROFILING","severity":"MEDIUM","summary":"c","exact_quote":"q3"}]}' };
      }
      if (msg.type === 'AI_ACQUIRE') return { granted: true };
      return { ok: true };
    },
  });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'complete');
  assert.strictEqual(resp.result.total_risks_found, 3);
  assert.ok(sentTypes.includes('RUN_AI_CLOUD'), 'cloud path used');
  assert.ok(!sentTypes.includes('AI_ACQUIRE'), 'cloud path must not take the local mutex');
  console.log('PASS cloud provider path used, local mutex skipped');
}

async function testCloudFailureFallsBackToLocal() {
  const captured = {};
  const ai = aiReturning('{"total_risks_found":0,"risks":[]}', captured);
  const sentTypes = [];
  const { sendManualScan } = loadContentScript({
    ai,
    bodyText: 'policy text',
    initialStorage: { settings: { provider: 'openai', keys: { openai: 'bad-key' } } },
    onSendMessage: (msg) => {
      sentTypes.push(msg.type);
      if (msg.type === 'RUN_AI_CLOUD') return { ok: false, error: 'openai HTTP 401' };
      if (msg.type === 'AI_ACQUIRE') return { granted: true };
      return { ok: true };
    },
  });
  const resp = await sendManualScan();
  assert.strictEqual(resp.status, 'complete');
  assert.ok(sentTypes.includes('RUN_AI_CLOUD') && sentTypes.includes('AI_ACQUIRE'));
  console.log('PASS cloud failure falls back to on-device Nano');
}

/* ------------------------------------------------------------------ *
 * background.js harness + tests
 * ------------------------------------------------------------------ */

function loadBackground(overrides = {}) {
  const badge = { text: [], color: [] };
  const sessionWrites = [];
  const listeners = { message: [], removed: [] };

  const chromeMock = {
    runtime: { onMessage: { addListener: (fn) => listeners.message.push(fn) } },
    action: {
      setBadgeText: async (o) => badge.text.push(o),
      setBadgeBackgroundColor: async (o) => badge.color.push(o),
    },
    tabs: {
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
      get: async (id) => ({ id, url: 'https://example.com/' }),
    },
    storage: {
      local: { get: async () => overrides.localData || {} },
      session: { set: async (obj) => sessionWrites.push(obj), get: async () => ({}) },
    },
    scripting: { executeScript: overrides.executeScript || (async () => [{ result: { ok: true, text: '{}' } }]) },
  };

  const sandbox = { chrome: chromeMock, fetch: overrides.fetch, console, URL, setTimeout, clearTimeout, AbortController };
  vm.createContext(sandbox);
  if (overrides.env) overrides.env.sandbox = sandbox; // lets tests inject MAIN-world globals
  vm.runInContext(read('background.js'), sandbox, { filename: 'background.js' });
  return { badge, listeners, sessionWrites };
}

async function testBadgeColors() {
  const { badge, listeners } = loadBackground();
  const handler = listeners.message[0];

  let responded = null;
  handler({ type: 'ANALYSIS_COMPLETE', status: 'complete', total_risks_found: 3 }, { tab: { id: 7 } }, (r) => (responded = r));
  await waitFor(() => badge.color.length === 1);
  assert.deepEqual(badge.text[0], { tabId: 7, text: '3' });
  assert.deepEqual(badge.color[0], { tabId: 7, color: '#D93025' }); // red
  assert.deepEqual(responded, { ok: true });

  handler({ type: 'ANALYSIS_COMPLETE', status: 'complete', total_risks_found: 0 }, { tab: { id: 7 } }, () => {});
  await waitFor(() => badge.color.length === 2);
  assert.deepEqual(badge.text[1], { tabId: 7, text: '0' });
  assert.deepEqual(badge.color[1], { tabId: 7, color: '#188038' }); // green
  console.log('PASS badge: red with count when risks > 0, green 0 when clean');
}

async function testFetchRelayStripsHtml() {
  const fetchMock = async () => ({
    ok: true,
    text: async () => '<html><head><style>body{color:red}</style></head><body><p>Hello &amp; goodbye</p><script>evil()</script></body></html>',
  });
  const { listeners } = loadBackground({ fetch: fetchMock });
  const resp = await new Promise((resolve) =>
    listeners.message[0]({ type: 'FETCH_TEXT', url: 'https://example.com/privacy' }, { tab: { id: 1 } }, resolve)
  );
  assert.ok(resp.ok);
  assert.strictEqual(resp.text, 'Hello & goodbye');
  console.log('PASS service-worker fetch relay strips scripts/styles/tags and decodes entities');
}

async function testMainWorldBridge() {
  let createOpts = null;
  const env = {};
  const executeScript = async (opts) => {
    assert.strictEqual(opts.world, 'MAIN');
    assert.deepEqual(opts.args[1], { type: 'object', marker: true }); // schema forwarded
    // The injected func resolves `window` against the sandbox global,
    // exactly like a page MAIN world would provide it.
    env.sandbox.window = {
      ai: {
        languageModel: {
          capabilities: async () => ({ available: 'readily' }),
          create: async (opts) => {
            createOpts = opts;
            return { prompt: async (p) => 'AI:' + p.slice(0, 3), destroy: () => {} };
          },
        },
      },
    };
    try {
      return [{ result: await opts.func(opts.args[0]) }];
    } finally {
      delete env.sandbox.window;
    }
  };
  const { listeners } = loadBackground({ executeScript: executeScript, env: env });
  const resp = await new Promise((resolve) =>
    listeners.message[0]({ type: 'RUN_AI_MAINWORLD', prompt: 'You are a strict...', schema: { type: 'object', marker: true } }, { tab: { id: 2 } }, resolve)
  );
  assert.deepEqual(resp, { ok: true, text: 'AI:You' });
  assert.ok(createOpts?.expectedOutputs?.[0]?.languages?.includes('en'), 'bridge create must pass expectedOutputs');
  console.log('PASS MAIN-world bridge executes prompt and returns model text (+expectedOutputs)');
}

async function testMainWorldBridgeNoAi() {
  const env = {};
  const executeScript = async (opts) => {
    env.sandbox.window = {}; // MAIN world exists but has no AI API
    return [{ result: await opts.func(opts.args[0]) }];
  };
  const { listeners } = loadBackground({ executeScript: executeScript, env: env });
  const resp = await new Promise((resolve) =>
    listeners.message[0]({ type: 'RUN_AI_MAINWORLD', prompt: 'x' }, { tab: { id: 2 } }, resolve)
  );
  assert.deepEqual(resp, { ok: false, error: 'ai-unavailable' });
  console.log('PASS MAIN-world bridge reports ai-unavailable when API missing');
}


async function testAiMutexSerialization() {
  const { listeners } = loadBackground();
  const handler = listeners.message[0];

  let r1 = null;
  handler({ type: 'AI_ACQUIRE' }, { tab: { id: 1 } }, (r) => (r1 = r));
  assert.deepEqual(r1, { granted: true });

  let r2 = null;
  handler({ type: 'AI_ACQUIRE' }, { tab: { id: 2 } }, (r) => (r2 = r));
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(r2, null); // queued, not granted

  handler({ type: 'AI_RELEASE' }, { tab: { id: 1 } }, () => {});
  assert.deepEqual(r2, { granted: true }); // FIFO handoff
  console.log('PASS AI mutex serializes across tabs with FIFO handoff');
}

async function testAiMutexReleasedOnTabClose() {
  const { listeners } = loadBackground();
  const handler = listeners.message[0];

  handler({ type: 'AI_ACQUIRE' }, { tab: { id: 1 } }, () => {});
  let r2 = null;
  handler({ type: 'AI_ACQUIRE' }, { tab: { id: 2 } }, (r) => (r2 = r));
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(r2, null);

  listeners.removed[0](1); // holder's tab closed without releasing
  assert.deepEqual(r2, { granted: true });
  console.log('PASS AI mutex auto-releases when the holder tab closes');
}


async function testQueueStatePublished() {
  const { listeners, sessionWrites } = loadBackground();
  const handler = listeners.message[0];

  handler({ type: 'AI_ACQUIRE', hostname: 'a.com' }, { tab: { id: 1 } }, () => {});
  let last = sessionWrites[sessionWrites.length - 1].aiQueue;
  assert.strictEqual(last.current.hostname, 'a.com');
  assert.strictEqual(last.waiting.length, 0);

  handler({ type: 'AI_ACQUIRE', hostname: 'b.com' }, { tab: { id: 2 } }, () => {});
  last = sessionWrites[sessionWrites.length - 1].aiQueue;
  assert.strictEqual(last.current.hostname, 'a.com');
  assert.strictEqual(last.waiting.length, 1);
  assert.strictEqual(last.waiting[0].hostname, 'b.com');

  handler({ type: 'AI_RELEASE' }, { tab: { id: 1 } }, () => {});
  last = sessionWrites[sessionWrites.length - 1].aiQueue;
  assert.strictEqual(last.current.hostname, 'b.com');
  assert.strictEqual(last.waiting.length, 0);
  console.log('PASS queue state published to storage.session (current + waiting)');
}


async function testCloudChunkingMergeDedupe() {
  const bodies = [];
  const fetchMock = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const n = bodies.length;
    const risks =
      n === 1 ? [{ category: 'DATA_RESALE', severity: 'HIGH', summary: 's1', exact_quote: 'quote-one' }]
      : n === 2 ? [
          { category: 'LEGAL_TRAPS', severity: 'MEDIUM', summary: 's2', exact_quote: 'quote-two' },
          { category: 'DATA_RESALE', severity: 'HIGH', summary: 's1-dup', exact_quote: 'quote-one' }, // dup
        ]
      : [{ category: 'LEGAL_TRAPS', severity: 'MEDIUM', summary: 's2-again', exact_quote: 'quote-two' }]; // dup
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ total_risks_found: risks.length, risks }) } }] }) };
  };
  const { listeners } = loadBackground({
    fetch: fetchMock,
    localData: { settings: { provider: 'groq', keys: { groq: 'k' }, models: {} } },
  });
  const text = 'a'.repeat(25000); // > 2 chunks of 12000
  const resp = await new Promise((resolve) =>
    listeners.message[0]({ type: 'RUN_AI_CLOUD', text, hostname: 'h.com', scanId: 's' }, { tab: { id: 1 } }, resolve)
  );
  assert.ok(resp.ok, 'cloud analysis ok');
  assert.strictEqual(bodies.length, 3, '25,000 chars -> 3 overlapping chunks');
  const merged = JSON.parse(resp.text);
  assert.strictEqual(merged.total_risks_found, 2, 'duplicate quotes deduped across chunks');
  console.log('PASS cloud analysis chunks long text, merges + dedupes risks');
}

async function testCloudErrorSurfaced() {
  const fetchMock = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' });
  const { listeners } = loadBackground({
    fetch: fetchMock,
    localData: { settings: { provider: 'openai', keys: { openai: 'bad' } } },
  });
  const resp = await new Promise((resolve) =>
    listeners.message[0]({ type: 'RUN_AI_CLOUD', text: 'short text', hostname: 'h', scanId: 's' }, { tab: { id: 1 } }, resolve)
  );
  assert.strictEqual(resp.ok, false);
  assert.ok(resp.error.includes('401'), 'HTTP detail surfaced');
  console.log('PASS cloud provider errors surface with HTTP detail');
}

async function testCloudTestEndpoint() {
  const fetchMock = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
  const { listeners } = loadBackground({ fetch: fetchMock });
  const resp = await new Promise((resolve) =>
    listeners.message[0]({ type: 'CLOUD_TEST', provider: 'groq', apiKey: 'k', model: 'm' }, {}, resolve)
  );
  assert.deepEqual(resp, { ok: true });
  const bad = await new Promise((resolve) =>
    listeners.message[0]({ type: 'CLOUD_TEST', provider: 'groq', apiKey: '', model: 'm' }, {}, resolve)
  );
  assert.strictEqual(bad.ok, false);
  console.log('PASS CLOUD_TEST validates keys with a tiny request');
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

(async () => {
  const tests = [
    testNoPolicyLinks,
    testAutoScanPipeline,
    testManualScanAndBadJson,
    testProseWrappedJson,
    testTruncation,
    testAiUnavailable,
    testCookieBannerAutoReject,
    testLocalAiDomExceptionFallsBackToBridge,
    testDomExceptionIsDescribedNotObjectified,
    testCreateOptionsRejectedRetriesDefaults,
    testAbortSkipsBridgeAndFailsFast,
    testQuotaExceededShrinksInputAndSucceeds,
    testContextInvalidatedIsQuiet,
    testLanguageModelNamespaceUsesResponseConstraint,
    testAnalysisHoldsAndReleasesMutex,
    testNegativeResultBacksOff,
    testInvalidStateErrorRetriesOnce,
    testStreamingDeltaChunksDriveProgress,
    testStreamingLegacyPrefixChunks,
    testCloudProviderPathSkipsMutex,
    testCloudFailureFallsBackToLocal,
    testBadgeColors,
    testFetchRelayStripsHtml,
    testMainWorldBridge,
    testMainWorldBridgeNoAi,
    testAiMutexSerialization,
    testAiMutexReleasedOnTabClose,
    testQueueStatePublished,
    testCloudChunkingMergeDedupe,
    testCloudErrorSurfaced,
    testCloudTestEndpoint,
  ];
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      failed++;
      console.error(`FAIL ${t.name}:`, err.message);
    }
  }
  console.log(failed === 0 ? `\nAll ${tests.length} tests passed.` : `\n${failed}/${tests.length} tests FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
})();
