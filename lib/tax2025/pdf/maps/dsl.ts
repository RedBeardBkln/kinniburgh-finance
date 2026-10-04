// Tiny helpers shared by the form maps (T2a/T2b). They only build the plain FormMap
// entries from lib/tax2025/pdf/types.ts so every map file stays a readable list of
// "field -> line" facts; they add no behaviour of their own. Field names are always the
// FULL AcroForm names from data/forms/2025/catalog/<formId>.fields.json.

import type { BlankReason, LineRef, MapBlank, MapMoneyLine } from "@/lib/tax2025/pdf/types";

/** One money field showing one engine line. `zero: "print"` = print "0" for a computed/not-applicable zero. */
export function money(field: string, line: LineRef, opts: { zero?: "print"; expected?: boolean } = {}): MapMoneyLine {
  const entry: MapMoneyLine = { kind: "money", field, line };
  if (opts.zero) entry.zero = opts.zero;
  if (opts.expected) entry.expected = true;
  return entry;
}

/** Exact-field blank entries sharing one reason: `blanks("ssn", `${P1}f1_16[0]`, ...)`. */
export function blanks(reason: BlankReason, ...fields: string[]): MapBlank[] {
  return fields.map((field) => ({ field, reason }));
}

/**
 * Blank entries that also carry a plain-language note: the cover lists the note so a box the app does not
 * decide (12a-12c, 7b, 3c-6d, ...) is never silently skipped. Entries sharing one note print one cover line.
 */
export function notedBlanks(reason: BlankReason, note: string, ...fields: string[]): MapBlank[] {
  return fields.map((field) => ({ field, reason, note }));
}

/** `prefix + id + "[0]"` for each id (the common field-name shape). */
export function ids(prefix: string, ...names: string[]): string[] {
  return names.map((n) => `${prefix}${n}[0]`);
}
