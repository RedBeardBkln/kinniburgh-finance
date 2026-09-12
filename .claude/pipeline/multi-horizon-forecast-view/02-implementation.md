# Implementation: Multi-horizon forecast view

## Summary of changes

**New files:**

- `lib/forecast-rollup.ts` — pure rollup module. Exports `RollupHorizon`,
  `RollupBucket`, `rollupForecast(forecast, horizon)`. Implements daily
  (passthrough), weekly (relative 7-day chunks from `forecast[0]`), monthly
  (calendar-aligned, groups consecutive days by UTC year/month), and
  quarterly (calendar-aligned, groups consecutive days by UTC year/quarter)
  rollups per the plan's exact spec. Each bucket carries `endingBalance`
  (last day's balance), `minBalance`/`hasBreach`/`firstBreachDate` (computed
  across all days in the bucket, not just the ending day), and `isPartial`.
  No DB/Prisma-client imports beyond the `Decimal` runtime type; no
  `"use server"`. Exhaustive `switch` over `RollupHorizon` with a
  `never`-typed default guard.

- `lib/__tests__/forecast-rollup.test.ts` — all 10 cases specified in the
  plan (daily passthrough, weekly exact multiple of 7, weekly breach
  mid-bucket, weekly firstBreachDate-picks-earliest, monthly spanning a
  boundary, monthly exact full month, quarterly spanning a boundary,
  quarterly exact full quarter, empty input, single-day weekly). All 10
  pass, matching every exact expected value in the plan (balances, dates,
  `isPartial` flags) with no changes needed to the plan's expected values.

- `components/forecast/spend-pace-section.tsx` — new plain (no
  `"use client"`, no hooks) presentational component. Exports `TagPaceRow`
  and `SpendPaceSection`. Renders the "Category Spend Pace — {periodLabel}"
  card with the required disclaimer line, a table (Tag / Spent so far /
  Budget / Projected (month end) / Status), and the exact 4-branch status
  badge logic from the plan (low confidence → "Not enough history yet" +
  `~` prefix on the projected value; ≥100% → "Trending over" red;
  ≥80% → "On pace" amber; else → "Under pace" green).

**Modified files:**

- `components/forecast/balance-chart.tsx` — added one optional prop,
  `subtitleOverride?: string`. Subtitle text is now
  `subtitleOverride ?? \`${days}-day projection\``. When the prop is
  omitted (all existing call sites before this task's own new ones), the
  rendered text is identical to before.

- `components/forecast/forecast-account-card.tsx` — added three new
  required props (`chartDataWeekly`, `chartDataMonthly`,
  `chartDataQuarterly`, all `ChartPoint[]`, reusing the existing exported
  type). Added a `granularity` state
  (`"daily" | "weekly" | "monthly" | "quarterly"`, default `"daily"`) and a
  second segmented-button row below the existing 30/60/90 row, styled
  identically. When `granularity === "daily"`, behavior is byte-for-byte
  the same as before (30/60/90 row shown, `chartData90.slice(0, days)`,
  `hasBreaches` via `balance < minimumBalance`). Otherwise the 30/60/90 row
  is hidden, the full corresponding rollup array is rendered unsliced, and
  `hasBreaches` is derived from `isBreachDay` (not `balance < minimumBalance`)
  so a mid-bucket breach is still flagged even when the bucket's ending
  balance is healthy. `subtitleOverride` is passed through to
  `<BalanceChart>` as `"Weekly rollup"` / `"Monthly rollup"` /
  `"Quarterly rollup"` (or `undefined` for daily).

- `app/forecast/page.tsx`:
  - Imports `rollupForecast`/`RollupBucket` from `@/lib/forecast-rollup`,
    `projectPeriodEndSpend` from `@/lib/spend-forecast`,
    `computeBudgetSummary` from `@/lib/budget`, `PACE_TRAILING_MONTHS` from
    `@/lib/budget-pace`, and `SpendPaceSection`/`TagPaceRow` from the new
    component.
  - Inside the existing `accountForecasts = tdAccounts.map(...)` block,
    after `chartData90` is built, computes `chartDataWeekly`,
    `chartDataMonthly`, `chartDataQuarterly` via `rollupForecast` +
    label-formatting helpers exactly matching the plan's label formats
    (`Week N (Mon D–Mon D)`, `Mon YYYY (partial)`, `QN YYYY (partial)`),
    and adds all three arrays to the object returned per account.
  - `<ForecastAccountCard>` now receives the three new props.
  - Added a new block (gated `entity?.slug === "personal"`) that queries
    the current period's Personal budgets, current-period tag spend, and
    trailing-history tag spend via `db.$queryRaw`, then runs
    `computeBudgetSummary` + `projectPeriodEndSpend` per tag (skipping
    tags with `effectiveBudget <= 0`) to build `paceRows: TagPaceRow[]`,
    sorted by `projectedPercentOfBudget` descending. This mirrors
    `app/budgets/page.tsx`'s existing entity-scoped raw-SQL pattern (not
    `checkBudgetPace`'s unscoped one), per the plan's Design decision 4.
  - Renders `<SpendPaceSection>` after the "Next 14 Days — Primary
    Checking" card and before "Recurring expenses", gated on
    `entity?.slug === "personal" && paceRows.length > 0`.

## Deviations from the plan

- **Naming only, no behavior change:** the plan's illustrative code names
  the per-tag forecast result `forecast`, which would shadow the
  outer-scope meaning of "forecast" used elsewhere in this large file. I
  named it `spendForecast` instead for readability. Purely cosmetic — same
  fields, same call, same logic.
- **`paceRows` declared `const` instead of `let`:** the plan's illustrative
  snippet uses `let paceRows: TagPaceRow[] = []`, but it's only ever mutated
  via `.push()`/`.sort()`, never reassigned — ESLint's `prefer-const` (an
  existing rule in this repo, not new) flagged the `let` as an error. Fixed
  to `const`. No behavior change.
