// Forecast inputs for the assistant: the Personal balance projection's rows, loaded read-only with explicit selects. This MIRRORS the Personal
// engine of app/forecast/page.tsx (checking accounts with a minimum balance, active transfers / income sources / budget-linked bills with
// their accrual draws, and credit cards with a statement due date). The page loads inline and has no exported loader, so a drift between the
// two is possible; the pure builder lives in tools/get-forecast.ts and uses the same lib/forecast.ts generators as the page.
// The business-bucket forecast (revenue-based) is NOT covered.

import type { Decimal } from "@prisma/client/runtime/library";
import { db } from "@/lib/db";

export interface ForecastAccountRow {
  id: string;
  nickname: string;
  mask: string | null;
  currentBalance: Decimal | null;
  currentBalanceAt: Date | null;
  minimumBalance: Decimal | null;
}

export interface ForecastTransferRow {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  amount: Decimal;
  cadence: string;
  dayRules: unknown;
  purpose: string | null;
  active: boolean;
}

export interface ForecastIncomeRow {
  id: string;
  accountId: string;
  description: string;
  cadence: string;
  dayRules: unknown;
  amount: Decimal;
  active: boolean;
}

export interface ForecastBillRow {
  id: string;
  accountId: string;
  payee: string;
  amountType: string;
  expectedAmount: Decimal | null;
  autopayDay: number | null;
  annualBudget: Decimal | null;
  frequency: string;
  payDayOfWeek: number | null;
  biweeklyAnchorDate: Date | null;
  payMonth: number | null;
  accrualEnvelope: { draws: { estimatedDate: Date; estimatedAmount: Decimal }[] } | null;
}

export interface ForecastCardRow {
  id: string;
  nickname: string;
  ccDueDate: Date | null;
  ccStatementBalance: Decimal | null;
}

export interface ForecastInputs {
  accounts: ForecastAccountRow[];
  transfers: ForecastTransferRow[];
  incomes: ForecastIncomeRow[];
  bills: ForecastBillRow[];
  cards: ForecastCardRow[];
}

export async function loadForecastInputs(): Promise<ForecastInputs> {
  const [accounts, transfers, incomes, bills, cards] = await Promise.all([
    db.account.findMany({
      where: { archivedAt: null, accountType: "checking", minimumBalance: { not: null }, entity: { type: "personal" } },
      orderBy: { nickname: "asc" },
      take: 10,
      select: { id: true, nickname: true, mask: true, currentBalance: true, currentBalanceAt: true, minimumBalance: true },
    }),
    db.scheduledTransfer.findMany({
      where: { active: true },
      take: 200,
      select: { id: true, fromAccountId: true, toAccountId: true, amount: true, cadence: true, dayRules: true, purpose: true, active: true },
    }),
    db.incomeSource.findMany({
      where: { active: true },
      take: 200,
      select: { id: true, accountId: true, description: true, cadence: true, dayRules: true, amount: true, active: true },
    }),
    db.scheduledBill.findMany({
      where: { active: true, budgetTagId: { not: null } },
      take: 200,
      select: {
        id: true,
        accountId: true,
        payee: true,
        amountType: true,
        expectedAmount: true,
        autopayDay: true,
        annualBudget: true,
        frequency: true,
        payDayOfWeek: true,
        biweeklyAnchorDate: true,
        payMonth: true,
        accrualEnvelope: { select: { draws: { select: { estimatedDate: true, estimatedAmount: true } } } },
      },
    }),
    db.account.findMany({
      where: { accountType: "credit_card", archivedAt: null, ccDueDate: { not: null }, entity: { type: "personal" } },
      take: 30,
      select: { id: true, nickname: true, ccDueDate: true, ccStatementBalance: true },
    }),
  ]);
  return { accounts, transfers, incomes, bills, cards };
}
