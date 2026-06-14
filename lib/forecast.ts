import { Decimal } from "@prisma/client/runtime/library";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScheduleEventType =
  | "transfer_out"
  | "transfer_in"
  | "bill"
  | "income";

export interface ScheduleEvent {
  date: Date;
  amount: Decimal; // positive = inflow, negative = outflow
  description: string;
  accountId: string;
  type: ScheduleEventType;
}

export interface DayForecast {
  date: Date;
  balanceAfter: Decimal;
  events: ScheduleEvent[];
  isBreachDay: boolean;
}

// Transfer/bill cadence types (mirrors ScheduledTransfer.cadence)
export type Cadence = "weekly" | "semi_monthly" | "monthly" | "biweekly";

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Start of day UTC. */
function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Returns the next date on or after `from` with the given UTC day-of-week (0=Sun). */
function nextWeekday(from: Date, dayOfWeek: number): Date {
  const d = startOfDayUTC(from);
  const delta = (dayOfWeek - d.getUTCDay() + 7) % 7;
  return new Date(d.getTime() + delta * 86400000);
}

/** Returns all dates in [from, to) that fall on the given day-of-week. */
function allWeekdays(from: Date, to: Date, dayOfWeek: number): Date[] {
  const result: Date[] = [];
  let cur = nextWeekday(from, dayOfWeek);
  while (cur < to) {
    result.push(cur);
    cur = new Date(cur.getTime() + 7 * 86400000);
  }
  return result;
}

/** Returns all dates in [from, to) matching one of daysOfMonth (1-based). */
function allMonthDays(from: Date, to: Date, daysOfMonth: number[]): Date[] {
  const result: Date[] = [];
  const start = startOfDayUTC(from);
  // Walk month by month
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  // Ensure we start at the right month even if from is mid-month
  const endYear = to.getUTCFullYear();
  const endMonth = to.getUTCMonth();

  while (year < endYear || (year === endYear && month <= endMonth)) {
    for (const day of daysOfMonth) {
      const d = new Date(Date.UTC(year, month, day));
      if (d >= from && d < to) result.push(d);
    }
    month++;
    if (month > 11) { month = 0; year++; }
  }
  return result.sort((a, b) => a.getTime() - b.getTime());
}

/** Returns all biweekly dates in [from, to) given an anchor date and interval. */
function allBiweekly(
  from: Date,
  to: Date,
  anchorDate: Date,
  intervalDays: number
): Date[] {
  const result: Date[] = [];
  const anchor = startOfDayUTC(anchorDate);
  const intervalMs = intervalDays * 86400000;
  // Find the first occurrence on or after `from`
  const fromMs = startOfDayUTC(from).getTime();
  const anchorMs = anchor.getTime();
  const diff = fromMs - anchorMs;
  const periods = Math.ceil(diff / intervalMs);
  let cur = new Date(anchorMs + periods * intervalMs);
  while (cur < to) {
    if (cur >= from) result.push(cur);
    cur = new Date(cur.getTime() + intervalMs);
  }
  return result;
}

// ── Occurrence generators ─────────────────────────────────────────────────────

interface TransferLike {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  amount: Decimal | string | number;
  cadence: string;
  dayRules: unknown; // Json
  purpose?: string | null;
  active: boolean;
}

/**
 * Expands a ScheduledTransfer into individual ScheduleEvents within [from, to).
 * Returns two events per occurrence: transfer_out (fromAccount) and transfer_in (toAccount).
 */
