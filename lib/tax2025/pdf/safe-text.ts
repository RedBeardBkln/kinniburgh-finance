// One guard for EVERY string that is written into a PDF (plan section 6.4): form-field
// text, field tooltips, the cover page, continuation lists and the page stamp.
//   1. SSN-like text (containsSsnLikeText) is refused and replaced by a neutral
//      placeholder, so the digits never reach the file;
//   2. everything else is made WinAnsi-safe (pdf-lib throws on other characters).
// Callers that can raise open items must do so when `refused` is true, WITHOUT
// echoing the original text (it may be a social security number).

import { containsSsnLikeText } from "@/lib/tax-extraction-schema";
import { sanitizeWinAnsi } from "@/lib/tax2025/pdf/winansi";

export const SSN_PLACEHOLDER = "[withheld: text looked like an SSN]";

export interface SafeText {
  /** WinAnsi-safe text, or SSN_PLACEHOLDER when refused. */
  text: string;
  refused: boolean;
}

export function safeText(raw: string): SafeText {
  if (containsSsnLikeText(raw)) return { text: SSN_PLACEHOLDER, refused: true };
  const text = sanitizeWinAnsi(raw);
  // Sanitising can bring digit groups together (e.g. by dropping zero-width characters): re-check.
  if (containsSsnLikeText(text)) return { text: SSN_PLACEHOLDER, refused: true };
  return { text, refused: false };
}
