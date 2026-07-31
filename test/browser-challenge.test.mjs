import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import * as browser from '../src/browser.js';

const challengeHtml = '<!doctype html><title>Just a moment...</title><p>Checking your browser</p>';
const response = ({
  status = 200,
  contentType = 'application/json',
  cfMitigated = '',
  html = '',
  json = {},
} = {}) => ({
  status,
  json,
  headers: { contentType, cfMitigated },
  ...(html ? { html } : {}),
});

function requireExport(name, type = 'function') {
  assert.equal(typeof browser[name], type, `${name} must be exported`);
  return browser[name];
}

function assertChallengeError(error) {
  const ErrorType = requireExport('CloudflareChallengeError');
  assert.ok(error instanceof ErrorType);
  assert.equal(error.code, 'cloudflare_challenge_failed');
  return true;
}

test('exports the challenge transport API', () => {
  requireExport('isChallengeResponse');
  requireExport('createCgFetch');
  requireExport('CloudflareChallengeError');
});

test('recognizes the cf-mitigated challenge header case-insensitively', () => {
  const isChallengeResponse = requireExport('isChallengeResponse');

  assert.equal(isChallengeResponse({
    status: 200,
    headers: { CfMiTiGaTeD: 'ChAlLeNgE', contentType: 'application/json' },
    json: {},
  }), true);
});

test('recognizes challenge HTML only for 403, 429, and 503 fallback statuses', () => {
  const isChallengeResponse = requireExport('isChallengeResponse');

  for (const status of [403, 429, 503]) {
    assert.equal(isChallengeResponse(response({
      status,
      contentType: 'Text/HTML; charset=UTF-8',
      html: challengeHtml,
    })), true, `status ${status}`);
  }
  assert.equal(isChallengeResponse(response({
    status: 500,
    contentType: 'text/html',
    html: challengeHtml,
  })), false);
  assert.equal(isChallengeResponse(response({
    status: 403,
    contentType: 'text/html',
    html: '<html><p>ordinary forbidden page</p></html>',
  })), false);
});

test('does not classify an ordinary 403 JSON response as a challenge', () => {
  const isChallengeResponse = requireExport('isChallengeResponse');

  assert.equal(isChallengeResponse(response({
    status: 403,
    contentType: 'application/json',
    json: { error: 'forbidden', message: 'verify you are human' },
  })), false);
});

test('passes one normalized proxy and impersonation to raw fetch and solver', async () => {
  const createCgFetch = requireExport('createCgFetch');
  const rawCalls = [];
  const solveCalls = [];
  const rawFetch = async (requestPath, opts) => {
    rawCalls.push({ requestPath, opts });
    return rawCalls.length === 1
      ? response({ status: 403, contentType: 'text/html', html: challengeHtml })
      : response({ json: { ok: true } });
  };
  const solve = async (...args) => {
    solveCalls.push(args);
    return { cleared: true, cookieHeader: 'cf_clearance=clear-token', ua: 'solver-ua' };
  };

  const cgFetch = createCgFetch({ rawFetch, solve, clear: () => {} });
  const result = await cgFetch('/backend-api/test', {
    proxy: '  http://effective-proxy  ',
    imp: 'safari18_0',
  });

  assert.deepEqual(result.json, { ok: true });
  assert.equal(rawCalls.length, 2);
  for (const call of rawCalls) {
    assert.equal(call.opts.proxy, 'http://effective-proxy');
    assert.equal(call.opts.imp, 'safari18_0');
  }
  assert.deepEqual(solveCalls, [[
    'https://chatgpt.com/backend-api/test',
    'http://effective-proxy',
    challengeHtml,
    'safari18_0',
    {
      method: 'GET',
      token: '',
      headers: {},
      body: null,
    },
  ]]);
});

