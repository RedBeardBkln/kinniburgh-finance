# Test Report — Notification delivery hardening

## Verdict: PASS

## Acceptance criteria checklist

1. **All 8 previously-unfiltered check functions exclude an opted-out user from `createNotification`'s `userIds`.** PASS.
   Read `lib/notifications.ts` in full and confirmed each of `checkBudgetOverspend`, `checkBudgetPace`, `checkLowBalance`, `checkAccrualShortfall`, `checkBillReminders`, `checkAnomalies`, `checkCardPaymentsDue`, `checkCcFundingShortfall` computes an `eligibleUserIds` array by filtering `db.user.findMany({ select: { id, notificationPrefs } })` against the relevant pref key's `enabled !== false` (or `enabled === false` early-exclude), and passes only that array into `createNotification`/`userIds`. Verified with real (not fabricated) test runs — 5 functions already had Coder-written opt-out tests; I additionally wrote and ran opt-out tests for `checkCardPaymentsDue` (both branches) and `checkCcFundingShortfall`, which the plan deliberately left untested. All pass. `checkBudgetPace` has no direct test (plan's explicit scope call — see "Not tested" below), but its code path is structurally identical to the already-tested `checkAccrualShortfall` boolean-only pattern.

2. **`checkBudgetOverspend`, `checkBillReminders`, `checkAnomalies` respect per-user `threshold`/`daysAhead`/`multiplier`, falling back to 80/3/1.5.** PASS.
   Confirmed by reading the code (each does `p?.threshold ?? 80`, `p?.daysAhead ?? 3`, `p?.multiplier ?? 1.5` respectively, with `Decimal.greaterThan`/`.times()` used for the anomaly comparison, not raw `>`) and by the existing "respects each user's individually configured X" test cases, which set two users to different values and assert only the qualifying one appears in `userIds`. All pass.

3. **`checkLowBalance`'s $15 fee transaction is unconditional, unaffected by `low_balance` prefs.** PASS.
   Read the function: the fee-creation block (lines ~311–357) sits entirely before the `eligibleUserIds` computation and the `low_balance` pref filter only gates the `createNotification` call at the bottom. The existing test "still creates the $15 minimum-balance fee transaction even when every user is opted out of the notification" sets both users to `enabled: false`, asserts `db.transaction.create` is still called once and `db.notification.create` is not called. Ran it — passes.

