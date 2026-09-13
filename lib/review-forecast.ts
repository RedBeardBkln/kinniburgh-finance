import { Decimal } from "@prisma/client/runtime/library";
import {
  projectPeriodEndSpend,
  type MonthlySpendPoint,
  type SpendForecast,
  type ForecastConfidence,
} from "./spend-forecast";

// ── Monthly review forecast helpers ────────────────────────────────────────────
// Pure functions — unit tested in lib/__tests__/review-forecast.test.ts.
// Money: Decimal everywhere. Never floats. No DB/Prisma imports, no "use server".
//
// Supports two pieces of the monthly review (see
// .claude/pipeline/monthly-review-forecast/01-plan.md):
//  1. A per-tag forward projection for the in-progress period (thin wrapper
//     around projectPeriodEndSpend, wired up in lib/monthly-review-build.ts —
//     no new pure logic needed for that half).
//  2. A retrospective "how accurate was last month's mid-month projection"
//     reconstruction, using only transaction history that already exists —
//     no new tracking table (ground rule 3: transactions are immutable
//     facts, so this is always re-derivable after the fact).

export const REVIEW_FORECAST_TRAILING_MONTHS = 3; // shared window for both
// the forward budgetHealth projection and the retrospective reconstruction,
// so query windows and projectPeriodEndSpend's own default never drift
// apart via two different magic numbers.
export const MAX_ACCURACY_ROWS = 5;
export const MIN_NOTABLE_MISS_AMOUNT = new Decimal(10); // $10 dollars — a
// miss below this is rounding noise, not a signal worth a household's
// attention in a monthly review.

const PERIOD_RE = /^\d{4}-\d{2}$/;

function parsePeriod(period: string, fnName: string): [number, number] {
  if (!PERIOD_RE.test(period)) {
    throw new Error(`${fnName}: invalid period "${period}"`);
  }
  const [year, month] = period.split("-").map(Number) as [number, number];
  return [year, month];
}

function daysInPeriodMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * "YYYY-MM" immediately before `period`, handling year rollover
 * ("2026-01" -> "2025-12"). Throws on malformed input.
 */
export function previousPeriod(period: string): string {
  const [year, month] = parsePeriod(period, "previousPeriod");
  const d = new Date(Date.UTC(year, month - 2, 1)); // month-1 (0-indexed) - 1 = prior month; JS normalizes negative months into the prior year
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Deterministic "representative point" used to reconstruct what a forecast
 * would have said partway through `period`: the period's calendar
 * midpoint day (ceil(daysInPeriod / 2)), at UTC midnight. Depends only on
 * the period string (no "now"), so regenerating a review for the same
 * period always reconstructs the same historical projection. Throws on
 * malformed input.
 */
export function periodMidpointDate(period: string): Date {
  const [year, month] = parsePeriod(period, "periodMidpointDate");
  const daysInPeriod = daysInPeriodMonth(year, month);
  const midDay = Math.ceil(daysInPeriod / 2);
  return new Date(Date.UTC(year, month - 1, midDay));
}

export interface ForecastAccuracyResult {
  projected: Decimal; // absolute magnitude — reconstructed midpoint projection
  actual: Decimal; // absolute magnitude — the now-known final total
  missAbs: Decimal; // |actual - projected|, absolute magnitude
  percentOff: number | null; // round(missAbs / actual * 100); null when actual is 0 (div-by-zero guard)
  direction: "over" | "under" | "exact"; // projected > actual => "over"; projected < actual => "under"; missAbs===0 => "exact"
  confidence: ForecastConfidence; // straight passthrough from the reconstructed SpendForecast — never hidden
  reconstructedForecast: SpendForecast; // full underlying forecast (method, trailingMonthsUsed, etc.) for callers/UI that want more detail
}

/**
 * Reconstructs what projectPeriodEndSpend() would have projected partway
 * (periodMidpointDate(period)) through a now-complete `period`, using only
 * the transaction activity that existed by that point plus trailing history
 * strictly before `period` — then compares it to the period's real final
 * total. All DB aggregation is the caller's job (matching lib/budget-pace.ts's
 * pure/DB split); this function does only the Decimal math.
 */
export function reconstructForecastAccuracy(opts: {
  period: string; // the now-complete period being retrospectively evaluated
  spendAtMidpoint: Decimal; // signed sum of period's transactions with postedAt through periodMidpointDate(period) inclusive
  actualFinal: Decimal; // signed full-period actual total
  history: MonthlySpendPoint[]; // periods strictly before `period` — full, complete totals
  trailingMonths?: number; // default REVIEW_FORECAST_TRAILING_MONTHS
}): ForecastAccuracyResult {
  const trailingMonths = opts.trailingMonths ?? REVIEW_FORECAST_TRAILING_MONTHS;

  const reconstructedForecast = projectPeriodEndSpend({
    period: opts.period,
    spendToDate: opts.spendAtMidpoint,
    asOfDate: periodMidpointDate(opts.period),
    history: opts.history,
    trailingMonths,
  });

  const projected = reconstructedForecast.projectedTotal.abs();
  const actual = opts.actualFinal.abs();
  const missAbs = projected.minus(actual).abs();

  const direction: "over" | "under" | "exact" = missAbs.isZero()
    ? "exact"
    : projected.greaterThan(actual)
      ? "over"
      : "under";

  const percentOff = actual.isZero()
    ? null
    : Math.round(missAbs.div(actual).times(100).toNumber());

  return {
    projected,
    actual,
    missAbs,
    percentOff,
    direction,
    confidence: reconstructedForecast.confidence,
    reconstructedForecast,
  };
}

export interface TaggedForecastAccuracy {
  tagName: string;
  entityName: string;
  result: ForecastAccuracyResult;
}

/**
 * Narrows a full set of per-tag reconstructions down to the "notable
 * misses" worth printing in a review: drops low-confidence reconstructions
 * (too little trailing history to mean anything — same signal
 * projectPeriodEndSpend already exposes, not new logic) and misses at or
 * below minMissAmount, sorts the remainder by absolute dollar miss
 * (largest first — dollar magnitude is what a household actually cares
 * about, not percent-off on a trivially small budget line), and caps to
 * maxRows. Returns [] when nothing qualifies — never throws.
 */
export function selectNotableAccuracyRows(
  rows: TaggedForecastAccuracy[],
  opts?: { maxRows?: number; minMissAmount?: Decimal }
): TaggedForecastAccuracy[] {
  const maxRows = opts?.maxRows ?? MAX_ACCURACY_ROWS;
  const minMissAmount = opts?.minMissAmount ?? MIN_NOTABLE_MISS_AMOUNT;

  return rows
    .filter(
      (r) => r.result.confidence !== "low" && r.result.missAbs.greaterThan(minMissAmount)
    )
    .sort((a, b) => b.result.missAbs.comparedTo(a.result.missAbs))
    .slice(0, maxRows);
}
