// Budget reads for the assistant. DB-aware, explicit select only (through the effective-budget loader). The budgeted amounts are resolved exactly as lib/advisor-context.ts does
// (nested lines auto-sum within an account, root lines only for totals), and spend per (entity, tag) comes from queries/spend.ts.
// This can differ from the Budgets page for lines linked to recurring expenses (a pre-existing, separate adjustment on that page).
// A month with no row for a line shows the latest earlier row of that line (lib/budget-carry-forward.ts, read-time only), marked `carriedFrom`.

import { Decimal } from "@prisma/client/runtime/library";
import { loadEffectiveBudgetRows } from "@/lib/budget-carry-forward-build";
import { monthOfPeriod, periodOfDate, planAmountForMonth, planForLine } from "@/lib/seasonal-energy";
import { loadSeasonalPlansSafe } from "@/lib/seasonal-energy-build";
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
  /** The period the figures were carried forward from when the month has no row of its own; null otherwise. */
  carriedFrom?: string | null;
  /**
   * The seasonal model's estimate for this line and calendar month, only for the current or a later month and only once
   * its gate has passed (lib/seasonal-energy.ts). It sits BESIDE the budget figure and does not replace it here.
   */
  seasonalEstimate?: { amount: string; confidence: string; basis: string };
}

function entityMatches(e: { name: string; slug: string | null }, wanted: string): boolean {
  const w = wanted.toLowerCase();
  return e.name.toLowerCase() === w || (e.slug !== null && e.slug.toLowerCase() === w);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function loadBudgetFacts(period: string, bounds: { start: Date; end: Date }, entity: string | null): Promise<BudgetLineFacts[]> {
  const [effective, spendRows, seasonal] = await Promise.all([
    loadEffectiveBudgetRows({ periods: [period] }),
    loadTagSpendForPeriod(bounds.start, bounds.end),
    loadSeasonalPlansSafe({ now: new Date() }),
  ]);
  const showSeasonal = period >= periodOfDate(new Date());
  const monthIdx = monthOfPeriod(period) - 1;
  const budgets = effective
    .filter((b) => entity === null || entityMatches(b.entity, entity))
    .sort((a, b) => byText(a.entity.name, b.entity.name) || byText(a.tag.name, b.tag.name))
    .slice(0, 400);

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

  return budgets.map((b) => {
    const plan = showSeasonal ? planForLine(seasonal.plans, b.entity.id, b.tagId) : null;
    const planAmount = plan ? planAmountForMonth(plan, monthIdx + 1) : null;
    return {
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
      carriedFrom: b.carriedFrom,
      ...(plan && planAmount ? { seasonalEstimate: { amount: planAmount.toFixed(2), confidence: plan.confidence, basis: plan.shortBasis } } : {}),
    };
  });
}
