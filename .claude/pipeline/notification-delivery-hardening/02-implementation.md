# Implementation — Notification delivery hardening

## Summary of changes

### `lib/notifications.ts`
- Threaded `notificationPrefs` enforcement into all 8 previously-unfiltered check functions, per the plan's function-by-function mapping:
  - **`checkBudgetOverspend(period)`** — replaced the flat `if (summary.percentUsed < 80) continue;` gate with a per-budget `eligibleUserIds` computation: a user is excluded if `overspend.enabled === false`, otherwise included only if `percentUsed >= (threshold ?? 80)`. `continue`s before the `scopeKey`/dedup check when nobody's eligible.
  - **`checkBudgetPace(period)`** — after the existing `evaluation.fire` gate, filters users by `budget_pace.enabled !== false` (boolean-only, no threshold — matches `evaluateBudgetPace`'s own fire logic).
  - **`checkLowBalance()`** — fetches `users` once at the top; the `$15` minimum-balance-fee `Transaction`/`TransactionTag`/GL-assignment block is untouched and still fires unconditionally off the account's real balance state; only the breach-warning `createNotification` call at the bottom is gated by `low_balance.enabled !== false`.
  - **`checkAccrualShortfall()`** — boolean-only batch-filter on `accrual_shortfall.enabled`.
  - **`checkBillReminders()`** — kept the `daysUntil < 0` guard as an unconditional top-of-loop continue; dropped the hardcoded `daysUntil > 3` upper bound in favor of a per-user `daysAhead` (default 3) comparison, gated by `bill_due.enabled`.
  - **`checkAnomalies(period)`** — replaced the hardcoded `current.lessThanOrEqualTo(avg.times(1.5))` early-exit with a per-user `multiplier` (default 1.5) comparison using `Decimal.greaterThan`/`.times()` (not raw `>`), gated by `anomaly.enabled`.
  - **`checkCardPaymentsDue()`** — `eligibleUserIds` computed once (batch-filter, boolean-only) from the new `cc_payment_due` key, reused for both the standard `cc_payment_due` reminder and the `cc_payment_overdue` escalation branches (confirmed by reading the function: same per-card loop, mutually exclusive branches on one underlying due-date check).
  - **`checkCcFundingShortfall()`** — single-account function; `eligibleUserIds` computed and checked right after the `result.status === "covered"` short-circuit and before building the title/body, gated by the new `cc_funding_shortfall` key.
- Deleted the now-fully-unused `getAllUserIds()` helper — confirmed via repo-wide grep it has no remaining call sites (`checkDocumentExpiry` and `checkLargeSpend` already fetched `notificationPrefs` directly and never used it).
- No notification wording, scopeKey formats, dedup logic, or business-condition thresholds (the *default* 80/3/1.5 values) were changed — only *who receives* each already-computed notification.

### `actions/notifications.ts`
- Added three new optional `prefsSchema` keys, each `{ enabled: z.boolean() }` (no threshold — none of the three has a real user-tunable numeric knob): `budget_pace`, `cc_payment_due`, `cc_funding_shortfall`. `cc_payment_due` is shared by both the `cc_payment_due` and `cc_payment_overdue` notification types per the plan's judgment call (confirmed by reading `checkCardPaymentsDue`).
- No changes needed to `getNotifPrefs`/`updateNotifPrefs` — both already work generically off `prefsSchema.parse(...)`.

### `components/notifications/notif-prefs-form.tsx`
- Added three entries to `PREF_TYPES` (`budget_pace`, `cc_payment_due`, `cc_funding_shortfall`), same boolean-only toggle style as `low_balance`/`accrual_shortfall`/`policy_expiry`. No new input blocks needed since none of the three has a threshold field. No other component logic changed — the existing render loop, `setEnabled`, and save flow work generically.

### `lib/web-push.ts`
- `sendPushToUser`'s `.catch()` block now actually does what its old comment claimed: on `err instanceof webpush.WebPushError && (err.statusCode === 404 || err.statusCode === 410)`, deletes the matching `PushSubscription` row by `endpoint` (wrapped in its own `.catch(() => {})` to tolerate a race with `dispatchPending`'s safety-net sweep hitting the same dead endpoint). Any other error (network blip, 5xx, non-`WebPushError`) is left alone. Replaced the stale "endpoint cleanup happens on 410" comment with an accurate description.

