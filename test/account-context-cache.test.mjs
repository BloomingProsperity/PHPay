import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountContextCache } from '../src/account-context-cache.js';

const freeContext = {
  token: 'token',
  email: 'person@example.com',
  status: { state: 'free', plan: 'chatgptfreeplan', errorCode: '' }
};

test('coalesces concurrent account loads and reuses a fresh successful context', async () => {
  let calls = 0;
  let now = 1_000;
  const cache = createAccountContextCache({ ttlMs: 120_000, now: () => now });
  const loader = async () => {
    calls += 1;
    await new Promise(resolve => setImmediate(resolve));
    return freeContext;
  };

  const [first, second] = await Promise.all([
    cache.load('accounts_one', loader),
    cache.load('accounts_one', loader)
  ]);

  assert.deepEqual(first, freeContext);
  assert.deepEqual(second, freeContext);
  assert.equal(calls, 1);

  now += 119_999;
  assert.deepEqual(await cache.load('accounts_one', loader), freeContext);
  assert.equal(calls, 1);

  now += 2;
  await cache.load('accounts_one', loader);
  assert.equal(calls, 2);
});

test('does not cache failed account states for the fast payment path', async () => {
  let calls = 0;
  const cache = createAccountContextCache();
  const loader = async () => {
    calls += 1;
    return {
      token: 'token',
      email: 'person@example.com',
      status: { state: 'error', plan: '', errorCode: 'account_status_check_failed' }
    };
  };

  await cache.load('accounts_one', loader);
  await cache.load('accounts_one', loader);
  assert.equal(calls, 2);
  assert.equal(cache.peek('accounts_one'), null);
});

test('supports explicit invalidation and keeps deployment instances isolated', async () => {
  const first = createAccountContextCache();
  const second = createAccountContextCache();
  await first.load('accounts_one', async () => freeContext);

  assert.deepEqual(first.peek('accounts_one'), freeContext);
  assert.equal(second.peek('accounts_one'), null);

  first.invalidate('accounts_one');
  assert.equal(first.peek('accounts_one'), null);

  await first.load('accounts_two', async () => freeContext);
  first.clear();
  assert.equal(first.peek('accounts_two'), null);
});

test('primes a detected account context for the immediate payment path', () => {
  const cache = createAccountContextCache();

  assert.equal(cache.prime('accounts_one', freeContext), true);
  assert.deepEqual(cache.peek('accounts_one'), freeContext);

  assert.equal(cache.prime('accounts_bad', {
    ...freeContext,
    status: { state: 'invalid', plan: '', errorCode: 'invalid_account_credential' }
  }), false);
  assert.equal(cache.peek('accounts_bad'), null);
});
