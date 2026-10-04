"use client";

// Tiny client leaf: the questions and answers summary is a server component, so only the print
// trigger needs the browser.
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex min-h-11 items-center rounded-md border border-primary/40 px-4 text-sm font-medium text-primary hover:bg-primary/10 print:hidden"
    >
      Print this page
    </button>
  );
}
