# Plan: Spend run-rate forecast (trend-based projection)

## Restated goal

Add a pure, unit-tested function that takes a tag's spend-to-date for the current
(in-progress) period plus its recent historical monthly totals, and projects where
that tag's spend will land by the end of the period — blending a linear day-count
pace extrapolation with a trailing-average baseline so a single big early-month
transaction (or a bill that always posts late) doesn't produce a wild projection.
This is a new, standalone `lib/` module with tests only; nothing wires it into
notifications, actions, or the UI in this task.

## Scope

**In scope:**
- New file `lib/spend-forecast.ts`: pure functions, no DB/Prisma imports, no `"use server"`.
- New file `lib/__tests__/spend-forecast.test.ts`: Vitest unit tests, `Decimal`-based,
  mirroring the style of `lib/__tests__/budget.test.ts` and `lib/__tests__/forecast.test.ts`.
- Documenting the projection method's assumptions/limitations directly in the code
  as a comment block (ground rule 8: observational, not advice, not a guarantee).

**Out of scope (explicitly not touched):**
- `lib/notifications.ts` — no new notification check, no wiring into `checkBudgetOverspend`
  or `checkAnomalies`. That's a deliberate follow-up task per the request.
- Any UI/dashboard component, any server action (`actions/*.ts`).
- `prisma/schema.prisma` — no new tables/columns. The function takes plain inputs the
  (future) caller is responsible for querying from the DB.
- Any new dependency. `Decimal` comes from `@prisma/client/runtime/library`, already
  used throughout `lib/budget.ts` and `lib/forecast.ts` — reuse that import, nothing
  from `package.json` needs to change.
- Budget-comparison logic (e.g. "will this exceed the budget line"). The request's
  "already over budget" test case is satisfied by feeding spend-to-date that already
  exceeds the historical trailing average — see Test 5 below — not by adding a
  budget parameter to the function. A dedicated budget-vs-forecast comparison belongs
  with the wiring follow-up task, not this core module.

## Affected files/modules

| File | Change |
|---|---|
| `lib/spend-forecast.ts` | **New.** Core projection module. |
| `lib/__tests__/spend-forecast.test.ts` | **New.** Unit tests. |

No other files are touched.

## Approach

### 1. Types (exported from `lib/spend-forecast.ts`)

```ts
import { Decimal } from "@prisma/client/runtime/library";

/** One prior period's total signed spend for a single tag (e.g. from a
 *  GROUP BY tagId, period query the caller runs against Transaction/TransactionTag).
 *  Only include periods that actually had data — do not pass a $0 entry for a
 *  month with zero transactions; omit it instead (see Risks/unknowns). */
export interface MonthlySpendPoint {
  period: string;   // "YYYY-MM"
  total: Decimal;   // signed; negative = outflow, matching the codebase's Transaction.amount convention
}

export type ForecastMethod = "blended" | "pace_only";
export type ForecastConfidence = "low" | "medium" | "high";

export interface SpendForecast {
  period: string;                  // "YYYY-MM" being forecast (the current, in-progress period)
  daysElapsed: number;              // clamped to [1, daysInPeriod]
  daysInPeriod: number;
  spendToDate: Decimal;             // echoes the input, signed
  paceProjection: Decimal;          // naive linear extrapolation: spendToDate * daysInPeriod / daysElapsed
  trailingAverage: Decimal | null;  // baseline from up to trailingMonths prior periods; null if none available
  trailingMonthsUsed: number;       // how many history points actually fed the baseline (0..trailingMonths)
  projectedTotal: Decimal;          // the headline number — see algorithm below
  method: ForecastMethod;
  confidence: ForecastConfidence;
}
```

### 2. Core function

```ts
export function projectPeriodEndSpend(opts: {
  period: string;                 // "YYYY-MM" — the period being forecast
  spendToDate: Decimal;           // signed sum of this tag's transactions in `period` so far
  asOfDate: Date;                 // the date spendToDate was computed through ("today")
  history: MonthlySpendPoint[];   // prior periods' totals for the same tag; any order, any length, may include duplicates or future/current periods (filtered internally)
  trailingMonths?: number;        // default 3 — how many most-recent qualifying prior periods to average
}): SpendForecast
```

### 3. Algorithm (exact — implement as written, no design decisions left open)

