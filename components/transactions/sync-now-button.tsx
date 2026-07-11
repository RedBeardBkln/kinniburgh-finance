"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { syncEntityPlaidAccounts } from "@/actions/plaid-sync";

export function SyncNowButton({ entityId }: { entityId?: string }) {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");
  const router = useRouter();

  function handleSync() {
    setStatus("idle");
    startTransition(async () => {
      try {
        const result = await syncEntityPlaidAccounts(entityId);

        let msg: string;
        let resultStatus: "ok" | "error";

        if (result.needsReauth) {
          resultStatus = "error";
          msg = "Reconnect needed";
        } else if (result.synced === 0 && result.failed > 0) {
          resultStatus = "error";
          msg = "Sync failed";
        } else if (result.added > 0) {
          resultStatus = "ok";
          msg = `+${result.added} new`;
        } else if (result.modified > 0) {
          resultStatus = "ok";
          msg = "Balances updated";
        } else {
          resultStatus = "ok";
          msg = "Up to date";
        }

        setStatus(resultStatus);
        setMessage(msg);
        router.refresh();
      } catch {
        setStatus("error");
        setMessage("Error");
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={handleSync}
        disabled={isPending}
        className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 text-xs h-9 font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none transition-colors"
      >
        {isPending ? (
          <>
            <svg
              className="mr-1.5 h-3 w-3 animate-spin"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Syncing…
          </>
        ) : (
          "Sync Now"
        )}
      </button>
      {status !== "idle" && (
        <span
          className={`text-xs ${status === "ok" ? "text-green-600" : "text-destructive"}`}
        >
          {message}
        </span>
      )}
    </div>
  );
}
