// Tool: get_net_worth_history. Shaper is PURE and unit-tested.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { loadSnapshots, type SnapshotRow } from "@/lib/advisor/queries/net-worth";
import { dollarsOf, isoDay } from "@/lib/advisor/tools/format";
import { optional, parseInput } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const schema = z.object({ months: optional(z.number().int().min(1).max(36)) }).strict();
type Input = z.output<typeof schema>;

export function shapeNetWorth(rows: readonly SnapshotRow[]): ToolOutput {
  const asc = [...rows].sort((a, b) => a.date.getTime() - b.date.getTime());
  const points = asc.map((r) => ({
    date: isoDay(r.date),
    totalAssets: dollarsOf(r.totalAssetsCents),
    totalLiabilities: dollarsOf(r.totalLiabilitiesCents),
    netWorth: dollarsOf(r.netWorthCents),
  }));
  const first = asc[0];
  const last = asc[asc.length - 1];
  const change =
    first !== undefined && last !== undefined && asc.length > 1
      ? { from: isoDay(first.date), to: isoDay(last.date), netWorthChange: dollarsOf(last.netWorthCents - first.netWorthCents) }
      : null;
  return { data: { rows: points, change }, rows: points.length, links: [links.netWorth()] };
}

export const getNetWorthHistoryTool = defineTool<Input>({
  name: "get_net_worth_history",
  description:
    "Net worth snapshots over time: date, total assets, total liabilities and net worth, oldest first, with the change between the first and last point. Use it for 'how has our net worth changed'. months is 1 to 36 (default 12). Snapshots are stored periodically, so the points are not necessarily monthly.",
  inputJsonSchema: {
    type: "object",
    properties: { months: { type: "integer", description: "Optional. How many months back, 1 to 36. Default 12." } },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up net worth",
  summarizeArgs: (i) => `months=${i.months ?? 12}`,
  run: async (ctx, i) => {
    const months = i.months ?? 12;
    const since = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth() - months, ctx.now.getUTCDate()));
    return shapeNetWorth(await loadSnapshots(since, 36));
  },
  maxChars: LIMITS.toolResultChars,
  phase: 1,
});
