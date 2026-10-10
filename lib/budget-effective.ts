// The one place that turns a month's Budget rows into the amounts the screens show: the recurring-expense override,
// then the per-account parent/child auto-sum, then the roots-only total rule. The Budgets page and the dashboard both
// call this, so "Total Budgeted" cannot drift between them again (the dashboard used to skip the recurring override).
//
// Pure: no database, no clock. It never reads or writes the Budget table itself; callers pass the rows they already
// loaded. SERVER-ONLY: it imports Decimal as a value, so a "use client" component must not import it (see
// lib/budget-nesting.ts for why that matters).
import { Decimal } from "@prisma/client/runtime/library";
import { resolveBudgetedAmounts, getRootBudgetLineIds } from "@/lib/budget-nesting";
import { monthlyEquivalentCents } from "@/lib/recurring-expenses";

export interface EffectiveBudgetInput {
  id: string;
  tagId: string;
  accountId: string;
  /** The stored amount; null means "add up my nested children". */
  budgeted: Decimal | null;
  /** The stored "additional buffer" for a line that carries recurring expenses (cents; may be absent). */
  additionalAmountCents?: Decimal | null;
}

export interface RecurringForBudget {
  tagId: string | null;
  amountCents: number;
  frequency: string;
}

export interface EffectiveBudgets {
  /** Per line: the amount the line states itself (recurring-linked, or the stored value); null = auto-sum. */
  explicitById: Map<string, Decimal | null>;
  /** Per line: the amount that counts (explicit, or the sum of its nested children). */
  resolvedById: Map<string, Decimal>;
  /** Lines that are NOT nested under another line of the same account: sum only these for a total. */
  rootIds: Set<string>;
  /** Lines that have at least one nested child line (same account). */
  parentIds: Set<string>;
  /** Lines whose amount comes from linked recurring expenses rather than the stored value. */
  recurringLinkedIds: Set<string>;
  /** Sum of the resolved amounts of the root lines. */
  totalBudgeted: Decimal;
}

/** Precedence per line: recurring-linked amount, then the stored amount, then the auto-sum of the nested children. */
export function resolveEffectiveBudgets(
  lines: EffectiveBudgetInput[],
  recurring: RecurringForBudget[],
  tagParentId: (tagId: string) => string | null | undefined
): EffectiveBudgets {
  const zero = new Decimal(0);

  const recurringCentsByTag = new Map<string, number>();
  for (const exp of recurring) {
    if (!exp.tagId) continue;
    recurringCentsByTag.set(exp.tagId, (recurringCentsByTag.get(exp.tagId) ?? 0) + monthlyEquivalentCents(exp.amountCents, exp.frequency));
  }

  const explicitById = new Map<string, Decimal | null>();
  const recurringLinkedIds = new Set<string>();
  for (const line of lines) {
    const recurringCents = recurringCentsByTag.get(line.tagId);
    if (recurringCents !== undefined) {
      const additional = new Decimal(line.additionalAmountCents ?? 0);
      explicitById.set(line.id, additional.plus(recurringCents).div(100));
      recurringLinkedIds.add(line.id);
    } else {
      explicitById.set(line.id, line.budgeted);
    }
  }

  const byAccount = new Map<string, EffectiveBudgetInput[]>();
  for (const line of lines) {
    const group = byAccount.get(line.accountId);
    if (group) group.push(line);
    else byAccount.set(line.accountId, [line]);
  }

  const resolvedById = new Map<string, Decimal>();
  const rootIds = new Set<string>();
  for (const group of byAccount.values()) {
    const resolverInput = group.map((l) => ({ id: l.id, tagId: l.tagId, budgeted: explicitById.get(l.id) ?? null }));
    for (const [id, amount] of resolveBudgetedAmounts(resolverInput, tagParentId, zero)) resolvedById.set(id, amount);
    for (const id of getRootBudgetLineIds(group, tagParentId)) rootIds.add(id);
  }

  // A line is a parent when some other line of the same account sits directly under its tag.
  const parentIds = new Set<string>();
  for (const group of byAccount.values()) {
    const tagToLine = new Map(group.map((l) => [l.tagId, l.id]));
    for (const line of group) {
      const parentTag = tagParentId(line.tagId) ?? null;
      const parentLine = parentTag ? tagToLine.get(parentTag) : undefined;
      if (parentLine && parentLine !== line.id) parentIds.add(parentLine);
    }
  }

  let totalBudgeted = zero;
  for (const line of lines) {
    if (rootIds.has(line.id)) totalBudgeted = totalBudgeted.plus(resolvedById.get(line.id) ?? zero);
  }

  return { explicitById, resolvedById, rootIds, parentIds, recurringLinkedIds, totalBudgeted };
}
