// Tool: get_tax_open_items. Open items, input conflicts and the owner's homework list for the TY2025 DRAFT return, from the review sheet model.
// Shaper is PURE and unit-tested. Each item carries its provenance refs (document / owner answer / books entry) by kind, id and label only.

import { z } from "zod";
import { links } from "@/lib/advisor/links";
import { loadTaxSheetOnce } from "@/lib/advisor/queries/tax";
import { safeField } from "@/lib/advisor/scrub";
import { plainIds } from "@/lib/advisor/tools/tax-format";
import { sheetOrNotice } from "@/lib/advisor/tools/get-tax-return-summary";
import { optional, parseInput } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";
import type { SheetModel, SheetOpenItem } from "@/lib/tax2025-sheet";

const schema = z.object({ severity: optional(z.enum(["blocking", "advisory", "all"])), limit: optional(z.number().int().min(1).max(30)) }).strict();
type Input = z.output<typeof schema>;

const DEFAULT_LIMIT = 15;
const WHO_TEXT: Readonly<Record<SheetOpenItem["who"], string>> = { owner: "the owner's answer is needed", cpa: "the owner's own decision is needed", derived: "derived by the engine; nothing to enter" };

export function shapeTaxOpenItems(model: SheetModel, i: Input): ToolOutput {
  const severity = i.severity ?? "all";
  const limit = i.limit ?? DEFAULT_LIMIT;
  const all = model.openItems.filter((o) => severity === "all" || o.severity === severity);
  const items = all.slice(0, limit).map((o) => ({
    id: safeField(o.id, 80),
    severity: o.severity,
    message: safeField(plainIds(o.message), 300),
    action: safeField(plainIds(o.action), 200),
    who: WHO_TEXT[o.who] ?? o.who,
    owner_action: o.ownerAction === null ? null : safeField(plainIds(o.ownerAction), 240),
    affected_lines: o.lines.slice(0, 6).map((l) => safeField(l.text, 80)),
    sources: o.refs.slice(0, 4).map((r) => ({ kind: safeField(r.kind, 30), id: safeField(r.id, 64), label: safeField(r.label, 80) })),
  }));
  const conflicts = model.conflicts.slice(0, 10).map((c) => ({
    fact: safeField(c.factKey, 80),
    chosen: c.chosen === null ? null : safeField(c.chosen, 80),
    reason: safeField(plainIds(c.reason), 200),
    candidates: c.candidates.slice(0, 4).map((x) => ({ basis: safeField(x.basisLabel, 60), label: safeField(x.label, 80), value: safeField(x.valueText, 80) })),
  }));
  const homework = model.homework
    .filter((h) => severity === "all" || h.severity === severity)
    .slice(0, 10)
    .map((h) => ({ id: safeField(h.id, 80), severity: h.severity, what: safeField(plainIds(h.what), 240), why: safeField(plainIds(h.why), 240), lines: h.lines.slice(0, 6).map((l) => safeField(l, 80)) }));
  return {
    data: {
      tax_year: model.taxYear,
      draft_label: safeField(model.draftLabel, 200),
      counts: { blocking: model.summary.blockingItemCount, advisory: model.summary.advisoryItemCount },
      rows: items,
      matching_items: all.length,
      ...(all.length > items.length ? { more: `${all.length - items.length} more items match; raise limit (max 30) or filter by severity.` } : {}),
      conflicts,
      owner_homework: homework,
    },
    rows: items.length,
    total: all.length,
    links: [links.taxForms(2025), links.returnSheet(2025)],
  };
}

export const getTaxOpenItemsTool = defineTool<Input>({
  name: "get_tax_open_items",
  description:
    "What is still open on the TY2025 DRAFT return: open items (blocking first) with message, what to do, who has to act (the owner's answer, the owner's own decision, or derived by the engine), affected lines and the sources they came from (document, owner answer, books entry), plus input conflicts the engine had to choose between and the owner's homework list. severity is blocking, advisory or all (default all); limit 1 to 30 (default 15). Only TY2025 exists.",
  inputJsonSchema: {
    type: "object",
    properties: {
      severity: { type: "string", description: "Optional. One of blocking, advisory, all. Default all." },
      limit: { type: "integer", description: "Optional. Items to return, 1 to 30. Default 15." },
    },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Checking what is open on the return",
  summarizeArgs: (i) => `severity=${i.severity ?? "all"}, limit=${i.limit ?? DEFAULT_LIMIT}`,
  run: async (ctx, i) => {
    const r = sheetOrNotice(2025, await loadTaxSheetOnce(ctx));
    return "out" in r ? r.out : shapeTaxOpenItems(r.model, i);
  },
  maxChars: 12_000,
  phase: 1,
});
