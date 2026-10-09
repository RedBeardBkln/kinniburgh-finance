// DB-aware, READ-ONLY: one account's other scheduled movements (transfers in and out, paychecks, budget bills) in a
// window, as signed flows for lib/cc-funding.ts `analyzeCardFunding`. Without them the funding analysis ignores
// money moving INTO the account and over-reports shortfalls. It uses the same generators and the same bill filter
// as the Forecast page's per-account projection, so the funding card and the chart agree. No writes, no auth: the
// CALLER (a page that has already run auth(), or a notification job) is responsible for access control.
// Card statement payments are deliberately NOT included (they are the thing being analysed).

import { db } from "@/lib/db";
import {
  generateBillOccurrences,
  generateIncomeOccurrences,
  generateTransferOccurrences,
  type ScheduleEvent,
} from "@/lib/forecast";
import type { ScheduledFlow } from "@/lib/cc-funding";

/**
 * Signed flows (positive = into the account) for `accountId` in [from, to), or null when they could not be read
 * (FAIL-SOFT: never rejects; logs err.name only). A caller must treat null as "inflows unknown", not as "none".
 */
export async function loadScheduledFlows(accountId: string, from: Date, to: Date): Promise<ScheduledFlow[] | null> {
  try {
    return await readScheduledFlows(accountId, from, to);
  } catch (err) {
    console.error("Scheduled flows unavailable", err instanceof Error ? err.name : "UnknownError");
    return null;
  }
}

async function readScheduledFlows(accountId: string, from: Date, to: Date): Promise<ScheduledFlow[]> {
  const [transfers, incomeSources, bills] = await Promise.all([
    db.scheduledTransfer.findMany({
      where: { active: true, OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] },
      select: {
        id: true,
        fromAccountId: true,
        toAccountId: true,
        amount: true,
        cadence: true,
        dayRules: true,
        purpose: true,
        active: true,
      },
    }),
    db.incomeSource.findMany({
      where: { active: true, accountId },
      select: { id: true, accountId: true, description: true, cadence: true, dayRules: true, amount: true, active: true },
    }),
    db.scheduledBill.findMany({
      where: { active: true, accountId, budgetTagId: { not: null } },
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
  ]);

  const events: ScheduleEvent[] = [
    ...transfers.flatMap((t) => generateTransferOccurrences(t, from, to)),
    ...incomeSources.flatMap((s) => generateIncomeOccurrences(s, from, to)),
    ...bills.flatMap((b) => generateBillOccurrences(b, from, to, b.accrualEnvelope?.draws ?? [])),
  ].filter((e) => e.accountId === accountId);
  return events.map((e) => ({ date: e.date, amount: e.amount }));
}
