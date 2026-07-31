import test from 'node:test';
import assert from 'node:assert/strict';

import * as solver from '../src/solver.js';

const CHROME_131_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function requireExport(name) {
  assert.equal(typeof solver[name], 'function', `${name} must be exported`);
  return solver[name];
}

function assertChallengeFailure(error) {
  assert.equal(error?.code, 'cloudflare_challenge_failed');
  return true;
}

test('exports the solver coordinator API', () => {
  requireExport('hasClearanceCookie');
  requireExport('createChallengeCoordinator');
  requireExport('toPlaywrightProxy');
  requireExport('createBrowserSolver');
  requireExport('createCapSolver');
});

test('accepts only a non-empty cf_clearance cookie', () => {
  const hasClearanceCookie = requireExport('hasClearanceCookie');

  assert.equal(hasClearanceCookie('cf_clearance=clear-token'), true);
  assert.equal(hasClearanceCookie('session=private; cf_clearance=clear-token==; theme=dark'), true);
  assert.equal(hasClearanceCookie('cf_clearance='), false);
  assert.equal(hasClearanceCookie('session=private'), false);
  assert.equal(hasClearanceCookie(''), false);
  assert.equal(hasClearanceCookie(null), false);
});

test('returns and caches only cf_clearance from a usable browser solution', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  let browserCalls = 0;
  const coordinator = createChallengeCoordinator({
    browser: async () => {
      browserCalls += 1;
      return {
        cleared: true,
        cookieHeader: 'session=private; cf_clearance=clear-token==; theme=dark',
        ua: 'browser-ua',
      };
    },
    capsolver: async () => {
      throw new Error('CapSolver should not run');
    },
  });

  const first = await coordinator.solve(
    'https://example.test/a',
    'http://proxy.test:8080',
    '<html>challenge</html>',
    'chrome131',
  );
  const second = await coordinator.solve(
    'https://example.test/b',
    'http://proxy.test:8080',
    '<html>different challenge</html>',
    'chrome131',
  );

  assert.equal(first.cookieHeader, 'cf_clearance=clear-token==');
  assert.equal(first.cleared, true);
  assert.equal(first.ua, 'browser-ua');
  assert.deepEqual(second, first);
  assert.equal(browserCalls, 1);
});

test('keys valid cache entries by origin, effective proxy, and fingerprint', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  const calls = [];
  const coordinator = createChallengeCoordinator({
    browser: async input => {
      calls.push(input);
      return {
        cleared: true,
        cookieHeader: `cf_clearance=token-${calls.length}`,
        ua: CHROME_131_UA,
      };
    },
    capsolver: async () => null,
  });

  await coordinator.solve('https://one.test/a', 'http://proxy-a', '', 'chrome131');
  await coordinator.solve('https://one.test/b', 'http://proxy-a', '', 'chrome131');
  await coordinator.solve('https://one.test/a', 'http://proxy-b', '', 'chrome131');
  await coordinator.solve('https://two.test/a', 'http://proxy-a', '', 'chrome131');
  await coordinator.solve('https://one.test/a', 'http://proxy-a', '', 'chrome132');

  assert.equal(calls.length, 4);
});

test('coalesces concurrent solves for the same key', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  let browserCalls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const coordinator = createChallengeCoordinator({
    browser: async () => {
      browserCalls += 1;
      await gate;
      return {
        cleared: true,
        cookieHeader: 'cf_clearance=shared-token',
        ua: CHROME_131_UA,
      };
    },
    capsolver: async () => null,
  });

  const first = coordinator.solve('https://example.test/a', 'http://proxy', '', 'chrome131');
  const second = coordinator.solve('https://example.test/b', 'http://proxy', '', 'chrome131');
  release();

  assert.deepEqual(await first, await second);
  assert.equal(browserCalls, 1);
});

