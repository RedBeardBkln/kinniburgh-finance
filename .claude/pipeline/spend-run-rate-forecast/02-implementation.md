# Implementation: Spend run-rate forecast (trend-based projection)

## Summary of changes

- **`lib/spend-forecast.ts`** (new) — Core projection module, pure functions, no
  DB/Prisma imports, no `"use server"`. Exports `MonthlySpendPoint`,
  `ForecastMethod`, `ForecastConfidence`, `SpendForecast`,
  `computeTrailingAverage`, and `projectPeriodEndSpend`, matching the plan's
  signatures exactly.
  - `daysInPeriodMonth` / `daysElapsedInPeriod` — internal date helpers, copied
    verbatim from the plan (mirrors `period-balance-sheet.ts`'s `monthRange`
    last-day calc and `forecast.ts`'s unexported helper pattern).
  - `computeTrailingAverage` — exported, dedupes by period (last wins), only
    considers periods strictly before the target period, caps at
    `trailingMonths`, returns `{ average: null, monthsUsed: 0 }` when there's no
    qualifying history or `trailingMonths <= 0`. Implemented verbatim from the
    plan.
  - `projectPeriodEndSpend` — validates `period` against `/^\d{4}-\d{2}$/` and
    throws a descriptive `Error` otherwise; clamps `trailingMonths =
    Math.max(0, opts.trailingMonths ?? 3)`; computes `paceProjection =
    spendToDate * daysInPeriod / daysElapsed`; blends with the trailing average
    when one exists (`method: "blended"`), otherwise falls back to
    `paceProjection` alone (`method: "pace_only"`); sets `confidence` from
    `monthsUsed` vs. `trailingMonths`. **One deviation from the plan's literal
    arithmetic — see "Deviations from the plan" below.**
  - Assumptions/limitations comment block placed directly above
    `projectPeriodEndSpend`, covering all four points required by the plan
    (observational/not-advice framing, day-of-month concentration limitation,
    trailing average excludes the current period, callers must omit $0/no-data
    months from `history`) — satisfies CLAUDE.md ground rule 8.

- **`lib/__tests__/spend-forecast.test.ts`** (new) — Vitest unit tests using the
  `D()`/`d()` helper conventions from `budget.test.ts` and `forecast.test.ts`
  (`D = (s: string) => new Decimal(s)`, dates as `new Date(iso +
  "T00:00:00Z")`). Implements all 9 test groups from the plan's Test
  expectations section verbatim, including the `computeTrailingAverage` direct
  unit tests as a separate `describe` block. 15 test cases total.

No other files were touched. `git status` on `lib/spend-forecast.ts` and
`lib/__tests__/spend-forecast.test.ts` is the only diff introduced by this task;
all other working-tree changes present at task start (from prior work) are
untouched.

## Deviations from the plan

**One deviation, in the blend arithmetic inside `projectPeriodEndSpend`, with a
strong reason.**

The plan's literal algorithm (section 3c) computes the blend weight as a raw JS
number:

```ts
const paceWeight = daysElapsed / daysInPeriod;
projectedTotal = paceProjection.times(paceWeight).plus(trailingAverage.times(1 - paceWeight));
```

Implemented exactly as written, this fails the plan's own **Test 5** ("tag
already over its historical norm"), where `daysElapsed = 10`, `daysInPeriod =
30`, so `paceWeight = 10/30 = 0.3333333333333333` — a non-terminating binary
float approximation of ⅓. Multiplying that through `Decimal` produces
`-699.99999999999996`, not the plan's specified exact `"-700"`. I ran the
literal version first and confirmed this failure via `pnpm test` before
changing anything (see Commands run below).

Fix: replaced the two-step "materialize a float weight, then multiply" with a
single algebraically-equivalent `Decimal` division done once, at the end:

```ts
const daysRemaining = daysInPeriod - daysElapsed;
projectedTotal = paceProjection
  .times(daysElapsed)
  .plus(trailingAverage.times(daysRemaining))
  .div(daysInPeriod);
```

This is `paceProjection × w + trailingAverage × (1 − w)` for `w = daysElapsed /
daysInPeriod`, rearranged so the division by `daysInPeriod` happens exactly
once, after summing two exact integer-scaled `Decimal` products, instead of
being computed early as a lossy JS float and then propagated through two
separate `Decimal` multiplications. It produces bit-for-bit-in-decimal-string
identical results to the plan's intent for every test case in the plan
(verified: Tests 1, 2, 3, 5, 6 all match the plan's specified exact strings /
`toBeCloseTo` values), and is exact for Test 5 specifically. No test
expectation, output type, method/confidence logic, or public signature changed
— this is purely an internal arithmetic-order fix to make the specified exact
outputs actually hold. Documented in a code comment at the call site pointing
back to this section.

I considered instead loosening Test 5's assertion to `toBeCloseTo` (matching
how Test 3 already tolerates float imprecision), which would have kept the
plan's arithmetic untouched. I chose the arithmetic fix instead because the
plan explicitly marked Test 5's `"-700"` as **exact** (unlike Test 3, which the
plan itself flags as approximate), and preserving an exact-match guarantee for
the household-facing "over budget" scenario seemed like the more load-bearing
correctness property to keep than the letter of the intermediate weight
computation. If this judgment call is wrong, it's a one-line revert back to the
plan's literal form plus loosening the Test 5 assertion.

No other deviations. All other algorithm details (validation regex, day-count
helpers, dedup/cap/exclude logic in `computeTrailingAverage`, method/confidence
assignment, the assumptions comment block) match the plan exactly.

## Commands run and their results

- `pnpm typecheck` — clean, zero errors (ran twice: once before, once after the
  arithmetic fix; both clean).
- `pnpm lint` — zero errors overall; 45 pre-existing warnings in unrelated
  files (React hooks / unused-vars in components, seed script, other test
  files) that predate this task and are untouched by it. Confirmed via `grep
  -i "spend-forecast"` on the lint output that neither new file produced any
  warning or error.
- `pnpm test` (full suite):
  - First run (plan's literal arithmetic): 27 files, 304 tests, **1 failed** —
    `spend-forecast.test.ts > projectPeriodEndSpend > 5. tag already over its
    historical norm` — `expected '-699.99999999999996' to be '-700'`. This is
    the float-precision issue described above.
  - After the arithmetic fix: **28 files passed (28), 304 tests passed (304)**,
    zero failures. 289 baseline + 15 new tests in `spend-forecast.test.ts`,
    zero regressions elsewhere.

## Open items

- The plan's own Risk #1 (flagged, not something I resolved): the "already
  over budget" test case is satisfied by feeding `spendToDate` that already
  exceeds the trailing average, per the plan's explicit design (no budget
  parameter in this module). If a budget-vs-forecast comparison was actually
  wanted here, that's a scope question for the requester to confirm before the
  follow-up wiring task — not something I changed.
- Per plan scope, `lib/notifications.ts` wiring (a `checkSpendTrend`-style
  check) is a deliberate follow-up, not touched here.
- The arithmetic deviation above should be double-checked by the
  Tester/Reviewer against the plan's intent — I'm confident it's mathematically
  equivalent and produces the plan's specified exact outputs, but flagging it
  explicitly since the plan said "implement as written, no design decisions
  left open" and I made one narrow decision to fix a precision bug the literal
  form has.
