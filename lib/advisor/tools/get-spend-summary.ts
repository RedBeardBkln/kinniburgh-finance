// Tool: get_spend_summary. Shaper is PURE and unit-tested; the SQL is in queries/spend.ts.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { loadSpendGroups, loadSpendTotals, type SpendDirection, type SpendGroupBy, type SpendGroupRow, type SpendTotals } from "@/lib/advisor/queries/spend";
import { safeField } from "@/lib/advisor/scrub";
import { centsOf, dollarsOf, percentOf } from "@/lib/advisor/tools/format";
import { isoDate, optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { nextDay } from "@/lib/advisor/tools/transactions-filter";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const GROUPS = ["tag", "month", "entity", "account", "payee"] as const;
const MAX_SPAN_DAYS = 1_830;

const schema = z
  .object({
    from: isoDate,
    to: isoDate,
    group_by: z.enum(GROUPS),
    entity: optional(shortText),
    top_n: optional(z.number().int().min(1).max(30)),
    direction: optional(z.enum(["outflow", "inflow", "any"])),
  })
  .strict()
  .refine((v) => v.to >= v.from, { path: ["to"], message: "to before from" })
  .refine((v) => (new Date(`${v.to}T00:00:00Z`).getTime() - new Date(`${v.from}T00:00:00Z`).getTime()) / 86_400_000 <= MAX_SPAN_DAYS, { path: ["to"], message: "range too long" });
type Input = z.output<typeof schema>;

export function shapeSpend(groupBy: SpendGroupBy, groups: readonly SpendGroupRow[], totals: SpendTotals, range: { from: string; to: string }): ToolOutput {
  const totalOutflow = centsOf(totals.outflow) ?? 0;
  const rows = groups.map((g) => {
    const out = centsOf(g.outflow) ?? 0;
    const inn = centsOf(g.inflow) ?? 0;
    return {
      label: safeField(g.label ?? "(none)", 80),
      outflow: dollarsOf(out),
      inflow: dollarsOf(inn),
      net: dollarsOf(inn - out),
      tx_count: g.txCount,
      share_of_outflow_percent: groupBy === "month" ? null : percentOf(out, totalOutflow),
    };
  });
  const totalInflow = centsOf(totals.inflow) ?? 0;
  return {
    data: {
      range,
      group_by: groupBy,
      rows,
      totals: { outflow: dollarsOf(totalOutflow), inflow: dollarsOf(totalInflow), net: dollarsOf(totalInflow - totalOutflow), tx_count: totals.txCount },
      notes: [
        "Outflow and inflow are positive magnitudes. Internal transfers and archived transactions are excluded.",
        ...(groupBy === "tag" ? ["A transaction with several tags is counted under each tag, so tag rows can add up to more than the totals."] : []),
      ],
    },
    rows: rows.length,
    links: [links.transactions(), links.budgets()],
  };
}

export const getSpendSummaryTool = defineTool<Input>({
  name: "get_spend_summary",
  description:
    "Aggregated spending and income between two dates, grouped by tag, month, entity, account or payee, largest outflow first (months are in date order). Returns outflow, inflow, net and transaction count per group plus overall totals, excluding internal transfers. top_n limits the groups (1 to 30, default 15; months always list up to 60). The range may span at most five years. A transaction with several tags is counted under each tag.",
  inputJsonSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start date YYYY-MM-DD, inclusive." },
      to: { type: "string", description: "End date YYYY-MM-DD, inclusive." },
      group_by: { type: "string", description: "One of tag, month, entity, account, payee." },
      entity: { type: "string", description: "Optional. Entity name or slug to restrict to." },
      top_n: { type: "integer", description: "Optional. Number of groups to return, 1 to 30. Default 15." },
      direction: { type: "string", description: "Optional. One of outflow, inflow, any. Default any." },
    },
    required: ["from", "to", "group_by"],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Summarizing spending",
  summarizeArgs: (i) => `${i.from}..${i.to}, by ${i.group_by}, top ${i.top_n ?? 15}${i.entity !== undefined ? ", entity" : ""}`,
  run: async (_ctx, i) => {
    const groupBy: SpendGroupBy = i.group_by;
    const direction: SpendDirection = i.direction ?? "any";
    const q = {
      groupBy,
      from: new Date(`${i.from}T00:00:00Z`),
      to: nextDay(i.to),
      entity: i.entity ?? null,
      direction,
      limit: groupBy === "month" ? 60 : (i.top_n ?? 15),
    };
    const [groups, totals] = await Promise.all([loadSpendGroups(q), loadSpendTotals(q)]);
    return shapeSpend(groupBy, groups, totals, { from: i.from, to: i.to });
  },
  maxChars: LIMITS.toolResultChars,
  phase: 1,
});
