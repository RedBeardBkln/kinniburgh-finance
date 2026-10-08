// Tool: get_tax_facts. The owner-confirmed tax facts store, READ through the carry-forward resolver (never copied anywhere). Shaper is PURE.
//
// The resolver splits the facts for a target year into: already confirmed for that year, carried unchanged from an earlier year, needing
// re-confirmation, open items and "ask fresh" reference values. Each fact says which year and version it came from and how it was confirmed.
// The TY2025 return, its fingerprint and the AI reviewer do not read this store (a separate source for owner statements); this tool only reads.

import { z } from "zod";
import { links } from "@/lib/advisor/links";
import { loadTaxFactsOnce } from "@/lib/advisor/queries/tax";
import { safeField } from "@/lib/advisor/scrub";
import { firstNameOf } from "@/lib/advisor/names";
import { isoDay } from "@/lib/advisor/tools/format";
import { plainIds } from "@/lib/advisor/tools/tax-format";
import { optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";
import { resolveCarryForward, type CarryItem } from "@/lib/tax-facts/carry-forward";
import { formatFactValue } from "@/lib/tax-facts/format";
import { FACT_CATEGORIES, type TaxFactRow } from "@/lib/tax-facts/types";
import type { TaxFactsLoad } from "@/lib/tax-facts-store";

const schema = z
  .object({
    category: optional(shortText),
    tax_year: optional(z.number().int().min(2000).max(2100)),
    key_prefix: optional(shortText),
    include_history: optional(z.boolean()),
    open_items_only: optional(z.boolean()),
  })
  .strict();
type Input = z.output<typeof schema>;

const MAX_FACTS = 80;
const MAX_HISTORY = 60;
const DEFAULT_YEAR = 2025;

const GROUPS = [
  ["already_confirmed_for_year", "alreadyConfirmedForYear"],
  ["carried_from_earlier_year", "carried"],
  ["needs_reconfirmation", "needsReconfirmation"],
  ["open_items", "openItems"],
  ["ask_fresh_reference_only", "askFresh"],
] as const;

function shapeItem(c: CarryItem): Record<string, unknown> {
  return {
    key: safeField(c.factKey, 100),
    label: safeField(c.label, 120),
    category: c.category,
    value: safeField(formatFactValue(c), 160),
    from_tax_year: c.fromTaxYear,
    version: c.fromVersion,
    carry_policy: c.carryPolicy,
    provenance: safeField(c.provenanceLabel, 160),
    how_it_reaches_this_year: safeField(c.carriedLabel, 160),
    reference_only: c.referenceOnly,
  };
}

function shapeHistory(r: TaxFactRow): Record<string, unknown> {
  return {
    key: safeField(r.factKey, 100),
    version: r.version,
    tax_year: r.taxYear,
    change: r.changeKind,
    value: safeField(formatFactValue(r), 160),
    source: r.sourceKind,
    source_ref: r.sourceRef === null ? null : safeField(r.sourceRef, 120),
    recorded_by: firstNameOf(r.setByName),
    recorded_on: isoDay(r.setAt),
    superseded: r.archivedAt !== null,
    // the owner's reason for a change / retirement / resolution (his own words), scrubbed
    reason: r.reason === null ? null : safeField(plainIds(r.reason), 240),
  };
}

export function shapeTaxFacts(rows: readonly TaxFactRow[], i: Input): ToolOutput {
  const year = i.tax_year ?? DEFAULT_YEAR;
  const category = i.category?.trim().toLowerCase();
  const prefix = i.key_prefix?.trim().toLowerCase();
  const resolved = resolveCarryForward(rows, year);
  const keep = (c: CarryItem): boolean => (category === undefined || c.category === category) && (prefix === undefined || c.factKey.toLowerCase().startsWith(prefix));

  let budget = MAX_FACTS;
  let total = 0;
  const groups: Record<string, Record<string, unknown>[]> = {};
  for (const [outName, inName] of GROUPS) {
    if (i.open_items_only === true && inName !== "openItems") continue;
    const items = resolved[inName].filter(keep);
    total += items.length;
    const take = items.slice(0, Math.max(0, budget));
    budget -= take.length;
    groups[outName] = take.map(shapeItem);
  }

  const shownKeys = new Set(Object.values(groups).flatMap((g) => g.map((x) => String(x.key))));
  const history =
    i.include_history === true
      ? rows
          .filter((r) => shownKeys.has(safeField(r.factKey, 100)) && r.taxYear <= year)
          .sort((a, b) => (a.factKey < b.factKey ? -1 : a.factKey > b.factKey ? 1 : a.version - b.version))
          .slice(0, MAX_HISTORY)
          .map(shapeHistory)
      : undefined;

  const shown = Object.values(groups).reduce((n, g) => n + g.length, 0);
  return {
    data: {
      tax_year: year,
      categories_available: [...FACT_CATEGORIES],
      groups,
      ...(history !== undefined ? { history } : {}),
      ...(total > shown ? { more: `${total - shown} more facts match; narrow with category or key_prefix.` } : {}),
      honesty:
        "These are facts the owner told the app; they are not verified by documents unless the provenance says so. Nothing here is a computed tax figure, and the TY2025 return does not read this store.",
    },
    rows: shown,
    total,
    links: [links.taxFacts(), links.taxFactsCarry(year + 1)],
  };
}

export function factsNotice(load: TaxFactsLoad): ToolOutput | null {
  switch (load.state) {
    case "ok":
      return null;
    case "table_missing":
      return { data: { available: false, message: "Tax facts are not available yet: the facts table has not been created in this database." }, links: [links.taxFacts()] };
    case "no_entity":
      return { data: { available: false, message: "Tax facts are not available: the Personal entity was not found." }, links: [links.taxFacts()] };
    default:
      return { data: { available: false, message: "Tax facts could not be read right now. Nothing was changed." }, links: [links.taxFacts()] };
  }
}

export const getTaxFactsTool = defineTool<Input>({
  name: "get_tax_facts",
  description:
    "The tax facts the owner confirmed (W-2 and interest details, estate, deeds, decisions X1/X5/X6/X7/X8, open items ...), read through the carry-forward resolver for a tax year (default 2025): already confirmed for that year, carried from an earlier year, needing re-confirmation, open items and values to ask fresh. Each fact says its source, the year and version it came from, and when it was confirmed. Filters: category, key_prefix, open_items_only; include_history adds each fact's earlier versions with the owner's reasons. Up to 80 facts.",
  inputJsonSchema: {
    type: "object",
    properties: {
      category: { type: "string", description: "Optional. A fact category: household, income, business, retirement, payments, property, estate, decision or open_item." },
      tax_year: { type: "integer", description: "Optional. The tax year to resolve the facts for, 2000 to 2100. Default 2025." },
      key_prefix: { type: "string", description: "Optional. Start of a fact key, for example household or decision.x1." },
      include_history: { type: "boolean", description: "Optional. true also lists earlier versions of the facts shown." },
      open_items_only: { type: "boolean", description: "Optional. true returns only the open items." },
    },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Reading confirmed tax facts",
  summarizeArgs: (i) => `year=${i.tax_year ?? DEFAULT_YEAR}${i.category !== undefined ? ", category" : ""}${i.key_prefix !== undefined ? ", key" : ""}${i.open_items_only === true ? ", open only" : ""}${i.include_history === true ? ", history" : ""}`,
  run: async (ctx, i) => {
    const load = await loadTaxFactsOnce(ctx);
    if (load.state !== "ok") return factsNotice(load) ?? { data: { available: false } };
    return shapeTaxFacts(load.rows, i);
  },
  maxChars: 12_000,
  phase: 1,
});
