// Benchtop time on an invoice (EK Consulting only; see CLAUDE.md "Benchtop time import"). PURE: no DB, no clock, safe in a client
// component. Benchtop (the owner's formulation app) keeps the time log; an invoice DRAFT imports the finished, unbilled entries of
// the linked Benchtop client as hourly lines, and each line remembers the Benchtop entry ids it covers (`BillingLine.timeEntryIds`).
// Issuing the invoice marks those entries billed in Benchtop with the invoice number; voiding it marks them unbilled again.

import { MAX_LINE_DESCRIPTION } from "@/lib/invoicing/constants";

/** One finished, unbilled Benchtop entry, as Benchtop's /api/connect/time/entries returns it. */
export interface BenchtopEntry {
  id: string;
  startedAt: string;
  endedAt: string;
  minutes: number;
  activity: string;
  task: string;
  projectName: string | null;
  person: string;
}

export const TIME_GROUPINGS = ["entry", "day", "project"] as const;
export type TimeGrouping = (typeof TIME_GROUPINGS)[number];
export const TIME_GROUPING_LABELS: Record<TimeGrouping, string> = {
  entry: "One line per entry",
  day: "One line per day",
  project: "One line per project",
};

/** Hours on a line are rounded to the nearest step (in thousandths of an hour): exact (0.01 hr), 0.1 hr or 0.25 hr. */
export const TIME_ROUNDINGS = ["exact", "tenth", "quarter"] as const;
export type TimeRounding = (typeof TIME_ROUNDINGS)[number];
export const TIME_ROUNDING_LABELS: Record<TimeRounding, string> = {
  exact: "Exact (to 0.01 hr)",
  tenth: "Nearest 0.1 hr",
  quarter: "Nearest 0.25 hr",
};
const STEP_MILLI: Record<TimeRounding, number> = { exact: 10, tenth: 100, quarter: 250 };

/** Most entry ids one line can carry, and one invoice (Benchtop's own limit per request is 2000). */
export const MAX_TIME_ENTRIES_PER_LINE = 500;
export const MAX_TIME_ENTRIES_PER_DOCUMENT = 2000;

/** The entry's start as an America/New_York calendar day, "YYYY-MM-DD" (the repo displays dates in New York time). */
export function nyWorkDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Minutes to hours as quantity text, rounded half-up to the step; null when that rounds to zero (a line needs a quantity above zero). */
export function hoursText(minutes: number, rounding: TimeRounding): string | null {
  const step = STEP_MILLI[rounding];
  // minutes * 1000 / 60 thousandths of an hour, rounded half-up to the step, in integers only
  const milli = Math.floor((minutes * 1000 * 2 + 60 * step) / (60 * step * 2)) * step;
  if (milli <= 0) return null;
  const whole = Math.floor(milli / 1000);
  const frac = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function joinCapped(parts: string[], max: number): string {
  const unique = [...new Set(parts.map(oneLine).filter((p) => p !== ""))];
  let out = unique.join("; ");
  if (out.length > max) out = `${out.slice(0, max - 1).trimEnd()}…`;
  return out;
}

const entryText = (e: BenchtopEntry) => `${e.activity}: ${oneLine(e.task)}`;

export interface TimeLine {
  description: string;
  quantity: string;
  unit: string;
  workDate: string;
  timeEntryIds: string[];
  minutes: number;
}

/**
 * Groups the chosen entries into invoice lines, oldest first. Each line's hours are rounded once (after grouping). A group that
 * rounds to zero hours is left out and its entries are returned in `skipped`, so they stay unbilled in Benchtop.
 */
export function buildTimeLines(entries: BenchtopEntry[], opts: { grouping: TimeGrouping; rounding: TimeRounding }): { lines: TimeLine[]; skipped: string[] } {
  const sorted = [...entries].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const groups = new Map<string, BenchtopEntry[]>();
  for (const e of sorted) {
    const key = opts.grouping === "entry" ? e.id : opts.grouping === "day" ? nyWorkDate(e.startedAt) : (e.projectName ?? "");
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const lines: TimeLine[] = [];
  const skipped: string[] = [];
  for (const [key, group] of groups) {
    // A line carries at most MAX_TIME_ENTRIES_PER_LINE ids; a bigger group becomes several lines
    for (let i = 0; i < group.length; i += MAX_TIME_ENTRIES_PER_LINE) {
      const chunk = group.slice(i, i + MAX_TIME_ENTRIES_PER_LINE);
      const minutes = chunk.reduce((s, e) => s + Math.max(0, e.minutes), 0);
      const quantity = hoursText(minutes, opts.rounding);
      if (quantity === null) {
        skipped.push(...chunk.map((e) => e.id));
        continue;
      }
      const last = chunk[chunk.length - 1]!;
      let description: string;
      if (opts.grouping === "entry") description = joinCapped([`${last.projectName ? `${last.projectName} · ` : ""}${entryText(last)}`], MAX_LINE_DESCRIPTION);
      else if (opts.grouping === "day") description = joinCapped(chunk.map((e) => `${e.projectName ? `${e.projectName} · ` : ""}${entryText(e)}`), MAX_LINE_DESCRIPTION);
      else description = joinCapped([`${key || "General"}: ${joinCapped(chunk.map(entryText), MAX_LINE_DESCRIPTION)}`], MAX_LINE_DESCRIPTION);
      lines.push({ description, quantity, unit: "hr", workDate: nyWorkDate(last.startedAt), timeEntryIds: chunk.map((e) => e.id), minutes });
    }
  }
  return { lines, skipped };
}

// ── Billed status in Benchtop for an issued or void invoice ──────────────────────────────

export type TimeSyncKind = "time_billed" | "time_bill_failed" | "time_unbilled" | "time_unbill_failed";

/**
 * Whether Benchtop still needs to hear about this invoice's time, from its timeline (newest sync event wins): an issued invoice needs
 * its entries marked billed, a void one needs them marked unbilled. null = nothing to do (a draft, no imported time, or already done).
 */
export function pendingTimeSync(
  status: string,
  entryCount: number,
  events: { kind: string; createdAt: string }[]
): { direction: "bill" | "unbill"; failed: boolean } | null {
  if (entryCount === 0 || (status !== "issued" && status !== "void")) return null;
  const direction = status === "issued" ? "bill" : "unbill";
  const done = direction === "bill" ? "time_billed" : "time_unbilled";
  const fail = direction === "bill" ? "time_bill_failed" : "time_unbill_failed";
  const latest = [...events].filter((e) => e.kind === done || e.kind === fail).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest?.kind === done) return null;
  return { direction, failed: latest?.kind === fail };
}

/** Every Benchtop entry id on the lines, once each. */
export function documentTimeEntryIds(lines: { timeEntryIds: string[] }[]): string[] {
  return [...new Set(lines.flatMap((l) => l.timeEntryIds))];
}

/** "175" / "175.5" / "$175.00" -> cents, or null; a rate is 0.01 to 10,000.00 dollars an hour. */
export function parseHourlyRate(raw: string): number | null {
  const m = /^\$?\s*(\d{1,5})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents > 0 && cents <= 1_000_000 ? cents : null;
}
