import test from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveImpersonation,
  effectiveProxy,
  normalizeNetworkContext,
} from '../src/network-context.js';
import { DEFAULT_IMPERSONATION, IMPS } from '../src/fprints.js';

test('effectiveProxy prefers a non-empty explicit proxy', () => {
  const env = {
    CF_PROXY: 'http://cf-proxy',
    HTTPS_PROXY: 'http://upper-proxy',
    https_proxy: 'http://lower-proxy',
  };

  assert.equal(effectiveProxy('  http://explicit-proxy  ', env), 'http://explicit-proxy');
});

test('effectiveProxy falls back through configured proxy environment variables', () => {
  assert.equal(
    effectiveProxy('', {
      CF_PROXY: '  http://cf-proxy  ',
      HTTPS_PROXY: 'http://upper-proxy',
      https_proxy: 'http://lower-proxy',
    }),
    'http://cf-proxy',
  );
  assert.equal(
    effectiveProxy('   ', {
      CF_PROXY: '   ',
      HTTPS_PROXY: '  http://upper-proxy  ',
      https_proxy: 'http://lower-proxy',
    }),
    'http://upper-proxy',
  );
  assert.equal(
    effectiveProxy('', {
      CF_PROXY: '',
      HTTPS_PROXY: '',
      https_proxy: '  http://lower-proxy  ',
    }),
    'http://lower-proxy',
  );
  assert.equal(effectiveProxy('', {}), '');
});

test('effectiveImpersonation passes through pool members and falls back otherwise', () => {
  for (const value of IMPS) {
    assert.equal(effectiveImpersonation(value), value);
  }
  for (const value of ['', 'chrome131', 'chrome119', 'firefox', 'bogus']) {
    assert.equal(effectiveImpersonation(value), DEFAULT_IMPERSONATION);
  }
});

test('normalizeNetworkContext returns the effective proxy and fingerprint', () => {
  assert.deepEqual(
    normalizeNetworkContext(
      { proxy: '   ', imp: 'safari18_0' },
      { CF_PROXY: '', HTTPS_PROXY: '  http://fallback-proxy  ' },
    ),
    {
      proxy: 'http://fallback-proxy',
      imp: 'safari18_0',
    },
  );
});

test('the fingerprint pool contains multiple proven fingerprints with a strong default', () => {
  assert.equal(DEFAULT_IMPERSONATION, 'edge99');
  assert.ok(IMPS.length >= 10);
  assert.ok(!IMPS.includes('chrome131'));
});
