// The owner's choice for an overpayment: refund it, apply it to 2026 estimated tax, or apply a stated amount.
// Decisions X7 (Form 1040 line 34 -> lines 35a and 36) and X8 (CT-1040 line 22 -> lines 23 and 25).
//
// Dependency-free on purpose (no imports at all): it is read by the engine, the override feed, the server action,
// the review sheet and the client dialog helpers, so nothing here may pull a server module or a Decimal to the
// client. Whole dollars only, integer arithmetic only (parseInt on a digits-only string; no float parsing).
//
// The stored text (TaxReturnOverride.valueText, valueKind "choice") is one of:
//   refund_all            nothing is applied to 2026; the whole overpayment (less any printed line 38 penalty) is refunded
//   apply_all             the whole overpayment is applied to 2026 estimated tax
//   apply_amount:<n>      <n> whole dollars are applied to 2026; the rest is refunded
// Sources (read 2026-10-06, pinned pack data/tax-sources/2025): Form 1040 instructions, line 36 ("Enter on line 36
// the amount, if any, of the overpayment on line 34 you want applied to your 2026 estimated tax. ... This election
// to apply part or all of the amount overpaid to your 2026 estimated tax can't be changed later.") and CT-1040
// instructions, lines 23 to 25. See specs/09, "Overpayment: refund or apply to 2026".

export const OVERPAYMENT_MODES = ["refund_all", "apply_all", "apply_amount"] as const;
export type OverpaymentMode = (typeof OVERPAYMENT_MODES)[number];

/** The alternative shown while nothing is recorded (the lines print blank). Never storable. */
export const OVERPAYMENT_NO_ELECTION = "no_election";

/** An amount to apply is at most seven digits (the override dollar cap is the same order of magnitude). */
export const OVERPAYMENT_MAX_APPLIED_DIGITS = 7;

export const OVERPAYMENT_AMOUNT_PREFIX = "apply_amount:";

export const OVERPAYMENT_CHOICE_ERROR =
  'Choose "refund all", "apply all to 2026" or "apply a stated amount" (a whole number of dollars).';
export const OVERPAYMENT_WHOLE_DOLLARS_ERROR = "Enter whole dollars: the form takes whole dollars.";
export const OVERPAYMENT_AMOUNT_ERROR = "Enter the amount to apply as a whole number of dollars, at least 1.";

export type ParsedOverpaymentChoice =
  | { ok: true; mode: OverpaymentMode; appliedDollars: number | null; canonical: string }
  | { ok: false; error: string };

const AMOUNT_SHAPE = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)$/;
const CENTS_SHAPE = /^\$?\s*(?:\d{1,3}(?:,\d{3})+|\d*)\.\d*$/;

/** Parses the digits-only dollars of an amount text ("5000", "$5,000"); the error says why it was refused. */
export function parseOverpaymentAmount(text: string): { ok: true; dollars: number } | { ok: false; error: string } {
  const t = text.trim();
  if (CENTS_SHAPE.test(t)) return { ok: false, error: OVERPAYMENT_WHOLE_DOLLARS_ERROR };
  const m = AMOUNT_SHAPE.exec(t);
  if (!m) return { ok: false, error: OVERPAYMENT_AMOUNT_ERROR };
  const digits = (m[1] ?? "").replace(/,/g, "");
  if (digits.length > OVERPAYMENT_MAX_APPLIED_DIGITS) return { ok: false, error: OVERPAYMENT_AMOUNT_ERROR };
  const dollars = parseInt(digits, 10);
  if (!Number.isSafeInteger(dollars) || dollars < 1) return { ok: false, error: OVERPAYMENT_AMOUNT_ERROR };
  return { ok: true, dollars };
}

/** The canonical stored text of a mode (and, for apply_amount, the whole dollars). */
export function formatOverpaymentChoice(mode: OverpaymentMode, appliedDollars: number | null): string {
  return mode === "apply_amount" ? `${OVERPAYMENT_AMOUNT_PREFIX}${appliedDollars ?? 0}` : mode;
}

