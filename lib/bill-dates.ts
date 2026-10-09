// Budget-dated bill occurrences. Pure: no database, no clock.
//
// Owner rule: a bill's date is the BUDGET's date, because that is when the money has to be in the account and
// when the transaction is initiated, even though the bank may clear it a few days later. The bank's clearing lag is
// explanatory text only and never moves an item (see lib/recurring-detect.ts `clearingLagFor`).
//
// A ScheduledBill linked to a Budget line (budgetTagId + budgetEntityId) carries one schedule, overwritten by
// whichever period saved last, while Budget rows are per month. For every calendar month in a window this module
// takes the schedule from THAT month's Budget row when it has a usable one, otherwise from the bill's own record
// (the previous behaviour). Only the DATE fields come from the Budget row: amount precedence is unchanged (the
// bill's expectedAmount / annualBudget / amountType, account and payee are always the bill's), and a Budget row
// whose frequency differs from the bill's is not used (the amount per occurrence depends on the frequency, so
// mixing them would silently change the amount).
//
// lib/forecast.ts is not edited: this wraps `generateBillOccurrences` month by month.

import { Decimal } from "@prisma/client/runtime/library";
import { generateBillOccurrences, type AccrualDrawLike, type ScheduleEvent } from "@/lib/forecast";
import { isLumpSumFrequency } from "@/lib/annual-bill";

export interface BudgetScheduleRow {
  entityId: string;
  tagId: string;
  /** YYYY-MM */
  period: string;
  payDay: number | null;
  frequency: string;
  payDayOfWeek: number | null;
  biweeklyAnchorDate: Date | string | null;
  payMonth: number | null;
  annualAmountDue: Decimal | string | number | null;
}

/** `${entityId}|${tagId}` -> (YYYY-MM -> Budget schedule row). */
export type BudgetScheduleIndex = Map<string, Map<string, BudgetScheduleRow>>;

/** The bill fields this module reads (a structural subset of ScheduledBill). */
export interface BillDateBill {
  id: string;
  accountId: string;
  payee: string;
  amountType: string;
  expectedAmount: Decimal | string | number | null;
  autopayDay: number | null;
  annualBudget: Decimal | string | number | null;
  frequency?: string;
  payDayOfWeek?: number | null;
  biweeklyAnchorDate?: Date | string | null;
  payMonth?: number | null;
  entityId?: string;
  budgetTagId?: string | null;
  budgetEntityId?: string | null;
}

/** The bill fields the schedule decision reads (so a caller with a narrow select can use it). */
export type BillScheduleInput = Pick<
  BillDateBill,
  "amountType" | "autopayDay" | "annualBudget" | "frequency" | "payDayOfWeek" | "biweeklyAnchorDate" | "payMonth" | "entityId" | "budgetTagId" | "budgetEntityId"
>;

export interface EffectiveSchedule {
  fields: {
    frequency: string;
    autopayDay: number | null;
    payDayOfWeek: number | null;
    biweeklyAnchorDate: Date | string | null;
    payMonth: number | null;
  };
  basis: "budget" | "bill";
  /** The Budget row's pay day when that row's schedule is the one used. */
  budgetDay: number | null;
  /** The bill record's own day. */
  recordDay: number | null;
}

