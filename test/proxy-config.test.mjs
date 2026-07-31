import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxyConfig, normalizeProxy, parseProxyLines } from '../src/proxy-config.js';

test('normalizes supported proxy forms and rejects unsupported input', () => {
  assert.equal(normalizeProxy('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(normalizeProxy('127.0.0.1:8080:user:p@ss'), 'http://user:p%40ss@127.0.0.1:8080/');
  assert.equal(normalizeProxy('https://user:pass@example.com:8443'), 'https://user:pass@example.com:8443/');
  assert.equal(normalizeProxy('socks5://127.0.0.1:1080'), '');
  assert.equal(normalizeProxy('127.0.0.1:70000'), '');
});

test('parses lines, removes duplicates, and reports invalid rows', () => {
  assert.deepEqual(parseProxyLines([
    'proxy',
    '127.0.0.1:8080',
    '127.0.0.1:8080',
    'bad',
    'https://example.com:8443'
  ].join('\n')), {
    proxies: ['http://127.0.0.1:8080/', 'https://example.com:8443/'],
    valid: 2,
    duplicate: 1,
    invalid: 1
  });
});

test('persists a redacted saved pool and selects it round-robin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-proxy-config-'));
  try {
    const file = path.join(root, 'config', 'proxy.json');
    const config = createProxyConfig({ file, env: {} });
    const saved = config.replace([
      'http://user:secret@proxy-one.test:8080',
      'https://proxy-two.test:8443'
    ]);
    assert.equal(saved.ok, true);
    assert.equal(config.proxyFor(0), 'http://user:secret@proxy-one.test:8080/');
    assert.equal(config.proxyFor(1), 'https://proxy-two.test:8443/');
    assert.equal(config.proxyFor(2), 'http://user:secret@proxy-one.test:8080/');
    assert.doesNotMatch(JSON.stringify(config.publicView()), /secret/);
    assert.match(config.publicView().items[0].label, /\*\*\*/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('environment pool is authoritative and local save cannot overwrite it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-proxy-config-'));
  try {
    const config = createProxyConfig({
      file: path.join(root, 'proxy.json'),
      env: {
        PROXY_POOL: 'http://env-one.test:8001,http://env-two.test:8002',
        CF_PROXY: 'http://fallback.test:8003'
      }
    });
    assert.equal(config.publicView().source, 'environment_pool');
    assert.equal(config.publicView().locked, true);
    assert.equal(config.proxyFor(1), 'http://env-two.test:8002/');
    assert.deepEqual(config.replace(['http://local.test:9000']), {
      ok: false,
      error: 'proxy_pool_managed_by_environment'
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saved pool precedes single-proxy fallbacks and test errors stay redacted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-proxy-config-'));
  try {
    const seen = [];
    const config = createProxyConfig({
      file: path.join(root, 'proxy.json'),
      env: { CF_PROXY: 'http://cf.test:8000', HTTPS_PROXY: 'http://https.test:9000' },
      testRequest: async proxy => {
        seen.push(proxy);
        throw new Error(`cannot use ${proxy}`);
      }
    });
    assert.equal(config.proxyFor(0), 'http://cf.test:8000/');
    config.replace(['http://user:secret@local.test:7000']);
    assert.equal(config.proxyFor(0), 'http://user:secret@local.test:7000/');
    const result = await config.test('http://user:secret@test.test:7443');
    assert.equal(result.ok, false);
    assert.equal(seen.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exposes an internal ordered snapshot and short-lived health without leaking it publicly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-proxy-config-'));
  try {
    let now = 1_000;
    const config = createProxyConfig({
      file: path.join(root, 'proxy.json'),
      env: {},
      now: () => now,
      testRequest: async () => ({ detail: '203.0.113.8' })
    });
    config.replace([
      'http://user:secret@one.test:8001',
      'https://two.test:8002'
    ]);

    const snapshot = config.snapshot();
    assert.deepEqual(snapshot, [
      'http://user:secret@one.test:8001/',
      'https://two.test:8002/'
    ]);
    snapshot.shift();
    assert.equal(config.snapshot().length, 2);

    const tested = await config.testAt(0);
    assert.equal(tested.ok, true);
    assert.deepEqual(config.cachedHealthAt(0, 120_000), {
      ok: true,
      latencyMs: tested.latencyMs,
      detail: '203.0.113.8',
      checkedAt: 1_000
    });
    assert.doesNotMatch(JSON.stringify(config.publicView()), /secret|203\.0\.113\.8/);

    now += 120_001;
    assert.equal(config.cachedHealthAt(0, 120_000), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('records a runtime proxy failure so the next scheduler can skip the same slot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-proxy-config-'));
  try {
    const config = createProxyConfig({
      file: path.join(root, 'proxy.json'),
      env: {},
      now: () => 5_000
    });
    config.replace(['http://one.test:8001', 'http://two.test:8002']);
    assert.equal(config.recordHealthAt(0, {
      ok: false,
      error: 'proxy_connection_failed'
    }), true);
    assert.deepEqual(config.cachedHealthAt(0), {
      ok: false,
      error: 'proxy_connection_failed',
      checkedAt: 5_000
    });
    assert.equal(config.cachedHealthAt(1), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
