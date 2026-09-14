# Plan — Notification delivery hardening

## Restated goal

Two real bugs in the household notification system: (1) 8 of `lib/notifications.ts`'s 10 `checkXxx()` cron functions notify every user regardless of their `notificationPrefs` settings, and (2) `lib/web-push.ts#sendPushToUser` never actually deletes dead push subscriptions despite a comment claiming it does. Fix both so a user's notification settings page actually controls what they receive, and dead subscriptions stop being retried forever.

## Scope

**In scope:**
- Thread `notificationPrefs` enforcement into the 8 check functions that currently ignore it: `checkBudgetOverspend`, `checkBudgetPace`, `checkLowBalance`, `checkAccrualShortfall`, `checkBillReminders`, `checkAnomalies`, `checkCardPaymentsDue`, `checkCcFundingShortfall`.
- Add 3 missing `prefsSchema` entries (`budget_pace`, `cc_payment_due`, `cc_funding_shortfall`) in `actions/notifications.ts` so those types are actually storable/toggleable.
- Add corresponding UI toggles to `components/notifications/notif-prefs-form.tsx`.
- Fix `lib/web-push.ts#sendPushToUser` to delete the `PushSubscription` row on a confirmed-gone (404/410) push failure, and leave it alone on any other error.
- Unit tests for all of the above, following existing patterns in `lib/__tests__/notifications.test.ts` (new `describe` blocks for the pattern-eligible functions only — see Risks below for which check functions are and aren't unit-testable under this repo's existing precedent) and a new `lib/__tests__/web-push.test.ts`.

**Out of scope (explicit):**
- The `email` notification channel — stays declared-but-unused. Do not build email delivery.
- Adding any new notification type, changing notification wording/body text, or changing when a check function's underlying business condition "fires" (e.g. the 80%-used overspend line, the 1.5× anomaly multiplier default, the 3-day bill window) — only *who receives* the already-computed notification changes.
- Adding UI number-input controls for `bill_due`'s `daysAhead` or `anomaly`'s `multiplier` fields. Those schema fields already exist today but have no matching UI control in `notif-prefs-form.tsx` (only `overspend.threshold` and `large_spend.thresholdCents` have inputs) — that gap predates this task and fixing it isn't required to satisfy the "respect prefs" bug; flagged below as a recommendation, not undertaken here.
- Removing/renaming any existing notification type string, `TYPE_META` entries, or the `Notification`/`NotificationUser` split.
- Any ClawBox or PWA work (separate Tier 4 items).

## Affected files/modules

- `lib/notifications.ts` — the 8 check functions listed above, plus removal of the now-fully-unused `getAllUserIds()` helper (confirmed via repo-wide grep: only these 8 call sites use it; the other 2 functions already fetch `notificationPrefs` directly).
- `actions/notifications.ts` — `prefsSchema` (add 3 keys).
- `components/notifications/notif-prefs-form.tsx` — `PREF_TYPES` array (add 3 entries, enabled-only toggles, same style as existing rows).
- `lib/web-push.ts` — `sendPushToUser`'s catch block.
- `lib/__tests__/notifications.test.ts` — new test coverage (additive, following the existing mock setup).
- `lib/__tests__/web-push.test.ts` — new file.

No Prisma schema changes needed: `notificationPrefs` is already `Json @default("{}")` on `User`, `Notification.type` is a plain `String` (not an enum — new type strings never need a migration, though this task adds no new types), and `PushSubscription.endpoint` is already `@unique`, making it a safe delete key.

## Approach

### Part A — Prefs enforcement in `lib/notifications.ts`

