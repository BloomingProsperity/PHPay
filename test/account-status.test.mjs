import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAccountStatus, normalizeAccountStatus, normalizePlanTier } from '../src/account-status.js';
import { resolveToken } from '../src/browser.js';
import { assertAccountCanSubscribe, createPaymentFlows } from '../src/payment.js';
import { safePaymentErrorCode } from '../src/payment-error.js';

test('account status reports an active paid plan from current entitlement data', () => {
  const status = normalizeAccountStatus({
    accounts: {
      team: { entitlement: { has_active_subscription: false, subscription_plan: 'chatgptteamplan' } },
      personal: { entitlement: { has_active_subscription: true, subscription_plan: 'chatgptplus' } }
    }
  });
  assert.deepEqual(status, { state: 'active', plan: 'chatgptplusplan', errorCode: '' });
});

test('plan tiers normalize canonical values and the legacy plus alias', () => {
  for (const plan of [
    'chatgptfreeplan',
    'chatgptplusplan',
    'chatgptgoplan',
    'chatgptprolite',
    'chatgptpro',
    'chatgptteamplan'
  ]) {
    assert.equal(normalizePlanTier(plan), plan);
  }
  assert.equal(normalizePlanTier(' ChatGPTPlus '), 'chatgptplusplan');
  assert.equal(normalizePlanTier('paid'), '');
  assert.equal(normalizePlanTier(null), '');
});

test('plan tiers reject inherited object property names', () => {
  for (const plan of ['constructor', '__proto__', 'toString']) {
    assert.equal(normalizePlanTier(plan), '', plan);
  }
});

test('account status rejects an unknown active plan', () => {
  assert.throws(
    () => normalizeAccountStatus({
      accounts: {
        personal: { entitlement: { has_active_subscription: true, subscription_plan: 'provider-new-plan' } }
      }
    }),
    error => error?.code === 'account_status_check_failed'
  );
});

test('account status rejects a known and unknown active plan in either insertion order', () => {
  const known = { entitlement: { has_active_subscription: true, subscription_plan: 'chatgptplusplan' } };
  const unknown = { entitlement: { has_active_subscription: true, subscription_plan: 'provider-new-plan' } };
  for (const accounts of [
    { known, unknown },
    { unknown, known }
  ]) {
    assert.throws(
      () => normalizeAccountStatus({ accounts }),
      error => error?.code === 'account_status_check_failed'
    );
  }
});

test('account status rejects different active plans in either insertion order', () => {
  const plus = { entitlement: { has_active_subscription: true, subscription_plan: 'chatgptplusplan' } };
  const pro = { entitlement: { has_active_subscription: true, subscription_plan: 'chatgptpro' } };
  for (const accounts of [
    { plus, pro },
    { pro, plus }
  ]) {
    assert.throws(
      () => normalizeAccountStatus({ accounts }),
      error => error?.code === 'account_status_check_failed'
    );
  }
});

test('account status accepts multiple active entries for the same canonical plan', () => {
  const status = normalizeAccountStatus({
    accounts: {
      personal: { entitlement: { has_active_subscription: true, subscription_plan: 'chatgptplus' } },
      workspace: { entitlement: { has_active_subscription: true, subscription_plan: 'chatgptplusplan' } }
    }
  });
  assert.deepEqual(status, { state: 'active', plan: 'chatgptplusplan', errorCode: '' });
});

test('account status reports free when no account has an active subscription', () => {
  const status = normalizeAccountStatus({
    accounts: {
      expired: { entitlement: { has_active_subscription: false, subscription_plan: 'chatgptteamplan' } },
      personal: { entitlement: { has_active_subscription: false, subscription_plan: 'chatgptfreeplan' } }
    }
  });
  assert.deepEqual(status, { state: 'free', plan: 'chatgptfreeplan', errorCode: '' });
});

test('account status rejects an unrecognized provider response', () => {
  assert.throws(() => normalizeAccountStatus({}), /account status response/);
});

test('account status rejects accounts whose entitlement flag is missing or malformed', () => {
  for (const payload of [
    { accounts: { personal: {} } },
    { accounts: { personal: { entitlement: {} } } },
    { accounts: { personal: { entitlement: { has_active_subscription: 'false' } } } }
  ]) {
    assert.throws(
      () => normalizeAccountStatus(payload),
      error => error?.code === 'account_status_check_failed'
    );
  }
});

test('account status fails closed when valid and malformed account entries are mixed', () => {
  for (const malformed of [
    {},
    { entitlement: {} },
    { entitlement: { has_active_subscription: 'false' } }
  ]) {
    assert.throws(
      () => normalizeAccountStatus({
        accounts: {
          personal: { entitlement: { has_active_subscription: false } },
          malformed
        }
      }),
      error => error?.code === 'account_status_check_failed'
    );
  }
});

