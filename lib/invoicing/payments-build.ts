// Read-only loaders for payments, deposits on account, open invoices and bank-deposit candidates. No writes, explicit selects, soft-delete
// guards on every Transaction read, plain strings / integer cents out (the Transaction Decimal is converted at this boundary).

import { db } from "@/lib/db";
import { decimalToCents } from "@/lib/invoicing/cents";
import { scoreDeposits, type DepositCandidate } from "@/lib/invoicing/deposit-match";
import { DEPOSIT_WINDOW_DAYS } from "@/lib/invoicing/constants";
import { toIsoDate } from "@/lib/invoicing/validate";

export interface PaymentAllocationView {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  amountCents: number;
  appliedOn: string;
}

export interface PaymentView {
  id: string;
  clientId: string;
  clientName: string;
  method: string;
  receivedOn: string;
  amountCents: number;
  feeCents: number;
  reference: string | null;
  status: string;
  voidReason: string | null;
  depositTransactionId: string | null;
  deposit: { id: string; postedAt: string; amountCents: number; archived: boolean } | null;
  allocations: PaymentAllocationView[];
  /** The part of the payment not yet applied to an invoice: a deposit on account (zero for a void payment). */
  unappliedDepositCents: number;
}

const PAYMENT_SELECT = {
  id: true,
  clientId: true,
  method: true,
  receivedOn: true,
  amountCents: true,
  feeCents: true,
  reference: true,
  status: true,
  voidReason: true,
  depositTransactionId: true,
  client: { select: { name: true } },
  depositTransaction: { select: { id: true, postedAt: true, amount: true, archivedAt: true } },
  allocations: {
    where: { voidedAt: null },
    select: { id: true, invoiceId: true, amountCents: true, appliedOn: true, invoice: { select: { displayNumber: true } } },
    orderBy: { appliedOn: "asc" as const },
  },
} as const;

type PaymentRow = Awaited<ReturnType<typeof loadPaymentRows>>[number];

async function loadPaymentRows(entityId: string, where: { clientId?: string; id?: string }) {
  return db.billingPayment.findMany({ where: { entityId, ...where }, select: PAYMENT_SELECT, orderBy: [{ receivedOn: "desc" }, { createdAt: "desc" }], take: 500 });
}

function toView(r: PaymentRow): PaymentView {
  const allocated = r.allocations.reduce((s, a) => s + a.amountCents, 0);
  const dep = r.depositTransaction;
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: r.client.name,
    method: r.method,
    receivedOn: toIsoDate(r.receivedOn),
    amountCents: r.amountCents,
    feeCents: r.feeCents,
    reference: r.reference,
    status: r.status,
    voidReason: r.voidReason,
    depositTransactionId: r.depositTransactionId,
    deposit: dep ? { id: dep.id, postedAt: toIsoDate(dep.postedAt), amountCents: decimalToCents(dep.amount), archived: dep.archivedAt !== null } : null,
    allocations: r.allocations.map((a) => ({ id: a.id, invoiceId: a.invoiceId, invoiceNumber: a.invoice.displayNumber, amountCents: a.amountCents, appliedOn: toIsoDate(a.appliedOn) })),
    unappliedDepositCents: r.status === "recorded" ? Math.max(0, r.amountCents - allocated) : 0,
  };
}

export async function loadClientPayments(entityId: string, clientId: string): Promise<PaymentView[]> {
  return (await loadPaymentRows(entityId, { clientId })).map(toView);
}

export async function loadPayment(entityId: string, id: string): Promise<PaymentView | null> {
  const rows = await loadPaymentRows(entityId, { id });
  return rows[0] ? toView(rows[0]) : null;
}

export interface OpenInvoice {
  id: string;
  displayNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalCents: number;
  balanceCents: number;
}

/** The client's issued invoices that still have a balance (what a new payment can be applied to). */
export async function loadOpenInvoices(entityId: string, clientId: string): Promise<OpenInvoice[]> {
  const rows = await db.billingDocument.findMany({
    where: { entityId, clientId, kind: "invoice", status: "issued" },
    select: { id: true, displayNumber: true, issueDate: true, dueDate: true, totalCents: true, number: true, allocations: { where: { voidedAt: null }, select: { amountCents: true } } },
    orderBy: { number: "asc" },
  });
  return rows
    .map((r) => ({
      id: r.id,
      displayNumber: r.displayNumber,
      issueDate: r.issueDate ? toIsoDate(r.issueDate) : null,
      dueDate: r.dueDate ? toIsoDate(r.dueDate) : null,
      totalCents: r.totalCents,
      balanceCents: r.totalCents - r.allocations.reduce((s, a) => s + a.amountCents, 0),
    }))
    .filter((r) => r.balanceCents > 0);
}

export interface DepositCandidateView {
  transactionId: string;
  postedAt: string;
  amountCents: number;
  text: string;
  remainingCents: number;
  score: number;
  reasons: string[];
}

/**
 * Bank deposits that could settle a payment, best match first. Only positive, posted (not pending), non-archived, non-transfer rows of the entity within
 * a date window of the receipt; a deposit already fully used by other recorded payments is not offered. The owner always confirms.
 */
export async function loadDepositCandidates(
  entityId: string,
  payment: { amountCents: number; feeCents: number; receivedOn: Date; clientName: string; paymentId: string | null }
): Promise<DepositCandidateView[]> {
  const from = new Date(payment.receivedOn.getTime() - DEPOSIT_WINDOW_DAYS * 86_400_000);
  const to = new Date(payment.receivedOn.getTime() + DEPOSIT_WINDOW_DAYS * 86_400_000);
  const rows = await db.transaction.findMany({
    // pending: false - a pending row is replaced by a new id when it posts, so a link to it would go stale (see store.checkDeposit).
    where: { entityId, archivedAt: null, transferPairId: null, pending: false, amount: { gt: 0 }, postedAt: { gte: from, lte: to } },
    select: { id: true, postedAt: true, amount: true, payeeRaw: true, description: true },
    orderBy: { postedAt: "desc" },
    take: 200,
  });
  if (rows.length === 0) return [];
  const linked = await db.billingPayment.findMany({
    where: { depositTransactionId: { in: rows.map((r) => r.id) }, status: "recorded", ...(payment.paymentId ? { id: { not: payment.paymentId } } : {}) },
    select: { depositTransactionId: true, amountCents: true, feeCents: true },
  });
  const linkedNet = new Map<string, number>();
  for (const l of linked) {
    if (l.depositTransactionId) linkedNet.set(l.depositTransactionId, (linkedNet.get(l.depositTransactionId) ?? 0) + l.amountCents - l.feeCents);
  }
  const candidates: DepositCandidate[] = rows.map((r) => ({
    transactionId: r.id,
    postedAt: r.postedAt,
    amountCents: decimalToCents(r.amount),
    text: `${r.payeeRaw ?? ""} ${r.description ?? ""}`.trim(),
    alreadyLinkedNetCents: linkedNet.get(r.id) ?? 0,
  }));
  const scored = scoreDeposits({ amountCents: payment.amountCents, feeCents: payment.feeCents, receivedOn: payment.receivedOn, clientName: payment.clientName }, candidates);
  const byId = new Map(candidates.map((c) => [c.transactionId, c]));
  return scored.slice(0, 15).map((s) => {
    const c = byId.get(s.transactionId)!;
    return { transactionId: c.transactionId, postedAt: toIsoDate(c.postedAt), amountCents: c.amountCents, text: c.text.slice(0, 80), remainingCents: s.remainingCents, score: s.score, reasons: s.reasons };
  });
}
