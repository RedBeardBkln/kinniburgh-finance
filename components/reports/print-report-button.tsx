"use client";

import { Printer } from "lucide-react";

// Tiny client leaf: the report sheets are server components, so only the print trigger needs the browser.
export function PrintReportButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 print:hidden"
    >
      <Printer className="h-4 w-4" />
      Print report
    </button>
  );
}
