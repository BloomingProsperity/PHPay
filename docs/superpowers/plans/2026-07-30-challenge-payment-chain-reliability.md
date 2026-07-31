# Challenge and Payment Chain Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make account import, status detection, checkout, payment, 3DS recheck, and success persistence use one network identity and handle Cloudflare failures without corrupting account or resource state.

**Architecture:** Centralize proxy/fingerprint normalization in a small module. Make the ChatGPT transport and challenge coordinator independently testable with injected functions, propagate a typed challenge error, and persist only a network slot in private payment-task state. Preserve the existing promotion bypass and provider-returned actual amount logic.

**Tech Stack:** Node.js ESM, `node:test`, Python `curl_cffi`, Playwright Core, Undici, Docker Compose.

---

### Task 1: Stable network context

**Files:**
- Create: `src/network-context.js`
- Create: `test/network-context.test.mjs`
- Modify: `src/fprints.js`

- [ ] **Step 1: Write failing tests**

Test that an explicit proxy wins, an empty proxy falls back through `CF_PROXY` then `HTTPS_PROXY`, and the supported fingerprint is `chrome131`.

- [ ] **Step 2: Verify RED**

Run: `node --test test/network-context.test.mjs`

Expected: failure because `src/network-context.js` does not exist.

- [ ] **Step 3: Implement the minimal context API**

Provide:

```js
export function effectiveProxy(value = '', env = process.env)
export function effectiveImpersonation(value = '')
export function normalizeNetworkContext(input = {}, env = process.env)
```

Explicit non-empty values win. Fingerprints normalize to `chrome131` so Chromium UA, CapSolver UA, and `curl_cffi` use one supported Chrome identity.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/network-context.test.mjs`

Expected: all tests pass.

### Task 2: Detect and propagate Cloudflare challenges

**Files:**
- Create: `test/browser-challenge.test.mjs`
- Modify: `cffetch.py`
- Modify: `src/browser.js`

- [ ] **Step 1: Write failing transport tests**

Cover:

- `cf-mitigated: challenge` is detected regardless of status.
- a 403 HTML compatibility challenge is detected.
- the effective proxy reaches both raw transport and solver.
- a failed solve throws `cloudflare_challenge_failed`.
- a successful solve replays once with `cf_clearance` and the solver UA.

- [ ] **Step 2: Verify RED**

Run: `node --test test/browser-challenge.test.mjs`

Expected: failure because the injectable transport and challenge classifier do not exist.

- [ ] **Step 3: Implement the transport boundary**

Export:

```js
export function isChallengeResponse(response)
export function createCgFetch({ rawFetch, solve, clear })
export class CloudflareChallengeError extends Error
```

The production `cgFetch` uses `createCgFetch`. It normalizes the network context before the first request, never returns an unresolved challenge as an ordinary response, and clears an invalid replay before throwing.

Change `cffetch.py` to make one coherent `chrome131` request and return only the challenge-relevant response headers plus candidate HTML.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/browser-challenge.test.mjs`

Expected: all tests pass without external network access.

### Task 3: Cache only usable solver results

**Files:**
- Create: `test/solver.test.mjs`
- Modify: `src/solver.js`

- [ ] **Step 1: Write failing coordinator tests**

Cover:

- only a cookie header containing `cf_clearance` is usable;
- browser/session cookies are filtered out and only `cf_clearance` is replayed;
- empty/failed results are not cached;
- concurrent identical keys execute one solve;
- valid results are cached by origin, proxy, and fingerprint;
- clearing the key forces a new solve.

- [ ] **Step 2: Verify RED**

Run: `node --test test/solver.test.mjs`

Expected: failure because the challenge coordinator API does not exist.

- [ ] **Step 3: Implement the coordinator**

Export:

```js
export function hasClearanceCookie(value)
export function createChallengeCoordinator({ ttl, now } = {})
```

