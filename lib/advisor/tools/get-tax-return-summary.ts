// Tool: get_tax_return_summary. Headline figures of the TY2025 DRAFT return from the review sheet model. Shaper is PURE and unit-tested.
//
// Source: the same sheet model the Tax Forms return page renders (effective view, overrides marked), built once per turn. Returned: the draft
// label, engine version, completeness text, counts, caveats and the federal / Connecticut headline rows with their status and any
// provisional figure. Never returned: the facts, raw documents, attestation answers, the checklist or homework (separate tools).

import { z } from "zod";
import { links } from "@/lib/advisor/links";
import { loadTaxSheetOnce } from "@/lib/advisor/queries/tax";
import { safeField } from "@/lib/advisor/scrub";
import { plainIds, plainStatusId } from "@/lib/advisor/tools/tax-format";
import { parseInput } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";
import type { LoadedSheet } from "@/lib/tax2025-sheet-load";
import type { SheetHeadlineRow, SheetModel } from "@/lib/tax2025-sheet";

const schema = z.object({ year: z.number().int().min(1990).max(2100) }).strict();
type Input = z.output<typeof schema>;

export const UNSUPPORTED_YEAR_HINT =
  "The return engine computes tax year 2025 only. For other years the assistant can read the stored tax facts (get_tax_facts) and records, not a computed return.";
export const SHEET_UNAVAILABLE_MESSAGE = "The TY2025 return could not be computed right now, so no figures are available. Nothing was changed.";

function headline(r: SheetHeadlineRow): Record<string, unknown> {
  return {
    label: safeField(r.label, 80),
    computed: safeField(r.computedText, 60),
    status: safeField(plainIds(r.statusLabel), 80),
    provisional_estimate: r.provisionalText === null ? null : safeField(r.provisionalText, 80),
    overridden: r.overridden,
    depends_on_override: r.dependsOnOverride,
    effective_with_override: r.effectiveText === null ? null : safeField(r.effectiveText, 60),
  };
}

export function shapeTaxSummary(model: SheetModel): ToolOutput {
  const s = model.summary;
  return {
    data: {
      tax_year: model.taxYear,
      draft_label: safeField(model.draftLabel, 200),
      engine_version: model.engineVersion,
      built_at: safeField(model.generatedAtDisplay, 60),
      completeness: safeField(s.completenessText, 160),
      complete: s.complete,
      counts: {
        blocking_items: s.blockingItemCount,
        advisory_items: s.advisoryItemCount,
        unverified_document_reads: s.unverifiedDocumentCount,
        derived_inputs: s.derivedInputCount,
        undecided_decisions: s.undecidedDecisionCount,
        overridden_lines: model.overrideCount,
      },
      caveats: s.caveats.slice(0, 8).map((c) => safeField(c, 240)),
      provisional_note: s.provisionalNote === null ? null : safeField(s.provisionalNote, 240),
      provisional_assumed_facts: s.provisionalAssumedFacts.slice(0, 10).map((f) => safeField(f, 160)),
      federal: s.federal.slice(0, 12).map(headline),
      connecticut: s.connecticut.slice(0, 12).map(headline),
      line_status_counts: Object.fromEntries(Object.entries(s.statusCounts).map(([k, v]) => [plainStatusId(k), v])),
      overrides: {
        line_overrides: s.overrides.lineCount,
        decision_overrides: s.overrides.decisionCount,
        totals_not_recomputed: s.overrides.totalsNotRecomputed,
        notice: s.overrides.totalsNotice === null ? null : safeField(s.overrides.totalsNotice, 240),
      },
      notes: [
        "Figures are a DRAFT computed from the inputs on file; Eric is the preparer of record and nothing here is filed or approved by this assistant.",
        "A line marked unverified AI read rests on a document the owner has not confirmed yet.",
      ],
    },
    links: [links.taxForms(2025), links.returnSheet(2025), links.finalReview(2025)],
  };
}

/** Shared by the sheet-backed tools: the one place an unsupported year or an unavailable sheet becomes a neutral result. */
export function sheetOrNotice(year: number, loaded: LoadedSheet): { model: SheetModel } | { out: ToolOutput } {
  if (year !== 2025 || loaded.kind === "unsupported_year") return { out: { data: { supported: false, hint: UNSUPPORTED_YEAR_HINT }, links: [links.taxFacts()] } };
  if (loaded.kind === "error") return { out: { data: { available: false, message: SHEET_UNAVAILABLE_MESSAGE }, links: [links.taxForms(2025)] } };
  return { model: loaded.model };
}

export const getTaxReturnSummaryTool = defineTool<Input>({
  name: "get_tax_return_summary",
  description:
    "Headline figures of the household's TY2025 return, which is a DRAFT until the owner approves it: draft label, engine version, whether the engine says it is complete, counts of blocking items, unverified document reads and undecided decisions, caveats, and the federal and Connecticut headline rows with their status (computed, missing input, needs your decision, rule not verified ...) and any provisional figure. Only year 2025 is supported. Use get_tax_return_lines for line detail.",
  inputJsonSchema: {
    type: "object",
    properties: { year: { type: "integer", description: "Tax year. Only 2025 is supported." } },
    required: ["year"],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Reading the TY2025 return",
  summarizeArgs: (i) => `year=${i.year}`,
  run: async (ctx, i) => {
    if (i.year !== 2025) return { data: { supported: false, hint: UNSUPPORTED_YEAR_HINT }, links: [links.taxFacts()] };
    const r = sheetOrNotice(i.year, await loadTaxSheetOnce(ctx));
    return "out" in r ? r.out : shapeTaxSummary(r.model);
  },
  maxChars: 8_000,
  phase: 1,
});
