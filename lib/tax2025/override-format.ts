// Display formatting shared by the overrides layer (overrides.ts) and the client
// dialog helpers (override-input.ts). PURE and dependency-free on purpose: the
// client bundle imports it, so it must not pull in the Prisma runtime.

export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 500;
/** 21,000,000 dollars = 2,100,000,000 cents, inside Postgres INTEGER (2,147,483,647). */
export const OVERRIDE_MAX_ABS_DOLLARS = 21_000_000;

const USD0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Whole dollars, e.g. "$12,345" / "-$500". */
export function formatDollars(dollars: number): string {
  return USD0.format(dollars);
}

const ET_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "2026-10-11" in America/New_York (en-CA is the YYYY-MM-DD locale). */
export function formatOverrideDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : ET_DATE.format(d);
}