test('does not cache empty or failed attempts', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  let browserCalls = 0;
  let capsolverCalls = 0;
  const coordinator = createChallengeCoordinator({
    browser: async () => {
      browserCalls += 1;
      return {
        cleared: true,
        cookieHeader: 'session=private',
        ua: '',
      };
    },
    capsolver: async () => {
      capsolverCalls += 1;
      return {
        cleared: false,
        cookieHeader: 'cf_clearance=',
        ua: '',
      };
    },
  });

  await assert.rejects(
    () => coordinator.solve('https://example.test/a', 'http://proxy', '<html>challenge</html>', 'chrome131'),
    assertChallengeFailure,
  );
  await assert.rejects(
    () => coordinator.solve('https://example.test/a', 'http://proxy', '<html>challenge</html>', 'chrome131'),
    assertChallengeFailure,
  );

  assert.equal(browserCalls, 2);
  assert.equal(capsolverCalls, 2);
});

test('clear removes a cached solution and forces a new solve', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  let browserCalls = 0;
  const coordinator = createChallengeCoordinator({
    browser: async () => ({
      cleared: true,
      cookieHeader: `cf_clearance=token-${++browserCalls}`,
      ua: CHROME_131_UA,
    }),
    capsolver: async () => null,
  });

  const first = await coordinator.solve('https://example.test/a', 'http://proxy', '', 'chrome131');
  coordinator.clear('https://example.test/other', 'http://proxy', 'chrome131');
  const second = await coordinator.solve('https://example.test/a', 'http://proxy', '', 'chrome131');

  assert.notEqual(first.cookieHeader, second.cookieHeader);
  assert.equal(browserCalls, 2);
});

test('a solve started before clear cannot overwrite the fresh result', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  const releases = [];
  let browserCalls = 0;
  const coordinator = createChallengeCoordinator({
    browser: () => new Promise(resolve => {
      const token = `token-${++browserCalls}`;
      releases.push(() => resolve({
        cleared: true,
        cookieHeader: `cf_clearance=${token}`,
        ua: CHROME_131_UA,
      }));
    }),
    capsolver: async () => null,
  });

  const stale = coordinator.solve('https://example.test/a', 'http://proxy', '', 'chrome131');
  coordinator.clear('https://example.test/a', 'http://proxy', 'chrome131');
  const fresh = coordinator.solve('https://example.test/a', 'http://proxy', '', 'chrome131');

  releases[1]();
  assert.equal((await fresh).cookieHeader, 'cf_clearance=token-2');
  releases[0]();
  assert.equal((await stale).cookieHeader, 'cf_clearance=token-1');

  const cached = await coordinator.solve('https://example.test/a', 'http://proxy', '', 'chrome131');
  assert.equal(cached.cookieHeader, 'cf_clearance=token-2');
  assert.equal(browserCalls, 2);
});

test('expires cached solutions using the injected clock', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  let clock = 100;
  let browserCalls = 0;
  const coordinator = createChallengeCoordinator({
    ttl: 50,
    now: () => clock,
    browser: async () => ({
      cleared: true,
      cookieHeader: `cf_clearance=token-${++browserCalls}`,
      ua: CHROME_131_UA,
    }),
    capsolver: async () => null,
  });

  await coordinator.solve('https://example.test/a', '', '', 'chrome131');
  clock = 149;
  await coordinator.solve('https://example.test/b', '', '', 'chrome131');
  clock = 150;
  await coordinator.solve('https://example.test/c', '', '', 'chrome131');

  assert.equal(browserCalls, 2);
});

