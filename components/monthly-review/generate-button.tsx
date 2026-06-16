"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { generateMonthlyReview } from "@/actions/monthly-review";

interface Props {
  period: string;
  label?: string;
}

export function GenerateButton({ period, label = "Generate review" }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await generateMonthlyReview(period);
      if ("error" in result) {
        setError(result.error);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        onClick={handleClick}
        disabled={isPending}
        className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
      >
        {isPending ? "Generating…" : label}
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
