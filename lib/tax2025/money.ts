// Money helpers for the TY2025 engine. Decimal everywhere inside rules; integer
// cents only at document boundaries. No floats for money.

import { Decimal } from "@prisma/client/runtime/library";
import type { LineKey, RuleLine, RuleStatus } from "@/lib/tax2025/types";

export const D = (v: Decimal.Value): Decimal => new Decimal(v);
export const ZERO = new Decimal(0);

/**
 * IRS whole-dollar rounding (1040 instructions, "Rounding Off to Whole Dollars",
 * verified 2026-10-03): amounts under 50 cents are dropped, 50 to 99 cents round up
 * to the next dollar. `ROUND_HALF_UP` is "half away from zero", so a loss of
 * $2.50 rounds to -$3, the same magnitude rule.
 */
export function roundLine(x: Decimal): Decimal {
  return x.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/**
 * "If you have to add two or more amounts to figure the amount to enter on a
 * line, include cents when adding the amounts and round off only the total."
 */
export function sumThenRound(parts: readonly Decimal[]): Decimal {
  return roundLine(parts.reduce((acc, p) => acc.plus(p), ZERO));
}

export function centsToDollars(cents: number): Decimal {
  return new Decimal(cents).div(100);
}

/** Dollars (Decimal) to integer cents. */
export function dollarsToCents(dollars: Decimal): number {
  return dollars.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

export function maxD(a: Decimal, b: Decimal): Decimal {
  return a.greaterThan(b) ? a : b;
}

export function minD(a: Decimal, b: Decimal): Decimal {
  return a.lessThan(b) ? a : b;
}

/** A line with an amount: rounds `exact` to whole dollars. */
export function amountLine(
  key: LineKey,
  label: string,
  formLine: string,
  exact: Decimal,
  status: RuleStatus = "computed",
  reason?: string
): RuleLine {
  const line: RuleLine = { key, label, formLine, amount: roundLine(exact), exact, status };
  if (reason !== undefined) line.reason = reason;
  return line;
}

/** A line with NO amount (missing / needs CPA / not yet computed): never 0. */
export function blockedLine(
  key: LineKey,
  label: string,
  formLine: string,
  status: Exclude<RuleStatus, "computed" | "not_applicable">,
  reason: string
): RuleLine {
  return { key, label, formLine, amount: null, exact: null, status, reason };
}

/** "Format dollars" for reasons text: whole dollars with thousands separators. */
export function fmt(d: Decimal): string {
  const rounded = d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const [intPart, frac] = rounded.abs().toFixed(2).split(".");
  const withCommas = (intPart ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = rounded.isNegative() && !rounded.isZero() ? "-" : "";
  return frac === "00" ? `${sign}$${withCommas}` : `${sign}$${withCommas}.${frac}`;
}
