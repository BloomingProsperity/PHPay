# 3DS Account-Tier Observer Design

## Goal

Add a dedicated, persistent 3DS handoff module that lets the user complete bank authentication manually while the server determines completion only by re-reading the account's subscription tier through the existing account-status chain.

This design supersedes the old pending-3DS UI behavior that asked the user to manually recheck Stripe or the checkout session.

## Explicitly out of scope

- TLS fingerprint selection or rotation;
- proxy/fingerprint coordination;
- challenge-solver or Cloudflare behavior;
- any change to the existing TLS fingerprint, browser-challenge, or anti-bot chain.

The implementation may add proxy configuration and selection in `src/server.js`, but must preserve fingerprint assignment and challenge behavior byte-for-byte unless an unrelated compile error makes that impossible; such a conflict must be reported instead of being silently changed.

## Confirmed product rules

- The server never attempts to solve, bypass, or automate 3DS.
- When the provider returns a safe 3DS redirect URL, the server persists it and shows it in a dedicated UI module.
- The user opens the URL and completes the issuer challenge manually.
- A pending-3DS task does not poll Stripe and does not resubmit, confirm, approve, or retry payment.
- The account tier is the completion signal.
- The first post-3DS account-tier query runs two minutes after 3DS is detected.
- If the tier has not changed, subsequent account-tier queries run every twenty-five seconds.
- Only the account associated with an active pending-3DS task is polled; the whole account library is never scanned on an interval.
- A task succeeds when the current normalized account tier equals the task's selected target tier and differs from the recorded pre-payment tier.
- An account already on the selected target tier is rejected before payment begins.
- Account, card, and address resources remain locked while the task is pending 3DS.
- Successful completion releases resources through the existing success path and keeps the card's existing 30-second cooldown.
- Browser refresh and server restart must preserve the pending task and resume its schedule without triggering another payment request.

## End-to-end flow

1. The existing account-status detector reads and normalizes the account's current tier before payment.
2. The server saves this value as the task's immutable `accountPlanBefore`.
3. The preflight rejects the task if `accountPlanBefore` already equals the selected target `plan`.
4. The normal payment attempt continues.
5. If the provider returns `requires_action`, the server:
   - persists `pending_3ds`;
   - stores only the safe HTTPS verification URL;
   - records `threeDsDetectedAt`;
   - sets `nextAccountCheckAt` to two minutes later;
   - records one idempotent 3DS event against the card;
   - keeps all resources locked.
6. The UI restores the task in the dedicated 3DS module and shows the first-check countdown.
7. The user opens the verification URL and completes the issuer challenge manually.
8. When `nextAccountCheckAt` arrives, the server calls the same shared account-status detector used by account import and payment preflight.
9. If the current tier is not the target tier, the server records the observation and schedules the next check twenty-five seconds later.
10. If the current tier equals the target tier and differs from `accountPlanBefore`, the server:
    - marks the task `succeeded`;
    - records `completionSource: account_tier_after_3ds`;
    - marks the account payment as completed through 3DS;
    - records a successful card use;
    - releases the resources with the normal card cooldown.

No Stripe status polling occurs between steps 5 and 10.

## Shared account-status chain

There must be one source of truth for account tier detection:

```text
stored account credential
  -> resolve token
  -> fetch account status
  -> normalize provider tier
  -> persist account observation
```

The following consumers reuse that chain:

- account import: initial informational status;
- payment preflight: `accountPlanBefore` and same-target rejection;
- pending 3DS observer: post-authentication tier checks.

The observer must reuse the existing per-account in-flight guard so import checks and 3DS checks cannot query the same account concurrently.

## Plan normalization and comparison

Both the selected plan and provider response must be normalized to the same canonical plan identifiers before comparison:

- `chatgptfreeplan`
- `chatgptplusplan`
- `chatgptgoplan`
- `chatgptprolite`
- `chatgptpro`
- `chatgptteamplan`

Unknown provider values remain observable but cannot satisfy a target-plan comparison.

The completion predicate is:

```text
currentPlan === targetPlan
AND currentPlan !== accountPlanBefore
```

Transient network, throttling, challenge, and provider errors do not mark the payment failed. They leave the task pending and schedule another account check in twenty-five seconds. An invalid account credential stops automatic polling and exposes a safe actionable error in the UI while keeping the task record.

## Persistent payment-task fields

Extend the internal payment task with:

- `accountPlanBefore`
- `accountPlanCurrent`
- `threeDsDetectedAt`
- `firstAccountCheckAt`
- `lastAccountCheckAt`
- `nextAccountCheckAt`
- `accountCheckErrorCode`
- `completionSource`
- `threeDsCompletedAt`

The redacted public task view may expose these non-sensitive status fields. It must not expose resource ids, tokens, full card data, CVC, address data, checkout secrets, or processor credentials.

`plan` remains the selected target plan.

## Observer lifecycle

Use one server-side scheduler for pending-3DS account observations.

