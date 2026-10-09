// Server-side validation of the name the owner types when adding a recurring pattern as a recurring expense.
// Not a "use server" file (it exports a plain function). PURE. Never echoes the rejected text.

import { findRedactionIssues } from "@/lib/tax-review/redact";

export const RECURRING_NAME_MAX = 80;

export const RECURRING_NAME_REQUIRED = `Give it a name (1 to ${RECURRING_NAME_MAX} characters).`;
export const RECURRING_NAME_HTML = "The name cannot contain < or > or control characters.";
export const RECURRING_NAME_IDENTIFIER = "That name looks like it contains an ID or account number; remove it.";

export type NameCheck = { ok: true; value: string } | { ok: false; error: string };

/**
 * Trimmed, whitespace collapsed, invisible format characters removed; 1..80 characters; no HTML-ish angle brackets or
 * control characters; refused (never rewritten) when it looks like an SSN, EIN, card or long account number.
 */
export function validateRecurringName(raw: unknown): NameCheck {
  if (typeof raw !== "string") return { ok: false, error: RECURRING_NAME_REQUIRED };
  const text = raw
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 1 || text.length > RECURRING_NAME_MAX) return { ok: false, error: RECURRING_NAME_REQUIRED };
  if (/[<>\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: RECURRING_NAME_HTML };
  if (findRedactionIssues(text).length > 0) return { ok: false, error: RECURRING_NAME_IDENTIFIER };
  return { ok: true, value: text };
}
