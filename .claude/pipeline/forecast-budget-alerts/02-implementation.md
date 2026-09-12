# Implementation: forecast-budget-alerts

## Summary of changes

- **`lib/budget-pace.ts`** (new) — Pure decision module wrapping
  `projectPeriodEndSpend()` from `lib/spend-forecast.ts`. Exports
  `PACE_TRAILING_MONTHS` (3), `PACE_SUPPRESS_AT_PERCENT_USED` (80),
  `PACE_OVERAGE_MARGIN` (0.05), the `BudgetPaceEvaluation` interface, and
  `evaluateBudgetPace()`. Also re-exports `MonthlySpendPoint` and
  `SpendForecast` types from `lib/spend-forecast.ts` so `lib/notifications.ts`
  doesn't need a second import path, per the plan's note that
  "`budget-pace.ts` re-exports what's needed."
  - `evaluateBudgetPace` always calls `projectPeriodEndSpend` first (so
    `forecast` is populated on every return path, per acceptance criterion 9),
    then applies four guards in the order specified by the plan: zero/negative
    `effectiveBudget` → `percentUsed >= 80` → `confidence === "low"` →
    materiality margin (`projectedTotal.abs() > effectiveBudget.abs() * 1.05`,
    strict `>`). Only fires when none of the guards trip.
  - No DB imports, no `"use server"` — fully pure, matches
    `lib/card-due.ts`/`lib/cc-funding.ts` convention.

- **`lib/notifications.ts`** (modified) — Added two new imports
  (`evaluateBudgetPace`, `PACE_TRAILING_MONTHS`, `MonthlySpendPoint` from
  `./budget-pace`) and a new exported `checkBudgetPace(period: string):
  Promise<number>` function, inserted immediately after
  `checkBudgetOverspend` (which is otherwise byte-for-byte unchanged).
  `checkBudgetPace`:
  - Runs the same current-month tag-spend query as `checkBudgetOverspend`
    (duplicated inline, per the plan's explicit no-shared-helper decision).
  - Runs a new trailing-history raw SQL query (grouped by `tagId` and
    `to_char(postedAt, 'YYYY-MM')`) bounded to the `PACE_TRAILING_MONTHS`
    months immediately before the current period, bucketed into a
    `Map<string, MonthlySpendPoint[]>`.
  - Calls `evaluateBudgetPace` per budget; skips if it doesn't fire or if
    `alreadyNotifiedToday(scopeKey)` (scope key `pace:${tagId}:${period}`,
    distinct from `overspend:${tagId}:${period}`).
  - Builds title/body from the exact templates in the plan (decision 4) and
    calls `createNotification` with `type: "budget_pace"` and the payload
    shape specified in the plan (including `projectedOverage`, `confidence`,
    `method`, `trailingMonthsUsed`, `daysElapsed`, `daysInPeriod`,
    `percentUsed`).

- **`app/api/cron/notifications/route.ts`** (modified) — Added
  `checkBudgetPace` to the import list, to the `Promise.all` array (as
  `budgetPace`), to the `generated` sum, and to the returned JSON object,
  following the exact existing pattern for every other check.

- **`lib/__tests__/budget-pace.test.ts`** (new) — 10 tests covering
  `evaluateBudgetPace` directly, using the same `D`/`d`/`history()` helper
  pattern as `lib/__tests__/spend-forecast.test.ts`:
  1. Fires — high confidence, below 80% used, projection > 105% of budget.
  2. Fires — medium confidence (2/3 trailing months) is not suppressed.
  3. Does not fire — `confidence === "low"` (empty history), even though the
     bare pace projection alone would exceed budget.
  4. Does not fire — `percentUsed >= 80` (both a `85` case and the exact `80`
     boundary).
  5. Does not fire — projection under budget (healthy), high confidence;
     `projectedOverageAbs === null`.
  6. Materiality margin — 2% over doesn't fire, exactly 5% (105%) doesn't fire
     (strict `>` boundary), 6% over fires.
  7. Does not fire — `effectiveBudget` zero; no NaN/Infinity.
  8. Does not fire — `effectiveBudget` negative; no throw/nonsensical fire.
  9. `forecast` always populated across four different suppressed cases
     (mirroring tests 3–6's shapes).
  10. `trailingMonths` override (1 vs. default 3) flips the fire outcome on
      the same fixture, confirming the option threads through.

## Deviations from the plan

None. Implementation follows the plan's design decisions, function
signatures, payload shape, notification copy templates, scope keys, and test
plan exactly. `checkBudgetOverspend` was not touched; `checkBudgetPace` was
not added to `lib/__tests__/notifications.test.ts`, per the plan's explicit
precedent-based decision.

One implementation-level note (not a deviation, just documenting a choice):
`evaluateBudgetPace` computes `threshold = effectiveBudget.abs().times(1 +
PACE_OVERAGE_MARGIN)` (i.e. `.times(1.05)`) rather than the
"single-final-division" rearrangement noted in my own memory for a *different*
prior bug (weighted blends with a non-terminating fractional weight, e.g.
`daysElapsed / daysInPeriod`). I verified empirically via a throwaway Node
script that `Decimal(x).times(1.05)` (and `.times(1.02)`, `.times(1.06)`) are
exact for this codebase's `Decimal` build — no float-imprecision risk here
because `1.05` is not a non-terminating binary fraction the way `1/3` is — so
no rearrangement was needed for the margin math itself.

## Commands run and their results

- `pnpm typecheck` — `tsc --noEmit` — clean, no errors.
- `pnpm lint` — 0 errors, 45 warnings, all pre-existing and in files I didn't
  touch (React hooks set-state-in-effect warnings, unused vars in components/
  seed script/other test files). Confirmed by scanning the full lint output
  for `budget-pace` / `notifications.ts` / `route.ts` — no matches among the
  warnings.
- `pnpm test` (`vitest run`, full suite) — **317 passed / 317, 29 files**
  (baseline was 307/307 across 28 files; my new `budget-pace.test.ts` added
  exactly 10 tests in 1 new file; zero regressions, zero skipped/failing).

## Open items

- None outside the plan's own documented, accepted risks (duplicated 80%
  threshold constant between `checkBudgetOverspend` and `budget-pace.ts`; no
  per-user opt-out for `budget_pace`; `checkBudgetPace` itself untested
  against a live DB, matching the existing `checkCardPaymentsDue`/
  `checkCcFundingShortfall` precedent). All of these are called out explicitly
  in `01-plan.md`'s Risks/unknowns section and were not silently resolved or
  expanded in scope here.
