// Tool: list_fixed_assets. Shaper is PURE and unit-tested; the read is queries/fixed-assets.ts (loadFixedAssetsPage, read-only).
// No depreciation, MACRS class, Section 179 or bonus figure and no building basis is computed or returned.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { loadFixedAssets, type FixedAssetsPageView } from "@/lib/advisor/queries/fixed-assets";
import { safeDescriptive } from "@/lib/advisor/scrub";
import { dollarsOf } from "@/lib/advisor/tools/format";
import { defaultPriorYear } from "@/lib/advisor/tools/list-donations";
import { optional, parseInput } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const MAX_ROWS = 50;

const schema = z.object({ year: optional(z.number().int().min(2000).max(2100)) }).strict();
type Input = z.output<typeof schema>;

export function shapeFixedAssets(view: FixedAssetsPageView): ToolOutput {
  let budget = MAX_ROWS;
  let truncated = false;
  const entities = view.sections.map((s) => {
    const room = Math.max(0, budget);
    if (s.rows.length > room) truncated = true;
    const rows = s.rows.slice(0, room).map((r) => ({
      description: safeDescriptive(r.description, 100),
      placed_in_service: r.placedInServiceIso,
      cost_basis: dollarsOf(r.costBasisCents),
      is_real_property: r.isRealProperty,
      land_value: dollarsOf(r.landValueCents),
      business_use_percent: r.businessUsePercent,
      has_invoice: r.invoiceDocumentId !== null,
      after_viewed_year: r.afterViewedYear,
    }));
    budget -= rows.length;
    return {
      entity: safeDescriptive(s.entityName, 80),
      none_confirmed: s.noneConfirmed,
      line_satisfied_by_entries: s.lineSatisfiedByEntries,
      rows,
    };
  });
  const count = entities.reduce((n, e) => n + e.rows.length, 0);
  return {
    data: {
      year: view.year,
      entities,
      ...(truncated ? { rows_truncated: true } : {}),
      notes: ["Cost basis and land value are as entered. No depreciation, Section 179 or bonus figure is computed here."],
    },
    rows: count,
    links: [links.fixedAssets(view.year)],
  };
}

export const listFixedAssetsTool = defineTool<Input>({
  name: "list_fixed_assets",
  description:
    "The fixed-asset register for one year for the business entities that keep one: per entity whether the owner confirmed there are none and whether the entries satisfy the Forms line, and per asset the description, date placed in service, cost basis, whether it is real property, land value, business-use percent, whether an invoice is attached, and whether it was placed in service after the viewed year. year defaults to last calendar year. No depreciation is computed.",
  inputJsonSchema: {
    type: "object",
    properties: { year: { type: "integer", description: "Optional. Tax year, for example 2025. Default last calendar year." } },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up fixed assets",
  summarizeArgs: (i) => `year=${i.year ?? "default"}`,
  run: async (ctx, i) => shapeFixedAssets(await loadFixedAssets(i.year ?? defaultPriorYear(ctx.now))),
  maxChars: LIMITS.toolResultChars,
  phase: 2,
});
