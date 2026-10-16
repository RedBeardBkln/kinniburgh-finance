// Money and rounding rules of the invoicing feature (plan section 6). PURE and client-safe (the invoice editor shows live totals from
// THIS module and the server recomputes with the very same functions, then rejects a mismatch).
//
// Everything is INTEGER arithmetic: cents are JS integers, the quantity is held as thousandths (Decimal(12,3) in the database) and
// the products are formed with BigInt so no float is ever involved and no intermediate can lose precision. Rounding is always
// half-up on non-negative values. (A deliberate choice over a Decimal import: the editor client component loads this module, and a
// value import of Decimal in a shared lib file has broken `next build` before; integer/BigInt math is exact and bundle-safe.)

import { MAX_CENTS, MAX_QUANTITY_MILLI } from "@/lib/invoicing/constants";

export type DiscountKindLite = "percent" | "fixed";

export interface DiscountInput {
  kind: DiscountKindLite;
  /** percent: basis points (1500 = 15.00 percent, 1 to 10000); fixed: cents (> 0). */
  value: number;
}

export interface LineInput {
  /** Quantity in thousandths (7.25 hours = 7250). */
  quantityMilli: number;
  unitPriceCents: number;
  discount?: DiscountInput | null;
}

export interface LineTotals {
  grossCents: number;
  discountCents: number;
  totalCents: number;
}

export interface DocumentTotals {
  lines: LineTotals[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

/** Rounds num/den half-up for non-negative integers (BigInt). */
function divRoundHalfUp(num: bigint, den: bigint): bigint {
  return (num * BigInt(2) + den) / (den * BigInt(2));
}

export function isIntegerCents(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_CENTS;
}

/** Parses a typed quantity ("7.25", "10", "0.5") to thousandths, or null when invalid (more than 3 decimals, negative, zero, text, too large). */
export function parseQuantityMilli(raw: string): number | null {
  const text = raw.trim();
  const m = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) return null;
  const milli = Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
  if (!Number.isSafeInteger(milli) || milli <= 0 || milli > MAX_QUANTITY_MILLI) return null;
  return milli;
}

/** Formats thousandths as the shortest exact decimal text ("7.25", "10", "0.5"). */
export function formatQuantityMilli(milli: number): string {
  const whole = Math.floor(milli / 1000);
  const frac = milli % 1000;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(3, "0").replace(/0+$/, "")}`;
}

/** lineGross = round-half-up(quantity x unitPriceCents). */
export function lineGrossCents(quantityMilli: number, unitPriceCents: number): number {
  const v = divRoundHalfUp(BigInt(quantityMilli) * BigInt(unitPriceCents), BigInt(1000));
  return Number(v);
}

/** A percent discount of `baseCents`: round-half-up(base x bps / 10000). */
export function percentOf(baseCents: number, bps: number): number {
  return Number(divRoundHalfUp(BigInt(baseCents) * BigInt(bps), BigInt(10000)));
}

export type DiscountCheck = { ok: true; cents: number } | { ok: false; error: string };

/** The cents a discount takes off `baseCents`, or an error (a discount may not exceed the amount it is applied to). */
export function discountCents(baseCents: number, discount: DiscountInput | null | undefined): DiscountCheck {
  if (!discount) return { ok: true, cents: 0 };
  if (!Number.isSafeInteger(discount.value) || discount.value <= 0) return { ok: false, error: "A discount must be greater than zero." };
  if (discount.kind === "percent") {
    if (discount.value > 10000) return { ok: false, error: "A percent discount cannot be more than 100 percent." };
    return { ok: true, cents: percentOf(baseCents, discount.value) };
  }
  if (discount.value > baseCents) return { ok: false, error: "A discount cannot be more than the amount it is applied to." };
  return { ok: true, cents: discount.value };
}

/** The line total after its own discount. */
export function lineTotals(line: LineInput): { ok: true; totals: LineTotals } | { ok: false; error: string } {
  if (!Number.isSafeInteger(line.quantityMilli) || line.quantityMilli <= 0 || line.quantityMilli > MAX_QUANTITY_MILLI) {
    return { ok: false, error: "A quantity must be greater than zero." };
  }
  if (!isIntegerCents(line.unitPriceCents)) return { ok: false, error: "A price must be zero or more, in whole cents." };
  const grossCents = lineGrossCents(line.quantityMilli, line.unitPriceCents);
  if (grossCents > MAX_CENTS) return { ok: false, error: "That line amount is too large." };
  const d = discountCents(grossCents, line.discount);
  if (!d.ok) return d;
  return { ok: true, totals: { grossCents, discountCents: d.cents, totalCents: grossCents - d.cents } };
}

/**
 * Totals of a whole document: sum of line totals, then the invoice-level discount on that subtotal (not spread across lines),
 * total = subtotal - discount. Fails (with a plain sentence) on any invalid line or discount or an amount above the column limit.
 */
export function computeDocumentTotals(
  lines: readonly LineInput[],
  discount: DiscountInput | null | undefined
): { ok: true; totals: DocumentTotals } | { ok: false; error: string } {
  const out: LineTotals[] = [];
  let subtotal = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const r = lineTotals(lines[i]!);
    if (!r.ok) return { ok: false, error: `Line ${i + 1}: ${r.error}` };
    out.push(r.totals);
    subtotal += r.totals.totalCents;
    if (subtotal > MAX_CENTS) return { ok: false, error: "The document total is too large." };
  }
  const d = discountCents(subtotal, discount);
  if (!d.ok) return { ok: false, error: `Invoice discount: ${d.error}` };
  return { ok: true, totals: { lines: out, subtotalCents: subtotal, discountCents: d.cents, totalCents: subtotal - d.cents } };
}

/** Billed unit price from a cost and a markup: round-half-up(cost x (10000 + bps) / 10000). */
export function markupPriceCents(unitCostCents: number, markupBps: number): number {
  return Number(divRoundHalfUp(BigInt(unitCostCents) * BigInt(10000 + markupBps), BigInt(10000)));
}

/** Cents as plain dollars text for display ("$1,234.50"); never used for arithmetic. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
}

/** Parses a typed percent ("10", "12.5", "0.25") to basis points, or null (more than 2 decimals, zero, above 100, text). */
export function parsePercentToBps(raw: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bps <= 0 || bps > 10000) return null;
  return bps;
}

/** Basis points as a percent text ("15", "12.5", "0.25"). */
export function formatBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0+$/, "")}`;
}
