// Shared output formatting for tool shapers. PURE.
//
// Money rule: amounts are stored as NUMERIC(14,2) / integer cents. Shapers parse a stored value into INTEGER CENTS (exact, from the decimal
// string) and add cents; a dollar figure is produced only at the edge (cents / 100, two decimals). No float is ever summed.

export type DecimalLike = string | number | { toString(): string } | null | undefined;

/** Exact integer cents from a decimal string such as "-1234.5" / "12.34" / "7". Returns null for null / undefined / unparseable. */
export function centsOf(v: DecimalLike): number | null {
  if (v === null || v === undefined) return null;
  const raw = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(2) : "") : String(v.toString()).trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(raw);
  if (m === null) return null;
  const frac = (m[3] ?? "").padEnd(2, "0");
  // Round half away from zero on the third decimal (stored values have two; this only guards odd inputs).
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;
  return m[1] === "-" ? -cents : cents;
}

/** Dollars with two decimals for a cents integer; null stays null. */
export function dollarsOf(cents: number | null): number | null {
  return cents === null ? null : Number((cents / 100).toFixed(2));
}

export function dollars(v: DecimalLike): number | null {
  return dollarsOf(centsOf(v));
}

/** YYYY-MM-DD in UTC (stored dates are UTC; the model is told so in the prompt). */
export function isoDay(d: Date | null | undefined): string | null {
  return d === null || d === undefined || Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function isoDateTime(d: Date | null | undefined): string | null {
  return d === null || d === undefined || Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 16) + "Z";
}

/** Integer percent (0 when the denominator is 0); capped at 999 like the Budgets page. */
export function percentOf(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.min(999, Math.round((Math.abs(part) / Math.abs(whole)) * 100));
}

/** Today's year-month in America/New_York, "YYYY-MM". */
export function easternPeriod(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(now);
  return parts.slice(0, 7);
}

/** [start, end) UTC bounds of a "YYYY-MM" period. */
export function periodBounds(period: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) };
}