test('uses CDP only without a proxy and gives CapSolver a canonical Chrome 131 identity', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  const browserInputs = [];
  const capsolverInputs = [];
  const coordinator = createChallengeCoordinator({
    browser: async input => {
      browserInputs.push(input);
      return null;
    },
    capsolver: async input => {
      capsolverInputs.push(input);
      return {
        cleared: true,
        cookieHeader: `session=private; cf_clearance=token-${capsolverInputs.length}; other=private`,
        ua: '',
      };
    },
  });

  const direct = await coordinator.solve('https://direct.test/a', '', '<html>challenge</html>', '');
  const proxied = await coordinator.solve('https://proxy.test/a', ' http://proxy.test:8080 ', '<html>challenge</html>', 'safari18_0');

  assert.equal(browserInputs[0].allowCdp, true);
  assert.equal(browserInputs[1].allowCdp, false);
  assert.equal(browserInputs[1].proxy, 'http://proxy.test:8080');
  for (const input of capsolverInputs) {
    assert.equal(input.imp, 'chrome131');
    assert.equal(input.ua, CHROME_131_UA);
  }
  assert.equal(direct.cookieHeader, 'cf_clearance=token-1');
  assert.equal(proxied.cookieHeader, 'cf_clearance=token-2');
});

test('converts an authenticated proxy into Playwright fields without credentials in server', () => {
  const toPlaywrightProxy = requireExport('toPlaywrightProxy');

  assert.deepEqual(
    toPlaywrightProxy('https://user%40mail.test:p%40ss%3Aword@proxy.test:8443'),
    {
      server: 'https://proxy.test:8443',
      username: 'user@mail.test',
      password: 'p@ss:word',
    },
  );
  assert.deepEqual(
    toPlaywrightProxy('http://proxy.test:8080'),
    { server: 'http://proxy.test:8080' },
  );
  assert.equal(toPlaywrightProxy(''), undefined);
});

function browserFixture({ reportedUa = CHROME_131_UA } = {}) {
  const calls = {
    connect: [],
    launch: [],
    contexts: 0,
    newContext: [],
    contextClose: 0,
    pageClose: 0,
    browserClose: 0,
    goto: [],
    evaluate: [],
    cookiesAdded: [],
  };
  const page = {
    goto: async url => {
      calls.goto.push(url);
      return {
        status: () => 200,
        headers: async () => ({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ ok: true }),
      };
    },
    evaluate: async (fn, arg) => {
      calls.evaluate.push(arg);
      if (arg !== undefined) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          text: JSON.stringify({ ok: true }),
        };
      }
      return reportedUa;
    },
    waitForTimeout: async () => {},
    close: async () => { calls.pageClose += 1; },
  };
  const context = {
    addInitScript: async () => {},
    addCookies: async cookies => { calls.cookiesAdded.push(cookies); },
    newPage: async () => page,
    cookies: async () => [{ name: 'cf_clearance', value: 'clear-token' }],
    close: async () => { calls.contextClose += 1; },
  };
  const browser = {
    contexts: () => {
      calls.contexts += 1;
      throw new Error('default context must not be reused');
    },
    newContext: async options => {
      calls.newContext.push(options);
      return context;
    },
    close: async () => { calls.browserClose += 1; },
  };
  const chromiumApi = {
    connectOverCDP: async endpoint => {
      calls.connect.push(endpoint);
      return browser;
    },
    launch: async options => {
      calls.launch.push(options);
      return browser;
    },
  };
  return { calls, chromiumApi };
}

