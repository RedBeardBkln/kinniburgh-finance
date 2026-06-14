import { Decimal } from "@prisma/client/runtime/library";

export interface BudgetSummary {
  budgeted: Decimal;
  rolloverAmount: Decimal;
  effectiveBudget: Decimal;
  actualSpend: Decimal; // signed; negative = outflows
  remaining: Decimal;
  percentUsed: number; // |actualSpend| / effectiveBudget × 100
  isOverspent: boolean;
}

/**
 * Compute budget summary for one tag/period.
 *
 * actualSpend is the sum of signed transaction amounts for this tag+period
 * (typically negative for expense categories).
 * rolloverAmount is positive for underspend carried in, negative for overspend.
 */
export function computeBudgetSummary(opts: {
  budgeted: Decimal;
  rolloverAmount: Decimal;
  actualSpend: Decimal;
}): BudgetSummary {
  const { budgeted, rolloverAmount, actualSpend } = opts;
  const effectiveBudget = budgeted.plus(rolloverAmount);
  const remaining = effectiveBudget.plus(actualSpend); // actualSpend is negative for expenses
  const percentUsed = effectiveBudget.isZero()
    ? 0
    : actualSpend.abs().div(effectiveBudget).times(100).toNumber();

  return {
    budgeted,
    rolloverAmount,
    effectiveBudget,
    actualSpend,
    remaining,
    percentUsed: Math.min(percentUsed, 999), // cap display at 999%
    isOverspent: remaining.isNegative(),
  };
}

/**
 * Compute the rollover to carry into the next period.
 * Returns the remaining amount (positive = underspent, negative = overspent).
 * Only meaningful when rolloverEnabled is true for the budget line.
 */
export function computeRolloverToNext(summary: BudgetSummary): Decimal {
  return summary.remaining;
}

/**
 * Aggregate actual spend for a tag from an array of signed transaction amounts.
 */
export function sumActualSpend(amounts: Decimal[]): Decimal {
  return amounts.reduce((acc, a) => acc.plus(a), new Decimal(0));
}
