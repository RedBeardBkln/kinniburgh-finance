"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createAccrualDraw,
  updateAccrualDraw,
  deleteAccrualDraw,
} from "@/actions/envelope";

interface DrawRow {
  id: string;
  estimatedDateIso: string; // "YYYY-MM-DD"
  estimatedAmount: string; // decimal string
  notes: string | null;
}

interface Props {
  envelopeId: string;
  draws: DrawRow[];
}

function fmtUSD(amount: string): string {
  const n = parseFloat(amount);
  if (isNaN(n)) return amount;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function AccrualDrawsList({ envelopeId, draws }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const sorted = [...draws].sort((a, b) =>
    a.estimatedDateIso < b.estimatedDateIso ? -1 : a.estimatedDateIso > b.estimatedDateIso ? 1 : 0
  );

  async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formEl = e.currentTarget;
    const formData = new FormData(formEl);

    const amountStr = formData.get("estimatedAmount") as string;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      setError("Enter a positive amount.");
      return;
    }

    setSaving(true);
    try {
      await createAccrualDraw({
        accrualEnvelopeId: envelopeId,
        estimatedDate: formData.get("estimatedDate") as string,
        estimatedAmount: amount.toFixed(2),
        notes: (formData.get("notes") as string) || undefined,
      });
      formEl.reset();
      startTransition(() => router.refresh());
    } catch {
      setError("Could not add draw. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(e: React.FormEvent<HTMLFormElement>, id: string) {
    e.preventDefault();
    setError(null);
    const formEl = e.currentTarget;
    const formData = new FormData(formEl);

    const amountStr = formData.get("estimatedAmount") as string;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      setError("Enter a positive amount.");
      return;
    }

    setSaving(true);
    try {
      await updateAccrualDraw({
        id,
        estimatedDate: formData.get("estimatedDate") as string,
        estimatedAmount: amount.toFixed(2),
        notes: (formData.get("notes") as string) || undefined,
      });
      setEditingId(null);
      startTransition(() => router.refresh());
    } catch {
      setError("Could not save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this estimated draw?")) return;
    setError(null);
    try {
      await deleteAccrualDraw(id);
      startTransition(() => router.refresh());
    } catch {
      setError("Could not delete draw. Please try again.");
    }
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs font-medium">Estimated draws</p>

      {sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No estimated draws yet — add one below so the forecast can use it
          instead of a flat monthly spread.
        </p>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((draw) =>
            editingId === draw.id ? (
              <form
                key={draw.id}
                onSubmit={(e) => handleUpdate(e, draw.id)}
                className="flex flex-wrap items-center gap-1.5 rounded border bg-muted/20 p-1.5"
              >
                <input
                  name="estimatedDate"
                  type="date"
                  defaultValue={draw.estimatedDateIso}
                  required
                  className="rounded border px-2 py-1 text-xs"
                />
                <input
                  name="estimatedAmount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  defaultValue={draw.estimatedAmount}
                  required
                  className="w-24 rounded border px-2 py-1 text-xs"
                />
                <input
                  name="notes"
                  defaultValue={draw.notes ?? ""}
                  placeholder="Notes"
                  maxLength={500}
                  className="min-w-0 flex-1 rounded border px-2 py-1 text-xs"
                />
                <button
                  type="submit"
                  disabled={saving}
                  className="text-xs text-primary hover:underline disabled:opacity-60"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div
                key={draw.id}
                className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-xs"
              >
                <span>
                  <span className="font-medium">
                    {new Date(`${draw.estimatedDateIso}T00:00:00Z`).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      timeZone: "UTC",
                    })}
                  </span>{" "}
                  — {fmtUSD(draw.estimatedAmount)}
                  {draw.notes && <span className="text-muted-foreground"> ({draw.notes})</span>}
                </span>
                <span className="flex shrink-0 gap-2">
                  <button
                    onClick={() => setEditingId(draw.id)}
                    className="text-primary hover:underline"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(draw.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    Delete
                  </button>
                </span>
              </div>
            )
          )}
        </div>
      )}

      {/* Add-draw mini-form */}
      <form onSubmit={handleAdd} className="flex flex-wrap items-center gap-1.5 pt-1">
        <input
          name="estimatedDate"
          type="date"
          required
          className="rounded border px-2 py-1.5 text-xs"
        />
        <input
          name="estimatedAmount"
          type="number"
          step="0.01"
          min="0.01"
          placeholder="0.00"
          required
          className="w-24 rounded border px-2 py-1.5 text-xs"
        />
        <input
          name="notes"
          placeholder="Notes (optional)"
          maxLength={500}
          className="min-w-0 flex-1 rounded border px-2 py-1.5 text-xs"
        />
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {saving ? "Adding…" : "Add draw"}
        </button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
