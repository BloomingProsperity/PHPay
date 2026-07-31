# Full-Chain Fixes and Reference UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已确认的账号、支付任务、3DS、代理和恢复问题，并把生产 UI 完整替换为参考 HTML 的视觉和排版，同时保留全部功能。

**Architecture:** 把凭证选择、稳定账号身份、完成索引、任务收口和网络错误规范化放到独立纯模块中，由 `server.js` 组合；前端继续使用现有安全 API 和 DOM ID，只更换生产标记结构与 CSS。所有行为更改先用最小失败测试证明，再实施单一修复。

**Tech Stack:** Node.js ESM、内置 `node:test`、文件持久化、Undici、静态 HTML/CSS/JavaScript、应用内浏览器、Docker Compose。

---

## File map

- Create `src/account-identity.js`: 规范化邮箱、生成稳定账号键并合并新凭证。
- Create `src/payment-ledger.js`: 独立保存已完成账号/套餐索引。
- Create `src/network-error.js`: 遍历 cause 链并规范化传输错误。
- Modify `src/account-status.js`: 返回检测实际使用的 token 和 email。
- Modify `src/resource-store.js`: 稳定账号合并、完成索引恢复和陈旧锁释放。
- Modify `src/payment-task-store.js`: 取消状态、全部未决任务读取和链接任务字段。
- Modify `src/three-ds-observer.js`: 显式停止并支持任务取消。
- Modify `src/stripe.js`: 为所有 Stripe 请求增加超时。
- Modify `src/server.js`: 接线统一导入、任务复核/取消、代理所有权、POST 链接任务和运行清理。
- Modify `public/index.html`: 移植参考稿生产布局与样式，保持现有安全事件接线。
- Modify affected tests under `test/`.

### Task 1: Effective account credential

**Files:**
- Modify: `src/account-status.js`
- Modify: `src/server.js`
- Test: `test/account-status.test.mjs`
- Test: `test/resource-api.test.mjs`

- [ ] **Step 1: Add a failing credential-fallback test**

```js
test('returns the refreshed token used after access-token rejection', async () => {
  const status = await detectAccountStatus(
    { accessToken: 'old', sessionToken: 'session' },
    {
      token: 'old',
      getAccountStatusFn: async token => token === 'old'
        ? { status: 401, json: {} }
        : { status: 200, json: freeAccountsPayload() },
      resolveTokenFn: async () => ({ token: 'fresh', email: 'user@example.com' })
    }
  );
  assert.equal(status.state, 'free');
  assert.equal(status.token, 'fresh');
  assert.equal(status.email, 'user@example.com');
});
```

- [ ] **Step 2: Verify the focused test is red**

Run:

```powershell
node --test --test-name-pattern="returns the refreshed token" test/account-status.test.mjs
```

Expected: FAIL because `detectAccountStatus()` currently returns no effective token.

- [ ] **Step 3: Return and consume the effective credential**

Keep a local `effectiveToken` and `effectiveEmail`; after session fallback replace both and return:

```js
return {
  ...normalizeAccountStatus(response.json),
  token: effectiveToken,
  email: effectiveEmail
};
```

In `loadStoredAccountContext()`, use `status.token || token` and `status.email || email`.

- [ ] **Step 4: Verify green**

```powershell
node --test --test-name-pattern="refreshed token|cached account context" test/account-status.test.mjs test/resource-api.test.mjs
```

Expected: PASS without any external request.

### Task 2: Stable identity and durable payment ledger

**Files:**
- Create: `src/account-identity.js`
- Create: `src/payment-ledger.js`
- Modify: `src/resource-store.js`
- Modify: `src/server.js`
- Test: `test/account-identity.test.mjs`
- Test: `test/payment-ledger.test.mjs`
- Test: `test/resource-store.test.mjs`

- [ ] **Step 1: Add failing stable-identity tests**

```js
test('same email with refreshed tokens has one stable key', () => {
  assert.equal(
    stableAccountKey({ user: { email: ' User@Example.com ' }, accessToken: 'a' }),
    stableAccountKey({ user: { email: 'user@example.com' }, accessToken: 'b' })
  );
});

test('completed plan survives account resource deletion and reimport', () => {
  ledger.complete({
    accountKey: 'email:user@example.com',
    plan: 'chatgptplusplan',
    taskId: crypto.randomUUID(),
    amount: 110000,
    currency: 'PHP'
  });
  assert.equal(ledger.get('email:user@example.com', 'chatgptplusplan').amount, 110000);
});
```

- [ ] **Step 2: Verify both tests are red**

