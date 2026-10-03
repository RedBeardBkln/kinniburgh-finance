// Pure parsing of an owner-typed dollar amount into INTEGER CENTS. No floats on
// the money path: the string is split into its whole-dollar and cent digits and
// combined as integers (never `parseFloat(x) * 100`, which turns 19.99 into
// 1998.9999999999998). Nothing is ever rounded - a third decimal digit is
// rejected so the owner never silently loses or gains a fraction of a cent.
//
// Client-safe (no imports). Use `formatCentsDisplay` from
// lib/tax-extraction-schema.ts to display cents; do NOT use lib/utils.ts#formatUSD
// for cents (it formats dollars despite its doc comment).

/** Prisma `Int` column ceiling (Postgres INTEGER): 21,474,836.47 dollars. */
export const MAX_INT_CENTS = 2_147_483_647;

export interface ParseDollarsOptions {
  /** Accept 0 / 0.00 (default: reject). */
  allowZero?: boolean;
  /** Largest accepted value in cents (default MAX_INT_CENTS). */
  maxCents?: number;
}

export type ParseDollarsResult = { ok: true; cents: number } | { ok: false; error: string };

// Optional leading "$"; either plain digits or properly grouped thousands
// ("1,250"); optional 1-2 decimal digits. A leading digit is required (".5" is
// rejected), as are signs, exponents and any text.
const DOLLARS_RE = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

export function parseDollarsToCents(raw: string, opts: ParseDollarsOptions = {}): ParseDollarsResult {
  const maxCents = opts.maxCents ?? MAX_INT_CENTS;
  if (typeof raw !== "string") return { ok: false, error: "Enter a dollar amount" };
  const text = raw.trim();
  if (text === "") return { ok: false, error: "Enter a dollar amount" };
  if (text.startsWith("-")) return { ok: false, error: "The amount cannot be negative" };

  const match = DOLLARS_RE.exec(text);
  if (!match) {
    return { ok: false, error: "Enter dollars and cents like 1250 or 1,250.50 (no more than 2 decimals)" };
  }

  const dollarDigits = match[1]!.replace(/,/g, "");
  const centDigits = (match[2] ?? "").padEnd(2, "0");
  // Reject before multiplying so an absurdly long digit string can't lose
  // integer precision on the way to the ceiling check.
  if (dollarDigits.replace(/^0+(?=\d)/, "").length > 10) {
    return { ok: false, error: "That amount is too large" };
  }
  const cents = Number(dollarDigits) * 100 + Number(centDigits);

  if (cents > maxCents) return { ok: false, error: "That amount is too large" };
  if (cents === 0 && !opts.allowZero) return { ok: false, error: "The amount must be greater than zero" };
  return { ok: true, cents };
}