- No other deviations. All type shapes, prop names, label formats, status
  badge thresholds, and query shapes match the plan exactly.

## Commands run and their results

- `pnpm vitest run lib/__tests__/forecast-rollup.test.ts` — 10/10 passed
  (run early, before wiring the rest, to validate the rollup module in
  isolation).
- `pnpm typecheck` (`tsc --noEmit`) — clean, no errors.
- `pnpm lint` (ESLint) — 0 errors, 45 warnings, all 45 pre-existing and
  unrelated to this task's files (confirmed by inspecting every warning
  location — none are in `lib/forecast-rollup.ts`,
  `lib/__tests__/forecast-rollup.test.ts`, `app/forecast/page.tsx`,
  `components/forecast/*`). One real error was introduced during
  development (`paceRows` `let` vs `const`) and fixed before this final
  run.
- `pnpm test` (`vitest run`, full suite) — **327/327 tests passed across 30
  files** (baseline was 317/317 across 29 files; this task added exactly
  the 10 new `forecast-rollup.test.ts` cases in 1 new file, zero
  regressions elsewhere).

## Open items

- **Manual/browser verification is required and was NOT performed** (no
  browser access in this pipeline, per the plan's Approach step 8 and Risk
  notes). A human must load `/forecast?bucket=personal` and a business
  bucket (e.g. `/forecast?bucket=sudden-valley`) and confirm:
  - Daily granularity is pixel-for-pixel identical to before this change.
  - Weekly/Monthly/Quarterly visibly swap in fewer, wider buckets with the
    expected labels and hide the 30/60/90 row.
  - A bucket with a mid-period (non-ending-day) breach is still flagged
    with destructive styling even though its ending balance may be
    healthy — this exercises the `hasBreach`/`minBalance` wiring added in
    `ForecastAccountCard`, which cannot be verified by unit tests alone
    since that component has no test file (consistent with its pre-existing
    untested `days` state, per the plan's Test expectations section).
  - The "Category Spend Pace" section renders sensible numbers on the
    Personal bucket and does not render at all on business buckets.
  - No layout breakage at mobile width.
- Everything else in the plan's scope was implemented as specified; no
  gaps found in `lib/forecast.ts` / `lib/spend-forecast.ts` requiring
  changes (neither file was touched, as required).
- No Prisma schema changes, no new dependencies, no new/changed
  `actions/*.ts` files — confirmed via `git status`-equivalent review of
  everything touched in this task.
