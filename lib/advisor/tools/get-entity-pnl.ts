// Tool: get_entity_pnl. Shaper is PURE and unit-tested; the reads are in queries/pnl.ts (computePL, the business P&L page's own function).

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { findEntityByNameOrSlug, loadPnl, type PnlEntity, type PnlFacts, type PnlLineFacts } from "@/lib/advisor/queries/pnl";
import { safeField } from "@/lib/advisor/scrub";
import { centsOf, dollarsOf } from "@/lib/advisor/tools/format";
import { isoDate, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

export const MAX_PNL_SPAN_DAYS = 1_100;
export const MAX_PNL_LINES = 80;

const schema = z
  .object({ entity: shortText, from: isoDate, to: isoDate })
  .strict()
  .refine((v) => v.to >= v.from, { path: ["to"], message: "to before from" })
  .refine((v) => (new Date(`${v.to}T00:00:00Z`).getTime() - new Date(`${v.from}T00:00:00Z`).getTime()) / 86_400_000 <= MAX_PNL_SPAN_DAYS, { path: ["to"], message: "range too long" });
type Input = z.output<typeof schema>;

const NOTE =
  "Totals are positive magnitudes from the general-ledger (GL) codes on transactions: income is revenue codes, expenses are expense codes. Internal transfers are excluded. Only GL-coded transactions count, so the figures are as complete as the coding is.";

function lines(rows: readonly PnlLineFacts[]): { rows: { code: string; name: string; total: number | null }[]; truncated: boolean } {
  const shaped = rows.slice(0, MAX_PNL_LINES).map((l) => ({ code: safeField(l.code, 20), name: safeField(l.name, 80), total: dollarsOf(centsOf(l.total)) }));
  return { rows: shaped, truncated: rows.length > MAX_PNL_LINES };
}

export function shapePnl(entity: PnlEntity | null, range: { from: string; to: string }, facts: { pl: PnlFacts; uncodedCount: number } | null): ToolOutput {
  if (entity === null) {
    return { data: { supported: false, hint: "No entity with that name or slug. Use list_accounts to see the entity names, or get_spend_summary for spending across entities." }, rows: 0 };
  }
  if (entity.type !== "business" || facts === null) {
    return {
      data: {
        supported: false,
        entity: safeField(entity.name, 80),
        hint: "A GL-based profit and loss exists for the business entities only. For personal spending use get_spend_summary.",
      },
      rows: 0,
    };
  }
  const { pl, uncodedCount } = facts;
  const income = lines(pl.incomeLines);
  const expense = lines(pl.expenseLines);
  const ex = pl.excludedFromPL;
  const slug = entity.slug;
  const outLinks = slug !== null ? [links.business(slug, "pl"), links.business(slug, "gl")] : [links.transactions()];
  return {
    data: {
      supported: true,
      entity: safeField(entity.name, 80),
      range,
      income_lines: income.rows,
      expense_lines: expense.rows,
      ...(income.truncated || expense.truncated ? { lines_truncated: true } : {}),
      total_income: dollarsOf(centsOf(pl.totalIncome)),
      total_expenses: dollarsOf(centsOf(pl.totalExpenses)),
      net_income: dollarsOf(centsOf(pl.netIncome)),
      excluded_from_pl: {
        transaction_count: ex.transactionCount,
        net: dollarsOf(centsOf(ex.netAmount)),
        lines: ex.lines.slice(0, 20).map((l) => ({ code: safeField(l.code, 20), name: safeField(l.name, 80), type: safeField(l.type, 20), tx_count: l.transactionCount, total: dollarsOf(centsOf(l.total)) })),
      },
      uncoded_tx_count: uncodedCount,
      note: NOTE,
    },
    rows: income.rows.length + expense.rows.length,
    links: outLinks,
  };
}

export const getEntityPnlTool = defineTool<Input>({
  name: "get_entity_pnl",
  description:
    "Profit and loss for one business entity (Sudden Valley, EK Consulting or Mezzo) between two dates: income lines, expense lines, totals and net income, from the GL codes on its transactions, plus what was left off (balance-sheet codes) and how many transactions have no GL code yet. entity is a name or slug. The range may span at most about three years. Personal spending is not a GL P&L: use get_spend_summary for it.",
  inputJsonSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Entity name or slug, for example eric-kinniburgh-consulting." },
      from: { type: "string", description: "Start date YYYY-MM-DD, inclusive." },
      to: { type: "string", description: "End date YYYY-MM-DD, inclusive." },
    },
    required: ["entity", "from", "to"],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up the profit and loss",
  summarizeArgs: (i) => `entity=set, ${i.from}..${i.to}`,
  run: async (_ctx, i) => {
    const entity = await findEntityByNameOrSlug(i.entity);
    if (entity === null || entity.type !== "business") return shapePnl(entity, { from: i.from, to: i.to }, null);
    const facts = await loadPnl(entity.id, new Date(`${i.from}T00:00:00.000Z`), new Date(`${i.to}T23:59:59.999Z`));
    return shapePnl(entity, { from: i.from, to: i.to }, facts);
  },
  maxChars: LIMITS.toolResultChars,
  phase: 2,
});
