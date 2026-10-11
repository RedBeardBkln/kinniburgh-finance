"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { archiveUtilityUsage } from "@/actions/utility-usage";

// One saved usage row: "Remove" asks once, then archives it (the row leaves the history table and the estimates; it is
// kept in the database, never deleted). Only the ids are sent; the server checks the row belongs to this house.

export function UsageArchiveButton({ entityId, id, label }: { entityId: string; id: string; label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function archive() {
    setError(null);
    startTransition(async () => {
      const result = await archiveUtilityUsage({ entityId, id });
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      router.refresh();
    });
  }

  if (!confirming) {
    return (
      <span className="inline-flex flex-col items-end gap-0.5">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={pending}
          className="text-xs text-muted-foreground hover:text-destructive hover:underline disabled:opacity-50"
          aria-label={`Remove ${label}`}
        >
          Remove
        </button>
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span>Remove this row from the history?</span>
      <button type="button" onClick={archive} disabled={pending} className="rounded-md border px-2 py-0.5 hover:bg-muted disabled:opacity-50">
        {pending ? "Removing..." : "Yes, remove"}
      </button>
      <button type="button" onClick={() => setConfirming(false)} disabled={pending} className="text-muted-foreground hover:underline disabled:opacity-50">
        Keep
      </button>
    </span>
  );
}
