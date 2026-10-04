// SYNTHETIC fixtures for the T3 (Schedule B, Form 8995, Form 8959) and T5 (CT-1040) map
// tests. Every name and number is invented ("Alex Example", "Payer 3 Bank"); nothing is
// read from, or resembles, the real return. Money is whole dollars.

import { lineMeta } from "@/lib/tax2025/line-catalog";
import type { LineKey, RuleStatus } from "@/lib/tax2025/types";
import type { PdfFormRequirement, PdfLine, PdfReturnView, PdfTableRow, TableKey } from "@/lib/tax2025/pdf/types";
import { makeView, pdfLine, type ViewOptions } from "./tax2025-pdf-view.fixture";

/** A PdfLine for a real engine key, labelled from the real line catalog. */
export function engineLine(key: LineKey, amount: number | null, status: RuleStatus = "computed", reason: string | null = null): PdfLine {
  const meta = lineMeta(key);
  return pdfLine({ key, formLabel: meta.form, formLine: meta.formLine, label: meta.label, amount, status, reason });
}

export function linesOf(entries: ReadonlyArray<readonly [LineKey, number | null] | PdfLine>): Partial<Record<LineKey, PdfLine>> {
  const out: Partial<Record<LineKey, PdfLine>> = {};
  for (const e of entries) {
    const line = Array.isArray(e) ? engineLine(e[0] as LineKey, e[1] as number | null) : (e as PdfLine);
    out[line.key as LineKey] = line;
  }
  return out;
}

/** n synthetic payer rows: amount_i = 100 * i + 7 (distinct, never zero). */
export function payerRows(n: number, label = "Payer"): PdfTableRow[] {
  const rows: PdfTableRow[] = [];
  for (let i = 1; i <= n; i++) rows.push({ cells: { payer: `${label} ${i} Bank`, amount: 100 * i + 7 } });
  return rows;
}

export function sumAmounts(rows: readonly PdfTableRow[], column = "amount"): number {
  let total = 0;
  for (const r of rows) {
    const v = r.cells[column];
    if (typeof v === "number") total += v;
  }
  return total;
}

export function required(value: boolean | "blocking", reason = "synthetic engine verdict"): PdfFormRequirement {
  return { required: value, reason };
}

export function viewWith(opts: ViewOptions & { tables?: Partial<Record<TableKey, PdfTableRow[]>>; formsRequired?: PdfReturnView["formsRequired"] }): PdfReturnView {
  const { formsRequired, ...rest } = opts;
  const view = makeView(rest);
  return formsRequired === undefined ? view : { ...view, formsRequired };
}
