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
import { loadNetIncomeSources } from "./net-income-build";
import { effectiveSchedule, generateBillOccurrencesBudgetDated, hasResolvableDay } from "./bill-dates";
import { loadBudgetScheduleIndex } from "./bill-dates-build";
import { loadEffectiveBudgetRows } from "./budget-carry-forward-build";
import { sendPushToUser } from "./web-push";
import { evaluateBudgetPace, PACE_TRAILING_MONTHS } from "./budget-pace";
import type { MonthlySpendPoint } from "./budget-pace";
import { autoAssignGlCodes } from "./gl-code-resolver";
import { resolveBudgetedAmounts } from "./budget-nesting";

// Groups a period's Budget rows by accountId and resolves each line's
// effective (possibly auto-summed) amount — shared by checkBudgetOverspend
// and checkBudgetPace, both of which do independent per-tag checks (no
// root-filtering needed; every row, parent and child, gets its own resolved
// amount and its own independent check).
function resolveBudgetsByAccount<T extends { id: string; tagId: string; accountId: string; budgeted: Decimal | null; tag: { parentId: string | null } }>(
  budgets: T[]
): Map<string, Decimal> {
  const byAccountId = new Map<string, T[]>();
  for (const b of budgets) {
    if (!byAccountId.has(b.accountId)) byAccountId.set(b.accountId, []);
    byAccountId.get(b.accountId)!.push(b);
  }
  const resolved = new Map<string, Decimal>();
  for (const group of byAccountId.values()) {
    const tagParentById = new Map(group.map((b) => [b.tagId, b.tag.parentId]));
    const resolverInput = group.map((b) => ({ id: b.id, tagId: b.tagId, budgeted: b.budgeted }));
    for (const [id, amt] of resolveBudgetedAmounts(resolverInput, (tagId) => tagParentById.get(tagId), new Decimal(0))) {
      resolved.set(id, amt);
    }
  }
  return resolved;
}

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

  // Effective rows: when the month has no row for a line, the latest earlier month's row stands in (read-time carry-forward).
  const budgets = await loadEffectiveBudgetRows({ periods: [period] });

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
  const resolvedByBudgetId = resolveBudgetsByAccount(budgets);
  const users = await db.user.findMany({ select: { id: true, notificationPrefs: true } });
  let generated = 0;

  for (const budget of budgets) {
    const actualSpend = spendByTagId.get(budget.tagId) ?? new Decimal(0);
    const summary = computeBudgetSummary({
      budgeted: resolvedByBudgetId.get(budget.id) ?? new Decimal(0),
      rolloverAmount: budget.rolloverAmount ?? new Decimal(0),
      actualSpend,
    });

    const eligibleUserIds = users
      .filter((u) => {
        const prefs = (u.notificationPrefs ?? {}) as Record<string, unknown>;
        const p = prefs["overspend"] as { enabled?: boolean; threshold?: number } | undefined;
        if (p?.enabled === false) return false;
        const threshold = p?.threshold ?? 80;
        return summary.percentUsed >= threshold;
      })
      .map((u) => u.id);

    if (eligibleUserIds.length === 0) continue;

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
      userIds: eligibleUserIds,
    });
    generated++;
  }

  return generated;
}

// ── Check: Budget pace (forecast-based early warning) ─────────────────────────

/**
 * Early "trending over budget" warning, distinct from checkBudgetOverspend's
 * snapshot 80%-used alert. Wraps projectPeriodEndSpend() (lib/spend-forecast.ts)
 * via evaluateBudgetPace() (lib/budget-pace.ts), which stands down once
 * percentUsed >= 80 (checkBudgetOverspend owns that signal at that point) and
 * once forecast.confidence === "low" (too shaky to page on).
 */
