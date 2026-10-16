// Derived accrual books (plan D1). PURE. There is NO journal table: debit / credit entries are derived on demand from invoices,
// payments and allocations, so they cannot drift from the documents, and a bank Transaction is never written. Every
// scenario balances (debits == credit) by construction; ledger tests assert it. There are no credit memos (no refunds are ever
// given): a customer credit is a deposit on account, i.e. a payment not yet applied (Cr Unearned until it is applied).
//
// Accounts are keys: "role:ar" | "role:unearned" | "role:discounts" | "role:fees" | "role:cash" and "gl:<GlCode.id>" (a revenue line).
// "role:cash" stands for the bank side so the entries balance; it is NOT a GL account and never appears in a P&L.
//
// Entries (dated on the document's own dates; a void reverses at voidedAt so closed periods stay stable):
//   invoice issued       Dr A/R total, Dr Discounts invoiceDiscount, Cr revenue per line GL (line total after line discount)
//   payment recorded     Dr Cash (amount - fee), Dr Fees fee, Cr A/R for the part applied on or before the receipt day,
//                        Cr Unearned for the rest (a deposit on account: prepayment / overpayment)
//   later allocation     Dr Unearned, Cr A/R (on appliedOn)
//   allocation voided    Dr A/R, Cr Unearned (on voidedAt)
//   payment voided       Dr Unearned amount, Cr Cash net, Cr Fees fee (on voidedAt; its allocations were voided first)

export interface LedgerEntry {
  date: Date;
  account: string;
  debitCents: number;
  creditCents: number;
  /** The document or payment id the entry comes from. */
  sourceId: string;
  kind: "invoice" | "invoice_void" | "payment" | "payment_void" | "allocation" | "allocation_void";
}

export interface LedgerDoc {
  id: string;
  kind: "invoice";
  status: string; // draft | issued | void
  issueDate: Date | null;
  voidedAt: Date | null;
  totalCents: number;
  discountCents: number;
  lines: { glCodeId: string | null; lineTotalCents: number }[];
}

export interface LedgerAllocation {
  /** Allocations of this payment to invoices. */
  appliedOn: Date;
  amountCents: number;
  voidedAt: Date | null;
}

export interface LedgerPayment {
  id: string;
  receivedOn: Date;
  amountCents: number;
  feeCents: number;
  status: string; // recorded | void
  voidedAt: Date | null;
  allocations: LedgerAllocation[];
}

export const ACCOUNT_AR = "role:ar";
export const ACCOUNT_UNEARNED = "role:unearned";
export const ACCOUNT_DISCOUNTS = "role:discounts";
export const ACCOUNT_FEES = "role:fees";
export const ACCOUNT_CASH = "role:cash";
export const glAccount = (glCodeId: string) => `gl:${glCodeId}`;

const dr = (date: Date, account: string, cents: number, sourceId: string, kind: LedgerEntry["kind"]): LedgerEntry => ({ date, account, debitCents: cents, creditCents: 0, sourceId, kind });
const cr = (date: Date, account: string, cents: number, sourceId: string, kind: LedgerEntry["kind"]): LedgerEntry => ({ date, account, debitCents: 0, creditCents: cents, sourceId, kind });

function documentEntries(doc: LedgerDoc): LedgerEntry[] {
  if (doc.status === "draft" || !doc.issueDate) return [];
  const base: LedgerEntry[] = [];
  const add = (debit: boolean, account: string, cents: number) => {
    if (cents === 0) return;
    // A/R and Discounts are debits, revenue is credits.
    base.push(debit ? dr(doc.issueDate!, account, cents, doc.id, "invoice") : cr(doc.issueDate!, account, cents, doc.id, "invoice"));
  };
  add(true, ACCOUNT_AR, doc.totalCents);
  add(true, ACCOUNT_DISCOUNTS, doc.discountCents);
  for (const l of doc.lines) {
    if (l.glCodeId && l.lineTotalCents > 0) add(false, glAccount(l.glCodeId), l.lineTotalCents);
  }
  const out = [...base];
  if (doc.status === "void" && doc.voidedAt) {
    for (const e of base) {
      out.push({ date: doc.voidedAt, account: e.account, debitCents: e.creditCents, creditCents: e.debitCents, sourceId: doc.id, kind: "invoice_void" });
    }
  }
  return out;
}

