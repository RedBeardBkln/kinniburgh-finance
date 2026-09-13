"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setEntityTaxReservePct } from "@/actions/business-forecast";

interface Props {
  entityId: string;
  pct: number;
  isDefault: boolean;
}

export function TaxReservePctForm({ entityId, pct, isDefault }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(pct));
  const [error, setError] = useState<string | null>(null);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      setError("Enter a percentage between 0 and 100");
      return;
    }
    startTransition(async () => {
      const result = await setEntityTaxReservePct({ entityId, pct: parsed });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm">
          {pct}%{isDefault ? " (default)" : ""}
        </span>
        <button
          type="button"
          onClick={() => {
            setValue(String(pct));
            setEditing(true);
          }}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="flex items-center gap-2">
      <input
        type="number"
        min={0}
        max={100}
        step="0.1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={isPending}
        className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
      />
      <span className="text-sm text-muted-foreground">%</span>
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-primary text-primary-foreground px-2.5 py-1 text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        onClick={() => {
          setEditing(false);
          setError(null);
        }}
        disabled={isPending}
        className="rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        Cancel
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