Validate `opts.period` matches `/^\d{4}-\d{2}$/`; throw `new Error("projectPeriodEndSpend: invalid period ...")` if not (this is a general-purpose lib function that may receive bad input, unlike `notifications.ts`'s internal `daysRemaining`, which trusts its caller — validating here is the "should not crash" requirement).

Clamp `trailingMonths = Math.max(0, opts.trailingMonths ?? 3)`.

**a. Days-in-period / days-elapsed helpers** (internal, not exported — same pattern as `forecast.ts`'s unexported `startOfDayUTC`):

```ts
function daysInPeriodMonth(period: string): number {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // mirrors period-balance-sheet.ts's monthRange lastDay calc
}

function daysElapsedInPeriod(period: string, asOfDate: Date): number {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const daysInPeriod = daysInPeriodMonth(period);
  const asOfYear = asOfDate.getUTCFullYear();
  const asOfMonth = asOfDate.getUTCMonth() + 1;
  if (asOfYear < year || (asOfYear === year && asOfMonth < month)) return 1; // period hasn't started — floor at 1, never 0 (avoids div-by-zero)
  if (asOfYear > year || (asOfYear === year && asOfMonth > month)) return daysInPeriod; // period already over — treat as complete
  const day = asOfDate.getUTCDate();
  return Math.min(Math.max(day, 1), daysInPeriod);
}
```

**b. Trailing average helper** (exported — small composable piece, same style as `budget.ts`'s exported `sumActualSpend`):

```ts
export function computeTrailingAverage(
  history: MonthlySpendPoint[],
  period: string,
  trailingMonths: number
): { average: Decimal | null; monthsUsed: number } {
  if (trailingMonths <= 0) return { average: null, monthsUsed: 0 };

  // Dedupe by period (last entry wins) so a caller accidentally passing the
  // same period twice doesn't double-weight it.
  const byPeriod = new Map<string, Decimal>();
  for (const h of history) byPeriod.set(h.period, h.total);

  // Only periods strictly before the target period (string compare works — "YYYY-MM" sorts lexicographically).
  const prior = [...byPeriod.entries()]
    .filter(([p]) => p < period)
    .sort((a, b) => b[0].localeCompare(a[0])) // most recent first
    .slice(0, trailingMonths);

  if (prior.length === 0) return { average: null, monthsUsed: 0 };

  const sum = prior.reduce((acc, [, total]) => acc.plus(total), new Decimal(0));
  return { average: sum.div(prior.length), monthsUsed: prior.length };
}
```

**c. Main function body:**

```ts
const daysInPeriod = daysInPeriodMonth(opts.period);
const daysElapsed = daysElapsedInPeriod(opts.period, opts.asOfDate);

const paceProjection = opts.spendToDate.times(daysInPeriod).div(daysElapsed);

const { average: trailingAverage, monthsUsed } = computeTrailingAverage(
  opts.history, opts.period, trailingMonths
);

let projectedTotal: Decimal;
let method: ForecastMethod;
if (trailingAverage === null) {
  projectedTotal = paceProjection;
  method = "pace_only";
} else {
  const paceWeight = daysElapsed / daysInPeriod; // 0 < w <= 1; grows as the period progresses
  projectedTotal = paceProjection.times(paceWeight).plus(trailingAverage.times(1 - paceWeight));
  method = "blended";
}

const confidence: ForecastConfidence =
  monthsUsed === 0 ? "low" : monthsUsed < trailingMonths ? "medium" : "high";

return {
  period: opts.period, daysElapsed, daysInPeriod, spendToDate: opts.spendToDate,
  paceProjection, trailingAverage, trailingMonthsUsed: monthsUsed,
  projectedTotal, method, confidence,
};
```

**Why this blend weight:** early in the period (`daysElapsed` small relative to
`daysInPeriod`), the pace projection is extrapolated from very little data and gets
proportionally little weight; the trailing average dominates. As the period
progresses, real data accumulates and the pace projection is trusted more. At the
literal end of the period (`daysElapsed === daysInPeriod`), `paceWeight` is exactly
1 and `projectedTotal === spendToDate` — the projection collapses to the known
actual, which is the correct degenerate case (see Test 9).

### 4. Code comment documenting assumptions (required by CLAUDE.md ground rule 8)

Put a comment block above `projectPeriodEndSpend` covering:
- This is an observational projection for a single tag, not a guarantee and not
  financial/tax advice — callers must present it as "on pace for ~$X" language, never
  "you will spend $X."
- The day-count weighting assumes spend accrues independently of *which* day of the
  month it lands on. A tag whose spend is concentrated on a specific day (rent on the
  1st, a utility bill on the 28th) will be under- or over-projected until enough of
  the period has elapsed for the pace signal to catch up — this is a known, accepted
  limitation, not a bug (see back-loaded test case).
- The trailing average deliberately excludes the current (in-progress) period so
  partial-month data never leaks into its own baseline.
- Callers must omit periods with no transactions from `history` rather than passing
  a `$0` entry — a `$0` entry would incorrectly pull the average toward zero for,
  e.g., a newly-active tag's first partial month.

### 5. Implementation order for the Coder

1. Create `lib/spend-forecast.ts` with the types, the two internal date helpers,
   `computeTrailingAverage`, and `projectPeriodEndSpend`, in that order.
2. Write the assumptions comment block above `projectPeriodEndSpend`.
3. Create `lib/__tests__/spend-forecast.test.ts` using the `D()`/`d()` helper
   conventions from `budget.test.ts`/`forecast.test.ts` (`D = (s) => new Decimal(s)`,
   dates as `new Date(iso + "T00:00:00Z")` or plain `new Date(Date.UTC(...))`).
4. Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and confirm the full suite passes
   (289 existing + new spend-forecast tests).

## Risks/unknowns

- **Assumption (flagged, not silently resolved):** the "already over budget" test
  requirement is interpreted as "spend-to-date already exceeds the trailing
  historical average," since this module takes no budget parameter by design
  (the request scopes budget comparison out — see Scope). If the intent was actually
  for this module to accept a budget amount and return an explicit
  over/under-budget flag, that's a scope change the user should confirm before
  the follow-up wiring task.
- **Back-loaded spend is a real, accepted weakness**, not something this plan tries
  to eliminate: a tag whose spend reliably lands late in the month will be
  under-projected for most of the period. Flagged in the code comment per ground
  rule 8 so this doesn't get surfaced later as "the forecast was wrong" — it's a
  documented characteristic of day-count blending, not a defect.
- **Caller contract for `history`:** the function trusts the caller to have already
  excluded $0/no-data months from `history` (see comment). If a future caller
  (the wiring task) queries the DB with a `GROUP BY` that produces a row only when
  transactions exist, this is naturally satisfied — but it's worth calling out
  explicitly since nothing in this module can detect the difference between "no
  data" and "an intentional $0 entry."
- **No timezone handling beyond UTC day-of-month**, consistent with `forecast.ts`'s
  existing UTC-day convention (CLAUDE.md: dates stored UTC). `asOfDate` should be
  passed as a UTC-normalized `Date`; the function does not itself convert from
  America/New_York, matching how `forecast.ts` and `notifications.ts` already handle
  this (no local-time conversion inside pure lib functions).
- **Recommendation (not scope):** once this is reviewed, a natural follow-up is a
  `checkSpendTrend`-style notification in `lib/notifications.ts` (alongside
  `checkBudgetOverspend`) that surfaces `projectedTotal` against the tag's budget —
  but that's explicitly deferred per the request.

## Acceptance criteria

1. `lib/spend-forecast.ts` exports `MonthlySpendPoint`, `ForecastMethod`,
   `ForecastConfidence`, `SpendForecast`, `computeTrailingAverage`, and
   `projectPeriodEndSpend`, matching the signatures above.
2. `projectPeriodEndSpend` never throws for valid `period` strings, including
   zero spend-to-date, empty `history`, and `asOfDate` outside the target period.
3. `projectPeriodEndSpend` throws a descriptive `Error` for a malformed `period`
   (e.g. `"2026-9"`, `"September 2026"`, `""`).
4. All money values in and out are `Decimal` (from `@prisma/client/runtime/library`)
   — no `number`/float arithmetic on money anywhere in the module.
5. No `any` in the new module; `pnpm typecheck` passes with zero errors.
6. `pnpm lint` passes with zero errors/warnings on the new files.
7. `pnpm test` (full suite) passes; the new test file adds to, and does not reduce,
   the existing 289/289 passing count.
8. Nothing outside `lib/spend-forecast.ts` and `lib/__tests__/spend-forecast.test.ts`
   is modified — `git status` shows no changes to `lib/notifications.ts`,
   `prisma/schema.prisma`, `actions/*`, or any UI file as a result of this task.

## Test expectations

Unit tests only (`lib/__tests__/spend-forecast.test.ts`), no DB, no integration
tests — matches the existing pattern (`budget.test.ts`, `forecast.test.ts` are both
pure-function unit tests with hand-built inputs).

1. **Steady/level spending.** History: 3 months at `-600, -580, -620` (periods
   `2026-06/07/08`). Target period `2026-09` (30 days), `asOfDate` day 15,
   `spendToDate = -300`. Expect `trailingAverage.toString() === "-600"`,
   `paceProjection.toString() === "-600"`, `projectedTotal.toString() === "-600"`
   (exact — both signals agree), `method === "blended"`, `confidence === "high"`.

2. **Front-loaded spending (rent day 1).** History: 3 months each `-1500`. Target
   period 30 days, `asOfDate` day 3, `spendToDate = -1500` (rent posted day 1,
   nothing since). Expect `paceProjection.toString() === "-15000"` (naive
   extrapolation is wild, as expected), `trailingAverage.toString() === "-1500"`,
   `projectedTotal.toString() === "-2850"` (exact: `-15000×0.1 + -1500×0.9`).
   Assert `projectedTotal.abs().lessThan(paceProjection.abs())` to explicitly
   demonstrate the blend damps the naive pace signal.

3. **Back-loaded spending (bill due late in month).** History: 3 months each
   `-200`. Target period 30 days, `asOfDate` day 25, `spendToDate = -20` (most
   spend not posted yet). Expect `paceProjection.toString() === "-24"`,
   `trailingAverage.toString() === "-200"`, `projectedTotal.toNumber()` ≈ `-53.33`
   (exact fraction: `-1600/30`; assert with `toBeCloseTo(-53.33, 2)` on
   `.toNumber()`, matching the `toBeCloseTo` pattern already used in
   `budget.test.ts`). Assert `projectedTotal.abs().lessThan(trailingAverage.abs())`
   to document the known under-projection risk for this pattern (see Risks).

4. **No history (new tag) — must not crash or wildly extrapolate from nothing.**
   Three sub-cases, all with `history: []`:
   - `spendToDate = -45` on day 5 of a 30-day period → `trailingAverage === null`,
     `method === "pace_only"`, `confidence === "low"`,
     `projectedTotal.toString() === "-270"` (i.e. it still projects off the one
     data point it has — that's expected pace-only behavior — but is clearly
     flagged `low` confidence for the caller to handle).
   - `spendToDate = D(0)` (literally zero transactions so far) → expect
     `projectedTotal.isZero()`, no throw, no `NaN`/`Infinity`.
   - `asOfDate` in the month *before* the target `period` (period hasn't started)
     → expect `daysElapsed === 1` (not 0), no divide-by-zero, function returns
     normally.

5. **Tag already over its historical norm (over-budget-style spike).** History: 3
   months at `-300, -280, -320` (avg `-300`). Target period 30 days, `asOfDate` day
   10, `spendToDate = -500` (already well beyond typical pace-to-date). Expect
   `trailingAverage.toString() === "-300"`, `paceProjection.toString() === "-1500"`,
   `projectedTotal.toString() === "-700"` (exact: `-1500×⅓ + -300×⅔`). Assert
   `projectedTotal.abs().greaterThan(trailingAverage.abs())` (forecast correctly
   signals a worse-than-normal trajectory, is not silently capped at the average)
   AND `projectedTotal.abs().lessThan(paceProjection.abs())` (blending still damps
   the raw linear extrapolation). `confidence === "high"`.

6. **Period already complete (`asOfDate` after period end) — self-consistency
   check.** Period `2026-08` (31 days), `asOfDate = 2026-09-15`,
   `spendToDate = -950` (the known final actual), history of 2 prior months.
   Expect `daysElapsed === 31 === daysInPeriod`, and
   `projectedTotal.toString() === "-950"` exactly — equal to `spendToDate`,
   ignoring the trailing average entirely, since the period is over and the actual
   is already known.

7. **Invalid `period` throws.** `"2026-9"`, `"September 2026"`, and `""` each
   throw an `Error` from `projectPeriodEndSpend`.

8. **Leap-year / month-length boundary.** Period `2026-02` (2026 is not a leap
   year — confirm `daysInPeriod === 28`), `asOfDate` on the 28th → `daysElapsed
   === 28`.

9. **`computeTrailingAverage` direct unit tests** (separate `describe` block):
   - Dedupes a repeated `period` entry (last one wins) rather than double-counting it.
   - Excludes entries for the current/target period and any future periods.
   - Caps at `trailingMonths` even when more qualifying history is supplied, keeping
     the most recent ones.
   - Returns `{ average: null, monthsUsed: 0 }` for empty input and for
     `trailingMonths <= 0`.

No integration/e2e tests are expected for this task — the module has no DB or
network dependency to integration-test against, consistent with "no integrated DB
tests; mock at the function boundary" from CLAUDE.md's Architecture section.