export async function checkBudgetPace(period: string): Promise<number> {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  // Effective rows: when the month has no row for a line, the latest earlier month's row stands in (read-time carry-forward).
  const budgets = await loadEffectiveBudgetRows({ periods: [period] });

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

  const trailingMonths = PACE_TRAILING_MONTHS;
  const historyStart = new Date(Date.UTC(year, month - 1 - trailingMonths, 1));

  const historyRows = await db.$queryRaw<{ tagId: string; period: string; total: string }[]>`
    SELECT tt."tagId" AS "tagId", to_char(t."postedAt", 'YYYY-MM') AS period, SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${historyStart}
      AND t."postedAt" < ${monthStart}
    GROUP BY tt."tagId", period
  `;

  const historyByTagId = new Map<string, MonthlySpendPoint[]>();
  for (const row of historyRows) {
    const points = historyByTagId.get(row.tagId) ?? [];
    points.push({ period: row.period, total: new Decimal(row.total) });
    historyByTagId.set(row.tagId, points);
  }

  const resolvedByBudgetId = resolveBudgetsByAccount(budgets);
  const users = await db.user.findMany({ select: { id: true, notificationPrefs: true } });
  let generated = 0;

  for (const budget of budgets) {
    const actualSpend = spendByTagId.get(budget.tagId) ?? new Decimal(0);
    const summary = computeBudgetSummary({
      budgeted: resolvedByBudgetId.get(budget.id) ?? new Decimal(0),
      rolloverAmount: budget.rolloverAmount ?? new Decimal(0),
      actualSpend,
    });

    const evaluation = evaluateBudgetPace({
      period,
      effectiveBudget: summary.effectiveBudget,
      actualSpend,
      percentUsed: summary.percentUsed,
      asOfDate: startOfDayUTC(new Date()),
      history: historyByTagId.get(budget.tagId) ?? [],
      trailingMonths: PACE_TRAILING_MONTHS,
    });

    if (!evaluation.fire) continue;

    const eligibleUserIds = users
      .filter((u) => {
        const prefs = (u.notificationPrefs ?? {}) as Record<string, unknown>;
        const p = prefs["budget_pace"] as { enabled?: boolean } | undefined;
        return p?.enabled !== false;
      })
      .map((u) => u.id);

    if (eligibleUserIds.length === 0) continue;

    const scopeKey = `pace:${budget.tagId}:${period}`;
    if (await alreadyNotifiedToday(scopeKey)) continue;

    const title = `Trending over budget: ${budget.tag.shortName}`;
    const body =
      `${budget.tag.shortName} is on pace to reach ${formatUSD(evaluation.forecast.projectedTotal)} ` +
      `by month end, above the ${formatUSD(summary.effectiveBudget)} budget — projected from ` +
      `${formatUSD(actualSpend)} spent so far plus the last ${evaluation.forecast.trailingMonthsUsed} ` +
      `month${evaluation.forecast.trailingMonthsUsed === 1 ? "" : "s"} of history.`;

    await createNotification({
      type: "budget_pace",
      entityId: budget.entityId,
      payload: {
        scopeKey,
        title,
        body,
        tagName: budget.tag.shortName,
        effectiveBudget: summary.effectiveBudget.toFixed(2),
        actualSpend: actualSpend.abs().toFixed(2),
        projectedTotal: evaluation.forecast.projectedTotal.abs().toFixed(2),
        projectedOverage: evaluation.projectedOverageAbs!.toFixed(2),
        confidence: evaluation.forecast.confidence,
        method: evaluation.forecast.method,
        trailingMonthsUsed: evaluation.forecast.trailingMonthsUsed,
        daysElapsed: evaluation.forecast.daysElapsed,
        daysInPeriod: evaluation.forecast.daysInPeriod,
        percentUsed: Math.round(summary.percentUsed),
      },
      userIds: eligibleUserIds,
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
    },
  });

  const from = startOfDayUTC(new Date());
  const to = new Date(from.getTime() + 30 * 86400000);
  const users = await db.user.findMany({ select: { id: true, notificationPrefs: true } });
  let generated = 0;

  for (const account of accounts) {
    const events: ScheduleEvent[] = [];

    for (const t of [...account.scheduledTransfersFrom, ...account.scheduledTransfersTo]) {
      events.push(
        ...generateTransferOccurrences(t, from, to).filter((e) => e.accountId === account.id)
      );
    }
    // Paychecks are TAKE-HOME (lib/net-income-build.ts), never the stored gross amount.
    for (const s of await loadNetIncomeSources({ where: { accountId: account.id } })) {
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
          // No user session in this cron path — GL auto-assignment still
          // happens, only its audit row is skipped (matches this site's
          // existing choice to skip an audit log for the tag write itself).
          await autoAssignGlCodes([
            { transactionId: tx.id, entityId: entity.id, tagIds: [feeTag.id] },
          ]);
        }
      }
    }

    if (breaches.length === 0) continue;

    const eligibleUserIds = users
      .filter((u) => {
        const prefs = (u.notificationPrefs ?? {}) as Record<string, unknown>;
        const p = prefs["low_balance"] as { enabled?: boolean } | undefined;
        return p?.enabled !== false;
      })
      .map((u) => u.id);

    if (eligibleUserIds.length === 0) continue;

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
      userIds: eligibleUserIds,
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
  const users = await db.user.findMany({ select: { id: true, notificationPrefs: true } });
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

    const eligibleUserIds = users
      .filter((u) => {
        const prefs = (u.notificationPrefs ?? {}) as Record<string, unknown>;
        const p = prefs["accrual_shortfall"] as { enabled?: boolean } | undefined;
        return p?.enabled !== false;
      })
      .map((u) => u.id);

    if (eligibleUserIds.length === 0) continue;

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
      userIds: eligibleUserIds,
    });
    generated++;
  }

  return generated;
}

