# Test Report: forecast-budget-alerts

## Verdict: PASS

## Acceptance criteria checklist

1. **`lib/budget-pace.ts` exports the required surface, no DB imports, no `"use server"`.** PASS.
   Read the file directly: exports `PACE_TRAILING_MONTHS` (3), `PACE_SUPPRESS_AT_PERCENT_USED` (80),
   `PACE_OVERAGE_MARGIN` (0.05), `BudgetPaceEvaluation`, `evaluateBudgetPace`. Only import is
   `Decimal` from `@prisma/client/runtime/library` and `projectPeriodEndSpend`/types from
   `./spend-forecast` — no `db`/Prisma client import, no `"use server"` directive.

2. **Suppression guards match plan spec, in the plan's exact order, with correct boundaries.** PASS.
   Read `evaluateBudgetPace` line by line: order is (a) `effectiveBudget.lessThanOrEqualTo(0)` →
   (b) `percentUsed >= PACE_SUPPRESS_AT_PERCENT_USED` (80) → (c) `forecast.confidence === "low"` →
   (d) materiality margin `!projectedTotal.abs().greaterThan(effectiveBudget.abs() * 1.05)` (strict `>`
   required to fire). This is exactly the plan's specified order and thresholds. Hand-verified the
   arithmetic behind the test fixtures (not just "tests pass"):
   - Test 1: paceProjection = -200×30/10 = -600, trailingAverage = -900, blended = (-600×10 + -900×20)/30
     = -800 — matches `projectedTotal` assertion; overage = |−800| − |600| = 200 — matches.
   - Test 4 boundary: `percentUsed: 80` exactly is suppressed (`>=`, not `>`) — confirmed test exercises
     this exact boundary, not just an "above 80" case.
   - Test 6 boundary: 2% over (no fire), exactly 105% of budget / 5% over (no fire, strict `>` required),
     6% over (fires) — hand-verified all three: steady-state fixture makes paceProjection ==
     trailingAverage == the target X regardless of day-weighting, so projectedTotal is exactly X in each
     case; threshold = 1000×1.05 = 1050; 1020 and 1050 both fail `> 1050`, 1060 passes. Confirms the
     `>` vs `>=` boundary is pinned correctly, not just approximately tested.
   - Tests 7/8 (zero/negative budget): guard fires first (before percentUsed/confidence checks would
     even matter), `fire: false`, `forecast.projectedTotal` is neither NaN nor Infinite — confirmed.

3. **`evaluateBudgetPace` fires correctly when no suppression applies and overage > 5%.** PASS.
   Verified test 1 (high confidence, 33% used, blended -800 vs 600×1.05=630, fires, overage 200) and
   test 2 (medium confidence 2/3 months, blended -600 vs 500×1.05=525, fires, overage 100) by hand —
   confidence "medium" is correctly NOT suppressed (only "low" is gated), matching decision 3.

4. **`checkBudgetOverspend` is genuinely untouched.** PASS.
   `git diff -- lib/notifications.ts` shows only an addition (114 insertions, 2 deletions — the 2
   deletions are the import-block lines being re-flowed to add the new import). The entire
   `checkBudgetOverspend` function body (lines 85–138) shows zero changed lines in the diff; the new
   `checkBudgetPace` function is inserted as a new block immediately after it. `lib/__tests__/notifications.test.ts`
   is untouched (`git diff --stat` on it produces no output) and its 9 tests still pass unmodified.

5. **`scopeKey` collision check.** PASS.
   `checkBudgetOverspend` uses `overspend:${budget.tagId}:${period}` (line 120); `checkBudgetPace` uses
   `pace:${budget.tagId}:${period}`. Distinct string prefixes mean `alreadyNotifiedToday`'s
   `payload: { path: ["scopeKey"], equals: scopeKey }` lookup can never match across the two checks —
   confirmed by reading `alreadyNotifiedToday`'s exact-match query, not just eyeballing the literals.

6. **Ground rule 8 compliance (observational, not advice).** PASS.
   Read the actual shipped body template in `lib/notifications.ts`: `"{tag} is on pace to reach {X} by
   month end, above the {budget} budget — projected from {spent} spent so far plus the last {N}
   month(s) of history."` — purely descriptive/observational, no imperative or advice verbs ("should",
   "cut back", "consider", "you need to"). Matches decision 4's template exactly, byte for byte.

