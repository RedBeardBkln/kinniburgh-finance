// Pure width logic for user-resizable table columns (components/documents/
// resizable-table.tsx). Widths are CSS pixels. The last column is not
// resizable: it fills whatever space is left, so a drag moves the divider 1:1.

export const MIN_COLUMN_WIDTH = 50;
export const MAX_COLUMN_WIDTH = 800;

export function clampColumnWidth(
  width: number,
  min: number = MIN_COLUMN_WIDTH,
  max: number = MAX_COLUMN_WIDTH
): number {
  if (!Number.isFinite(width)) return min;
  return Math.min(max, Math.max(min, Math.round(width)));
}

/**
 * Parses widths saved in localStorage. Anything that doesn't line up with the
 * current column set (wrong length, non-numeric, tampered JSON) falls back to
 * the defaults rather than producing a broken table.
 */
export function parseStoredWidths(raw: string | null, defaults: readonly number[]): number[] {
  if (!raw) return [...defaults];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...defaults];
  }
  if (!Array.isArray(parsed) || parsed.length !== defaults.length) return [...defaults];
  if (!parsed.every((w) => typeof w === "number" && Number.isFinite(w))) return [...defaults];
  return (parsed as number[]).map((w, i) => clampColumnWidth(w, MIN_COLUMN_WIDTH, Math.max(MAX_COLUMN_WIDTH, defaults[i] ?? 0)));
}

/** Width after dragging a divider `deltaX` px from where the drag started. */
export function widthAfterDrag(startWidth: number, deltaX: number): number {
  return clampColumnWidth(startWidth + deltaX);
}

export function sameWidths(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}
