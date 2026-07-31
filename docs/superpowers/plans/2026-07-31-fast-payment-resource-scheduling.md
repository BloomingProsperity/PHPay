# Fast Payment Resource Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce account-import-to-payment-success latency while adding safe ordered proxy/card/address scheduling, without real payments, new infrastructure, or TLS fingerprint changes.

**Architecture:** Each Docker deployment remains an independent resource domain. A deployment-local account-context cache coalesces token/status work, a lightweight coordinator manages ordered proxy leases and event-driven resource waits, and the payment state machine only switches resources before the irreversible confirm boundary.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing Undici/Playwright dependencies, file-backed resource/task stores, single-process Docker service.

**Current status (2026-07-31):** Tasks 1–8 are implemented and verified with
affected-module tests plus local Docker/UI inspection. No real payment test was run.

---

## File structure

- Create `src/account-context-cache.js`: short-lived per-deployment token/status cache and in-flight request coalescing.
- Create `src/fingerprint-provider.js`: stable soft-lease provider port whose default adapter preserves current fingerprint behavior.
- Create `src/task-resource-coordinator.js`: ordered proxy health, hard leases, FIFO wait notification, and direct-mode handling.
- Modify `src/proxy-config.js`: expose private ordered snapshots and recent health without exposing credentials publicly.
- Modify `src/payment.js`: consume trusted cached account context, parallelize independent pre-confirm requests, and remove the first fixed polling delay.
- Modify `src/payment-error.js`: classify only explicit safe pre-confirm retry categories.
- Modify `src/payment-task-store.js`: persist attempt/stage metadata needed to prevent post-confirm retries.
- Modify `src/server.js`: connect import checks, account cache, proxy preflight, resource leases, queue wakeups, and retry decisions.
- Modify `public/index.html`: show compact preflight, waiting, retry, proxy, fingerprint and 3DS states.
- Create `test/account-context-cache.test.mjs`: cache TTL and coalescing tests.
- Create `test/fingerprint-provider.test.mjs`: default behavior, ordered soft leases, reuse, snapshots, and redaction.
- Create `test/task-resource-coordinator.test.mjs`: ordered proxy leases, direct mode, and wakeup tests.
- Modify `test/payment-orchestration.test.mjs`: critical-path parallelism and immediate poll tests.
- Modify `test/proxy-config.test.mjs`: snapshot/health redaction tests.
- Modify `test/resource-api.test.mjs`: batch scheduling and conflict integration tests using disabled payment execution.

### Task 1: Coalesce account recognition work

**Files:**
- Create: `src/account-context-cache.js`
- Create: `test/account-context-cache.test.mjs`

- [ ] **Step 1: Write failing cache tests**

Add tests proving that concurrent calls for the same account invoke the loader once, successful entries remain fresh for 120 seconds, failed results are not reused for fast payment, and two independent cache instances do not share state.

```js
test('coalesces concurrent account loads and reuses a fresh successful context', async () => {
  let calls = 0;
  const cache = createAccountContextCache({ ttlMs: 120_000, now: () => 1_000 });
  const loader = async () => {
    calls += 1;
    return {
      token: 'token',
      email: 'person@example.com',
      status: { state: 'free', plan: 'chatgptfreeplan', errorCode: '' }
    };
  };
  const [first, second] = await Promise.all([
    cache.load('accounts_one', loader),
    cache.load('accounts_one', loader)
  ]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.deepEqual(await cache.load('accounts_one', loader), first);
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
node --test test/account-context-cache.test.mjs
```

Expected: FAIL because `src/account-context-cache.js` does not exist.

- [ ] **Step 3: Implement the cache**

Implement `createAccountContextCache({ ttlMs, now })` with `load(id, loader)`, `peek(id)`, `invalidate(id)`, and `clear()`. Keep `value` and `promise` private; only cache contexts whose status is `free` or `active`.

- [ ] **Step 4: Run the focused test**

Run:

```powershell
node --test test/account-context-cache.test.mjs
```

Expected: PASS.

### Task 2: Shorten the normal payment critical path

**Files:**
- Modify: `src/payment.js`
- Modify: `test/payment-orchestration.test.mjs`

- [ ] **Step 1: Add failing orchestration tests**

Add a deferred-promise test proving `stripe.createPM`, `stripe.init`, and `sentinelReq` all start before any of the three resolves. Add a polling test proving the first `pollSession` occurs before the first `sleep`.

