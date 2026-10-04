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

/** Exact cents of (whole dollars x basisPoints / 10,000), rounded to the nearest cent (every federal rate is a whole percent, so exact). */
export function mulDollarsToCents(dollars: Dollars, bp: number): Cents {
  return Number(divRoundHalfAway(BigInt(dollars) * BigInt(bp), BigInt(100)));
}

/** round(n / d) to a whole number, half away from zero (integer inputs). */
export function roundDivInt(n: number, d: number): number {
  return Number(divRoundHalfAway(BigInt(n), BigInt(d)));
}

/** Basis points of a decimal rate constant (0.9235 -> 9235). The constants registry holds rates as decimals. */
export function bpOf(rate: number): number {
  return Math.round(rate * 10_000);
}

/** Whole dollars of an amount held in exact cents that is already a multiple of a cent: ceil / floor helpers on integers. */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
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

/** Sum of a list where a null element makes the whole sum null. */
export function sumOrNull(xs: readonly Maybe<number>[]): Maybe<number> {
  return addAll(...xs);
}

/** a - b, null when either is null. */
export function sub(a: Maybe<number>, b: Maybe<number>): Maybe<number> {
  return a === null || b === null ? null : a - b;
}

/** Apply a function only when every input is present. */
export function lift<T>(inputs: readonly Maybe<number>[], f: (xs: number[]) => T): Maybe<T> {
  const xs: number[] = [];
  for (const x of inputs) {
    if (x === null) return null;
    xs.push(x);
  }
  return f(xs);
}

/** Decimal string ("0.700", "0.67", "1") to thousandths, null when it is not a plain non-negative decimal with at most 3 places. */
export function thousandthsOf(rate: string): Maybe<number> {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(rate.trim());
  if (m === null) return null;
  const frac = (m[2] ?? "").padEnd(3, "0");
  return Number(m[1]) * 1000 + Number(frac);
}
