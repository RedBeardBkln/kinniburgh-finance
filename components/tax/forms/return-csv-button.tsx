"use client";

import { useState, useTransition } from "react";
import { exportTaxReturnCsv } from "@/actions/tax-return";

// Download of the return review sheet as CSV. The server action authenticates, computes
// the return and returns the CSV text; this leaf only turns it into a file download.
// No confirm dialog: the export is read-only and changes nothing.

export function ReturnCsvButton({ year }: { year: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function download() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await exportTaxReturnCsv(year);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = res.filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        setError("The CSV export failed. Try again.");
      }
    });
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 print:hidden">
      <button
        type="button"
        onClick={download}
        disabled={pending}
        className="inline-flex min-h-11 items-center rounded-md border border-primary/40 px-4 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
      >
        {pending ? "Building CSV..." : "Download CSV (one row per line)"}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
