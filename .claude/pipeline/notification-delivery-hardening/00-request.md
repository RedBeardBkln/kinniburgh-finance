# Request

Tier 4 of the platform roadmap ("automate as much financial work as possible" north star — Tier 4 is post-launch hardening: ClawBox build-out, notification-delivery hardening, mobile PWA polish). This task is the notification-delivery hardening item. ClawBox is blocked on a separate device/auth issue (not in scope here). PWA polish is a separate future task.

Scope, confirmed with the user: fix real, verified bugs in preference enforcement and dead-subscription handling. **Do NOT build email notification delivery** — the `email` value on `Notification.channel` stays declared-but-unused; that's an explicit future task, not this one.

## Confirmed facts (verified by reading the code directly — don't re-derive, but do verify against the current file before changing it)

### Bug 1: 8 of 10 notification check functions ignore user preferences

`lib/notifications.ts` has 10 `checkXxx()` functions, each called from `app/api/cron/notifications/route.ts` (read that file to see how/whether it aggregates results). The user-facing settings page (`app/settings/notifications/page.tsx` → `components/notifications/notif-prefs-form.tsx`, backed by `actions/notifications.ts`'s `getNotifPrefs`/`updateNotifPrefs`/`prefsSchema`) lets a user enable/disable each alert type and tune some thresholds, stored as JSON on `User.notificationPrefs`.

**Only 2 of 10 check functions actually read `notificationPrefs`:**
- `checkDocumentExpiry` (line ~539) — correct reference pattern: fetches `db.user.findMany({ select: { id: true, notificationPrefs: true } })` once, then per-item filters `users` down to `eligibleUserIds` via `prefs["policy_expiry"]?.enabled !== false`, and only calls `createNotification({ userIds: eligibleUserIds, ... })` for eligible users.
- `checkLargeSpend` (line ~787) — correct reference pattern for a function with a numeric threshold: loops per-user, reads `prefs["large_spend"]` as `{ enabled?, thresholdCents? }`, skips if `enabled === false`, uses `thresholdCents ?? <default>` to filter which transactions qualify for that specific user.

**The other 8 ignore prefs entirely and notify every user regardless of their settings** (confirmed directly for `checkLowBalance`, which calls a local `getAllUserIds()` helper with zero filtering — the same absence applies to the rest, verify each individually rather than assuming identical structure):
- `checkBudgetOverspend(period)` (~line 86) — `prefsSchema` has `overspend: { enabled, threshold: 1-100 }` (a percent-of-budget-used threshold)
- `checkBudgetPace(period)` (~line 150) — **no `budget_pace` key exists in `prefsSchema` at all yet** (see Bug 1b below)
- `checkLowBalance()` (~line 255) — `prefsSchema` has `low_balance: { enabled }`
- `checkAccrualShortfall()` (~line 373) — `prefsSchema` has `accrual_shortfall: { enabled }`
- `checkBillReminders()` (~line 422) — `prefsSchema` has `bill_due: { enabled, daysAhead: 1-14 }`
- `checkAnomalies(period)` (~line 467) — `prefsSchema` has `anomaly: { enabled, multiplier: >=1.1 }`
- `checkCardPaymentsDue()` (~line 597) — **no pref key exists yet** for `cc_payment_due`/`cc_payment_overdue` (see Bug 1b)
- `checkCcFundingShortfall()` (~line 694) — **no pref key exists yet** for `cc_funding_shortfall` (see Bug 1b)

### Bug 1b: `prefsSchema` (in `actions/notifications.ts`) is missing entries for 3 notification types

`prefsSchema` currently has keys for: `overspend`, `low_balance`, `accrual_shortfall`, `bill_due`, `anomaly`, `policy_expiry`, `large_spend`. But the full set of notification types (see `TYPE_META` in `app/notifications/page.tsx` and `components/notifications/notification-bell.tsx` for the canonical type list) also includes `budget_pace`, `cc_payment_due`, `cc_payment_overdue`, `cc_funding_shortfall` — these have no corresponding `prefsSchema` entry, so there is currently no way for a user to disable them even after Bug 1 is fixed, since there's nowhere to store that preference. Add schema entries for these (boolean `enabled` is sufficient unless the check function has an obvious tunable threshold worth exposing — use judgment, don't force a threshold field that doesn't map to anything real in the check logic; `cc_payment_due` and `cc_payment_overdue` likely share one `enabled` toggle since they're the same underlying check with two severities, verify by reading `checkCardPaymentsDue`'s actual logic before deciding).

### Bug 2: dead push subscriptions are never cleaned up

`lib/web-push.ts`'s `sendPushToUser` catches every `webpush.sendNotification()` rejection with a comment claiming "Stale subscriptions are silently ignored; endpoint cleanup happens on 410" — but there is no actual cleanup code; the catch block does nothing. The `web-push` npm package's rejected error object exposes `.statusCode` (and `web-push`'s own docs/well-known behavior: a 404 or 410 response means the subscription is gone and should be deleted — verify this against the installed `web-push` package's types/README rather than assuming). Fix: on a 404/410 error, delete the corresponding `PushSubscription` row (matched by `endpoint`) so it stops being retried forever. Other errors (network blips, 5xx) should NOT delete the subscription — only confirmed-gone ones.

## Ground rules (CLAUDE.md)

TypeScript strict, no fabricated data. This is a household notification system — the visible behavior change users will notice is "my settings now actually do something" and "I stop getting alerts I turned off." Do not change notification wording/content, do not add new notification types, do not touch the `email` channel. Keep each `checkXxx` fix consistent with whichever of the two established patterns (`checkDocumentExpiry`'s batch-filter vs. `checkLargeSpend`'s per-user-threshold-loop) actually fits that function's existing structure — don't force one pattern onto a function shaped for the other.

## Your job (Planner)

1. Read `lib/notifications.ts` in full (all 10 check functions) to see each one's current user-iteration structure and confirm exactly how to thread prefs-filtering into each without changing its notification content/logic otherwise.
2. Read `actions/notifications.ts`'s `prefsSchema` and `components/notifications/notif-prefs-form.tsx` in full to plan the 3 new pref entries and their UI additions (keep the UI style/pattern consistent with the existing toggles).
3. Read `lib/web-push.ts` and check the installed `web-push` package (`node_modules/web-push` or its `package.json`/types) to confirm the exact shape of a rejected send's error object (property name for the HTTP status).
4. Read `app/api/cron/notifications/route.ts` to confirm how check functions are invoked (in case any pass required args like `period` that matter for testing).
5. Plan unit tests: `lib/__tests__/notifications.test.ts` already exists — follow its existing style/mocking pattern (CLAUDE.md: mock at the function boundary, no integrated DB tests). Cover: each fixed check function respects `enabled: false` (no notification created for an opted-out user) and respects any threshold field where one exists; the new prefsSchema entries validate correctly; `sendPushToUser` deletes the `PushSubscription` row on a 410/404-equivalent error and does NOT delete it on other errors.
6. List every file to be modified and precise acceptance criteria for the Tester.

Do not write implementation code. Do not commit or push. Write the plan to `.claude/pipeline/notification-delivery-hardening/01-plan.md`.
