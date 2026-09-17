import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { projectPeriodEndSpend, type MonthlySpendPoint } from "./spend-forecast";
import { resolveBudgetedAmounts } from "./budget-nesting";
import {
  previousPeriod,
  periodMidpointDate,
  reconstructForecastAccuracy,
  selectNotableAccuracyRows,
  REVIEW_FORECAST_TRAILING_MONTHS,
  type TaggedForecastAccuracy,
} from "./review-forecast";

// ── Monthly review builder ──────────────────────────────────────────────────────
// DB-touching, not "use server" — an ordinary async function, safe to import
// from both actions/monthly-review.ts (which does its own requireAuth() first)
// and app/api/cron/monthly-review/route.ts (which authenticates via a bearer
// secret, not a session). This is the single source of truth for how a
// MonthlyReview's `data` JSON blob is computed; both callers upsert the result
// themselves — this function only builds and returns it.
//
// See .claude/pipeline/monthly-review-forecast/01-plan.md ("Discovered issue")
// for why this consolidation exists: the cron route previously had its own,
// separately-drifted inline copy of this logic that never received the new
// forecast fields.

export interface ReviewData {
  period: string;
  generatedAt: string;
  budgetHealth: Array<{
    tagName: string;
    entityName: string;
    budgetedCents: number;
    actualCents: number;
    percentUsed: number;
    status: "ok" | "warning" | "over";
    // Forward projection for this (possibly still in-progress) period.
    projectedCents: number; // abs(forecast.projectedTotal) in cents
    projectedPercentUsed: number; // round(projectedCents / budgetedCents * 100); 0 when budgetedCents is 0
    forecastConfidence: "low" | "medium" | "high";
    forecastMethod: "blended" | "pace_only";
  }>;
  accountSnapshot: Array<{
    nickname: string;
    balanceCents: number;
    minimumCents: number | null;
    marginCents: number | null;
  }>;
  upcomingBills: Array<{
    payee: string;
    amountCents: number | null;
    autopayDay: number | null;
    entityName: string;
  }>;
  accrualStatus: Array<{
    name: string;
    currentCents: number;
    targetCents: number;
    proRataCents: number;
    pct: number;
    status: "on_track" | "watch" | "behind";
  }>;
  // Retrospective accuracy for the prior period.
  forecastAccuracyPeriod: string | null; // the prior "YYYY-MM" this section evaluates; null when there were no budgeted tags for that period to evaluate (e.g. first review ever generated)
  forecastAccuracy: Array<{
    tagName: string;
    entityName: string;
    projectedCents: number; // abs, reconstructed at that period's midpoint
    actualCents: number; // abs, actual final total
    missCents: number; // abs(actual - projected)
    percentOff: number | null;
    direction: "over" | "under" | "exact";
    confidence: "low" | "medium" | "high";
  }>;
}

function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

async function queryTagSpend(
  start: Date,
  end: Date
): Promise<Map<string, Decimal>> {
  const rows = await db.$queryRaw<{ entityId: string; tagId: string; total: string }[]>`
    SELECT t."entityId", tt."tagId", SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${start}
      AND t."postedAt" < ${end}
    GROUP BY t."entityId", tt."tagId"
  `;
  const map = new Map<string, Decimal>();
  for (const row of rows) {
    map.set(`${row.entityId}:${row.tagId}`, new Decimal(row.total));
  }
  return map;
}

async function queryTagHistory(
  historyStart: Date,
  historyEnd: Date
): Promise<Map<string, MonthlySpendPoint[]>> {
  const rows = await db.$queryRaw<
    { entityId: string; tagId: string; period: string; total: string }[]
  >`
    SELECT t."entityId", tt."tagId", to_char(t."postedAt",'YYYY-MM') AS period,
           SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."archivedAt" IS NULL AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${historyStart} AND t."postedAt" < ${historyEnd}
    GROUP BY t."entityId", tt."tagId", period
  `;
  const map = new Map<string, MonthlySpendPoint[]>();
  for (const row of rows) {
    const key = `${row.entityId}:${row.tagId}`;
    const points = map.get(key) ?? [];
    points.push({ period: row.period, total: new Decimal(row.total) });
    map.set(key, points);
  }
  return map;
}

