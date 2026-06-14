import { Decimal } from "@prisma/client/runtime/library";

/** The $250 minimum balance / $15 fee applies to TD Bank accounts only. */
export const TD_MINIMUM_BALANCE = new Decimal("250.00");
export const TD_MINIMUM_FEE = new Decimal("15.00");

/**
 * Validate that the two legs of an internal transfer are equal in absolute value.
 * outAmount should be negative (outflow), inAmount should be positive (inflow).
 */
export function validateTransferPair(
  outAmount: Decimal,
  inAmount: Decimal
): boolean {
  return outAmount.abs().equals(inAmount.abs());
}

/**
 * Returns true if applying transferAmount to currentBalance would push it
 * below minimumBalance at any point — triggering the $15 fee.
 */
export function wouldBreachMinimum(
  currentBalance: Decimal,
  transferAmount: Decimal, // negative for outflow
  minimumBalance: Decimal
): boolean {
  return currentBalance.plus(transferAmount).lessThan(minimumBalance);
}

/**
 * How much cushion remains above the minimum after applying a transfer.
 * Negative means the minimum would be breached.
 */
export function balanceCushion(
  currentBalance: Decimal,
  transferAmount: Decimal,
  minimumBalance: Decimal
): Decimal {
  return currentBalance.plus(transferAmount).minus(minimumBalance);
}

/**
 * Project the balance N days out given a list of scheduled outflows (negative)
 * and inflows (positive). Used for the "days until sub-$250" warning.
 */
export function projectBalance(
  startingBalance: Decimal,
  scheduledAmounts: Decimal[]
): Decimal {
  return scheduledAmounts.reduce(
    (bal, amount) => bal.plus(amount),
    startingBalance
  );
}

/**
 * Find the first projected balance that breaches the minimum (for warning generation).
 * Returns the index of the first breach, or -1 if none.
 */
export function findFirstBreach(
  startingBalance: Decimal,
  scheduledAmounts: Decimal[],
  minimumBalance: Decimal
): number {
  let balance = startingBalance;
  for (let i = 0; i < scheduledAmounts.length; i++) {
    const amt = scheduledAmounts[i];
    if (amt === undefined) continue;
    balance = balance.plus(amt);
    if (balance.lessThan(minimumBalance)) return i;
  }
  return -1;
}
