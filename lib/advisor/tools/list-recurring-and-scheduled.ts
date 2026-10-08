// Tool: list_recurring_and_scheduled. Shaper is PURE and unit-tested; the reads are in queries/schedule.ts.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { SCHEDULE_PER_SECTION, loadSchedule, type ScheduleKind, type ScheduleRows, type ScheduledBillRow } from "@/lib/advisor/queries/schedule";
import { safeField } from "@/lib/advisor/scrub";
import { centsOf, dollarsOf, isoDay } from "@/lib/advisor/tools/format";
import { optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const KINDS = ["recurring_expenses", "bills", "transfers", "income", "all"] as const;
const TOTAL_CAP = 100;

const schema = z.object({ entity: optional(shortText), kind: optional(z.enum(KINDS)) }).strict();
type Input = z.output<typeof schema>;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function listDays(days: readonly unknown[]): string {
  const ok = days.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 31).slice(0, 4);
  if (ok.length === 0) return "";
  return ok.length === 1 ? String(ok[0]) : `${ok.slice(0, -1).join(", ")} and ${ok[ok.length - 1]}`;
}

/** The short text for a cadence + `dayRules` JSON ("semi-monthly on 15 and 30"). The raw JSON is never returned. */
export function summarizeDayRules(cadence: string, rules: unknown): string {
  const r = isRecord(rules) ? rules : {};
  switch (cadence) {
    case "weekly": {
      const dow = r["dayOfWeek"];
      return typeof dow === "number" && Number.isInteger(dow) && dow >= 0 && dow <= 6 ? `weekly on ${WEEKDAYS[dow]}` : "weekly";
    }
    case "semi_monthly": {
      const days = Array.isArray(r["daysOfMonth"]) ? listDays(r["daysOfMonth"]) : "";
      return days !== "" ? `semi-monthly on ${days}` : "semi-monthly";
    }
    case "monthly": {
      const d = r["dayOfMonth"];
      return typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 31 ? `monthly on day ${d}` : "monthly";
    }
    case "biweekly": {
      const iv = r["intervalDays"];
      const n = typeof iv === "number" && Number.isInteger(iv) && iv > 0 && iv <= 366 ? iv : 14;
      const a = r["anchorDate"];
      return typeof a === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a) ? `every ${n} days from ${a}` : `every ${n} days`;
    }
    default:
      return "custom schedule";
  }
}

function billTiming(b: ScheduledBillRow): string {
  const dow = b.payDayOfWeek !== null && b.payDayOfWeek >= 0 && b.payDayOfWeek <= 6 ? WEEKDAYS[b.payDayOfWeek] : null;
  switch (b.frequency) {
    case "weekly":
      return dow !== null ? `weekly on ${dow}` : "weekly";
    case "biweekly":
      return dow !== null ? `every other ${dow}` : "every two weeks";
    case "annual":
    case "semiannual": {
      const month = b.payMonth !== null && b.payMonth >= 1 && b.payMonth <= 12 ? MONTHS[b.payMonth - 1] : null;
      const day = b.autopayDay !== null ? ` ${b.autopayDay}` : "";
      return `${b.frequency === "annual" ? "once a year" : "twice a year"}${month !== null ? ` from ${month}${day}` : ""}`;
    }
    default:
      return b.autopayDay !== null ? `monthly on day ${b.autopayDay}` : "monthly";
  }
}

function cap<T>(rows: readonly T[], remaining: { n: number }, flags: string[], label: string): T[] {
  const room = Math.max(0, Math.min(SCHEDULE_PER_SECTION, remaining.n));
  if (rows.length > room) flags.push(label);
  const out = rows.slice(0, room);
  remaining.n -= out.length;
  return out;
}

export function shapeSchedule(rows: ScheduleRows): ToolOutput {
  const remaining = { n: TOTAL_CAP };
  const cut: string[] = [];
  const recurring = cap(rows.recurringExpenses, remaining, cut, "recurring_expenses").map((r) => ({
    name: safeField(r.name, 80),
    entity: safeField(r.entity.name, 80),
    amount: dollarsOf(r.amountCents),
    frequency: safeField(r.frequency, 20),
    due_day: r.dueDay,
    next_due: isoDay(r.nextDueDate),
    budget_tag: r.tag === null ? null : safeField(r.tag.shortName, 60),
  }));
  const bills = cap(rows.bills, remaining, cut, "bills").map((b) => ({
    payee: safeField(b.payee, 80),
    entity: safeField(b.entity.name, 80),
    account: safeField(b.account.nickname, 60),
    amount_type: safeField(b.amountType, 20),
    monthly_amount: dollarsOf(centsOf(b.expectedAmount)),
    annual_budget: dollarsOf(centsOf(b.annualBudget)),
    timing: billTiming(b),
    active: b.active,
  }));
  const transfers = cap(rows.transfers, remaining, cut, "transfers").map((t) => ({
    purpose: t.purpose === null ? null : safeField(t.purpose, 80),
    from_account: safeField(t.fromAccount.nickname, 60),
    to_account: safeField(t.toAccount.nickname, 60),
    amount: dollarsOf(centsOf(t.amount)),
    schedule: summarizeDayRules(t.cadence, t.dayRules),
    active: t.active,
  }));
  const income = cap(rows.income, remaining, cut, "income").map((s) => ({
    description: safeField(s.description, 80),
    entity: safeField(s.entity.name, 80),
    deposit_account: safeField(s.account.nickname, 60),
    amount: dollarsOf(centsOf(s.amount)),
    schedule: summarizeDayRules(s.cadence, s.dayRules),
    active: s.active,
  }));
  const count = recurring.length + bills.length + transfers.length + income.length;
  return {
    data: {
      recurring_expenses: recurring,
      bills,
      transfers,
      income,
      ...(cut.length > 0 ? { sections_truncated: cut } : {}),
      notes: [
        "Bill amounts are monthly totals regardless of frequency (for an annual bill the monthly amount is the set-aside and annual_budget is the total due). Inactive items are listed with active=false and are not used in the forecast.",
      ],
    },
    rows: count,
    links: [links.forecast(), links.budgets()],
  };
}

export const listRecurringAndScheduledTool = defineTool<Input>({
  name: "list_recurring_and_scheduled",
  description:
    "Lists what is set up to repeat: recurring expenses, scheduled bills, scheduled transfers between accounts, and income sources (paychecks), each with amount, schedule in plain words, entity or account nicknames and whether it is active. kind is recurring_expenses, bills, transfers, income or all (default all). entity (name or slug) is optional. Up to 40 per section and 100 in total. Use get_forecast for projected balances.",
  inputJsonSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Optional. Entity name or slug to restrict to." },
      kind: { type: "string", description: "Optional. One of recurring_expenses, bills, transfers, income, all. Default all." },
    },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up recurring items",
  summarizeArgs: (i) => `kind=${i.kind ?? "all"}, entity=${i.entity === undefined ? "all" : "set"}`,
  run: async (_ctx, i) => {
    const kind: ScheduleKind = i.kind ?? "all";
    return shapeSchedule(await loadSchedule({ ...(i.entity !== undefined ? { entity: i.entity } : {}), kind }));
  },
  maxChars: LIMITS.toolResultChars,
  phase: 2,
});
