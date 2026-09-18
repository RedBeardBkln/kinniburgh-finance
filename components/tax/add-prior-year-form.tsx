"use client";

import { useState, useTransition } from "react";
import { ensureTaxWorkspace } from "@/actions/tax";
import { isValidPriorYear, MIN_TAX_YEAR } from "@/lib/tax-year-range";

interface AddPriorYearFormProps {
  entities: Array<{ id: string; name: string }>;
}

const currentYear = new Date().getUTCFullYear();

export function AddPriorYearForm({ entities }: AddPriorYearFormProps) {
  const [open, setOpen] = useState(false);
  const [entityId, setEntityId] = useState(entities[0]?.id ?? "");
  const [year, setYear] = useState(String(currentYear - 1));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setYear(String(currentYear - 1));
    setError(null);
    setOpen(false);
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const yearNum = Number(year);
    if (!isValidPriorYear(yearNum, currentYear)) {
      setError(`Enter a year between ${MIN_TAX_YEAR} and ${currentYear + 1}.`);
      return;
    }
    if (!entityId) {
      setError("Select an entity.");
      return;
    }

    const formData = new FormData();
    formData.set("entityId", entityId);
    formData.set("taxYear", String(yearNum));

    startTransition(async () => {
      await ensureTaxWorkspace(formData);
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-sm text-primary hover:underline"
      >
        + Add a tax year
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border p-4 bg-muted/30">
      <p className="text-sm font-medium">Open a tax year</p>
      <p className="text-xs text-muted-foreground">
        For a year that doesn&apos;t appear above yet (including next year, to get a head start) —
        creates the workspace and opens it.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Entity</label>
          <select
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            required
            disabled={isPending}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          >
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name.split(",")[0]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Tax year</label>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            min={MIN_TAX_YEAR}
            max={currentYear + 1}
            required
            disabled={isPending}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending || !entityId || !year}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isPending ? "Opening…" : "Open workspace"}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={isPending}
          className="rounded-md border px-4 py-2 text-sm hover:bg-accent disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
