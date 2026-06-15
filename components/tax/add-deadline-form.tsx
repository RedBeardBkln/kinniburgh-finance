"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTaxDeadline } from "@/actions/tax-deadlines";

interface AddDeadlineFormProps {
  entities: Array<{ id: string; name: string }>;
}

export function AddDeadlineForm({ entities }: AddDeadlineFormProps) {
  const [open, setOpen] = useState(false);
  const [entityId, setEntityId] = useState(entities[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [type, setType] = useState<"quarterly_est" | "annual" | "extension" | "other">("quarterly_est");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function reset() {
    setLabel("");
    setDueDate("");
    setType("quarterly_est");
    setNotes("");
    setError(null);
    setOpen(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createTaxDeadline({ entityId, label, dueDate, type, notes: notes || undefined });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      reset();
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-sm text-primary hover:underline"
      >
        + Add deadline
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border p-4 bg-muted/30">
      <p className="text-sm font-medium">New Tax Deadline</p>

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
          <label className="text-xs font-medium text-muted-foreground">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
            disabled={isPending}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          >
            <option value="quarterly_est">Quarterly Estimate</option>
            <option value="annual">Annual Filing</option>
            <option value="extension">Extension</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Label</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="2026 Q3 estimated tax"
          required
          disabled={isPending}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Due Date</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            required
            disabled={isPending}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Notes (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={isPending}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending || !label || !dueDate}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Add"}
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
