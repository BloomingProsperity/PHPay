import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResourceStore } from '../src/resource-store.js';

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-resource-store-'));
  try { return run(createResourceStore(root), root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function assertCardCounts(usage, expected) {
  assert.deepEqual({
    paidAccountCount: usage.paidAccountCount,
    attemptCount: usage.attemptCount,
    successCount: usage.successCount,
    threeDsCount: usage.threeDsCount,
    hasThreeDs: usage.hasThreeDs
  }, expected);
}

test('store skips duplicates and does not overwrite the original record', () => withStore(store => {
  const card = { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Jane Doe' };
  assert.equal(store.add('cards', card, { file: 'one.txt', line: 1 }).status, 'added');
  assert.equal(store.add('cards', { ...card, name: 'Changed' }, { file: 'two.txt', line: 1 }).status, 'duplicate');
  assert.equal(store.list('cards').length, 1);
  assert.equal(store.get('cards', store.list('cards')[0].id).name, 'Jane Doe');
}));

test('accounts with the same email merge refreshed tokens into one resource', () => withStore(store => {
  assert.equal(store.add('accounts', { accessToken: 'token-one', user: { email: 'same@example.com' } }).status, 'added');
  const refreshed = store.add('accounts', {
    accessToken: 'token-two',
    sessionToken: 'session-two',
    user: { email: 'SAME@example.com' }
  });
  assert.equal(refreshed.status, 'duplicate');
  assert.equal(refreshed.updated, true);
  assert.equal(store.list('accounts').length, 1);
  const stored = store.get('accounts', store.list('accounts')[0].id);
  assert.equal(stored.accessToken, 'token-two');
  assert.equal(stored.sessionToken, 'session-two');
}));

test('account list uses a safe pending label when the imported credential has no email', () => withStore(store => {
  store.add('accounts', { accessToken: 'token-without-email', user: { email: '' } });
  assert.equal(store.list('accounts')[0].label, '待识别账号');
}));

test('card list views are redacted', () => withStore(store => {
  store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'Jane Doe' }, { file: 'one.txt', line: 1 });
  const [view] = store.list('cards');
  assert.deepEqual(Object.keys(view).sort(), ['id', 'importedAt', 'masked', 'name', 'usage']);
  assert.deepEqual(view.usage, {
    state: 'available',
    paidAccountCount: 0,
    attemptCount: 0,
    successCount: 0,
    threeDsCount: 0,
    hasThreeDs: false
  });
  assert.equal(view.masked, '•••• 4242');
}));

test('store lists a legacy address file with a stable ID and redacted label', () => withStore((store, root) => {
  const dir = path.join(root, 'addresses');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'addr-1.json'), JSON.stringify({
    line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US'
  }));
  const [view] = store.list('addresses');
  assert.match(view.id, /^addresses_/);
  assert.equal(view.label, 'Seattle, WA, US');
}));

test('accounts can be marked complete with an actual paid amount, deleted, and cleared', () => withStore(store => {
  const first = store.add('accounts', { accessToken: 'token-first', user: { email: 'first@example.com' } });
  const second = store.add('accounts', { accessToken: 'token-second', user: { email: 'second@example.com' } });
  store.completeAccount(first.id, { taskId: 'task-1', amount: 99900, currency: 'PHP' });
  const completed = store.list('accounts').find(item => item.id === first.id);
  assert.deepEqual(completed.payment, { state: 'completed', amount: 99900, currency: 'PHP' });
  assert.equal(store.remove('accounts', first.id), true);
  assert.equal(store.list('accounts').length, 1);
  assert.equal(store.clear('accounts'), 1);
  assert.equal(store.list('accounts').length, 0);
  assert.ok(second.id);
}));

test('reimporting a deleted completed account restores its completion marker', () => withStore(store => {
  const first = store.add('accounts', {
    accessToken: 'token-before-payment',
    user: { email: 'completed@example.com' }
  });
  store.completeAccount(first.id, {
    taskId: 'task-completed',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan'
  });
  assert.equal(store.remove('accounts', first.id), true);

  const reimported = store.add('accounts', {
    accessToken: 'token-after-payment',
    user: { email: 'COMPLETED@example.com' }
  });
  const [view] = store.list('accounts');

  assert.equal(reimported.status, 'added');
  assert.equal(view.payment.state, 'completed');
  assert.equal(view.payment.plan, 'chatgptplusplan');
  assert.equal(store.reserve('accounts', view.id, 'second-payment-task'), false);
}));

