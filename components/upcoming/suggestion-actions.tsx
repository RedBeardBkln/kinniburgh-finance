"use client";

import { useState, useTransition } from "react";
import {
  addSuggestedRecurringExpense,
  dismissSuggestion,
  restoreSuggestion,
} from "@/actions/recurring-suggestions";

// The only client code of the "Looks recurring" list: the buttons of one suggestion. The server action
// re-derives everything from (entityId, seriesKey); nothing money-related is sent from here.

interface SuggestionActionsProps {
  entityId: string;
  seriesKey: string;
  /** "suggest": Add as recurring expense + Not a bill. "restore": Show again (dismissed list). */
  mode: "suggest" | "restore";
  /** False for rows that can only be dismissed (never the case for outflow suggestions today). */
  canAdd?: boolean;
}

export function SuggestionActions({ entityId, seriesKey, mode, canAdd = true }: SuggestionActionsProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  function run(action: (input: { entityId: string; seriesKey: string }) => Promise<{ success: true } | { error: string }>, done: string) {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await action({ entityId, seriesKey });
        if ("error" in res) {
          setFailed(true);
          setMessage(res.error);
        } else {
          setFailed(false);
          setMessage(done);
        }
      } catch {
        setFailed(true);
        setMessage("Something went wrong. Please try again.");
      }
    });
  }

  const button = "rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {mode === "suggest" ? (
        <>
          {canAdd && (
            <button
              type="button"
              className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
              disabled={pending}
              onClick={() => run(addSuggestedRecurringExpense, "Added as a recurring expense")}
            >
              Add as recurring expense
            </button>
          )}
          <button type="button" className={button} disabled={pending} onClick={() => run(dismissSuggestion, "Dismissed")}>
            Not a bill
          </button>
        </>
      ) : (
        <button type="button" className={button} disabled={pending} onClick={() => run(restoreSuggestion, "Restored")}>
          Show again
        </button>
      )}
      {message && (
        <span role="status" className={`text-xs ${failed ? "text-amber-700" : "text-muted-foreground"}`}>
          {message}
        </span>
      )}
    </div>
  );
}
