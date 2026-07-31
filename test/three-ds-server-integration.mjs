import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaymentTaskStore } from '../src/payment-task-store.js';
import { createResourceStore } from '../src/resource-store.js';

const TARGET_PLAN = 'chatgptplusplan';

test('startup observer completes an overdue 3DS task and finalizes its locked resources', async () => {
  await withServer(async ({ base, root, ids }) => {
    const task = await waitFor(
      async () => (await fetch(`${base}/api/payment-tasks/${ids.taskId}`)).json(),
      value => value.state === 'succeeded',
      'overdue 3DS task was not completed'
    );

    assert.equal(task.completionSource, 'account_tier_after_3ds');
    assert.equal(task.accountPlanCurrent, TARGET_PLAN);
    assert.match(task.threeDsCompletedAt, /^\d{4}-\d{2}-\d{2}T/);

    const resources = createResourceStore(root);
    const account = resources.list('accounts').find(item => item.id === ids.accountId);
    const card = resources.list('cards').find(item => item.id === ids.cardId);
    const address = resources.list('addresses').find(item => item.id === ids.addressId);

    assert.deepEqual(
      {
        state: account.payment.state,
        plan: account.payment.plan,
        via3ds: account.payment.via3ds,
        accountPlanBefore: account.payment.accountPlanBefore
      },
      {
        state: 'completed',
        plan: TARGET_PLAN,
        via3ds: true,
        accountPlanBefore: 'chatgptfreeplan'
      }
    );
    assert.notEqual(account.usage?.state, 'in_use');
    assert.notEqual(address.usage?.state, 'in_use');
    assert.equal(card.usage.state, 'cooldown');
    assert.equal(card.usage.attemptCount, 1);
    assert.equal(card.usage.successCount, 1);
    assert.equal(card.usage.threeDsCount, 1);
    assert.equal(card.usage.hasThreeDs, true);
    assert.ok(Date.parse(card.usage.cooldownUntil) > Date.now());
  }, {
    fakeState: 'active',
    fakePlan: TARGET_PLAN,
    accountPlanBefore: 'chatgptfreeplan'
  });
});

test('baseline target stays pending on a 25 second cadence and recheck performs no payment call', async () => {
  await withServer(async ({ base, ids, audit }) => {
    const pending = await waitFor(
      async () => (await fetch(`${base}/api/payment-tasks/${ids.taskId}`)).json(),
      value => value.state === 'pending_3ds' && Boolean(value.lastAccountCheckAt),
      'baseline 3DS task was not observed'
    );

    assert.equal(pending.accountPlanCurrent, TARGET_PLAN);
    const retryDelay = Date.parse(pending.nextAccountCheckAt) - Date.parse(pending.lastAccountCheckAt);
    assert.ok(retryDelay >= 24_900 && retryDelay <= 25_100, `unexpected retry delay ${retryDelay}`);

    const response = await fetch(`${base}/api/payment-tasks/${ids.taskId}/recheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionJson: 'must-not-be-used' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'pending_3ds');
    assert.equal(audit().some(event => String(event.type || '').startsWith('payment-')), false);
  }, {
    fakeState: 'active',
    fakePlan: TARGET_PLAN,
    accountPlanBefore: TARGET_PLAN
  });
});

async function withServer(run, { fakeState, fakePlan, accountPlanBefore }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-three-ds-server-'));
  const auditFile = path.join(root, 'audit.jsonl');
  const port = 45000 + Math.floor(Math.random() * 1000);
  const ids = seedPendingTask(root, accountPlanBefore);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DIPAY_STORAGE_ROOT: root,
      DIPAY_DISABLE_ACCOUNT_STATUS_CHECK: '1',
      DIPAY_DISABLE_PAYMENT_EXECUTION: '1',
      DIPAY_FAKE_ACCOUNT_STATUS_CHECK: '1',
      DIPAY_FAKE_ACCOUNT_STATUS_STATE: fakeState,
      DIPAY_FAKE_ACCOUNT_STATUS_PLAN: fakePlan,
      DIPAY_TEST_AUDIT_FILE: auditFile
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;

  try {
    await waitFor(
      async () => {
        try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
      },
      Boolean,
      `isolated server did not start: ${stderr.join('')}`
    );
    await run({ base, root, ids, audit: () => readAudit(auditFile) });
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function seedPendingTask(root, accountPlanBefore) {
  const resources = createResourceStore(root);
  const accountId = resources.add('accounts', {
    accessToken: 'eyJhbGci.server.observer',
    user: { email: 'observer@example.com' }
  }).id;
  const cardId = resources.add('cards', {
    number: '4242424242424242',
    exp: '12/30',
    cvc: '123',
    name: 'Observer Card'
  }).id;
  const addressId = resources.add('addresses', {
    line1: '1 Observer St',
    city: 'Seattle',
    state: 'WA',
    zip: '98101',
    country: 'US'
  }).id;
  const now = Date.now();
  const tasks = createPaymentTaskStore(root);
  const task = tasks.create({
    idempotencyKey: `three-ds-server-${accountPlanBefore}`,
    state: 'pending_3ds',
    stage: 'confirm_started',
    accountResourceId: accountId,
    cardResourceId: cardId,
    addressResourceId: addressId,
    networkSlot: 0,
    plan: TARGET_PLAN,
    amount: 99900,
    currency: 'PHP',
    verificationUrl: 'https://verify.example/3ds',
    accountPlanBefore,
    threeDsDetectedAt: new Date(now - 180_000).toISOString(),
    firstAccountCheckAt: new Date(now - 60_000).toISOString(),
    nextAccountCheckAt: new Date(now - 1_000).toISOString()
  });

  for (const [kind, id] of [['accounts', accountId], ['cards', cardId], ['addresses', addressId]]) {
    assert.equal(resources.reserve(kind, id, task.id), true);
  }
  assert.equal(resources.recordCardEvent(cardId, task.id, 'submitted'), true);
  assert.equal(resources.recordCardEvent(cardId, task.id, 'three_ds'), true);
  return { taskId: task.id, accountId, cardId, addressId };
}

async function waitFor(read, predicate, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function readAudit(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
