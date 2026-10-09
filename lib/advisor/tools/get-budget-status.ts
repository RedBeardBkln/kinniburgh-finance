// Tool: get_budget_status. Shaper is PURE and unit-tested; loading and resolution are in queries/budgets.ts.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { loadBudgetFacts, type BudgetLineFacts } from "@/lib/advisor/queries/budgets";
import { safeField } from "@/lib/advisor/scrub";
import { centsOf, dollarsOf, easternPeriod, percentOf, periodBounds } from "@/lib/advisor/tools/format";
import { optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const MAX_LINES = 120;

const schema = z.object({ period: optional(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)), entity: optional(shortText) }).strict();
type Input = z.output<typeof schema>;

export function shapeBudgets(period: string, lines: readonly BudgetLineFacts[]): ToolOutput {
  let totalBudgeted = 0;
  let totalSpent = 0;
  const rows = lines.slice(0, MAX_LINES).map((l) => {
    const budgeted = centsOf(l.budgeted) ?? 0;
    const rollover = l.rolloverEnabled ? (centsOf(l.rolloverAmount) ?? 0) : 0;
    const spent = centsOf(l.spent) ?? 0;
    const available = budgeted + rollover;
    if (l.isRoot) totalBudgeted += budgeted;
    totalSpent += spent;
    return {
      tag: safeField(l.tagPath, 80),
      name: safeField(l.shortName, 60),
      entity: safeField(l.entity, 60),
      frequency: l.frequency,
      budgeted: dollarsOf(budgeted),
      rollover_in: l.rolloverEnabled ? dollarsOf(rollover) : null,
      spent: dollarsOf(spent),
      remaining: dollarsOf(available - spent),
      percent_used: percentOf(spent, available),
      overspent: available - spent < 0,
      auto_summed_from_children: l.autoSummed,
      ...(l.carriedFrom ? { carried_from: l.carriedFrom } : {}),
    };
  });
  const anyCarried = lines.slice(0, MAX_LINES).some((l) => Boolean(l.carriedFrom));
  return {
    data: {
      period,
      rows,
      totals: { budgeted_root_lines_only: dollarsOf(totalBudgeted), spent_all_lines: dollarsOf(totalSpent), remaining: dollarsOf(totalBudgeted - totalSpent) },
      notes: [
        "Budgeted amounts are monthly. Lines nested under a parent are auto-summed where the parent has no amount of its own, and totals use root lines only so nothing is double counted.",
        "Spent is net outflow on that exact tag and entity for the month, excluding internal transfers. This can differ from the Budgets page for lines linked to recurring expenses.",
        ...(anyCarried
          ? [
              "Rows with carried_from have no budget row of their own for this month: the figures are the latest earlier month's row for that line, carried forward at read time (rollover and one-off additional amounts are not carried). The Budgets page shows nothing for that month until lines are added there. Electric, oil and firewood lines are not carried yet.",
            ]
          : []),
      ],
      ...(lines.length > MAX_LINES ? { omitted_lines: lines.length - MAX_LINES } : {}),
    },
    rows: rows.length,
    total: lines.length,
    links: [links.budgets()],
  };
}

export const getBudgetStatusTool = defineTool<Input>({
  name: "get_budget_status",
  description:
    "Budget versus actual spending for one month: per budget line the tag, entity, monthly budget, rollover carried in, spent, remaining, percent used and whether it is overspent, plus totals. Defaults to the current month (America/New_York); period is YYYY-MM; entity (name or slug) is optional. May differ from the Budgets page for lines linked to recurring expenses. Up to 120 lines.",
  inputJsonSchema: {
    type: "object",
    properties: {
      period: { type: "string", description: "Optional. Month as YYYY-MM. Default the current month." },
      entity: { type: "string", description: "Optional. Entity name or slug to restrict to." },
    },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Checking budgets",
  summarizeArgs: (i) => `period=${i.period ?? "current"}${i.entity !== undefined ? ", entity" : ""}`,
  run: async (ctx, i) => {
    const period = i.period ?? easternPeriod(ctx.now);
    const bounds = periodBounds(period);
    if (bounds === null) return { data: { rows: [], error: "Invalid period; use YYYY-MM." }, rows: 0 };
    return shapeBudgets(period, await loadBudgetFacts(period, bounds, i.entity ?? null));
  },
  maxChars: LIMITS.toolResultChars,
  phase: 1,
});
