// DB-aware, READ-ONLY reads that assemble the upcoming ledger's input (bills, budgets, recurring expenses, envelopes,
// cards, transfers, paychecks, rentals, projected revenue, tax deadlines, policies). No writes, no auth: the CALLER
// (a page, or a server action that has already run requireAuth()) is responsible for access control. All Prisma
// reads use explicit selects. Shared by lib/upcoming-ledger-build.ts (the pages) and actions/recurring-suggestions.ts
// (which needs only the recorded items, not the built ledger).

import { db } from "@/lib/db";
import { CARD_PAST_DUE_LOOKBACK_DAYS, todayForNewYork, type UpcomingLedgerInput } from "@/lib/upcoming-ledger";

const DAY_MS = 86_400_000;

export interface LoadedLedgerInput {
  input: UpcomingLedgerInput;
  /** UTC midnight of the America/New_York date. */
  from: Date;
  to: Date;
  entityNameById: Record<string, string>;
  entitySlugById: Record<string, string | null>;
  accountNameById: Record<string, string>;
}

/** Every YYYY-MM the window [from, to) touches. */
function periodsTouched(from: Date, to: Date): string[] {
  const periods: string[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  while (Date.UTC(y, m, 1) < to.getTime()) {
    periods.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return periods;
}

export async function loadUpcomingLedgerInput(args: {
  /** null = every entity (the Taxes / Projects aggregate views). */
  entityId: string | null;
  days: number;
  now: Date;
}): Promise<LoadedLedgerInput> {
  const { entityId, days, now } = args;
  const from = todayForNewYork(now);
  const to = new Date(from.getTime() + days * DAY_MS);
  const lookbackStart = new Date(from.getTime() - CARD_PAST_DUE_LOOKBACK_DAYS * DAY_MS);
  const entityWhere = entityId ? { entityId } : {};

  const [
    bills,
    budgets,
    recurring,
    envelopes,
    cards,
    transfers,
    incomeSources,
    rentalBookings,
    projectedRevenue,
    taxDeadlines,
    policies,
    entities,
    accounts,
  ] = await Promise.all([
    db.scheduledBill.findMany({
      where: { active: true, ...entityWhere },
      select: {
        id: true,
        accountId: true,
        entityId: true,
        payee: true,
        amountType: true,
        expectedAmount: true,
        autopayDay: true,
        annualBudget: true,
        frequency: true,
        payDayOfWeek: true,
        biweeklyAnchorDate: true,
        payMonth: true,
        active: true,
        budgetTagId: true,
        budgetEntityId: true,
        accrualEnvelope: { select: { draws: { select: { estimatedDate: true, estimatedAmount: true } } } },
      },
    }),
    db.budget.findMany({
      where: { period: { in: periodsTouched(from, to) }, ...entityWhere },
      select: {
        id: true,
        tagId: true,
        entityId: true,
        accountId: true,
        period: true,
        budgeted: true,
        payDay: true,
        frequency: true,
        payDayOfWeek: true,
        biweeklyAnchorDate: true,
        payMonth: true,
        annualAmountDue: true,
        tag: { select: { shortName: true } },
      },
    }),
    db.recurringExpense.findMany({
      where: entityWhere,
      select: {
        id: true,
        entityId: true,
        name: true,
        amountCents: true,
        frequency: true,
        dueDay: true,
        nextDueDate: true,
        tagId: true,
        // Read only for the "[pattern:...]" marker (lib/recurring-series-marker.ts); never displayed from here.
        notes: true,
      },
    }),
    db.accrualEnvelope.findMany({
      where: { scheduledBillId: null, ...(entityId ? { account: { entityId } } : {}) },
      select: {
        id: true,
        name: true,
        accountId: true,
        account: { select: { entityId: true } },
        draws: { select: { estimatedDate: true, estimatedAmount: true } },
      },
    }),
    db.account.findMany({
      where: {
        accountType: "credit_card",
        archivedAt: null,
        ccDueDate: { gte: lookbackStart, lt: to },
        ...entityWhere,
      },
      select: { id: true, nickname: true, entityId: true, ccDueDate: true, ccStatementBalance: true },
    }),
    db.scheduledTransfer.findMany({
      where: { active: true, ...(entityId ? { fromAccount: { entityId } } : {}) },
      select: {
        id: true,
        fromAccountId: true,
        toAccountId: true,
        amount: true,
        cadence: true,
        dayRules: true,
        purpose: true,
        active: true,
        fromAccount: { select: { entityId: true } },
        toAccount: { select: { nickname: true } },
      },
    }),
    db.incomeSource.findMany({
      where: { active: true, ...entityWhere },
      select: {
        id: true,
        accountId: true,
        entityId: true,
        description: true,
        cadence: true,
        dayRules: true,
        amount: true,
        active: true,
      },
    }),
    db.rentalBooking.findMany({
      where: { payoutDate: { gte: from, lt: to }, ...entityWhere },
      select: { id: true, entityId: true, payoutDate: true, guest: true, grossEarnings: true },
    }),
    db.projectedRevenue.findMany({
      where: { archivedAt: null, realizedAt: null, ...entityWhere },
      select: {
        id: true,
        entityId: true,
        accountId: true,
        description: true,
        expectedDate: true,
        amountCents: true,
        realizedAt: true,
        archivedAt: true,
      },
    }),
    db.taxDeadline.findMany({
      // dueDate is stored at ET midnight (04:00Z / 05:00Z), so widen by a day; the builder normalizes to the UTC date.
      where: { archivedAt: null, status: "upcoming", dueDate: { gte: from, lt: new Date(to.getTime() + DAY_MS) }, ...entityWhere },
      select: { id: true, entityId: true, label: true, dueDate: true, status: true, archivedAt: true },
    }),
    db.insurancePolicy.findMany({
      where: { archivedAt: null, expiryDate: { gte: from, lt: new Date(to.getTime() + DAY_MS) }, ...entityWhere },
      select: { id: true, entityId: true, insurer: true, policyType: true, expiryDate: true, archivedAt: true },
    }),
    db.entity.findMany({ where: { archivedAt: null }, select: { id: true, name: true, slug: true, navLabel: true } }),
    db.account.findMany({ where: { archivedAt: null, ...entityWhere }, select: { id: true, nickname: true } }),
  ]);

  const input: UpcomingLedgerInput = {
    from,
    days,
    entityId,
    bills: bills.map((b) => ({
      id: b.id,
      accountId: b.accountId,
      entityId: b.entityId,
      payee: b.payee,
      amountType: b.amountType,
      expectedAmount: b.expectedAmount,
      autopayDay: b.autopayDay,
      annualBudget: b.annualBudget,
      frequency: b.frequency,
      payDayOfWeek: b.payDayOfWeek,
      biweeklyAnchorDate: b.biweeklyAnchorDate,
      payMonth: b.payMonth,
      active: b.active,
      budgetTagId: b.budgetTagId,
      budgetEntityId: b.budgetEntityId,
      draws: b.accrualEnvelope?.draws ?? [],
    })),
    budgets: budgets.map((b) => ({
      id: b.id,
      tagId: b.tagId,
      tagName: b.tag.shortName,
      entityId: b.entityId,
      accountId: b.accountId,
      period: b.period,
      budgeted: b.budgeted,
      payDay: b.payDay,
      frequency: b.frequency,
      payDayOfWeek: b.payDayOfWeek,
      biweeklyAnchorDate: b.biweeklyAnchorDate,
      payMonth: b.payMonth,
      annualAmountDue: b.annualAmountDue,
    })),
    recurring,
    orphanEnvelopes: envelopes.map((e) => ({
      id: e.id,
      name: e.name,
      accountId: e.accountId,
      entityId: e.account.entityId,
      draws: e.draws,
    })),
    cards: cards.flatMap((c) =>
      c.ccDueDate
        ? [
            {
              id: c.id,
              nickname: c.nickname,
              entityId: c.entityId,
              ccDueDate: c.ccDueDate,
              ccStatementBalance: c.ccStatementBalance,
            },
          ]
        : []
    ),
    transfers: transfers.map((t) => ({
      id: t.id,
      fromAccountId: t.fromAccountId,
      toAccountId: t.toAccountId,
      fromEntityId: t.fromAccount.entityId,
      amount: t.amount,
      cadence: t.cadence,
      dayRules: t.dayRules,
      purpose: t.purpose,
      toNickname: t.toAccount.nickname,
      active: t.active,
    })),
    incomeSources,
    rentalBookings,
    projectedRevenue,
    taxDeadlines,
    policies,
  };

  return {
    input,
    from,
    to,
    entityNameById: Object.fromEntries(entities.map((e) => [e.id, e.navLabel ?? e.name])),
    entitySlugById: Object.fromEntries(entities.map((e) => [e.id, e.slug])),
    accountNameById: Object.fromEntries(accounts.map((a) => [a.id, a.nickname])),
  };
}