test('account status is persisted and confirmed payment promotes it to the paid plan', () => withStore(store => {
  const account = store.add('accounts', { accessToken: 'token-status', user: { email: 'status@example.com' } });
  store.updateAccountStatus(account.id, { state: 'free', plan: 'chatgptfreeplan' });
  assert.equal(store.list('accounts')[0].accountStatus.state, 'free');

  store.completeAccount(account.id, {
    taskId: 'task-paid',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan'
  });
  const completed = store.list('accounts')[0];
  assert.deepEqual(completed.accountStatus.state, 'active');
  assert.equal(completed.accountStatus.plan, 'chatgptplusplan');
  assert.equal(completed.payment.plan, 'chatgptplusplan');
}));

test('account completion safely exposes canonical 3DS provenance without exposing private task metadata', () => withStore(store => {
  const account = store.add('accounts', { accessToken: 'token-3ds', user: { email: '3ds@example.com' } });
  store.completeAccount(account.id, {
    taskId: 'private-task-id',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan',
    via3ds: true,
    accountPlanBefore: ' ChatGPTFreePlan '
  });

  const completed = store.list('accounts')[0];
  assert.deepEqual(completed.payment, {
    state: 'completed',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan',
    via3ds: true,
    accountPlanBefore: 'chatgptfreeplan'
  });
  assert.doesNotMatch(JSON.stringify(completed), /private-task-id|completedAt/);
  assert.equal(store.get('accounts', account.id)._resource.payment.taskId, 'private-task-id');
}));

test('replayed account completion monotonically preserves valid 3DS provenance', () => withStore(store => {
  const account = store.add('accounts', { accessToken: 'token-replayed-3ds', user: { email: 'replayed-3ds@example.com' } });
  const base = {
    taskId: 'replayed-task',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan'
  };
  store.completeAccount(account.id, {
    ...base,
    via3ds: true,
    accountPlanBefore: 'chatgptfreeplan'
  });
  store.completeAccount(account.id, base);
  store.completeAccount(account.id, {
    ...base,
    via3ds: 'not-a-boolean',
    accountPlanBefore: 'enterprise'
  });
  store.completeAccount(account.id, {
    ...base,
    via3ds: false,
    accountPlanBefore: 'chatgptpro'
  });

  assert.deepEqual(store.list('accounts')[0].payment, {
    state: 'completed',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan',
    via3ds: true,
    accountPlanBefore: 'chatgptfreeplan'
  });
  const payment = store.get('accounts', account.id)._resource.payment;
  assert.equal(payment.via3ds, true);
  assert.equal(payment.accountPlanBefore, 'chatgptfreeplan');
}));

test('legacy malformed completion metadata is omitted from public account views', () => withStore((store, root) => {
  const account = store.add('accounts', { accessToken: 'token-legacy-3ds', user: { email: 'legacy-3ds@example.com' } });
  store.completeAccount(account.id, {
    taskId: 'legacy-task',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan'
  });
  const file = path.join(root, 'accounts', fs.readdirSync(path.join(root, 'accounts'))[0]);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data._resource.payment.via3ds = 'true';
  data._resource.payment.accountPlanBefore = 'enterprise';
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  assert.deepEqual(store.list('accounts')[0].payment, {
    state: 'completed',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan'
  });
}));

test('delayed account checks cannot downgrade an account after payment completes', () => withStore(store => {
  const account = store.add('accounts', { accessToken: 'token-paid', user: { email: 'paid@example.com' } });
  store.completeAccount(account.id, {
    taskId: 'task-paid',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan'
  });

  for (const state of ['pending', 'free', 'error', 'invalid']) {
    store.updateAccountStatus(account.id, {
      state,
      plan: state === 'free' ? 'chatgptfreeplan' : '',
      errorCode: state === 'invalid' ? 'invalid_account_credential' : 'account_status_check_failed'
    });
  }
  store.updateAccountStatus(account.id, {
    state: 'active',
    plan: 'chatgptproplan',
    errorCode: ''
  });

  const completed = store.list('accounts')[0];
  assert.deepEqual(completed.accountStatus.state, 'active');
  assert.equal(completed.accountStatus.plan, 'chatgptplusplan');
  assert.deepEqual(completed.payment, {
    state: 'completed',
    amount: 110000,
    currency: 'PHP',
    plan: 'chatgptplusplan'
  });
}));

test('account list exposes task occupancy for automatic selection', () => withStore(store => {
  const account = store.add('accounts', { accessToken: 'token-first', user: { email: 'first@example.com' } });
  assert.equal(store.reserve('accounts', account.id, 'task-1'), true);
  assert.equal(store.list('accounts').find(item => item.id === account.id).usage.state, 'in_use');
}));

