"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateInvestmentBalance } from "@/actions/retirement";

interface Props {
  accountId: string;
  accountName: string;
}

export function RetirementBalanceForm({ accountId, accountName: _ }: Props) {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [balance, setBalance] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    const val = parseFloat(balance);
    if (!val || val < 0) { setError("Enter a valid balance"); return; }
    setError(null);
    startTransition(async () => {
      try {
        await updateInvestmentBalance(accountId, val);
        setShow(false); setBalance("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update");
      }
    });
  }

  if (!show) {
    return (
      <button onClick={() => setShow(true)} className="text-xs text-primary hover:underline whitespace-nowrap">
        Update balance
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-xs text-muted-foreground">$</span>
      <input
        type="number" step="0.01" min="0" value={balance}
        onChange={(e) => setBalance(e.target.value)}
        placeholder="Balance"
        className="w-24 rounded border border-input bg-background px-2 py-1 text-xs"
      />
      <button onClick={handleSave} disabled={isPending}
        className="text-xs text-primary hover:underline disabled:opacity-50">
        {isPending ? "Saving…" : "Save"}
      </button>
      <button onClick={() => setShow(false)} className="text-xs text-muted-foreground hover:underline">×</button>
      {error && <span className="text-xs text-destructive ml-1">{error}</span>}
    </div>
  );
}
