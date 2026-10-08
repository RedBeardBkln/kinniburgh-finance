// Tool: list_donations. Shaper is PURE and unit-tested; the read is queries/donations.ts (loadDonationsPage, read-only).
// No deduction is computed here or by the page: only the logged amounts and the substantiation flags are returned.

import { z } from "zod";
import { LIMITS } from "@/lib/advisor/config";
import { links } from "@/lib/advisor/links";
import { loadDonations, type DonationsPageView } from "@/lib/advisor/queries/donations";
import { safeDescriptive, safeField } from "@/lib/advisor/scrub";
import { dollarsOf, easternPeriod } from "@/lib/advisor/tools/format";
import { optional, parseInput } from "@/lib/advisor/tools/parse";
import { defineTool, type ToolOutput } from "@/lib/advisor/tools/types";

const MAX_ROWS = 100;
const MAX_UNLINKED = 10;

const schema = z.object({ year: optional(z.number().int().min(2000).max(2100)) }).strict();
type Input = z.output<typeof schema>;

/** The year before the current one (America/New_York): the year the household is usually asking about. */
export function defaultPriorYear(now: Date): number {
  return Number(easternPeriod(now).slice(0, 4)) - 1;
}

/**
 * Some receipt flags quote the charity letter's own benefit text. That text is deliberately not returned, so those flags use a fixed sentence;
 * every other flag message is a static sentence from the app.
 */
const FIXED_FLAG_MESSAGES: Readonly<Record<string, string>> = {
  receipt_goods_services:
    "The linked letter says goods or services were provided, so the deductible part of this gift may be reduced. The owner decides; this app does not compute a reduced amount.",
};

function flagOut(f: { code: string; message: string }): { code: string; message: string } {
  return { code: safeField(f.code, 60), message: FIXED_FLAG_MESSAGES[f.code] ?? safeField(f.message, 300) };
}

export function shapeDonations(view: DonationsPageView): ToolOutput {
  const rows = view.rows.slice(0, MAX_ROWS).map((r) => ({
    date: r.dateIso,
    recipient: safeDescriptive(r.recipient, 100),
    kind: safeField(r.kind, 20),
    amount: dollarsOf(r.amountCents),
    substantiation: safeField(r.substantiation, 40),
    has_receipt: r.receiptDocumentId !== null,
    flags: r.flags.map(flagOut),
  }));
  const unlinked = view.unlinkedReceipts.slice(0, MAX_UNLINKED).map((u) => ({ summary: safeDescriptive(u.summary, 120), verified: u.verified }));
  return {
    data: {
      year: view.year,
      none_confirmed: view.noneConfirmed,
      rows,
      ...(view.rows.length > MAX_ROWS ? { rows_truncated: true } : {}),
      year_flags: view.yearFlags.map(flagOut),
      totals: { cash: dollarsOf(view.totals.cashCents), noncash: dollarsOf(view.totals.noncashCents) },
      unlinked_receipts: { count: view.unlinkedReceipts.length, items: unlinked },
      notes: [
        "Totals are the amounts logged, not a deduction: no deductible amount is computed. A flag is advisory; the owner decides how a gift is treated.",
      ],
    },
    rows: rows.length,
    total: view.rows.length,
    links: [links.donations(view.year)],
  };
}

export const listDonationsTool = defineTool<Input>({
  name: "list_donations",
  description:
    "The household's charitable donation log for one calendar year: date, recipient, cash or non-cash, logged amount, how the gift is substantiated, whether a receipt is linked and any advisory flags, plus logged totals, whether the owner confirmed there were none, and donation receipts uploaded but not yet logged. year defaults to last calendar year. No deductible amount is computed.",
  inputJsonSchema: {
    type: "object",
    properties: { year: { type: "integer", description: "Optional. Calendar year, for example 2025. Default last calendar year." } },
    required: [],
    additionalProperties: false,
  },
  parse: (raw) => parseInput(schema, raw),
  label: "Looking up donations",
  summarizeArgs: (i) => `year=${i.year ?? "default"}`,
  run: async (ctx, i) => shapeDonations(await loadDonations(i.year ?? defaultPriorYear(ctx.now))),
  maxChars: LIMITS.toolResultChars,
  phase: 2,
});