export function generateTransferOccurrences(
  transfer: TransferLike,
  from: Date,
  to: Date
): ScheduleEvent[] {
  if (!transfer.active) return [];

  const amount = new Decimal(String(transfer.amount));
  const rules = transfer.dayRules as Record<string, unknown>;
  const label = transfer.purpose ?? "Transfer";

  let dates: Date[] = [];

  if (transfer.cadence === "weekly") {
    const dow = typeof rules["dayOfWeek"] === "number" ? rules["dayOfWeek"] : 1;
    dates = allWeekdays(from, to, dow);
  } else if (transfer.cadence === "semi_monthly") {
    const days = Array.isArray(rules["daysOfMonth"])
      ? (rules["daysOfMonth"] as number[])
      : [1, 15];
    dates = allMonthDays(from, to, days);
  } else if (transfer.cadence === "monthly") {
    const day = typeof rules["dayOfMonth"] === "number" ? rules["dayOfMonth"] : 1;
    dates = allMonthDays(from, to, [day]);
  }

  const events: ScheduleEvent[] = [];
  for (const date of dates) {
    events.push({
      date,
      amount: amount.negated(),
      description: label,
      accountId: transfer.fromAccountId,
      type: "transfer_out",
    });
    events.push({
      date,
      amount,
      description: label,
      accountId: transfer.toAccountId,
      type: "transfer_in",
    });
  }
  return events;
}

interface IncomeSourceLike {
  id: string;
  accountId: string;
  description: string;
  cadence: string;
  dayRules: unknown; // Json
  amount: Decimal | string | number;
  active: boolean;
}

/**
 * Expands an IncomeSource into ScheduleEvents within [from, to).
 */
export function generateIncomeOccurrences(
  source: IncomeSourceLike,
  from: Date,
  to: Date
): ScheduleEvent[] {
  if (!source.active) return [];

  const amount = new Decimal(String(source.amount));
  const rules = source.dayRules as Record<string, unknown>;

  let dates: Date[] = [];

  if (source.cadence === "semi_monthly") {
    const days = Array.isArray(rules["daysOfMonth"])
      ? (rules["daysOfMonth"] as number[])
      : [15, 30];
    dates = allMonthDays(from, to, days);
  } else if (source.cadence === "biweekly") {
    const intervalDays =
      typeof rules["intervalDays"] === "number" ? rules["intervalDays"] : 14;
    const anchor =
      typeof rules["anchorDate"] === "string"
        ? new Date(rules["anchorDate"])
        : from;
    dates = allBiweekly(from, to, anchor, intervalDays);
  } else if (source.cadence === "weekly") {
    const dow = typeof rules["dayOfWeek"] === "number" ? rules["dayOfWeek"] : 1;
    dates = allWeekdays(from, to, dow);
  } else if (source.cadence === "monthly") {
    const day = typeof rules["dayOfMonth"] === "number" ? rules["dayOfMonth"] : 1;
    dates = allMonthDays(from, to, [day]);
  }

  return dates.map((date) => ({
    date,
    amount,
    description: source.description,
    accountId: source.accountId,
    type: "income" as const,
  }));
}

// ── Account forecast ──────────────────────────────────────────────────────────

/**
 * Projects daily balance for one account over a date range.
 *
 * @param startingBalance  Known balance as of `from` (or null = unknown)
 * @param events           All ScheduleEvents for THIS account in [from, to)
 * @param minimumBalance   $250 for TD accounts; null for JCSB (no minimum rule)
 * @param from             Inclusive start date
 * @param to               Exclusive end date
 */
export function buildAccountForecast(
  startingBalance: Decimal,
  events: ScheduleEvent[],
  minimumBalance: Decimal | null,
  from: Date,
  to: Date
): DayForecast[] {
  // Group events by YYYY-MM-DD key
  const byDay = new Map<string, ScheduleEvent[]>();
  for (const ev of events) {
    const key = ev.date.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(ev);
  }

  const result: DayForecast[] = [];
  let balance = startingBalance;
  let cur = startOfDayUTC(from);

  while (cur < to) {
    const key = cur.toISOString().slice(0, 10);
    const dayEvents = byDay.get(key) ?? [];
    for (const ev of dayEvents) {
      balance = balance.plus(ev.amount);
    }
    const isBreachDay =
      minimumBalance !== null && balance.lessThan(minimumBalance);
    result.push({
      date: new Date(cur),
      balanceAfter: balance,
      events: dayEvents,
      isBreachDay,
    });
    cur = new Date(cur.getTime() + 86400000);
  }

  return result;
}

/**
 * Find all forecast days where the balance is projected sub-minimum.
 * Convenience wrapper around buildAccountForecast for warning generation.
 */
export function findBreachDays(forecast: DayForecast[]): DayForecast[] {
  return forecast.filter((d) => d.isBreachDay);
}
