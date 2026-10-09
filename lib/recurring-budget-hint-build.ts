// DB-aware, READ-ONLY loader for the pre-confirm notice of the inline Add step (lib/recurring-budget-hint.ts).
// No writes, no auth: like lib/upcoming-ledger-build.ts the CALLER (the Forecast page, which has already run auth())
// owns access control. Three explicit-select reads (the Budget one through lib/budget-carry-forward-build.ts), plain numbers out: no account number, name or note is read.
// Fail-soft: any error returns null (the step then shows a generic line and still lets the owner add).

import { Decimal } from "@prisma/client/runtime/library";
import { db } from "@/lib/db";
import { loadEffectiveBudgetRows } from "@/lib/budget-carry-forward-build";
import { buildBudgetFacts, type TagBudgetFacts } from "@/lib/recurring-budget-hint";

/** YYYY-MM the Budgets page opens on (it uses the UTC month of "now"). */
export function currentBudgetPeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function toCents(v: { toString(): string } | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const d = new Decimal(v.toString());
  return d.isNaN() ? null : d.toDecimalPlaces(0).toNumber();
}

/** Facts per `entityId|tagId` (only categories with a budget row or a scheduled bill), or null when the reads failed. */
export async function loadBudgetHints(args: {
  /** null = every entity (the all-entities views). */
  entityId: string | null;
  now: Date;
}): Promise<Record<string, TagBudgetFacts> | null> {
  const { entityId, now } = args;
  const entityWhere = entityId ? { entityId } : {};
  try {
    const [budgets, bills, recurring] = await Promise.all([
      // Effective rows (read-time carry-forward): a month with no row for a category uses the latest earlier row.
      loadEffectiveBudgetRows({ periods: [currentBudgetPeriod(now)], entityId }),
      db.scheduledBill.findMany({
        where: { active: true, budgetTagId: { not: null }, ...entityWhere },
        select: { entityId: true, budgetEntityId: true, budgetTagId: true },
      }),
      db.recurringExpense.findMany({
        where: { tagId: { not: null }, ...entityWhere },
        select: { entityId: true, tagId: true, amountCents: true, frequency: true },
      }),
    ]);
    return buildBudgetFacts({
      budgets: budgets.map((b) => ({
        entityId: b.entityId,
        tagId: b.tagId,
        budgetedCents: toCents(b.budgeted === null ? null : b.budgeted.times(100)),
        // Stored as a number of CENTS despite the Decimal column (app/budgets/page.tsx adds it to a cents sum).
        additionalCents: toCents(b.additionalAmountCents) ?? 0,
      })),
      bills: bills.flatMap((b) => (b.budgetTagId ? [{ entityId: b.entityId, budgetEntityId: b.budgetEntityId, budgetTagId: b.budgetTagId }] : [])),
      recurring: recurring.flatMap((r) => (r.tagId ? [{ entityId: r.entityId, tagId: r.tagId, amountCents: r.amountCents, frequency: r.frequency }] : [])),
    });
  } catch (err) {
    console.error("Budget hints unavailable", err instanceof Error ? err.name : "UnknownError");
    return null;
  }
}