/** "refund_all", "apply_all", "apply_amount:5000" or "apply_amount:$5,000" -> mode, whole dollars and the canonical text. Anything else (a bare "apply_amount", cents, 0, text, extra parts) is refused. */
export function parseOverpaymentChoice(text: string): ParsedOverpaymentChoice {
  const t = text.trim();
  if (t === "refund_all") return { ok: true, mode: "refund_all", appliedDollars: null, canonical: "refund_all" };
  if (t === "apply_all") return { ok: true, mode: "apply_all", appliedDollars: null, canonical: "apply_all" };
  if (t.startsWith(OVERPAYMENT_AMOUNT_PREFIX)) {
    const amount = parseOverpaymentAmount(t.slice(OVERPAYMENT_AMOUNT_PREFIX.length));
    if (!amount.ok) return { ok: false, error: amount.error };
    return { ok: true, mode: "apply_amount", appliedDollars: amount.dollars, canonical: formatOverpaymentChoice("apply_amount", amount.dollars) };
  }
  return { ok: false, error: OVERPAYMENT_CHOICE_ERROR };
}

/** True when `text` is exactly what may be STORED for X7 / X8 (the canonical forms; "apply_amount:$5,000" is parsed but stored as "apply_amount:5000"). */
export function isStoredOverpaymentChoice(text: string): boolean {
  const p = parseOverpaymentChoice(text);
  return p.ok && p.canonical === text;
}

/** Whole dollars as "$5,000" (integer text only, no locale). */
export function formatWholeDollars(dollars: number): string {
  const sign = dollars < 0 ? "-" : "";
  const abs = dollars < 0 ? -dollars : dollars;
  return `${sign}$${String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** How a person reads a stored choice: "Refund all", "Apply all to 2026", "Apply $5,000 to 2026". Null when the text is not a valid choice. */
export function overpaymentChoiceLabel(text: string): string | null {
  const p = parseOverpaymentChoice(text);
  if (!p.ok) return null;
  if (p.mode === "refund_all") return "Refund all";
  if (p.mode === "apply_all") return "Apply all to 2026";
  return `Apply ${formatWholeDollars(p.appliedDollars ?? 0)} to 2026`;
}

export interface OverpaymentSplit {
  /** Refunded (Form 1040 line 35a / CT-1040 line 25), whole dollars. */
  refunded: number;
  /** Applied to 2026 estimated tax (Form 1040 line 36 / CT-1040 line 23), whole dollars. */
  applied: number;
}

/**
 * The split of an available overpayment (whole dollars, already rounded) under a choice, or null when an
 * `apply_amount` is more than is available (the caller blocks: never print a number that does not add up).
 */
export function splitOverpayment(available: number, mode: OverpaymentMode, appliedDollars: number | null): OverpaymentSplit | null {
  if (mode === "refund_all") return { refunded: available, applied: 0 };
  if (mode === "apply_all") return { refunded: 0, applied: available };
  const a = appliedDollars ?? 0;
  if (a < 1 || a > available) return null;
  return { refunded: available - a, applied: a };
}

/** The live preview of the dialog: "Refunded: $11,054; applied to 2026: $5,000". Null while the amount is not a valid whole number within the limit. */
export function overpaymentPreview(available: number, mode: OverpaymentMode, amountText: string): string | null {
  const applied = mode === "apply_amount" ? parseOverpaymentAmount(amountText) : null;
  if (applied !== null && !applied.ok) return null;
  const split = splitOverpayment(available, mode, applied === null ? null : applied.ok ? applied.dollars : null);
  if (split === null) return null;
  return `Refunded: ${formatWholeDollars(split.refunded)}; applied to 2026: ${formatWholeDollars(split.applied)}`;
}

/** The two decisions' labels (shared by the engine and the decision registry; neutral wording: it travels to the AI payload). */
export const OVERPAYMENT_LABELS = {
  X7: "Overpayment on Form 1040 line 34: refund or apply to 2026 estimated tax (lines 35a and 36)",
  X8: "Overpayment on CT-1040 line 22: refund or apply to 2026 estimated tax (lines 23 and 25)",
} as const;
