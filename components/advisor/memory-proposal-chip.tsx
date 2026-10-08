"use client";

import { useState, useTransition } from "react";
import { BookmarkPlus, Check } from "lucide-react";
import { confirmMemorySuggestion } from "@/actions/advisor";
import { Button } from "@/components/ui/button";
import { MEMORY_CATEGORY_LABELS, isMemoryCategory } from "@/lib/advisor/memory-categories";

// A memory note the assistant SUGGESTED. Nothing is stored until the person clicks Save; Dismiss just hides it. The suggestion is live only (it is
// not saved with the message), so after a reload the Memory panel on the Advisor page is the way to add a note by hand.

export function MemoryProposalChip({ text, category }: { text: string; category: string }) {
  const [state, setState] = useState<"idle" | "saved" | "dismissed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (state === "dismissed") return null;
  const label = isMemoryCategory(category) ? MEMORY_CATEGORY_LABELS[category] : "Note";

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await confirmMemorySuggestion(text, category);
      if (res.ok) setState("saved");
      else setError(res.error);
    });
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-sm" role="group" aria-label="Suggested memory note">
      <p className="text-xs text-muted-foreground">
        <BookmarkPlus className="mr-1 inline h-3 w-3" aria-hidden="true" />
        Suggested by the assistant. Saved only if you click Save.
      </p>
      <p>
        <span className="mr-1.5 rounded-full border px-1.5 py-0.5 text-xs text-muted-foreground">{label}</span>
        {text}
      </p>
      {state === "saved" ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Check className="h-3 w-3" aria-hidden="true" />
          Saved to the household memory notes.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving..." : "Save"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setState("dismissed")} disabled={pending}>
            Dismiss
          </Button>
        </div>
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