test('account detection treats only explicit authentication evidence as invalid', async () => {
  const sessionJson = JSON.stringify({ accessToken: 'token' });
  const resolved = async () => ({ token: 'token', email: 'person@example.com' });

  const unauthorized = await detectAccountStatus(sessionJson, {
    resolveTokenFn: resolved,
    getAccountStatusFn: async () => ({ status: 401, json: {} })
  });
  assert.deepEqual(unauthorized, { state: 'invalid', plan: '', errorCode: 'invalid_account_credential' });

  const explicit = await detectAccountStatus(sessionJson, {
    resolveTokenFn: async () => {
      const error = new Error('credential rejected');
      error.code = 'invalid_account_credential';
      throw error;
    },
    getAccountStatusFn: async () => {
      throw new Error('must not be reached');
    }
  });
  assert.deepEqual(explicit, { state: 'invalid', plan: '', errorCode: 'invalid_account_credential' });

  const thrownUnauthorized = await detectAccountStatus(sessionJson, {
    resolveTokenFn: async () => {
      const error = new Error('authentication failed');
      error.status = 401;
      throw error;
    },
    getAccountStatusFn: async () => {
      throw new Error('must not be reached');
    }
  });
  assert.deepEqual(thrownUnauthorized, { state: 'invalid', plan: '', errorCode: 'invalid_account_credential' });
});

test('account detection keeps challenge, throttling, provider and misleading text failures retryable', async () => {
  const sessionJson = JSON.stringify({ accessToken: 'token' });
  const cases = [
    Object.assign(new Error('Cloudflare challenge unresolved'), { code: 'cloudflare_challenge_failed' }),
    Object.assign(new Error('rate limited'), { code: 'http_429' }),
    Object.assign(new Error('provider unavailable'), { code: 'http_503' }),
    new Error('invalid sessionToken shape from an upstream HTML page')
  ];

  for (const thrown of cases) {
    const status = await detectAccountStatus(sessionJson, {
      resolveTokenFn: async () => { throw thrown; },
      getAccountStatusFn: async () => {
        throw new Error('must not be reached');
      }
    });
    assert.deepEqual(status, { state: 'error', plan: '', errorCode: 'account_status_check_failed' });
  }

  const forbidden = await detectAccountStatus(sessionJson, {
    resolveTokenFn: async () => ({ token: 'token', email: '' }),
    getAccountStatusFn: async () => ({ status: 403, json: { error: 'challenge' } })
  });
  assert.deepEqual(forbidden, { state: 'error', plan: '', errorCode: 'account_status_check_failed' });
});

test('account detection reuses an already resolved access token', async () => {
  let resolveCalls = 0;
  let receivedToken = '';
  const status = await detectAccountStatus(JSON.stringify({ sessionToken: 'session-token' }), {
    token: 'resolved-access-token',
    resolveTokenFn: async () => {
      resolveCalls += 1;
      return { token: 'unexpected-token', email: '' };
    },
    getAccountStatusFn: async token => {
      receivedToken = token;
      return {
        status: 200,
        json: {
          accounts: {
            personal: { entitlement: { has_active_subscription: false } }
          }
        }
      };
    }
  });

  assert.equal(resolveCalls, 0);
  assert.equal(receivedToken, 'resolved-access-token');
  assert.equal(status.state, 'free');
});

test('account detection exchanges the session token when the stored access token is rejected', async () => {
  const sessionJson = JSON.stringify({
    accessToken: 'stale-access-token',
    sessionToken: 'current-session-token',
    user: { email: 'person@example.com' }
  });
  const resolvedInputs = [];
  const requestedTokens = [];
  const status = await detectAccountStatus(sessionJson, {
    token: 'stale-access-token',
    resolveTokenFn: async input => {
      resolvedInputs.push(JSON.parse(input));
      return { token: 'fresh-access-token', email: 'person@example.com' };
    },
    getAccountStatusFn: async token => {
      requestedTokens.push(token);
      if (token === 'stale-access-token') return { status: 401, json: {} };
      return {
        status: 200,
        json: {
          accounts: {
            personal: { entitlement: { has_active_subscription: false } }
          }
        }
      };
    }
  });

  assert.deepEqual(status, { state: 'free', plan: 'chatgptfreeplan', errorCode: '' });
  assert.deepEqual(requestedTokens, ['stale-access-token', 'fresh-access-token']);
  assert.deepEqual(resolvedInputs, [{ sessionToken: 'current-session-token' }]);
});

