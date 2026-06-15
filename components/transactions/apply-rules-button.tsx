"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyAllRules } from "@/actions/tag-rules";

interface Props {
  entityId?: string;
}

export function ApplyRulesButton({ entityId }: Props) {
  const router = useRouter();
  const [result, setResult] = useState<{ processed: number; tagged: number } | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    setResult(null);
    startTransition(async () => {
      const r = await applyAllRules(entityId);
      setResult(r);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleClick}
        disabled={isPending}
        className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 text-xs h-9 font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
      >
        {isPending ? "Applying…" : "Apply rules"}
      </button>
      {result && (
        <span className="text-xs text-muted-foreground">
          {result.tagged} / {result.processed} tagged
        </span>
      )}
    </div>
  );
}
