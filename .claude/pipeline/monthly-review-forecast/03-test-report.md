# Test Report: monthly-review-forecast

## Verdict: PASS

## Acceptance criteria checklist

- [x] **`lib/review-forecast.ts` exports the specified functions/constants with matching signatures.**
  Confirmed by reading the file: `previousPeriod`, `periodMidpointDate`, `reconstructForecastAccuracy`, `selectNotableAccuracyRows`, `REVIEW_FORECAST_TRAILING_MONTHS` (3), `MAX_ACCURACY_ROWS` (5), `MIN_NOTABLE_MISS_AMOUNT` ($10) all present and match the plan's Step-1 signatures.

- [x] **`lib/spend-forecast.ts` and `lib/budget-pace.ts` are unmodified.**
  `git diff --stat lib/spend-forecast.ts lib/budget-pace.ts` produced empty output (exit 0, no changes).

- [x] **`lib/monthly-review-build.ts` exports `ReviewData`/`buildMonthlyReviewData(period)`, is imported by both callers, and both callers produce identical shapes.**
  Read both diffs directly (`actions/monthly-review.ts`, `app/api/cron/monthly-review/route.ts`) — neither retains any inline query/computation block; both call `await buildMonthlyReviewData(period)` and only differ in their own auth mechanism (session vs. bearer secret) and side effects (upsert/revalidate vs. upsert/notify). Also ran a live read-only spot-check against the real Supabase DB (see "Tests run" below): called `buildMonthlyReviewData("2026-09")` twice and diffed the JSON (minus `generatedAt`) — byte-identical. `prisma/schema.prisma` unmodified (empty diff); `prisma/migrations/` only shows the unrelated pre-existing `20260908120000_bank_statements` migration from a different in-flight task.

