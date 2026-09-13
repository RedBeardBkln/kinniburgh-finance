# Implementation: monthly-review-forecast

No `03-test-report.md` or `04-review.md` existed at the start of this session — this is a first implementation pass, not a fix-forward.

## Summary of changes

### New: `lib/review-forecast.ts`
Pure, no DB/Prisma-model imports, no `"use server"`. Exports exactly what the plan specified:
- `REVIEW_FORECAST_TRAILING_MONTHS = 3`, `MAX_ACCURACY_ROWS = 5`, `MIN_NOTABLE_MISS_AMOUNT = new Decimal(10)`.
- `previousPeriod(period)` — regex-validates `YYYY-MM`, computes the prior period via `Date.UTC(year, month - 2, 1)` (JS normalizes the negative-month case for year rollover, e.g. `2026-01` → `2025-12`).
- `periodMidpointDate(period)` — `ceil(daysInPeriod / 2)` at UTC midnight, using the same `Date.UTC(year, month, 0)` trick `lib/spend-forecast.ts` uses for days-in-month.
- `reconstructForecastAccuracy(opts)` — calls `projectPeriodEndSpend` directly with `asOfDate: periodMidpointDate(period)`, then compares `abs(projectedTotal)` to `abs(actualFinal)` for `missAbs`/`percentOff`/`direction`, passing through `confidence` and the full `reconstructedForecast` untouched.
- `selectNotableAccuracyRows(rows, opts)` — filters `confidence !== "low"` and `missAbs > minMissAmount` (strictly greater — "at or below" per the plan is dropped), sorts descending by `missAbs`, slices to `maxRows`.

All worked Decimal values in the plan's Step 2 (exact-match/under/over/low-confidence/zero-actual-guard cases) were re-derived by hand before writing tests and matched exactly.

### New: `lib/__tests__/review-forecast.test.ts`
19 tests, matching the plan's Step 2 enumeration: `previousPeriod` (3 valid + 1 invalid-format block), `periodMidpointDate` (4 valid + 1 invalid), `reconstructForecastAccuracy` (5 worked cases), `selectNotableAccuracyRows` (5 cases including a hand-built `row()` test factory producing a full `TaggedForecastAccuracy` with a synthetic `reconstructedForecast`). All pass.

