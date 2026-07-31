# 3DS Account-Tier Observer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent manual-3DS queue that detects completion from the account tier, records card usage/3DS history, and exposes the workflow in the expanded right-side UI.

**Architecture:** Reuse `detectAccountStatus` as the only tier reader. Persist baseline/current tier and observer timestamps on payment tasks, run an isolated server-side scheduler with a two-minute first delay and 25-second repeats, and use an idempotent per-card task ledger for counts. The browser renders redacted task/resource views and never polls Stripe or resubmits payment for 3DS.

**Tech Stack:** Node.js ES modules, filesystem JSON stores, native `node:test`, Playwright Core, Docker Compose, single-file HTML/CSS/JavaScript frontend.

**Repository note:** `C:\Users\h\Desktop\dipay` is not a Git worktree. The commit checkpoints required by the planning workflow are replaced with focused test checkpoints; do not initialize Git or alter TLS/fingerprint files.

---

## File map

- Create `src/three-ds-observer.js`: scheduling and account-tier observation only.
- Create `src/proxy-config.js`: proxy parsing, redacted persistence, precedence, and round-robin selection.
- Create `test/three-ds-observer.test.mjs`: deterministic fake-clock observer tests.
- Create `test/proxy-config.test.mjs`: proxy parser/store/precedence tests.
- Create `test/three-ds-ui.mjs`: intercepted browser tests for the new panel and card statistics.
- Modify `src/account-status.js`: canonical plan normalization/comparison helper.
- Modify `src/payment.js`: target-aware preflight and account-status hook.
- Modify `src/payment-task-store.js`: persist and redact observer status fields.
- Modify `src/resource-store.js`: idempotent card event ledger and 3DS completion metadata.
- Modify `src/server.js`: wire hooks, observer lifecycle, resource completion, batch reconciliation, and remove pending-3DS Stripe scheduling.
- Modify `public/index.html`: expanded validation panel, dedicated 3DS queue, card usage labels, dead-control cleanup, and affected-page UI fixes.
- Modify focused existing tests under `test/`: update assertions for the new public contracts.
- Do not modify `src/fprints.js`, `src/network-context.js`, `src/browser.js`, `src/solver.js`, `src/turnstile.js`, or TLS/proxy/challenge behavior.

### Task 1: Normalize plans and make payment preflight target-aware

**Files:**
- Modify: `src/account-status.js`
- Modify: `src/payment.js`
- Test: `test/account-status.test.mjs`
- Test: `test/payment-orchestration.test.mjs`

- [ ] **Step 1: Write failing canonical-plan tests**

Add tests asserting:

```js
assert.equal(normalizePlanTier('chatgptplus'), 'chatgptplusplan');
assert.equal(normalizePlanTier('chatgptplusplan'), 'chatgptplusplan');
assert.equal(normalizePlanTier('chatgptpro'), 'chatgptpro');
assert.equal(normalizePlanTier('unexpected_paid_plan'), '');
```

Add target-aware preflight tests:

```js
assert.doesNotThrow(() => assertAccountCanSubscribe(
  { state: 'free', plan: 'chatgptfreeplan' },
  'chatgptplusplan'
));
assert.doesNotThrow(() => assertAccountCanSubscribe(
  { state: 'active', plan: 'chatgptplusplan' },
  'chatgptpro'
));
assert.throws(
  () => assertAccountCanSubscribe(
    { state: 'active', plan: 'chatgptplusplan' },
    'chatgptplusplan'
  ),
  error => error.code === 'account_already_on_target_plan'
);
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
node --test test/account-status.test.mjs test/payment-orchestration.test.mjs
```

Expected: FAIL because `normalizePlanTier` and the target-aware predicate are not implemented.

- [ ] **Step 3: Implement canonical normalization**

Export from `src/account-status.js`:

```js
const PLAN_ALIASES = new Map([
  ['chatgptfreeplan', 'chatgptfreeplan'],
  ['chatgptplus', 'chatgptplusplan'],
  ['chatgptplusplan', 'chatgptplusplan'],
  ['chatgptgoplan', 'chatgptgoplan'],
  ['chatgptprolite', 'chatgptprolite'],
  ['chatgptpro', 'chatgptpro'],
  ['chatgptteamplan', 'chatgptteamplan']
]);

export function normalizePlanTier(value) {
  return PLAN_ALIASES.get(String(value || '').trim().toLowerCase()) || '';
}
```

