# Single Payment Auto Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make “立即支付” automatically use available account and card resources and generate a temporary address when manual fields are empty.

**Architecture:** Keep resource selection in the existing browser resource layer and retain server-side locking at payment-task creation. Add one preparation function that honors manual selections first, then selects eligible library resources, then invokes the existing temporary-address generator.

**Tech Stack:** Node.js, browser JavaScript, local HTTP API, Playwright Core, Docker Compose

---

### Task 1: Expose account availability

**Files:**
- Modify: `src/resource-store.js`
- Test: `test/resource-store.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a test that reserves an account and expects its public list view to contain `usage.state === "in_use"`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node --test --test-name-pattern="account list exposes task occupancy" test/resource-store.test.mjs
```

Expected: FAIL because account views currently omit usage state.

- [ ] **Step 3: Implement account usage view**

Return the account view through the same lock-state projection used by other resources while retaining its `payment` field.

- [ ] **Step 4: Run test to verify it passes**

Run the same command and expect one passing test.

### Task 2: Add automatic single-payment preparation

**Files:**
- Modify: `public/index.html`
- Create: `test/single-payment-auto-selection.mjs`

- [ ] **Step 1: Write the failing browser test**

Start an isolated server, import one valid account and card, leave the address library empty, intercept `POST /api/payment-tasks`, click `#pay`, and assert:

```js
assert.match(payload.accountResourceId, /^accounts_/);
assert.match(payload.cardResourceId, /^cards_/);
assert.equal(payload.addressResourceId, '');
assert.ok(payload.address.line1);
assert.equal(addressesAfter.length, 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node test/single-payment-auto-selection.mjs
```

Expected: FAIL because the current click handler calls `getSess()` before any library selection.

- [ ] **Step 3: Implement minimal preparation flow**

Add `prepareSinglePaymentResources()` inside the resource-layer closure:

```js
if (!sess.value.trim()) {
  const account = resourceLibraries.acclist.list.find(item => !item.payment && item.usage?.state !== 'in_use');
  if (!account) throw new Error('账号库没有可用账号');
  await useResource('accounts', account);
}
if (![num.value, exp.value, cvc.value].every(value => value.trim())) {
  const card = [...resourceLibraries.cardlist.list]
    .filter(item => !['in_use', 'cooldown'].includes(item.usage?.state))
    .sort((a, b) => (a.usage?.paidAccountCount || 0) - (b.usage?.paidAccountCount || 0) || a.importedAt.localeCompare(b.importedAt))[0];
  if (!card) throw new Error('卡库没有可用支付卡');
  await useResource('cards', card);
}
await ensureTaskAddress();
```

Call it before reading the final session value in the `#pay` handler.

- [ ] **Step 4: Run browser test to verify it passes**

Run the new browser test and expect PASS without a real payment request.

### Task 3: Regression verification and deployment

**Files:**
- Modify: `src/payment.js`
- Modify: `src/server.js`
- Modify: `src/resource-store.js`
- Modify: `public/index.html`
- Test: `test/resource-store.test.mjs`
- Test: `test/single-payment-auto-selection.mjs`

- [ ] **Step 1: Add failing balance-state tests**

Verify an insufficient-funds card leaves the lock, exposes `usage.state === "insufficient_funds"`, cannot be reserved, and becomes reservable after explicit restoration.

- [ ] **Step 2: Preserve the provider decline reason**

Return `state: "failed"` for immediate provider rejection and normalize either `code` or `decline_code` equal to `insufficient_funds` into the public task error code.

- [ ] **Step 3: Retry with the next eligible card**

On an `insufficient_funds` terminal task, refresh the card library, exclude attempted, occupied, cooling, and insufficient cards, and submit the same account/address with the next card. Do not retry any other terminal condition.

- [ ] **Step 4: Add manual restoration**

Expose a local restore endpoint and a card-library “恢复使用” button for insufficient cards.

### Task 4: Regression verification and deployment

**Files:**
- Verify: `src/resource-store.js`
- Verify: `public/index.html`

- [ ] **Step 1: Run the complete automated suite**

```powershell
node --check src/server.js
node --test test/resource-importers.test.mjs test/resource-store.test.mjs test/payment-task-store.test.mjs test/resource-api.test.mjs
node test/resource-ui.mjs
node test/single-payment-auto-selection.mjs
```

Expected: all tests pass with zero failures.

The browser tests must select `chatgptplusplan`; production plan choices remain unchanged.

- [ ] **Step 2: Rebuild and restart Docker**

```powershell
docker compose up -d --build
```

Expected: container `dipay` starts successfully.

- [ ] **Step 3: Verify health**

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3456/api/health
```

Expected: HTTP 200 and `{"ok":true,...}`.
