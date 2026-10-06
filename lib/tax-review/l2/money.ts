// L2 oracle: integer arithmetic helpers. Written for the independent recalculation (plan 5.4); it shares NO code with
// lib/tax2025/money.ts. Money is held as whole dollars (printed lines) or integer cents (amounts read from the facts); there
// are no floats anywhere: a rate is an integer count of basis points and every product is rounded with BigInt arithmetic.
//
// Rounding rule (Form 1040 instructions, "Rounding Off to Whole Dollars"): "drop amounts under 50 cents and increase amounts
// from 50 to 99 cents to the next dollar". A negative amount is rounded the same way on its magnitude (half away from zero).

export type Cents = number;
export type Dollars = number;
/** A value the oracle may be unable to produce: null = not recomputed (never a silent zero). */
export type Maybe<T> = T | null;

const ZERO = BigInt(0);
const TWO = BigInt(2);

/** Integer division of two bigints, rounding half away from zero. */
function divRoundHalfAway(n: bigint, d: bigint): bigint {
  if (d < ZERO) return divRoundHalfAway(-n, -d);
  const neg = n < ZERO;
  const a = neg ? -n : n;
  const q = (TWO * a + d) / (TWO * d);
  return neg ? -q : q;
}

/** Whole dollars from integer cents (half away from zero). */
export function dollarsOfCents(cents: Cents): Dollars {
  return Number(divRoundHalfAway(BigInt(cents), BigInt(100)));
}

/** round(cents x basisPoints / 10,000) in whole dollars, i.e. cents x bp / 1,000,000. */
export function roundMulCents(cents: Cents, bp: number): Dollars {
  return Number(divRoundHalfAway(BigInt(cents) * BigInt(bp), BigInt(1_000_000)));
}

/** round(dollars x basisPoints / 10,000) in whole dollars. */
export function roundMulDollars(dollars: Dollars, bp: number): Dollars {
  return Number(divRoundHalfAway(BigInt(dollars) * BigInt(bp), BigInt(10_000)));
}

/** round(n / d) to a whole number, half away from zero (integer inputs). */
export function roundDivInt(n: number, d: number): number {
  return Number(divRoundHalfAway(BigInt(n), BigInt(d)));
}

/** Basis points of a decimal rate constant (0.9235 -> 9235). The constants registry holds rates as decimals. */
export function bpOf(rate: number): number {
  return Math.round(rate * 10_000);
}

export function ceilDiv(a: number, b: number): number {
  return Math.ceil(a / b);
}

export function max0(x: number): number {
  return x > 0 ? x : 0;
}

/** Sum that is null as soon as one term is null. */
export function addAll(...xs: readonly Maybe<number>[]): Maybe<number> {
  let s = 0;
  for (const x of xs) {
    if (x === null) return null;
    s += x;
  }
  return s;
}

/** Decimal string ("0.700", "0.67", "1") to thousandths, null when it is not a plain non-negative decimal with at most 3 places. */
export function thousandthsOf(rate: string): Maybe<number> {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(rate.trim());
  if (m === null) return null;
  const frac = (m[2] ?? "").padEnd(3, "0");
  return Number(m[1]) * 1000 + Number(frac);
}

/**
 * The overpayment decisions X7 / X8 as the oracle reads them (its own parser: no import of lib/tax2025/overpayment.ts). `none` = nothing is
 * recorded (the engine prints the lines blank); `unreadable` = a text this parser does not know (the oracle abstains, never guesses).
 */
export type OracleOverpayment =
  | { kind: "none" }
  | { kind: "refund_all" }
  | { kind: "apply_all" }
  | { kind: "apply_amount"; dollars: number }
  | { kind: "unreadable" };

/** "refund_all", "apply_all", "apply_amount:5000"; "no_election" or no decision = none; anything else = unreadable. */
export function overpaymentOfText(text: string | undefined): OracleOverpayment {
  if (text === undefined || text === "no_election") return { kind: "none" };
  if (text === "refund_all") return { kind: "refund_all" };
  if (text === "apply_all") return { kind: "apply_all" };
  const m = /^apply_amount:(\d{1,7})$/.exec(text);
  if (m !== null) {
    const dollars = Number(m[1]);
    return dollars >= 1 ? { kind: "apply_amount", dollars } : { kind: "unreadable" };
  }
  return { kind: "unreadable" };
}

/**
 * [refunded, applied] of an available overpayment (whole dollars) under a recorded choice; null when nothing is printed (no decision, or an
 * amount to apply above what is available: the engine blocks that case).
 */
export function overpaymentSplitOf(available: number, choice: OracleOverpayment): Maybe<readonly [number, number]> {
  switch (choice.kind) {
    case "refund_all":
      return [available, 0];
    case "apply_all":
      return [0, available];
    case "apply_amount":
      return choice.dollars <= available ? [available - choice.dollars, choice.dollars] : null;
    default:
      return null;
  }
}

/** A decision's percent text ("70%", "70.5%", "100%") to tenths of a percent (0..1000); null when it is anything else. */
export function tenthsOfPercent(text: string): Maybe<number> {
  const m = /^(\d{1,3})(?:\.(\d))?%$/.exec(text.trim());
  if (m === null) return null;
  const tenths = Number(m[1]) * 10 + Number(m[2] ?? "0");
  return tenths <= 1000 ? tenths : null;
}