test('account detection can return the refreshed credential used after access-token rejection', async () => {
  const status = await detectAccountStatus({
    accessToken: 'stale-access-token',
    sessionToken: 'current-session-token',
    user: { email: 'stored@example.com' }
  }, {
    token: 'stale-access-token',
    includeCredential: true,
    resolveTokenFn: async () => ({
      token: 'fresh-access-token',
      email: 'resolved@example.com'
    }),
    getAccountStatusFn: async token => token === 'stale-access-token'
      ? { status: 401, json: {} }
      : {
          status: 200,
          json: {
            accounts: {
              personal: { entitlement: { has_active_subscription: false } }
            }
          }
        }
  });

  assert.deepEqual(status, {
    state: 'free',
    plan: 'chatgptfreeplan',
    errorCode: '',
    token: 'fresh-access-token',
    email: 'resolved@example.com'
  });
});

test('subscription gate permits free accounts and active accounts changing tiers', () => {
  assert.deepEqual(
    assertAccountCanSubscribe(
      { state: 'free', plan: 'chatgptfreeplan', errorCode: '' },
      'chatgptplusplan'
    ),
    { state: 'free', plan: 'chatgptfreeplan', errorCode: '' }
  );
  assert.deepEqual(
    assertAccountCanSubscribe(
      { state: 'active', plan: 'chatgptgoplan', errorCode: '' },
      'chatgptplus'
    ),
    { state: 'active', plan: 'chatgptgoplan', errorCode: '' }
  );
});

test('subscription gate blocks the target tier, unknown active tiers, and unsafe states', () => {
  const expected = new Map([
    ['invalid', 'invalid_account_credential'],
    ['pending', 'account_status_check_failed'],
    ['unknown', 'account_status_check_failed'],
    ['error', 'account_status_check_failed']
  ]);
  for (const [state, code] of expected) {
    assert.throws(
      () => assertAccountCanSubscribe({ state, plan: '', errorCode: '' }, 'chatgptplusplan'),
      error => error?.code === code && safePaymentErrorCode(error) === code
    );
  }
  assert.throws(
    () => assertAccountCanSubscribe(
      { state: 'active', plan: 'chatgptplusplan', errorCode: '' },
      'chatgptplus'
    ),
    error => error?.code === 'account_already_on_target_plan'
  );
  assert.throws(
    () => assertAccountCanSubscribe(
      { state: 'active', plan: 'provider-new-plan', errorCode: '' },
      'chatgptplusplan'
    ),
    error => error?.code === 'account_status_check_failed'
  );
});

test('subscription gate rejects an unsupported target before considering account state', () => {
  for (const status of [
    { state: 'free', plan: 'chatgptfreeplan', errorCode: '' },
    { state: 'active', plan: 'chatgptgoplan', errorCode: '' }
  ]) {
    assert.throws(
      () => assertAccountCanSubscribe(status, 'provider-new-plan'),
      error => (
        error?.code === 'unsupported_target_plan'
        && safePaymentErrorCode(error) === 'unsupported_target_plan'
      )
    );
  }
});

