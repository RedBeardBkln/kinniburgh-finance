// Tool: list_accounts. Shaper is PURE and unit-tested; the query is in queries/accounts.ts.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { loadAccounts, type AccountRow } from "@/lib/advisor/queries/accounts";
import { safeField } from "@/lib/advisor/scrub";
import { dollars, isoDay, isoDateTime } from "@/lib/advisor/tools/format";
import { optional, parseInput, shortText } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const MAX_ACCOUNTS = 60;

const schema = z.object({ entity: optional(shortText), include_archived: optional(z.boolean()) }).strict();
type Input = z.output<typeof schema>;

export function shapeAccounts(rows: readonly AccountRow[]): ToolOutput {
  const shaped = rows.map((a) => {
    const credit =
      a.accountType === "credit_card"
        ? {
            dueDate: isoDay(a.ccDueDate),
            statementBalance: dollars(a.ccStatementBalance),
            minimumPayment: dollars(a.ccMinimumPayment),
            apr: a.ccApr === null ? null : Number(a.ccApr.toString()),
          }
        : null;
    return {
      nickname: safeField(a.nickname, 80),
      institution: safeField(a.institution.name, 80),
      accountType: a.accountType,
      entity: safeField(a.entity.name, 80),
      // Last four digits only; anything longer than four digits is never echoed.
      last4: a.mask !== null && /^\d{4}$/.test(a.mask) ? a.mask : null,
      currentBalance: dollars(a.currentBalance),
      balanceAsOf: isoDateTime(a.currentBalanceAt),
      minimumBalance: dollars(a.minimumBalance),
      integrationMode: a.integrationMode,
      archived: a.archivedAt !== null,
      ...(credit !== null ? { creditCard: credit } : {}),
    };
  });
  return { data: { rows: shaped }, rows: shaped.length, links: [links.accounts()] };
}

export const listAccountsTool = defineTool<Input>({
  name: "list_accounts",
  description:
    "Lists the household's accounts with nickname, institution, type, entity (Personal or one of the three LLCs), last four digits, current balance and when it was last updated, minimum balance, and for credit cards the due date, statement balance, minimum payment and APR. Use it for balances and account questions; use get_net_worth_history for trends. Returns up to 60 accounts.",
  inputJsonSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Optional. Entity name or slug to filter by, for example Personal." },
      include_archived: { type: "boolean", description: "Optional. true also lists archived accounts. Default false." },
    },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up accounts",
  summarizeArgs: (i) => `entity=${i.entity === undefined ? "all" : "filtered"}, archived=${i.include_archived === true ? "yes" : "no"}`,
  run: async (_ctx, i) => shapeAccounts(await loadAccounts({ ...(i.entity !== undefined ? { entity: i.entity } : {}), includeArchived: i.include_archived === true, take: MAX_ACCOUNTS })),
  maxChars: LIMITS.toolResultChars,
  phase: 1,
});
