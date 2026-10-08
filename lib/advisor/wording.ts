// Output wording for the assistant (plan section 11). PURE.
//
// Model text goes through, in this order: `ownerWording` (the repo's rewrite of "the CPA decides" prose), `redactText`
// (identifier-shaped numbers), then `enforceWording`: any sentence that still implies professional review, certification or
// licensure is removed and one neutral line is appended. The honesty statements ("I am not a CPA") are allowed by
// `findOwnerBannedWording` itself (HONESTY_ALLOWLIST).

import { findOwnerBannedWording, ownerWording } from "@/lib/tax-wording";
import { redactText } from "@/lib/advisor/scrub";

export const WORDING_REMOVED_NOTE =
  "A sentence was removed because it implied professional review; this assistant is software, not a CPA, EA or attorney.";

/** Split into sentences without losing line structure (markdown lists and tables stay one item per line). */
function sentencesOf(line: string): string[] {
  const parts = line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[*_`])/);
  return parts.length > 0 ? parts : [line];
}

export interface EnforcedText {
  text: string;
  removed: number;
}

export function enforceWording(text: string): EnforcedText {
  let removed = 0;
  const lines = text.split("\n").map((line) => {
    if (findOwnerBannedWording(line).length === 0) return line;
    const kept = sentencesOf(line).filter((s) => {
      if (findOwnerBannedWording(s).length === 0) return true;
      removed += 1;
      return false;
    });
    return kept.join(" ");
  });
  if (removed === 0) return { text, removed: 0 };
  const body = lines.filter((l, i) => l.trim() !== "" || (lines[i - 1] ?? "").trim() !== "").join("\n").trim();
  return { text: body === "" ? WORDING_REMOVED_NOTE : `${body}\n\n${WORDING_REMOVED_NOTE}`, removed };
}

/** The full pipeline for text shown to / stored for the user. Idempotent. */
export function finalizeModelText(text: string): string {
  const reworded = ownerWording(text);
  const redacted = redactText(reworded);
  return enforceWording(redacted).text;
}

/** For streamed chunks: wording + redaction only (sentence removal happens once on the final text, which replaces the chunks). */
export function previewModelText(chunk: string): string {
  return redactText(ownerWording(chunk));
}