test('browser fallback preserves local auth, cookies, method, and JSON body', async () => {
  const createBrowserSolver = requireExport('createBrowserSolver');
  const fixture = browserFixture();
  const browserSolve = createBrowserSolver({
    chromiumApi: fixture.chromiumApi,
    getConfig: () => ({ browserWs: '', chromePath: 'C:/fake/chrome.exe' }),
    findExecutable: () => 'C:/fake/chrome.exe',
  });

  const result = await browserSolve({
    url: 'https://example.test/backend-api/payments/checkout',
    proxy: 'http://proxy.test:8080',
    allowCdp: false,
    ua: CHROME_131_UA,
    requestContext: {
      method: 'POST',
      token: 'private-access-token',
      headers: {
        Cookie: 'theme=dark; __Secure-next-auth.session-token=private-session',
        'X-Request-Id': 'request-1',
      },
      body: { plan_name: 'chatgptplusplan' },
    },
  });

  assert.deepEqual(result.directResponse?.json, { ok: true });
  assert.deepEqual(fixture.calls.cookiesAdded[0].map(cookie => ({
    name: cookie.name,
    value: cookie.value,
  })), [
    { name: 'theme', value: 'dark' },
    { name: '__Secure-next-auth.session-token', value: 'private-session' },
  ]);
  assert.equal(fixture.calls.newContext[0].extraHTTPHeaders.Authorization, 'Bearer private-access-token');
  assert.equal(fixture.calls.newContext[0].extraHTTPHeaders['X-Request-Id'], 'request-1');
  assert.equal(fixture.calls.newContext[0].extraHTTPHeaders.Cookie, undefined);
  assert.deepEqual(fixture.calls.evaluate[0], {
    url: 'https://example.test/backend-api/payments/checkout',
    method: 'POST',
    headers: {
      'X-Request-Id': 'request-1',
      Authorization: 'Bearer private-access-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ plan_name: 'chatgptplusplan' }),
  });
});

test('authenticated direct responses are request-local and never reach CapSolver or cache', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  const browserInputs = [];
  const capsolverInputs = [];
  const coordinator = createChallengeCoordinator({
    browser: async input => {
      browserInputs.push(input);
      return {
        directResponse: {
          status: 200,
          json: { url: input.url },
          headers: { contentType: 'application/json', cfMitigated: '' },
        },
      };
    },
    capsolver: async input => {
      capsolverInputs.push(input);
      throw new Error('CapSolver must not receive authenticated request context');
    },
  });

  const first = await coordinator.solve(
    'https://example.test/a',
    'http://proxy',
    '<html>challenge</html>',
    'chrome131',
    { method: 'GET', token: 'token-a', headers: { Cookie: 'secret=a' }, body: null },
  );
  const second = await coordinator.solve(
    'https://example.test/b',
    'http://proxy',
    '<html>challenge</html>',
    'chrome131',
    { method: 'POST', token: 'token-b', headers: {}, body: { x: 1 } },
  );

  assert.equal(first.directResponse.json.url, 'https://example.test/a');
  assert.equal(second.directResponse.json.url, 'https://example.test/b');
  assert.equal(browserInputs.length, 2);
  assert.equal(capsolverInputs.length, 0);
  assert.equal(coordinator.inspect().cacheSize, 0);
  assert.equal(coordinator.inspect().inFlightSize, 0);
});

test('CDP solving uses an isolated Chrome 131 context and closes it', async () => {
  const createBrowserSolver = requireExport('createBrowserSolver');
  const fixture = browserFixture();
  const browserSolve = createBrowserSolver({
    chromiumApi: fixture.chromiumApi,
    getConfig: () => ({ browserWs: 'ws://127.0.0.1:9222', chromePath: '' }),
    findExecutable: () => 'unused',
  });

  const result = await browserSolve({
    url: 'https://example.test/challenge',
    proxy: '',
    allowCdp: true,
    ua: CHROME_131_UA,
  });

  assert.deepEqual(fixture.calls.connect, ['ws://127.0.0.1:9222']);
  assert.equal(fixture.calls.contexts, 0);
  assert.equal(fixture.calls.newContext[0].userAgent, CHROME_131_UA);
  assert.equal(fixture.calls.contextClose, 1);
  assert.equal(fixture.calls.pageClose, 1);
  assert.equal(fixture.calls.browserClose, 1);
  assert.equal(result.cookieHeader, 'cf_clearance=clear-token');
});

