import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaymentTaskStore } from '../src/payment-task-store.js';

test('idempotency key reuses the task without persisting payment secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const first = store.create({
      idempotencyKey: 'key-1', email: 'a@example.com', cardLast4: '4242',
      amount: 99900, currency: 'PHP', plan: 'chatgptplusplan', checkoutSessionId: 'cs_secret', accountResourceId: 'accounts_aaaaaaaaaaaaaaaaaaaaaaaa', cardResourceId: 'cards_bbbbbbbbbbbbbbbbbbbbbbbb', addressResourceId: 'addresses_cccccccccccccccccccccccc'
    });
    const second = store.create({
      idempotencyKey: 'key-1', email: 'a@example.com', cardLast4: '4242',
      amount: 99900, currency: 'PHP'
    });
    assert.equal(first.id, second.id);
    assert.equal(second.reused, true);
    assert.doesNotMatch(JSON.stringify(store.list()), /cs_secret|key-1/);
    assert.equal(store.getInternal(first.id).accountResourceId, 'accounts_aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(store.getInternal(first.id).cardResourceId, 'cards_bbbbbbbbbbbbbbbbbbbbbbbb');
    assert.equal(store.getInternal(first.id).addressResourceId, 'addresses_cccccccccccccccccccccccc');
    assert.equal(first.plan, 'chatgptplusplan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public task views expose the 3DS URL but not hidden task fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({ idempotencyKey: 'private-key', email: 'a@example.com', cardLast4: '4242' });
    const view = store.update(task.id, { state: 'pending_3ds', verificationUrl: 'https://verify.example/3ds', checkoutSessionId: 'cs_hidden' });
    assert.deepEqual(Object.keys(view).sort(), [
      'accountCheckErrorCode', 'accountPlanBefore', 'accountPlanCurrent', 'amount',
      'cardLast4', 'completionSource', 'createdAt', 'currency', 'email', 'errorCode',
      'fingerprintId', 'fingerprintLabel', 'fingerprintReused', 'firstAccountCheckAt',
      'id', 'lastAccountCheckAt', 'nextAccountCheckAt', 'plan', 'retryAction', 'stage', 'state',
      'threeDsCompletedAt', 'threeDsDetectedAt', 'updatedAt', 'verificationUrl'
    ]);
    assert.equal(view.verificationUrl, 'https://verify.example/3ds');
    assert.equal(view.retryAction, 'reconcile');
    assert.doesNotMatch(JSON.stringify(view), /private-key|cs_hidden/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public retry action is derived from state and ignores client input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({
      idempotencyKey: 'derived-retry-action',
      retryAction: 'next_proxy'
    });
    assert.equal(task.retryAction, 'stop');
    const view = store.update(task.id, {
      state: 'failed',
      stage: 'preconfirm',
      errorCode: 'incorrect_zip',
      retryAction: 'next_card'
    });
    assert.equal(view.retryAction, 'next_address');
    assert.equal(Object.hasOwn(store.getInternal(task.id), 'retryAction'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fingerprint task snapshots expose only safe labels and keep profile details private', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({ idempotencyKey: 'fingerprint-task' });
    const view = store.update(task.id, {
      fingerprintId: 'fp-one',
      fingerprintLabel: 'Chrome One',
      fingerprintReused: true,
      fingerprintProfile: {
        id: 'fp-one',
        impersonation: 'chrome-one',
        userAgent: 'private-user-agent',
        headers: { 'x-private': 'secret' }
      }
    });

    assert.equal(view.fingerprintId, 'fp-one');
    assert.equal(view.fingerprintLabel, 'Chrome One');
    assert.equal(view.fingerprintReused, true);
    assert.doesNotMatch(JSON.stringify(view), /private-user-agent|x-private|secret|chrome-one/);
    assert.equal(store.getInternal(task.id).fingerprintProfile.headers['x-private'], 'secret');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3DS account observation fields persist through create and update without changing the target plan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({
      idempotencyKey: 'account-observation-fields',
      plan: 'chatgptplusplan',
      accountPlanBefore: 'CHATGPTFREEPLAN',
      accountPlanCurrent: 'chatgptfreeplan',
      threeDsDetectedAt: '2026-07-30T08:00:00+08:00',
      firstAccountCheckAt: '2026-07-30T00:01:00.000Z',
      nextAccountCheckAt: '2026-07-30T00:02:00.000Z',
      accountCheckErrorCode: 'check_pending'
    });

    const view = store.update(task.id, {
      accountPlanCurrent: 'chatgptplus',
      lastAccountCheckAt: '2026-07-30T00:03:00.000Z',
      nextAccountCheckAt: '2026-07-30T00:04:00.000Z',
      accountCheckErrorCode: '',
      completionSource: 'account_tier_after_3ds',
      threeDsCompletedAt: '2026-07-30T00:05:00.000Z'
    });

    assert.equal(view.plan, 'chatgptplusplan');
    assert.deepEqual(
      Object.fromEntries([
        'accountPlanBefore', 'accountPlanCurrent', 'threeDsDetectedAt',
        'firstAccountCheckAt', 'lastAccountCheckAt', 'nextAccountCheckAt',
        'accountCheckErrorCode', 'completionSource', 'threeDsCompletedAt'
      ].map(field => [field, view[field]])),
      {
        accountPlanBefore: 'chatgptfreeplan',
        accountPlanCurrent: 'chatgptplusplan',
        threeDsDetectedAt: '2026-07-30T08:00:00+08:00',
        firstAccountCheckAt: '2026-07-30T00:01:00.000Z',
        lastAccountCheckAt: '2026-07-30T00:03:00.000Z',
        nextAccountCheckAt: '2026-07-30T00:04:00.000Z',
        accountCheckErrorCode: '',
        completionSource: 'account_tier_after_3ds',
        threeDsCompletedAt: '2026-07-30T00:05:00.000Z'
      }
    );
    assert.equal(store.getInternal(task.id).completionSource, 'account_tier_after_3ds');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3DS account observation fields sanitize invalid create and update values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({
      idempotencyKey: 'invalid-account-observation-fields',
      accountPlanBefore: 'enterprise',
      accountPlanCurrent: 'unknown',
      threeDsDetectedAt: 'yesterday',
      firstAccountCheckAt: '2026-07-30',
      lastAccountCheckAt: 'not-a-date',
      nextAccountCheckAt: 123,
      accountCheckErrorCode: 'not safe!',
      completionSource: 'manual',
      threeDsCompletedAt: '30 July 2026'
    });

    for (const field of [
      'accountPlanBefore', 'accountPlanCurrent', 'threeDsDetectedAt',
      'firstAccountCheckAt', 'lastAccountCheckAt', 'nextAccountCheckAt',
      'accountCheckErrorCode', 'completionSource', 'threeDsCompletedAt'
    ]) {
      assert.equal(task[field], '');
    }

    const view = store.update(task.id, {
      accountPlanBefore: 'still_unknown',
      accountPlanCurrent: null,
      threeDsDetectedAt: 'invalid',
      firstAccountCheckAt: {},
      lastAccountCheckAt: 'nope',
      nextAccountCheckAt: 'tomorrow',
      accountCheckErrorCode: 'spaces are unsafe',
      completionSource: 'checkout_success',
      threeDsCompletedAt: false
    });
    for (const field of [
      'accountPlanBefore', 'accountPlanCurrent', 'threeDsDetectedAt',
      'firstAccountCheckAt', 'lastAccountCheckAt', 'nextAccountCheckAt',
      'accountCheckErrorCode', 'completionSource', 'threeDsCompletedAt'
    ]) {
      assert.equal(view[field], '');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3DS account observation timestamps reject invalid calendar, clock, and offset boundaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({ idempotencyKey: 'invalid-timestamp-boundaries' });
    for (const timestamp of [
      '2025-02-29T00:00:00.000Z',
      '2026-04-31T00:00:00.000Z',
      '2026-01-01T24:00:00.000Z',
      '2026-01-01T00:00:00.000+14:01'
    ]) {
      const view = store.update(task.id, { threeDsDetectedAt: timestamp });
      assert.equal(view.threeDsDetectedAt, '', timestamp);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3DS account observation timestamps preserve valid leap day and offset boundaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({
      idempotencyKey: 'valid-timestamp-boundaries',
      threeDsDetectedAt: '2024-02-29T23:59:59.999Z',
      firstAccountCheckAt: '2026-07-30T08:00:00+08:00',
      lastAccountCheckAt: '2026-07-30T14:00:00+14:00'
    });
    assert.equal(task.threeDsDetectedAt, '2024-02-29T23:59:59.999Z');
    assert.equal(task.firstAccountCheckAt, '2026-07-30T08:00:00+08:00');
    assert.equal(task.lastAccountCheckAt, '2026-07-30T14:00:00+14:00');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public task views redact every internal payment task identifier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({
      idempotencyKey: 'secret-idempotency-key',
      accountResourceId: 'accounts_aaaaaaaaaaaaaaaaaaaaaaaa',
      cardResourceId: 'cards_bbbbbbbbbbbbbbbbbbbbbbbb',
      addressResourceId: 'addresses_cccccccccccccccccccccccc',
      networkSlot: 9,
      checkoutSessionId: 'cs_secret'
    });
    store.update(task.id, { processorEntity: 'processor_secret' });

    const hiddenFields = [
      'accountResourceId', 'cardResourceId', 'addressResourceId', 'networkSlot',
      'idempotencyKey', 'checkoutSessionId', 'processorEntity'
    ];
    for (const view of [store.get(task.id), store.list()[0]]) {
      for (const field of hiddenFields) assert.equal(Object.hasOwn(view, field), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy payment task JSON exposes empty 3DS account observation fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const directory = path.join(root, 'payment-tasks');
    const id = '11111111-1111-4111-8111-111111111111';
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({
      id,
      idempotencyKey: 'legacy-key',
      state: 'processing',
      stage: 'preconfirm',
      plan: 'chatgptplusplan',
      amount: null,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z'
    }));

    const view = createPaymentTaskStore(root).get(id);
    for (const field of [
      'accountPlanBefore', 'accountPlanCurrent', 'threeDsDetectedAt',
      'firstAccountCheckAt', 'lastAccountCheckAt', 'nextAccountCheckAt',
      'accountCheckErrorCode', 'completionSource', 'threeDsCompletedAt'
    ]) {
      assert.equal(view[field], '');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('network slot persists privately and never appears in public task JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({
      idempotencyKey: 'private-network-slot',
      email: 'slot@example.com',
      networkSlot: 7
    });

    assert.equal(store.getInternal(task.id).networkSlot, 7);
    assert.equal(Object.hasOwn(task, 'networkSlot'), false);
    assert.equal(Object.hasOwn(store.get(task.id), 'networkSlot'), false);
    assert.equal(Object.hasOwn(store.list()[0], 'networkSlot'), false);
    assert.doesNotMatch(JSON.stringify(store.list()), /networkSlot/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('payment confirmation stage persists and appears in public task JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({
      idempotencyKey: 'private-confirmation-stage',
      stage: 'preconfirm'
    });
    store.update(task.id, { stage: 'confirm_started' });

    assert.equal(store.getInternal(task.id).stage, 'confirm_started');
    assert.equal(task.stage, 'preconfirm');
    assert.equal(store.get(task.id).stage, 'confirm_started');
    assert.equal(store.list()[0].stage, 'confirm_started');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3DS completion claim is single-use, safely patched, persisted, and precisely listed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const claimedTask = store.create({
      idempotencyKey: 'claimable-3ds-completion',
      state: 'pending_3ds',
      plan: 'chatgptplusplan',
      accountPlanBefore: 'chatgptfreeplan',
      accountResourceId: 'accounts_aaaaaaaaaaaaaaaaaaaaaaaa',
      cardResourceId: 'cards_bbbbbbbbbbbbbbbbbbbbbbbb',
      addressResourceId: 'addresses_cccccccccccccccccccccccc',
      checkoutSessionId: 'original-secret'
    });
    const otherPending = store.create({
      idempotencyKey: 'other-pending-3ds',
      state: 'pending_3ds'
    });

    const claimed = store.claimThreeDsCompletion(claimedTask.id, {
      state: 'failed',
      plan: 'chatgptpro',
      accountResourceId: 'accounts_dddddddddddddddddddddddd',
      checkoutSessionId: 'replacement-secret',
      accountPlanCurrent: 'CHATGPTPLUS',
      lastAccountCheckAt: '2026-07-30T00:02:00.000Z',
      nextAccountCheckAt: '',
      accountCheckErrorCode: '',
      completionSource: 'account_tier_after_3ds',
      threeDsCompletedAt: '2026-07-30T00:02:00.000Z'
    });

    assert.equal(claimed.state, 'completing_3ds');
    assert.equal(claimed.plan, 'chatgptplusplan');
    assert.equal(claimed.accountResourceId, 'accounts_aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(claimed.checkoutSessionId, 'original-secret');
    assert.equal(claimed.accountPlanCurrent, 'chatgptplusplan');
    assert.equal(claimed.completionSource, 'account_tier_after_3ds');
    assert.equal(store.claimThreeDsCompletion(claimedTask.id, {
      accountPlanCurrent: 'chatgptpro'
    }), null);

    const reopened = createPaymentTaskStore(root);
    assert.equal(reopened.getInternal(claimedTask.id).state, 'completing_3ds');
    assert.equal(reopened.get(claimedTask.id).state, 'completing_3ds');
    assert.deepEqual(
      reopened.list({ state: 'completing_3ds' }).map(task => task.id),
      [claimedTask.id]
    );
    assert.equal(reopened.get(otherPending.id).state, 'pending_3ds');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3DS completion claim rejects failed and succeeded tasks without overwriting them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const failed = store.create({
      idempotencyKey: 'failed-claim-rejected',
      state: 'failed',
      accountPlanCurrent: 'chatgptfreeplan'
    });
    const succeeded = store.create({
      idempotencyKey: 'succeeded-claim-rejected',
      state: 'succeeded',
      accountPlanCurrent: 'chatgptplusplan'
    });

    assert.equal(store.claimThreeDsCompletion(failed.id, {
      accountPlanCurrent: 'chatgptplusplan'
    }), null);
    assert.equal(store.claimThreeDsCompletion(succeeded.id, {
      accountPlanCurrent: 'chatgptpro'
    }), null);
    assert.equal(store.getInternal(failed.id).accountPlanCurrent, 'chatgptfreeplan');
    assert.equal(store.getInternal(succeeded.id).accountPlanCurrent, 'chatgptplusplan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only unresolved pending or unknown tasks can be explicitly failed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const pending = store.create({ idempotencyKey: 'cancel-pending', state: 'pending_3ds' });
    const unknown = store.create({ idempotencyKey: 'cancel-unknown', state: 'unknown' });
    const completing = store.create({ idempotencyKey: 'cancel-completing', state: 'pending_3ds' });
    store.claimThreeDsCompletion(completing.id, {});

    assert.equal(store.failUnresolved(pending.id, 'user_cancelled').state, 'failed');
    assert.equal(store.failUnresolved(unknown.id, 'user_cancelled').state, 'failed');
    assert.equal(store.failUnresolved(completing.id, 'user_cancelled'), null);
    assert.equal(store.get(completing.id).state, 'completing_3ds');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale failure updates cannot overwrite a claimed completion before success', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const task = store.create({
      idempotencyKey: 'claimed-completion-interleaving',
      state: 'pending_3ds',
      plan: 'chatgptplusplan'
    });
    store.claimThreeDsCompletion(task.id, {
      accountPlanCurrent: 'chatgptplusplan',
      completionSource: 'account_tier_after_3ds',
      threeDsCompletedAt: '2026-07-30T00:02:00.000Z'
    });

    const afterFailed = store.update(task.id, {
      state: 'failed',
      accountCheckErrorCode: 'stale_failure'
    });
    assert.equal(afterFailed.state, 'completing_3ds');
    assert.equal(afterFailed.accountCheckErrorCode, 'stale_failure');
    assert.equal(store.update(task.id, { state: 'unknown' }).state, 'completing_3ds');
    assert.equal(store.update(task.id, { state: 'succeeded' }).state, 'succeeded');
    assert.equal(store.update(task.id, { state: 'failed' }).state, 'succeeded');
    assert.equal(createPaymentTaskStore(root).getInternal(task.id).state, 'succeeded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('success history lists only confirmed successes and can be cleared independently', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-task-'));
  try {
    const store = createPaymentTaskStore(root);
    const succeeded = store.create({
      idempotencyKey: 'success-history-key',
      state: 'succeeded',
      email: 'paid@example.com',
      cardLast4: '4242',
      amount: 110000,
      currency: 'PHP',
      plan: 'chatgptplusplan'
    });
    store.create({
      idempotencyKey: 'failed-history-key',
      state: 'failed',
      email: 'failed@example.com',
      amount: 0,
      currency: 'PHP'
    });

    assert.deepEqual(store.list({ state: 'succeeded', limit: 100 }).map(task => task.id), [succeeded.id]);
    assert.equal(store.clearSucceeded(), 1);
    assert.equal(store.get(succeeded.id), null);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].state, 'failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