Use it inside `normalizeAccountStatus`.

- [ ] **Step 4: Implement target-aware preflight and hook**

Change the payment guard to:

```js
export function assertAccountCanSubscribe(status = {}, targetPlan = '') {
  const current = normalizePlanTier(status.plan);
  const target = normalizePlanTier(targetPlan);
  if (status.state === 'free') return { ...status, plan: current || 'chatgptfreeplan' };
  if (status.state === 'active' && current && target && current !== target) {
    return { ...status, plan: current };
  }
  if (status.state === 'active' && current === target) {
    const error = new Error('账号已经是所选套餐，已停止支付');
    error.code = 'account_already_on_target_plan';
    throw error;
  }
  // Preserve invalid/error handling through the existing safe codes.
}
```

Make `emitAccountStatus` accept `targetPlan`, return the normalized status, and invoke:

```js
hooks.onAccountStatus?.({ accountPlanBefore: status.plan });
```

before checkout creation.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node --test test/account-status.test.mjs test/payment-orchestration.test.mjs
```

Expected: PASS.

### Task 2: Persist observer state safely on payment tasks

**Files:**
- Modify: `src/payment-task-store.js`
- Test: `test/payment-task-store.test.mjs`

- [ ] **Step 1: Write failing persistence/redaction tests**

Create a pending task with:

```js
{
  accountPlanBefore: 'chatgptfreeplan',
  accountPlanCurrent: 'chatgptfreeplan',
  threeDsDetectedAt: '2026-07-30T10:00:00.000Z',
  firstAccountCheckAt: '2026-07-30T10:02:00.000Z',
  nextAccountCheckAt: '2026-07-30T10:02:00.000Z',
  accountCheckErrorCode: '',
  completionSource: ''
}
```

Assert those safe fields appear in `store.get()` while `accountResourceId`, checkout ids, and idempotency keys remain absent.

- [ ] **Step 2: Run the test and verify failure**

Run:

```powershell
node --test test/payment-task-store.test.mjs
```

Expected: FAIL because the new fields are not stored or exposed.

- [ ] **Step 3: Add typed fields**

Extend public/updatable fields with:

```js
'accountPlanBefore',
'accountPlanCurrent',
'threeDsDetectedAt',
'firstAccountCheckAt',
'lastAccountCheckAt',
'nextAccountCheckAt',
'accountCheckErrorCode',
'completionSource',
'threeDsCompletedAt'
```

Validate plans through the canonical plan helper, timestamps through a strict ISO-date helper, error codes through `safeCode`, and completion source through:

```js
value === 'account_tier_after_3ds' ? value : ''
```

- [ ] **Step 4: Run the task-store tests**

Run:

```powershell
node --test test/payment-task-store.test.mjs
```

Expected: PASS, including secret-redaction assertions.

### Task 3: Add an idempotent per-card usage and 3DS ledger

**Files:**
- Modify: `src/resource-store.js`
- Test: `test/resource-store.test.mjs`
- Test: `test/resource-api.test.mjs`

- [ ] **Step 1: Write failing ledger tests**

Add one card, reserve it for `task-1`, then call:

```js
store.recordCardEvent(card.id, 'task-1', 'submitted');
store.recordCardEvent(card.id, 'task-1', 'submitted');
store.recordCardEvent(card.id, 'task-1', 'three_ds');
store.recordCardEvent(card.id, 'task-1', 'three_ds');
store.recordCardEvent(card.id, 'task-1', 'succeeded');
store.recordCardEvent(card.id, 'task-1', 'succeeded');
```

Assert the public usage view contains:

```js
{
  attemptCount: 1,
  successCount: 1,
  threeDsCount: 1,
  hasThreeDs: true
}
```

Add a fresh-card assertion that all counts are zero.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
node --test test/resource-store.test.mjs test/resource-api.test.mjs
```

Expected: FAIL because `recordCardEvent` and the public counts do not exist.

- [ ] **Step 3: Implement the ledger**

Expose:

```js
recordCardEvent(id, taskId, event)
```

Persist private metadata:

