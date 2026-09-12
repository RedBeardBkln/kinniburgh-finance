import { Decimal } from "@prisma/client/runtime/library";
import type { DayForecast } from "./forecast";

// ── Forecast rollup ──────────────────────────────────────────────────────────
// Pure functions — unit tested in lib/__tests__/forecast-rollup.test.ts.
// Money: Decimal everywhere. Never floats. No DB/Prisma imports, no "use server".
//
// Rolls an existing day-by-day account balance forecast (lib/forecast.ts's
// DayForecast[]) up into coarser display buckets (weekly/monthly/quarterly).
// This is a display-grouping transform only — it invents no new forecasting
// math and never changes lib/forecast.ts's own output.

export type RollupHorizon = "daily" | "weekly" | "monthly" | "quarterly";

export interface RollupBucket {
  index: number; // 0-based sequence within the rollup
  periodStart: Date; // first day covered, inclusive, UTC midnight
  periodEnd: Date; // last day covered, inclusive, UTC midnight
  daysIncluded: number; // number of forecast days rolled into this bucket
  isPartial: boolean; // true if this bucket doesn't span a full natural
  // period (7 days for weekly; the full calendar month/quarter for
  // monthly/quarterly)
  endingBalance: Decimal; // balanceAfter of the LAST day in the bucket
  minBalance: Decimal; // lowest balanceAfter across all days in the bucket
  hasBreach: boolean; // true if any day in the bucket has isBreachDay
  firstBreachDate: Date | null; // earliest breach date in the bucket, else null
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function daysInMonth(year: number, month0: number): number {
  // Same technique as lib/spend-forecast.ts's daysInPeriodMonth and
  // lib/period-balance-sheet.ts's monthRange lastDay calc.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

interface DaySummary {
  endingBalance: Decimal;
  minBalance: Decimal;
  hasBreach: boolean;
  firstBreachDate: Date | null;
}

/** Summarizes a non-empty, ascending-ordered run of forecast days. */
function summarizeDays(days: DayForecast[]): DaySummary {
  let minBalance = days[0]!.balanceAfter;
  let hasBreach = false;
  let firstBreachDate: Date | null = null;

  for (const day of days) {
    if (day.balanceAfter.lessThan(minBalance)) minBalance = day.balanceAfter;
    if (day.isBreachDay) {
      hasBreach = true;
      // `days` is ascending by date, so the first breach encountered is
      // already the earliest — no need to compare timestamps.
      if (firstBreachDate === null) firstBreachDate = day.date;
    }
  }

  return {
    endingBalance: days[days.length - 1]!.balanceAfter,
    minBalance,
    hasBreach,
    firstBreachDate,
  };
}

/** Groups consecutive items sharing the same key (order-preserving). */
function groupConsecutive<T>(items: T[], keyFn: (item: T) => string): T[][] {
  const groups: T[][] = [];
  let currentKey: string | null = null;
  let currentGroup: T[] = [];

  for (const item of items) {
    const key = keyFn(item);
    if (key !== currentKey) {
      if (currentGroup.length > 0) groups.push(currentGroup);
      currentGroup = [];
      currentKey = key;
    }
    currentGroup.push(item);
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  return groups;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Groups an existing DayForecast[] (assumed already sorted ascending by date
 * — guaranteed by buildAccountForecast's day-by-day walk) into daily / weekly
 * / monthly / quarterly RollupBuckets. Empty input returns [].
 *
 * - "daily": one bucket per DayForecast (passthrough).
 * - "weekly": relative buckets anchored to forecast[0] — days 0-6, 7-13, etc.
 * - "monthly" / "quarterly": calendar-aligned (UTC month / calendar quarter).
 *   The first and/or last bucket may be partial when the input doesn't start
 *   or end on a period boundary — see `isPartial`.
 */
export function rollupForecast(
  forecast: DayForecast[],
  horizon: RollupHorizon
): RollupBucket[] {
  if (forecast.length === 0) return [];

  switch (horizon) {
    case "daily":
      return forecast.map((day, index) => ({
        index,
        periodStart: day.date,
        periodEnd: day.date,
        daysIncluded: 1,
        isPartial: false,
        endingBalance: day.balanceAfter,
        minBalance: day.balanceAfter,
        hasBreach: day.isBreachDay,
        firstBreachDate: day.isBreachDay ? day.date : null,
      }));

    case "weekly": {
      const buckets: RollupBucket[] = [];
      for (let i = 0; i < forecast.length; i += 7) {
        const chunk = forecast.slice(i, i + 7);
        const summary = summarizeDays(chunk);
        buckets.push({
          index: buckets.length,
          periodStart: chunk[0]!.date,
          periodEnd: chunk[chunk.length - 1]!.date,
          daysIncluded: chunk.length,
          isPartial: chunk.length < 7,
          ...summary,
        });
      }
      return buckets;
    }

    case "monthly": {
      const groups = groupConsecutive(
        forecast,
        (d) => `${d.date.getUTCFullYear()}-${d.date.getUTCMonth()}`
      );
      return groups.map((chunk, index) => {
        const summary = summarizeDays(chunk);
        const periodStart = chunk[0]!.date;
        const periodEnd = chunk[chunk.length - 1]!.date;
        const year = periodStart.getUTCFullYear();
        const month = periodStart.getUTCMonth();
        const lastDayOfMonth = daysInMonth(year, month);
        const isPartial =
          periodStart.getUTCDate() !== 1 || periodEnd.getUTCDate() !== lastDayOfMonth;
        return {
          index,
          periodStart,
          periodEnd,
          daysIncluded: chunk.length,
          isPartial,
          ...summary,
        };
      });
    }

    case "quarterly": {
      const groups = groupConsecutive(
        forecast,
        (d) => `${d.date.getUTCFullYear()}-${Math.floor(d.date.getUTCMonth() / 3)}`
      );
      return groups.map((chunk, index) => {
        const summary = summarizeDays(chunk);
        const periodStart = chunk[0]!.date;
        const periodEnd = chunk[chunk.length - 1]!.date;
        const year = periodStart.getUTCFullYear();
        const quarter = Math.floor(periodStart.getUTCMonth() / 3);
        const firstMonthOfQuarter = quarter * 3;
        const lastMonthOfQuarter = firstMonthOfQuarter + 2;
        const lastDayOfQuarter = daysInMonth(year, lastMonthOfQuarter);
        const startsOnQuarterBoundary =
          periodStart.getUTCMonth() === firstMonthOfQuarter && periodStart.getUTCDate() === 1;
        const endsOnQuarterBoundary =
          periodEnd.getUTCMonth() === lastMonthOfQuarter &&
          periodEnd.getUTCDate() === lastDayOfQuarter;
        return {
          index,
          periodStart,
          periodEnd,
          daysIncluded: chunk.length,
          isPartial: !startsOnQuarterBoundary || !endsOnQuarterBoundary,
          ...summary,
        };
      });
    }

    default: {
      const exhaustive: never = horizon;
      throw new Error(`rollupForecast: unknown horizon ${String(exhaustive)}`);
    }
  }
}
