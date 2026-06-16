"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createOrUpdateSavingsTransfer } from "@/actions/savings";

interface Props {
  defaultAmountCents: number;
  existingAmountCents: number | null;
}

export function SaveTransferForm({ defaultAmountCents, existingAmountCents }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [amount, setAmount] = useState(
    ((existingAmountCents ?? defaultAmountCents) / 100).toFixed(2)
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const amountCents = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setError("Enter a positive dollar amount.");
      return;
    }
    startTransition(async () => {
      const result = await createOrUpdateSavingsTransfer(amountCents);
      if ("error" in result) {
        setError(result.error);
      } else {
        setSuccess(true);
        router.refresh();
      }
    });
  }

  const label = existingAmountCents != null ? "Update transfer" : "Create transfer";

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground font-medium">Monthly amount ($)</label>
        <input
          type="number"
          min="1"
          step="1"
          value={amount}
          onChange={(e) => { setAmount(e.target.value); setSuccess(false); }}
          className="w-36 rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md border bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {isPending ? "Saving…" : label}
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
      {success && <span className="text-xs text-green-600">Saved!</span>}
    </form>
  );
}
