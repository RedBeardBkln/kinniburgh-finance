// Tool: search_transactions. The shaper is PURE and unit-tested; the filter / paging helpers are in transactions-filter.ts.

import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { searchTransactions, type TransactionRow, type TransactionSearchResult } from "@/lib/advisor/queries/transactions";
import { safeField } from "@/lib/advisor/scrub";
import { centsOf, dollarsOf, isoDay } from "@/lib/advisor/tools/format";
import { parseInput } from "@/lib/advisor/tools/parse";
import { encodePage, searchSchema, type SearchInput } from "@/lib/advisor/tools/transactions-filter";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const DEFAULT_LIMIT = 25;

export function shapeTransactions(result: Pick<TransactionSearchResult, "rows" | "matchCount" | "sumOutflow" | "sumInflow">, limit: number): ToolOutput {
  const pageRows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  const rows = pageRows.map((t: TransactionRow) => ({
    id: t.id,
    date: isoDay(t.postedAt),
    amount: dollarsOf(centsOf(t.amount)),
    payee: safeField(t.payeeRaw ?? t.payeeNormalized, 80),
    account: safeField(t.account.nickname, 60),
    entity: safeField(t.entity.name, 60),
    tags: t.tags.map((x) => safeField(x.tag.name, 80)).slice(0, 6),
    glCode: t.glCode === null ? null : safeField(`${t.glCode.code} ${t.glCode.name}`, 80),
    project: t.project === null ? null : safeField(t.project.name, 60),
    pending: t.pending,
    isTransfer: t.transferPairId !== null,
    note: t.notes === null || t.notes.trim() === "" ? null : safeField(t.notes, 160),
  }));
  const last = pageRows[pageRows.length - 1];
  const outflow = centsOf(result.sumOutflow);
  return {
    data: {
      rows,
      match_count: result.matchCount,
      // Totals cover the WHOLE match set (not just this page), as positive magnitudes.
      sum_outflow: outflow === null ? 0 : dollarsOf(Math.abs(outflow)),
      sum_inflow: dollarsOf(centsOf(result.sumInflow) ?? 0),
      next_page: hasMore && last !== undefined ? encodePage({ postedAt: last.postedAt, id: last.id }) : null,
    },
    rows: rows.length,
    total: result.matchCount,
    links: [links.transactions()],
  };
}

export const searchTransactionsTool = defineTool<SearchInput>({
  name: "search_transactions",
  description:
    "Searches transactions (newest first) with optional filters: date range, payee text, tag path text, entity (name or slug), account nickname text, amount magnitude range in dollars, direction, uncategorized only, and whether to include internal transfers (default excluded). Returns up to 25 rows per call (limit up to 50) plus match_count, sum_outflow and sum_inflow over the WHOLE match set, so never add rows up yourself. If next_page is set, pass it back as page to get the next rows. Amounts are negative for outflows. Dates are YYYY-MM-DD.",
  inputJsonSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Optional. Start date YYYY-MM-DD, inclusive." },
      to: { type: "string", description: "Optional. End date YYYY-MM-DD, inclusive." },
      payee: { type: "string", description: "Optional. Text the payee contains, case-insensitive." },
      tag: { type: "string", description: "Optional. Text the tag path contains, for example Groceries or Food & Drink." },
      entity: { type: "string", description: "Optional. Entity name or slug." },
      account: { type: "string", description: "Optional. Text the account nickname contains." },
      min_amount: { type: "number", description: "Optional. Smallest amount magnitude in dollars, 0 or more." },
      max_amount: { type: "number", description: "Optional. Largest amount magnitude in dollars." },
      direction: { type: "string", description: "Optional. One of outflow, inflow, any. Default any." },
      uncategorized: { type: "boolean", description: "Optional. true returns only transactions with no tag." },
      include_transfers: { type: "boolean", description: "Optional. true also returns internal transfers. Default false." },
      limit: { type: "integer", description: "Optional. Rows per call, 1 to 50. Default 25." },
      page: { type: "string", description: "Optional. The next_page value from the previous call." },
    },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(searchSchema, raw),
  label: "Looking up transactions",
  summarizeArgs: (i) => {
    const parts = [
      i.from !== undefined || i.to !== undefined ? `dates=${i.from ?? "any"} to ${i.to ?? "any"}` : "",
      i.payee !== undefined ? "payee" : "",
      i.tag !== undefined ? "tag" : "",
      i.entity !== undefined ? "entity" : "",
      i.account !== undefined ? "account" : "",
      i.min_amount !== undefined || i.max_amount !== undefined ? "amount" : "",
      i.direction !== undefined ? `direction=${i.direction}` : "",
      i.uncategorized === true ? "uncategorized" : "",
      i.page !== undefined ? "page" : "",
      `limit=${i.limit ?? DEFAULT_LIMIT}`,
    ].filter((p) => p !== "");
    return parts.join(", ");
  },
  run: async (_ctx, i) => {
    const limit = i.limit ?? DEFAULT_LIMIT;
    const result = await searchTransactions(i, limit);
    if (result.badPage) return { data: { rows: [], error: "That page value is not valid; repeat the search without page." }, rows: 0 };
    return shapeTransactions(result, limit);
  },
  maxChars: LIMITS.toolResultChars,
  phase: 1,
});
