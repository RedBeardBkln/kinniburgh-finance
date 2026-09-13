import { Decimal } from "@prisma/client/runtime/library";

// ── Quarterly business P&L forecast ──────────────────────────────────────────
// Pure functions — unit tested in lib/__tests__/business-quarter-forecast.test.ts.
// Money: Decimal everywhere. Never floats. No DB/Prisma-client imports, no "use server".
//
// Deliberately does NOT import from lib/spend-forecast.ts — that module
// operates on a single tag's spend over calendar months, this one operates on
// TWO series (income + expenses from computePL) over calendar quarters. The
// grain and shape differ enough that sharing code would couple two
// independently-evolving modules for a ~15-line savings; duplicating the
// pace/trailing-average blend math here keeps each module free to change
// independently. See .claude/pipeline/quarterly-business-forecast/01-plan.md
// Design decision 1.
//
// Ground rule 8 caveat: this is an observational projection, never a
// guarantee and never tax/financial advice. Callers must render "on pace for
// ~$X" language, never "you will net $X" — and the tax-reserve estimate below
// is a flat percentage heuristic, not a computed tax liability (no bracket,
// self-employment tax, or safe-harbor math — see computeTaxReserveEstimate).

// ── Quarter calendar helpers ─────────────────────────────────────────────────

const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

function parseQuarter(quarter: string): { year: number; q: number } {
  const m = QUARTER_RE.exec(quarter);
  if (!m) throw new Error(`invalid quarter "${quarter}"`);
  return { year: Number(m[1]), q: Number(m[2]) };
}

/** "YYYY-Q1".."YYYY-Q4" — validated with /^\d{4}-Q[1-4]$/, string-sortable
 *  lexicographically as-is (same trick spend-forecast.ts uses for "YYYY-MM"). */
