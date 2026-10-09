// Forecast inputs for the assistant: the Personal balance projection's rows, loaded read-only with explicit selects. This MIRRORS the Personal
// engine of app/forecast/page.tsx (checking accounts with a minimum balance, active transfers / income sources / budget-linked bills with
// their accrual draws). The page loads inline and has no exported loader, so a drift between the two is possible; the pure builder lives in
// tools/get-forecast.ts and uses the same lib/forecast.ts generators as the page. Credit cards come from the SAME read-only loader the page,
// the Upcoming ledger and the notifications use (lib/card-next-statement-build.ts, explicit selects): the paying account of each card is
// inferred from past payments, a paid statement is dropped and the next statements are estimates. No account is assumed by its nickname.
// The business-bucket forecast (revenue-based) is NOT covered.

import type { Decimal } from "@prisma/client/runtime/library";
import { db } from "@/lib/db";
import type { CardProjection } from "@/lib/card-next-statement";
import { loadCardProjections } from "@/lib/card-next-statement-build";
import { loadNetIncomeSources } from "@/lib/net-income-build";
import type { NetBasis } from "@/lib/net-income";
import { loadBudgetScheduleIndex } from "@/lib/bill-dates-build";
import type { BudgetScheduleIndex } from "@/lib/bill-dates";

export interface ForecastAccountRow {
  id: string;
  /** The account's entity, to label a card of ANOTHER entity that this account pays. */
  entityId?: string;
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
  /** The per-paycheck amount to project with: TAKE-HOME when known, else the gross (see amountBasis). */
  amount: Decimal;
  active: boolean;
  /** The stored gross amount. */
  grossAmount?: Decimal;
  /** How `amount` was resolved; "gross_unknown" = gross used because take-home is unknown (a flagged assumption). */
  amountBasis?: NetBasis;
}

export interface ForecastBillRow {
  id: string;
  accountId: string;
  /** With the budget link, lets the bill be dated by its Budget row (lib/bill-dates.ts). */
  entityId?: string;
  budgetTagId?: string | null;
  budgetEntityId?: string | null;
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

export interface ForecastInputs {
  accounts: ForecastAccountRow[];
  transfers: ForecastTransferRow[];
  incomes: ForecastIncomeRow[];
  bills: ForecastBillRow[];
  /** Card statements: inferred paying account, paid check and estimated next statements (all entities' cards). */
  cardProjections: CardProjection[];
  /** True when the card projections could not be read: card payments are then missing and the tool says so. */
  cardProjectionsFailed: boolean;
  /** Entity names by id, for the "(<entity> card)" label. */
  entityNameById: Record<string, string>;
  /** Budget schedule rows for the projection window: a bill is dated by its Budget row. Absent / empty = the bill records' dates. */
  budgetIndex?: BudgetScheduleIndex;
}

export async function loadForecastInputs(now: Date = new Date()): Promise<ForecastInputs> {
  const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 91 * 86_400_000);
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [accounts, transfers, incomeRows, bills, loadedCards, entities, budgetDates] = await Promise.all([
    db.account.findMany({
      where: { archivedAt: null, accountType: "checking", minimumBalance: { not: null }, entity: { type: "personal" } },
      orderBy: { nickname: "asc" },
      take: 10,
      select: { id: true, entityId: true, nickname: true, mask: true, currentBalance: true, currentBalanceAt: true, minimumBalance: true },
    }),
    db.scheduledTransfer.findMany({
      where: { active: true },
      take: 200,
      select: { id: true, fromAccountId: true, toAccountId: true, amount: true, cadence: true, dayRules: true, purpose: true, active: true },
    }),
    // Paychecks are TAKE-HOME (lib/net-income-build.ts: its own explicit selects), never the stored gross amount.
    loadNetIncomeSources({ take: 200, now }),
    db.scheduledBill.findMany({
      where: { active: true, budgetTagId: { not: null } },
      take: 200,
      select: {
        id: true,
        accountId: true,
        entityId: true,
        budgetTagId: true,
        budgetEntityId: true,
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
    loadCardProjections({ now }),
    db.entity.findMany({ where: { archivedAt: null }, take: 20, select: { id: true, name: true } }),
    loadBudgetScheduleIndex({ from: windowStart, to: windowEnd }),
  ]);
  const incomes: ForecastIncomeRow[] = incomeRows.map((s) => ({
    id: s.id,
    accountId: s.accountId,
    description: s.description,
    cadence: s.cadence,
    dayRules: s.dayRules,
    amount: s.amount,
    active: s.active,
    grossAmount: s.grossAmount,
    amountBasis: s.amountBasis,
  }));
  return {
    accounts,
    transfers,
    incomes,
    bills,
    budgetIndex: budgetDates.index,
    cardProjections: loadedCards.projections,
    cardProjectionsFailed: loadedCards.error,
    entityNameById: Object.fromEntries(entities.map((e) => [e.id, e.name])),
  };
}
