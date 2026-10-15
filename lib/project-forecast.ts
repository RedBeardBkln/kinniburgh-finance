// How a Project enters the forecast. Pure: no database, no clock (the caller passes today), no Next imports.
//
// A project is a ONE-TIME planned expense when it has all three of: an account to pay it from, an amount still to be
// spent, and a target date that has not passed. With NO target date it is an ONGOING project (not a one-time expense):
// it is never put on a date and never counted in a projection. A project without an account is also left out and
// flagged, because the forecast cannot say whose balance it draws on. Nothing is ever guessed.
//
// The amount is what is LEFT of the project's budget: budget minus the project's spending so far (project-assigned
// transactions that are outflows plus its receipts, the same definition the Projects pages show). Spending already
// made has already left the account, so counting the whole budget again would overstate the outflow.
import { Decimal } from "@prisma/client/runtime/library";
import type { ScheduleEvent } from "@/lib/forecast";

export interface ProjectForecastInput {
  id: string;
  name: string;
  entityId: string | null;
  accountId: string | null;
  /** The entity that owns the paying account: whose money the project spends (the ledger groups by it). */
  accountEntityId?: string | null;
  /** active | completed | paused; only active projects are forecast. */
  status: string;
  budget: Decimal;
  /** Spent so far (positive), as shown on the Projects pages. */
  spent: Decimal;
  /** Calendar day stored at UTC midnight; null = ongoing. */
  targetDate: Date | null;
}

export type ProjectForecastState =
  /** A dated one-time outflow of `amount` (positive, what is left of the budget) from `accountId` on `date`. */
  | { state: "counted"; amount: Decimal; date: Date; accountId: string }
  /** No target date: an ongoing project, not a one-time expense. Not in any projection. */
  | { state: "ongoing" }
  /** No account assigned: left out until one is chosen. */
  | { state: "no_account" }
  /** The target date is before today and the budget is not used up: left out until the date is updated. */
  | { state: "target_passed"; date: Date }
  /** The whole budget has been spent already: nothing left to come out. */
  | { state: "nothing_left" }
  /** Paused or completed. */
  | { state: "not_active" };

function dayOf(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** `today` is the America/New_York calendar day as UTC midnight (lib/upcoming-ledger.ts `todayForNewYork`). */
export function classifyProject(p: ProjectForecastInput, today: Date): ProjectForecastState {
  if (p.status !== "active") return { state: "not_active" };
  if (!p.accountId) return { state: "no_account" };
  if (!p.targetDate) return { state: "ongoing" };
  const remaining = p.budget.minus(p.spent);
  if (!remaining.greaterThan(0)) return { state: "nothing_left" };
  const date = dayOf(p.targetDate);
  if (date.getTime() < dayOf(today).getTime()) return { state: "target_passed", date };
  return { state: "counted", amount: remaining, date, accountId: p.accountId };
}

/** The counted projects as signed (negative) forecast events for one account inside [from, to). */
export function projectEventsForAccount(
  projects: readonly ProjectForecastInput[],
  accountId: string,
  from: Date,
  to: Date,
  today: Date
): ScheduleEvent[] {
  const events: ScheduleEvent[] = [];
  for (const p of projects) {
    const c = classifyProject(p, today);
    if (c.state !== "counted" || c.accountId !== accountId) continue;
    if (c.date.getTime() < from.getTime() || c.date.getTime() >= to.getTime()) continue;
    events.push({
      date: c.date,
      amount: c.amount.negated(),
      description: `Project: ${p.name} (planned)`,
      accountId,
      type: "bill",
    });
  }
  return events.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Plain one-line status for the Projects pages ("In the forecast: ...", "Ongoing: ..."). */
export function describeProjectForecast(state: ProjectForecastState, accountName: string | null): { text: string; counted: boolean } {
  const money = (d: Decimal) => `$${d.toDecimalPlaces(0).toNumber().toLocaleString("en-US")}`;
  const day = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  switch (state.state) {
    case "counted":
      return {
        counted: true,
        text: `In the forecast: ${money(state.amount)} still to spend, leaving ${accountName ?? "its account"} on ${day(state.date)}.`,
      };
    case "ongoing":
      return { counted: false, text: "Ongoing project (no target date), so it is not counted as a one-time expense in the forecast." };
    case "no_account":
      return { counted: false, text: "Not in the forecast: choose the account this project is paid from." };
    case "target_passed":
      return { counted: false, text: `Not in the forecast: the target date (${day(state.date)}) has passed. Update the date to include it.` };
    case "nothing_left":
      return { counted: false, text: "Not in the forecast: the whole budget is already spent." };
    case "not_active":
      return { counted: false, text: "Not in the forecast while the project is not active." };
  }
}