test('insufficient-funds cards stay paused until explicitly restored', () => withStore(store => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  assert.equal(store.reserve('cards', card.id, 'task-1'), true);
  assert.equal(store.markCardInsufficient(card.id, 'task-1'), true);
  const paused = store.list('cards').find(item => item.id === card.id);
  assert.equal(paused.usage.state, 'insufficient_funds');
  assert.equal(store.reserve('cards', card.id, 'task-2'), false);
  assert.equal(store.restoreCard(card.id), true);
  assert.equal(store.reserve('cards', card.id, 'task-2'), true);
}));

test('selected cards and addresses count only successfully paid accounts after release', () => withStore(store => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  const address = store.add('addresses', { line1: '1 Main', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' });
  assert.equal(store.reserve('cards', card.id, 'task-1'), true);
  assert.equal(store.reserve('cards', card.id, 'task-2'), false);
  assert.equal(store.reserve('addresses', address.id, 'task-1'), true);
  assert.equal(store.release('cards', card.id, 'task-1', { paid: true }), true);
  assert.equal(store.release('addresses', address.id, 'task-1', { paid: true }), true);
  const cardView = store.list('cards').find(item => item.id === card.id);
  const addressView = store.list('addresses').find(item => item.id === address.id);
  assert.equal(cardView.usage.state, 'available');
  assert.equal(addressView.usage.state, 'available');
  assert.equal(cardView.usage.paidAccountCount, 1);
  assert.equal(addressView.usage.paidAccountCount, 1);
  assert.ok(store.get('cards', card.id)._resource.usage.paidTasks['task-1']);
  assert.ok(store.get('addresses', address.id)._resource.usage.paidTasks['task-1']);
}));

test('a cooling card exposes its successful paid-account count before it is released', () => withStore(store => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  assert.equal(store.reserve('cards', card.id, 'task-1'), true);
  assert.equal(store.recordPaidUsage('cards', card.id, 'task-1'), true);
  const cooling = store.list('cards').find(item => item.id === card.id);
  assert.deepEqual(cooling.usage, {
    state: 'in_use',
    paidAccountCount: 1,
    attemptCount: 1,
    successCount: 1,
    threeDsCount: 0,
    hasThreeDs: false
  });
  assert.equal(store.release('cards', card.id, 'task-1'), true);
  assert.equal(store.list('cards').find(item => item.id === card.id).usage.paidAccountCount, 1);
}));

test('a released card stays unavailable during its 30 second cooldown', () => withStore((store, root) => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  assert.equal(store.reserve('cards', card.id, 'task-1'), true);
  assert.equal(store.recordPaidUsage('cards', card.id, 'task-1'), true);
  const releasedAt = Date.now();
  assert.equal(store.release('cards', card.id, 'task-1', { cooldownMs: 30_000 }), true);
  const cooling = store.list('cards').find(item => item.id === card.id);
  assert.equal(cooling.usage.state, 'cooldown');
  assert.ok(Date.parse(cooling.usage.cooldownUntil) - releasedAt >= 29_900);
  assert.equal(store.reserve('cards', card.id, 'task-2'), false);

  const file = path.join(root, 'cards', fs.readdirSync(path.join(root, 'cards'))[0]);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data._resource.usage.cooldownUntil = new Date(Date.now() - 1).toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  assert.equal(store.reserve('cards', card.id, 'task-2'), true);
}));

test('card events are idempotent per task and their private ledger never leaks through list views', () => withStore(store => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  assert.equal(store.reserve('cards', card.id, 'task-ledger'), true);
  for (const event of ['submitted', 'three_ds', 'succeeded']) {
    assert.equal(store.recordCardEvent(card.id, 'task-ledger', event), true);
  }
  const first = structuredClone(store.get('cards', card.id)._resource.usage);
  for (const event of ['submitted', 'three_ds', 'succeeded']) {
    assert.equal(store.recordCardEvent(card.id, 'task-ledger', event), true);
  }
  const second = store.get('cards', card.id)._resource.usage;

  assert.deepEqual(second, first);
  assert.equal(first.lastUsedAt, first.cardTasks['task-ledger'].submittedAt);
  assert.ok(Date.parse(first.cardTasks['task-ledger'].threeDsAt));
  assert.ok(Date.parse(first.cardTasks['task-ledger'].succeededAt));
  const view = store.list('cards')[0];
  assert.deepEqual(view.usage, {
    state: 'in_use',
    paidAccountCount: 0,
    attemptCount: 1,
    successCount: 1,
    threeDsCount: 1,
    hasThreeDs: true
  });
  assert.doesNotMatch(JSON.stringify(view), /task-ledger|cardTasks|submittedAt|threeDsAt|succeededAt/);
}));

