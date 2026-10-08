// Tool: get_financial_overview. The existing cheap snapshot (lib/advisor-context.ts) as ONE tool instead of a per-request prompt dump.
// Renter names are left out (names policy); the text goes through the framework's wording + scrubber like every tool result.

import { z } from "zod";
import { buildAdvisorContext } from "@/lib/advisor-context";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { parseInput } from "@/lib/advisor/tools/parse";
import { defineTool } from "@/lib/advisor/tools/types";

const schema = z.object({}).strict();
type Input = z.output<typeof schema>;

export const getFinancialOverviewTool = defineTool<Input>({
  name: "get_financial_overview",
  description:
    "A one-page text snapshot of the household's money as of now: active goals, account balances by entity, latest net worth, this month's budget versus spending, 30 and 90 day cash flow, top spending categories, regular income sources, recurring expenses, scheduled transfers, upcoming rental revenue and insurance premiums. Use it first for broad questions; use the specific tools for detail. Renter names are omitted. The text is cut at 16000 characters.",
  inputJsonSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  parse: (raw) => parseInput(schema, raw),
  label: "Reading the financial snapshot",
  summarizeArgs: () => "snapshot",
  run: async () => ({ data: await buildAdvisorContext({ omitGuestNames: true }), links: [links.accounts(), links.budgets(), links.forecast()] }),
  maxChars: LIMITS.overviewResultChars,
  phase: 1,
});