- [x] **Each `budgetHealth` row includes the four new fields, never suppressed by confidence.**
  Confirmed by code (unconditional `.map` over all budgets, no confidence-based filter) and by live data — sample row for period `2026-09` shows all four fields (`projectedCents: 8226, projectedPercentUsed: 82, forecastConfidence: "high", forecastMethod: "blended"`) on a row with `actualCents: 0` (i.e., a low-actual row that a suppression rule might have dropped, but wasn't).

- [x] **`forecastAccuracy` capped at 5, all `confidence !== "low"`, all `missCents` above the $10 floor; `forecastAccuracyPeriod` null with empty array when prior period has no budgets.**
  Confirmed via unit tests (5 `selectNotableAccuracyRows` cases, all passing) and via live-DB run against `2026-09`: 5 rows returned, `confidence` was `"high"`/`"high"`/`"medium"`/`"high"`/`"medium"` (never `"low"`), all `missCents` > 1000 ($10), sorted strictly descending by `missCents` (209791 → 191303 → 69720 → 67003 → 57194). The empty-prior-budgets case is exercised by `buildMonthlyReviewData`'s `if (priorBudgets.length > 0)` guard (read directly) — not independently DB-tested since no period in the live data currently lacks prior budgets, but the code path is unambiguous on read.

- [x] **Review page renders projected column + confidence labeling on every row, and forecast-accuracy card (or empty-state), without crashing on old stored rows.**
  Read `app/review/[year]/[month]/page.tsx` in full. Guards present exactly as claimed: `b.projectedCents != null && b.projectedPercentUsed != null` (falls back to a muted `—` otherwise, never `$0`/`NaN`), and `data.forecastAccuracy && data.forecastAccuracy.length > 0` (falls back to the muted empty-state note, not a crash, when the field is entirely absent — i.e. `undefined` on an old stored row — since `undefined && ...` short-circuits to falsy). No unguarded top-level access to any new field found via grep of the whole file.

- [x] **`pnpm typecheck`, `pnpm lint`, `pnpm test` all pass clean; full suite grows from baseline with zero regressions.**
  Ran all three myself — see "Tests run" below. `tsc --noEmit` clean/exit 0. Lint: 44 warnings, 0 errors, all 44 in files untouched by this task (cross-checked file paths against the diff). Full suite: 381/381 passed across 33 files (was 362/362 across 32 files per the Coder's claimed baseline — new file adds exactly 19 tests, consistent).

- [ ] **Human visual verification of the rendered page.**
  Not performed — no browser access in this environment, and the plan itself (Risks/unknowns #7) flags this as requiring a human. Not counted against the verdict since the plan explicitly scopes this as a separate, human-only step, but flagging it as outstanding per the plan's own acceptance criteria wording.

## Tests run

```
cd D:/Repos/Personal/kinniburgh-finance
pnpm typecheck
# $ tsc --noEmit  — no output, exit 0

pnpm lint
# ✖ 44 problems (0 errors, 44 warnings)
# All 44 in pre-existing files not touched by this task (app/personal/mortgage/mortgage-client.tsx,
# components/dashboard/category-drilldown-modal.tsx, components/insurance/insurance-policy-card.tsx,
# lib/encrypt.ts, prisma/seed.ts, etc.) — none in lib/review-forecast.ts, lib/monthly-review-build.ts,
# actions/monthly-review.ts, app/api/cron/monthly-review/route.ts, or the review page.

pnpm test
# Test Files  33 passed (33)
#      Tests  381 passed (381)
# includes: lib/__tests__/review-forecast.test.ts (19 tests) — all pass
```

Live read-only DB spot-check (per this repo's `.claude/agent-memory/tester/live-db-readonly-verification-technique.md`):
wrote a temporary `.mjs` script in the repo root (`node --import tsx`), imported `buildMonthlyReviewData` from
`lib/monthly-review-build.ts` directly, called it against the real Supabase DB for period `2026-09` (the current
in-progress period, with prior period `2026-08` also having budget rows), deleted the script immediately after
(`git status --porcelain` confirmed no leftover file). No writes were performed (`buildMonthlyReviewData` only
builds and returns; it does not upsert).

- Called it twice for the same period and diffed the JSON (`generatedAt` stripped since it's a timestamp) — **byte-identical**, confirming determinism and that there's no residual path-dependent branching.
- `budgetHealth`: 53 rows, e.g. `{tagName: "Electricity", entityName: "Sudden Valley Property Management, LLC", budgetedCents: 10000, actualCents: 0, projectedCents: 8226, projectedPercentUsed: 82, forecastConfidence: "high", forecastMethod: "blended"}` — full entity name (not truncated/split), all four new fields present.
- `forecastAccuracyPeriod`: `"2026-08"`, `forecastAccuracy`: 5 rows (capped correctly), confidences `["high","medium","high","high","medium"]` (never `"low"`), `missCents` all > 1000 and strictly descending (209791, 191303, 69720, 67003, 57194), and one row (`Auto Insurance`, `actualCents: 0`) exercising the `percentOff === null` div-by-zero guard on real data.

## Tests added

None — `lib/__tests__/review-forecast.test.ts` (19 tests) already covers every case the plan's Step 2 enumerated (`previousPeriod` 3+1, `periodMidpointDate` 4+1, `reconstructForecastAccuracy` 5 worked Decimal cases, `selectNotableAccuracyRows` 5 cases). I hand-recomputed all 5 `reconstructForecastAccuracy` cases and the `selectNotableAccuracyRows` capping case by hand (see "Not tested" / hand-verification below) rather than trusting the assertions, and they match exactly — I did not find a gap in coverage worth adding a new test for. The live-DB spot-check above substitutes for the plan's suggested "generate a period both ways and diff" manual check, per the plan's own instruction that this should be a scripted spot-check rather than a new automated test file.

## Hand-verification of `reconstructForecastAccuracy` (not just trusting `pnpm test`)

Re-derived algebraically for period `"2026-09"` (30 days, midpoint day 15, so `daysElapsed = daysRemaining = 15`):

- **Case 2 (under)**: `pace = -500*30/15 = -1000`; `trailingAvg = avg(-300,-280,-320) = -300`; `blended = (-1000*15 + -300*15)/30 = -650`; `projected = 650`; `actual = |-800| = 800`; `missAbs = 150`; `percentOff = round(150/800*100) = round(18.75) = 19`; `800 > 650` ⇒ `"under"`. Matches test exactly.
- **Case 3 (over)**: `pace = -1000*30/15 = -2000`; `blended = (-2000*15 + -300*15)/30 = -1150`; `projected = 1150`; `actual = 700`; `missAbs = 450`; `percentOff = round(450/700*100) = round(64.28) = 64`; `1150 > 700` ⇒ `"over"`. Matches.
- **Case 4 (low confidence)**: no history ⇒ `trailingAverage = null` ⇒ `method = "pace_only"`, `projected = pace = -200*30/15 = -400` ⇒ `400`. `actual = 380`. `missAbs = 20`, `percentOff = round(20/380*100) = 5`. `confidence`: `monthsUsed = 0` ⇒ `"low"`. Matches — and confirms this case exists specifically to test that `selectNotableAccuracyRows` excludes on *confidence*, not magnitude (its `missAbs=20` clears the $10 floor).
- **Case 5 (div-by-zero guard)**: `actualFinal = 0` ⇒ `actual.isZero()` ⇒ `percentOff = null`, not `NaN`/`Infinity`. Confirmed the guard is a real `isZero()` check, not a silent `0/0` that vitest happened not to catch.

Also confirmed `reconstructForecastAccuracy` passes `asOfDate: periodMidpointDate(period)` (not `new Date()`) and `history` is only ever populated by the caller (`lib/monthly-review-build.ts`) with periods **strictly before** the target period via `historyStart..priorStart`-bounded queries — i.e. the retrospective reconstruction genuinely only sees transaction data that existed as of the reconstructed midpoint (`spendAtMidpoint`, itself computed from a `priorStart..midpointExclusive`-bounded query) plus trailing history from *before* the period being evaluated. It never sees the full period's actual total during reconstruction — `actualFinal` is only compared against the result afterward, not fed into the projection. This is not retroactively omniscient.

## Bug-fix verification (the three specific fixes the plan called for)

All three read directly in `lib/monthly-review-build.ts` and confirmed absent from the old inline cron computation (via `git diff`):

1. **`transferPairId` filter on transaction-sum queries** — present in all three query sites (`tagSpendRows` inline query, `queryTagSpend`, `queryTagHistory`): `AND t."transferPairId" IS NULL`. The old cron route's `tagSpendRows` query (visible in the diff's removed lines) had no such filter.
2. **Accrual pro-rata uses the target period's month** — `const proRataCents = Math.round((targetCents * month) / 12)` where `month` is parsed from the `period` argument, not `new Date()`. The old cron code (removed lines in the diff) used `now.getUTCMonth() + 1`, which for a cron run is always the *current* calendar month, off by one from the period actually being reviewed (`prevPeriod()`).
3. **Entity names full/consistent** — `entityName: b.entity.name` (no `.split(",")`) in the shared builder. The old cron code (removed lines) used `entity.name.split(",")[0]`. Confirmed on live data: `"Sudden Valley Property Management, LLC"` renders in full from the shared builder, not truncated to `"Sudden Valley Property Management"`.

## Ground rule 8 (no financial-advice language) — shipped copy review

Read the actual rendered strings in `app/review/[year]/[month]/page.tsx`:
- Projected column: `~$X (Y%)` + optional `"low confidence"`/`"medium confidence"` label — purely descriptive, no imperative/advice language.
- Forecast-accuracy card intro: *"What the current projection model would have estimated partway through {period}, compared to what actually happened — not necessarily what was shown to you at the time."* — correctly hedges against implying this was actually displayed historically, factual framing.
- Per-row notes: `"Projected higher than actual"` / `"Projected lower than actual"` / `"Close match"` — observational, not prescriptive. No new instance of "you should"/"you will"/investment or tax guidance language anywhere in the diff.

## Scope check

Diffed current `git status --porcelain -uall` against the session-start snapshot given at the top of this conversation. They match exactly outside this task's declared files (`lib/review-forecast.ts`, `lib/__tests__/review-forecast.test.ts`, `lib/monthly-review-build.ts`, `actions/monthly-review.ts`, `app/api/cron/monthly-review/route.ts`, `app/review/[year]/[month]/page.tsx`) — all other modified/untracked entries (bank-statements feature, balance-sheet changes, `.claude/agent-memory/` growth, etc.) were already present before this task started and are unrelated in-flight work from other pipeline tasks.

## Defects found

None that block this task. One minor, non-blocking observation:

- **Undisclosed accrual-status threshold change in cron-generated reviews** (severity: cosmetic/informational, not a defect). The old cron route's inline accrual-status thresholds were `pct < 70 ⇒ "behind"`, `pct < 90 ⇒ "watch"`, else `"on_track"`. The consolidated `buildMonthlyReviewData` uses the `actions/monthly-review.ts` thresholds (`pct >= 90 ⇒ "on_track"`, `pct >= 60 ⇒ "watch"`, else `"behind"`) — a 60% cutoff instead of 70%. This is a real behavior change to cron-generated reviews' accrual badges (a `pct` in `[60,70)` now shows `"watch"` instead of `"behind"`). It's squarely covered by the plan's own Step 3 instruction to "move unchanged from `actions/monthly-review.ts`'s current logic (this is the version to keep...)" for the whole accrual-status block, so it's sanctioned by the plan even though the plan's Risks/unknowns #3 only itemized three specific divergences by name and didn't call out this fourth one explicitly. Not a defect in the implementation — flagging only because the plan's own disclosure list was incomplete, in case the user wants it called out in review.

## Not tested

- **Human visual verification of the rendered page** (populated/empty forecast-accuracy states, low-confidence badge) — no browser access in this environment; the plan itself flags this as a required separate human step (Risks/unknowns #7), not something any pipeline agent can do.
- **`forecastAccuracyPeriod === null` / empty-`forecastAccuracy` path on real data** — every period currently in the live DB has prior-period budget rows, so I could not exercise the "first review ever generated" branch against real data. Verified instead by reading the code (`if (priorBudgets.length > 0)` guard, unambiguous) and by the page's guarded rendering (`data.forecastAccuracy && data.forecastAccuracy.length > 0` correctly falls through to the empty-state note for `[]` or `undefined`).
- **Actual rendering of an old stored `MonthlyReview` row lacking the new fields** — no old rows exist in the live DB to render against (the review page pulls whatever's stored; I did not fabricate/insert a synthetic old-shaped row into production data, per ground rule 1's spirit of not writing test data into the real household's DB). Verified via static code read instead (guards confirmed present and correctly short-circuit on `undefined`).
- **Cron route's actual bearer-secret-authenticated HTTP path end-to-end** (i.e. an actual `curl` against a running `next dev` server hitting `/api/cron/monthly-review`) — not run; verified the route's logic by reading it directly instead, which is sufficient given `buildMonthlyReviewData` was already independently verified live.
