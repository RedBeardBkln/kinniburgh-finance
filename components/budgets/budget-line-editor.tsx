"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { updateBudgetLine } from "@/actions/budgets";
import { formatUSD } from "@/lib/utils";

interface BudgetLineEditorProps {
  budgetId: string;
  currentBudgeted: number; // resolved/effective dollars as number, for display
  /** The raw stored value — null when this line is blank/auto-summed from
   * its nested children. Used to prefill edit mode so an unmodified Save
   * round-trips as blank instead of freezing the resolved number in. */
  rawBudgeted: number | null;
}

export function BudgetLineEditor({ budgetId, currentBudgeted, rawBudgeted }: BudgetLineEditorProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(rawBudgeted !== null ? rawBudgeted.toFixed(2) : "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  function startEditing() {
    setValue(rawBudgeted !== null ? rawBudgeted.toFixed(2) : "");
    setError(null);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function cancel() {
    setEditing(false);
    setError(null);
  }

  function save() {
    startTransition(async () => {
      const result = await updateBudgetLine(budgetId, value);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setEditing(false);
      setError(null);
      router.refresh();
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  }

  if (!editing) {
    if (rawBudgeted === null) {
      return (
        <button
          onClick={startEditing}
          className="tabular-nums italic text-muted-foreground hover:underline hover:text-primary cursor-pointer"
          title="Auto-calculated from nested budget lines — click to override"
        >
          Auto · {formatUSD(currentBudgeted)}
        </button>
      );
    }
    return (
      <button
        onClick={startEditing}
        className="tabular-nums hover:underline hover:text-primary cursor-pointer"
        title="Click to edit"
      >
        {formatUSD(currentBudgeted)}
      </button>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="inline-flex items-center gap-1">
        <span className="text-muted-foreground text-xs">$</span>
        <input
          ref={inputRef}
          type="number"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isPending}
          className="w-24 rounded border px-1.5 py-0.5 text-right text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        />
        <button
          onClick={save}
          disabled={isPending}
          className="text-xs text-primary hover:underline disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={cancel}
          disabled={isPending}
          className="text-xs text-muted-foreground hover:underline disabled:opacity-50"
        >
          Cancel
        </button>
      </span>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
