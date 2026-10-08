// Tool: get_tax_return_lines. Per-line status and provenance of the TY2025 DRAFT return, from the review sheet model. Shaper is PURE.
//
// Returned per line: key, form, form line, label, status and status label, amount text ("not computed" is never shown as 0), the engine's
// reason (clipped), citation ids and primary-source URLs, provenance chips (verified document, UNVERIFIED AI read, owner answer, books,
// derived, decision, override), and the single override note string (it ends with the owner's own recorded reason, decision D12; scrubbed).
// NOT returned: the engine's duplicate `computed` block and the chip hrefs.

import { z } from "zod";
import { links } from "@/lib/advisor/links";
import { loadTaxSheetOnce } from "@/lib/advisor/queries/tax";
import { safeField } from "@/lib/advisor/scrub";
import { plainIds, plainStatusId } from "@/lib/advisor/tools/tax-format";
import { optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { sheetOrNotice } from "@/lib/advisor/tools/get-tax-return-summary";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";
import type { SheetLine, SheetModel } from "@/lib/tax2025-sheet";

const schema = z
  .object({
    form: optional(shortText),
    status: optional(shortText),
    key: optional(shortText),
    limit: optional(z.number().int().min(1).max(60)),
  })
  .strict();
type Input = z.output<typeof schema>;

const DEFAULT_LIMIT = 20;

const norm = (s: string): string => s.trim().toLowerCase();

function matches(line: SheetLine, groupForm: string, i: Input): boolean {
  if (i.form !== undefined) {
    const f = norm(i.form);
    if (!norm(groupForm).includes(f) && !norm(line.form).includes(f)) return false;
  }
  if (i.status !== undefined) {
    const s = norm(i.status);
    if (norm(line.status) !== s && norm(plainStatusId(line.status)) !== s && !norm(line.statusLabel).includes(s)) return false;
  }
  if (i.key !== undefined) {
    const k = norm(i.key);
    if (norm(line.key) !== k && !norm(line.key).startsWith(k)) return false;
  }
  return true;
}

function shapeLine(l: SheetLine): Record<string, unknown> {
  return {
    key: l.key,
    form: safeField(l.form, 40),
    form_line: safeField(l.formLine, 20),
    label: safeField(l.label, 120),
    status: plainStatusId(l.status),
    status_label: safeField(plainIds(l.statusLabel), 100),
    amount: safeField(l.amountText, 40),
    reason: l.reason === null ? null : safeField(plainIds(l.reason), 240),
    citations: l.citations.slice(0, 4).map((c) => ({ id: safeField(c.id, 60), url: c.url === null ? null : safeField(c.url, 200), verified_on: c.verifiedOn })),
    sources: l.chips.slice(0, 6).map((c) => ({ kind: c.kind, label: safeField(c.label, 80) })),
    default_undecided: l.defaultUndecided === null ? null : safeField(l.defaultUndecided, 100),
    override_note: l.override === null ? null : safeField(plainIds(l.override.note), 240),
    depends_on_overridden: l.dependsOnOverridden.slice(0, 4).map((d) => safeField(d.text, 100)),
  };
}

export function shapeTaxLines(model: SheetModel, i: Input): ToolOutput {
  const limit = i.limit ?? DEFAULT_LIMIT;
  const all: { group: string; line: SheetLine }[] = [];
  for (const g of [...model.federal, ...model.connecticut]) for (const line of g.lines) if (matches(line, g.form, i)) all.push({ group: g.form, line });
  const rows = all.slice(0, limit).map((x) => shapeLine(x.line));
  return {
    data: {
      tax_year: model.taxYear,
      draft_label: safeField(model.draftLabel, 200),
      rows,
      matching_lines: all.length,
      ...(all.length > rows.length ? { more: `${all.length - rows.length} more lines match; narrow with form, status or key, or raise limit (max 60).` } : {}),
      amounts_note: "Amounts are whole dollars as printed on the draft. A line that could not be computed says 'not computed' and is never zero.",
    },
    rows: rows.length,
    total: all.length,
    links: [links.returnSheet(2025), links.taxForms(2025)],
  };
}

export const getTaxReturnLinesTool = defineTool<Input>({
  name: "get_tax_return_lines",
  description:
    "Line-by-line status of the TY2025 DRAFT return: each line's key, form and line number, label, status (computed, missing input, needs your decision, rule not verified ...), amount text, the engine's reason, citation ids and irs.gov / ct.gov URLs, provenance chips (verified document, UNVERIFIED AI read, owner answer, books, derived, decision, override) and any override note. Filter by form text (for example Schedule C or CT-1040), status (for example missing_input) or key prefix (for example sch1). Up to 60 lines per call, default 20 (a larger request may be cut to fit; narrow the filters instead).",
  inputJsonSchema: {
    type: "object",
    properties: {
      form: { type: "string", description: "Optional. Text of the form name, for example Schedule C, Form 1040 or CT-1040." },
      status: { type: "string", description: "Optional. A status such as computed, missing_input, not_yet_computed, needs_owner_decision, rule_unverified, not_applicable, informational, overridden, or text of its label." },
      key: { type: "string", description: "Optional. A line key or key prefix, for example f1040.11 or sch1." },
      limit: { type: "integer", description: "Optional. Lines to return, 1 to 60. Default 20." },
    },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Reading return lines",
  summarizeArgs: (i) => `${i.form !== undefined ? "form, " : ""}${i.status !== undefined ? "status, " : ""}${i.key !== undefined ? "key, " : ""}limit=${i.limit ?? DEFAULT_LIMIT}`,
  run: async (ctx, i) => {
    const r = sheetOrNotice(2025, await loadTaxSheetOnce(ctx));
    return "out" in r ? r.out : shapeTaxLines(r.model, i);
  },
  maxChars: 12_000,
  phase: 1,
});
