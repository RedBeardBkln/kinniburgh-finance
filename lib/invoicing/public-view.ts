// What the client's link page (/i/<token>) shows (plan P11). PURE: built from the same content as the invoice PDF, minus everything the
// client must never see there. The page renders ONLY this object.
//
// Shown: business name (dba first) and address, invoice number, dates, terms, the bill-to client NAME only, lines (description, quantity,
// rate, amount), subtotal, discount, total, paid, balance, client-visible notes, terms text, footer, the "Mail checks to" block, and the
// bank / ACH text ONLY when that invoice ticks "include bank details". Never: an EIN, internal notes, contacts or e-mail addresses, GL
// codes, payment details beyond "Paid $X", the timeline, Stripe ids.

import type { PdfInput } from "@/lib/invoicing/pdf/model";

export interface PublicInvoiceLine {
  description: string;
  quantityText: string;
  unitPriceCents: number;
  totalCents: number;
  detail: string | null;
}

export interface PublicInvoiceView {
  state: "open" | "paid" | "void";
  businessName: string;
  businessAddressLines: string[];
  displayNumber: string;
  issueDate: string | null;
  dueText: string;
  title: string | null;
  poNumber: string | null;
  billToName: string;
  lines: PublicInvoiceLine[];
  subtotalCents: number;
  discountLabel: string | null;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  notes: string | null;
  termsText: string | null;
  footerText: string | null;
  payableTo: string | null;
  mailingLines: string[];
  /** Empty unless the invoice ticks "include bank details". */
  bankLines: string[];
  /** "Pay online" is offered (online payments on and configured, a balance of at least the minimum due). */
  canPayOnline: boolean;
}

export function toPublicInvoiceView(input: PdfInput, opts: { canPayOnline: boolean }): PublicInvoiceView {
  const state: PublicInvoiceView["state"] = input.status === "void" ? "void" : input.balanceCents <= 0 ? "paid" : "open";
  return {
    state,
    businessName: input.business.dbaName?.trim() || input.business.name,
    businessAddressLines: [...input.business.addressLines],
    displayNumber: input.displayNumber ?? "",
    issueDate: input.issueDate,
    dueText: input.dueText,
    title: input.title,
    poNumber: input.poNumber,
    billToName: input.billTo.name,
    lines: input.lines.map((l) => ({
      description: l.description,
      quantityText: `${l.quantity}${l.unit ? ` ${l.unit}` : ""}`,
      unitPriceCents: l.unitPriceCents,
      totalCents: l.totalCents,
      detail: [l.workDate ? `Work date ${l.workDate}` : null, l.discountText].filter((x): x is string => Boolean(x)).join(" | ") || null,
    })),
    subtotalCents: input.subtotalCents,
    discountLabel: input.discountLabel,
    discountCents: input.discountCents,
    totalCents: input.totalCents,
    paidCents: state === "void" ? 0 : input.paidCents,
    balanceCents: state === "open" ? input.balanceCents : 0,
    notes: input.notes,
    termsText: input.termsText,
    footerText: input.footerText,
    payableTo: input.remit.payableTo,
    mailingLines: [...input.remit.mailingLines],
    bankLines: [...input.remit.bankLines],
    canPayOnline: state === "open" && opts.canPayOnline,
  };
}
