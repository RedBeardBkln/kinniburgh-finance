"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OverviewItem } from "@/lib/dashboard-overview";

/** The server action that saves a choice (handed down from the page so this file never imports server code). */
export type SetExpenseKind = (input: {
  tagId: string;
  kind: "fixed" | "variable" | "auto";
}) => Promise<{ success: true } | { error: string }>;

function whole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/**
 * "How lines are sorted": every category with its Fixed / Variable call, the reason, and a button to move it. A choice
 * is saved for the category (all months) and wins over the automatic call; "Use automatic" removes it.
 */
export function KindSorter({ items, setKind }: { items: OverviewItem[]; setKind: SetExpenseKind }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyTag, setBusyTag] = useState<string | null>(null);

  const sortable = items
    .filter((i) => i.tagId !== null)
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "fixed" ? -1 : 1));

  function change(tagId: string, kind: "fixed" | "variable" | "auto") {
    setError(null);
    setBusyTag(tagId);
    startTransition(async () => {
      const result = await setKind({ tagId, kind });
      if ("error" in result) setError(result.error);
      else router.refresh();
      setBusyTag(null);
    });
  }

  return (
    <details className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <summary className="cursor-pointer select-none font-medium">How lines are sorted into Fixed and Variable</summary>
      <p className="mt-2 text-xs text-muted-foreground">
        A line counts as Fixed when it cost about the same in at least 4 of the last 6 months. You can move any line yourself and
        the choice is remembered.
      </p>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      <ul className="mt-2 divide-y">
        {sortable.map((item) => {
          const tagId = item.tagId as string;
          const busy = pending && busyTag === tagId;
          const other = item.kind === "fixed" ? "variable" : "fixed";
          return (
            <li key={item.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5">
              <div className="min-w-0">
                <span className="font-medium">{item.name}</span>{" "}
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${item.kind === "fixed" ? "bg-slate-200 text-slate-800" : "bg-primary/10 text-primary"}`}
                >
                  {item.kind === "fixed" ? "Fixed" : "Variable"}
                </span>
                <span className="ml-2 text-xs tabular-nums text-muted-foreground">{whole(item.actualCents)} this month</span>
                <p className="text-xs text-muted-foreground">{item.basis}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => change(tagId, other)}
                  className="rounded border bg-background px-2 py-1 text-xs hover:bg-accent/50 disabled:opacity-50"
                >
                  Make {other === "fixed" ? "Fixed" : "Variable"}
                </button>
                {item.source === "you" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => change(tagId, "auto")}
                    className="rounded px-2 py-1 text-xs text-primary hover:underline disabled:opacity-50"
                  >
                    Use automatic
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
