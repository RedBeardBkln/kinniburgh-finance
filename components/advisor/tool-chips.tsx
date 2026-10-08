import { AlertTriangle, Check, Loader2 } from "lucide-react";
import type { ToolChip } from "@/lib/advisor/chat-state";

// The fixed-text chips for the lookups behind an answer: "Looking up transactions..." while running, then "Transactions (25 rows)".
// The label text comes from the tool registry (or the stored record), never from the model.

export function ToolChips({ chips }: { chips: readonly ToolChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Lookups used for this answer">
      {chips.map((c) => (
        <span
          key={c.id}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${c.state === "failed" ? "border-destructive/40 text-destructive" : "text-muted-foreground"}`}
        >
          {c.state === "running" ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : c.state === "failed" ? (
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          ) : (
            <Check className="h-3 w-3" aria-hidden="true" />
          )}
          {c.state === "running" ? `${c.text}...` : c.text}
        </span>
      ))}
    </div>
  );
}
