"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setMcCarthyNotOil } from "@/actions/seasonal-settings";

// One click on one McCarthy row: "Not heating oil" (leave it out of the oil history) or "Count it again". Only the ids are
// sent; the server action re-checks that the transaction exists, is a McCarthy payment and belongs to this property.
// The transaction itself is never changed.

export function McCarthyToggle({ entityId, txId, notOil }: { entityId: string; txId: string; notOil: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function click() {
    setError(null);
    startTransition(async () => {
      const result = await setMcCarthyNotOil({ entityId, transactionId: txId, notOil });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={click}
        disabled={pending}
        className="rounded-md border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
      >
        {pending ? "Saving..." : notOil ? "Not heating oil" : "Count it again"}
      </button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