test('returns an authenticated local-browser response without replaying the protocol request', async () => {
  const createCgFetch = requireExport('createCgFetch');
  const rawCalls = [];
  const solveCalls = [];
  const directResponse = response({
    status: 200,
    json: { accounts: [{ id: 'account-1' }] },
  });
  const cgFetch = createCgFetch({
    rawFetch: async (requestPath, opts) => {
      rawCalls.push({ requestPath, opts });
      return response({ status: 403, contentType: 'text/html', html: challengeHtml });
    },
    solve: async (...args) => {
      solveCalls.push(args);
      return { directResponse, via: 'browser' };
    },
    clear: () => {},
  });

  const result = await cgFetch('/backend-api/accounts/check/v4-2023-04-27', {
    method: 'POST',
    token: 'private-access-token',
    headers: {
      Cookie: '__Secure-next-auth.session-token=private-session',
      'X-Request-Id': 'request-1',
    },
    body: { requested: true },
    proxy: 'http://effective-proxy',
  });

  assert.equal(result, directResponse);
  assert.equal(rawCalls.length, 1);
  assert.deepEqual(solveCalls[0][4], {
    method: 'POST',
    token: 'private-access-token',
    headers: {
      Cookie: '__Secure-next-auth.session-token=private-session',
      'X-Request-Id': 'request-1',
    },
    body: { requested: true },
  });
});

test('rejects a local-browser response that is still a Cloudflare challenge', async () => {
  const createCgFetch = requireExport('createCgFetch');
  const clearCalls = [];
  const cgFetch = createCgFetch({
    rawFetch: async () => response({
      status: 403,
      contentType: 'text/html',
      html: challengeHtml,
    }),
    solve: async () => ({
      directResponse: response({
        status: 403,
        contentType: 'text/html',
        html: challengeHtml,
      }),
      via: 'browser',
    }),
    clear: (...args) => clearCalls.push(args),
  });

  await assert.rejects(
    () => cgFetch('/backend-api/test', { token: 'private-token' }),
    assertChallengeError,
  );
  assert.deepEqual(clearCalls, [[
    'https://chatgpt.com/backend-api/test',
    '',
  ]]);
});

test('replays only cf_clearance from solver cookies and attaches solver UA', async () => {
  const createCgFetch = requireExport('createCgFetch');
  const rawCalls = [];
  const rawFetch = async (_requestPath, opts) => {
    rawCalls.push(opts);
    return rawCalls.length === 1
      ? response({ status: 503, contentType: 'text/html', html: challengeHtml })
      : response({ json: { ok: true } });
  };
  const solve = async () => ({
    cleared: true,
    cookieHeader: 'session=do-not-replay; cf_clearance=clear-token==; other=do-not-replay',
    ua: 'solver-ua',
  });

  const cgFetch = createCgFetch({ rawFetch, solve, clear: () => {} });
  await cgFetch('/backend-api/test', {
    headers: {
      'User-Agent': 'old-upper-ua',
      'user-agent': 'old-lower-ua',
      'USER-AGENT': 'old-caps-ua',
      Cookie: 'session=original-session; cf_clearance=stale-one',
      cookie: 'theme=dark; cf_clearance=stale-two',
      COOKIE: 'other=keep',
    },
  });

  assert.deepEqual(
    Object.entries(rawCalls[1].headers).filter(([key]) => key.toLowerCase() === 'cookie'),
    [[
      'Cookie',
      'session=original-session; theme=dark; other=keep; cf_clearance=clear-token==',
    ]],
  );
  assert.deepEqual(
    Object.entries(rawCalls[1].headers).filter(([key]) => key.toLowerCase() === 'user-agent'),
    [['User-Agent', 'solver-ua']],
  );
  assert.equal((rawCalls[1].headers.Cookie.match(/cf_clearance=/g) || []).length, 1);
  assert.doesNotMatch(rawCalls[1].headers.Cookie, /do-not-replay|stale-/);
});

