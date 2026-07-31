# Account Detection, Safe Retry, and Hidden Fingerprint UI Design

## Goal

Make pasted account credentials a deliberate one-click detection-and-import flow,
remove the fingerprint-library card from the visible UI while preserving its runtime
integration, and make the backend the only authority for automatic payment retries.

## Scope

This change covers four related problems:

1. The account session textarea does not currently affect the account-library count.
2. The frontend duplicates retry classification and can diverge from the backend.
3. Address or proxy failures can incorrectly make a usable card enter cooldown.
4. The configured fingerprint library is visually noisy and should not be shown.

The obsolete `ISSUES.md` N-4 multi-country note is removed. No country, address,
proxy, TLS, Cloudflare, or real-payment behavior is added by deleting that note.

## Account detection and import

Add a single `检测并入库` button beside the account input status. The browser sends
the textarea text to a dedicated account detection endpoint.

The endpoint:

- reuses the existing account text extractor;
- accepts session JSON, access tokens, session tokens, and mixed surrounding text;
- adds structurally valid candidates to the deployment-local account store;
- runs the existing account-status detector before returning;
- removes a newly added invalid candidate instead of leaving it in the library;
- refreshes a duplicate account's status without increasing the library count;
- returns only resource IDs, email labels, safe account state, plan, and safe errors.

For one recognized account, the UI selects that account for the current single
operation. For multiple recognized accounts, all valid accounts enter the library
but no arbitrary account is silently selected. The top count refreshes after the
request completes.

## Backend-authoritative retry action

The public payment-task representation includes a derived `retryAction` produced by
the existing backend `paymentFailureAction()` function. It is never accepted from
the client and is never stored as payment-provider state.

The browser removes its duplicate decision table and follows only:

- `next_card`
- `next_address`
- `next_proxy`
- `reconcile`
- `stop`

Unknown, 3DS, authentication-required, and non-authoritative post-confirm outcomes
remain non-resubmittable.

## Resource release policy

The backend derives card handling from the authoritative retry action:

- `insufficient_funds`: mark the card blocked and release account/address.
- `next_card`: release the card with the existing 30-second cooldown.
- `next_address` or `next_proxy`: release the card immediately without cooldown.
- `stop` before confirmation: release without card cooldown.
- `reconcile`: keep account, card, address, proxy, and fingerprint held.
- success: record paid usage and apply the existing 30-second cooldown.

This policy applies consistently to initial execution and manual reconciliation
transitions.

## Fingerprint integration and UI

The fingerprint runtime remains enabled:

- `src/fprints.js` supplies the ordered 16-profile pool.
- `src/fingerprint-provider.js` assigns profiles with soft leases.
- `src/network-context.js` passes supported pool members through.
- solver cache keys continue to include the fingerprint.

Remove the fingerprint card, its client fetch, management popup, CSS, and fingerprint
labels from task logs. Keep the backend provider endpoint and safe task metadata for
diagnostics and future integration tests.

## Verification

All tests are local, mocked, or use disabled payment execution. No test may call a
real account or submit a real payment.

Focused verification covers:

- pasted account detection, valid import, duplicate refresh, and invalid rejection;
- backend-derived public `retryAction`;
- no card cooldown on address/proxy failures;
- cooldown or blocking on explicit card failures;
- 3DS/unknown never entering an automatic retry branch;
- the fingerprint runtime remaining ordered and passed through;
- the fingerprint UI being absent;
- the N-4 multi-country issue text being absent.