```powershell
node --test test/account-identity.test.mjs test/payment-ledger.test.mjs
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement stable identity and atomic ledger**

`stableAccountKey(account)` returns `email:<lowercase email>` when available and otherwise
`credential:<sha256(accessToken or sessionToken)>`. `mergeAccountCredential(old, next)`
keeps `_resource` metadata and replaces non-empty credential/user fields.

`createPaymentLedger(root)` stores `config/payment-ledger.json` atomically:

```js
{
  complete(entry) {},
  get(accountKey, plan) {},
  entries() {}
}
```

Each key is `${accountKey}\0${normalizePlanTier(plan)}` and completion is idempotent by task ID.

- [ ] **Step 4: Make account add an upsert**

For accounts, `resources.add()` searches by stable account key. On match, merge the new
credentials into the existing file and return `{ status: 'duplicate', id, updated: true }`.
When loading a view, restore `payment` from the ledger if the same stable key/plan completed.

- [ ] **Step 5: Record success in the ledger before marking the resource**

`finishSuccessfulTaskResources()` writes the ledger entry first, then calls
`resources.completeAccount()`. Deleting or clearing resource JSON never removes ledger entries.

- [ ] **Step 6: Verify focused stores**

```powershell
node --test test/account-identity.test.mjs test/payment-ledger.test.mjs test/resource-store.test.mjs
```

Expected: PASS; same email stays one resource and completed plans survive deletion/reimport.

### Task 3: Unified account import

**Files:**
- Modify: `src/server.js`
- Test: `test/resource-api.test.mjs`

- [ ] **Step 1: Add failing parity tests**

```js
test('file and pasted account import apply the same validity policy', async () => {
  const file = await post('/api/resources/accounts/import', {
    file: { name: 'accounts.txt', text: fixture }
  });
  const pasted = await post('/api/resources/accounts/detect-import', { text: fixture });
  assert.deepEqual(
    pickImportCounts(file),
    pickImportCounts(pasted)
  );
});
```

Test valid, invalid, duplicate, and retryable status-error records.

- [ ] **Step 2: Verify red**

```powershell
node --test --test-name-pattern="same validity policy" test/resource-api.test.mjs
```

Expected: FAIL because file import currently returns before status checks finish.

- [ ] **Step 3: Extract one import service**

Create a server-local `importAccounts({name,text})` that parses, upserts, awaits a maximum of
three concurrent status checks, removes only newly added `invalid` records, and returns
`{ added, duplicate, rejected, items, errors }`. Both endpoints call it.

- [ ] **Step 4: Verify parity**

```powershell
node --test --test-name-pattern="account import|pasted account" test/resource-api.test.mjs
```

Expected: PASS.

### Task 4: Unknown and 3DS lifecycle

**Files:**
- Modify: `src/payment-task-store.js`
- Modify: `src/three-ds-observer.js`
- Modify: `src/server.js`
- Modify: `public/index.html`
- Test: `test/payment-task-store.test.mjs`
- Test: `test/three-ds-observer.test.mjs`
- Test: `test/three-ds-server-integration.mjs`

- [ ] **Step 1: Add failing cancel and batch-recheck tests**

```js
test('cancels pending 3DS without changing a succeeded task', () => {
  assert.equal(store.cancel(pending.id, 'cancelled_by_user').state, 'failed');
  assert.equal(store.cancel(succeeded.id, 'cancelled_by_user'), null);
});

