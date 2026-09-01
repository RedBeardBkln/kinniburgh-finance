"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UnsavedChangesGuardProps {
  /** True while the user has unsaved edits */
  isDirty: boolean;
  /** Saves all pending edits. Return false/throw to abort the leave. */
  onSave: () => Promise<boolean | void>;
  /** Where the user intended to go (for the leave action) */
  pendingHrefRef: React.MutableRefObject<string | null>;
}

/**
 * Blocks in-app navigation (Next.js <Link>/router) and hard browser exits
 * (tab close, reload, external nav) while unsaved work exists.
 * - In-app: intercepts link clicks, shows a "save before exiting?" modal.
 * - Browser: fires a native beforeunload confirm.
 * Modal offers Save & leave / Leave without saving / Stay.
 */
export function UnsavedChangesGuard({ isDirty, onSave, pendingHrefRef }: UnsavedChangesGuardProps) {
  const [showModal, setShowModal] = useState(false);
  const [savingThenLeaving, setSavingThenLeaving] = useState(false);
  const [leavingWithoutSave, setLeavingWithoutSave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDirtyRef = useRef(isDirty);

  // Keep the ref in sync outside of render
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  // Native browser guard (tab close / reload / external navigation)
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirtyRef.current) return;
      // Modern browsers show a generic confirm; returnValue is required
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // In-app navigation guard: intercept clicks on Next <Link> anchors
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!isDirtyRef.current) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      // Find the closest anchor (Next <Link> renders <a>)
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("http") || href.startsWith("mailto:"))
        return;
      // Ignore download links
      if (anchor.hasAttribute("download")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;

      // Same-URL hash/detail navigation doesn't lose state
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;

      // Block the navigation and remember the destination
      e.preventDefault();
      e.stopPropagation();
      pendingHrefRef.current = anchor.href;
      setShowModal(true);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [pendingHrefRef]);

  const leave = useCallback(() => {
    // Temporarily clear dirty so guards don't re-trigger, then navigate
    window.location.href = pendingHrefRef.current ?? "/tax";
  }, [pendingHrefRef]);

  async function handleSaveAndLeave() {
    setSavingThenLeaving(true);
    setError(null);
    try {
      const ok = await onSave();
      if (ok === false) {
        setError("Save failed — your changes are still here. Fix the issue or leave without saving.");
        setSavingThenLeaving(false);
        return;
      }
      isDirtyRef.current = false;
      leave();
    } catch {
      setError("Save failed — your changes are still here. Fix the issue or leave without saving.");
      setSavingThenLeaving(false);
    }
  }

  function handleLeaveWithoutSaving() {
    isDirtyRef.current = false;
    setLeavingWithoutSave(true);
    leave();
  }

  function handleStay() {
    setShowModal(false);
    pendingHrefRef.current = null;
  }

  if (!showModal) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border bg-background p-5 shadow-xl space-y-4">
        <div>
          <h3 className="text-base font-semibold">Save your work before leaving?</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            You have unsaved changes on this page. If you leave now, they&apos;ll be lost.
          </p>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        <div className="flex flex-col gap-2">
          <button
            onClick={handleSaveAndLeave}
            disabled={savingThenLeaving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {savingThenLeaving ? "Saving…" : "Save & leave"}
          </button>
          <button
            onClick={handleLeaveWithoutSaving}
            disabled={leavingWithoutSave}
            className="rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5 disabled:opacity-60"
          >
            Leave without saving
          </button>
          <button
            onClick={handleStay}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Stay on this page
          </button>
        </div>
      </div>
    </div>
  );
}