```js
test('starts PM, init, and sentinel concurrently after checkout creation', async () => {
  const started = [];
  const gate = Promise.withResolvers();
  const { flows } = fixture({
    stripe: {
      createPM: async () => {
        started.push('pm');
        await gate.promise;
        return { j: { id: 'pm_test' } };
      },
      init: async () => {
        started.push('init');
        await gate.promise;
        return { j: { init_checksum: 'checksum', invoice: { amount_due: 99900 } } };
      }
    },
    cg: {
      sentinelReq: async () => {
        started.push('sentinel');
        await gate.promise;
        return { json: { token: 'sentinel-token' } };
      }
    }
  });
  const payment = flows.runPay(input, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(new Set(started), new Set(['pm', 'init', 'sentinel']));
  gate.resolve();
  await payment;
});
```

- [ ] **Step 2: Run only payment orchestration tests and verify failure**

Run:

```powershell
node --test test/payment-orchestration.test.mjs
```

Expected: new concurrency and immediate-poll assertions FAIL.

- [ ] **Step 3: Parallelize the safe section**

After checkout creation, define `loadCurrentPricing` and execute:

```js
const [pm, sentinel, pricing] = await Promise.all([
  dependencies.stripe.createPM(card, address, pk, network.proxy),
  prepareSentinel(opts, emit, dependencies),
  loadCurrentPricing()
]);
```

Keep confirm strictly after all three have succeeded.

- [ ] **Step 4: Remove only the first polling delay**

Change the result loop to sleep only when `i > 0`:

```js
for (let i = 0; i < 12; i++) {
  if (i > 0) await dependencies.sleep(1000);
  const poll = await dependencies.stripe.pollSession(cs, pk, network.proxy);
  // existing classification
}
```

- [ ] **Step 5: Run the focused test**

Run:

```powershell
node --test test/payment-orchestration.test.mjs
```

Expected: PASS, including existing amount/unknown-result protections.

### Task 3: Reuse import-time account context during payment

**Files:**
- Modify: `src/payment.js`
- Modify: `src/server.js`
- Modify: `test/payment-orchestration.test.mjs`
- Modify: `test/resource-api.test.mjs`

- [ ] **Step 1: Add failing trusted-context tests**

Verify that a server-supplied fresh `{ token, email, status }` avoids both `resolveToken` and `detectAccountStatus`, still calls `assertAccountCanSubscribe`, and records `accountPlanBefore`. Verify that untrusted HTTP body fields cannot activate this path.

- [ ] **Step 2: Run the two focused test files**

Run:

```powershell
node --test test/payment-orchestration.test.mjs test/resource-api.test.mjs
```

Expected: new assertions FAIL.

- [ ] **Step 3: Connect import checks to the cache**

Create one `accountContexts` instance in `src/server.js`. Replace duplicate status work with a loader that resolves the token once, detects status with that token, persists the public status, and returns the private context.

- [ ] **Step 4: Pass context through server-owned hooks only**

For tasks created from `accountResourceId`, call `accountContexts.load()` before `runPay` and pass the result in the non-public hooks object. Do not read `accountContext` from the request body.

- [ ] **Step 5: Consume trusted context in `runPay`**

When hooks contain a valid context, emit and validate the cached status without calling the network dependencies. Manual pasted credentials and stale/error contexts continue through the existing path.

- [ ] **Step 6: Invalidate on explicit account changes**

Invalidate one cache entry on account delete/manual recheck and clear the cache on account-library clear.

- [ ] **Step 7: Run the focused tests**

Run:

```powershell
node --test test/account-context-cache.test.mjs test/payment-orchestration.test.mjs test/resource-api.test.mjs
```

Expected: PASS.

### Task 4: Add ordered deployment-local proxy coordination

**Files:**
- Create: `src/task-resource-coordinator.js`
- Create: `test/task-resource-coordinator.test.mjs`
- Modify: `src/proxy-config.js`
- Modify: `test/proxy-config.test.mjs`

- [ ] **Step 1: Write failing coordinator tests**

Cover stable top-to-bottom ordering, concurrent hard leases, release and FIFO wakeup, current-run unavailable proxies, direct mode without a concurrency limit, and isolation between two coordinator instances.

- [ ] **Step 2: Run the two focused test files**

Run:

```powershell
node --test test/task-resource-coordinator.test.mjs test/proxy-config.test.mjs
```

Expected: FAIL because the coordinator and private snapshot API do not exist.

- [ ] **Step 3: Expose a private ordered snapshot**

Add `snapshot()` to `createProxyConfig()` returning a new array of raw normalized proxies for server-internal use. Keep `publicView()` redacted and unchanged.

- [ ] **Step 4: Implement the coordinator**

Implement:

```js
createTaskResourceCoordinator({
  proxies,
  direct,
  now,
  healthTtlMs
})
```

with `markHealth(index, result)`, `acquireProxy(ownerId, cursor)`, `releaseProxy(ownerId)`, `waitForChange(signal)`, and `publicStats()`. Use maps/sets and event wakeups, not timers.

- [ ] **Step 5: Run the focused tests**

Run:

```powershell
node --test test/task-resource-coordinator.test.mjs test/proxy-config.test.mjs
```

Expected: PASS.

### Task 4A: Establish the future fingerprint-library entry point

**Files:**
- Create: `src/fingerprint-provider.js`
- Create: `test/fingerprint-provider.test.mjs`
- Modify: `src/server.js`
- Modify: `src/payment-task-store.js`
- Reference: `docs/fingerprint-provider-contract.md`

- [ ] **Step 1: Write failing provider tests**

Cover the current single-default profile, top-to-bottom selection, preference for unused profiles, soft reuse when every profile is occupied, release by owner, stable snapshots, and public redaction.

- [ ] **Step 2: Run the focused test**

Run:

```powershell
node --test test/fingerprint-provider.test.mjs
```

Expected: FAIL because `src/fingerprint-provider.js` does not exist.

- [ ] **Step 3: Implement the stable provider port**

Implement `createFingerprintProvider({ profiles, fallbackProfile })` with:

```js
snapshot()
acquire({ ownerId, ordinal })
release(ownerId)
publicView()
```

The default provider must return the existing `DEFAULT_IMPERSONATION`. Do not modify `src/network-context.js` in this phase.

- [ ] **Step 4: Persist only the integration seam**

Store the selected fingerprint ID, public label, reused flag, and private profile snapshot on newly created tasks. Continue passing the existing default `imp` value to payment code so runtime behavior is unchanged.

- [ ] **Step 5: Add a fake-library wiring test**

Inject 16 fake profiles and prove ordered assignment. Inject 8 profiles for 10 owners and prove owners 9 and 10 reuse profiles 1 and 2 without waiting.

- [ ] **Step 6: Run the focused tests**

Run:

```powershell
node --test test/fingerprint-provider.test.mjs test/payment-task-store.test.mjs
```

Expected: PASS; private headers never appear in public task output.

### Task 5: Integrate streaming proxy preflight and event-driven resource waits

**Files:**
- Modify: `src/server.js`
- Modify: `test/resource-api.test.mjs`

- [ ] **Step 1: Add failing integration tests**

Use injected test hooks to prove:

- proxy tests run concurrently;
- a healthy proxy can launch a task without waiting for slower proxy tests;
- failed proxies are skipped in stable order;
- two active tasks never share a configured proxy;
- no configured proxy permits all requested concurrency through direct mode;
- a waiting account wakes after card/proxy release without 250ms scanning.

- [ ] **Step 2: Run only resource API tests**

Run:

```powershell
node --test test/resource-api.test.mjs
```

Expected: new scheduling assertions FAIL.

- [ ] **Step 3: Create one coordinator per batch**

Snapshot the proxy list at run creation. Start at most `min(concurrency, 10)` proxy tests. Mark results as they settle and notify the scheduler immediately.

- [ ] **Step 4: Replace worker-slot proxy selection**

Assign proxies by the batch cursor and hard lease owner, not by the Promise worker `slot`. Persist `networkSlot` and `networkProxy` on the task only after acquiring the lease.

- [ ] **Step 5: Replace 250ms polling**

When no card or proxy is available, await the coordinator/resource-release notification. Card cooldown uses one timer for the nearest deadline; ordinary in-use resources do not cause repeated file scans.

- [ ] **Step 6: Preserve all-or-nothing acquisition**

If account/card/address/proxy acquisition fails, release all already acquired resources with `recordUsage: false`, release the proxy lease, and return the account to FIFO.

- [ ] **Step 7: Run the focused integration test**