Two established patterns already exist in this file; each function keeps whichever fits its existing loop shape (per CLAUDE.md: don't force one pattern onto a function shaped for the other):

- **Batch-filter pattern** (`checkDocumentExpiry`): fetch `db.user.findMany({ select: { id: true, notificationPrefs: true } })` once at the top, then per notification-worthy item, filter `users` down to an `eligibleUserIds` array and pass that (not the full user list) into `createNotification`.
- **Per-user-threshold-loop pattern** (`checkLargeSpend`): only needed when a per-user *numeric* threshold gates which underlying events qualify at all (not just whether the user sees them).

Function-by-function plan:

1. **`checkBudgetOverspend(period)`** — `overspend: { enabled, threshold: 1-100 }` already exists in schema. Replace `db.user.findMany` via `getAllUserIds()` with `findMany({ select: { id, notificationPrefs } })`. Remove the flat `if (summary.percentUsed < 80) continue;` gate. Instead, per budget, compute `eligibleUserIds = users.filter(u => { const p = prefs["overspend"]; if (p?.enabled === false) return false; const threshold = p?.threshold ?? 80; return summary.percentUsed >= threshold; }).map(u => u.id)`. If `eligibleUserIds.length === 0`, `continue` (skip scopeKey/dedup check and creation entirely — no behavior change for a budget nobody cares about). Otherwise proceed with existing `scopeKey`/`alreadyNotifiedToday`/message-building logic unchanged, and call `createNotification({ ..., userIds: eligibleUserIds })`.
2. **`checkBudgetPace(period)`** — no schema key exists yet; add `budget_pace: { enabled }` in Part B. This function's `evaluation.fire` boolean already encapsulates all the "should this fire" business logic (from `evaluateBudgetPace`) — there's no per-user tunable here. Use the batch-filter pattern: fetch users+prefs once, and after `if (!evaluation.fire) continue;`, compute `eligibleUserIds = users.filter(u => prefs["budget_pace"]?.enabled !== false).map(u => u.id)`; if empty, `continue`; else pass `eligibleUserIds` to `createNotification`.
3. **`checkLowBalance()`** — `low_balance: { enabled }` already exists. Batch-filter pattern: fetch users+prefs once. **Important:** the `$15` minimum-balance-fee `Transaction`/`TransactionTag`/GL-assignment block (lines ~296–342) is not a notification — it's a real financial record — and must keep firing unconditionally regardless of any user's `low_balance` preference; only the `createNotification` call at the bottom of the loop (breach warning) gets prefs-gated via `eligibleUserIds`.
4. **`checkAccrualShortfall()`** — `accrual_shortfall: { enabled }` already exists. Straightforward batch-filter (boolean-only, no threshold).
5. **`checkBillReminders()`** — `bill_due: { enabled, daysAhead: 1-14 }` already exists. Keep the existing `if (daysUntil < 0 || daysUntil > 3) continue;` line's `daysUntil < 0` half as-is (an already-past due date is never worth reminding about, unrelated to prefs) but drop the hardcoded `daysUntil > 3` upper bound; replace with per-user filtering: `eligibleUserIds = users.filter(u => { const p = prefs["bill_due"]; if (p?.enabled === false) return false; const daysAhead = p?.daysAhead ?? 3; return daysUntil <= daysAhead; }).map(u => u.id)` (keep the `daysUntil < 0` continue as an unconditional top-of-loop guard first). If empty, `continue`.
6. **`checkAnomalies(period)`** — `anomaly: { enabled, multiplier: >=1.1 }` already exists. Replace the hardcoded `current.lessThanOrEqualTo(avg.times(1.5))` gate the same way: per-row, compute `eligibleUserIds = users.filter(u => { const p = prefs["anomaly"]; if (p?.enabled === false) return false; const multiplier = p?.multiplier ?? 1.5; return current.greaterThan(avg.times(multiplier)); }).map(u => u.id)`. If empty, `continue`.
7. **`checkCardPaymentsDue()`** — no schema key yet; add `cc_payment_due: { enabled }` in Part B, shared by both the standard reminder (`type: "cc_payment_due"`) and the overdue escalation (`type: "cc_payment_overdue"`) branches — confirmed by reading the function: both are two severities of the same per-card due-date check (mutually exclusive per card per day), not independent conditions, so one toggle covers both. Batch-filter: fetch users+prefs once at the top, compute `eligibleUserIds = users.filter(u => prefs["cc_payment_due"]?.enabled !== false).map(u => u.id)` once, reuse it for both branches' `createNotification` calls; if empty, skip both branches for that card (still evaluate other cards).
8. **`checkCcFundingShortfall()`** — no schema key yet; add `cc_funding_shortfall: { enabled }` in Part B. Single-account function (not a loop) — batch-filter: fetch users+prefs, compute `eligibleUserIds`; if empty, `return 0` at the same point the existing `if (result.status === "covered") return 0;` short-circuit sits (after computing `result`, before building the message — no need to build `title`/`body` for nobody).

After all 8 are converted, delete the now-unused `getAllUserIds()` helper (lines ~34–37) — verified via repo-wide grep it has no other call sites.

### Part B — `prefsSchema` additions (`actions/notifications.ts`)

Add three new optional keys, boolean-`enabled`-only (no threshold — none of the three has an existing user-tunable numeric knob worth exposing, per the request's own guidance not to force one):

```ts
budget_pace: z.object({ enabled: z.boolean() }).optional(),
cc_payment_due: z.object({ enabled: z.boolean() }).optional(),
cc_funding_shortfall: z.object({ enabled: z.boolean() }).optional(),
```

No change to `getNotifPrefs`/`updateNotifPrefs` logic — both already work generically off `prefsSchema.parse(...)`.

### Part C — UI (`components/notifications/notif-prefs-form.tsx`)

Add three entries to `PREF_TYPES`, same shape/style as existing boolean-only rows (e.g. `low_balance`, `accrual_shortfall`, `policy_expiry` — no extra input block needed since none of the three has a threshold field):

```ts
{ key: "budget_pace" as const, label: "Budget pace warning", description: "Early alert when a tag is trending toward going over budget based on spending pace." },
{ key: "cc_payment_due" as const, label: "Credit card payment due", description: "Alert before a credit card statement is due, and again if it becomes overdue." },
{ key: "cc_funding_shortfall" as const, label: "Credit card funding shortfall", description: "Alert when the credit card funding account won't cover upcoming card payments." },
```

No other changes to the component — the existing `PREF_TYPES.map(...)` render loop, `setEnabled`, and save flow all work generically already.

### Part D — `lib/web-push.ts` dead-subscription cleanup

Confirmed via `node_modules/.pnpm/web-push@3.6.7.../src/web-push-lib.js` (lines ~369–384): `webpush.sendNotification()` rejects with a `webpush.WebPushError` instance (has a `.statusCode: number` property, confirmed in `@types/web-push/index.d.ts`) whenever the push endpoint returns a non-2xx HTTP status; other failure modes (network errors, timeouts) reject with a different error shape that has no `.statusCode`.

Change the `.catch(...)` in `sendPushToUser`'s `subs.map(...)` loop from a no-op to:

```ts
.catch(async (err: unknown) => {
  if (err instanceof webpush.WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
    await db.pushSubscription.delete({ where: { endpoint: s.endpoint } }).catch(() => {
      // Already deleted by a concurrent call — ignore.
    });
  }
  // Other errors (network blips, 5xx, etc.) are left alone — not confirmed-gone.
})
```

Use `delete` (not `deleteMany`) since `endpoint` is `@unique` — wrap in its own `.catch(() => {})` only to guard the narrow race where two concurrent `sendPushToUser` calls (e.g. this cron's fire-and-forget dispatch racing `dispatchPending`'s safety-net sweep) both get a 410 for the same endpoint and the second `delete` would throw "record not found." Update the stale comment above the catch block to describe what the code now actually does.

### Part E — Tests

Add to `lib/__tests__/notifications.test.ts` (extend existing `vi.mock("@/lib/db", ...)` factory to include any newly-needed table mocks — check which of `budget`/`account`/`accrualEnvelope`/`scheduledBill` mocks already exist before adding):

- For each of the 5 check functions already covered there (`checkBudgetOverspend`, `checkLowBalance`, `checkAccrualShortfall`, `checkBillReminders`, `checkAnomalies`): add a case asserting a user with `notificationPrefs: { <type>: { enabled: false } }` is excluded from `userIds` in the `notification.create` call (or, if that user is the only user, that `notification.create` is not called at all — reuse the existing single/two-user mock shape). For `checkBudgetOverspend`, `checkBillReminders`, `checkAnomalies` (the three with a per-user threshold field), add a second case with two users on different threshold/daysAhead/multiplier values where only the user whose configured value is met ends up in `eligibleUserIds`.
- Per the confirmed **pure-decision-module precedent** (`.claude/agent-memory/planner/repo_conventions.md`): `checkBudgetPace`, `checkCardPaymentsDue`, and `checkCcFundingShortfall` are deliberately NOT covered by direct tests in this file (they wrap `lib/budget-pace.ts`, `lib/card-due.ts`, `lib/cc-funding.ts`, which are unit-tested on their own) — do not add new `describe` blocks for these 3; their prefs-gating logic is simple boolean filtering identical in shape to the already-tested pattern in `checkAccrualShortfall`, and adding thin DB-mocked tests for them would break with this file's established scope. **Flag for the Tester:** if the Tester's own judgment differs (e.g. wants smoke coverage that the new `eligibleUserIds` computation doesn't throw), that's a reasonable call to make at that stage, but it diverges from current file scope — note the divergence rather than silently expanding it.
- New `prefsSchema` validation cases (either inline in `actions/notifications.ts`'s own future test file if one exists — confirmed it does not; add a lightweight case to `lib/__tests__/notifications.test.ts` is NOT appropriate since it doesn't import `actions/notifications.ts` today) — **decision: skip a dedicated schema unit test.** `prefsSchema` is a private (non-exported) zod object; the only exported surface is `getNotifPrefs`/`updateNotifPrefs`, both of which are `"use server"` functions requiring `requireAuth()`/DB access with no existing unit-test precedent for any `actions/*.ts` file in this repo (confirmed: `actions/` has no `__tests__` directory or Vitest coverage anywhere). Do not invent a new test-the-server-action pattern for 3 lines of schema — instead, the Coder should double-check by running `pnpm typecheck` that `NotifPrefs` (the inferred type) still round-trips through `notif-prefs-form.tsx` with the 3 new keys added to `PREF_TYPES`, which is this repo's existing verification mechanism for `actions/*.ts` changes.
- New `lib/__tests__/web-push.test.ts`: mock `@/lib/db` (`pushSubscription: { findMany, delete }`) and mock the `web-push` package itself (`vi.mock("web-push", ...)` — check `@/lib/db`-style mock factory conventions from other tests, e.g. `supabase-storage.test.ts`, for how this repo mocks a 3rd-party SDK rather than assuming). Cases:
  - `sendNotification` rejects with a `WebPushError`-shaped object where `statusCode: 410` → `pushSubscription.delete` is called once with `{ where: { endpoint } }`.
  - Same for `statusCode: 404`.
  - `sendNotification` rejects with `statusCode: 500` → `pushSubscription.delete` is NOT called.
  - `sendNotification` rejects with a non-`WebPushError` (e.g. a generic network `Error` with no `.statusCode`) → `pushSubscription.delete` is NOT called.
  - `sendNotification` resolves successfully → `pushSubscription.delete` is NOT called, no throw.
  - Since `webpush.WebPushError` is a real exported class from the `web-push` package, the Coder should mock it either by importing the real class from the actual (unmocked) `web-push` module and only mocking `sendNotification`, or by constructing an object and using `Object.setPrototypeOf`/a matching mock class — verify which is simpler once mocking `web-push` is underway; don't assume `instanceof` will trivially pass through a naive object-literal mock without deliberately wiring the prototype chain.

## Risks/unknowns

- **Same-cron-run eligibility snapshot:** for the three threshold-gated functions (`checkBudgetOverspend`, `checkBillReminders`, `checkAnomalies`), `eligibleUserIds` is computed once per check-function invocation and the existing `scopeKey`/`alreadyNotifiedToday` dedup is still per-scope-per-day (unchanged). If the cron only runs once daily (need to confirm — not read as part of this plan; check `vercel.json` or similar cron config before/during implementation if it matters), this is a non-issue. If it runs more than once a day, a user who newly becomes eligible mid-day (e.g. spend crosses their personal threshold between two cron runs) won't get notified until the dedup scope resets — this is an accepted pre-existing granularity limit of the shared-row broadcast design (see `repo_conventions.md`'s note on `checkLargeSpend` being the only per-user-row exception), not a new bug this task introduces.
- **`cc_payment_due` shared toggle assumption:** treating `cc_payment_due` and `cc_payment_overdue` as sharing one preference key is my judgment call per the request's own hint, confirmed by reading `checkCardPaymentsDue`'s actual branching (same per-card loop, mutually exclusive branches). If the user actually wants independent control (e.g. mute the "due soon" reminder but keep overdue escalations), this plan doesn't support that — flagging so the user can object before the Coder builds it, since splitting into two keys later means a `notificationPrefs` JSON migration-by-convention (no schema migration needed since it's just JSON, but existing users' saved `cc_payment_due` value would need re-interpretation).
- **Missing UI for `bill_due.daysAhead` / `anomaly.multiplier`:** confirmed these two schema fields exist today with zero UI to set them (only readable/writable via direct `updateNotifPrefs` calls, e.g. future API/script use). Not fixed by this task (out of scope per above) — flagging as a good follow-up candidate, not resolving unilaterally.
- **No test precedent for `actions/*.ts` files:** confirmed via grep that no `actions/` file has ever had a dedicated unit test in this repo. This plan deliberately does not introduce one just for the 3-line schema addition; verification for that piece is `pnpm typecheck` + the Tester manually confirming the settings page save/reload round-trips (see Test expectations below).
- **`db.pushSubscription.delete` race:** two near-simultaneous push sends to the same dead endpoint (e.g. the cron's fire-and-forget `createNotification` dispatch and `dispatchPending`'s safety-net sweep both touching a `sentAt: null` notification in the same run) could both get a 410 and both attempt delete; handled via the inner `.catch(() => {})` per Part D — flagging so the Tester knows this is deliberate, not an oversight.

## Acceptance criteria

1. All 8 previously-unfiltered check functions (`checkBudgetOverspend`, `checkBudgetPace`, `checkLowBalance`, `checkAccrualShortfall`, `checkBillReminders`, `checkAnomalies`, `checkCardPaymentsDue`, `checkCcFundingShortfall`) exclude a user from `createNotification`'s `userIds` when that user's relevant `notificationPrefs[type].enabled === false`.
2. `checkBudgetOverspend`, `checkBillReminders`, and `checkAnomalies` additionally respect each user's individually configured `threshold`/`daysAhead`/`multiplier` value (falling back to the existing hardcoded default — 80 / 3 / 1.5 respectively — when a user has no explicit value set).
3. `checkLowBalance`'s `$15` minimum-balance-fee transaction creation is unaffected by any user's `low_balance` preference — still fires purely off the account's real balance state.
4. `checkDocumentExpiry` and `checkLargeSpend` (already correct) are untouched and still pass their existing behavior.
5. `prefsSchema` in `actions/notifications.ts` has new optional `budget_pace`, `cc_payment_due`, `cc_funding_shortfall` keys (each `{ enabled: z.boolean() }`), and `getNotifPrefs`/`updateNotifPrefs` round-trip them correctly (no code change needed there beyond the schema itself).
6. `notif-prefs-form.tsx`'s `PREF_TYPES` includes all 3 new keys with a label/description in the same visual style as existing rows; toggling and saving them persists via `updateNotifPrefs` exactly like existing rows (no new save-path logic needed).
7. `sendPushToUser` deletes the matching `PushSubscription` row (matched by `endpoint`) when `webpush.sendNotification` rejects with a `WebPushError` whose `statusCode` is `404` or `410`, and does NOT delete it for any other rejection (other status codes, or non-`WebPushError` errors like network failures).
8. The stale "endpoint cleanup happens on 410" comment in `lib/web-push.ts` is replaced with an accurate description of the real cleanup logic.
9. The unused `getAllUserIds()` helper is removed from `lib/notifications.ts` (or, if the Coder finds a remaining legitimate use during implementation, left in place with a one-line note explaining why it's still needed — don't leave genuinely-dead code un-flagged).
10. `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass with no regressions to the currently-passing suite (351/351 as of 2026-09-12 per prior verified run — re-confirm the live count rather than trusting that number).
11. No notification wording/body text changed for any of the 10 types. No new `Notification.type` string introduced. `email` channel remains untouched (`channel: "in_app"` literal in `createNotification` unchanged).

## Test expectations

**Unit tests only** (this repo has no integrated DB tests — mock at the function boundary, per CLAUDE.md and confirmed repo convention):

- `lib/__tests__/notifications.test.ts` (extend existing file, following its established `vi.mock("@/lib/db", ...)` / `vi.mock("@/lib/web-push", ...)` factory pattern):
  - `checkBudgetOverspend`: opted-out user excluded; per-user custom `threshold` respected (one user's threshold met, another's not, on the same budget).
  - `checkLowBalance`: opted-out user excluded from the *notification*; fee-transaction creation still happens regardless of prefs (add/extend a case proving this — e.g. all users opted out but `db.transaction.create` for the fee is still called).
  - `checkAccrualShortfall`: opted-out user excluded (boolean-only, no threshold).
  - `checkBillReminders`: opted-out user excluded; per-user custom `daysAhead` respected.
  - `checkAnomalies`: opted-out user excluded; per-user custom `multiplier` respected.
  - Edge case for each threshold-gated function: all users opted out or all users' thresholds unmet → `notification.create` is not called at all (covers the early-`continue` branch, not just partial exclusion).
- `lib/__tests__/web-push.test.ts` (new file): the 5 cases listed under Part E above (410 deletes, 404 deletes, 500 doesn't, non-`WebPushError` doesn't, success doesn't).
- No new tests for `checkBudgetPace`, `checkCardPaymentsDue`, `checkCcFundingShortfall` — consistent with this file's existing scope boundary (pure-decision-module precedent), per Part E's explicit call-out. Tester should double check this exclusion still reads as intentional (not accidentally-skipped) when reviewing coverage.
- No new tests for `prefsSchema` itself (rationale in Part E) — Tester's checklist item here is a manual/typecheck-level check: `pnpm typecheck` passes with the 3 new `PREF_TYPES` entries wired to the widened `NotifPrefs` type, and (if a dev/staging environment is reachable) the settings page visibly shows and saves the 3 new toggles.

## Notes for the Coder

- Read each of the 8 target functions fully in `lib/notifications.ts` before editing — line numbers cited above are approximate (from the request doc) and may have shifted slightly; match by function name/signature, not line number.
- Keep every existing `scopeKey` string format and `alreadyNotifiedToday` call site exactly as-is — only the computation feeding `userIds` into `createNotification` changes.
- `Decimal` comparisons (`.greaterThan`, `.lessThanOrEqualTo`, etc.) — not `>`/`<` on the raw values — must be used for the `anomaly` multiplier comparison, matching the file's existing convention throughout.
