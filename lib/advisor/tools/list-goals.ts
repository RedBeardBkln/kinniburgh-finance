// Tool: list_goals. Shaper is PURE and unit-tested.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { loadGoals, type GoalRow } from "@/lib/advisor/queries/goals";
import { safeField } from "@/lib/advisor/scrub";
import { dollarsOf, isoDay, percentOf } from "@/lib/advisor/tools/format";
import { optional, parseInput } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const schema = z.object({ status: optional(z.enum(["active", "achieved", "paused", "all"])) }).strict();
type Input = z.output<typeof schema>;

const PRIORITY = { 1: "high", 2: "medium", 3: "low" } as const;

export function shapeGoals(rows: readonly GoalRow[]): ToolOutput {
  const goals = rows.map((g) => ({
    title: safeField(g.title, 100),
    category: g.category,
    description: g.description === null ? null : safeField(g.description, 240),
    target: dollarsOf(g.targetAmountCents),
    current: dollarsOf(g.currentAmountCents),
    percent_complete: g.targetAmountCents !== null && g.targetAmountCents > 0 ? percentOf(g.currentAmountCents ?? 0, g.targetAmountCents) : null,
    target_date: isoDay(g.targetDate),
    priority: PRIORITY[g.priority as 1 | 2 | 3] ?? "medium",
    status: g.status,
    notes: g.notes === null ? null : safeField(g.notes, 240),
  }));
  return { data: { rows: goals }, rows: goals.length, links: [links.advisor()] };
}

export const listGoalsTool = defineTool<Input>({
  name: "list_goals",
  description:
    "Lists the household's financial goals shown in the Goals panel: title, category, target and current amounts, percent complete, target date, priority, status and owner notes. status is active (default), achieved, paused or all. Up to 50 goals.",
  inputJsonSchema: {
    type: "object",
    properties: { status: { type: "string", description: "Optional. One of active, achieved, paused, all. Default active." } },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up goals",
  summarizeArgs: (i) => `status=${i.status ?? "active"}`,
  run: async (_ctx, i) => shapeGoals(await loadGoals(i.status ?? "active", 50)),
  maxChars: LIMITS.toolResultChars,
  phase: 1,
});