test('missing account 3DS remains cancellable and releases resources', async () => {
  const response = await fetch(`${base}/api/payment-tasks/${task.id}/cancel`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).errorCode, 'cancelled_by_user');
});
```

- [ ] **Step 2: Verify red**

```powershell
node --test test/payment-task-store.test.mjs test/three-ds-observer.test.mjs test/three-ds-server-integration.mjs
```

Expected: FAIL on missing cancel API/store transition.

- [ ] **Step 3: Implement safe cancellation**

Add `paymentTasks.cancel(id, reason)` allowing only `pending_3ds`, `completing_3ds` before
completion claim, and `unknown`. Stop the observer, release task resources without paid usage,
release fingerprint and proxy, and persist `failed/cancelled_by_user`.

- [ ] **Step 4: Make batch paused state actionable**

Public batch output keeps `paused` while unresolved tasks exist, but each task carries
`retryAction: reconcile`. The UI renders “复核” for unknown and “取消” for stopped 3DS.
Polling continues at 5 seconds for paused batches rather than locking all controls; safe
non-payment controls remain enabled.

- [ ] **Step 5: Verify lifecycle**

```powershell
node --test test/payment-task-store.test.mjs test/three-ds-observer.test.mjs test/three-ds-server-integration.mjs
```

Expected: PASS with no payment execution.

### Task 5: Temporary address rule

**Files:**
- Modify: `public/index.html`
- Test: `test/single-payment-card-switch.mjs`

- [ ] **Step 1: Add a failing page-load test**

```js
assert.equal(await page.locator('#line1').inputValue(), '');
await page.click('#pay');
assert.equal(temporaryAddressCalls, 1);
```

- [ ] **Step 2: Verify red**

```powershell
node test/single-payment-card-switch.mjs http://127.0.0.1:3456
```

Expected: FAIL because `/api/defaults` pre-fills the address.

- [ ] **Step 3: Stop address prefill**

Remove the `/api/defaults` address assignment. Keep fields empty until a selected address,
manual input, or `ensureTaskAddress()` fills them. Preserve explicit `forceAddress`.

- [ ] **Step 4: Verify green**

Run the same command and expect PASS.

### Task 6: Proxy ownership, error typing, and timeouts

**Files:**
- Create: `src/network-error.js`
- Modify: `src/payment-error.js`
- Modify: `src/stripe.js`
- Modify: `src/server.js`
- Test: `test/payment-error.test.mjs`
- Test: `test/proxy-config.test.mjs`
- Test: `test/resource-api.test.mjs`

- [ ] **Step 1: Add failing cause-chain and timeout tests**

```js
test('classifies nested proxy transport failures', () => {
  const cause = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
  const error = new TypeError('fetch failed', { cause });
  assert.equal(safePaymentErrorCode(error, { hasProxy: true }), 'proxy_connection_failed');
});
```

Inject a fetch that waits for abort and assert Stripe `call()` rejects with
`network_timeout` within the configured test timeout.

- [ ] **Step 2: Verify red**

```powershell
node --test --test-name-pattern="nested proxy|network timeout|account check proxy lease" test/payment-error.test.mjs test/resource-api.test.mjs
```

Expected: FAIL on nested cause and unleased account check.

- [ ] **Step 3: Implement error-chain normalization**

`errorChain(error)` walks `cause` with cycle protection. `isProxyTransportError(error)`
checks `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`,
`UND_ERR_HEADERS_TIMEOUT`, `ENOTFOUND`, and typed local timeouts.

- [ ] **Step 4: Add Stripe abort timeout**

Use `AbortSignal.timeout(timeoutMs)` in `call()`, defaulting to 30 seconds and accepting
an injected shorter timeout in tests. Convert abort failures to an error with
`code = 'network_timeout'`.

- [ ] **Step 5: Lease proxies for account checks**

Account checks acquire the next healthy unleased proxy through the shared registry, release
it after detection, and use direct mode only when the configured pool is empty. A task-bound
3DS check continues to use its already-held proxy.

- [ ] **Step 6: Verify focused networking**

```powershell
node --test test/payment-error.test.mjs test/proxy-config.test.mjs test/resource-api.test.mjs
```

Expected: PASS.

### Task 7: POST link tasks and legacy shutdown

**Files:**
- Modify: `src/payment-task-store.js`
- Modify: `src/server.js`
- Modify: `public/index.html`
- Test: `test/resource-api.test.mjs`
- Test: `test/resource-ui.mjs`

- [ ] **Step 1: Add failing transport tests**

```js
test('link generation never accepts credentials in a GET query', async () => {
  assert.equal((await fetch(`${base}/api/link?payload=secret`)).status, 405);
  assert.equal((await fetch(`${base}/api/link-tasks`, {
    method: 'POST',
    body: JSON.stringify({ sessionJson: fixture, plan: 'chatgptplusplan' })
  })).status, 202);
});
```

- [ ] **Step 2: Verify red**

```powershell
node --test --test-name-pattern="link generation never" test/resource-api.test.mjs
```

Expected: FAIL because GET `/api/link` is still active.

- [ ] **Step 3: Implement POST link jobs**

Add `/api/link-tasks` and `/api/link-batches` POST routes. Persist safe progress/result records,
reuse effective account context, and return only HTTPS links. GET `/api/link` and
`/api/batch-links` return 405/410 without reading query credentials.

- [ ] **Step 4: Rewire existing buttons**

`#link` and `#batch` use `fetch(POST)` plus safe status polling. Keep their labels and positions
from the reference UI.

- [ ] **Step 5: Verify**

```powershell
node --test --test-name-pattern="link" test/resource-api.test.mjs
node test/resource-ui.mjs http://127.0.0.1:3456
```

Expected: PASS; inspected requests contain no session query parameter.

### Task 8: Runtime cleanup and recovery

**Files:**
- Modify: `src/resource-store.js`
- Modify: `src/server.js`
- Test: `test/resource-store.test.mjs`
- Test: `test/resource-api.test.mjs`

