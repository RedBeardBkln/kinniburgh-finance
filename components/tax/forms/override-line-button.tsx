"use client";

import { useState } from "react";
import { OverrideDialog, type OverrideDialogLine } from "@/components/tax/forms/override-dialog";

// The small chip on a review-sheet line that opens the override dialog. Hidden when the
// sheet is printed (the printed sheet shows the override note instead of a button).

export function OverrideLineButton({ line, taxYear }: { line: OverrideDialogLine; taxYear: 2025 }) {
  const [open, setOpen] = useState(false);
  const has = line.override !== null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="override-chip"
        aria-label={`${has ? "Change override on" : "Override"} ${line.form} line ${line.formLine}`}
        className="inline-flex min-h-[44px] items-center rounded-md border border-primary/40 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10 print:hidden sm:min-h-0"
      >
        {has ? "Change override" : "Override"}
      </button>
      {open ? <OverrideDialog line={line} taxYear={taxYear} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
