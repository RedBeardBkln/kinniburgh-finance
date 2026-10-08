// Tool: get_tax_decisions. The owner's decisions on the TY2025 DRAFT return (X1, X5, X6, X7, X8 ...) with who decided, when and WHY, and the
// alternatives side by side, from the review sheet model. Shaper is PURE and unit-tested.
//
// The owner's recorded reason is returned on purpose (decision D12: it is his own text, scrubbed and clipped). Finding-acceptance reasons are not.
// The choice itself is the owner's: this tool only reads; recording a decision is done on the Tax Forms page.

import { z } from "zod";
import { links } from "@/lib/advisor/links";
import { loadTaxSheetOnce } from "@/lib/advisor/queries/tax";
import { safeField } from "@/lib/advisor/scrub";
import { firstNameOf } from "@/lib/advisor/names";
import { plainIds } from "@/lib/advisor/tools/tax-format";
import { sheetOrNotice } from "@/lib/advisor/tools/get-tax-return-summary";
import { optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";
import type { SheetDecision, SheetModel } from "@/lib/tax2025-sheet";

const schema = z.object({ id: optional(shortText) }).strict();
type Input = z.output<typeof schema>;

const MAX_DECISIONS = 20;

function shapeDecision(d: SheetDecision): Record<string, unknown> {
  return {
    id: safeField(d.id, 40),
    label: safeField(plainIds(d.label), 160),
    chosen: safeField(plainIds(d.chosen), 120),
    status: safeField(d.statusText, 60),
    undecided: d.undecided,
    decided_by: d.decidedBy === null ? null : firstNameOf(d.decidedBy),
    decided_at: d.decidedAt === null ? null : safeField(d.decidedAt, 40),
    recorded_decision:
      d.override === null
        ? null
        : {
            note: safeField(plainIds(d.override.note), 240),
            // the owner's own recorded reason (decision D12), scrubbed
            reason: safeField(d.override.reason, 500),
            recorded_by: firstNameOf(d.override.by),
            on: d.override.atDate,
            version: d.override.version,
          },
    affected_lines: d.affectedLines.slice(0, 8).map((l) => safeField(l, 40)),
    alternatives: d.alternatives.slice(0, 6).map((a) => ({
      label: safeField(plainIds(a.label), 160),
      status: safeField(plainIds(a.statusLabel), 100),
      is_default: a.isDefault,
      in_force: a.inForce,
      marker: a.marker === null ? null : safeField(a.marker, 40),
      effect: a.effectAmountText === null ? null : safeField(plainIds(a.effectAmountText), 120),
      effect_note: a.effectNote === null ? null : safeField(plainIds(a.effectNote), 240),
    })),
    whole_return_effect: safeField(plainIds(d.wholeReturnEffect), 300),
    business_use:
      d.percent === null
        ? null
        : {
            recorded_percent: d.percent.currentText,
            default_when_undecided_percent: d.percent.defaultText,
            booked_to_shared_accounts: d.percent.bookedCents / 100,
            line: safeField(d.percent.lineLabel, 60),
            personal_portion_text: safeField(d.percent.personalText, 200),
          },
    overpayment:
      d.amount === null ? null : { max_applicable_dollars: d.amount.maxDollars, recorded_dollars: d.amount.currentDollars, line: safeField(d.amount.overpaymentLine, 60) },
  };
}

export function shapeTaxDecisions(model: SheetModel, i: Input): ToolOutput {
  const wanted = i.id?.trim().toLowerCase();
  const matching = model.decisions.filter((d) => wanted === undefined || d.id.toLowerCase() === wanted);
  const rows = matching.slice(0, MAX_DECISIONS).map(shapeDecision);
  const placeholders = model.decisionPlaceholders
    .filter((p) => wanted === undefined || p.id.toLowerCase() === wanted)
    .slice(0, 10)
    .map((p) => ({ id: safeField(p.id, 40), label: safeField(plainIds(p.label), 160), note: safeField(plainIds(p.note), 240) }));
  return {
    data: {
      tax_year: model.taxYear,
      draft_label: safeField(model.draftLabel, 200),
      undecided_count: model.summary.undecidedDecisionCount,
      rows,
      not_raised_for_this_return: placeholders,
      honesty: "A decision marked 'default, undecided' shows the conservative alternative; it is not a recommendation. The choice is the owner's and is recorded on the Tax Forms page.",
    },
    rows: rows.length,
    total: matching.length,
    links: [links.returnSheet(2025), links.taxForms(2025)],
  };
}

export const getTaxDecisionsTool = defineTool<Input>({
  name: "get_tax_decisions",
  description:
    "The owner's decisions on the TY2025 DRAFT return (home office method, depreciation elections, business-use percentages, how an overpayment is applied, and so on): for each decision the choice in force, whether it is still the undecided default, who recorded it, when and why (the owner's own recorded reason), and the alternatives side by side with their effect on the return. Optionally pass id (for example X1). Read-only; the choice is the owner's.",
  inputJsonSchema: {
    type: "object",
    properties: { id: { type: "string", description: "Optional. A decision id such as X1, X5, X6, X7 or X8. Omit to list all." } },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Reading the return decisions",
  summarizeArgs: (i) => (i.id === undefined ? "all decisions" : "one decision"),
  run: async (ctx, i) => {
    const r = sheetOrNotice(2025, await loadTaxSheetOnce(ctx));
    return "out" in r ? r.out : shapeTaxDecisions(r.model, i);
  },
  maxChars: 12_000,
  phase: 1,
});
