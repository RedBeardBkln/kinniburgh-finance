// Budget reads for the assistant. DB-aware, explicit select only. The budgeted amounts are resolved exactly as lib/advisor-context.ts does
// (nested lines auto-sum within an account, root lines only for totals), and spend per (entity, tag) comes from queries/spend.ts.
// This can differ from the Budgets page for lines linked to recurring expenses (a pre-existing, separate adjustment on that page).

import { Decimal } from "@prisma/client/runtime/library";
import { db } from "@/lib/db";
import { getRootBudgetLineIds, resolveBudgetedAmounts } from "@/lib/budget-nesting";
import { loadTagSpendForPeriod } from "@/lib/advisor/queries/spend";

export interface BudgetLineFacts {
  tagPath: string;
  shortName: string;
  entity: string;
  frequency: string;
  /** Resolved MONTHLY budget, decimal string. */
  budgeted: string;
  autoSummed: boolean;
  rolloverEnabled: boolean;
  /** Rollover carried in (signed), decimal string. */
  rolloverAmount: string;
  /** Net spend in the period as a positive magnitude for outflows (decimal string; negative when refunds exceed spend). */
  spent: string;
  isRoot: boolean;
}

export async function loadBudgetFacts(period: string, bounds: { start: Date; end: Date }, entity: string | null): Promise<BudgetLineFacts[]> {
  const [budgets, spendRows] = await Promise.all([
    db.budget.findMany({
      where: {
        period,
        ...(entity !== null
          ? { entity: { OR: [{ name: { equals: entity, mode: "insensitive" as const } }, { slug: { equals: entity, mode: "insensitive" as const } }] } }
          : {}),
      },
      orderBy: [{ entity: { name: "asc" } }, { tag: { name: "asc" } }],
      take: 400,
      select: {
        id: true,
        tagId: true,
        accountId: true,
        budgeted: true,
        frequency: true,
        rolloverEnabled: true,
        rolloverAmount: true,
        tag: { select: { name: true, shortName: true, parentId: true } },
        entity: { select: { id: true, name: true } },
      },
    }),
    loadTagSpendForPeriod(bounds.start, bounds.end),
  ]);

  const tagParentById = new Map(budgets.map((b) => [b.tagId, b.tag.parentId]));
  const byAccount = new Map<string, typeof budgets>();
  for (const b of budgets) {
    const g = byAccount.get(b.accountId) ?? [];
    g.push(b);
    byAccount.set(b.accountId, g);
  }
  const resolved = new Map<string, Decimal>();
  const roots = new Set<string>();
  for (const group of byAccount.values()) {
    const input = group.map((b) => ({ id: b.id, tagId: b.tagId, budgeted: b.budgeted }));
    for (const [id, amt] of resolveBudgetedAmounts(input, (t) => tagParentById.get(t), new Decimal(0))) resolved.set(id, amt);
    for (const id of getRootBudgetLineIds(group, (t) => tagParentById.get(t))) roots.add(id);
  }
  const spendByKey = new Map(spendRows.map((r) => [`${r.entityId}:${r.tagId}`, new Decimal(r.total)]));

  return budgets.map((b) => ({
    tagPath: b.tag.name,
    shortName: b.tag.shortName,
    entity: b.entity.name,
    frequency: b.frequency,
    budgeted: (resolved.get(b.id) ?? new Decimal(0)).toFixed(2),
    autoSummed: b.budgeted === null,
    rolloverEnabled: b.rolloverEnabled,
    rolloverAmount: (b.rolloverAmount ?? new Decimal(0)).toFixed(2),
    spent: (spendByKey.get(`${b.entity.id}:${b.tagId}`) ?? new Decimal(0)).negated().toFixed(2),
    isRoot: roots.has(b.id),
  }));
}