test('legacy paid-usage recording preserves an existing private card event ledger', () => withStore(store => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  assert.equal(store.reserve('cards', card.id, 'task-paid-ledger'), true);
  for (const event of ['submitted', 'three_ds', 'succeeded']) {
    assert.equal(store.recordCardEvent(card.id, 'task-paid-ledger', event), true);
  }
  const cardTasks = structuredClone(store.get('cards', card.id)._resource.usage.cardTasks);
  assert.equal(store.recordPaidUsage('cards', card.id, 'task-paid-ledger'), true);
  const firstUsage = structuredClone(store.get('cards', card.id)._resource.usage);
  assert.equal(store.recordPaidUsage('cards', card.id, 'task-paid-ledger'), true);

  assert.deepEqual(store.get('cards', card.id)._resource.usage.cardTasks, cardTasks);
  assert.deepEqual(store.get('cards', card.id)._resource.usage, firstUsage);
  assert.ok(firstUsage.paidTasks['task-paid-ledger']);
  assert.deepEqual(store.list('cards')[0].usage, {
    state: 'in_use',
    paidAccountCount: 1,
    attemptCount: 1,
    successCount: 1,
    threeDsCount: 1,
    hasThreeDs: true
  });
}));

test('card event validation rejects invalid values and unrelated writers while a card is locked', () => withStore(store => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  const account = store.add('accounts', { accessToken: 'token-not-a-card', user: { email: 'not-card@example.com' } });
  assert.equal(store.recordCardEvent(card.id, 'unowned-task', 'submitted'), false);
  assert.equal(store.reserve('cards', card.id, 'owner-task'), true);
  assert.equal(store.recordCardEvent(card.id, 'other-task', 'submitted'), false);
  assert.equal(store.recordCardEvent(card.id, '', 'submitted'), false);
  assert.equal(store.recordCardEvent(card.id, 'owner-task', 'declined'), false);
  assert.equal(store.recordCardEvent(account.id, 'owner-task', 'submitted'), false);
  assert.equal(store.recordCardEvent('cards_missing', 'owner-task', 'submitted'), false);
  assert.equal(store.recordCardEvent(card.id, 'owner-task', 'submitted'), true);
  assert.equal(store.list('cards')[0].usage.attemptCount, 1);
}));

test('distinct card tasks accumulate independently after each task acquires the card', () => withStore(store => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  for (const taskId of ['task-one', 'task-two']) {
    assert.equal(store.reserve('cards', card.id, taskId), true);
    assert.equal(store.recordCardEvent(card.id, taskId, 'submitted'), true);
    assert.equal(store.recordCardEvent(card.id, taskId, 'three_ds'), true);
    assert.equal(store.recordCardEvent(card.id, taskId, 'succeeded'), true);
    if (taskId === 'task-one') {
      assert.equal(store.release('cards', card.id, taskId, { recordUsage: false }), true);
    }
  }
  assert.deepEqual(store.list('cards')[0].usage, {
    state: 'in_use',
    paidAccountCount: 0,
    attemptCount: 2,
    successCount: 2,
    threeDsCount: 2,
    hasThreeDs: true
  });
}));

test('card counts survive in-use, cooldown, and insufficient-funds state transitions', () => withStore((store, root) => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  assert.equal(store.reserve('cards', card.id, 'task-state'), true);
  assert.equal(store.recordCardEvent(card.id, 'task-state', 'submitted'), true);
  assert.equal(store.recordCardEvent(card.id, 'task-state', 'three_ds'), true);
  assert.equal(store.recordCardEvent(card.id, 'task-state', 'succeeded'), true);
  const counts = { paidAccountCount: 0, attemptCount: 1, successCount: 1, threeDsCount: 1, hasThreeDs: true };

  const inUse = store.list('cards')[0].usage;
  assert.equal(inUse.state, 'in_use');
  assertCardCounts(inUse, counts);
  assert.equal(store.release('cards', card.id, 'task-state', { cooldownMs: 30_000 }), true);
  const cooling = store.list('cards')[0].usage;
  assert.equal(cooling.state, 'cooldown');
  assertCardCounts(cooling, counts);

  const file = path.join(root, 'cards', fs.readdirSync(path.join(root, 'cards'))[0]);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data._resource.usage.cooldownUntil = new Date(Date.now() - 1).toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  assert.equal(store.reserve('cards', card.id, 'task-insufficient'), true);
  assert.equal(store.markCardInsufficient(card.id, 'task-insufficient'), true);
  const blocked = store.list('cards')[0].usage;
  assert.equal(blocked.state, 'insufficient_funds');
  assertCardCounts(blocked, counts);
}));

