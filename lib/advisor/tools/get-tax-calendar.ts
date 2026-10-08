// Tool: get_tax_calendar. Shaper is PURE and unit-tested; reads are in queries/tax-calendar.ts (deadlines, and the household tax-year state
// through the fail-soft display reader). The year-close note and reopen reason, and the deadline notes, are never available to this file.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { firstNameOf } from "@/lib/advisor/names";
import { DEADLINE_CAP, loadDeadlines, loadYearCloseSummary, type DeadlineRow, type YearCloseSummary } from "@/lib/advisor/queries/tax-calendar";
import { safeDescriptive, safeField } from "@/lib/advisor/scrub";
import { isoDay } from "@/lib/advisor/tools/format";
import { optional, parseInput } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const MAX_YEARS = 6;
const DAY_MS = 86_400_000;

const schema = z.object({ year: optional(z.number().int().min(2000).max(2100)) }).strict();
type Input = z.output<typeof schema>;

const startOfDayUtc = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** The due-date window: a tax year's deadlines fall from January 1 of that year through the end of the next one; no year means 30 days ago onward. */
export function calendarWindow(year: number | undefined, now: Date): { from: Date; to: Date | null } {
  if (year === undefined) return { from: new Date(startOfDayUtc(now) - 30 * DAY_MS), to: null };
  return { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year + 2, 0, 1)) };
}

export function shapeTaxCalendar(deadlines: readonly DeadlineRow[], yearState: YearCloseSummary, now: Date): ToolOutput {
  const today = startOfDayUtc(now);
  const rows = deadlines.slice(0, DEADLINE_CAP).map((d) => {
    const daysUntil = Math.round((startOfDayUtc(d.dueDate) - today) / DAY_MS);
    return {
      entity: safeField(d.entity.name, 80),
      label: safeDescriptive(d.label, 100),
      due_date: isoDay(d.dueDate),
      type: safeField(d.type, 30),
      status: safeField(d.status, 20),
      days_until: daysUntil,
      overdue: daysUntil < 0 && d.status === "upcoming",
    };
  });
  const year_state = yearState.available
    ? {
        available: true,
        years: [...yearState.years]
          .sort((a, b) => b.taxYear - a.taxYear)
          .slice(0, MAX_YEARS)
          .map((y) => ({
            tax_year: y.taxYear,
            status: y.status,
            filed_on: isoDay(y.filedOn),
            closed_by_first_name: y.closedByName === null ? null : firstNameOf(y.closedByName),
            reopened_on: isoDay(y.reopenedAt),
          })),
      }
    : { available: false };
  return {
    data: {
      rows,
      year_state,
      notes: [
        "A deadline's status (upcoming, filed, waived) is its own label and is separate from the household's tax-year state (open, closed as filed, reopened), which the owner records on the Tax Forms hub. Neither one changes any number on the return.",
      ],
    },
    rows: rows.length,
    links: [links.taxForms(2025)],
  };
}

export const getTaxCalendarTool = defineTool<Input>({
  name: "get_tax_calendar",
  description:
    "Tax deadlines (estimated payments, filing and extension dates) with entity, due date, type, status, days until due and whether one is overdue, plus the household's tax-year state: open, closed as filed (with the filed date and first name) or reopened for revision. year is a tax year: it returns deadlines due from January 1 of that year through the end of the following year; without it, deadlines due from 30 days ago onward. Up to 40 deadlines. Deadline status and tax-year state are separate things.",
  inputJsonSchema: {
    type: "object",
    properties: { year: { type: "integer", description: "Optional. Tax year, for example 2025. Default: deadlines due from 30 days ago onward." } },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up the tax calendar",
  summarizeArgs: (i) => `year=${i.year ?? "upcoming"}`,
  run: async (ctx, i) => {
    const [deadlines, yearState] = await Promise.all([loadDeadlines(calendarWindow(i.year, ctx.now)), loadYearCloseSummary()]);
    return shapeTaxCalendar(deadlines, yearState, ctx.now);
  },
  maxChars: LIMITS.toolResultChars,
  phase: 2,
});