### `lib/__tests__/notifications.test.ts`
- Extended the shared `vi.mock("@/lib/db", ...)` factory with `transaction: { findFirst, create }`, `entity: { findFirst }`, `transactionTag: { create }`, and `tag.findFirst`/`tag.create` (needed for `checkLowBalance`'s fee-creation test path), plus `vi.mock("@/lib/gl-code-resolver", () => ({ autoAssignGlCodes: vi.fn() }))`.
- Changed the default `mockDb.user.findMany` fixture to include `notificationPrefs: null` on both default users (harmless — matches the real DB's nullable JSON column — and required so new prefs-reading code has a defined shape to read from in tests that don't override it).
- Added a `userIdsFromCreateCall()` helper to pull `userIds` out of a `notification.create` mock call.
- Added new test cases per the plan's Test expectations, one `describe` block extension per already-covered function:
  - `checkBudgetOverspend`: opted-out user excluded; per-user custom `threshold` respected; edge case (all opted out / all thresholds unmet) → `notification.create` not called.
  - `checkLowBalance`: opted-out user excluded from the notification (breach case, no fee); the `$15` fee-transaction path still fires when *every* user is opted out of the notification (`db.transaction.create` called once, `db.notification.create` not called).
  - `checkAccrualShortfall`: opted-out user excluded; edge case (all opted out) → no notification.
  - `checkBillReminders`: opted-out user excluded; per-user custom `daysAhead` respected; edge case (all users' `daysAhead` unmet) → no notification.
  - `checkAnomalies`: opted-out user excluded; per-user custom `multiplier` respected; edge case (all unmet/opted out) → no notification.
  - Per the plan's explicit scope boundary, no new tests were added for `checkBudgetPace`, `checkCardPaymentsDue`, or `checkCcFundingShortfall` (pure-decision-module precedent — their prefs-gating is identical in shape to `checkAccrualShortfall`'s already-tested boolean-only pattern, and they wrap separately-unit-tested pure modules).

### `lib/__tests__/web-push.test.ts` (new file)
- Covers the 5 cases from the plan: `sendNotification` rejecting with a 410/404 `WebPushError` → `pushSubscription.delete` called once with `{ where: { endpoint } }`; rejecting with a 500 `WebPushError` → not called; rejecting with a non-`WebPushError` (plain `Error`) → not called; resolving successfully → not called, no throw.
- Mocking approach deviates slightly from the plan's suggested `vi.mock("web-push", ...)` + `vi.spyOn` — see Deviations below.

## Deviations from the plan

- **Web-push test mocking mechanism.** The plan suggested either `vi.mock("web-push", ...)` with the real `WebPushError` spliced in, or a hand-built mock class with a manually-wired prototype chain, and separately flagged that `vi.spyOn` might need care. In practice, `vi.spyOn(webpush, "sendNotification")` (and every typed variant of it, including casting to a narrower interface) hit a TypeScript constraint error: `@types/web-push` has no explicit `export default`, so under `esModuleInterop` the synthetic default-import type TypeScript infers for `import webpush from "web-push"` does not expose its function members (`sendNotification`, `setVapidDetails`, etc.) to `vi.spyOn`'s generic key-inference machinery — only the three non-overloaded value exports (`WebPushError`, `supportedContentEncodings`, `supportedUrgency`) satisfied the generic constraint, even after re-declaring a local interface with an explicit `sendNotification: typeof webpush.sendNotification` field. Rather than fight the type inference further or reach for `any` (disallowed by CLAUDE.md), the test instead imports the **real, unmocked** `web-push` module (so `WebPushError` is the genuine class — `instanceof` works with zero fixture risk) and directly overwrites the `sendNotification` property on the shared module object with a plain `vi.fn()`, restoring the original in `afterAll`. This achieves the same effect the plan wanted (mock only `sendNotification`, keep the real `WebPushError`) without the TS friction. Functionally equivalent; flagging since it's not literally the mechanism the plan named.
- Everything else matches the plan as written — no other deviations.

## Commands run and their results

- `pnpm typecheck` (`tsc --noEmit`) — clean, no errors.
- `pnpm lint` — 0 errors, 43 warnings, all pre-existing and in files this task didn't touch (confirmed by grepping the output for `notifications.ts`, `web-push.ts`, `notif-prefs-form.tsx` — none appear). Consistent with this repo's known ~45-pre-existing-warnings baseline (see coder memory `commands.md`).
- `pnpm test` (`vitest run`, full suite) — **453/453 passed across 38 files** (up from a starting point I did not capture a clean baseline for since `git status` at task start already showed other uncommitted pipeline folders from concurrent/prior sessions, not this repo's test files — the notifications/web-push test files are the only test-relevant diff here). Added 1 new test file (`lib/__tests__/web-push.test.ts`, 5 tests) and 17 new test cases inside the existing `lib/__tests__/notifications.test.ts` (5 existing tests untouched, +17 new = 22 tests in that file).

## Open items

- None outstanding from this task's scope. The plan's own flagged-but-out-of-scope items (no UI for `bill_due.daysAhead`/`anomaly.multiplier` number inputs; `cc_payment_due`/`cc_payment_overdue` sharing one preference key; the same-cron-run eligibility-snapshot granularity limit) were deliberately not addressed, per the plan's explicit scope boundary — they're pre-existing gaps or accepted design limits, not regressions introduced here.
- The `email` notification channel remains fully untouched, as required (`channel: "in_app"` literal in `createNotification` unchanged).
