// Validation for the tax year close actions (tax-carry-screen-and-year-close, Phase B).
//
// The note and the reopen reason are tax records: they are checked BEFORE anything is written and are refused when they look
// like an SSN, an EIN, an account or confirmation number (6+ digit runs) or a date of birth. A rejected text is never echoed.
// There is deliberately no field for a confirmation number. PURE: no DB, no network; the caller supplies `now`.

import { formatFactDate } from "@/lib/tax-facts/format";
import { containsPrivateIdentifier, privacyError, validateReason, type Checked } from "@/lib/tax-facts/validate";
import { NOTE_MAX } from "@/lib/tax-year-close/types";

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The date the owner says the return was filed: strict YYYY-MM-DD, a real calendar date, not before Jan 1 of the year after
 * the tax year (a TY2025 return cannot have been filed before 2026-01-01), not after today in America/New_York. Returned as a
 * Date at 12:00 UTC so it displays as the same calendar day in New York.
 */
export function parseFiledOn(text: string, taxYear: number, now: Date): Checked<Date> {
  const raw = text.trim();
  const m = DATE_SHAPE.exec(raw);
  if (!m) return { ok: false, error: "Enter the date you filed as year-month-day, for example 2026-10-12." };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return { ok: false, error: "That is not a real calendar date." };
  }
  const earliest = `${taxYear + 1}-01-01`;
  if (raw < earliest) {
    return { ok: false, error: `A TY${taxYear} return cannot have been filed before ${earliest}.` };
  }
  if (raw > formatFactDate(now)) return { ok: false, error: "The filing date cannot be in the future." };
  return { ok: true, value: date };
}

/** The optional note on a close: empty means none; at most NOTE_MAX characters; no private identifier. */
export function validateCloseNote(raw: string | null | undefined): Checked<string | null> {
  const text = (raw ?? "").trim();
  if (text.length === 0) return { ok: true, value: null };
  if (text.length > NOTE_MAX) return { ok: false, error: `The note must be ${NOTE_MAX} characters or fewer.` };
  if (containsPrivateIdentifier(text)) return { ok: false, error: privacyError("note") };
  return { ok: true, value: text };
}

/** The required reason on a reopen (3 to 500 characters, no private identifier). */
export function validateReopenReason(raw: string | null | undefined): Checked<string> {
  const r = validateReason(raw, true);
  if (!r.ok) return r;
  return { ok: true, value: r.value ?? "" };
}
