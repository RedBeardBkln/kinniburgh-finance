"use client";

import { useEffect, useId, useRef } from "react";

// A small accessible modal for the TY2025 review sheet (the repo's modal pattern from
// missing-field-actions.tsx, kept separate so that file is not refactored): Escape and a
// click on the backdrop close it, focus moves into the dialog on open and returns to the
// button that opened it on close, role="dialog" aria-modal="true". Full-screen and
// scrollable below 640 px, a centred card above. No window.confirm anywhere.

export function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  // Keep the latest onClose without re-running the focus effect below.
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener !== null && document.contains(opener)) opener.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="h-full w-full max-w-none overflow-y-auto bg-background p-4 shadow-lg outline-none sm:h-auto sm:max-h-[90vh] sm:max-w-xl sm:rounded-lg sm:border sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-sm font-semibold">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="min-h-[44px] px-2 text-xs text-muted-foreground hover:text-foreground sm:min-h-0">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
