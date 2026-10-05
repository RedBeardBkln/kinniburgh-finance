// Type / description / code entries that the packet leaves blank beside an amount line (reason `zero_line_entry`, see types.ts
// MapBlank.follows). Pure: it reads only the map and the view. While every line an entry follows is zero or not applicable, a
// blank entry is exactly right (the line itself is blank). When a followed line prints something that needs the entry (a
// non-zero amount, a recorded override, or an owner "Yes" that the engine could not turn into an amount) the entry is a hand-written
// item: fill.ts raises an advisory item and L1 check B5 raises a finding, so a type box is never silently empty next to an amount.

import type { FormMap, LineRef, MapBlank, PdfLine, PdfReturnView } from "@/lib/tax2025/pdf/types";

export interface HandEntry {
  formId: string;
  /** The map's own note (one per distinct note: entries that share a note are one item). */
  note: string;
  /** Fields (or `match:<regex>` for a pattern entry) that carry the note and stay blank. */
  fields: string[];
  /** The followed lines that need the entry, in map order ("Schedule 1 line 8z"). */
  lines: { key: LineRef; label: string; amount: number | null; why: "amount" | "needs_answer" }[];
}

/** Does this followed line print an amount, or still wait on the owner's answer (so a description may be needed)? */
function needsEntry(line: PdfLine | undefined): "amount" | "needs_answer" | null {
  if (line === undefined) return null;
  switch (line.status) {
    case "computed":
    case "overridden":
    case "not_applicable":
      return line.amount !== null && line.amount !== 0 ? "amount" : null;
    case "needs_cpa_judgment":
      // the owner answered Yes for the group this line belongs to: an amount is expected that the engine does not compute
      return "needs_answer";
    default:
      return null;
  }
}

function blankLabel(b: MapBlank): string {
  return "field" in b ? b.field : `match:${b.match.source}`;
}

/** Blank entries (reason `zero_line_entry`) of a map whose followed lines carry an amount or a pending owner answer. */
export function entriesNeedingHand(map: FormMap, view: PdfReturnView): HandEntry[] {
  const byNote = new Map<string, HandEntry>();
  for (const b of map.blank) {
    if (b.reason !== "zero_line_entry" || b.follows === undefined || b.note === undefined) continue;
    const need: HandEntry["lines"] = [];
    for (const key of b.follows) {
      const line = view.lines[key];
      const why = needsEntry(line);
      if (line !== undefined && why !== null) {
        need.push({ key, label: `${line.formLabel} line ${line.formLine}`, amount: line.amount, why });
      }
    }
    if (need.length === 0) continue;
    const entry = byNote.get(b.note) ?? { formId: map.formId, note: b.note, fields: [], lines: [] };
    entry.fields.push(blankLabel(b));
    for (const n of need) if (!entry.lines.some((l) => l.key === n.key)) entry.lines.push(n);
    byNote.set(b.note, entry);
  }
  return [...byNote.values()];
}

/** The plain-language sentence for one hand entry (packet advisory item and review finding). */
export function handEntryMessage(entry: HandEntry): string {
  const where = entry.lines.map((l) => l.label).join(", ");
  const why = entry.lines.every((l) => l.why === "amount") ? "carries an amount" : "needs your answer or carries an amount";
  return `${entry.note}: ${where} ${why}, and this packet leaves that entry blank. Write it on the printed form (attach a statement if it does not fit).`;
}