test('legacy paidAccountCount remains the minimum for derived attempt and success counts', () => withStore((store, root) => {
  store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  const file = path.join(root, 'cards', fs.readdirSync(path.join(root, 'cards'))[0]);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data._resource.usage = {
    paidAccountCount: 4,
    lastUsedAt: new Date().toISOString(),
    cardTasks: {
      'new-task': {
        submittedAt: new Date().toISOString(),
        threeDsAt: new Date().toISOString(),
        succeededAt: new Date().toISOString()
      }
    }
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  assert.deepEqual(store.list('cards')[0].usage, {
    state: 'available',
    lastUsedAt: data._resource.usage.lastUsedAt,
    paidAccountCount: 4,
    attemptCount: 4,
    successCount: 4,
    threeDsCount: 1,
    hasThreeDs: true
  });
}));

test('malformed legacy paidAccountCount values are exposed as zero', () => withStore((store, root) => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  const address = store.add('addresses', { line1: '1 Main', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' });
  const cardFile = path.join(root, 'cards', fs.readdirSync(path.join(root, 'cards'))[0]);
  const addressFile = path.join(root, 'addresses', fs.readdirSync(path.join(root, 'addresses'))[0]);

  for (const value of ['NaN', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const cardData = JSON.parse(fs.readFileSync(cardFile, 'utf8'));
    cardData._resource.usage = { lastUsedAt: new Date().toISOString(), paidAccountCount: value };
    fs.writeFileSync(cardFile, JSON.stringify(cardData, null, 2));
    const usage = store.list('cards').find(item => item.id === card.id).usage;
    assertCardCounts(usage, {
      paidAccountCount: 0,
      attemptCount: 0,
      successCount: 0,
      threeDsCount: 0,
      hasThreeDs: false
    });

    const addressData = JSON.parse(fs.readFileSync(addressFile, 'utf8'));
    addressData._resource.usage = { lastUsedAt: new Date().toISOString(), paidAccountCount: value };
    fs.writeFileSync(addressFile, JSON.stringify(addressData, null, 2));
    assert.equal(store.list('addresses').find(item => item.id === address.id).usage.paidAccountCount, 0);
  }
}));

test('paid usage writes recover safely from malformed legacy counts', () => withStore((store, root) => {
  const card = store.add('cards', { number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  const file = path.join(root, 'cards', fs.readdirSync(path.join(root, 'cards'))[0]);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data._resource.usage = { paidAccountCount: -1 };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  assert.equal(store.reserve('cards', card.id, 'record-task'), true);
  assert.equal(store.recordPaidUsage('cards', card.id, 'record-task'), true);
  assert.equal(store.get('cards', card.id)._resource.usage.paidAccountCount, 1);
  assert.equal(store.release('cards', card.id, 'record-task', { recordUsage: false }), true);

  const replay = store.get('cards', card.id);
  replay._resource.usage.paidAccountCount = Number.MAX_SAFE_INTEGER + 1;
  fs.writeFileSync(file, JSON.stringify(replay, null, 2));
  assert.equal(store.reserve('cards', card.id, 'release-task'), true);
  assert.equal(store.release('cards', card.id, 'release-task', { paid: true }), true);
  const recovered = store.get('cards', card.id)._resource.usage;
  assert.equal(recovered.paidAccountCount, 1);
  assert.ok(recovered.paidTasks['release-task']);
}));

test('startup recovery releases only orphaned resource locks', () => withStore(store => {
  const account = store.add('accounts', {
    accessToken: 'eyJhbGci.recovery.account',
    user: { email: 'recovery@example.com' }
  });
  const card = store.add('cards', {
    number: '4242424242424242', exp: '12/30', cvc: '123', name: ''
  });
  const address = store.add('addresses', {
    line1: '1 Main', city: 'Seattle', state: 'WA', zip: '98101', country: 'US'
  });
  store.reserve('accounts', account.id, 'terminal-task');
  store.reserve('cards', card.id, 'active-task');
  store.reserve('addresses', address.id, 'missing-task');

  assert.equal(store.releaseOrphanedLocks(new Set(['active-task'])), 2);
  assert.equal(store.list('accounts')[0].usage, undefined);
  assert.equal(store.list('cards')[0].usage.state, 'in_use');
  assert.equal(store.list('addresses')[0].usage, undefined);
}));
