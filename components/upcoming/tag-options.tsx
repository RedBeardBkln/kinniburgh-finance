"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AddTagOption } from "@/lib/recurring-add-step";
import type { TagBudgetFacts } from "@/lib/recurring-budget-hint";

// What the inline "Add as recurring expense" step needs once for the whole review list (a context, not a prop of every
// row: it is the same for every suggestion and can be a few hundred entries): the budget categories, and the plain
// numbers behind the pre-confirm Budgets notice.

interface AddStepData {
  tags: readonly AddTagOption[];
  /**
   * Facts per `entityId|tagId` (only categories with a budget row or a scheduled bill).
   * undefined = not provided; null = the read failed (the step then shows a generic line and still lets the owner add).
   */
  budgetFacts: Record<string, TagBudgetFacts> | null | undefined;
}

const AddStepContext = createContext<AddStepData>({ tags: [], budgetFacts: undefined });

export function TagOptionsProvider({
  tags,
  budgetFacts,
  children,
}: {
  tags: readonly AddTagOption[];
  budgetFacts?: Record<string, TagBudgetFacts> | null;
  children: ReactNode;
}) {
  return <AddStepContext.Provider value={{ tags, budgetFacts }}>{children}</AddStepContext.Provider>;
}

export function useTagOptions(): readonly AddTagOption[] {
  return useContext(AddStepContext).tags;
}

export function useBudgetFacts(): Record<string, TagBudgetFacts> | null | undefined {
  return useContext(AddStepContext).budgetFacts;
}