export function periodKey(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, "0")}`;
}

/** Every YYYY-MM overlapping [from, to). */
export function periodsBetween(from: Date, to: Date): string[] {
  if (!(from < to)) return [];
  const out: string[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const last = new Date(to.getTime() - 1);
  const ey = last.getUTCFullYear();
  const em = last.getUTCMonth();
  while (y < ey || (y === ey && m <= em)) {
    out.push(periodKey(y, m));
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

/** The index key of a bill's Budget line, or null when the bill is not linked to one. */
export function budgetKeyOfBill(b: Pick<BillDateBill, "budgetTagId" | "budgetEntityId" | "entityId">): string | null {
  if (!b.budgetTagId) return null;
  const entity = b.budgetEntityId ?? b.entityId;
  if (!entity) return null;
  return `${entity}|${b.budgetTagId}`;
}

export function budgetIndexKey(entityId: string, tagId: string): string {
  return `${entityId}|${tagId}`;
}

export function buildBudgetScheduleIndex(rows: BudgetScheduleRow[]): BudgetScheduleIndex {
  const index: BudgetScheduleIndex = new Map();
  for (const r of rows) {
    const key = budgetIndexKey(r.entityId, r.tagId);
    let inner = index.get(key);
    if (!inner) {
      inner = new Map();
      index.set(key, inner);
    }
    inner.set(r.period, r);
  }
  return index;
}

function validDay(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 31;
}

function validDate(d: Date | string | null | undefined): boolean {
  if (d == null) return false;
  return !Number.isNaN(new Date(d).getTime());
}

/**
 * True when the Budget row carries a complete schedule that can stand in for the bill's own: same frequency as the
 * bill, and every field that frequency needs. A row with no pay day (the "no schedule" row of a month the owner
 * never dated) or a different frequency is NOT usable, so the bill's own schedule applies.
 */
export function budgetRowUsable(row: BudgetScheduleRow, bill: BillScheduleInput): boolean {
  if (bill.amountType === "accrued") return validDay(row.payDay);
  const billFreq = bill.frequency ?? "monthly";
  if (row.frequency !== billFreq) return false;
  if (isLumpSumFrequency(billFreq)) {
    if (bill.annualBudget == null) return false;
    return validDay(row.payDay) && row.payMonth != null && row.payMonth >= 1 && row.payMonth <= 12;
  }
  if (billFreq === "weekly") return row.payDayOfWeek != null && row.payDayOfWeek >= 0 && row.payDayOfWeek <= 6;
  if (billFreq === "biweekly") return validDate(row.biweeklyAnchorDate);
  return validDay(row.payDay);
}

/** The schedule to use for a bill in one period (YYYY-MM): the Budget row's when usable, else the bill's own. */
export function effectiveSchedule(bill: BillScheduleInput, index: BudgetScheduleIndex, period: string): EffectiveSchedule {
  const own: EffectiveSchedule["fields"] = {
    frequency: bill.frequency ?? "monthly",
    autopayDay: bill.autopayDay,
    payDayOfWeek: bill.payDayOfWeek ?? null,
    biweeklyAnchorDate: bill.biweeklyAnchorDate ?? null,
    payMonth: bill.payMonth ?? null,
  };
  const key = budgetKeyOfBill(bill);
  const row = key ? index.get(key)?.get(period) : undefined;
  if (!row || !budgetRowUsable(row, bill)) {
    return { fields: own, basis: "bill", budgetDay: null, recordDay: bill.autopayDay };
  }
  if (bill.amountType === "accrued") {
    // Accrued bills ignore frequency: only the day of month matters.
    return { fields: { ...own, autopayDay: row.payDay }, basis: "budget", budgetDay: row.payDay, recordDay: bill.autopayDay };
  }
  return {
    fields: {
      frequency: own.frequency,
      autopayDay: row.payDay,
      payDayOfWeek: row.payDayOfWeek,
      biweeklyAnchorDate: row.biweeklyAnchorDate,
      payMonth: row.payMonth,
    },
    basis: "budget",
    budgetDay: row.payDay,
    recordDay: bill.autopayDay,
  };
}

/**
 * False when the schedule has no day to put the bill on, i.e. the generator would FABRICATE one (a monthly or accrued
 * bill with no pay day defaults to day 1). Reminders and the ledger use this so an undated bill is never given a
 * made-up date. Weekly / biweekly keep the generator's own defaults (unchanged behaviour).
 */
export function hasResolvableDay(eff: EffectiveSchedule, bill: Pick<BillDateBill, "amountType">): boolean {
  if (bill.amountType === "accrued") return eff.fields.autopayDay != null;
  const f = eff.fields.frequency;
  if (f === "weekly" || f === "biweekly") return true;
  if (isLumpSumFrequency(f)) return eff.fields.autopayDay != null && eff.fields.payMonth != null;
  return eff.fields.autopayDay != null;
}

/**
 * Outflow events for a bill in [from, to), dated month by month from the Budget row where one is usable. With an
 * empty index, an untagged bill, or an accrued bill with real draw dates, the result is exactly
 * `generateBillOccurrences(bill, from, to, draws)`.
 */
export function generateBillOccurrencesBudgetDated(
  bill: BillDateBill,
  index: BudgetScheduleIndex,
  from: Date,
  to: Date,
  draws: AccrualDrawLike[] = []
): ScheduleEvent[] {
  const key = budgetKeyOfBill(bill);
  if ((bill.amountType === "accrued" && draws.length > 0) || !key || index.size === 0 || !index.has(key)) {
    return generateBillOccurrences(bill, from, to, draws);
  }
  if (!(from < to)) return [];

  const events: ScheduleEvent[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const last = new Date(to.getTime() - 1);
  const ey = last.getUTCFullYear();
  const em = last.getUTCMonth();
  while (y < ey || (y === ey && m <= em)) {
    const monthStart = new Date(Date.UTC(y, m, 1));
    const nextMonthStart = new Date(Date.UTC(y, m + 1, 1));
    const winStart = from > monthStart ? from : monthStart;
    const winEnd = to < nextMonthStart ? to : nextMonthStart;
    if (winStart < winEnd) {
      const eff = effectiveSchedule(bill, index, periodKey(y, m));
      const clone: BillDateBill = eff.basis === "budget" ? { ...bill, ...eff.fields } : bill;
      events.push(...generateBillOccurrences(clone, winStart, winEnd, []));
    }
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return events.sort((a, b) => a.date.getTime() - b.date.getTime());
}
