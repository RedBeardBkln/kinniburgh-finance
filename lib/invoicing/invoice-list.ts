// Pure rules for the Invoices list: which rows the default list shows and which are kept behind "Show archived".
// "Archived" on that list means a voided invoice or a draft the owner archived; both are hidden by default.

import type { InvoiceRow } from "@/lib/invoicing/documents-build";

export interface InvoiceListRow extends InvoiceRow {
  /** True for a draft the owner archived: it has no detail page, so the list shows it without a link. */
  archivedDraft: boolean;
}

export interface InvoiceListView {
  /** The rows to render, newest first as loaded (live rows, then the archived ones when shown). */
  rows: InvoiceListRow[];
  /** How many void invoices plus archived drafts exist (the toggle shows this count). */
  hiddenCount: number;
  /** True when there are no invoices at all, archived or not. */
  empty: boolean;
}

export function buildInvoiceList(live: InvoiceRow[], archivedDrafts: InvoiceRow[], showArchived: boolean): InvoiceListView {
  const active: InvoiceListRow[] = [];
  const archived: InvoiceListRow[] = [];
  for (const r of live) (r.status === "void" ? archived : active).push({ ...r, archivedDraft: false });
  for (const r of archivedDrafts) archived.push({ ...r, archivedDraft: true });
  return {
    rows: showArchived ? [...active, ...archived] : active,
    hiddenCount: archived.length,
    empty: active.length === 0 && archived.length === 0,
  };
}

/** Reads the `?archived=1` query value; anything else means hidden. */
export function parseShowArchived(value: string | string[] | undefined): boolean {
  return (Array.isArray(value) ? value[0] : value) === "1";
}