```js
usage.cardTasks[taskId] = {
  ...(usage.cardTasks[taskId] || {}),
  submittedAt,
  threeDsAt,
  succeededAt
};
```

Only write a timestamp if the event field is still empty. Derive:

```js
attemptCount = Math.max(submittedTaskCount, paidAccountCount);
successCount = Math.max(succeededTaskCount, paidAccountCount);
threeDsCount = threeDsTaskCount;
hasThreeDs = threeDsCount > 0;
```

Do not expose task ids or the private ledger in API views.

- [ ] **Step 4: Persist account completion tags**

Allow `completeAccount` to accept:

```js
{
  via3ds: true,
  accountPlanBefore: 'chatgptfreeplan'
}
```

Expose only:

```js
payment: {
  state: 'completed',
  amount,
  currency,
  plan,
  via3ds
}
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node --test test/resource-store.test.mjs test/resource-api.test.mjs
```

Expected: PASS without leaking the private ledger.

### Task 4: Build the isolated 3DS account-tier observer

**Files:**
- Create: `src/three-ds-observer.js`
- Create: `test/three-ds-observer.test.mjs`

- [ ] **Step 1: Write deterministic fake-clock tests**

Construct the observer with injected `now`, `setTimer`, and `clearTimer`. Cover:

```js
observer.register(taskId);
assert.equal(timer.delay, 120_000);
```

After the first free-tier response:

```js
await timer.run();
assert.equal(nextTimer.delay, 25_000);
```

After the target-tier response:

```js
await nextTimer.run();
assert.equal(paymentTasks.get(taskId).state, 'succeeded');
assert.equal(paymentTasks.get(taskId).completionSource, 'account_tier_after_3ds');
```

Also assert:

- a temporary error reschedules in 25 seconds;
- invalid credentials stop scheduling;
- `recover()` respects persisted `nextAccountCheckAt`;
- two tasks for the same account never overlap;
- no injected Stripe/payment function exists or is called.

- [ ] **Step 2: Run the observer tests and verify failure**

Run:

