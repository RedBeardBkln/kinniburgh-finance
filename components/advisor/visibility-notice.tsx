"use client";

import { useState } from "react";
import { Eye, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ASSISTANT_NOTICE, ASSISTANT_NOTICE_TITLE } from "@/lib/advisor/notice";

// A small button that opens the plain-language statement of what the assistant can and cannot see (lib/advisor/notice.ts).
export function VisibilityNotice() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Eye className="h-3.5 w-3.5" /> {ASSISTANT_NOTICE_TITLE}
      </Button>
      {open && (
        <div role="region" aria-label={ASSISTANT_NOTICE_TITLE} className="absolute right-0 z-30 mt-2 max-h-[70vh] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border bg-card p-4 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{ASSISTANT_NOTICE_TITLE}</h2>
            <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-3 text-xs">
            {ASSISTANT_NOTICE.map((s) => (
              <section key={s.heading}>
                <h3 className="font-medium">{s.heading}</h3>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                  {s.items.map((it) => (
                    <li key={it}>{it}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
