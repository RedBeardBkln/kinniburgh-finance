// Pure helpers for the "On this page" list the sidebar shows under the Forecast item. A page marks a section with
// `id`, `data-toc-label` (the text shown) and optionally `data-toc-level="2"` (indented under the section above it);
// the sidebar reads those marks from the rendered page, so a section that is not on the page (another entity, a
// Suspense block that has not streamed in, an empty state) simply has no entry. No DOM, no React, no Next here.

export interface TocEntry {
  id: string;
  label: string;
  level: 1 | 2;
}

export interface RawTocNode {
  id: string | null;
  label: string | null;
  level: string | null;
}

export const TOC_SELECTOR = "[data-toc-label][id]";

/** Document order is kept; a node without an id or label is dropped and the first of two equal ids wins. */
export function buildTocEntries(nodes: readonly RawTocNode[]): TocEntry[] {
  const seen = new Set<string>();
  const out: TocEntry[] = [];
  for (const n of nodes) {
    const id = n.id?.trim() ?? "";
    const label = n.label?.replace(/\s+/g, " ").trim() ?? "";
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, level: n.level === "2" ? 2 : 1 });
  }
  return out;
}

/**
 * The section being read: the last one whose top edge has scrolled up to the threshold; the first one when none has
 * yet; null when there are no sections. `tops` is in document order. At the very bottom of the page the last section
 * can never scroll up to the threshold, so `atBottom` makes it the active one.
 */
export function activeTocId(tops: readonly { id: string; top: number }[], threshold: number, atBottom = false): string | null {
  if (tops.length === 0) return null;
  if (atBottom) return (tops[tops.length - 1] as { id: string }).id;
  let active = (tops[0] as { id: string }).id;
  for (const t of tops) {
    if (t.top <= threshold) active = t.id;
  }
  return active;
}

export function sameEntries(a: readonly TocEntry[], b: readonly TocEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.id === b[i]?.id && e.label === b[i]?.label && e.level === b[i]?.level);
}
