"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMileageEntry } from "@/actions/mileage";

interface AddMileageEntryFormProps {
  entityId: string;
}

export function AddMileageEntryForm({ entityId }: AddMileageEntryFormProps) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [miles, setMiles] = useState("");
  const [purpose, setPurpose] = useState("");
  const [billable, setBillable] = useState(false);
  const [rate, setRate] = useState("0.700");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function reset() {
    setDate(today);
    setMiles("");
    setPurpose("");
    setBillable(false);
    setRate("0.700");
    setNotes("");
    setError(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createMileageEntry({
        entityId,
        date,
        miles: Number(miles),
        purpose,
        billable,
        ratePerMile: Number(rate),
        notes: notes || undefined,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      reset();
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            disabled={isPending}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Miles (whole number)</label>
          <input
            type="number"
            min="1"
            step="1"
            value={miles}
            onChange={(e) => setMiles(e.target.value)}
            placeholder="24"
            required
            disabled={isPending}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Purpose</label>
        <input
          type="text"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="Client meeting — Hartford"
          required
          disabled={isPending}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">IRS rate ($/mi)</label>
          <input
            type="number"
            step="0.001"
            min="0"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            disabled={isPending}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
        </div>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
              disabled={isPending}
              className="h-4 w-4 rounded border-input"
            />
            Billable to client
          </label>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Notes (optional)</label>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Round trip"
          disabled={isPending}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <button
        type="submit"
        disabled={isPending || !miles || !purpose}
        className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {isPending ? "Adding…" : "Add Entry"}
      </button>
    </form>
  );
}
