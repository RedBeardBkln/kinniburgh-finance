// Pure state rules of the "Add history" form (components/forecast/usage-upload-form.tsx), kept here so they can be tested
// without a DOM: a preview is only good for the exact text, utility, unit and column mapping it was computed with, and
// Save is allowed only for a current, error-free (or skip-ticked) preview. No database, no clock, no Decimal (this module
// is imported by a client component).

import type { ColumnRole, ParseOk, UsageKind, UsageUnit } from "@/lib/utility-usage-parse";

/** Identifies what a preview was computed from. Anything that changes the server's answer changes this key. */
export function formKey(kind: UsageKind, text: string, mapping: readonly ColumnRole[] | null, unit: UsageUnit): string {
  return JSON.stringify([kind, text, mapping, kind === "firewood" ? unit : null]);
}

export interface SaveState {
  preview: ParseOk | null;
  /** The key the shown preview was computed with. */
  previewKey: string | null;
  /** The key of the form as it is now. */
  currentKey: string;
  pending: boolean;
  skipBad: boolean;
}

/** Why Save is disabled, or null when it is allowed. */
export function saveBlockedReason(s: SaveState): string | null {
  if (s.pending) return "Working...";
  if (s.preview === null) return "Preview the text first.";
  if (s.previewKey !== s.currentKey) return "Something changed since the preview. Preview again before saving.";
  if (s.preview.mappingError !== null) return s.preview.mappingError;
  if (s.preview.rows.length === 0) return "There are no rows to save.";
  const errors = s.preview.rows.filter((r) => r.status === "error").length;
  if (errors > 0 && !s.skipBad) return `${errors} row${errors === 1 ? " has" : "s have"} an error. Fix ${errors === 1 ? "it" : "them"}, or tick skip.`;
  return null;
}
