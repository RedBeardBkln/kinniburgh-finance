// Document numbering (plan section 7). PURE. The actual allocation happens inside the issue transaction in lib/invoicing/store.ts
// (UPDATE ... SET next = next + 1 RETURNING under the row lock); this module only formats numbers and judges counter edits.

import { MAX_DOC_NUMBER, MAX_NUMBER_PAD } from "@/lib/invoicing/constants";

/** "INV-" + 42 padded to 5 -> "INV-00042"; a number longer than the pad is never truncated ("INV-10000" with pad 4). */
export function formatDisplayNumber(prefix: string, n: number, pad: number): string {
  const p = Number.isInteger(pad) && pad > 0 ? Math.min(pad, MAX_NUMBER_PAD) : 0;
  return `${prefix}${String(n).padStart(p, "0")}`;
}

/**
 * A quote number as printed: prefix + number, e.g. ("Q-", 2001) -> "Q-2001" (owner decision 2026-10-16; invoices keep no prefix and start
 * at 3100). Quotes use the same zero padding as invoices. The quote WORKFLOW (task 1.11) is not built yet; this and the setup counter
 * are the numbering groundwork only.
 */
export function formatQuoteNumber(prefix: string, n: number, pad = 0): string {
  return formatDisplayNumber(prefix, n, pad);
}

export function isValidDocumentNumber(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_DOC_NUMBER;
}

export function isValidPrefix(prefix: string): boolean {
  return prefix.length <= 12 && /^[A-Za-z0-9._\-/ ]*$/.test(prefix) && !/\s{2,}/.test(prefix);
}

/**
 * A quote prefix must be a valid prefix that is already trimmed (no leading or trailing space), non-empty, contains at least one
 * non-digit (so "3" + 2001 can never print as 32001) and differs from the invoice prefix (case-insensitively), so a quote number can
 * never be mistaken for an invoice number. Invoices print with no prefix by default, so an empty invoice prefix never equals it.
 */
export function isValidQuotePrefix(prefix: string, invoicePrefix = ""): boolean {
  if (prefix !== prefix.trim() || prefix.length === 0) return false;
  if (!/\D/.test(prefix)) return false;
  if (!isValidPrefix(prefix)) return false;
  return prefix.toLowerCase() !== invoicePrefix.trim().toLowerCase();
}

export const QUOTE_PREFIX_RULE_MESSAGE =
  "The quote prefix is required (for example Q-). It may only use letters, digits and . _ - / (up to 12 characters, no spaces at the ends), must include a character that is not a digit, and must differ from the invoice prefix.";

/**
 * Whether the owner may set the next number to `requested`. The counter can only go up: it must be a valid number and greater
 * than the highest number already used for that kind (numbers are never reused, voids keep theirs). `highestUsed` is null when
 * none has been issued yet. The unique (entityId, kind, number) index is the backstop.
 */
export function canSetNextNumber(requested: number, highestUsed: number | null): { ok: true } | { ok: false; error: string } {
  if (!isValidDocumentNumber(requested)) return { ok: false, error: `The next number must be a whole number from 1 to ${MAX_DOC_NUMBER}.` };
  if (highestUsed !== null && requested <= highestUsed) {
    return { ok: false, error: `Numbers are never reused. The next number must be higher than ${highestUsed}, the highest already issued.` };
  }
  return { ok: true };
}

/** Editing an existing counter: it can only go up (never below its current value) and never to a number already used. */
export function canChangeCounter(current: number, requested: number, highestUsed: number | null): { ok: true } | { ok: false; error: string } {
  const base = canSetNextNumber(requested, highestUsed);
  if (!base.ok) return base;
  if (requested < current) return { ok: false, error: `The counter can only go up. The next number is ${current}; it cannot be set lower.` };
  return { ok: true };
}
