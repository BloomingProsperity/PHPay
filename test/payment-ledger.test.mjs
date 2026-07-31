import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaymentLedger } from '../src/payment-ledger.js';

function withLedger(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dipay-payment-ledger-'));
  try { return run(createPaymentLedger(root), root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('completed plan survives resource deletion because it is stored in an independent ledger', () => withLedger((ledger, root) => {
  const taskId = crypto.randomUUID();
  ledger.complete({
    accountKey: 'email:user@example.com',
    plan: 'chatgptplusplan',
    taskId,
    amount: 110000,
    currency: 'PHP'
  });

  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  const resource = path.join(root, 'accounts', 'user@example.com.json');
  fs.writeFileSync(resource, '{}');
  fs.unlinkSync(resource);

  assert.deepEqual(ledger.get('email:user@example.com', 'chatgptplusplan'), {
    accountKey: 'email:user@example.com',
    plan: 'chatgptplusplan',
    taskId,
    amount: 110000,
    currency: 'PHP',
    completedAt: ledger.get('email:user@example.com', 'chatgptplusplan').completedAt
  });
  assert.ok(Date.parse(ledger.get('email:user@example.com', 'chatgptplusplan').completedAt));
}));

test('payment ledger completion is idempotent by account and plan', () => withLedger(ledger => {
  const first = ledger.complete({
    accountKey: 'email:user@example.com',
    plan: 'chatgptplusplan',
    taskId: 'task-one',
    amount: 110000,
    currency: 'PHP'
  });
  const replay = ledger.complete({
    accountKey: 'email:user@example.com',
    plan: 'chatgptplusplan',
    taskId: 'task-two',
    amount: 999999,
    currency: 'PHP'
  });

  assert.deepEqual(replay, first);
  assert.equal(ledger.entries().length, 1);
}));
