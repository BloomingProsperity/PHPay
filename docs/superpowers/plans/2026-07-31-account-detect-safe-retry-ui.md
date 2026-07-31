# Account Detection, Safe Retry, and Hidden Fingerprint UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-click account detection/import, centralize retry decisions in the backend, correct card cooldown behavior, hide the fingerprint UI, and remove the obsolete N-4 issue.

**Architecture:** Reuse the existing parser, account store, and account-status detector through one narrow API. Derive public retry actions from the backend payment state machine and make the browser a consumer rather than a second policy engine. Preserve the configured 16-profile fingerprint runtime while removing only its visible UI.

**Tech Stack:** Node.js ESM, built-in `node:test`, file-backed resource/task stores, static HTML/CSS/JavaScript, Playwright UI assertions, Docker Compose.

---

### Task 1: Prove the account detection/import contract

**Files:**
- Modify: `test/resource-api.test.mjs`
- Modify: `src/server.js`

- [ ] **Step 1: Add failing API tests**

Add tests that POST `{ text }` to `/api/resources/accounts/detect-import` and prove:

```js
assert.equal(result.added, 1);
assert.equal(result.items[0].state, 'free');
assert.equal((await fetch(`${base}/api/accounts`).then(r => r.json())).length, 1);
```

Also prove that a second request reports a duplicate without increasing the count,
and an invalid credential returns a rejected item without persisting it.

- [ ] **Step 2: Run only the new API tests**

```powershell
node --test --test-name-pattern="pasted account detection" test/resource-api.test.mjs
```

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement the narrow endpoint**

Use `parseResourceFile('accounts', { name: 'pasted-account.txt', text })`,
`resources.add()`, and `startAccountStatusCheck()`. Return only safe resource views
and remove newly added invalid accounts before responding.

- [ ] **Step 4: Re-run the focused API tests**

Expected: PASS with fake account checks and disabled payment execution.

### Task 2: Centralize retry decisions and card release policy

**Files:**
- Modify: `src/payment-error.js`
- Modify: `src/payment-task-store.js`
- Modify: `src/server.js`
- Modify: `test/payment-error.test.mjs`
- Modify: `test/payment-task-store.test.mjs`
- Modify: `test/resource-api.test.mjs`

- [ ] **Step 1: Add failing policy tests**

Assert that:

```js
paymentResourcePolicy(addressFailure).card === 'available'
paymentResourcePolicy(proxyFailure).card === 'available'
paymentResourcePolicy(cardDecline).card === 'cooldown'
paymentResourcePolicy(insufficientFunds).card === 'blocked'
paymentResourcePolicy(unknown).hold === true
```

Assert public task JSON derives `retryAction` and ignores any client-supplied value.

- [ ] **Step 2: Run the three focused test files**

```powershell
node --test test/payment-error.test.mjs test/payment-task-store.test.mjs test/resource-api.test.mjs
```

Expected: the new policy and public field assertions FAIL.

- [ ] **Step 3: Implement the pure policy and use it at release boundaries**

Add `paymentResourcePolicy(task)` beside `paymentFailureAction(task)`. Use it in
`startPaymentTask()` and recheck completion handling. Do not change the provider
payment protocol.

- [ ] **Step 4: Re-run only the three focused files**

Expected: PASS; no real payment call.

### Task 3: Add the compact account button and remove duplicate retry logic

**Files:**
- Modify: `public/index.html`
- Modify: `test/resource-ui.mjs`
- Modify: `test/single-payment-card-switch.mjs`

- [ ] **Step 1: Add failing UI assertions**

Assert exactly one `#account-detect-import` button exists, clicking it uses the new
endpoint, refreshes the account count, and selects a single valid account.

Assert the source no longer defines a browser `paymentFailureAction()` and instead
reads `task.retryAction`.

- [ ] **Step 2: Run only the two UI scripts**

```powershell
node test/resource-ui.mjs http://127.0.0.1:3456
node test/single-payment-card-switch.mjs http://127.0.0.1:3456
```

Expected: FAIL before implementation.

- [ ] **Step 3: Implement compact UI behavior**

Add the button and a one-line result status under the textarea. Disable the button
during detection, refresh library counts, select one valid account, and show a safe
summary for multiple/duplicate/rejected results.

Replace the local retry classifier with `task.retryAction`.

- [ ] **Step 4: Re-run only the two UI scripts**

Expected: PASS using intercepted APIs, without real payment.

### Task 4: Hide fingerprint UI without disconnecting runtime

**Files:**
- Modify: `public/index.html`
- Modify: `test/resource-ui.mjs`
- Test: `test/fingerprint-provider.test.mjs`
- Test: `test/network-context.test.mjs`
- Test: `test/browser-challenge.test.mjs`

- [ ] **Step 1: Add failing absence assertions**

Assert the page has no fingerprint card, management button, list, statistics, or
fingerprint text in task logs.

- [ ] **Step 2: Remove only visible fingerprint code**

Delete fingerprint-specific HTML, CSS, fetch/render handlers, and log text. Keep
`/api/fingerprint-provider`, task fingerprint assignment, provider snapshots, and
network-context pass-through unchanged.

- [ ] **Step 3: Run focused fingerprint-chain tests**

```powershell
node --test test/fingerprint-provider.test.mjs test/network-context.test.mjs
node --test --test-name-pattern="fingerprint|normalized proxy and impersonation" test/browser-challenge.test.mjs
```

Expected: PASS and prove the hidden UI did not disable runtime selection.

### Task 5: Remove obsolete issue and deploy

**Files:**
- Modify: `ISSUES.md`
- Modify: `docs/superpowers/specs/2026-07-31-account-detect-safe-retry-ui-design.md`

- [ ] **Step 1: Remove N-4**

Delete only the N-4 multi-country signal section. Do not change address generation or
country handling.

- [ ] **Step 2: Run final affected-module verification**

Run only the files named in Tasks 1–4 plus syntax checks. Do not run the repository
test suite and do not execute a real payment.

- [ ] **Step 3: Rebuild the existing service**

```powershell
docker compose up -d --build dipay
docker compose ps
```

Expected: the single `dipay` service is up on `127.0.0.1:3456`.

- [ ] **Step 4: Inspect the right-side UI**

Verify the new account action is compact, the fingerprint card is absent, and no
other module moved out of alignment. Do not click a payment button.

## Execution note

This workspace is not a Git repository, so commit checkpoints are replaced by
focused test checkpoints. Execution is inline because the user requested no
subagents.

