# Payment Task and 3DS Design

## Goal

Make payment execution locally traceable and safe to resume: one user intent creates one payment task, 3DS is represented as a user-controlled pending state, and only verified settlement marks a task successful.

## Scope

- Replace credential-bearing GET payment submission with a POST task-creation endpoint.
- Persist a local task record with a stable task id and non-sensitive account/card labels.
- Reject a concurrent or repeated submission with the same idempotency key by returning the original task.
- Represent payment outcomes as `processing`, `pending_3ds`, `succeeded`, `failed`, or `unknown`.
- When the payment provider supplies a safe redirect URL for required customer authentication, expose it to the user; the user completes bank authentication themselves.
- Add a recheck endpoint that polls the existing checkout session and updates the same local task.
- Show the task, amount, currency, and action button in the UI task panel.

## Explicit safety rules

- The server never attempts to solve or bypass 3DS.
- `setup_intent.succeeded` alone is not a successful charge.
- A polling timeout remains `unknown`, not `failed`.
- Only a verified paid checkout/payment result becomes `succeeded`.
- Full PAN, CVC, session tokens and addresses are never written to task records or sent in a URL.

## Data flow

1. The page generates an idempotency key and POSTs the one-time payment input to `/api/payment-tasks`.
2. The server creates a local task immediately, runs the payment attempt, and emits task updates through SSE.
3. If authentication is required, the task becomes `pending_3ds` with a provider redirect URL when present.
4. The user opens that URL, completes bank authentication, then clicks recheck.
5. The server polls the existing checkout session and persists `succeeded`, `failed`, `pending_3ds`, or `unknown`.

## Testing

- Unit tests cover strict final card validation and payment-state classification.
- API tests cover POST-only task creation, idempotent task reuse, and redacted persisted task views.
- UI tests cover a pending-3DS task action and recheck state presentation.
