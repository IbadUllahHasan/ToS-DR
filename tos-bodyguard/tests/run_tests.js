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
  const storage = {};
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
        return overrides.onSendMessage ? overrides.onSendMessage(msg) : { ok: true };
      },
    },
    storage: {
      local: {
        get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (obj) => Object.assign(storage, obj),
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
  windowMock.top = windowMock;

  const sandbox = {
    window: windowMock,
    location: windowMock.location,
    document: documentMock,
    chrome: chromeMock,
    fetch: overrides.fetch || (async () => { throw new Error('network disabled in test'); }),
    MutationObserver: MutationObserverMock,
    DOMParser: DOMParserMock,
    console: { log: () => {}, warn: () => {}, info: () => {}, error: (...a) => consoleErrors.push(a) },
    setTimeout, clearTimeout, AbortController,
  };
  vm.createContext(sandbox);
  vm.runInContext(read('content.js'), sandbox, { filename: 'content.js' });

  const sendManualScan = () =>
    new Promise((resolve) => messageListeners[0]({ type: 'MANUAL_SCAN' }, {}, resolve));

  return { storage, sentMessages, consoleErrors, clicked, sendManualScan, overrides };
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

/* ------------------------------------------------------------------ *
 * background.js harness + tests
 * ------------------------------------------------------------------ */

function loadBackground(overrides = {}) {
  const badge = { text: [], color: [] };
  const listeners = { message: [] };

  const chromeMock = {
    runtime: { onMessage: { addListener: (fn) => listeners.message.push(fn) } },
    action: {
      setBadgeText: async (o) => badge.text.push(o),
      setBadgeBackgroundColor: async (o) => badge.color.push(o),
    },
    tabs: {
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      get: async (id) => ({ id, url: 'https://example.com/' }),
    },
    storage: { local: { get: async () => ({}) } },
    scripting: { executeScript: overrides.executeScript || (async () => [{ result: { ok: true, text: '{}' } }]) },
  };

  const sandbox = { chrome: chromeMock, fetch: overrides.fetch, console, URL };
  vm.createContext(sandbox);
  if (overrides.env) overrides.env.sandbox = sandbox; // lets tests inject MAIN-world globals
  vm.runInContext(read('background.js'), sandbox, { filename: 'background.js' });
  return { badge, listeners };
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
  const env = {};
  const executeScript = async (opts) => {
    assert.strictEqual(opts.world, 'MAIN');
    // The injected func resolves `window` against the sandbox global,
    // exactly like a page MAIN world would provide it.
    env.sandbox.window = {
      ai: {
        languageModel: {
          capabilities: async () => ({ available: 'readily' }),
          create: async () => ({ prompt: async (p) => 'AI:' + p.slice(0, 3), destroy: () => {} }),
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
    listeners.message[0]({ type: 'RUN_AI_MAINWORLD', prompt: 'You are a strict...' }, { tab: { id: 2 } }, resolve)
  );
  assert.deepEqual(resp, { ok: true, text: 'AI:You' });
  console.log('PASS MAIN-world bridge executes prompt and returns model text');
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
    testBadgeColors,
    testFetchRelayStripsHtml,
    testMainWorldBridge,
    testMainWorldBridgeNoAi,
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
