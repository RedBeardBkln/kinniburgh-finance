import { Decimal } from "@prisma/client/runtime/library";
import { projectPeriodEndSpend, type MonthlySpendPoint, type SpendForecast } from "./spend-forecast";

export type { MonthlySpendPoint, SpendForecast };

// ── Budget pace decision ──────────────────────────────────────────────────────
// Pure functions — unit tested in lib/__tests__/budget-pace.test.ts.
// Money: Decimal everywhere. Never floats. No DB/Prisma imports, no "use server".
//
// Wraps projectPeriodEndSpend() (lib/spend-forecast.ts) with the suppression
// rules that decide whether an early "trending over budget" notification
// should fire. See .claude/pipeline/forecast-budget-alerts/01-plan.md
// (Design decision 3) for the rationale behind each guard below.

export const PACE_TRAILING_MONTHS = 3;

// Must stay in sync with checkBudgetOverspend's own 80% threshold in
// lib/notifications.ts — not extracted into a shared constant (see plan's
// Scope/Risks notes on why that file is intentionally not touched here).
export const PACE_SUPPRESS_AT_PERCENT_USED = 80;

export const PACE_OVERAGE_MARGIN = 0.05;

export interface BudgetPaceEvaluation {
  fire: boolean;
  forecast: SpendForecast;
  projectedOverageAbs: Decimal | null;
}

export function evaluateBudgetPace(opts: {
  period: string;
  effectiveBudget: Decimal;
  actualSpend: Decimal; // signed, current period-to-date
  percentUsed: number; // from computeBudgetSummary
  asOfDate: Date;
  history: MonthlySpendPoint[];
  trailingMonths?: number; // default PACE_TRAILING_MONTHS
}): BudgetPaceEvaluation {
  const trailingMonths = opts.trailingMonths ?? PACE_TRAILING_MONTHS;

  const forecast = projectPeriodEndSpend({
    period: opts.period,
    spendToDate: opts.actualSpend,
    asOfDate: opts.asOfDate,
    history: opts.history,
    trailingMonths,
  });

  // Zero/negative-budget guard: no meaningful "over budget" concept to project against.
  if (opts.effectiveBudget.lessThanOrEqualTo(0)) {
    return { fire: false, forecast, projectedOverageAbs: null };
  }

  // Once actual usage is at/above the overspend threshold, checkBudgetOverspend
  // already owns the signal — a second "trending over" notification would be
  // redundant noise, not new information.
  if (opts.percentUsed >= PACE_SUPPRESS_AT_PERCENT_USED) {
    return { fire: false, forecast, projectedOverageAbs: null };
  }

  // A "low"-confidence projection is a bare linear extrapolation off a single
  // partial month with no historical baseline to damp it — too shaky to page
  // the household on.
  if (forecast.confidence === "low") {
    return { fire: false, forecast, projectedOverageAbs: null };
  }

  // Materiality margin: forecasting math is inherently noisy near the
  // boundary, so only fire when the projection clears the budget by more
  // than PACE_OVERAGE_MARGIN.
  const threshold = opts.effectiveBudget.abs().times(1 + PACE_OVERAGE_MARGIN);
  if (!forecast.projectedTotal.abs().greaterThan(threshold)) {
    return { fire: false, forecast, projectedOverageAbs: null };
  }

  const projectedOverageAbs = forecast.projectedTotal.abs().minus(opts.effectiveBudget.abs());
  return { fire: true, forecast, projectedOverageAbs };
}