- Register a task when it first becomes `pending_3ds`.
- On server startup, load all persisted `pending_3ds` tasks and register them again.
- Derive the next delay from persisted timestamps; do not reset the two-minute delay after a restart.
- Before every query, reload the internal task and confirm it is still `pending_3ds`.
- Do not schedule overlapping checks for the same task or account.
- Stop scheduling when the task succeeds or the credential becomes invalid.
- Never call the payment creation, confirmation, approval, or Stripe polling functions from the observer.

## Card usage ledger

Each card keeps a local idempotent per-task usage ledger. Public views expose only derived counts and tags.

Events:

- `submittedAt`: written once when the card reaches the real payment-confirmation submission stage;
- `threeDsAt`: written once when that submitted payment returns a 3DS requirement;
- `succeededAt`: written once when the target account tier is observed.

Derived public fields:

- `attemptCount`: number of distinct submitted payment tasks;
- `successCount`: number of distinct tasks completed by account-tier observation or the existing verified success path;
- `threeDsCount`: number of distinct tasks that triggered 3DS;
- `hasThreeDs`: true when `threeDsCount > 0`.

Selecting or previewing a card does not increase `attemptCount`. Repeated callbacks, retries, process recovery, and page refreshes must not double-count any event.

When a 3DS task succeeds:

- the task is tagged `3DS 完成`;
- the account payment metadata records `via3ds: true`;
- the card permanently displays `触发过 3DS`;
- the card's `successCount` increases exactly once.

## UI design

### Right-side layout

The existing “验证服务” settings remain fully expanded. The collapse toggle and hidden-state behavior are removed.

A new “3DS 手动验证” panel sits directly below it in the same right column. The panel is always visible; its empty state is compact.

### Network proxy settings and import

The expanded validation-service card includes a lower “网络代理” subsection. It makes the already-supported backend proxy configuration usable without editing Docker environment variables.

Controls:

- multiline proxy input, one proxy per line;
- “导入代理” button that opens the standard modal/drawer file picker;
- `.txt` and `.csv` file support;
- “测试连接”, “保存设置”, and “清空” actions;
- per-proxy remove action;
- visible valid, duplicate, invalid, and saved counts;
- masked saved values and configuration-source status.

Accepted input forms:

- `http://user:pass@host:port`
- `https://user:pass@host:port`
- `host:port:user:pass`, normalized to an HTTP proxy URL
- `host:port`, normalized to an HTTP proxy URL

Parsing trims blank lines, validates the complete entry, and removes duplicates. Invalid rows are excluded and reported. Only HTTP and HTTPS proxies are accepted because those are the schemes already supported consistently by the current request chain.

The browser reads imported files locally and submits only the normalized proxy list. Passwords are never returned in clear text by status/list endpoints.

Runtime precedence:

1. non-empty `PROXY_POOL` environment variable;
2. locally saved UI proxy list;
3. `CF_PROXY`;
4. `HTTPS_PROXY`;
5. direct connection.

Single-payment tasks use the first available configured proxy. Concurrent/batch task slots use round-robin selection. A task persists its selected slot and continues using that slot for account checks, payment calls, and later 3DS account-tier observation. Saving a new list affects only newly created tasks and never changes an active task's bound proxy.

The saved proxy list lives in a local ignored/runtime configuration file with restrictive permissions. The UI can test a candidate proxy through a dedicated bounded server endpoint; automated tests inject the outbound request and never use a real external service.

### Validation-service configuration import and clear

The always-expanded validation-service card keeps its existing Key and browser URL inputs and adds explicit configuration management:

- “导入配置” opens the shared file modal and accepts `.json` and `.txt`;
- JSON accepts `{ "apiKey": "...", "browserWs": "ws://..." }`;
- text accepts `SOLVER_API_KEY=...`, `BROWSER_WS_ENDPOINT=...`, a `CAP-...` key line, and a `ws://`/`wss://` URL line;
- import produces a preview and does not save until the user confirms;
- “清除 Key”, “清除 URL”, and “全部清除” are explicit destructive actions with confirmation;
- environment-owned values are marked as Docker-managed and their corresponding clear controls are disabled;
- saved secrets are masked, never returned in clear text, and written atomically with restrictive permissions.

These controls change configuration storage only. They do not change solver, TLS fingerprint, challenge, or browser behavior.

### Task-log retention and manual clear

The live log surface remains a current-task view and is replaced when a new task starts. Persisted task records are the durable history.

Manual history actions are separated:

- clear succeeded;
- clear failed;
- clear all terminal records.

`processing`, `pending_3ds`, `completing_3ds`, and `unknown` are protected from bulk deletion. Clearing task history never deletes account, card, address, or their usage/3DS metadata.

Automatic destructive deletion remains disabled until a retention period is explicitly approved. The UI may limit rendered history without deleting persisted files.

### User list and detail modal

