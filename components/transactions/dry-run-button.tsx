"use client";

import { useState, useTransition } from "react";
import { dryRunTagRules } from "@/actions/tag-rules";

interface Props {
  entityId?: string;
}

export function DryRunButton({ entityId }: Props) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{
    total: number;
    willTag: number;
    previews: Array<{ payeeRaw: string; tagShortName: string }>;
    unmatched: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        const r = await dryRunTagRules(entityId);
        setResult(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Preview failed");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={isPending}
        className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 text-xs h-9 font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
      >
        {isPending ? "Previewing…" : "Preview matches"}
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {result && (
        <div className="text-xs text-right space-y-1 max-w-xs">
          <p className="font-medium">
            {result.willTag} of {result.total} untagged would be tagged.
          </p>
          {result.previews.length > 0 && (
            <ul className="text-muted-foreground space-y-0.5">
              {result.previews.map((p, i) => (
                <li key={i} className="truncate">
                  {p.payeeRaw} → {p.tagShortName}
                </li>
              ))}
            </ul>
          )}
          {result.unmatched > 0 && (
            <p className="text-muted-foreground">{result.unmatched} have no matching rule.</p>
          )}
        </div>
      )}
    </div>
  );
}