Run:

```powershell
node --test test/resource-api.test.mjs
```

Expected: PASS with `DIPAY_DISABLE_PAYMENT_EXECUTION=1`; no external payment request.

### Task 6: Add stage-aware safe resource switching

**Files:**
- Modify: `src/payment-error.js`
- Modify: `src/payment-task-store.js`
- Modify: `src/server.js`
- Modify: `test/payment-error.test.mjs`
- Modify: `test/payment-task-store.test.mjs`
- Modify: `test/resource-api.test.mjs`

- [ ] **Step 1: Add failing decision tests**

Cover explicit card failures, explicit pre-confirm proxy failure, explicit address failure, `pending_3ds`, and any exception after `confirm_started`.

- [ ] **Step 2: Run the three focused files**

Run:

```powershell
node --test test/payment-error.test.mjs test/payment-task-store.test.mjs test/resource-api.test.mjs
```

Expected: new retry-decision assertions FAIL.

- [ ] **Step 3: Add a pure retry decision**

Implement a function that returns one of:

```text
next_card
next_address
next_proxy
reconcile
stop
```

The function must return `reconcile` for 3DS/unknown and must only return a resource
switch after `confirm_started` when the provider gave an authoritative no-charge
failure such as a card decline.

- [ ] **Step 4: Apply decisions in the batch loop**

Keep the account job ordinal stable. Each new safe attempt creates a new task record linked by `jobId` and `attempt`; never mutate a submitted task back to processing.

- [ ] **Step 5: Preserve locks for uncertain outcomes**

Keep account/card ownership for `pending_3ds` and `unknown`. A replacement proxy may only be used by the existing read-only reconciliation path and must never call confirm.

- [ ] **Step 6: Run the focused tests**

Run:

```powershell
node --test test/payment-error.test.mjs test/payment-task-store.test.mjs test/resource-api.test.mjs test/three-ds-server-integration.mjs
```

Expected: PASS without real payment.

### Task 7: Show speed and scheduling state without crowding the UI

**Files:**
- Modify: `public/index.html`
- Modify: `test/resource-ui.mjs`

- [ ] **Step 1: Add failing UI assertions**

Verify compact labels for `代理预检`, `等待资源`, `自动换卡`, `自动换地址`, `自动换代理`, and stage durations. Verify detailed retry information remains in the task dialog.

- [ ] **Step 2: Run only the UI test**

Run:

```powershell
node test/resource-ui.mjs
```

Expected: FAIL until the new labels and rendering exist.

- [ ] **Step 3: Implement compact rendering**

Add one summary row to the task panel. Do not add another permanent large card. Put per-attempt resource and duration details in the existing task/3DS dialog.

- [ ] **Step 4: Run the UI test**

Run:

```powershell
node test/resource-ui.mjs
```

Expected: PASS.

### Task 8: Final targeted verification

**Files:**
- No production file changes unless a focused verification reveals a defect.

- [x] **Step 1: Run only affected unit/integration tests**

```powershell
node --test test/account-context-cache.test.mjs test/task-resource-coordinator.test.mjs test/proxy-config.test.mjs test/payment-orchestration.test.mjs test/payment-error.test.mjs test/payment-task-store.test.mjs test/resource-api.test.mjs test/three-ds-server-integration.mjs
node --test test/fingerprint-provider.test.mjs
node test/resource-ui.mjs
```

Expected: all PASS, no external payment calls.

- [x] **Step 2: Build and start the existing single-service compose deployment**

Only after Docker Desktop is available:

```powershell
docker compose up -d --build
docker compose ps
```

Expected: one healthy `dipay` container for this deployment; no added infrastructure services.

- [x] **Step 3: Inspect the local UI**

Open `http://127.0.0.1:3456/`, verify compact layout and simulated scheduling states. Do not click any operation that can submit a real payment.

- [x] **Step 4: Review the critical path**

Confirm from source and tests that the normal path is:

```text
local import parse
→ coalesced token/status context
→ checkout session
→ PM + init + Sentinel in parallel
→ confirm
→ approve
→ immediate first result query
```

and that post-confirm unknown/3DS states cannot enter any automatic resubmission branch.

## Execution note

The current workspace is not a Git repository, so the plan deliberately uses test checkpoints instead of commit checkpoints. The user previously requested no subagents; execution is inline in the current session.
