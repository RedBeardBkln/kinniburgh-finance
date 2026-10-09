// A stable, non-sensitive link from a RecurringExpense back to the recurring pattern (lib/recurring-detect.ts series)
// it was created from. It lives in RecurringExpense.notes (no schema change): "[pattern:<series key>]". The series key is
// `${entityId}|${accountId}|out|${canonical payee}`: uuids and the lower-case payee text, never an account number.
//
// Why it exists: the "already recorded" check and the detector's suppression used to compare NAMES, so a renamed
// recurring expense (the owner may now name it on Add) would be offered again. The marker keys both on the series itself.
//
// PURE and import-free so the client component that displays notes can use it.

const MARKER_RE = /\s*\[pattern:([^\][\r\n]{1,320})\]/;

/** `[pattern:<key>]`, the text stored in notes. */
export function seriesMarker(seriesKey: string): string {
  return `[pattern:${seriesKey}]`;
}

/** The series key named by a notes string, or null. */
export function seriesKeyFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const m = MARKER_RE.exec(notes);
  return m ? (m[1] as string) : null;
}

/** Notes as a person should read them: the marker removed, null when nothing else is left. */
export function visibleNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const text = notes.replace(MARKER_RE, "").trim();
  return text === "" ? null : text;
}
