"use client";

import { useState, useTransition } from "react";

interface Props {
  filename: string;
  action: () => Promise<string>;
  label?: string;
}

export function ExportCsvButton({ filename, action, label = "Export CSV" }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleExport() {
    setError(null);
    startTransition(async () => {
      try {
        const csv = await action();
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Export failed");
      }
    });
  }

  return (
    <span>
      <button
        onClick={handleExport}
        disabled={isPending}
        className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
      >
        {isPending ? "Exporting…" : label}
      </button>
      {error && <span className="ml-2 text-xs text-destructive">{error}</span>}
    </span>
  );
}