7. **`pnpm typecheck`, `pnpm lint`, `pnpm test` all pass clean.** PASS — ran all three myself (not
   trusting the Coder's reported numbers):
   - `pnpm typecheck` → `tsc --noEmit`, zero output, clean.
   - `pnpm lint` → 0 errors, 45 warnings. Scanned the full warning list: all are in files untouched by
     this task (React hooks set-state-in-effect warnings, unused vars in unrelated components/pages/seed
     script). No warning references `budget-pace`, `notifications.ts`, or the cron route.
   - `pnpm test` (`vitest run`) → **317 passed, 317 total, 29 files**, 0 failed, 0 skipped. Confirmed
     `lib/__tests__/budget-pace.test.ts` ran with exactly 10 tests, all green, and
     `lib/__tests__/notifications.test.ts` ran unmodified with its original 9 tests, all green.

8. **No Prisma schema changes, no new dependencies attributable to this task.** PASS.
   `git diff --stat -- package.json pnpm-lock.yaml prisma/schema.prisma` shows no change to
   package.json/pnpm-lock.yaml at all, and the only `prisma/schema.prisma` diff (36 insertions) is the
   pre-existing, unrelated `BankStatement` model addition from a different in-flight task (present in
   the git status snapshot at the very start of this conversation, before this task's Tester review
   began) — not something introduced by this task's Coder.

## Scope verification (task instruction #6)

Compared `git status --porcelain -uall` against the session-start `gitStatus` snapshot given in the
system reminder at the top of this conversation: **identical, line for line.** No file outside the
snapshot appears modified or newly untracked. This confirms the only deltas attributable to this task
are exactly the plan's declared files: `lib/budget-pace.ts` (new), `lib/__tests__/budget-pace.test.ts`
(new), `lib/notifications.ts` (modified), `app/api/cron/notifications/route.ts` (modified). Everything
else in the dirty tree (CLAUDE.md, actions/reports.ts, balance-sheet/business page changes, bank
statements feature files, prisma schema BankStatement model, etc.) predates this task and is unrelated
to it — consistent with [[pipeline-scope-verification]] memory.

## Tests run

```
pnpm typecheck
  $ tsc --noEmit
  (clean, no output)

pnpm lint
  ✖ 45 problems (0 errors, 45 warnings)
  (all warnings in files untouched by this task)

pnpm test
  Test Files  29 passed (29)
       Tests  317 passed (317)
  lib/__tests__/budget-pace.test.ts (10 tests) ... all passed
  lib/__tests__/notifications.test.ts (9 tests) ... all passed, unmodified file
```

## Tests added

None added by the Tester. `lib/__tests__/budget-pace.test.ts` (written by the Coder) was reviewed
line-by-line against the plan's 10 required test-expectation cases and found to cover all of them,
including the specific boundary cases the plan called out as most likely to be gotten wrong by a naive
implementation:
- Exact `percentUsed === 80` boundary (suppressed, `>=` not `>`) — present (test 4).
- Exact 5%/105%-of-budget margin boundary (not fired, strict `>` required) plus a just-over-margin case
  (6% over, fires) — present (test 6), and I independently re-derived the arithmetic by hand rather than
  trusting the assertions at face value (see criterion 2 above).
- "Medium" vs "low" confidence distinction (only "low" suppresses) — present (test 2 vs test 3).
- Zero and negative `effectiveBudget` guards, no NaN/Infinity — present (tests 7, 8).
- `forecast` always populated across suppressed paths — present (test 9).
- `trailingMonths` override changing the fire outcome — present (test 10), hand-verified the -610
  blended result for the override case.

I did not find a coverage gap worth adding a new test for. The one thing I verified by hand rather than
by adding a new test: whether `evaluateBudgetPace` computing `projectPeriodEndSpend` *before* the
zero/negative-budget and percentUsed guards (rather than after, as one reading of the plan's prose
could suggest) causes any behavioral difference. It does not — the plan's own clarifying note requires
`forecast` to be populated on every return path regardless of which guard trips, and computing it
unconditionally upfront satisfies that without changing which guard decides `fire`/`projectedOverageAbs`.
This is a implementation-order nuance, not a defect.

## Defects found

None.

## Not tested

- **`checkBudgetPace` itself against a live/mocked DB.** No integration test exists for it, matching
  the plan's explicit, accepted precedent (`checkCardPaymentsDue`/`checkCcFundingShortfall` are also
  untested at that layer) and this repo's stated "no DB in unit tests" convention. This means a
  wiring-level mistake (wrong `Map` key from the raw SQL alias, wrong date-window arithmetic in the
  live `Date.UTC` calls, actual Postgres `to_char` behavior) is not exercised by `pnpm test` and would
  only surface against a real database. I did not have a way to spin up Postgres in this environment to
  close that gap, and the plan explicitly scoped this out rather than leaving it ambiguous.
- **The cron route's actual HTTP behavior** (`app/api/cron/notifications/route.ts`) — verified only by
  reading the diff (import added, added to `Promise.all`, added to the summed `generated` count and the
  JSON response, in the same shape as every other check). Not exercised by an actual request in this
  session; no route-level test exists for this file for any of the other checks either, so this isn't
  a regression in test coverage.
