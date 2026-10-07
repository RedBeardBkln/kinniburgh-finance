"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { seedTaxFactsTy2025 } from "@/actions/tax-facts";

// Owner-triggered, idempotent load of the TY2025 facts transcribed from specs/12. It only adds facts that have no
// record at all; a fact you have since changed is never overwritten. Writes only to the facts table.

export function SeedFactsButton({ total, missing }: { total: number; missing: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const res = await seedTaxFactsTy2025();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setMessage(`Added ${res.inserted} fact${res.inserted === 1 ? "" : "s"}; ${res.alreadyPresent} already recorded.`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={pending || missing === 0}
        className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-60"
      >
        {pending ? "Loading..." : missing === 0 ? `All ${total} TY2025 facts are loaded` : `Load the TY2025 facts from spec 12 (${missing} of ${total} to add)`}
      </button>
      {message && <span className="text-xs text-green-700">{message}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
