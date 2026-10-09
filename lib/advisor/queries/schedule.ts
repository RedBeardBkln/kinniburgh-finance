// Recurring expense / scheduled bill / scheduled transfer / income source reads for the assistant. DB-aware, explicit select only.
// Notes, ids, tag ids and account ids are never selected; `dayRules` (JSON) is selected because the shaper summarizes it into text.

import { db } from "@/lib/db";
import { loadNetIncomeSources } from "@/lib/net-income-build";
import type { NetBasis } from "@/lib/net-income";
import { effectiveSchedule } from "@/lib/bill-dates";
import { loadBudgetScheduleIndex } from "@/lib/bill-dates-build";

type Dec = { toString(): string };

export interface RecurringExpenseRow {
  name: string;
  amountCents: number;
  frequency: string;
  dueDay: number | null;
  nextDueDate: Date | null;
  entity: { name: string };
  tag: { shortName: string } | null;
}

export interface ScheduledBillRow {
  payee: string;
  amountType: string;
  expectedAmount: Dec | null;
  annualBudget: Dec | null;
  autopayDay: number | null;
  frequency: string;
  payDayOfWeek: number | null;
  payMonth: number | null;
  active: boolean;
  entity: { name: string };
  account: { nickname: string };
  /** The bill's day in the current month when its Budget row dates it differently from the bill record (else absent). */
  budgetDay?: number | null;
}

export interface ScheduledTransferRow {
  amount: Dec;
  cadence: string;
  dayRules: unknown;
  purpose: string | null;
  active: boolean;
  fromAccount: { nickname: string };
  toAccount: { nickname: string };
}

export interface IncomeSourceRow {
  description: string;
  cadence: string;
  dayRules: unknown;
  /** The stored GROSS amount per paycheck. */
  amount: Dec;
  active: boolean;
  entity: { name: string };
  account: { nickname: string };
  /** Take-home per paycheck (null when unknown: the forecast then uses the gross) and how it was resolved. */
  takeHome?: Dec | null;
  takeHomeBasis?: NetBasis;
  /** Plain-language basis ("take-home $6,064.86, from your last 6 deposits"). */
  takeHomeNote?: string;
}

export interface ScheduleRows {
  recurringExpenses: RecurringExpenseRow[];
  bills: ScheduledBillRow[];
  transfers: ScheduledTransferRow[];
  income: IncomeSourceRow[];
}

export type ScheduleKind = "recurring_expenses" | "bills" | "transfers" | "income" | "all";

export const SCHEDULE_PER_SECTION = 40;

export async function loadSchedule(opts: { entity?: string; kind: ScheduleKind }): Promise<ScheduleRows> {
  const entityMatch = (e: string) => ({ OR: [{ name: { equals: e, mode: "insensitive" as const } }, { slug: { equals: e, mode: "insensitive" as const } }] });
  const entityWhere = opts.entity !== undefined ? { entity: entityMatch(opts.entity) } : {};
  const want = (k: ScheduleKind) => opts.kind === "all" || opts.kind === k;
  const take = SCHEDULE_PER_SECTION + 1; // one extra row tells the shaper a section was cut
  const [recurringExpenses, bills, transfers, income] = await Promise.all([
    want("recurring_expenses")
      ? db.recurringExpense.findMany({
          where: entityWhere,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take,
          select: { name: true, amountCents: true, frequency: true, dueDay: true, nextDueDate: true, entity: { select: { name: true } }, tag: { select: { shortName: true } } },
        })
      : Promise.resolve([]),
    want("bills")
      ? db.scheduledBill.findMany({
          where: entityWhere,
          orderBy: [{ payee: "asc" }, { id: "asc" }],
          take,
          select: {
            payee: true,
            amountType: true,
            expectedAmount: true,
            annualBudget: true,
            autopayDay: true,
            frequency: true,
            payDayOfWeek: true,
            payMonth: true,
            active: true,
            // Only to find the bill's Budget row (to report a different budget day); never returned.
            entityId: true,
            budgetTagId: true,
            budgetEntityId: true,
            entity: { select: { name: true } },
            account: { select: { nickname: true } },
          },
        })
      : Promise.resolve([]),
    want("transfers")
      ? db.scheduledTransfer.findMany({
          where: opts.entity !== undefined ? { OR: [{ fromAccount: { entity: entityMatch(opts.entity) } }, { toAccount: { entity: entityMatch(opts.entity) } }] } : {},
          orderBy: [{ purpose: "asc" }, { id: "asc" }],
          take,
          select: {
            amount: true,
            cadence: true,
            dayRules: true,
            purpose: true,
            active: true,
            fromAccount: { select: { nickname: true } },
            toAccount: { select: { nickname: true } },
          },
        })
      : Promise.resolve([]),
    // Income sources come from the take-home loader (its own explicit selects): the stored amount stays the GROSS.
    want("income")
      ? loadNetIncomeSources({ where: entityWhere, includeInactive: true, withAccount: true, withEntity: true, take })
      : Promise.resolve([]),
  ]);

  // A bill dated by its Budget row: report the budget day only when it differs from the bill record's day.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const budget = bills.length > 0 ? await loadBudgetScheduleIndex({ from: monthStart, to: monthEnd }) : null;
  const period = monthStart.toISOString().slice(0, 7);
  const billRows: ScheduledBillRow[] = bills.map((b) => {
    const row: ScheduledBillRow = {
      payee: b.payee,
      amountType: b.amountType,
      expectedAmount: b.expectedAmount,
      annualBudget: b.annualBudget,
      autopayDay: b.autopayDay,
      frequency: b.frequency,
      payDayOfWeek: b.payDayOfWeek,
      payMonth: b.payMonth,
      active: b.active,
      entity: b.entity,
      account: b.account,
    };
    if (budget) {
      const eff = effectiveSchedule(b, budget.index, period);
      if (eff.basis === "budget" && eff.budgetDay !== null && eff.budgetDay !== b.autopayDay) row.budgetDay = eff.budgetDay;
    }
    return row;
  });

  const incomeRows: IncomeSourceRow[] = income.map((s) => ({
    description: s.description,
    cadence: s.cadence,
    dayRules: s.dayRules,
    amount: s.grossAmount,
    active: s.active,
    entity: s.entity ?? { name: "" },
    account: s.account ?? { nickname: "" },
    takeHome: s.amountBasis === "gross_unknown" ? null : s.amount,
    takeHomeBasis: s.amountBasis,
    takeHomeNote: s.netInfo.label,
  }));
  return { recurringExpenses, bills: billRows, transfers, income: incomeRows };
}