test('real payment and link flows stop unsafe account states before checkout creation', async () => {
  const expected = new Map([
    ['invalid', 'invalid_account_credential'],
    ['pending', 'account_status_check_failed'],
    ['unknown', 'account_status_check_failed'],
    ['error', 'account_status_check_failed']
  ]);

  for (const [state, code] of expected) {
    let createSessionCalls = 0;
    const flows = createPaymentFlows({
      resolveToken: async () => ({ token: 'token', email: 'person@example.com' }),
      detectAccountStatus: async () => ({ state, plan: '', errorCode: '' }),
      createSession: async () => {
        createSessionCalls++;
        return { json: {} };
      }
    });
    const common = {
      sessionJson: JSON.stringify({ accessToken: 'token' }),
      plan: 'chatgptplus'
    };
    const pay = flows.runPay({
      ...common,
      card: { number: '4242424242424242', exp: '12/99', cvc: '123', name: '' },
      address: { line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' }
    }, () => {});
    await assert.rejects(pay, error => error?.code === code);
    await assert.rejects(flows.runLink(common, () => {}), error => error?.code === code);
    assert.equal(createSessionCalls, 0, `${state} must stop before createSession`);
  }
});

test('real payment and link flows stop the target or an unknown active tier before checkout creation', async () => {
  for (const [plan, code] of [
    ['chatgptplusplan', 'account_already_on_target_plan'],
    ['provider-new-plan', 'account_status_check_failed']
  ]) {
    let createSessionCalls = 0;
    const flows = createPaymentFlows({
      resolveToken: async () => ({ token: 'token', email: 'person@example.com' }),
      detectAccountStatus: async () => ({ state: 'active', plan, errorCode: '' }),
      createSession: async () => {
        createSessionCalls++;
        return { json: {} };
      }
    });
    const common = {
      sessionJson: JSON.stringify({ accessToken: 'token' }),
      plan: 'chatgptplus'
    };
    await assert.rejects(
      flows.runPay({
        ...common,
        card: { number: '4242424242424242', exp: '12/99', cvc: '123', name: '' },
        address: { line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' }
      }, () => {}),
      error => error?.code === code
    );
    await assert.rejects(flows.runLink(common, () => {}), error => error?.code === code);
    assert.equal(createSessionCalls, 0);
  }
});

test('real payment and link flows reject an unsupported target before checkout creation', async () => {
  for (const status of [
    { state: 'free', plan: 'chatgptfreeplan', errorCode: '' },
    { state: 'active', plan: 'chatgptgoplan', errorCode: '' }
  ]) {
    let createSessionCalls = 0;
    const flows = createPaymentFlows({
      resolveToken: async () => ({ token: 'token', email: 'person@example.com' }),
      detectAccountStatus: async () => status,
      createSession: async () => {
        createSessionCalls += 1;
        return { json: {} };
      }
    });
    const common = {
      sessionJson: JSON.stringify({ accessToken: 'token' }),
      plan: 'provider-new-plan'
    };
    await assert.rejects(
      flows.runPay({
        ...common,
        card: { number: '4242424242424242', exp: '12/99', cvc: '123', name: '' },
        address: { line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' }
      }, () => {}),
      error => error?.code === 'unsupported_target_plan'
    );
    await assert.rejects(
      flows.runLink(common, () => {}),
      error => error?.code === 'unsupported_target_plan'
    );
    assert.equal(createSessionCalls, 0);
  }
});

test('real payment and link flows let an active account change tiers', async () => {
  let createSessionCalls = 0;
  const flows = createPaymentFlows({
    resolveToken: async () => ({ token: 'token', email: 'person@example.com' }),
    detectAccountStatus: async () => ({ state: 'active', plan: 'chatgptgoplan', errorCode: '' }),
    createSession: async () => {
      createSessionCalls++;
      return { json: {} };
    }
  });
  const common = {
    sessionJson: JSON.stringify({ accessToken: 'token' }),
    plan: 'chatgptplus'
  };

  await assert.rejects(
    flows.runPay({
      ...common,
      card: { number: '4242424242424242', exp: '12/99', cvc: '123', name: '' },
      address: { line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' }
    }, () => {}),
    /checkout|会话|session/i
  );
  await assert.rejects(flows.runLink(common, () => {}), /checkout|会话|session/i);
  assert.equal(createSessionCalls, 2);
});

test('real payment and link flows let a confirmed free account reach checkout creation', async () => {
  let createSessionCalls = 0;
  const flows = createPaymentFlows({
    resolveToken: async () => ({ token: 'token', email: 'person@example.com' }),
    detectAccountStatus: async () => ({ state: 'free', plan: 'chatgptfreeplan', errorCode: '' }),
    createSession: async () => {
      createSessionCalls++;
      return { json: {} };
    }
  });
  const common = {
    sessionJson: JSON.stringify({ accessToken: 'token' }),
    plan: 'chatgptplus'
  };

  await assert.rejects(
    flows.runPay({
      ...common,
      card: { number: '4242424242424242', exp: '12/99', cvc: '123', name: '' },
      address: { line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' }
    }, () => {}),
    /checkout|会话|session/i
  );
  await assert.rejects(flows.runLink(common, () => {}), /checkout|会话|session/i);
  assert.equal(createSessionCalls, 2);
});

test('session-token exchange exposes only explicit 401 as invalid credentials', async () => {
  const sessionToken = 'eyJ.header.payload.signature.extra';
  await assert.rejects(
    resolveToken(sessionToken, {
      cgFetchFn: async () => ({ status: 401, json: {} })
    }),
    error => error?.status === 401 && error?.code === 'invalid_account_credential'
  );

  for (const response of [
    { status: 429, json: {} },
    { status: 503, json: {} },
    { status: 200, json: {} }
  ]) {
    await assert.rejects(
      resolveToken(sessionToken, { cgFetchFn: async () => response }),
      error => error?.code === 'account_status_check_failed' && error?.code !== 'invalid_account_credential'
    );
  }
});

test('session-token exchange preserves a typed Cloudflare challenge failure', async () => {
  const challenge = Object.assign(new Error('challenge'), { code: 'cloudflare_challenge_failed' });
  await assert.rejects(
    resolveToken('eyJ.header.payload.signature.extra', {
      cgFetchFn: async () => { throw challenge; }
    }),
    error => error === challenge
  );
});
