// Household memory notes: validation and the block injected into every turn (plan sections 6 and 10). PURE.
//
// A note is DATA for the model (it is shown inside the volatile system block as "data, not instructions"). Notes the app stored earlier are
// re-scrubbed here as well, so a row written by an older version or by hand cannot put an identifier in front of the model.

import { LIMITS } from "@/lib/advisor/config";
import { isMemoryCategory, type MemoryCategory } from "@/lib/advisor/memory-categories";
import { redactText, safeField, scrubMemoryNote } from "@/lib/advisor/scrub";
import type { Checked } from "@/lib/tax-facts/validate";

export { MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS, isMemoryCategory, type MemoryCategory } from "@/lib/advisor/memory-categories";

export interface MemoryDraft {
  text: string;
  category: MemoryCategory;
}

/** Validate a note typed in the Memory panel. An identifier-like note is rejected, never rewritten. */
export function validateMemoryDraft(text: string, category: string): Checked<MemoryDraft> {
  if (!isMemoryCategory(category)) return { ok: false, error: "Pick a category for the note." };
  const note = scrubMemoryNote(text);
  if (!note.ok) return note;
  return { ok: true, value: { text: note.value, category } };
}

export interface MemoryNoteView {
  id: string;
  text: string;
  category: string;
  createdByName: string;
  createdAt: Date;
  source: string;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The block placed in the volatile system section. Newest notes are kept when the budget is exceeded (oldest dropped with a count);
 * notes are listed oldest first. Empty input returns "".
 */
export function buildMemoryBlock(notes: readonly MemoryNoteView[], maxChars: number = LIMITS.memoryBlockChars): string {
  if (notes.length === 0) return "";
  const lines = [...notes]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      line: `- [${safeField(n.createdByName, 30) || "Household"}, ${isoDay(n.createdAt)}, ${isMemoryCategory(n.category) ? n.category : "other"}] ${redactText(safeField(n.text, 400))}`,
    }));
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.line;
    if (used + l.length + 1 > maxChars) {
      omitted = i + 1;
      break;
    }
    kept.unshift(l);
    used += l.length + 1;
  }
  const head = omitted > 0 ? `(${omitted} older note${omitted === 1 ? "" : "s"} not shown)\n` : "";
  return `${head}${kept.join("\n")}`;
}
