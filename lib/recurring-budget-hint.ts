// Pre-confirm notice for the inline "Add as recurring expense" step. /budgets shows, for a category that has a Budget
// row, (sum of the monthly equivalents of its linked recurring expenses + the row's additional amount) INSTEAD OF the
// stored budgeted amount (app/budgets/page.tsx). So linking a suggestion to a category that has a budget changes the
// figure shown there. This file turns plain numbers into the sentence the owner reads BEFORE confirming.
//
// PURE and client-safe: no DB, no clock. The loader that reads the numbers is lib/recurring-budget-hint-build.ts
// (read-only). Money here is integer cents; the only arithmetic is the same monthlyEquivalentCents the Budgets page uses.

import { monthlyEquivalentCents } from "@/lib/recurring-expenses";

/** What is known about one category (tag) of one entity for the current budget period. */
export interface TagBudgetFacts {
  /** A Budget row exists for this entity + tag in the current period. */
  hasBudget: boolean;
  /** The stored budgeted amount in cents, or null when the row has none (a parent that auto-sums its children). */
  budgetedCents: number | null;
  /** The row's "additional amount" in cents (added to the linked recurring expenses on /budgets). */
  additionalCents: number;
  /** Sum of the monthly equivalents (cents) of the recurring expenses already linked to this tag in this entity. */
  linkedMonthlyCents: number;
  /** How many recurring expenses are already linked. */
  linkedCount: number;
  /** An active scheduled bill is tied to this category. */
  hasBill: boolean;
}

export const BUDGET_NOTICE_GENERIC = "Linking can change the Budgets figure for that category.";

export function budgetFactsKey(entityId: string, tagId: string): string {
  return `${entityId}|${tagId}`;
}

/** 2870 -> "~$28.70"; 123456 -> "~$1,234.56". */
export function approxCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `~${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** Monthly equivalent of the suggestion being added, exactly as /budgets would count the row once it exists. */
export function thisMonthlyCents(amountCents: number, frequency: string): number {
  return monthlyEquivalentCents(amountCents, frequency);
}

/**
 * The notice for the selected category, or null when there is nothing to say (the category has no budget row and no
 * scheduled bill). Observational: it states what Budgets will show, never what to do.
 */
export function budgetNotice(facts: TagBudgetFacts | undefined, thisCents: number): string | null {
  if (!facts || (!facts.hasBudget && !facts.hasBill)) return null;
  const parts: string[] = [];
  if (facts.hasBudget) {
    const total = thisCents + facts.linkedMonthlyCents + facts.additionalCents;
    const had =
      facts.budgetedCents === null
        ? "This category has a budget line with no amount of its own."
        : `This category has a ${approxCents(facts.budgetedCents)}/month budget.`;
    const linked = facts.linkedCount > 0 ? ` + ${facts.linkedCount} already linked ${approxCents(facts.linkedMonthlyCents)}` : "";
    parts.push(
      `${had} Linking recurring expenses to a category replaces the budget shown on Budgets with their monthly total ` +
        `(this one ${approxCents(thisCents)}${linked} + your additional amount ${approxCents(facts.additionalCents)} = ${approxCents(total)}). ` +
        "You can change it on Budgets afterwards."
    );
  }
  if (facts.hasBill) {
    parts.push(
      "A scheduled bill is tied to this category, so the upcoming list keeps counting the bill and shows this expense as a second record of it."
    );
  }
  return parts.join(" ");
}

/**
 * What the step shows for the currently selected category. "No tag" = nothing. facts === null (the read failed) = the
 * generic line. A category without a budget row / bill = nothing. Facts but no usable amount = the generic line.
 */
export function selectedTagNotice(
  facts: Record<string, TagBudgetFacts> | null | undefined,
  entityId: string,
  tagId: string,
  amountCents: number | undefined,
  frequency: string | undefined
): string | null {
  if (tagId === "") return null;
  if (facts === null) return BUDGET_NOTICE_GENERIC;
  const f = facts?.[budgetFactsKey(entityId, tagId)];
  if (!f) return null;
  if (amountCents === undefined || !frequency) return BUDGET_NOTICE_GENERIC;
  return budgetNotice(f, thisMonthlyCents(amountCents, frequency));
}

export interface BudgetRowInput {
  entityId: string;
  tagId: string;
  budgetedCents: number | null;
  additionalCents: number;
}
export interface BillRowInput {
  entityId: string;
  budgetEntityId: string | null;
  budgetTagId: string;
}
export interface RecurringRowInput {
  entityId: string;
  tagId: string;
  amountCents: number;
  frequency: string;
}

/** Folds the three read-only row sets into one facts record per `entityId|tagId` that has a budget row or a bill. */
export function buildBudgetFacts(input: {
  budgets: BudgetRowInput[];
  bills: BillRowInput[];
  recurring: RecurringRowInput[];
}): Record<string, TagBudgetFacts> {
  const out: Record<string, TagBudgetFacts> = {};
  const get = (key: string): TagBudgetFacts =>
    (out[key] ??= { hasBudget: false, budgetedCents: null, additionalCents: 0, linkedMonthlyCents: 0, linkedCount: 0, hasBill: false });

  for (const b of input.budgets) {
    const f = get(budgetFactsKey(b.entityId, b.tagId));
    f.hasBudget = true;
    f.budgetedCents = b.budgetedCents;
    f.additionalCents = b.additionalCents;
  }
  for (const b of input.bills) get(budgetFactsKey(b.budgetEntityId ?? b.entityId, b.budgetTagId)).hasBill = true;
  for (const r of input.recurring) {
    const f = out[budgetFactsKey(r.entityId, r.tagId)];
    if (!f) continue; // a category with neither a budget row nor a bill needs no notice
    f.linkedMonthlyCents += monthlyEquivalentCents(r.amountCents, r.frequency);
    f.linkedCount += 1;
  }
  return out;
}