4. **`checkDocumentExpiry` and `checkLargeSpend` untouched.** PASS.
   `git diff lib/notifications.ts | grep` for both function names returns zero removed/changed lines inside either function body — confirmed via full diff read, not just grep. Their existing test files (`document-expiry.test.ts`, and `checkLargeSpend`'s coverage) still pass unchanged.

5. **`prefsSchema` has new `budget_pace`, `cc_payment_due`, `cc_funding_shortfall` keys, `{ enabled: z.boolean() }`.** PASS. Read `actions/notifications.ts` directly — all three present, each `.optional()`, matching the existing style of `low_balance`/`accrual_shortfall`/`policy_expiry`. `getNotifPrefs`/`updateNotifPrefs` unchanged (still generic over `prefsSchema.parse`).

6. **`notif-prefs-form.tsx` has matching UI toggles wired to `updateNotifPrefs`.** PASS. `PREF_TYPES` has all 3 new entries with label/description in the same shape as existing rows; no extra input block (correct, since none of the three has a threshold field). The render loop, `setEnabled`, and `save()` all work generically off `PREF_TYPES` — no new wiring needed and none was added. Traced the round-trip logically: `setEnabled(key, false)` → `prefs[key] = {...prefs[key], enabled: false}` → `save()` calls `updateNotifPrefs(prefs)` → `prefsSchema.parse` accepts it (all three schemas are `{enabled: boolean}` only, no required extra fields) → persisted to `User.notificationPrefs` → next cron run's `db.user.findMany({select: {notificationPrefs}})` reads it back and the check function's filter reads `enabled !== false`. No missing link.

7. **`sendPushToUser` deletes `PushSubscription` on 404/410 `WebPushError`, not on other errors.** PASS.
   Read `lib/web-push.ts`: `.catch(async (err) => { if (err instanceof webpush.WebPushError && (err.statusCode === 404 || err.statusCode === 410)) { await db.pushSubscription.delete({where:{endpoint: s.endpoint}}).catch(()=>{}); } })`. Confirmed `WebPushError`'s real constructor (`node_modules/web-push/src/web-push-error.js`) sets `.statusCode` from the second constructor arg, matching the check. Ran `lib/__tests__/web-push.test.ts` — 410 deletes, 404 deletes, 500 doesn't, non-`WebPushError` (plain `Error`) doesn't, success doesn't. All pass.

8. **Stale comment replaced.** PASS. Old "Stale subscriptions are silently ignored" comment is gone; new comment accurately describes the 404/410-delete behavior and the race-guard rationale.

9. **`getAllUserIds()` removed.** PASS. Confirmed via diff — the helper (previously at lines ~34–37) is deleted, and `git grep getAllUserIds` (implicitly, via reading the whole file) shows zero remaining references anywhere in `lib/notifications.ts`.

10. **`pnpm typecheck && pnpm lint && pnpm test` pass with no regressions.** PASS — re-ran all three myself (not trusting the Coder's report):
    - `pnpm typecheck` → clean, no output beyond the tsc invocation.
    - `pnpm lint` → 0 errors, 43 warnings, all pre-existing (setState-in-effect, unused-vars in files this task never touched — same baseline as Coder's report).
    - `pnpm test` → **453/453 passed, 38 files** before my additions; **458/458 passed, 38 files** after I added 5 new test cases (2 files: `checkCardPaymentsDue` ×3, `checkCcFundingShortfall` ×2) to close a coverage gap. No regressions either time.

11. **No wording/type-string/channel changes.** PASS. Diffed `lib/notifications.ts` line-by-line: every `title`/`body` template string, every `scopeKey` format, every `type:` literal passed to `createNotification` is byte-identical to before. `channel: "in_app"` in `createNotification` untouched. No new files under `app/notifications/` or `components/notifications/notification-bell.tsx` were touched (confirmed via `git diff --stat` — zero changes).

## Tests run

```
pnpm typecheck          # tsc --noEmit — clean
pnpm lint                # 0 errors, 43 pre-existing warnings
pnpm test                # vitest run — 453/453 (before my additions), 458/458 (after)
pnpm vitest run lib/__tests__/notifications.test.ts   # 27/27 (after additions; was 22/22)
```

Full-suite output (after my additions):
```
 Test Files  38 passed (38)
      Tests  458 passed (458)
   Duration  1.99s
```

## Tests added

The plan explicitly flagged (Part E, "Risks/unknowns") that `checkBudgetPace`, `checkCardPaymentsDue`, and `checkCcFundingShortfall` were left untested per the file's "pure-decision-module precedent," while also flagging that the Tester's own judgment on this could differ. I judged `checkCardPaymentsDue` in particular worth direct coverage: unlike every other check function, it computes `eligibleUserIds` **once outside the per-card loop** and reuses it across two structurally different branches (the standard due-soon reminder and the overdue escalation, which key off different `notification.type` values but the same pref). That shape is different enough from the already-tested boilerplate that code-reading alone wasn't sufficient assurance — it's exactly the kind of "looks right by inspection, wrong in practice" spot this pipeline exists to catch.

Added to `lib/__tests__/notifications.test.ts`:
- `checkCardPaymentsDue`: opted-out user excluded from the due-soon reminder; the same shared toggle correctly gates the overdue escalation branch too (`cc_payment_overdue` type); all-opted-out → no notification created at all.
- `checkCcFundingShortfall`: opted-out user excluded; all-opted-out → `count === 0` and `notification.create` not called.

All 5 new cases pass against the real (unmodified) implementation — this is genuine coverage, not tautological, since they set up realistic shortfall/due-date conditions via the actual `classifyCardDue`/`analyzeCardFunding` pure functions (not mocked) and assert on the resulting `userIds` payload.

I did not add tests for `checkBudgetPace` — its prefs-gating is a single boolean filter after an `evaluation.fire` gate, structurally identical to the already-tested `checkAccrualShortfall`, and I didn't find anything in its structure (unlike `checkCardPaymentsDue`'s shared-toggle-across-branches shape) that a smoke test would be likely to catch beyond what code-reading + the analogous existing test already covers.

## Defects found

None. No implementation bugs found in either the prefs-enforcement fix or the push-cleanup fix.

## Not tested

- **Live browser round-trip of the settings page.** No dev/staging environment was exercised in this pass; the "toggle → save → persists" claim in criterion 6 is verified by static/logical trace of the code path (`setEnabled` → `save()` → `updateNotifPrefs` → `prefsSchema.parse` → `db.user.update`), consistent with this repo's own stated precedent (no `actions/*.ts` unit-test convention exists, per the plan). Not a red flag — this matches the plan's own acknowledged limitation, not a gap introduced by this task.
- **`checkBudgetPace` prefs-gating**, direct unit test — deliberately not added; see rationale above. Its logic was verified by reading the code, not by executing a targeted test.
- **Real cron dispatch end-to-end** (`app/api/cron/notifications/route.ts` actually invoking all 10 functions against a live/staging DB) — this repo has no integrated DB test precedent (confirmed CLAUDE.md convention), so this was not exercised; only unit-level mocked coverage exists for the individual check functions.
- **Cross-test-file leakage from the `web-push.test.ts` mocking workaround** — confirmed structurally sound: Vitest 2.1.9 with no `pool`/`isolate` override in `vitest.config.ts` defaults to per-file module isolation (`pool: "threads"`, `isolate: true`), so mutating the shared `web-push` module's `sendNotification` property in one test file cannot leak into another file's module registry regardless of whether `afterAll` runs. I did not force a pool-config change to empirically prove this with a contrived cross-file test, since the default-isolation guarantee is a documented Vitest behavior, not something specific to this repo's setup that needs re-verification.

## Files reviewed/modified

- `D:\Repos\Personal\kinniburgh-finance\lib\notifications.ts` — read in full, diffed against `git diff`.
- `D:\Repos\Personal\kinniburgh-finance\lib\web-push.ts` — read in full.
- `D:\Repos\Personal\kinniburgh-finance\actions\notifications.ts` — read in full.
- `D:\Repos\Personal\kinniburgh-finance\components\notifications\notif-prefs-form.tsx` — read in full.
- `D:\Repos\Personal\kinniburgh-finance\app\api\cron\notifications\route.ts` — read in full.
- `D:\Repos\Personal\kinniburgh-finance\lib\card-due.ts`, `D:\Repos\Personal\kinniburgh-finance\lib\cc-funding.ts` — read to construct realistic new test fixtures.
- `D:\Repos\Personal\kinniburgh-finance\lib\__tests__\notifications.test.ts` — read in full; extended with 5 new test cases (`checkCardPaymentsDue` ×3, `checkCcFundingShortfall` ×2) plus supporting `account.findFirst` mock wiring.
- `D:\Repos\Personal\kinniburgh-finance\lib\__tests__\web-push.test.ts` — read in full, ran as-is (no changes).