### New: `lib/monthly-review-build.ts`
DB-touching, not `"use server"`. Exports `ReviewData` (the single source of truth for the shape, extended additively per the plan) and `async buildMonthlyReviewData(period)`. Consolidates what were two separately-drifted implementations (`actions/monthly-review.ts`'s and the cron route's) into one, per the plan's explicitly-approved "Discovered issue" resolution:
- Budget health block: kept the existing `tagSpendRows` query (with `archivedAt`/`transferPairId` filters), added a `spendDecimalMap` built from the same rows (no extra query), added a trailing-history query (`queryTagHistory` helper, entity+tag scoped, same shape as `checkBudgetPace`'s `historyRows` in `lib/notifications.ts` but grouped by `entityId` too), and calls `projectPeriodEndSpend` per budget row to derive `projectedCents`/`projectedPercentUsed`/`forecastConfidence`/`forecastMethod`.
- Account snapshot / upcoming bills / accrual status: moved verbatim from `actions/monthly-review.ts`'s (pre-existing) logic — the version with correct `archivedAt`/entity-scoping, per the plan's explicit instruction to keep that one over the cron route's.
- Retrospective forecast accuracy block: computes `priorPeriod = previousPeriod(period)`, short-circuits to `forecastAccuracyPeriod: null, forecastAccuracy: []` when the prior period has no budget rows, otherwise queries full-period actuals, midpoint-partial totals, and trailing history (three queries run via `Promise.all`), builds `TaggedForecastAccuracy[]`, and narrows via `selectNotableAccuracyRows`.
- Two small internal helpers (`monthBounds`, `queryTagSpend`, `queryTagHistory`) factor out the query shapes reused between the forward and retrospective blocks (the forward block still inlines its own `tagSpendRows` query since it also needs the non-Decimal `spendMap` cents shape for `actualCents`; `queryTagSpend` is only used by the retrospective block which needs plain Decimal maps).

### Modified: `actions/monthly-review.ts`
Slimmed to: `requireAuth()` → period-format validation (still returns `{ error }` on mismatch, unchanged behavior) → `buildMonthlyReviewData(period)` → the existing `db.monthlyReview.upsert(...)` → `revalidatePath(...)` → `{ success: true }`. Local `ReviewData` interface and all inline query blocks removed. Confirmed nothing external imports the type from this file (only the `generateMonthlyReview` function is imported, by `components/monthly-review/generate-button.tsx`).

### Modified: `app/api/cron/monthly-review/route.ts`
Kept the bearer-secret check and `prevPeriod()` as-is. Replaced the entire inline computation block with `buildMonthlyReviewData(period)`, then the existing upsert and notification-firing block, now reading `data.budgetHealth`/`data.accountSnapshot`/`data.accrualStatus` off the shared shape. Field names (`status`, `pct`) lined up exactly — no changes needed in the notification body. Removed now-unused `computeBudgetSummary` and `Decimal` imports. This incidentally fixes the three pre-existing divergences flagged in the plan's Risks/unknowns #3:
- Missing `transferPairId IS NULL` filter in the cron route's spend/accrual queries (internal transfers were being counted as spend in cron-generated reviews) — now filtered, matching the manual path.
- Accrual pro-rata previously used the *current calendar month* (`now.getUTCMonth()+1`) instead of the *target period's* month — now uses the target period's month (the kept `actions/monthly-review.ts` logic), so cron-generated reviews' accrual pacing is correct for the period they're actually reviewing.
- `entityName` previously used `entity.name.split(",")[0]` in the cron path vs. the full `entity.name` in the manual path — now consistently the full name everywhere.

### Modified: `app/review/[year]/[month]/page.tsx`
- Replaced the local `interface ReviewData` with `import type { ReviewData } from "@/lib/monthly-review-build"`.
- Added a `projectedStatus(pct)` helper (reusing `STATUS_COLORS`, not a stored field) and a `confidenceLabel(confidence)` helper (`"low confidence"` / `"medium confidence"` / `null` for high — never suppresses the row).
- Budget health table: added a "Projected" column. Guards `b.projectedCents != null && b.projectedPercentUsed != null` per-row (old stored rows without the field render `—` instead of `$0`/`NaN`). Shows `~$X (Y%)` with the `(Y%)` colored via `projectedStatus`, plus a muted confidence label line when not "high".
- New "Forecast accuracy" card, rendered only when `data.forecastAccuracy?.length` is truthy (guarded with `data.forecastAccuracy && data.forecastAccuracy.length > 0` so old rows lacking the field entirely don't crash); title `Forecast accuracy — {data.forecastAccuracyPeriod}`; intro copy uses the "what the current projection model would have estimated... not necessarily what was shown to you at the time" framing per the plan's ground-rule-8 concern. Empty/null state renders a muted note instead of the card. Table columns: Category, Entity, Projected, Actual, Miss (`percentOff%` or `fmtMoney(missCents)` when `percentOff` is `null`), and a "Notes" column with `DIRECTION_COPY[direction]` plus the same confidence-label convention.

## Deviations from the plan

None of substance. Two implementation-detail choices the plan left open (it explicitly said markup/exact wording was up to the Coder):
1. Put the retrospective card's per-row observational caption in its own labeled "Notes" table column rather than an unlabeled cell, for header/cell alignment consistency with the rest of the page's tables.
2. `lib/monthly-review-build.ts`'s forward-projection block still runs its own inline `tagSpendRows` query (identical to the pre-existing one) rather than routing through the new `queryTagSpend` helper, because it additionally needs the cents-rounded `spendMap` used for `actualCents` (a shape `queryTagSpend`, which returns signed Decimal only, doesn't produce) — no behavior difference, just avoided a redundant second query or an awkward dual-return helper signature.

## Commands run and their results

- `pnpm vitest run lib/__tests__/review-forecast.test.ts` — 19/19 passed (run first, before wiring up the DB-touching module, to validate the pure logic in isolation).
- `pnpm typecheck` (`tsc --noEmit`) — clean, no output, exit 0.
- `pnpm lint` — 44 warnings, 0 errors. All 44 are in files I did not touch (verified by reading the full output and cross-checking file paths against my change list); matches this repo's known pre-existing warning baseline per agent memory. No new warnings introduced by any file in this change.
- `pnpm test` (`vitest run`, full suite) — **381 passed, 0 failed, across 33 files** (up from the stated baseline of 362/362 across 32 files — exactly 362 + 19 new tests, 32 + 1 new file, zero regressions).
- `git diff --stat lib/spend-forecast.ts lib/budget-pace.ts` — empty (confirmed byte-identical to `main`, per acceptance criteria).
- `git status` — confirmed the only files I modified are `actions/monthly-review.ts`, `app/api/cron/monthly-review/route.ts`, `app/review/[year]/[month]/page.tsx`, plus the three new files (`lib/review-forecast.ts`, `lib/__tests__/review-forecast.test.ts`, `lib/monthly-review-build.ts`). All other modified/untracked files shown in `git status` (e.g. `actions/reports.ts`, `app/business/...`, `components/app-sidebar.tsx`, the bank-statements feature) predate this session and were left untouched.

## Open items

- **UI verification (plan Risks/unknowns #7, acceptance criteria):** I have no browser access. A human needs to visually verify the rendered "Budget health" table's new Projected column (including a `~` low-confidence row if reachable in current data) and the "Forecast accuracy" card in both its populated and empty states.
- **Manual/scripted spot-check (plan's Test expectations, "Integration/manual"):** the acceptance criterion asking to generate the same period via both the "Generate/Regenerate" button and a simulated cron-shaped call (bearer secret) and diff the stored `MonthlyReview.data` JSON is a Tester-owned manual check per the plan, not something I ran myself — flagging it explicitly so it isn't silently skipped.
- No new Prisma model/migration was added, matching the plan's explicit reasoning (Risks/unknowns #1). `prisma/schema.prisma` and `prisma/migrations/` are unmodified by this task (the pre-existing untracked `20260908120000_bank_statements` migration in `git status` is from unrelated prior work).
- No backfill of old `MonthlyReview` rows, per plan Risks/unknowns #4 — old rows will render without the new sections (guarded, not crashing) until regenerated.

## Files touched (absolute paths)

- New: `D:\Repos\Personal\kinniburgh-finance\lib\review-forecast.ts`
- New: `D:\Repos\Personal\kinniburgh-finance\lib\__tests__\review-forecast.test.ts`
- New: `D:\Repos\Personal\kinniburgh-finance\lib\monthly-review-build.ts`
- Modified: `D:\Repos\Personal\kinniburgh-finance\actions\monthly-review.ts`
- Modified: `D:\Repos\Personal\kinniburgh-finance\app\api\cron\monthly-review\route.ts`
- Modified: `D:\Repos\Personal\kinniburgh-finance\app\review\[year]\[month]\page.tsx`
