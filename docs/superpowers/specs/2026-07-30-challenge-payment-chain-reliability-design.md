# Challenge and Payment Chain Reliability Design

## Goal

Make the complete local workflow—from account import through confirmed payment—use one coherent network identity, distinguish Cloudflare failures from invalid credentials, and leave persisted account/card/address state correct after every terminal outcome.

## Preserved behavior

- Keep the current account TXT/JSON extraction and strict card/address parsing.
- Keep account plan detection before checkout.
- Keep the current request to bypass promotional checkout sessions, and fail closed when the provider still attaches a promotion, credit, discount, or trial.
- Use Stripe `invoice.amount_due` as the only payable amount and stop before confirmation when it is zero or missing. Display totals are never substituted.
- Keep 3DS user-controlled; the server does not attempt to solve or bypass bank authentication.
- Keep `unknown` payment results locked because releasing them could permit a duplicate charge.

## End-to-end data flow

1. The import endpoint parses a file and stores only recognized account credentials.
2. The account-status worker resolves a session token when required and checks the current entitlement.
3. A Cloudflare challenge failure becomes `account_status_check_failed`; only an actual authentication response becomes `invalid_account_credential`. A malformed entitlement response is never treated as free.
4. Single and batch entry points allocate a stable network slot and derive one effective proxy and TLS fingerprint from it.
5. The same effective proxy is used for token exchange, account checks, checkout creation, Sentinel, approval, Stripe calls, payment polling, and later task rechecks.
6. The challenge layer detects Cloudflare's `cf-mitigated: challenge` header, with the existing HTML/status heuristic retained as a compatibility fallback.
7. A challenge solver result is usable only when it contains `cf_clearance`. Failed or empty results are not cached.
8. Concurrent challenges with the same origin, proxy, and fingerprint share one in-flight solve attempt.
9. If challenge solving fails, a typed `cloudflare_challenge_failed` error propagates to the task boundary. The task becomes `failed` and its resources are released with the existing card cooldown.
10. A resource ID, when supplied, is authoritative: the server reloads that account, card, or address from the resource store instead of trusting a second client-supplied copy.
11. Real-time account status must be exactly `free`; `active`, `invalid`, `error`, `unknown`, and `pending` stop before checkout.
12. Stripe confirmation uses the provider-returned `invoice.amount_due`. The task records `confirm_started` before submission.
13. Once confirmation might have reached Stripe, non-authoritative exceptions become `unknown` and retain locks. Only a provider-declared decline or terminal cancellation becomes `failed`.
14. Confirmed success marks the account completed, increments card/address usage, and applies the card cooldown.
15. `pending_3ds` and genuinely `unknown` outcomes retain their locks. Recheck uses the original task network slot and releases resources only after confirmed success or a confirmed terminal failure.

## Components

### Network context

A small module owns effective proxy and fingerprint selection. Explicit task values win; otherwise the proxy falls back to `CF_PROXY` and then `HTTPS_PROXY`. Server-created tasks store only a numeric network slot, not proxy credentials.

### Challenge transport

`cffetch.py` returns status, response data, challenge state, and the effective fingerprint. Challenge detection checks `cf-mitigated` first and retains a narrow HTML fallback for providers that omit the header.

`browser.js` resolves the effective proxy before both the protocol request and solver call. It never returns an unresolved challenge as an ordinary provider response.

### Solver

The solver cache key contains origin, effective proxy, and fingerprint. Only a non-empty `cf_clearance` solution enters the cache, and only that cookie is replayed; browser login/session cookies are never copied. The ineffective headed retry is removed in the current Docker runtime; headless Chromium falls back directly to CapSolver.

### Account status

Authentication status and transport status are separate:

- 401 means invalid credentials.
- A provider 403 that is not identified as a Cloudflare challenge may remain invalid for compatibility.
- `cloudflare_challenge_failed`, timeouts, malformed provider responses, and network failures produce `account_status_check_failed`.
- A free result requires an explicit boolean subscription entitlement. Missing entitlement fields fail closed.
- Completed accounts are not downgraded by startup or delayed status checks.
- Startup checks run through a bounded worker pool rather than starting one network process per account.

### Payment tasks and resources

Task records privately persist `networkSlot`. Public task responses remain redacted. Solver-specific failures use the existing failed-task cleanup path. Unknown results remain locked and visible for manual recheck to avoid duplicate payment.

Task records also persist a private payment stage. Before `confirm_started`, an exception is a safe failure. At or after `confirm_started`, an exception without an authoritative provider result becomes `unknown`. The legacy `/api/batch-pay` route is retired so every charge goes through task idempotency and resource locking.

Batch reservation failure is bounded and classified by resource kind. An account conflict stops that account, a card conflict advances to another card, and an unavailable persisted address falls back to a temporary address. The loop cannot create an unbounded series of failed task files.

## Error handling

- `cloudflare_challenge_failed`: task failed, resources released, safe error code shown.
- `invalid_account_credential`: account marked invalid only after an authentication response or token-exchange proof.
- `zero_amount_offer`: amount recorded as zero, payment confirmation not called, resources released.
- `insufficient_funds`: card paused, account/address released, next card may be selected.
- `pending_3ds`: resources stay locked until recheck.
- `unknown`: resources stay locked until provider state is resolved.
- post-confirm transport error: task becomes `unknown`, never `failed`.
- attached promotion/credit/trial: stop before creating or confirming a payment method.

## Testing

- Unit tests cover effective proxy selection and challenge classification.
- Transport tests use injected local functions to prove the same proxy reaches the protocol request and solver without external network access.
- Solver tests prove failed/empty solutions are not cached and concurrent solves coalesce.
- Account-status tests prove challenge failures never become invalid credentials.
- Task-store tests prove the network slot is persisted internally and omitted publicly.
- API tests prove single tasks receive slot zero and rechecks use the stored slot.
- Payment orchestration tests prove post-confirm exceptions remain unknown and locked, while explicit declines fail and release.
- API tests prove resource IDs are bound to server-side data and the legacy unprotected batch-pay route returns 410.
- Amount tests prove missing `invoice.amount_due` never falls back to a display total.
- Existing card parsing, zero-amount, resource locking, batch allocation, 3DS, success-history, and UI tests remain green.
- Docker is rebuilt only after the complete local test suite passes.

## Scope exclusions

- No changes to plan identifiers or package pricing.
- No attempt to force, guess, or synthesize a non-zero provider amount.
- No automatic 3DS completion.
- No broad replacement of `curl_cffi`, Playwright, Stripe, or the resource store.
- No automatic release of genuinely unknown payments.
