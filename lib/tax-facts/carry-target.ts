// Which tax years the carry screen may target (tax-carry-screen-and-year-close, decision D5).
//
// The carry screen carries facts INTO a new tax year. It never targets TY2025 or earlier (the TY2025 return is a
// fingerprint-bound artifact that is being filed or already filed), never a year beyond next calendar year, and (once
// a tax year can be marked filed) never a year that is itself marked filed or earlier. `latestClosedYear` is a
// parameter: null means "no year is marked filed", so only the 2025 floor applies.
//
// PURE: no DB, no network; the caller supplies `now`.

/** The first tax year the carry screen may target. TY2025 and earlier are refused. */
export const FIRST_CARRY_TARGET_YEAR = 2026;

export type CarryTargetCode = "not_a_year" | "too_early" | "too_far" | "closed";

export type CarryTargetCheck = { ok: true } | { ok: false; code: CarryTargetCode; message: string };

export interface CarryTargetContext {
  /** The latest tax year whose state is "marked filed" (a reopened year does not count); null when none. */
  latestClosedYear: number | null;
  now: Date;
}

/** The calendar year in America/New_York (the owner's clock), not UTC, so New Year's Eve evenings are not off by one. */
export function currentCalendarYear(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric" }).format(now);
  return Number.parseInt(parts, 10);
}

/** A context for a caller that has no injectable clock of its own (a server page); tests pass `now`. */
export function carryTargetContext(latestClosedYear: number | null, now: Date = new Date()): CarryTargetContext {
  return { latestClosedYear, now };
}

export const TOO_EARLY_MESSAGE =
  "TY2025 and earlier are the returns being filed or already filed; facts for those years are not carried or re-confirmed on this screen.";

export function checkCarryTarget(year: number, ctx: CarryTargetContext): CarryTargetCheck {
  if (!Number.isInteger(year)) {
    return { ok: false, code: "not_a_year", message: "That is not a tax year." };
  }
  if (year < FIRST_CARRY_TARGET_YEAR) {
    return { ok: false, code: "too_early", message: TOO_EARLY_MESSAGE };
  }
  if (ctx.latestClosedYear !== null && year <= ctx.latestClosedYear) {
    return {
      ok: false,
      code: "closed",
      message: `TY${ctx.latestClosedYear} is marked filed, so TY${year} is not carried into. Reopen TY${ctx.latestClosedYear} on the Tax Forms page first.`,
    };
  }
  const last = currentCalendarYear(ctx.now) + 1;
  if (year > last) {
    return { ok: false, code: "too_far", message: `TY${year} is too far ahead; the latest year offered is TY${last}.` };
  }
  return { ok: true };
}

/** The first year offered: 2026, or the year after the latest year marked filed, whichever is later. */
export function firstCarryTarget(latestClosedYear: number | null): number {
  return Math.max(FIRST_CARRY_TARGET_YEAR, (latestClosedYear ?? 0) + 1);
}

/** Years offered as chips, oldest first: firstTarget through next calendar year (empty when a filed year is already that far ahead). */
export function carryTargetYears(ctx: CarryTargetContext): number[] {
  const first = firstCarryTarget(ctx.latestClosedYear);
  const last = currentCalendarYear(ctx.now) + 1;
  const years: number[] = [];
  for (let y = first; y <= last; y += 1) years.push(y);
  return years;
}

/** The year the links point at: the first year offered. */
export function defaultCarryTarget(ctx: CarryTargetContext): number {
  return firstCarryTarget(ctx.latestClosedYear);
}