// ── Check: Bill reminders ─────────────────────────────────────────────────────

export async function checkBillReminders(): Promise<number> {
  // A bill tied to a Budget line is dated by that month's Budget row (the money has to be in the account then), so a
  // bill whose own record has no day can still have one: the query includes tagged bills, and a bill with no
  // resolvable date in a month gets no reminder for it (no fabricated day 1).
  const bills = await db.scheduledBill.findMany({
    where: {
      active: true,
      OR: [{ autopayDay: { not: null } }, { frequency: { not: "monthly" } }, { budgetTagId: { not: null } }],
    },
    include: { entity: true },
  });

  const now = new Date();
  const today = startOfDayUTC(now);
  // Wide enough to cover every cadence's next occurrence (monthly days 29-31
  // clamp to the month's last day in allMonthDays, so consecutive monthly
  // occurrences are at most 31 days apart). 65 days is kept as a generous
  // margin and costs nothing.
  const horizon = new Date(today.getTime() + 65 * 86400000);
  const users = await db.user.findMany({ select: { id: true, notificationPrefs: true } });
  const budgetDates = await loadBudgetScheduleIndex({ from: today, to: horizon });
  let generated = 0;

  for (const bill of bills) {
    // generateBillOccurrences already sorts ascending (accrued branch is
    // explicitly sorted; the date-generator branch is naturally ascending
    // since allMonthDays/allWeekdays/allBiweekly all produce ascending output).
    const events = generateBillOccurrencesBudgetDated(bill, budgetDates.index, today, horizon).filter((e) =>
      hasResolvableDay(effectiveSchedule(bill, budgetDates.index, e.date.toISOString().slice(0, 7)), bill)
    );
    // Includes a bill with a due day set but a null/zero expectedAmount (e.g. a
    // budget line with an auto-summed or still-blank amount) — generateBillOccurrences
    // gates on a real amount, so this bill silently gets no reminder instead of one
    // with a blank dollar figure, as it did before this function routed through the
    // shared generator. Deliberate: no live budget/bill row is in this state as of
    // 2026-09-18, and reminding about an unknown amount isn't obviously better than
    // not reminding at all. Revisit if that stops being true.
    if (events.length === 0) continue;
    const nextEvent = events[0]!;
    const upcoming = nextEvent.date;
    const daysUntil = Math.floor((upcoming.getTime() - today.getTime()) / 86400000);

    if (daysUntil < 0) continue;

    const eligibleUserIds = users
      .filter((u) => {
        const prefs = (u.notificationPrefs ?? {}) as Record<string, unknown>;
        const p = prefs["bill_due"] as { enabled?: boolean; daysAhead?: number } | undefined;
        if (p?.enabled === false) return false;
        const daysAhead = p?.daysAhead ?? 3;
        return daysUntil <= daysAhead;
      })
      .map((u) => u.id);

    if (eligibleUserIds.length === 0) continue;

    const scopeKey = `bill_due:${bill.id}:${upcoming.toISOString().slice(0, 10)}`;
    if (await alreadyNotifiedToday(scopeKey)) continue;

    const dueDate = upcoming.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    // Per-occurrence amount (already derived via perOccurrenceAmount inside
    // generateBillOccurrences) — NOT bill.expectedAmount, which is always the
    // MONTHLY total and would overstate a weekly/biweekly bill's reminder.
    const occurrenceAmount = nextEvent.amount.abs();
    const amountStr = ` (${formatUSD(occurrenceAmount)})`;
    const title = `Bill reminder: ${bill.payee}`;
    const body = `${bill.payee} autopay is due ${dueDate}${amountStr}.`;

    await createNotification({
      type: "bill_due",
      entityId: bill.entityId,
      payload: {
        scopeKey,
        title,
        body,
        payee: bill.payee,
        dueDate: upcoming.toISOString(),
        amount: occurrenceAmount.toFixed(2),
      },
      userIds: eligibleUserIds,
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

  const users = await db.user.findMany({ select: { id: true, notificationPrefs: true } });
  let generated = 0;

  for (const row of currentSpendRows) {
    const current = new Decimal(row.total).abs();
    const avg = histMap.get(`${row.entityId}:${row.tagId}`)?.abs() ?? new Decimal(0);
    const noiseFloor = new Decimal(50);

    if (current.lessThan(noiseFloor)) continue;
    if (avg.isZero()) continue;

    const eligibleUserIds = users
      .filter((u) => {
        const prefs = (u.notificationPrefs ?? {}) as Record<string, unknown>;
        const p = prefs["anomaly"] as { enabled?: boolean; multiplier?: number } | undefined;
        if (p?.enabled === false) return false;
        const multiplier = p?.multiplier ?? 1.5;
        return current.greaterThan(avg.times(multiplier));
      })
      .map((u) => u.id);

    if (eligibleUserIds.length === 0) continue;

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
      userIds: eligibleUserIds,
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
import { cardDuesInWindow } from "./card-next-statement";
import { loadCardProjections } from "./card-next-statement-build";

/**
 * Reminds before each credit card's payment due date with the statement
 * balance — every card is paid in full, so the whole statement balance is
 * what avoids interest charges. Escalates separately for statements past their
 * due date, but ONLY when no payment was found: a statement the card's own
 * transactions (or a matching bank payment) show as paid sends nothing.
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
  // Paid-statement evidence (read-only, fail-soft). When it cannot be loaded nothing is claimed paid, and the
  // past-due text below only says that no payment was FOUND.
  const loaded = await loadCardProjections({ now });
  const projectionByCard = new Map(loaded.projections.map((p) => [p.cardId, p]));
  const users = await db.user.findMany({ select: { id: true, notificationPrefs: true } });
  const eligibleUserIds = users
    .filter((u) => {
      const prefs = (u.notificationPrefs ?? {}) as Record<string, unknown>;
      const p = prefs["cc_payment_due"] as { enabled?: boolean } | undefined;
      return p?.enabled !== false;
    })
    .map((u) => u.id);
  let generated = 0;

  for (const card of cards) {
    if (eligibleUserIds.length === 0) continue;

    const dueDate = card.ccDueDate!;
    const info = classifyCardDue(dueDate, now);
    const balance = card.ccStatementBalance;

    // Evidence the statement on file was paid: no reminder and no overdue alert for it.
    if (projectionByCard.get(card.id)?.onFile?.paid) continue;

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
        userIds: eligibleUserIds,
      });
      generated++;
    }
    // Past-due notice when no payment was found (fires daily until a sync shows a payment or a new cycle)
    else if (info.urgency === "overdue" && balance) {
      const scopeKey = `card_overdue:${card.id}:${dueDate.toISOString().slice(0, 10)}`;
      if (await alreadyNotifiedToday(scopeKey)) continue;

      const overdueDays = Math.abs(info.daysUntilDue);
      // loaded.error: no search for a payment ran, so do not say none was found.
      const title = loaded.error
        ? `Card statement past its due date: ${card.nickname}`
        : `Card statement past its due date, no payment found: ${card.nickname}`;
      const body = loaded.error
        ? `${card.nickname} was due ${overdueDays} day${overdueDays !== 1 ? "s" : ""} ago (statement ${formatUSD(balance)}); payments could not be checked just now, so check the card.`
        : `${card.nickname} was due ${overdueDays} day${overdueDays !== 1 ? "s" : ""} ago (statement ${formatUSD(balance)}); no matching payment was found in your synced transactions. A sync may be behind, so check the card.`;

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
        userIds: eligibleUserIds,
      });
      generated++;
    }
  }

  return generated;
}

// ── Check: Credit card funding shortfall (cards vs x2631) ────────────────────

import { analyzeCardFunding, buildFundingMessage } from "./cc-funding";
import { loadScheduledFlows } from "./account-scheduled-flows";
import type { CardProjection } from "./card-next-statement";

/**
 * Projects each account that really pays credit cards across the card
 * statement payments due in the next 30 days. The paying account is INFERRED
 * from past payments (lib/card-next-statement.ts), never assumed: a card whose
 * paying account is not determined is left out. Every card is paid in full, so
 * the whole statement balance is used. Statements not yet issued are included
 * only when their estimate is high or medium confidence, marked as estimates;
 * a rough (low confidence) estimate never triggers a notification. Scheduled
 * transfers, paychecks and bills into or out of the account are applied, so a
 * transfer already planned is not reported as a shortfall. Notifies when the
 * payments would dip the account below its minimum — with the exact transfer
 * needed to avoid the monthly low-balance fee. Also fires a gentler warning
 * when the cushion after all payments is under $50.
 */
export async function checkCcFundingShortfall(): Promise<number> {
  const now = new Date();
  const loaded = await loadCardProjections({ now });
  if (loaded.error || loaded.projections.length === 0) return 0;

  const projectionsByAccount = new Map<string, CardProjection[]>();
  for (const p of loaded.projections) {
    if (!p.funding) continue;
    projectionsByAccount.set(p.funding.accountId, [...(projectionsByAccount.get(p.funding.accountId) ?? []), p]);
  }

  let generated = 0;
  for (const [accountId, projections] of projectionsByAccount) {
    generated += await notifyFundingAccount(accountId, projections, now);
  }
  return generated;
}

async function notifyFundingAccount(accountId: string, projections: CardProjection[], now: Date): Promise<number> {
  // A checking account with a minimum-balance rule (the rule is what a shortfall breaks)
  const fundingAccount = await db.account.findFirst({
    where: {
      id: accountId,
      accountType: "checking",
      archivedAt: null,
      minimumBalance: { not: null },
    },
  });
  if (!fundingAccount || fundingAccount.currentBalance === null) return 0;

  const from = startOfDayUTC(now);
  const to = new Date(from.getTime() + 30 * 86400000);

  // Cards of any entity that this account pays (a business card can be paid from a personal account)
  const cardDues = projections.flatMap((p) => cardDuesInWindow(p, from, to, { minConfidence: "medium" }));
  if (cardDues.length === 0) return 0;

  // Known inflows (planned transfers, paychecks) decide whether a payment is a shortfall. If they cannot be read,
  // skip this account's alert for this run: an alert computed without them may over-report.
  const otherFlows = await loadScheduledFlows(fundingAccount.id, from, to);
  if (otherFlows === null) return 0;

  const result = analyzeCardFunding({
    currentBalance: new Decimal(fundingAccount.currentBalance.toString()),
    minimumBalance: fundingAccount.minimumBalance
      ? new Decimal(fundingAccount.minimumBalance.toString())
      : null,
    cards: cardDues,
    from,
    to,
    otherFlows,
  });

  // Only notify on shortfall or tight cushion — "covered" stays silent
  if (result.status === "covered") return 0;

  const users = await db.user.findMany({ select: { id: true, notificationPrefs: true } });
  const eligibleUserIds = users
    .filter((u) => {
      const prefs = (u.notificationPrefs ?? {}) as Record<string, unknown>;
      const p = prefs["cc_funding_shortfall"] as { enabled?: boolean } | undefined;
      return p?.enabled !== false;
    })
    .map((u) => u.id);
  if (eligibleUserIds.length === 0) return 0;

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
      estimatedTotalDue: result.estimatedTotalDue.toFixed(2),
      cards: cardDues.map((c) => ({
        nickname: c.accountNickname,
        dueDate: c.dueDate.toISOString(),
        statementBalance: c.statementBalance.toFixed(2),
        estimated: c.estimate !== undefined,
      })),
    },
    userIds: eligibleUserIds,
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