test('uses a Chrome 131 UA when the solver UA is empty', async () => {
  const createCgFetch = requireExport('createCgFetch');
  const rawCalls = [];
  const cgFetch = createCgFetch({
    rawFetch: async (_requestPath, opts) => {
      rawCalls.push(opts);
      return rawCalls.length === 1
        ? response({ status: 503, contentType: 'text/html', html: challengeHtml })
        : response({ json: { ok: true } });
    },
    solve: async () => ({
      cleared: true,
      cookieHeader: 'cf_clearance=clear-token',
      ua: '',
    }),
    clear: () => {},
  });

  await cgFetch('/backend-api/test', {
    headers: { 'user-agent': 'stale-ua' },
  });

  assert.deepEqual(
    Object.entries(rawCalls[1].headers).filter(([key]) => key.toLowerCase() === 'user-agent'),
    [['User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36']],
  );
});

test('throws a typed error when solving is unresolved or yields no clearance', async (t) => {
  const createCgFetch = requireExport('createCgFetch');
  const cases = [
    ['unresolved', { cleared: false, cookieHeader: 'cf_clearance=token' }],
    ['empty result', null],
    ['no cf_clearance', { cleared: true, cookieHeader: 'session=do-not-replay' }],
    ['empty cf_clearance', { cleared: true, cookieHeader: 'cf_clearance=' }],
  ];

  for (const [name, solution] of cases) {
    await t.test(name, async () => {
      const cgFetch = createCgFetch({
        rawFetch: async () => response({
          status: 403,
          contentType: 'text/html',
          html: challengeHtml,
        }),
        solve: async () => solution,
        clear: () => {},
      });

      await assert.rejects(() => cgFetch('/test'), assertChallengeError);
    });
  }
});

test('clears the solve cache and throws a typed error when replay is challenged again', async () => {
  const createCgFetch = requireExport('createCgFetch');
  const clearCalls = [];
  const cgFetch = createCgFetch({
    rawFetch: async () => response({
      status: 429,
      contentType: 'text/html',
      html: challengeHtml,
    }),
    solve: async () => ({
      cleared: true,
      cookieHeader: 'cf_clearance=clear-token',
      ua: 'solver-ua',
    }),
    clear: (...args) => clearCalls.push(args),
  });

  await assert.rejects(
    () => cgFetch('/backend-api/test', { proxy: 'http://effective-proxy' }),
    assertChallengeError,
  );
  assert.deepEqual(clearCalls, [[
    'https://chatgpt.com/backend-api/test',
    'http://effective-proxy',
  ]]);
});