export async function buildMonthlyReviewData(period: string): Promise<ReviewData> {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error(`buildMonthlyReviewData: invalid period "${period}"`);

  const year = parseInt(match[1]!);
  const month = parseInt(match[2]!);
  const { start: monthStart, end: monthEnd } = monthBounds(year, month);

  // ── Budget health + forward projection ──────────────────────────────────────
  const budgets = await db.budget.findMany({
    where: { period },
    include: { tag: true, entity: true },
  });

  const tagSpendRows = await db.$queryRaw<{ entityId: string; tagId: string; total: string }[]>`
    SELECT t."entityId", tt."tagId", SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${monthStart}
      AND t."postedAt" < ${monthEnd}
    GROUP BY t."entityId", tt."tagId"
  `;

  const spendMap = new Map<string, number>();
  const spendDecimalMap = new Map<string, Decimal>();
  for (const row of tagSpendRows) {
    const key = `${row.entityId}:${row.tagId}`;
    spendMap.set(key, Math.round(Math.abs(parseFloat(row.total)) * 100));
    spendDecimalMap.set(key, new Decimal(row.total));
  }

  const historyStart = new Date(Date.UTC(year, month - 1 - REVIEW_FORECAST_TRAILING_MONTHS, 1));
  const historyMap = await queryTagHistory(historyStart, monthStart);

  // Nesting/auto-sum resolution — same-account only. No root-filtering
  // needed: budgetHealth's downstream consumers only ever count
  // status==="over"/"warning" rows, never sum dollar amounts.
  const budgetTagParentById = new Map(budgets.map((b) => [b.tagId, b.tag.parentId]));
  const budgetsByAccountId = new Map<string, typeof budgets>();
  for (const b of budgets) {
    if (!budgetsByAccountId.has(b.accountId)) budgetsByAccountId.set(b.accountId, []);
    budgetsByAccountId.get(b.accountId)!.push(b);
  }
  const resolvedBudgetById = new Map<string, Decimal>();
  for (const group of budgetsByAccountId.values()) {
    const resolverInput = group.map((b) => ({ id: b.id, tagId: b.tagId, budgeted: b.budgeted }));
    for (const [id, amt] of resolveBudgetedAmounts(resolverInput, (tagId) => budgetTagParentById.get(tagId), new Decimal(0))) {
      resolvedBudgetById.set(id, amt);
    }
  }

  const budgetHealth: ReviewData["budgetHealth"] = budgets.map((b) => {
    const key = `${b.entityId}:${b.tagId}`;
    const budgetedCents = Math.round((resolvedBudgetById.get(b.id) ?? new Decimal(0)).toNumber() * 100);
    const actualCents = spendMap.get(key) ?? 0;
    const percentUsed = budgetedCents > 0 ? Math.round((actualCents / budgetedCents) * 100) : 0;
    const status: "ok" | "warning" | "over" =
      percentUsed > 100 ? "over" : percentUsed > 80 ? "warning" : "ok";

    const forecast = projectPeriodEndSpend({
      period,
      spendToDate: spendDecimalMap.get(key) ?? new Decimal(0),
      asOfDate: new Date(),
      history: historyMap.get(key) ?? [],
      trailingMonths: REVIEW_FORECAST_TRAILING_MONTHS,
    });
    const projectedCents = Math.round(forecast.projectedTotal.abs().toNumber() * 100);
    const projectedPercentUsed =
      budgetedCents > 0 ? Math.round((projectedCents / budgetedCents) * 100) : 0;

    return {
      tagName: b.tag.shortName,
      entityName: b.entity.name,
      budgetedCents,
      actualCents,
      percentUsed,
      status,
      projectedCents,
      projectedPercentUsed,
      forecastConfidence: forecast.confidence,
      forecastMethod: forecast.method,
    };
  });

  // ── Account snapshot (personal entity) ──────────────────────────────────────
  const personalEntity = await db.entity.findFirst({ where: { name: "Personal" } });
  const accountSnapshot: ReviewData["accountSnapshot"] = [];

  if (personalEntity) {
    const accounts = await db.account.findMany({
      where: {
        entityId: personalEntity.id,
        archivedAt: null,
        currentBalance: { not: null },
      },
      orderBy: { nickname: "asc" },
    });

    for (const acct of accounts) {
      const balanceCents = Math.round((acct.currentBalance as Prisma.Decimal).toNumber() * 100);
      const minimumCents =
        acct.minimumBalance != null
          ? Math.round((acct.minimumBalance as Prisma.Decimal).toNumber() * 100)
          : null;
      accountSnapshot.push({
        nickname: acct.nickname,
        balanceCents,
        minimumCents,
        marginCents: minimumCents != null ? balanceCents - minimumCents : null,
      });
    }
  }

  // ── Upcoming bills (all entities) ────────────────────────────────────────────
  const bills = await db.scheduledBill.findMany({
    where: { active: true },
    include: { entity: true },
    orderBy: { autopayDay: "asc" },
  });

  const upcomingBills: ReviewData["upcomingBills"] = bills.map((b) => ({
    payee: b.payee,
    amountCents:
      b.expectedAmount != null ? Math.round((b.expectedAmount as Prisma.Decimal).toNumber() * 100) : null,
    autopayDay: b.autopayDay ?? null,
    entityName: b.entity.name,
  }));

  // ── Accrual status ────────────────────────────────────────────────────────────
  const envelopes = await db.accrualEnvelope.findMany({
    orderBy: { name: "asc" },
  });

  const accrualStatus: ReviewData["accrualStatus"] = envelopes.map((env) => {
    const currentCents = Math.round((env.currentBalance as Prisma.Decimal).toNumber() * 100);
    const targetCents = Math.round((env.targetAnnualAmount as Prisma.Decimal).toNumber() * 100);
    // Pro-rata: what balance should be accumulated by this month of the year (the target period's month, not the calendar month at generation time)
    const proRataCents = Math.round((targetCents * month) / 12);
    const pct = proRataCents > 0 ? Math.round((currentCents / proRataCents) * 100) : 100;
    const status: "on_track" | "watch" | "behind" =
      pct >= 90 ? "on_track" : pct >= 60 ? "watch" : "behind";
    return { name: env.name, currentCents, targetCents, proRataCents, pct, status };
  });

  // ── Retrospective forecast accuracy (prior period) ───────────────────────────
  const priorPeriod = previousPeriod(period);
  const priorBudgets = await db.budget.findMany({
    where: { period: priorPeriod },
    include: { tag: true, entity: true },
  });

  let forecastAccuracyPeriod: string | null = null;
  let forecastAccuracy: ReviewData["forecastAccuracy"] = [];

  if (priorBudgets.length > 0) {
    const [priorYear, priorMonth] = priorPeriod.split("-").map(Number) as [number, number];
    const { start: priorStart, end: priorEnd } = monthBounds(priorYear, priorMonth);
    const midpointDate = periodMidpointDate(priorPeriod);
    const midpointExclusive = new Date(midpointDate.getTime() + 24 * 60 * 60 * 1000);
    const priorHistoryStart = new Date(
      Date.UTC(priorYear, priorMonth - 1 - REVIEW_FORECAST_TRAILING_MONTHS, 1)
    );

    const [actualMap, midpointMap, priorHistoryMap] = await Promise.all([
      queryTagSpend(priorStart, priorEnd),
      queryTagSpend(priorStart, midpointExclusive),
      queryTagHistory(priorHistoryStart, priorStart),
    ]);

    const candidates: TaggedForecastAccuracy[] = priorBudgets.map((b) => {
      const key = `${b.entityId}:${b.tagId}`;
      const result = reconstructForecastAccuracy({
        period: priorPeriod,
        spendAtMidpoint: midpointMap.get(key) ?? new Decimal(0),
        actualFinal: actualMap.get(key) ?? new Decimal(0),
        history: priorHistoryMap.get(key) ?? [],
      });
      return { tagName: b.tag.shortName, entityName: b.entity.name, result };
    });

    const notable = selectNotableAccuracyRows(candidates);

    forecastAccuracyPeriod = priorPeriod;
    forecastAccuracy = notable.map(({ tagName, entityName, result }) => ({
      tagName,
      entityName,
      projectedCents: Math.round(result.projected.toNumber() * 100),
      actualCents: Math.round(result.actual.toNumber() * 100),
      missCents: Math.round(result.missAbs.toNumber() * 100),
      percentOff: result.percentOff,
      direction: result.direction,
      confidence: result.confidence,
    }));
  }

  return {
    period,
    generatedAt: new Date().toISOString(),
    budgetHealth,
    accountSnapshot,
    upcomingBills,
    accrualStatus,
    forecastAccuracyPeriod,
    forecastAccuracy,
  };
}
