// Document state machine and derived display state (plan section 7). PURE.
//
// STORED status is accounting only (invoice: draft -> issued -> void; quote: draft -> sent -> accepted |
// declined | converted, or void). There are no credit memos. Delivery (sentAt) is separate. "paid", "partially paid", "overdue" and "issued, not sent" are
// DERIVED here and never stored.

import type { DocumentKind } from "@/lib/invoicing/constants";

export type InvoiceStatus = "draft" | "issued" | "void";
export type QuoteStatus = "draft" | "sent" | "accepted" | "declined" | "void" | "converted";

const TRANSITIONS: Record<DocumentKind, Record<string, readonly string[]>> = {
  invoice: { draft: ["issued"], issued: ["void"], void: [] },
  quote: {
    draft: ["sent", "void"],
    sent: ["accepted", "declined", "converted", "void"],
    accepted: ["converted", "void"],
    declined: ["void"],
    converted: [],
    void: [],
  },
};

export function statusesOf(kind: DocumentKind): string[] {
  return Object.keys(TRANSITIONS[kind]);
}

export function canTransition(kind: DocumentKind, from: string, to: string): boolean {
  const allowed = TRANSITIONS[kind][from];
  return allowed !== undefined && allowed.includes(to);
}

/** The America/New_York calendar day of `now`, as a Date at 00:00 UTC (how every calendar day is stored). */
export function nyToday(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

export type InvoiceDisplayState = "draft" | "issued_unsent" | "sent" | "partially_paid" | "paid" | "void";

export interface InvoiceStateInput {
  status: string;
  sentAt: Date | null;
  totalCents: number;
  /** Sum of the non-void allocations (payments, i.e. deposits applied) to this invoice. */
  allocatedCents: number;
  dueDate: Date | null;
  /** nyToday(now). */
  today: Date;
}

export interface InvoiceDerived {
  state: InvoiceDisplayState;
  balanceCents: number;
  /** Balance > 0 and today is after the due date (due today is NOT overdue). Shown alongside sent / partially_paid. */
  overdue: boolean;
  daysPastDue: number;
}

export function deriveInvoiceState(input: InvoiceStateInput): InvoiceDerived {
  if (input.status === "draft") return { state: "draft", balanceCents: input.totalCents, overdue: false, daysPastDue: 0 };
  if (input.status === "void") return { state: "void", balanceCents: 0, overdue: false, daysPastDue: 0 };
  const balanceCents = Math.max(0, input.totalCents - input.allocatedCents);
  let state: InvoiceDisplayState;
  if (input.allocatedCents >= input.totalCents) state = "paid";
  else if (input.allocatedCents > 0) state = "partially_paid";
  else state = input.sentAt ? "sent" : "issued_unsent";
  const daysPastDue = input.dueDate && balanceCents > 0 ? Math.max(0, daysBetween(input.dueDate, input.today)) : 0;
  return { state, balanceCents, overdue: balanceCents > 0 && daysPastDue > 0, daysPastDue };
}

/** Whole calendar days from a to b (both dates at 00:00 UTC). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export const DISPLAY_STATE_LABELS: Record<InvoiceDisplayState, string> = {
  draft: "Draft",
  issued_unsent: "Issued, not sent",
  sent: "Sent",
  partially_paid: "Partially paid",
  paid: "Paid",
  void: "Void",
};

/** An issued invoice can be voided only when it has no active allocations (void or remove them first). */
export function canVoidInvoice(status: string, activeAllocationCount: number): { ok: true } | { ok: false; error: string } {
  if (status !== "issued") return { ok: false, error: "Only an issued invoice can be voided." };
  if (activeAllocationCount > 0) {
    return { ok: false, error: "This invoice has payments applied. Remove those applications first, then void the invoice." };
  }
  return { ok: true };
}

/** A payment can be voided only when none of its allocations is active (remove the applications first). */
export function canVoidPayment(status: string, activeAllocationCount: number): { ok: true } | { ok: false; error: string } {
  if (status !== "recorded") return { ok: false, error: "This payment is already void." };
  if (activeAllocationCount > 0) return { ok: false, error: "Remove this payment's applications to invoices first, then void it." };
  return { ok: true };
}
