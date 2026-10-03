// Pure date helpers for the donation log and fixed-asset register.
//
// Convention (matches the mileage log, `T12:00:00Z`): a calendar date the owner
// enters is stored as NOON UTC of that day. Noon UTC is the same calendar day in
// America/New_York all year round (UTC-5 / UTC-4), so the UTC date and the
// displayed Eastern date never disagree and a year boundary never slips.

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const MIN_LOG_YEAR = 2000;
export const MAX_LOG_YEAR = 2100;

/**
 * "YYYY-MM-DD" -> Date at 12:00:00Z, or null when malformed, not a real calendar
 * day (2025-02-30 is rejected via a round-trip check) or outside 2000-2100.
 */
export function parseIsoDateNoonUtc(raw: string): Date | null {
  if (typeof raw !== "string") return null;
  const m = ISO_DATE_RE.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < MIN_LOG_YEAR || year > MAX_LOG_YEAR) return null;
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

/** Half-open [start, endExclusive) UTC bounds of a tax (calendar) year. */
export function taxYearBoundsUtc(year: number): { start: Date; endExclusive: Date } {
  return { start: new Date(Date.UTC(year, 0, 1)), endExclusive: new Date(Date.UTC(year + 1, 0, 1)) };
}

/** The UTC calendar year of a stored date. */
export function taxYearOfDate(d: Date): number {
  return d.getUTCFullYear();
}

/** "YYYY-MM-DD" of a stored (noon UTC) date, for form inputs. */
export function toIsoDateInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Display a stored date in America/New_York, e.g. "Mar 5, 2025". */
export function formatDateEt(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}