test('proxied solving skips CDP and applies structured credentials to launch and context', async () => {
  const createBrowserSolver = requireExport('createBrowserSolver');
  const fixture = browserFixture();
  const browserSolve = createBrowserSolver({
    chromiumApi: fixture.chromiumApi,
    getConfig: () => ({ browserWs: 'ws://127.0.0.1:9222', chromePath: '' }),
    findExecutable: () => 'C:/fake/chrome.exe',
  });
  const proxy = 'http://user%40mail.test:p%40ss@proxy.test:8080';

  await browserSolve({
    url: 'https://example.test/challenge',
    proxy,
    allowCdp: false,
    ua: CHROME_131_UA,
  });

  const expectedProxy = {
    server: 'http://proxy.test:8080',
    username: 'user@mail.test',
    password: 'p@ss',
  };
  assert.equal(fixture.calls.connect.length, 0);
  assert.deepEqual(fixture.calls.launch[0].proxy, expectedProxy);
  assert.deepEqual(fixture.calls.newContext[0].proxy, expectedProxy);
  assert.doesNotMatch(fixture.calls.launch[0].proxy.server, /user|p%40ss|@proxy/);
});

test('rejects a clearance result from a browser with a non-Chrome-131 UA', async () => {
  const createBrowserSolver = requireExport('createBrowserSolver');
  const fixture = browserFixture({
    reportedUa: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
  });
  const browserSolve = createBrowserSolver({
    chromiumApi: fixture.chromiumApi,
    getConfig: () => ({ browserWs: 'ws://127.0.0.1:9222', chromePath: '' }),
    findExecutable: () => 'unused',
  });

  const result = await browserSolve({
    url: 'https://example.test/challenge',
    proxy: '',
    allowCdp: true,
    ua: CHROME_131_UA,
  });

  assert.equal(result.cleared, false);
  assert.equal(result.cookieHeader, '');
  assert.equal(fixture.calls.contextClose, 1);
});

test('CapSolver aborts a hanging request and retains a typed timeout cause', async () => {
  const createCapSolver = requireExport('createCapSolver');
  const timers = [];
  const capsolver = createCapSolver({
    fetchFn: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    setTimer: callback => {
      timers.push(callback);
      return callback;
    },
    clearTimer: () => {},
    sleep: async () => {},
    requestTimeoutMs: 100,
    overallTimeoutMs: 500,
  });

  const pending = capsolver({
    url: 'https://example.test/challenge',
    html: '<html>challenge</html>',
    ua: CHROME_131_UA,
    proxy: 'http://proxy.test:8080',
    apiKey: 'key',
  });
  await Promise.resolve();
  timers.at(-1)();

  await assert.rejects(
    () => pending,
    error => {
      assert.equal(error.code, 'capsolver_timeout');
      return true;
    },
  );
});

test('CapSolver overall timeout aborts a pending poll delay', async () => {
  const createCapSolver = requireExport('createCapSolver');
  const timers = [];
  const capsolver = createCapSolver({
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ taskId: 'task-1' }),
    }),
    setTimer: callback => {
      timers.push(callback);
      return callback;
    },
    clearTimer: () => {},
    sleep: async (_delay, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    requestTimeoutMs: 100,
    overallTimeoutMs: 500,
  });

  const pending = capsolver({
    url: 'https://example.test/challenge',
    html: '<html>challenge</html>',
    ua: CHROME_131_UA,
    proxy: 'http://proxy.test:8080',
    apiKey: 'key',
  });
  await new Promise(resolve => setImmediate(resolve));
  timers[0]();

  await assert.rejects(
    () => pending,
    error => {
      assert.equal(error.code, 'capsolver_timeout');
      assert.match(error.message, /overall timeout/i);
      return true;
    },
  );
});

test('CapSolver preserves provider error codes and supplies AbortSignal to every request', async () => {
  const createCapSolver = requireExport('createCapSolver');
  const signals = [];
  const capsolver = createCapSolver({
    fetchFn: async (_url, options) => {
      signals.push(options.signal);
      return {
        ok: true,
        json: async () => ({
          errorId: 1,
          errorCode: 'ERROR_ZERO_BALANCE',
          errorDescription: 'balance is empty',
        }),
      };
    },
    setTimer: () => 1,
    clearTimer: () => {},
    sleep: async () => {},
  });

  await assert.rejects(
    () => capsolver({
      url: 'https://example.test/challenge',
      html: '<html>challenge</html>',
      ua: CHROME_131_UA,
      proxy: 'http://proxy.test:8080',
      apiKey: 'key',
    }),
    error => {
      assert.equal(error.code, 'ERROR_ZERO_BALANCE');
      assert.match(error.message, /balance is empty/i);
      return true;
    },
  );
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
});