- [ ] **Step 1: Add failing cleanup tests**

Assert a finished batch is removed from `activeBatchRuns`, its coordinator listener closes,
and startup releases a resource lock whose task ID is absent or terminal.

- [ ] **Step 2: Verify red**

```powershell
node --test --test-name-pattern="finished batch cleanup|orphan lock recovery" test/resource-api.test.mjs test/resource-store.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Implement bounded lifecycle**

Close coordinators in `finally`. Keep a safe completed batch snapshot for 10 minutes, then
delete it. Add `resources.releaseOrphanLocks(unresolvedTaskIds)` and build the unresolved set
from every processing, pending_3ds, completing_3ds, and unknown task at startup.

- [ ] **Step 4: Verify**

Run the same focused command and expect PASS.

### Task 9: Exact reference UI transplant

**Files:**
- Modify: `public/index.html`
- Modify: `test/resource-ui.mjs`
- Modify: `test/single-payment-card-switch.mjs`

- [ ] **Step 1: Add failing reference-layout assertions**

Assert:

```js
assert.equal(await page.locator('.app-shell').evaluate(el => getComputedStyle(el).maxWidth), '1360px');
assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(245, 247, 251)');
assert.equal(await page.locator('.resource-grid > .resource-card').count(), 3);
assert.equal(await page.locator('.service-grid > .service-card').count(), 3);
assert.equal(await page.locator('.task-status-grid > *').count(), 2);
```

Also assert every pre-existing required ID exists exactly once and all modal close paths work.

- [ ] **Step 2: Verify red**

```powershell
node test/resource-ui.mjs http://127.0.0.1:3456
```

Expected: FAIL because current layout does not use the reference structure.

- [ ] **Step 3: Transplant reference tokens and structure**

Use production CSS variables:

```css
:root {
  --page:#f5f7fb;
  --surface:#fff;
  --field:#f7f9fc;
  --line:#e6ebf2;
  --accent:#2f8f66;
  --accent-soft:#eef7f2;
  --text:#1f2b3a;
  --muted:#6b7889;
  --danger:#c0504f;
}
.app-shell{max-width:1360px;margin:0 auto;padding:30px 28px 72px;display:flex;flex-direction:column;gap:20px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:18px}
```

Convert inline reference styles to named production classes. Keep every functional ID and
existing event handler. Replace sample values with current counters, task data, proxy status,
3DS data, and success records.

- [ ] **Step 4: Add responsive behavior**

At desktop: resource 3 columns, payment 2 columns, services 3 columns, status 2 columns.
At `max-width: 900px`: payment/services/status stack to one column.
At `max-width: 560px`: resource cards stack, actions wrap, modal padding reduces.

- [ ] **Step 5: Verify UI behavior**

```powershell
node test/resource-ui.mjs http://127.0.0.1:3456
node test/single-payment-card-switch.mjs http://127.0.0.1:3456
```

Expected: PASS with intercepted APIs and no real payment.

### Task 10: Focused completion verification and Docker

**Files:**
- Verify all files modified above.

- [ ] **Step 1: Run syntax checks**

```powershell
node --check src/server.js
node --check src/account-status.js
node --check src/resource-store.js
node --check src/payment-task-store.js
```

Expected: no output and exit code 0.

- [ ] **Step 2: Run one affected-module aggregate**

```powershell
node --test test/account-status.test.mjs test/account-identity.test.mjs test/payment-ledger.test.mjs test/resource-store.test.mjs test/payment-task-store.test.mjs test/payment-error.test.mjs test/proxy-config.test.mjs test/three-ds-observer.test.mjs test/three-ds-server-integration.mjs test/resource-api.test.mjs
```

Expected: all affected tests PASS; no real endpoints are contacted.

- [ ] **Step 3: Rebuild existing Docker service**

```powershell
docker compose up -d --build dipay
docker compose ps
```

Expected: `dipay` is Up on `127.0.0.1:3456`.

- [ ] **Step 4: Inspect only, never pay**

In the right-side page, verify desktop and narrow widths, no horizontal overflow, no console
errors, each required ID exactly once, and all non-payment buttons/panels/modal close actions.

- [ ] **Step 5: Final completion audit**

Cross-check every requirement in
`docs/superpowers/specs/2026-07-31-full-chain-fixes-reference-ui-design.md` against source,
focused test output, Docker status, and rendered UI evidence. Keep the goal active if any item
lacks direct evidence.

## Execution note

This workspace is not a Git repository, so commit steps are intentionally omitted. The user
previously prohibited subagents; execution is inline with focused checkpoints and no real
payment.
