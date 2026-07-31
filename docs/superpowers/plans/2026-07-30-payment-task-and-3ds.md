# Payment Task and 3DS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-shot payment SSE with locally persisted, idempotent payment tasks that safely hand 3DS to the user and can be rechecked.

**Architecture:** Add a small filesystem-backed payment-task store whose public views are redacted. `payment.js` classifies provider polling results without treating a setup intent as a charge. `server.js` creates/rechecks tasks through POST routes and streams state updates, while `index.html` submits a generated idempotency key and renders the task action.

**Tech Stack:** Node.js ESM, built-in `node:test`, filesystem JSON store, native browser fetch/EventSource.

---

### Task 1: Define the payment outcome classifier

**Files:**
- Create: `src/payment-status.js`
- Create: `test/payment-status.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaymentStatus } from '../src/payment-status.js';

test('requires_action becomes pending_3ds with a redirect URL', () => {
  assert.deepEqual(classifyPaymentStatus({
    payment_intent: { status: 'requires_action', next_action: { redirect_to_url: { url: 'https://verify.example/3ds' } } }
  }), { state: 'pending_3ds', verificationUrl: 'https://verify.example/3ds' });
});

test('a succeeded setup intent does not mark a payment successful', () => {
  assert.deepEqual(classifyPaymentStatus({ setup_intent: { status: 'succeeded' } }), { state: 'processing' });
});

test('a paid checkout becomes succeeded', () => {
  assert.deepEqual(classifyPaymentStatus({ payment_status: 'paid' }), { state: 'succeeded' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/payment-status.test.mjs`

Expected: failure because `src/payment-status.js` does not exist.

- [ ] **Step 3: Write the minimal classifier**

```js
export function classifyPaymentStatus(payload = {}) {
  const intent = payload.payment_intent || {};
  if (payload.payment_status === 'paid' || intent.status === 'succeeded') return { state: 'succeeded' };
  if (intent.status === 'requires_action') {
    return { state: 'pending_3ds', verificationUrl: intent.next_action?.redirect_to_url?.url || '' };
  }
  return { state: 'processing' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/payment-status.test.mjs`

Expected: 3 passing tests.

### Task 2: Persist redacted payment tasks and protect idempotent retries

**Files:**
- Create: `src/payment-task-store.js`
- Create: `test/payment-task-store.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
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
    const first = store.create({ idempotencyKey: 'key-1', email: 'a@example.com', cardLast4: '4242', amount: 99900, currency: 'PHP', checkoutSessionId: 'cs_secret' });
    const second = store.create({ idempotencyKey: 'key-1', email: 'a@example.com', cardLast4: '4242', amount: 99900, currency: 'PHP' });
    assert.equal(first.id, second.id);
    assert.equal(second.reused, true);
    assert.doesNotMatch(JSON.stringify(store.list()), /cs_secret|key-1/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/payment-task-store.test.mjs`

Expected: failure because `src/payment-task-store.js` does not exist.

- [ ] **Step 3: Implement create/get/update/list with atomic JSON writes**

Implement `createPaymentTaskStore(root)` with `create(input)`, `get(id)`, `update(id, patch)`, and `list()`. Store idempotency key and checkout session id internally; return views containing only `id`, `state`, `email`, `cardLast4`, `amount`, `currency`, `verificationUrl`, timestamps, and safe error codes.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/payment-task-store.test.mjs`

Expected: 1 passing test.

### Task 3: Make payment execution return a classified, auditable outcome

**Files:**
- Modify: `src/payment.js:1-145`
- Modify: `test/payment-card.test.mjs`

- [ ] **Step 1: Write failing final-validation tests**

Add tests proving `validateCard` rejects a Luhn-invalid PAN, month `13`, and an expiry before the current month.

- [ ] **Step 2: Run the payment-card test file**

Run: `node --test test/payment-card.test.mjs`

Expected: the new tests fail because final validation is currently permissive.

- [ ] **Step 3: Implement strict final validation and return fields**

Use the existing card parser validation helpers or equivalent pure checks so `runPay` returns `state`, `amount`, `currency`, `checkoutSessionId`, safe `verificationUrl`, and safe error code. Use `classifyPaymentStatus` in polling. Preserve `unknown` after polling expires, and remove `setup_intent.succeeded` as a payment-success condition.

- [ ] **Step 4: Run the payment-card tests**

Run: `node --test test/payment-card.test.mjs`

Expected: all tests pass.

### Task 4: Replace GET payment execution with POST payment-task APIs

**Files:**
- Modify: `src/server.js:1-560`
- Modify: `test/resource-api.test.mjs`

- [ ] **Step 1: Write failing API tests**

Add tests that `POST /api/payment-tasks` rejects a missing idempotency key, that `GET /api/pay` returns 405, and that `GET /api/payment-tasks/:id` returns a redacted saved task.

- [ ] **Step 2: Run the API tests**

Run: `node --test test/resource-api.test.mjs`

Expected: the new task routes are absent and the legacy GET payment route still succeeds.

- [ ] **Step 3: Implement task routes**

Create `POST /api/payment-tasks`, `GET /api/payment-tasks/:id`, and `POST /api/payment-tasks/:id/recheck`. Start an SSE stream only after task creation, require `Idempotency-Key`, reuse an existing task for a duplicate key, and return 405 for the retired `GET /api/pay` route. Do not persist request payload secrets.

- [ ] **Step 4: Run API tests**

Run: `node --test test/resource-api.test.mjs`

Expected: all resource and payment-task API tests pass.

### Task 5: Render persisted status and the user-operated 3DS flow

**Files:**
- Modify: `public/index.html:385-620`
- Modify: `test/resource-ui.mjs`

- [ ] **Step 1: Write failing UI assertions**

Add assertions that payment submits through `fetch('/api/payment-tasks', { method: 'POST' })`, renders a `pending_3ds` status, creates a verification link only from the redacted task view, and provides a recheck button.

- [ ] **Step 2: Run the UI test**

Run: `node test/resource-ui.mjs`

Expected: failure because the page still constructs `/api/pay?payload=`.

- [ ] **Step 3: Implement task status UI**

Generate one browser idempotency key per click; POST it with the payment data; display amount, currency, state, and email. For `pending_3ds`, provide “完成银行验证” and “重新查询” buttons. The first opens only the server-supplied verification URL; the second calls the recheck endpoint. Build log rows with DOM text nodes rather than `innerHTML`.

- [ ] **Step 4: Run UI test**

Run: `node test/resource-ui.mjs`

Expected: UI test passes.

### Task 6: Run full safe verification and rebuild local container

**Files:**
- Verify only

- [ ] **Step 1: Run all local safe tests**

Run: `node --test test/resource-importers.test.mjs test/resource-store.test.mjs test/payment-card.test.mjs test/payment-status.test.mjs test/payment-task-store.test.mjs test/resource-api.test.mjs; node test/resource-ui.mjs`

Expected: all tests pass.

- [ ] **Step 2: Build and restart the local service**

Run: `docker compose up -d --build`

Expected: the local `dipay` service reports running.

- [ ] **Step 3: Check health and static retirement**

Run: `Invoke-RestMethod http://127.0.0.1:3456/api/health; (Invoke-WebRequest http://127.0.0.1:3456/).Content | Select-String '/api/pay\\?payload='`

Expected: health returns `ok: true` and the static page has no legacy GET payment submission.