The 3DS panel stays visually compact. Its “待验证” and “最近完成” groups list users by email only, with at most a small state dot/tag beside the email.

Clicking an email opens the shared modal with:

- account email, pre-payment tier, current tier, and selected target tier;
- actual amount and currency when known;
- first-check countdown or next-check countdown;
- last account-check time and safe account-check error;
- “打开验证链接” primary action;
- “复制链接” secondary action;
- linked card: masked last four digits, cardholder label when safely available, use count, success count, 3DS count, current availability state, and 3DS badge.

The public API and modal never expose full PAN or CVC. A completed 3DS entry remains inspectable, but its verification action is disabled/marked complete so the UI does not encourage duplicate action.

The panel/modal does not include a button that resubmits payment or polls Stripe.

Suggested status copy:

- `等待手动验证`
- `首次检测将在 01:42 后开始`
- `正在检测账号等级`
- `验证可能已完成，等待套餐生效`
- `已通过 3DS 完成`
- `账号凭证已失效，已停止检测`

### Card library rows

Every card row shows:

```text
•••• 3276
使用 5 次 · 成功 3 次 · 3DS 1 次
[触发过 3DS]
```

The 3DS badge appears only when `hasThreeDs` is true. Counts remain visible for available, in-use, cooling, and insufficient-funds cards.

### Completed entries

The 3DS module contains “待验证” and “最近完成” email lists. Once the target tier is observed, the user leaves “待验证” and moves to “最近完成”. Clicking either list still opens the linked account/card detail modal. The completed task also appears in the existing payment-success list with a `3DS 完成` tag. Historical card and account tags remain visible in their resource dialogs.

### Front-end regression audit

The implementation includes a full front-end pass, not only the new panel:

- remove obsolete hidden duplicate resource-import controls that are no longer part of the active UI;
- verify unique DOM ids and one active event binding per control;
- verify the plan picker, account/card/address import drawers, resource selection dialogs, per-item delete, clear actions, payment controls, validation-service controls, task status, success list, and 3DS links;
- keep the main execution card, right-side cards, and bottom task/success panels aligned at the existing desktop breakpoint;
- verify compact responsive behavior without clipped controls or mismatched card heights;
- exercise side-effecting buttons only with intercepted local APIs.

## API behavior

- The existing task-list endpoint remains the source for restoring pending and completed task views.
- The server performs automatic account-tier observation; the browser only refreshes redacted task data.
- The old pending-3DS “recheck payment” UI action is removed.
- The old recheck endpoint may remain for non-3DS diagnostic compatibility, but the 3DS module must never call it and the endpoint must not be scheduled automatically for pending-3DS tasks.
- `GET /api/proxy-config` returns only source, counts, ids, and masked proxy labels.
- `PUT /api/proxy-config` validates, deduplicates, and atomically saves a complete replacement proxy list.
- `POST /api/proxy-config/test` accepts one normalized candidate and returns a bounded success/error result without echoing credentials.
- Environment-owned `PROXY_POOL` is reported as locked/authoritative and cannot be overwritten through the UI.

## Error handling

- Unsafe or missing verification URL: keep the task pending and show that no safe link was supplied; never render a non-HTTPS link.
- Temporary account-status error: persist a safe error code and retry after twenty-five seconds.
- Invalid credential: stop the observer, keep resources locked for explicit user resolution, and show the credential error.
- Server restart: resume from persisted timestamps.
- Account removed while pending: stop observation, preserve the task, and show `selected account resource not found`.
- Tier differs from both the baseline and target: display the observed tier but do not mark success.

## Testing constraints and coverage

All verification is local, mocked, intercepted, or static. No test may execute a real payment or contact a real account-status endpoint.

Required coverage:

- task persistence and public redaction for the new fields;
- two-minute first-query scheduling;
- twenty-five-second subsequent scheduling;
- restart recovery without resetting timestamps;
- exact target-tier completion;
- same-target preflight rejection;
- transient error retry and invalid-credential stop;
- no calls to Stripe polling, payment confirmation, approval, or submission from the observer;
- idempotent card attempt, success, and 3DS counters;
- persistent 3DS account/card tags;
- dedicated module rendering and empty state;
- expanded validation-service layout;
- browser refresh restoring pending entries;
- completed entries moving into the success list;
- pending and completed 3DS groups rendering email-only rows that open the account/card detail modal;
- card rows showing all three counts and the 3DS badge.
- no duplicate ids, duplicate handlers, dead active controls, layout mismatch, or broken affected-page buttons.
- proxy parser coverage for every accepted format, invalid-row exclusion, and deduplication;
- proxy config secret redaction, environment precedence, atomic save, per-task slot stability, and round-robin selection;
- proxy import drawer, remove, clear, save, and intercepted connection-test controls.
- validation configuration JSON/TXT import, preview, explicit Key/URL/all clear, environment locks, and secret redaction;
- manual task-history clear categories protecting active, 3DS, completing, and unknown tasks.