test('CapSolver preserves a provider error body returned with HTTP 400', async () => {
  const createCapSolver = requireExport('createCapSolver');
  const capsolver = createCapSolver({
    fetchFn: async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        errorId: 1,
        errorCode: 'ERROR_TASK_NOT_SUPPORTED',
        errorDescription: 'task payload is not supported',
      }),
    }),
    setTimer: () => 1,
    clearTimer: () => {},
    sleep: async () => {},
  });

  await assert.rejects(
    () => capsolver({
      url: 'https://example.test/challenge',
      html: '<html>challenge</html>',
      ua: CHROME_131_UA,
      proxy: 'http://proxy.test:8080',
      apiKey: 'key',
    }),
    error => {
      assert.equal(error.code, 'ERROR_TASK_NOT_SUPPORTED');
      assert.match(error.message, /task payload is not supported/i);
      return true;
    },
  );
});

test('CapSolver keeps the replay identity on canonical Chrome 131', async () => {
  const createCapSolver = requireExport('createCapSolver');
  let call = 0;
  const requestBodies = [];
  const capsolver = createCapSolver({
    fetchFn: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => (++call === 1
          ? { taskId: 'task-1' }
          : {
            status: 'ready',
            solution: {
              cookies: {
                session: 'private',
                cf_clearance: 'clear-token',
              },
              userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
            },
          }),
      };
    },
    setTimer: () => 1,
    clearTimer: () => {},
    sleep: async () => {},
  });

  const result = await capsolver({
    url: 'https://example.test/challenge',
    html: '<html>challenge</html>',
    ua: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
    proxy: 'http://proxy.test:8080',
    apiKey: 'key',
  });

  assert.equal(result.cookieHeader, 'cf_clearance=clear-token');
  assert.equal(result.ua, CHROME_131_UA);
  assert.equal(requestBodies[0].task.userAgent, CHROME_131_UA);
});

test('coordinator retains the solver cause and always removes failed in-flight entries', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  const providerError = Object.assign(new Error('bad proxy'), { code: 'ERROR_PROXY_CONNECT_FAILED' });
  let capsolverCalls = 0;
  const coordinator = createChallengeCoordinator({
    browser: async () => null,
    capsolver: async () => {
      capsolverCalls += 1;
      throw providerError;
    },
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => coordinator.solve('https://example.test/a', 'http://proxy.test', '<html>x</html>', 'chrome131'),
      error => {
        assertChallengeFailure(error);
        assert.equal(error.cause, providerError);
        return true;
      },
    );
    assert.equal(coordinator.inspect().inFlightSize, 0);
  }
  assert.equal(capsolverCalls, 2);
});

test('expired and excess cache entries are pruned and generation state stays bounded', async () => {
  const createChallengeCoordinator = requireExport('createChallengeCoordinator');
  let clock = 0;
  let browserCalls = 0;
  const coordinator = createChallengeCoordinator({
    ttl: 5,
    maxEntries: 3,
    now: () => clock,
    browser: async () => ({
      cookieHeader: `cf_clearance=token-${++browserCalls}`,
      ua: CHROME_131_UA,
    }),
    capsolver: async () => null,
  });

  for (let index = 0; index < 20; index += 1) {
    clock = index;
    await coordinator.solve(`https://host-${index}.test/a`, '', '', 'chrome131');
  }
  const bounded = coordinator.inspect();
  assert.ok(bounded.cacheSize <= 3);
  assert.equal(bounded.inFlightSize, 0);
  assert.equal(bounded.generationSize, 0);

  clock = 100;
  await coordinator.solve('https://fresh.test/a', '', '', 'chrome131');
  assert.ok(coordinator.inspect().cacheSize <= 1);
});
