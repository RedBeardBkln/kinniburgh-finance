// Shared layout for the hand-rolled `fixed inset-0` dialogs (mobile-layout-cleanup). Plain strings, no React, so both
// server and client components can use it. On phones a dialog is a bottom sheet that never runs past the screen; from
// `sm` up it is the usual centred card. Callers put these FIRST in `cn(...)` so their own colours, padding and shadow win.

export type ModalSize = "sm" | "md" | "lg" | "xl" | "2xl" | "5xl";

/** Overlay: bottom sheet on phones, centred card with some breathing room from `sm` up. */
export const MODAL_OVERLAY = "fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4";

// Full literal class names (Tailwind only generates classes it can find written out in the source).
const SIZE_CLASS: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "5xl": "max-w-5xl",
};

/**
 * The dialog panel. `scroll`:
 * - "panel": the panel itself scrolls when it is taller than the screen.
 * - "inner": the dialog already has a flex-col body that scrolls; the panel only caps its height.
 */
export function modalPanelClass(size: ModalSize, scroll: "panel" | "inner" = "panel"): string {
  const base = `w-full ${SIZE_CLASS[size]} max-h-[92dvh] rounded-t-xl sm:max-h-[90vh] sm:rounded-lg`;
  return scroll === "panel" ? `${base} overflow-y-auto` : `${base} flex flex-col overflow-hidden`;
}