function paymentEntries(p: LedgerPayment): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  const net = p.amountCents - p.feeCents;
  const recordTime = p.allocations.filter((a) => a.appliedOn.getTime() <= p.receivedOn.getTime());
  const later = p.allocations.filter((a) => a.appliedOn.getTime() > p.receivedOn.getTime());
  const recordTimeSum = recordTime.reduce((s, a) => s + a.amountCents, 0);
  if (net > 0) out.push(dr(p.receivedOn, ACCOUNT_CASH, net, p.id, "payment"));
  if (p.feeCents > 0) out.push(dr(p.receivedOn, ACCOUNT_FEES, p.feeCents, p.id, "payment"));
  for (const a of recordTime) out.push(cr(p.receivedOn, ACCOUNT_AR, a.amountCents, p.id, "payment"));
  const rest = p.amountCents - recordTimeSum;
  // `recordTime` includes allocations that were later voided (their void entry, Dr A/R / Cr Unearned, is dated at voidedAt), so after
  // "remove the application, apply again" on the receipt day the record-time sum can exceed the payment. The excess is a DEBIT to Unearned
  // on the receipt day (D-13): Unearned(t) = amount - allocations in force on t, for every t, and the entries always balance.
  if (rest > 0) out.push(cr(p.receivedOn, ACCOUNT_UNEARNED, rest, p.id, "payment"));
  else if (rest < 0) out.push(dr(p.receivedOn, ACCOUNT_UNEARNED, -rest, p.id, "payment"));
  for (const a of later) {
    out.push(dr(a.appliedOn, ACCOUNT_UNEARNED, a.amountCents, p.id, "allocation"));
    out.push(cr(a.appliedOn, ACCOUNT_AR, a.amountCents, p.id, "allocation"));
  }
  for (const a of p.allocations) {
    if (a.voidedAt) {
      out.push(dr(a.voidedAt, ACCOUNT_AR, a.amountCents, p.id, "allocation_void"));
      out.push(cr(a.voidedAt, ACCOUNT_UNEARNED, a.amountCents, p.id, "allocation_void"));
    }
  }
  if (p.status === "void" && p.voidedAt) {
    out.push(dr(p.voidedAt, ACCOUNT_UNEARNED, p.amountCents, p.id, "payment_void"));
    if (net > 0) out.push(cr(p.voidedAt, ACCOUNT_CASH, net, p.id, "payment_void"));
    if (p.feeCents > 0) out.push(cr(p.voidedAt, ACCOUNT_FEES, p.feeCents, p.id, "payment_void"));
  }
  return out;
}

export function deriveLedger(docs: readonly LedgerDoc[], payments: readonly LedgerPayment[]): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const d of docs) entries.push(...documentEntries(d));
  for (const p of payments) entries.push(...paymentEntries(p));
  return entries.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export function totalsOf(entries: readonly LedgerEntry[]): { debitCents: number; creditCents: number } {
  let debitCents = 0;
  let creditCents = 0;
  for (const e of entries) {
    debitCents += e.debitCents;
    creditCents += e.creditCents;
  }
  return { debitCents, creditCents };
}

/** The invariant every scenario must satisfy. */
export function isBalanced(entries: readonly LedgerEntry[]): boolean {
  const t = totalsOf(entries);
  return t.debitCents === t.creditCents;
}

/** Net debit-minus-credit balance per account up to and including `asOf` (null = all). */
export function balancesByAccount(entries: readonly LedgerEntry[], asOf: Date | null = null): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (asOf && e.date.getTime() > asOf.getTime()) continue;
    out.set(e.account, (out.get(e.account) ?? 0) + e.debitCents - e.creditCents);
  }
  return out;
}

/** Net of debits minus credits of an account in [from, to] (both inclusive, 00:00 UTC days). */
export function netInRange(entries: readonly LedgerEntry[], account: string, from: Date, to: Date): number {
  let sum = 0;
  for (const e of entries) {
    if (e.account !== account) continue;
    if (e.date.getTime() < from.getTime() || e.date.getTime() > to.getTime()) continue;
    sum += e.debitCents - e.creditCents;
  }
  return sum;
}