```powershell
node --test test/three-ds-observer.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the observer**

Export:

```js
export function createThreeDsObserver({
  paymentTasks,
  resources,
  detectAccountStatus,
  finishSuccessfulTask,
  proxyFor = () => '',
  impFor = () => '',
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = timer => clearTimeout(timer),
  firstDelayMs = 120_000,
  intervalMs = 25_000
}) {
  // return { register, recover, stop, close }
}
```

`register(id)` schedules from persisted time. The check path:

1. reloads the task;
2. exits unless state is `pending_3ds`;
3. obtains the stored account;
4. calls `detectAccountStatus` once;
5. persists current tier and timestamps;
6. succeeds only on exact target/different-baseline match;
7. stops on invalid credentials;
8. otherwise schedules 25 seconds later.

- [ ] **Step 4: Run observer tests**

Run:

```powershell
node --test test/three-ds-observer.test.mjs
```

Expected: PASS.

### Task 5: Wire task creation, resource events, recovery, and batch status

**Files:**
- Modify: `src/server.js`
- Modify: `src/payment.js`
- Test: `test/payment-orchestration.test.mjs`
- Test: `test/payment-task-store.test.mjs`
- Test: `test/single-payment-auto-selection.mjs`

- [ ] **Step 1: Write failing integration tests with payment execution disabled**

Use temporary storage and fake account status to assert:

- `onAccountStatus` persists the baseline;
- `confirm_started` records one submitted-card event;
- `pending_3ds` records one 3DS event and schedules the two-minute first check;
- exact target tier finishes through the existing resource-release path;
- the account and card expose `via3ds`/3DS counts;
- restart recovery does not call payment execution;
- active account on a different plan is eligible;
- active account on the same selected plan is rejected;
- batch public state stops showing paused after all its pending 3DS tasks become succeeded.

- [ ] **Step 2: Run focused integration tests and verify failure**

Run:

```powershell
node --test test/payment-orchestration.test.mjs test/payment-task-store.test.mjs
node test/single-payment-auto-selection.mjs
```

Expected: FAIL on the new behavior.

- [ ] **Step 3: Wire hooks without touching TLS/fingerprint code**

In `startPaymentTask`:

```js
onAccountStatus: value => paymentTasks.update(id, value),
onStage: value => {
  paymentTasks.update(id, value);
  if (value.stage === 'confirm_started' && task.cardResourceId) {
    resources.recordCardEvent(task.cardResourceId, task.id, 'submitted');
  }
}
```

When the result becomes `pending_3ds`, atomically persist:

```js
{
  state: 'pending_3ds',
  verificationUrl,
  threeDsDetectedAt: nowIso,
  firstAccountCheckAt: plusTwoMinutesIso,
  nextAccountCheckAt: plusTwoMinutesIso
}
```

Record `three_ds` once and call `threeDsObserver.register(id)`.

- [ ] **Step 4: Make success accounting idempotent**

Before normal or 3DS success release:

```js
resources.recordCardEvent(task.cardResourceId, task.id, 'succeeded');
```

For 3DS completion, pass:

```js
{
  via3ds: true,
  accountPlanBefore: task.accountPlanBefore
}
```

to `completeAccount`.

- [ ] **Step 5: Recover on startup and keep 3DS off Stripe polling**

After interrupted-task recovery:

```js
threeDsObserver.recover();
```

Keep the legacy manual recheck route available for non-3DS diagnostics, but return the persisted task without Stripe/session polling when `task.state === 'pending_3ds'`.

- [ ] **Step 6: Reconcile batch state from task states**

Make `publicBatchRun` derive:

```js
const pending = tasks.some(task => ['processing', 'pending_3ds', 'unknown'].includes(task.state));
const state = pending ? (tasks.some(task => task.state === 'pending_3ds') ? 'paused' : 'processing') : 'completed';
```

This prevents a completed manual 3DS task from leaving a batch permanently paused.

- [ ] **Step 7: Run focused integration tests**

Run:

```powershell
node --test test/account-status.test.mjs test/payment-orchestration.test.mjs test/payment-task-store.test.mjs test/resource-store.test.mjs test/resource-api.test.mjs test/three-ds-observer.test.mjs
node test/single-payment-auto-selection.mjs
```

Expected: PASS.

### Task 6: Add runtime proxy configuration and import

**Files:**
- Create: `src/proxy-config.js`
- Create: `test/proxy-config.test.mjs`
- Modify: `src/server.js`
- Modify: `public/index.html`
- Modify: `test/resource-ui.mjs`

- [ ] **Step 1: Write failing parser/store tests**

Cover:

```js
assert.equal(normalizeProxy('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
assert.equal(
  normalizeProxy('127.0.0.1:8080:user:pass'),
  'http://user:pass@127.0.0.1:8080/'
);
assert.equal(
  normalizeProxy('https://user:pass@example.com:8443'),
  'https://user:pass@example.com:8443/'
);
assert.equal(normalizeProxy('socks5://127.0.0.1:1080'), '');
```

Assert blank removal, deduplication, invalid counts, atomic persistence, masked public views, environment precedence, and round-robin slot selection.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
node --test test/proxy-config.test.mjs
```

Expected: FAIL because `src/proxy-config.js` does not exist.

- [ ] **Step 3: Implement the proxy config module**

Export:

```js
export function normalizeProxy(value) {}
export function parseProxyLines(text) {}
export function createProxyConfig({
  file,
  env = process.env,
  testRequest
}) {
  return {
    publicView,
    replace,
    clear,
    proxyFor,
    test
  };
}
```

`replace()` writes the entire normalized list atomically with restrictive permissions. `publicView()` returns masked proxy labels only. `proxyFor(slot)` applies:

```text
PROXY_POOL env > saved list > CF_PROXY > HTTPS_PROXY > direct
```

- [ ] **Step 4: Wire dynamic selection and safe APIs**

Replace the static server pool with `proxyConfig.proxyFor(slot)` while preserving all existing call sites and network-slot persistence.

Add:

```text
GET  /api/proxy-config
PUT  /api/proxy-config
POST /api/proxy-config/test
```

The PUT route returns valid/duplicate/invalid counts. The test route never echoes credentials. When environment `PROXY_POOL` is non-empty, PUT returns a conflict explaining that environment configuration is authoritative.

- [ ] **Step 5: Add the proxy subsection and import drawer**

Inside the always-expanded validation card, add:

- a multiline `#proxy-input`;
- `#proxy-import`, `#proxy-test`, `#proxy-save`, and `#proxy-clear`;
- `#proxy-list` with per-entry remove buttons;
- masked source/count status;
- `.txt,.csv` file picker in the shared modal.

The browser parses file text locally, supports the four approved formats, merges with typed rows, and displays valid/duplicate/invalid totals before saving.

- [ ] **Step 6: Add intercepted UI/API tests**

Assert import, remove, clear, save, test, masking, env-lock messaging, and no duplicate handlers. Stub every proxy API and outbound test result; do not use a real proxy or external URL.

- [ ] **Step 7: Run focused proxy tests**

Run:

```powershell
node --test test/proxy-config.test.mjs
node test/resource-ui.mjs http://127.0.0.1:3456
```

Expected: PASS with no real external request.

### Task 7: Add validation-config import/clear and safe history controls

**Files:**
- Modify: `src/server.js`
- Modify: `src/payment-task-store.js`
- Modify: `public/index.html`
- Modify: `test/resource-ui.mjs`
- Test: focused store/API assertions

- [ ] **Step 1: Add focused failing tests**

Cover:

- JSON and text solver-config import preview;
- Key and URL detected independently;
- environment-owned values cannot be cleared through the UI;
- explicit Key, URL, and all-local clear;
- saved Key remains redacted;
- task-store clear by `succeeded`, `failed`, or all terminal;
- `processing`, `pending_3ds`, `completing_3ds`, and `unknown` are never bulk-deleted.

- [ ] **Step 2: Add safe solver config endpoints**

Keep `GET /api/solver` redacted. Extend local updates with atomic restricted-permission writes and add explicit clear behavior. Environment values remain authoritative and report locked controls.

- [ ] **Step 3: Add the import and clear UI**

Add “导入配置”, “清除 Key”, “清除 URL”, and “全部清除”. Reuse the shared modal for `.json,.txt` import and preview. Saving remains a separate confirmation action.

- [ ] **Step 4: Add safe task-history clearing**

Extend the task store with a state-filtered bulk clear that only accepts terminal `succeeded` and `failed` states. Add separate UI actions for success, failure, and all terminal history. Keep automatic deletion disabled.

- [ ] **Step 5: Run one focused verification**

Run only the directly affected store/UI test files once after implementation. Use intercepted APIs and no real solver/provider request.

### Task 8: Build the expanded validation and dedicated 3DS UI

**Files:**
- Modify: `public/index.html`
- Modify: `test/resource-ui.mjs`
- Create: `test/three-ds-ui.mjs`
- Modify: `test/status-panel-geometry.mjs`

- [ ] **Step 1: Write failing browser/static tests**

Assert:

- `#solver-settings` is visible on initial load;
- no solver collapse toggle remains;
- `#three-ds-panel` exists immediately below the validation panel;
- empty copy is compact;
- intercepted `GET /api/payment-tasks?state=pending_3ds` renders all pending entries;
- pending and completed groups render compact email-only rows;
- clicking an email opens the shared detail modal;
- the modal shows baseline/current/target tier, amount, countdown/error, and a safe HTTPS link/copy action;
- the modal shows the linked card tail/cardholder/use/success/3DS counts/state/badge without full PAN or CVC;
- no “重新查询支付” control appears;
- card rows show `使用 N 次 · 成功 N 次 · 3DS N 次`;
- `触发过 3DS` appears only when `hasThreeDs`;
- a completed task leaves “待验证”, remains as a clickable email under “最近完成”, disables its verification action, and also appears in success with `3DS 完成`;
- all document ids are unique;
- desktop/right-column/bottom panels align;
- 360px layout has no horizontal overflow.

- [ ] **Step 2: Run UI tests and verify failure**

Run against the local Docker UI:

```powershell
node test/resource-ui.mjs http://127.0.0.1:3456
node test/three-ds-ui.mjs http://127.0.0.1:3456
node test/status-panel-geometry.mjs http://127.0.0.1:3456
```

Expected: FAIL because the new panel and expanded default do not exist.

- [ ] **Step 3: Make validation settings permanently expanded**

Render `#solver-settings` without `hidden`, `inert`, `aria-hidden`, collapse animation state, or an `aria-controls="solver-settings"` toggle. Preserve the existing key, browser URL, test, save, and status controls.

- [ ] **Step 4: Add the 3DS panel**

Add directly after the validation section:

```html
<section class="resource-panel three-ds-panel" id="three-ds-panel" aria-labelledby="three-ds-title">
  <div class="three-ds-heading">
    <div>
      <h2 id="three-ds-title">3DS 手动验证</h2>
      <p>打开银行验证链接后，系统仅检测账号套餐等级。</p>
    </div>
    <span class="three-ds-count" id="three-ds-count">0</span>
  </div>
  <div id="three-ds-list" class="three-ds-list">
    <p class="three-ds-empty">暂无等待手动验证的任务</p>
  </div>
</section>
```

- [ ] **Step 5: Render redacted pending tasks**

Refresh the pending list on initial load and every five seconds for display only. Use DOM nodes and `textContent`. Compute countdown from `nextAccountCheckAt`; never trigger a backend payment recheck.

The primary link must satisfy:

```js
safeHttps(task.verificationUrl)
```

and use:

```html
target="_blank" rel="noopener noreferrer"
```

- [ ] **Step 6: Render card statistics and tags**

Every card row displays zero-safe counters:

```js
const attemptCount = Number(item.usage?.attemptCount || 0);
const successCount = Number(item.usage?.successCount || 0);
const threeDsCount = Number(item.usage?.threeDsCount || 0);
```

Add the badge only when `item.usage?.hasThreeDs === true`.

- [ ] **Step 7: Remove obsolete hidden duplicate controls and audit handlers**

Remove old hidden account/card/address import inputs/buttons that have been replaced by the active modal drawer. Keep the resource section rows and active selection controls. Confirm each active button receives one listener.

- [ ] **Step 8: Run UI tests**

Run:

```powershell
node test/resource-ui.mjs http://127.0.0.1:3456
node test/three-ds-ui.mjs http://127.0.0.1:3456
node test/status-panel-geometry.mjs http://127.0.0.1:3456
```

Expected: PASS with intercepted APIs only.

### Task 9: Final mocked verification and Docker/UI handoff

**Files:**
- Modify tests only if an assertion reveals an implementation defect.
- Do not modify TLS/fingerprint/challenge files.

- [ ] **Step 1: Prove the forbidden files are untouched**

Record hashes before/after implementation for:

```powershell
Get-FileHash src\fprints.js,src\network-context.js,src\browser.js,src\solver.js,src\turnstile.js
```

Expected: hashes match the pre-implementation snapshot.

- [ ] **Step 2: Run the complete relevant mocked test set**

Run:

```powershell
node --test test/account-status.test.mjs test/payment-error.test.mjs test/payment-orchestration.test.mjs test/payment-status.test.mjs test/payment-task-store.test.mjs test/resource-store.test.mjs test/resource-api.test.mjs test/proxy-config.test.mjs test/three-ds-observer.test.mjs
node test/resource-ui.mjs http://127.0.0.1:3456
node test/three-ds-ui.mjs http://127.0.0.1:3456
node test/status-panel-geometry.mjs http://127.0.0.1:3456
```

Expected: PASS. No real payment or real account-status request occurs.

- [ ] **Step 3: Rebuild and recreate Docker**

Run:

```powershell
docker compose up -d --build --force-recreate
docker compose ps
```

Expected: the service is healthy at `http://127.0.0.1:3456/`.

- [ ] **Step 4: Perform intercepted browser acceptance**

Open the right-side UI, intercept task/resource APIs, and visually verify:

- validation service is expanded;
- the proxy input/import drawer supports typed and file-based lists with masked saved values;
- the new 3DS panel is directly below it;
- a mocked pending task shows a two-minute first-check countdown;
- a mocked later check shows a 25-second countdown;
- a mocked completed task moves to “最近完成”; clicking its email still opens account/card details while the verification action is disabled, and the task also appears in success with `3DS 完成`;
- card counts and 3DS badge render;
- no 3DS action can resubmit payment.

- [ ] **Step 5: Report exact verification evidence**

Report changed files, focused test results, Docker status, right-side UI state, and the preserved TLS/fingerprint hashes. Explicitly state that no real payment test was run.