Production `solveChallenge` delegates through the coordinator. The browser attempt is successful only after `cf_clearance` exists. Remove the non-functional direct headed retry; fall back from headless Chromium to CapSolver. Throw `cloudflare_challenge_failed` when neither returns a usable solution.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/solver.test.mjs test/browser-challenge.test.mjs`

Expected: all tests pass.

### Task 4: Preserve account correctness, resource binding, and task network identity

**Files:**
- Modify: `test/account-status.test.mjs`
- Modify: `test/payment-task-store.test.mjs`
- Modify: `test/resource-api.test.mjs`
- Modify: `src/account-status.js`
- Modify: `src/payment-task-store.js`
- Modify: `src/payment.js`
- Modify: `src/server.js`
- Modify: `src/payment-error.js`
- Modify: `public/index.html`

- [ ] **Step 1: Write failing state tests**

Cover:

- `cloudflare_challenge_failed` maps to account state `error`, never `invalid`;
- malformed entitlement payloads cannot become `free`;
- completed accounts cannot be downgraded by startup or delayed status checks;
- startup account checks use bounded concurrency;
- real-time `active`, `error`, `unknown`, and `pending` statuses stop before checkout;
- a private `networkSlot` persists but never appears in public task JSON;
- server-created single tasks use slot zero;
- task recheck derives proxy and fingerprint from the stored slot;
- supplied resource IDs make server-side account/card/address records authoritative over client copies;
- a batch reservation conflict terminates or advances instead of creating failed tasks forever;
- unavailable persisted addresses fall back to a temporary per-task address instead of dropping an account;
- UI shows a safe challenge-failure reason.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test test/account-status.test.mjs test/payment-task-store.test.mjs test/resource-api.test.mjs
node test/resource-ui.mjs
```

Expected: new assertions fail for missing behavior.

- [ ] **Step 3: Implement state propagation**

Normalize the context at `runPay` and `runLink` entry. Require the real-time account state to be exactly `free`, and require explicit entitlement booleans before classifying an account as free. Prevent completed accounts from being downgraded and bound startup checks to a small worker pool. Store `networkSlot` privately, inject slot-zero context into single tasks, store the batch slot, and reuse the slot during recheck. When a resource ID is present, rebuild that part of the payload from the store. Make batch reservation conflicts bounded and use a temporary address when no persisted address is currently available. Add a user-safe `cloudflare_challenge_failed` message.

- [ ] **Step 4: Verify GREEN**

Run the commands from Step 2.

Expected: all tests pass.

### Task 5: Protect the charge boundary and actual amount

**Files:**
- Modify: `test/payment-card.test.mjs`
- Create: `test/payment-orchestration.test.mjs`
- Modify: `test/payment-task-store.test.mjs`
- Modify: `test/resource-api.test.mjs`
- Modify: `src/payment.js`
- Modify: `src/payment-task-store.js`
- Modify: `src/server.js`
- Modify: `src/stripe.js`

- [ ] **Step 1: Write failing charge-boundary tests**

Cover:

- missing `invoice.amount_due` never falls back to `total_summary`;
- zero amount is recorded and stops before confirm;
- attached promo/credit/discount/trial stops before payment-method creation or confirm;
- a Sentinel failure occurs before confirm and is a safe failure;
- a confirm transport exception becomes `unknown`;
- approve/poll exceptions after confirm become `unknown`;
- explicit provider decline remains `failed`;
- private payment stage persists and is omitted publicly;
- `/api/batch-pay` returns 410 without executing payment.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test test/payment-card.test.mjs test/payment-orchestration.test.mjs test/payment-task-store.test.mjs test/resource-api.test.mjs
```

Expected: new assertions fail for the current display-total fallback, post-confirm failure handling, task stage, and legacy route.

- [ ] **Step 3: Implement the protected boundary**

Extract a strict actual-amount reader that accepts only safe non-negative `invoice.amount_due`. Force promotion bypass for real payment and fail closed on any returned promotion marker. Obtain Sentinel before confirm. Persist `confirm_started` immediately before Stripe confirmation. Convert ambiguous exceptions at or after that stage into `unknown` results that retain locks. Keep authoritative declines as `failed`. Retire `/api/batch-pay` with HTTP 410.

- [ ] **Step 4: Verify GREEN**

Run the command from Step 2.

Expected: all tests pass.

### Task 6: Full verification and Docker runtime

**Files:**
- Modify only if verification exposes a regression.

- [ ] **Step 1: Run the complete automated suite**

Run:

```powershell
node --test test/*.test.mjs
node test/resource-ui.mjs
node test/status-panel-geometry.mjs
```

Expected: zero failures.

- [ ] **Step 2: Rebuild and restart Docker**

Run:

```powershell
docker compose up -d --build
docker compose ps
```

Expected: `dipay` is running on `127.0.0.1:3456`.

- [ ] **Step 3: Verify runtime source and health**

Compare local/container hashes for changed runtime files, call `/api/health`, inspect recent logs, and verify that no secret is printed.

- [ ] **Step 4: Browser smoke test**

Open `http://127.0.0.1:3456/`, verify the page loads, resource panels remain functional, solver status is accurate, and no real payment request is submitted.

- [ ] **Step 5: Non-billing network probe**

Use a controlled local challenge fixture or injected transport test to prove proxy propagation, challenge recognition, one solve, cookie replay, and typed failure without creating a checkout session or charge.
