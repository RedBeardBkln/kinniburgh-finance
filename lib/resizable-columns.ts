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

// ── Split pane (document preview | form) ─────────────────────────────────────

export const SPLIT_MIN_PERCENT = 25;
export const SPLIT_MAX_PERCENT = 80;
export const SPLIT_DEFAULT_PERCENT = 55;

export function clampSplitPercent(percent: number): number {
  if (!Number.isFinite(percent)) return SPLIT_DEFAULT_PERCENT;
  return Math.min(SPLIT_MAX_PERCENT, Math.max(SPLIT_MIN_PERCENT, Math.round(percent * 10) / 10));
}

/** Split saved in localStorage, or the default for anything missing/invalid. */
export function parseStoredSplit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return SPLIT_DEFAULT_PERCENT;
  const n = Number(raw);
  return Number.isFinite(n) ? clampSplitPercent(n) : SPLIT_DEFAULT_PERCENT;
}

/** Left-pane width (percent of the container) for a pointer at clientX. */
export function splitPercentFromPointer(clientX: number, containerLeft: number, containerWidth: number): number {
  if (!(containerWidth > 0)) return SPLIT_DEFAULT_PERCENT;
  return clampSplitPercent(((clientX - containerLeft) / containerWidth) * 100);
}

// ── Image zoom (scanned documents in the preview pane) ───────────────────────

/** Zoom is the image width as a percent of the pane: 100 = fit to the pane width. */
export const IMAGE_ZOOM_MIN = 100;
export const IMAGE_ZOOM_MAX = 400;
export const IMAGE_ZOOM_STEP = 25;

export function stepImageZoom(current: number, direction: 1 | -1): number {
  const next = current + direction * IMAGE_ZOOM_STEP;
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, next));
}
