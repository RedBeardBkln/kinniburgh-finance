// Turns a stored invoice (as the pages see it) back into the editor's DraftInput shape, so the server can re-validate a saved draft in
// strict mode at issue time and duplicate an invoice into a new draft. PURE.

import type { InvoiceDetail } from "@/lib/invoicing/documents-build";
import type { DraftInput } from "@/lib/invoicing/validate";

const dollars = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export function detailToDraftInput(d: InvoiceDetail, opts: { forDuplicate?: boolean } = {}): DraftInput {
  return {
    clientId: d.clientId,
    billingModel: d.billingModel,
    title: d.title,
    poNumber: opts.forDuplicate ? null : d.poNumber,
    issueDate: opts.forDuplicate ? null : d.issueDate,
    netDays: opts.forDuplicate ? null : d.netDays,
    notes: d.notes,
    internalNotes: opts.forDuplicate ? null : d.internalNotes,
    discountKind: d.discountKind,
    discountValue: d.discountValueText || null,
    includeRemitTo: d.includeRemitTo,
    showEin: d.showEin,
    lines: d.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: dollars(l.unitPriceCents),
      discountKind: l.discountKind,
      discountValue: l.discountValueText || null,
      glCodeId: l.glCodeId,
      taxable: l.taxable,
      workDate: opts.forDuplicate ? null : l.workDate,
      itemId: l.itemId,
      unitCostCents: l.unitCostCents,
      markupBps: l.markupBps,
      costTransactionId: opts.forDuplicate ? null : l.costTransactionId,
      receiptId: opts.forDuplicate ? null : l.receiptId,
    })),
  };
}