export function getQuarterForDate(date: Date): string {
  const year = date.getUTCFullYear();
  const q = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${year}-Q${q}`;
}

export interface QuarterBounds {
  start: Date; // UTC midnight, first day of the quarter
  end: Date; // UTC 23:59:59, last calendar day of the quarter (inclusive,
  // matching computePL's inclusive `lte` toDate convention as used in
  // app/business/[slug]/pl/page.tsx's yearEnd)
}

export function getQuarterBounds(quarter: string): QuarterBounds {
  const { year, q } = parseQuarter(quarter);
  const startMonth = (q - 1) * 3; // 0-indexed
  const endMonth = startMonth + 2; // 0-indexed, last month of the quarter
  const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, endMonth + 1, 0, 23, 59, 59, 0));
  return { start, end };
}

/** Most-recent-first list of `count` quarter keys strictly before `quarter`,
 *  correctly rolling over year boundaries (prior of "2026-Q1" is "2025-Q4"). */
export function getPriorQuarters(quarter: string, count: number): string[] {
  let { year, q } = parseQuarter(quarter);
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    q -= 1;
    if (q < 1) {
      q = 4;
      year -= 1;
    }
    result.push(`${year}-Q${q}`);
  }
  return result;
}

function daysInMonth(year: number, month1Indexed: number): number {
  return new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate();
}

/** Total calendar days in `quarter`, computed by summing its three months'
 *  day counts — mirrors spend-forecast.ts's daysInPeriodMonth. Avoids
 *  millisecond-diff rounding pitfalls against the 23:59:59 QuarterBounds.end
 *  convention. */
function daysInQuarterCalendar(quarter: string): number {
  const { year, q } = parseQuarter(quarter);
  const startMonth1 = (q - 1) * 3 + 1; // 1-indexed
  let total = 0;
  for (let m = startMonth1; m < startMonth1 + 3; m++) total += daysInMonth(year, m);
  return total;
}

/** Days elapsed within `quarter` as of `asOfDate`, floored at 1 (period
 *  hasn't started yet) and capped at daysInQuarterCalendar(quarter) (period
 *  already over) — mirrors spend-forecast.ts's daysElapsedInPeriod. */
function daysElapsedInQuarter(quarter: string, asOfDate: Date): number {
  const { start, end } = getQuarterBounds(quarter);
  const daysInQuarter = daysInQuarterCalendar(quarter);
  if (asOfDate.getTime() < start.getTime()) return 1;
  if (asOfDate.getTime() > end.getTime()) return daysInQuarter;
  const diffDays = Math.floor((asOfDate.getTime() - start.getTime()) / 86_400_000) + 1;
  return Math.min(Math.max(diffDays, 1), daysInQuarter);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export const DEFAULT_TAX_RESERVE_PCT = 30; // percent; single source of truth,
// referenced by lib/settings.ts's fallback and the UI's "(default)" label.

/** One prior, ALREADY-CONCLUDED quarter's totals for one entity, as returned
 *  by computePL() for that quarter's full date range.
 *  IMPORTANT CONTRACT (deviates from spend-forecast's MonthlySpendPoint on
 *  purpose): omit a quarter entirely if computePL returned no GL-coded lines
 *  at all for it (grouped.length === 0, i.e. pl.incomeLines.length === 0 &&
 *  pl.expenseLines.length === 0) — that signals the entity had no coded
 *  activity that quarter (most likely it didn't exist yet), not that it
 *  broke even. A quarter where the entity was operating but genuinely had $0
 *  income and some coded expenses IS included (that's real signal, not
 *  missing data) — computePL only returns empty arrays for the "nothing at
 *  all" case, so this distinction falls out for free from its existing
 *  return shape. */
export interface QuarterlyPLPoint {
  quarter: string; // "YYYY-Q1".."YYYY-Q4"
  totalIncome: Decimal; // unsigned, matches PLReport.totalIncome
  totalExpenses: Decimal; // unsigned, matches PLReport.totalExpenses
}

export type QuarterForecastMethod = "blended" | "pace_only";
export type QuarterForecastConfidence = "low" | "medium" | "high";

export interface LineForecast {
  actualToDate: Decimal; // unsigned
  paceProjection: Decimal; // unsigned; actualToDate * daysInQuarter / daysElapsed
  trailingAverage: Decimal | null; // unsigned baseline; null if no qualifying history
  projectedTotal: Decimal; // unsigned — headline per-line number
}

export interface QuarterlyBusinessForecast {
  quarter: string;
  daysElapsed: number; // clamped to [1, daysInQuarter]
  daysInQuarter: number;
  income: LineForecast;
  expenses: LineForecast;
  actualNetIncomeToDate: Decimal; // signed = income.actualToDate - expenses.actualToDate
  projectedNetIncome: Decimal; // signed = income.projectedTotal - expenses.projectedTotal
  trailingQuartersUsed: number; // 0..trailingQuarters — SHARED by both lines
  // (computed once from the same history set, so income/expenses never
  // disagree on confidence — simpler than spend-forecast's single-series
  // case because this module always evaluates two series from ONE
  // synchronized set of history points)
  method: QuarterForecastMethod;
  confidence: QuarterForecastConfidence;
}

// ── Trailing average (two series, one shared quartersUsed) ──────────────────

/** Averages up to `trailingQuarters` most recent quarters strictly before
 *  `quarter`, for BOTH totalIncome and totalExpenses over the same selected
 *  set of quarters (so both lines share one quartersUsed count). Deduplicates
 *  by quarter (last entry wins). Returns nulls/0 when there's no qualifying
 *  history or trailingQuarters <= 0. Mirrors spend-forecast.ts's
 *  computeTrailingAverage. */
export function computeTrailingQuarterlyAverages(
  history: QuarterlyPLPoint[],
  quarter: string,
  trailingQuarters: number
): { incomeAverage: Decimal | null; expenseAverage: Decimal | null; quartersUsed: number } {
  if (trailingQuarters <= 0) return { incomeAverage: null, expenseAverage: null, quartersUsed: 0 };

  const byQuarter = new Map<string, QuarterlyPLPoint>();
  for (const h of history) byQuarter.set(h.quarter, h);

  const prior = [...byQuarter.values()]
    .filter((h) => h.quarter < quarter)
    .sort((a, b) => b.quarter.localeCompare(a.quarter))
    .slice(0, trailingQuarters);

  if (prior.length === 0) return { incomeAverage: null, expenseAverage: null, quartersUsed: 0 };

  const incomeSum = prior.reduce((acc, h) => acc.plus(h.totalIncome), new Decimal(0));
  const expenseSum = prior.reduce((acc, h) => acc.plus(h.totalExpenses), new Decimal(0));

  return {
    incomeAverage: incomeSum.div(prior.length),
    expenseAverage: expenseSum.div(prior.length),
    quartersUsed: prior.length,
  };
}

// ── Core projection ───────────────────────────────────────────────────────────

/**
 * Projects where the CURRENT, in-progress quarter's income and expenses will
 * land by quarter-end, blending linear day-count pace extrapolation against a
 * trailing-average baseline — same algorithm as
 * spend-forecast.ts#projectPeriodEndSpend, applied independently to the
 * income and expense lines of a P&L instead of a single tag's spend.
 * Observational only — see ground rule 8 caveat in the file-level doc comment
 * (callers must render "on pace for ~$X", never "you will net $X").
 */
export function projectQuarterEndPL(opts: {
  quarter: string; // "YYYY-Q1".."YYYY-Q4" being forecast
  actualToDate: { totalIncome: Decimal; totalExpenses: Decimal }; // unsigned, from computePL(entityId, quarterStart, asOfDate)
  asOfDate: Date;
  history: QuarterlyPLPoint[]; // any order/length; duplicate quarters (last
  // wins) and current/future quarters are filtered internally
  trailingQuarters?: number; // default 4
}): QuarterlyBusinessForecast {
  // Validate the quarter format up front (also throws via getQuarterBounds below,
  // but this gives a consistent error message regardless of call order).
  parseQuarter(opts.quarter);

  const trailingQuarters = Math.max(0, opts.trailingQuarters ?? 4);

  const daysInQuarter = daysInQuarterCalendar(opts.quarter);
  const daysElapsed = daysElapsedInQuarter(opts.quarter, opts.asOfDate);
  const daysRemaining = daysInQuarter - daysElapsed;

  const incomePace = opts.actualToDate.totalIncome.times(daysInQuarter).div(daysElapsed);
  const expensePace = opts.actualToDate.totalExpenses.times(daysInQuarter).div(daysElapsed);

  const { incomeAverage, expenseAverage, quartersUsed } = computeTrailingQuarterlyAverages(
    opts.history,
    opts.quarter,
    trailingQuarters
  );

  let incomeProjectedTotal: Decimal;
  let expenseProjectedTotal: Decimal;
  let method: QuarterForecastMethod;

  if (incomeAverage === null || expenseAverage === null) {
    incomeProjectedTotal = incomePace;
    expenseProjectedTotal = expensePace;
    method = "pace_only";
  } else {
    // Single final Decimal division instead of materializing a JS float
    // weight (daysElapsed / daysInQuarter) — see
    // .claude/agent-memory/coder/decimal-blend-precision.md. Algebraically
    // equivalent to pace * w + average * (1 - w).
    incomeProjectedTotal = incomePace
      .times(daysElapsed)
      .plus(incomeAverage.times(daysRemaining))
      .div(daysInQuarter);
    expenseProjectedTotal = expensePace
      .times(daysElapsed)
      .plus(expenseAverage.times(daysRemaining))
      .div(daysInQuarter);
    method = "blended";
  }

  const confidence: QuarterForecastConfidence =
    quartersUsed === 0 ? "low" : quartersUsed < trailingQuarters ? "medium" : "high";

  const income: LineForecast = {
    actualToDate: opts.actualToDate.totalIncome,
    paceProjection: incomePace,
    trailingAverage: incomeAverage,
    projectedTotal: incomeProjectedTotal,
  };
  const expenses: LineForecast = {
    actualToDate: opts.actualToDate.totalExpenses,
    paceProjection: expensePace,
    trailingAverage: expenseAverage,
    projectedTotal: expenseProjectedTotal,
  };

  return {
    quarter: opts.quarter,
    daysElapsed,
    daysInQuarter,
    income,
    expenses,
    actualNetIncomeToDate: opts.actualToDate.totalIncome.sub(opts.actualToDate.totalExpenses),
    projectedNetIncome: incomeProjectedTotal.sub(expenseProjectedTotal),
    trailingQuartersUsed: quartersUsed,
    method,
    confidence,
  };
}

// ── Tax reserve estimate (percentage-based; NO bracket/SE-tax math) ─────────

export interface TaxReserveEstimate {
  reservePct: Decimal; // e.g. 30 meaning 30% — echoes the rate used
  reserveBasis: Decimal; // projectedNetIncome clamped at 0 (never reserve
  // against a projected loss)
  reserveAmount: Decimal; // reserveBasis * reservePct / 100
}

/** Pure percentage multiply. Throws on a negative reservePct. Does NOT
 *  compute tax brackets, self-employment tax, or any IRS-specific figure —
 *  this is a flat "reserveBasis × pct" cash-planning heuristic only. */
export function computeTaxReserveEstimate(
  projectedNetIncome: Decimal,
  reservePct: Decimal
): TaxReserveEstimate {
  if (reservePct.lessThan(0)) {
    throw new Error(`computeTaxReserveEstimate: reservePct cannot be negative (got ${reservePct.toString()})`);
  }
  const reserveBasis = projectedNetIncome.greaterThan(0) ? projectedNetIncome : new Decimal(0);
  const reserveAmount = reserveBasis.times(reservePct).div(100);
  return { reservePct, reserveBasis, reserveAmount };
}