test('normalizes solver exceptions to CloudflareChallengeError', async () => {
  const createCgFetch = requireExport('createCgFetch');
  const cause = new Error('solver exploded');
  const cgFetch = createCgFetch({
    rawFetch: async () => response({
      status: 403,
      contentType: 'text/html',
      html: challengeHtml,
    }),
    solve: async () => { throw cause; },
    clear: () => {},
  });

  await assert.rejects(
    () => cgFetch('/test'),
    error => {
      assertChallengeError(error);
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test('cffetch honors the requested fingerprint and gates full HTML output', () => {
  const fakeRoot = mkdtempSync(path.join(tmpdir(), 'dipay-cffetch-'));
  const packageDir = path.join(fakeRoot, 'curl_cffi');
  mkdirSync(packageDir);
  writeFileSync(path.join(packageDir, '__init__.py'), `
import os

class Response:
    def __init__(self, owner, method, url, kwargs):
        self.owner = owner
        self.method = method
        self.url = url
        self.kwargs = kwargs
        self.status_code = int(os.environ.get("FAKE_STATUS", "200"))
        self.headers = {
            "content-type": os.environ.get("FAKE_CONTENT_TYPE", "application/json"),
            "cf-mitigated": os.environ.get("FAKE_CF_MITIGATED", ""),
        }
        self.text = os.environ.get("FAKE_TEXT", "")

    def json(self):
        return {
            "callCount": self.owner.call_count,
            "method": self.method,
            "url": self.url,
            "impersonate": self.kwargs.get("impersonate"),
        }

class Requests:
    def __init__(self):
        self.call_count = 0

    def request(self, method, url, **kwargs):
        self.call_count += 1
        return Response(self, method, url, kwargs)

requests = Requests()
`);

  const python = process.env.PYTHON_BIN || 'python';
  const script = path.resolve('cffetch.py');
  const run = overrides => {
    const child = spawnSync(python, [script], {
      encoding: 'utf8',
      input: JSON.stringify({
        method: 'POST',
        url: 'https://example.test/resource',
        body: { nonIdempotent: true },
        impersonate: 'safari18_0',
      }),
      env: {
        ...process.env,
        PYTHONPATH: fakeRoot,
        ...overrides,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };

  const candidate = run({
    FAKE_STATUS: '503',
    FAKE_CONTENT_TYPE: 'text/html; charset=utf-8',
    FAKE_TEXT: challengeHtml,
  });
  assert.equal(candidate.json.callCount, 1);
  assert.equal(candidate.json.impersonate, 'safari18_0');
  assert.equal(candidate.impersonate, 'safari18_0');
  assert.deepEqual(candidate.headers, {
    contentType: 'text/html; charset=utf-8',
    cfMitigated: '',
  });
  assert.equal(candidate.html, challengeHtml);

  const headerChallenge = run({
    FAKE_STATUS: '200',
    FAKE_CONTENT_TYPE: 'application/json',
    FAKE_CF_MITIGATED: 'challenge',
    FAKE_TEXT: challengeHtml,
  });
  assert.equal(headerChallenge.html, challengeHtml);

  const ordinaryHtml = run({
    FAKE_STATUS: '200',
    FAKE_CONTENT_TYPE: 'text/html',
    FAKE_TEXT: '<html>ordinary page</html>',
  });
  assert.equal('html' in ordinaryHtml, false);
});

test('production cgFetch rejects a non-zero Python subprocess exit', () => {
  const script = `
    import { cgFetch } from ${JSON.stringify(new URL('../src/browser.js', import.meta.url).href)};
    try {
      await cgFetch('/test');
      process.exitCode = 9;
    } catch (error) {
      console.log(error.message);
      if (!/exited with code/i.test(error.message)) process.exitCode = 8;
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHON_BIN: process.execPath },
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /exited with code/i);
});

test('production cgFetch kills Python when stdout or stderr exceeds its byte limit', async (t) => {
  const fakeRoot = mkdtempSync(path.join(tmpdir(), 'dipay-cffetch-large-output-'));
  t.after(() => rmSync(fakeRoot, { recursive: true, force: true }));
  const packageDir = path.join(fakeRoot, 'curl_cffi');
  mkdirSync(packageDir);
  writeFileSync(path.join(packageDir, '__init__.py'), `
import os
import sys
import time

stream = os.environ["FAKE_LARGE_STREAM"]
target = sys.stdout if stream == "stdout" else sys.stderr
target.write("x" * (2 * 1024 * 1024))
target.flush()
time.sleep(10)
`);
  const moduleUrl = JSON.stringify(new URL('../src/browser.js', import.meta.url).href);
  const python = process.env.PYTHON_BIN || 'python';

  for (const stream of ['stdout', 'stderr']) {
    await t.test(stream, () => {
      const script = `
        import { cgFetch } from ${moduleUrl};
        try {
          await cgFetch('/test');
          process.exitCode = 9;
        } catch (error) {
          console.log(error.message);
          if (!/${stream} exceeded 1048576 byte limit/i.test(error.message)) process.exitCode = 8;
        }
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          PYTHON_BIN: python,
          PYTHONPATH: fakeRoot,
          FAKE_LARGE_STREAM: stream,
        },
      });

      assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
      assert.match(child.stdout, new RegExp(`${stream} exceeded 1048576 byte limit`, 'i'));
    });
  }
});
