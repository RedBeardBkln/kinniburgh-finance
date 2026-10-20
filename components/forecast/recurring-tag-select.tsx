"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moveRecurringExpenseToTag } from "@/actions/recurring-expenses";

type Tag = { id: string; name: string };

interface Props {
  expenseId: string;
  expenseName: string;
  currentTagId: string | null;
  tags: Tag[];
  className?: string;
}

/** Inline budget-line picker for one recurring expense (Forecast table, Budgets expansion). */
export function RecurringTagSelect({ expenseId, expenseName, currentTagId, tags, className }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(next: string) {
    const nextTagId = next === "" ? null : next;
    if (nextTagId === currentTagId) return;
    const target = nextTagId ? tags.find((t) => t.id === nextTagId)?.name ?? "the selected line" : "no budget line";
    // A linked recurring expense replaces the line's budgeted figure (see /budgets), so moving it changes both lines.
    if (
      !confirm(
        `Move "${expenseName}" to ${target}?\n\nLinked recurring expenses set a budget line's amount, so the old and the new line's budgeted figures will both change.`
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await moveRecurringExpenseToTag({ id: expenseId, tagId: nextTagId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className={className}>
      <select
        aria-label={`Budget line for ${expenseName}`}
        value={currentTagId ?? ""}
        disabled={pending}
        onChange={(e) => handleChange(e.target.value)}
        className="w-full max-w-[14rem] rounded border bg-background px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
      >
        <option value="">— None —</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
