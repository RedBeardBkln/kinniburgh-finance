import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { computeBudgetSummary } from "./budget";
import {
  buildAccountForecast,
  findBreachDays,
  generateTransferOccurrences,
  generateIncomeOccurrences,
  type ScheduleEvent,
} from "./forecast";
import { sendPushToUser } from "./web-push";

// ── Helpers ───────────────────────────────────────────────────────────────────

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function formatUSD(d: Decimal): string {
  return `$${d.abs().toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function daysRemaining(period: string): number {
  const now = new Date();
  const [year, month] = period.split("-").map(Number) as [number, number];
  const endOfMonth = new Date(Date.UTC(year, month, 1));
  return Math.max(0, Math.ceil((endOfMonth.getTime() - now.getTime()) / 86400000));
}

async function getAllUserIds(): Promise<string[]> {
  const users = await db.user.findMany({ select: { id: true } });
  return users.map((u) => u.id);
}

async function alreadyNotifiedToday(scopeKey: string): Promise<boolean> {
  const today = startOfDayUTC(new Date());
  const existing = await db.notification.findFirst({
    where: {
      createdAt: { gte: today },
      payload: { path: ["scopeKey"], equals: scopeKey },
    },
  });
  return existing !== null;
}

async function createNotification(opts: {
  type: string;
  entityId?: string;
  payload: Record<string, unknown>;
  userIds: string[];
}): Promise<void> {
  const { type, entityId, payload, userIds } = opts;
  if (userIds.length === 0) return;

  const notification = await db.notification.create({
    data: {
      type,
      entityId: entityId ?? null,
      payload: payload as Prisma.InputJsonValue,
      channel: "in_app",
      users: {
        create: userIds.map((userId) => ({ userId })),
      },
    },
  });

  // Dispatch push in background (fire-and-forget for the cron)
  await Promise.allSettled(userIds.map((uid) => sendPushToUser(uid, {
    title: payload["title"] as string,
    body: payload["body"] as string,
    url: "/notifications",
  })));

  await db.notification.update({
    where: { id: notification.id },
    data: { sentAt: new Date() },
  });
}

// ── Check: Budget overspend ───────────────────────────────────────────────────

export async function checkBudgetOverspend(period: string): Promise<number> {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  const budgets = await db.budget.findMany({
    where: { period },
    include: { tag: true, entity: true },
  });

  const tagSpendRows = await db.$queryRaw<{ tagId: string; total: string }[]>`
    SELECT tt."tagId", SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${monthStart}
      AND t."postedAt" < ${monthEnd}
    GROUP BY tt."tagId"
  `;

  const spendByTagId = new Map(tagSpendRows.map((r) => [r.tagId, new Decimal(r.total)]));
  const userIds = await getAllUserIds();
  let generated = 0;

  for (const budget of budgets) {
    const actualSpend = spendByTagId.get(budget.tagId) ?? new Decimal(0);
    const summary = computeBudgetSummary({
      budgeted: budget.budgeted,
      rolloverAmount: budget.rolloverAmount ?? new Decimal(0),
      actualSpend,
    });

    if (summary.percentUsed < 80) continue;

    const scopeKey = `overspend:${budget.tagId}:${period}`;
    if (await alreadyNotifiedToday(scopeKey)) continue;

    const days = daysRemaining(period);
    const pct = Math.round(summary.percentUsed);
    const title = `Budget alert: ${budget.tag.shortName}`;
    const body = `${budget.tag.shortName} is at ${formatUSD(actualSpend.abs())} of ${formatUSD(summary.effectiveBudget)} (${pct}%)${days > 0 ? ` — ${days} days left this month` : ""}.`;

    await createNotification({
      type: "overspend",
      entityId: budget.entityId,
      payload: { scopeKey, title, body, tagName: budget.tag.shortName, budgeted: summary.effectiveBudget.toFixed(2), actual: actualSpend.abs().toFixed(2), percentUsed: pct },
      userIds,
    });
    generated++;
  }

  return generated;
}

// ── Check: Low balance projection ─────────────────────────────────────────────

export async function checkLowBalance(): Promise<number> {
  const accounts = await db.account.findMany({
    where: {
      archivedAt: null,
      minimumBalance: { not: null },
      currentBalance: { not: null },
      accountType: { in: ["checking", "savings"] },
    },
    include: {
      scheduledTransfersFrom: { where: { active: true } },
      scheduledTransfersTo: { where: { active: true } },
      incomeSources: { where: { active: true } },
    },
  });

  const from = startOfDayUTC(new Date());
  const to = new Date(from.getTime() + 30 * 86400000);
  const userIds = await getAllUserIds();
  let generated = 0;

  for (const account of accounts) {
    const events: ScheduleEvent[] = [];

    for (const t of [...account.scheduledTransfersFrom, ...account.scheduledTransfersTo]) {
      events.push(
        ...generateTransferOccurrences(t, from, to).filter((e) => e.accountId === account.id)
      );
    }
    for (const s of account.incomeSources) {
      events.push(...generateIncomeOccurrences(s, from, to));
    }

    const forecast = buildAccountForecast(
      account.currentBalance!,
      events,
      account.minimumBalance!,
      from,
      to
    );
    const breaches = findBreachDays(forecast);

    // Record $15 fee if the actual balance (not just forecast) is already breaching
    if (
      account.minimumBalanceFee &&
      account.currentBalance!.lessThan(account.minimumBalance!)
    ) {
      const monthStart = startOfDayUTC(
        new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
      );
      const existingFee = await db.transaction.findFirst({
        where: {
          accountId: account.id,
          description: "TD Bank Minimum Balance Fee",
          postedAt: { gte: monthStart },
        },
      });
      if (!existingFee) {
        let feeTag = await db.tag.findFirst({ where: { name: "Bank Fees" } });
        if (!feeTag) {
          feeTag = await db.tag.create({
            data: { name: "Bank Fees", shortName: "Bank Fees" },
          });
        }
        const entity = await db.entity.findFirst({
          where: { accounts: { some: { id: account.id } } },
        });
        if (entity) {
          const tx = await db.transaction.create({
            data: {
              accountId: account.id,
              entityId: entity.id,
              postedAt: new Date(),
              amount: new Prisma.Decimal(account.minimumBalanceFee).negated(),
              payeeRaw: "TD Bank",
              description: "TD Bank Minimum Balance Fee",
              source: "manual",
            },
          });
          await db.transactionTag.create({ data: { transactionId: tx.id, tagId: feeTag.id } });
        }
      }
    }

    if (breaches.length === 0) continue;

    const scopeKey = `low_balance:${account.id}`;
    if (await alreadyNotifiedToday(scopeKey)) continue;

    const firstBreach = breaches[0]!;
    const breachDate = firstBreach.date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "America/New_York",
    });
    const minStr = formatUSD(account.minimumBalance!);
    const title = `Low balance warning: ${account.nickname}`;
    const body = `${account.nickname} is projected to fall below ${minStr} on ${breachDate}.`;

    await createNotification({
      type: "low_balance",
      entityId: account.entityId,
      payload: { scopeKey, title, body, accountNickname: account.nickname, projectedBreachDate: firstBreach.date.toISOString(), minimumBalance: account.minimumBalance!.toFixed(2) },
      userIds,
    });
    generated++;
  }

  return generated;
}

// ── Check: Accrual shortfall ──────────────────────────────────────────────────

export async function checkAccrualShortfall(): Promise<number> {
  const envelopes = await db.accrualEnvelope.findMany({
    include: { account: { include: { entity: true } } },
  });

  const now = new Date();
  const monthsElapsed = now.getUTCMonth() + 1;
  const currentMonth = now.getUTCMonth() + 1;
  const userIds = await getAllUserIds();
  let generated = 0;

  for (const envelope of envelopes) {
    const drawMonths = envelope.expectedDrawMonths as number[];
    const approachingDraw = drawMonths.some((m) => {
      const delta = ((m - currentMonth) + 12) % 12;
      return delta <= 2;
    });
    if (!approachingDraw) continue;

    const proRataTarget = envelope.targetAnnualAmount.div(12).times(monthsElapsed);
    if (!envelope.currentBalance.lessThan(proRataTarget)) continue;

    const scopeKey = `accrual_shortfall:${envelope.id}`;
    if (await alreadyNotifiedToday(scopeKey)) continue;

    const nextDraw = drawMonths
      .map((m) => ({ m, delta: ((m - currentMonth) + 12) % 12 }))
      .sort((a, b) => a.delta - b.delta)[0]!;
    const drawMonthName = new Date(Date.UTC(now.getUTCFullYear(), nextDraw.m - 1, 1))
      .toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

    const shortfall = proRataTarget.minus(envelope.currentBalance);
    const title = `Accrual shortfall: ${envelope.name}`;
    const body = `${envelope.name} is ${formatUSD(envelope.currentBalance)} of the ${formatUSD(proRataTarget)} target needed before draw season (${drawMonthName}). ${formatUSD(shortfall)} short.`;

    await createNotification({
      type: "accrual_shortfall",
      entityId: envelope.account.entityId,
      payload: { scopeKey, title, body, envelopeName: envelope.name, currentBalance: envelope.currentBalance.toFixed(2), target: proRataTarget.toFixed(2) },
      userIds,
    });
    generated++;
  }

  return generated;
}

// ── Check: Bill reminders ─────────────────────────────────────────────────────

export async function checkBillReminders(): Promise<number> {
  const bills = await db.scheduledBill.findMany({
    where: { active: true, autopayDay: { not: null } },
    include: { entity: true },
  });

  const now = new Date();
  const userIds = await getAllUserIds();
  let generated = 0;

  for (const bill of bills) {
    const day = bill.autopayDay!;
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day));
    const upcoming = thisMonth.getTime() >= startOfDayUTC(now).getTime() ? thisMonth : nextMonth;
    const daysUntil = Math.floor((upcoming.getTime() - startOfDayUTC(now).getTime()) / 86400000);

    if (daysUntil < 0 || daysUntil > 3) continue;

    const scopeKey = `bill_due:${bill.id}:${upcoming.toISOString().slice(0, 10)}`;
    if (await alreadyNotifiedToday(scopeKey)) continue;

    const dueDate = upcoming.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const amountStr = bill.expectedAmount ? ` (${formatUSD(bill.expectedAmount)})` : "";
    const title = `Bill reminder: ${bill.payee}`;
    const body = `${bill.payee} autopay is due ${dueDate}${amountStr}.`;

    await createNotification({
      type: "bill_due",
      entityId: bill.entityId,
      payload: { scopeKey, title, body, payee: bill.payee, dueDate: upcoming.toISOString(), amount: bill.expectedAmount?.toFixed(2) ?? null },
      userIds,
    });
    generated++;
  }

  return generated;
}

// ── Check: Spending anomalies ─────────────────────────────────────────────────

export async function checkAnomalies(period: string): Promise<number> {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1));

  // 3-month lookback
  const lookbackStart = new Date(Date.UTC(year, month - 4, 1));

  const currentSpendRows = await db.$queryRaw<{ tagId: string; entityId: string; total: string }[]>`
    SELECT tt."tagId", t."entityId", SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${periodStart}
      AND t."postedAt" < ${periodEnd}
    GROUP BY tt."tagId", t."entityId"
  `;

  const historicalRows = await db.$queryRaw<{ tagId: string; entityId: string; total: string }[]>`
    SELECT tt."tagId", t."entityId", SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${lookbackStart}
      AND t."postedAt" < ${periodStart}
    GROUP BY tt."tagId", t."entityId"
  `;

  // Historical average: total / 3 months
  const histMap = new Map(
    historicalRows.map((r) => [`${r.entityId}:${r.tagId}`, new Decimal(r.total).div(3)])
  );

  const tags = await db.tag.findMany({ select: { id: true, shortName: true } });
  const tagNames = new Map(tags.map((t) => [t.id, t.shortName]));

  const userIds = await getAllUserIds();
  let generated = 0;

  for (const row of currentSpendRows) {
    const current = new Decimal(row.total).abs();
    const avg = histMap.get(`${row.entityId}:${row.tagId}`)?.abs() ?? new Decimal(0);
    const noiseFloor = new Decimal(50);

    if (current.lessThan(noiseFloor)) continue;
    if (avg.isZero()) continue;
    if (current.lessThanOrEqualTo(avg.times(1.5))) continue;

    const scopeKey = `anomaly:${row.entityId}:${row.tagId}:${period}`;
    if (await alreadyNotifiedToday(scopeKey)) continue;

    const tagName = tagNames.get(row.tagId) ?? "Unknown";
    const multiple = current.div(avg).toFixed(1);
    const title = `Unusual spending: ${tagName}`;
    const body = `${tagName} spending is ${formatUSD(current)} this month vs. ${formatUSD(avg)} avg — ${multiple}× above normal.`;

    await createNotification({
      type: "anomaly",
      entityId: row.entityId,
      payload: { scopeKey, title, body, tagName, current: current.toFixed(2), avg: avg.toFixed(2), multiple },
      userIds,
    });
    generated++;
  }

  return generated;
}

// ── Check: Document expiry ────────────────────────────────────────────────────

export async function checkDocumentExpiry(): Promise<number> {
  const policies = await db.insurancePolicy.findMany({
    where: { archivedAt: null, expiryDate: { not: null } },
  });

  const users = await db.user.findMany({ select: { id: true, notificationPrefs: true } });
  let generated = 0;
  const now = Date.now();

  for (const policy of policies) {
    const daysUntilExpiry = Math.ceil((policy.expiryDate!.getTime() - now) / 86400000);
    if (daysUntilExpiry > 30) continue;

    const existing = await db.notification.findFirst({
      where: {
        type: "policy_expiry",
        payload: { path: ["policyId"], equals: policy.id },
      },
    });
    if (existing) continue;

    const eligibleUserIds = users
      .filter((u) => {
        const prefs = (u.notificationPrefs ?? {}) as Record<string, unknown>;
        const p = prefs["policy_expiry"] as { enabled?: boolean } | undefined;
        return p?.enabled !== false;
      })
      .map((u) => u.id);

    if (eligibleUserIds.length === 0) continue;

    const label =
      daysUntilExpiry < 0
        ? "has expired"
        : `expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`;
    const title = `Policy expiring soon: ${policy.insurer}`;
    const body = `${policy.insurer} ${policy.policyType} policy ${label}.`;

    await createNotification({
      type: "policy_expiry",
      payload: { title, body, policyId: policy.id, insurer: policy.insurer, daysUntilExpiry },
      userIds: eligibleUserIds,
    });
    generated++;
  }

  return generated;
}

// ── Check: Credit card payment due (avoid interest) ───────────────────────────

import { classifyCardDue, shouldRemindCardPayment } from "./card-due";

/**
 * Reminds before each credit card's payment due date with the statement
 * balance — paying that amount by the due date avoids interest charges.
 * Escalates separately for overdue statements.
 */
export async function checkCardPaymentsDue(): Promise<number> {
  const cards = await db.account.findMany({
    where: {
      accountType: "credit_card",
      archivedAt: null,
      ccDueDate: { not: null },
    },
    include: { entity: { select: { id: true } } },
  });

  const now = new Date();
  const userIds = await getAllUserIds();
  let generated = 0;

  for (const card of cards) {
    const dueDate = card.ccDueDate!;
    const info = classifyCardDue(dueDate, now);
    const balance = card.ccStatementBalance;

    // Standard reminder inside the window
    if (shouldRemindCardPayment(dueDate, now)) {
      const scopeKey = `card_due:${card.id}:${dueDate.toISOString().slice(0, 10)}`;
      if (await alreadyNotifiedToday(scopeKey)) continue;

      const dueStr = dueDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/New_York",
      });
      const balStr = balance ? ` Pay ${formatUSD(balance)} to avoid interest.` : "";
      const whenStr =
        info.urgency === "imminent"
          ? info.daysUntilDue <= 0
            ? "today"
            : "tomorrow"
          : `in ${info.daysUntilDue} days`;

      const title = `Card payment due ${whenStr}: ${card.nickname}`;
      const body = `${card.nickname} statement${balStr} Due ${dueStr}.${balance ? "" : " Check your statement for the payoff amount."}`;

      await createNotification({
        type: "cc_payment_due",
        entityId: card.entity.id,
        payload: {
          scopeKey,
          title,
          body,
          accountNickname: card.nickname,
          dueDate: dueDate.toISOString(),
          statementBalance: balance?.toFixed(2) ?? null,
          daysUntilDue: info.daysUntilDue,
        },
        userIds,
      });
      generated++;
    }
    // Escalated overdue notice (fires daily until a sync shows a new cycle)
    else if (info.urgency === "overdue" && balance) {
      const scopeKey = `card_overdue:${card.id}:${dueDate.toISOString().slice(0, 10)}`;
      if (await alreadyNotifiedToday(scopeKey)) continue;

      const overdueDays = Math.abs(info.daysUntilDue);
      const title = `Overdue card statement: ${card.nickname}`;
      const body = `${card.nickname} was due ${overdueDays} day${overdueDays !== 1 ? "s" : ""} ago — ${formatUSD(balance)} unpaid. Interest may already be accruing on new purchases.`;

      await createNotification({
        type: "cc_payment_overdue",
        entityId: card.entity.id,
        payload: {
          scopeKey,
          title,
          body,
          accountNickname: card.nickname,
          dueDate: dueDate.toISOString(),
          statementBalance: balance.toFixed(2),
          daysOverdue: overdueDays,
        },
        userIds,
      });
      generated++;
    }
  }

  return generated;
}

// ── Check: Credit card funding shortfall (cards vs x2631) ────────────────────

import { analyzeCardFunding, buildFundingMessage, type CardDue } from "./cc-funding";

/**
 * Projects the credit-card funding account (x2631 "Credit Cards") across all
 * upcoming card statement payments. Notifies when the autopayments would dip
 * it below the $250 minimum — with the exact transfer needed to avoid the
 * $15 monthly low-balance fee. Also fires a gentler warning when the cushion
 * after all payments is under $50.
 */
export async function checkCcFundingShortfall(): Promise<number> {
  // The funding account: TD checking named "Credit Cards" with a minimum rule
  const fundingAccount = await db.account.findFirst({
    where: {
      nickname: "Credit Cards",
      accountType: "checking",
      archivedAt: null,
      minimumBalance: { not: null },
    },
  });
  if (!fundingAccount || fundingAccount.currentBalance === null) return 0;

  // All credit cards on the same entity with live statement data
  const cards = await db.account.findMany({
    where: {
      accountType: "credit_card",
      archivedAt: null,
      entityId: fundingAccount.entityId,
      ccDueDate: { not: null },
      ccStatementBalance: { not: null },
    },
    orderBy: { ccDueDate: "asc" },
  });
  if (cards.length === 0) return 0;

  const from = startOfDayUTC(new Date());
  const to = new Date(from.getTime() + 30 * 86400000);

  const cardDues: CardDue[] = cards
    .map((c) => ({
      accountNickname: c.nickname,
      dueDate: c.ccDueDate!,
      statementBalance: new Decimal(c.ccStatementBalance!.toString()),
      minimumPayment: c.ccMinimumPayment ? new Decimal(c.ccMinimumPayment.toString()) : null,
    }))
    // Only cards with a due date inside the 30-day window
    .filter((c) => c.dueDate >= from && c.dueDate < to);
  if (cardDues.length === 0) return 0;

  const result = analyzeCardFunding({
    currentBalance: new Decimal(fundingAccount.currentBalance.toString()),
    minimumBalance: fundingAccount.minimumBalance
      ? new Decimal(fundingAccount.minimumBalance.toString())
      : null,
    cards: cardDues,
    from,
    to,
  });

  // Only notify on shortfall or tight cushion — "covered" stays silent
  if (result.status === "covered") return 0;

  const scopeKey = `cc_funding:${fundingAccount.id}:${result.status === "shortfall" ? "short" : "risk"}`;
  if (await alreadyNotifiedToday(scopeKey)) return 0;

  const { title, body } = buildFundingMessage({
    fundingAccountNickname: fundingAccount.nickname,
    currentBalance: new Decimal(fundingAccount.currentBalance.toString()),
    minimumBalance: fundingAccount.minimumBalance
      ? new Decimal(fundingAccount.minimumBalance.toString())
      : null,
    minimumBalanceFee: fundingAccount.minimumBalanceFee
      ? new Decimal(fundingAccount.minimumBalanceFee.toString())
      : null,
    result,
  });

  const userIds = await getAllUserIds();
  await createNotification({
    type: "cc_funding_shortfall",
    entityId: fundingAccount.entityId,
    payload: {
      scopeKey,
      title,
      body,
      fundingAccountNickname: fundingAccount.nickname,
      status: result.status,
      totalDue: result.totalDue.toFixed(2),
      shortfall: result.shortfall?.toFixed(2) ?? null,
      firstShortfallDate: result.firstShortfallDate?.toISOString() ?? null,
      cards: cardDues.map((c) => ({
        nickname: c.accountNickname,
        dueDate: c.dueDate.toISOString(),
        statementBalance: c.statementBalance.toFixed(2),
      })),
    },
    userIds,
  });
  return 1;
}

// ── Check: Large spend ────────────────────────────────────────────────────────

export async function checkLargeSpend(): Promise<number> {
  const users = await db.user.findMany({ select: { id: true, notificationPrefs: true } });
  const since = new Date(Date.now() - 86400000);

  const transactions = await db.transaction.findMany({
    where: { archivedAt: null, transferPairId: null, postedAt: { gte: since } },
    include: {
      account: { select: { nickname: true } },
      entity: { select: { name: true } },
    },
  });

  let generated = 0;

  for (const user of users) {
    const prefs = (user.notificationPrefs ?? {}) as Record<string, unknown>;
    const largePref = prefs["large_spend"] as
      | { enabled?: boolean; thresholdCents?: number }
      | undefined;
    if (largePref?.enabled === false) continue;
    const thresholdCents = largePref?.thresholdCents ?? 50000;

    for (const tx of transactions) {
      const amountCents = Math.round(Math.abs(tx.amount.toNumber()) * 100);
      if (amountCents < thresholdCents) continue;

      const existing = await db.notification.findFirst({
        where: {
          type: "large_spend",
          payload: { path: ["transactionId"], equals: tx.id },
          users: { some: { userId: user.id } },
        },
      });
      if (existing) continue;

      const payee = tx.payeeRaw ?? tx.payeeNormalized ?? "Unknown";
      const amtStr = `$${(amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
      const title = "Large transaction posted";
      const body = `${amtStr} at ${payee} on ${tx.account.nickname}.`;

      await createNotification({
        type: "large_spend",
        entityId: tx.entityId,
        payload: {
          title,
          body,
          transactionId: tx.id,
          amountCents,
          payeeRaw: payee,
          accountNickname: tx.account.nickname,
          entityName: tx.entity.name,
        },
        userIds: [user.id],
      });
      generated++;
    }
  }

  return generated;
}

// ── Dispatch pending push notifications ───────────────────────────────────────

export async function dispatchPending(): Promise<void> {
  // sentAt is set immediately in createNotification above; this is a safety net
  // for any notifications created outside that path.
  const pending = await db.notification.findMany({
    where: { sentAt: null },
    include: { users: true },
  });

  for (const n of pending) {
    const payload = n.payload as Record<string, unknown>;
    await Promise.allSettled(
      n.users.map((nu) =>
        sendPushToUser(nu.userId, {
          title: (payload["title"] as string) ?? "Banana Stand",
          body: (payload["body"] as string) ?? "",
          url: "/notifications",
        })
      )
    );
    await db.notification.update({ where: { id: n.id }, data: { sentAt: new Date() } });
  }
}
