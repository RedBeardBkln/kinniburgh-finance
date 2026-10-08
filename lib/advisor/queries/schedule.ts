// Recurring expense / scheduled bill / scheduled transfer / income source reads for the assistant. DB-aware, explicit select only.
// Notes, ids, tag ids and account ids are never selected; `dayRules` (JSON) is selected because the shaper summarizes it into text.

import { db } from "@/lib/db";

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
  amount: Dec;
  active: boolean;
  entity: { name: string };
  account: { nickname: string };
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
    want("income")
      ? db.incomeSource.findMany({
          where: entityWhere,
          orderBy: [{ description: "asc" }, { id: "asc" }],
          take,
          select: { description: true, cadence: true, dayRules: true, amount: true, active: true, entity: { select: { name: true } }, account: { select: { nickname: true } } },
        })
      : Promise.resolve([]),
  ]);
  return { recurringExpenses, bills, transfers, income };
}
