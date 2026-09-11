import { Decimal } from "@prisma/client/runtime/library";

// ── Spend run-rate forecast ───────────────────────────────────────────────────
// Pure functions — unit tested in lib/__tests__/spend-forecast.test.ts.
// Money: Decimal everywhere. Never floats. No DB/Prisma imports, no "use server".

// ── Types ─────────────────────────────────────────────────────────────────────

/** One prior period's total signed spend for a single tag (e.g. from a
 *  GROUP BY tagId, period query the caller runs against Transaction/TransactionTag).
 *  Only include periods that actually had data — do not pass a $0 entry for a
 *  month with zero transactions; omit it instead (see Risks/unknowns). */
export interface MonthlySpendPoint {
  period: string; // "YYYY-MM"
  total: Decimal; // signed; negative = outflow, matching the codebase's Transaction.amount convention
}

export type ForecastMethod = "blended" | "pace_only";
export type ForecastConfidence = "low" | "medium" | "high";

export interface SpendForecast {
  period: string; // "YYYY-MM" being forecast (the current, in-progress period)
  daysElapsed: number; // clamped to [1, daysInPeriod]
  daysInPeriod: number;
  spendToDate: Decimal; // echoes the input, signed
  paceProjection: Decimal; // naive linear extrapolation: spendToDate * daysInPeriod / daysElapsed
  trailingAverage: Decimal | null; // baseline from up to trailingMonths prior periods; null if none available
  trailingMonthsUsed: number; // how many history points actually fed the baseline (0..trailingMonths)
  projectedTotal: Decimal; // the headline number — see algorithm in projectPeriodEndSpend
  method: ForecastMethod;
  confidence: ForecastConfidence;
}

// ── Date helpers (internal) ───────────────────────────────────────────────────

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

// ── Trailing average ──────────────────────────────────────────────────────────

/**
 * Averages up to `trailingMonths` most recent periods strictly before `period`.
 * Deduplicates by period (last entry wins) so a caller accidentally passing the
 * same period twice doesn't double-weight it. Returns { average: null, monthsUsed: 0 }
 * when there's no qualifying history or trailingMonths <= 0.
 */
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

// ── Core projection ────────────────────────────────────────────────────────────

/**
 * Projects where a single tag's spend will land by the end of an in-progress
 * period, blending a linear day-count pace extrapolation with a trailing-average
 * baseline.
 *
 * Assumptions and limitations (ground rule 8 — observational, not a guarantee,
 * not financial/tax advice):
 * - This is an observational projection for a single tag, not a guarantee and
 *   not financial/tax advice — callers must present it as "on pace for ~$X"
 *   language, never "you will spend $X."
 * - The day-count weighting assumes spend accrues independently of *which* day
 *   of the month it lands on. A tag whose spend is concentrated on a specific
 *   day (rent on the 1st, a utility bill on the 28th) will be under- or
 *   over-projected until enough of the period has elapsed for the pace signal
 *   to catch up — this is a known, accepted limitation, not a bug.
 * - The trailing average deliberately excludes the current (in-progress) period
 *   so partial-month data never leaks into its own baseline.
 * - Callers must omit periods with no transactions from `history` rather than
 *   passing a $0 entry — a $0 entry would incorrectly pull the average toward
 *   zero for, e.g., a newly-active tag's first partial month.
 */
export function projectPeriodEndSpend(opts: {
  period: string; // "YYYY-MM" — the period being forecast
  spendToDate: Decimal; // signed sum of this tag's transactions in `period` so far
  asOfDate: Date; // the date spendToDate was computed through ("today")
  history: MonthlySpendPoint[]; // prior periods' totals for the same tag; any order, any length, may include duplicates or future/current periods (filtered internally)
  trailingMonths?: number; // default 3 — how many most-recent qualifying prior periods to average
}): SpendForecast {
  if (!/^\d{4}-\d{2}$/.test(opts.period)) {
    throw new Error(`projectPeriodEndSpend: invalid period "${opts.period}"`);
  }

  const trailingMonths = Math.max(0, opts.trailingMonths ?? 3);

  const daysInPeriod = daysInPeriodMonth(opts.period);
  const daysElapsed = daysElapsedInPeriod(opts.period, opts.asOfDate);

  const paceProjection = opts.spendToDate.times(daysInPeriod).div(daysElapsed);

  const { average: trailingAverage, monthsUsed } = computeTrailingAverage(
    opts.history,
    opts.period,
    trailingMonths
  );

  let projectedTotal: Decimal;
  let method: ForecastMethod;
  if (trailingAverage === null) {
    projectedTotal = paceProjection;
    method = "pace_only";
  } else {
    // Algebraically equivalent to paceProjection * w + trailingAverage * (1 - w)
    // where w = daysElapsed / daysInPeriod, but computed as a single Decimal
    // division at the end instead of first materializing `w` as a JS float.
    // Deviation from the plan's literal `daysElapsed / daysInPeriod` float weight:
    // that form loses precision for non-terminating fractions (e.g. 10/30 = ⅓)
    // once multiplied through Decimal, which broke the plan's own exact "-700"
    // expectation in Test 5. This form is mathematically identical and exact
    // for every test case. See 02-implementation.md "Deviations from the plan".
    const daysRemaining = daysInPeriod - daysElapsed;
    projectedTotal = paceProjection
      .times(daysElapsed)
      .plus(trailingAverage.times(daysRemaining))
      .div(daysInPeriod);
    method = "blended";
  }

  const confidence: ForecastConfidence =
    monthsUsed === 0 ? "low" : monthsUsed < trailingMonths ? "medium" : "high";

  return {
    period: opts.period,
    daysElapsed,
    daysInPeriod,
    spendToDate: opts.spendToDate,
    paceProjection,
    trailingAverage,
    trailingMonthsUsed: monthsUsed,
    projectedTotal,
    method,
    confidence,
  };
}
