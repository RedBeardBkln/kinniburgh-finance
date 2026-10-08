"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// A titled section that starts collapsed (Memory and Goals on the Advisor page). The content stays mounted so a server-rendered child keeps its state.
export function CollapsibleSection({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border">
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {title}
      </button>
      <div className={open ? "border-t p-3" : "hidden"}>{children}</div>
    </section>
  );
}
