// DB-aware, READ-ONLY inputs for the printable Personal reports (/personal/reports/weekly and /monthly). It builds the
// SAME DrillData payload as the dashboard (the effective budget lines through the shared carry-forward loader, the
// month's transactions, the one spend model in lib/month-spend.ts), so every number on a printed report agrees with
// the dashboard and /budgets for the same entity and month. No auth here (the pages run auth() first), no writes,
// nothing logged but an error name. A failed read returns { drill: null } and the page says the numbers are unavailable.
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveEffectiveBudgets } from "@/lib/budget-effective";
import { loadEffectiveBudgetRows } from "@/lib/budget-carry-forward-build";
import { buildMonthSpend, type SpendLineInput } from "@/lib/month-spend";
import { loadMonthTransactions } from "@/lib/month-spend-build";
import { loadOwnAccountByMask } from "@/lib/own-account-masks-build";
import { buildDrillData } from "@/lib/dashboard-drill-build";
import { buildOverview, elapsedFractionNY, type Overview } from "@/lib/dashboard-overview";
import { loadKindOverrides, loadLineHistory } from "@/lib/dashboard-overview-build";
import type { DrillData } from "@/lib/dashboard-drill";

export interface LoadedMonthReport {
  drill: DrillData | null;
  /** Fixed / variable split and the lines worth a look; null when it could not be built. */
  overview: Overview | null;
}

async function soft<T>(label: string, read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    console.error(`Report ${label} unavailable`, err instanceof Error ? err.name : "UnknownError");
    return null;
  }
}

export async function loadMonthReport(opts: {
  entityId: string;
  bucket: string;
  period: string;
  periodLabel: string;
  isCurrentPeriod: boolean;
  now: Date;
  /** Build the fixed / variable overview too (reads the 6 months before; the weekly report needs it). */
  withOverview: boolean;
}): Promise<LoadedMonthReport> {
  const { entityId, period } = opts;
  const [budgetRows, tagRows, accounts, recurringRows, monthTxs, ownAccountByMask] = await Promise.all([
    soft(
      "budget lines",
      loadEffectiveBudgetRows({ periods: [period], entityId }).then((rows) =>
        rows.sort((a, b) => a.account.nickname.localeCompare(b.account.nickname) || a.tag.name.localeCompare(b.tag.name))
      )
    ),
    soft("tags", db.tag.findMany({ select: { id: true, name: true, shortName: true, parentId: true }, orderBy: { name: "asc" } })),
    soft(
      "accounts",
      db.account.findMany({
        where: { entityId, archivedAt: null },
        select: {
          id: true,
          nickname: true,
          accountType: true,
          currentBalance: true,
          currentBalanceAt: true,
          institution: { select: { name: true } },
          entity: { select: { name: true } },
        },
        orderBy: { nickname: "asc" },
      })
    ),
    soft("recurring expenses", db.recurringExpense.findMany({ where: { entityId }, select: { tagId: true, amountCents: true, frequency: true } })),
    soft("month transactions", loadMonthTransactions({ entityId, period })),
    soft("own account masks", loadOwnAccountByMask()),
  ]);
  if (!budgetRows || !tagRows || !recurringRows || !monthTxs || !ownAccountByMask) return { drill: null, overview: null };

  let drill: DrillData;
  let lineInputs: SpendLineInput[];
  try {
    const tagParent = new Map(tagRows.map((t) => [t.id, t.parentId]));
    const effective = resolveEffectiveBudgets(
      budgetRows.map((b) => ({ id: b.id, tagId: b.tagId, accountId: b.accountId, budgeted: b.budgeted, additionalAmountCents: b.additionalAmountCents })),
      recurringRows,
      (tagId) => tagParent.get(tagId)
    );
    const zero = new Prisma.Decimal(0);
    lineInputs = budgetRows.map((b) => ({
      id: b.id,
      tagId: b.tagId,
      accountId: b.accountId,
      resolved: effective.resolvedById.get(b.id) ?? zero,
      explicit: effective.explicitById.get(b.id) ?? null,
      rollover: new Prisma.Decimal(b.rolloverAmount ?? 0),
    }));
    const model = buildMonthSpend(monthTxs, tagRows, lineInputs, { ownAccountByMask });
    drill = buildDrillData({
      model,
      txs: monthTxs,
      tags: tagRows,
      budgets: budgetRows.map((b) => ({
        id: b.id,
        entityId: b.entityId,
        carriedFrom: b.carriedFrom,
        tagId: b.tagId,
        accountId: b.accountId,
        accountName: b.account.nickname,
        entityName: b.account.entity.name,
        rawBudgeted: b.budgeted,
        rollover: new Prisma.Decimal(b.rolloverAmount ?? 0),
      })),
      effective,
      accounts: (accounts ?? []).map((a) => ({
        id: a.id,
        nickname: a.nickname,
        institutionName: a.institution.name,
        entityName: a.entity.name,
        accountType: a.accountType,
        currentBalance: a.currentBalance,
        currentBalanceAt: a.currentBalanceAt,
      })),
      transfers: [],
      period,
      periodLabel: opts.periodLabel,
      isCurrentPeriod: opts.isCurrentPeriod,
      bucket: opts.bucket,
      isAllEntities: false,
      periodQuery: opts.isCurrentPeriod ? "" : `&period=${period}`,
      ownAccountByMask,
    });
  } catch (err) {
    console.error("Report month numbers unavailable", err instanceof Error ? err.name : "UnknownError");
    return { drill: null, overview: null };
  }

  if (!opts.withOverview) return { drill, overview: null };
  let overview: Overview | null = null;
  try {
    const [history, kindOverrides] = await Promise.all([
      soft("recent months", loadLineHistory({ entityId, period, tags: tagRows, lines: lineInputs, ownAccountByMask })),
      soft("expense kind choices", loadKindOverrides()),
    ]);
    overview = buildOverview({
      data: drill,
      history,
      overrides: kindOverrides ?? {},
      elapsed: opts.isCurrentPeriod ? elapsedFractionNY(opts.now) : null,
    });
  } catch (err) {
    console.error("Report overview unavailable", err instanceof Error ? err.name : "UnknownError");
  }
  return { drill, overview };
}
