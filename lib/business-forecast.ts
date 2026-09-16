import { Decimal } from "@prisma/client/runtime/library";

// ── Business-bucket forecast math (Sudden Valley / EK Consulting) ────────────
// Pure functions — unit tested in lib/__tests__/business-forecast.test.ts.
// Money: Decimal everywhere. Never floats. No DB/Prisma-client imports, no "use server".
//
// Unlike Personal's day-by-day ScheduledTransfer/ScheduledBill/IncomeSource engine
// (lib/forecast.ts), a business bucket's 30/60/90-day projection is a single
// waterfall per horizon: currentBalance + revenue − transfers out − expenses.
// This module supplies the two pieces of that waterfall that need real math:
// capping the horizon to however far revenue data actually extends, and
// prorating a set of monthly Budget totals across an arbitrary [from, to) window.
//
// Ground rule 8 caveat: callers must render these as observational projections
// ("projected ~$X"), never a guarantee ("you will have $X").

// ── Horizon capping ───────────────────────────────────────────────────────────

export interface CappedHorizon {
  days: number;
  wasCapped: boolean;
}

/**
 * Caps a requested horizon (30/60/90) to however far out the entity's revenue
 * data actually extends.
 *
 * `latestConfirmedRevenueDate === null` means the entity has zero forward-looking
 * revenue rows at all — a real "no data" state (e.g. a freshly-set-up entity, or
 * EK Consulting before the owner adds any ProjectedRevenue rows). This
 * deliberately mirrors this codebase's existing "no data" vs "real zero"
 * distinction (see computePL's empty-array convention) — an entity with no
 * revenue rows yet gets the FULL requested horizon, uncapped, rather than being
 * truncated to 0 days, which would make an empty-by-design forecast look broken.
 *
 * Otherwise, `daysAvailable` is the whole number of days between `today` and
 * `latestConfirmedRevenueDate` (clamped to >= 0 — a revenue date in the past
 * caps the horizon to 0), and the returned `days` is `min(requestedDays, daysAvailable)`.
 */
export function capForecastHorizon(
  requestedDays: number,
  latestConfirmedRevenueDate: Date | null,
  today: Date
): CappedHorizon {
  if (latestConfirmedRevenueDate === null) {
    return { days: requestedDays, wasCapped: false };
  }

  const daysAvailable = Math.max(
    0,
    Math.floor((latestConfirmedRevenueDate.getTime() - today.getTime()) / 86_400_000)
  );
  const days = Math.min(requestedDays, daysAvailable);
  return { days, wasCapped: days < requestedDays };
}

// ── Expense proration ─────────────────────────────────────────────────────────

function daysInMonthUTC(year: number, month0: number): number {
  // Same technique as lib/forecast-rollup.ts's daysInMonth / lib/spend-forecast.ts's
  // daysInPeriodMonth — no date library in this repo.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function periodKey(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, "0")}`;
}

/**
 * Calendar-accurately prorates a set of monthly Budget totals across an
 * arbitrary [from, to) window (the — possibly horizon-capped — forecast window).
 *
 * `periodTotals` is keyed "YYYY-MM" (e.g. from a `Budget.groupBy({ by: ["period"] })`
 * query's `_sum.budgeted`); a period with no entry (or an explicit `Decimal(0)`
 * entry) contributes $0 — the correct behavior for EK Consulting, which
 * currently has zero Budget rows for any period.
 *
 * For each calendar month the window touches, this multiplies that month's
 * total budgeted amount by the fraction of that month's days which fall inside
 * [from, to), then sums across all touched months. Chosen over a simpler flat
 * "current month's daily rate × horizon length" approximation because Sudden
 * Valley already has real Budget data for every 2026 period — a
 * calendar-accurate lookup costs nothing extra here and stays correct if the
 * owner ever budgets a different amount for a future month, which a flat-rate
 * approximation would silently ignore.
 */
export function prorateExpensesAcrossHorizon(
  periodTotals: Map<string, Decimal>,
  from: Date,
  to: Date
): Decimal {
  let total = new Decimal(0);
  if (from.getTime() >= to.getTime()) return total;

  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();

  while (true) {
    const monthStart = new Date(Date.UTC(year, month, 1));
    if (monthStart.getTime() >= to.getTime()) break;

    const monthEndExclusive = new Date(Date.UTC(year, month + 1, 1));
    const segmentStart = monthStart.getTime() > from.getTime() ? monthStart : from;
    const segmentEnd = monthEndExclusive.getTime() < to.getTime() ? monthEndExclusive : to;
    const daysInSegment = Math.round((segmentEnd.getTime() - segmentStart.getTime()) / 86_400_000);

    if (daysInSegment > 0) {
      const totalDaysInMonth = daysInMonthUTC(year, month);
      const monthTotal = periodTotals.get(periodKey(year, month)) ?? new Decimal(0);
      total = total.plus(monthTotal.times(daysInSegment).div(totalDaysInMonth));
    }

    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }

  return total;
}
