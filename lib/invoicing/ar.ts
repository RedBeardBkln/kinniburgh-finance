// Accounts receivable math (plan sections 7, 17). PURE. Balance of an invoice = total - sum of its non-void allocations (each one
// applies part of a payment, i.e. a deposit on account). "As of" views honour the dates: an allocation counts from `appliedOn`, and
// a later void/deallocation (voidedAt) only counts from that day on, so a closed period does not change when something is voided
// afterwards. There are no credit memos.

export interface ArInvoice {
  id: string;
  clientId: string;
  displayNumber: string | null;
  status: string; // draft | issued | void
  issueDate: Date | null;
  dueDate: Date | null;
  totalCents: number;
  voidedAt: Date | null;
}

export interface ArAllocation {
  invoiceId: string;
  amountCents: number;
  appliedOn: Date;
  voidedAt: Date | null;
}

const t = (d: Date) => d.getTime();

/** Whether an invoice exists on the books on `asOf` (issued on or before it, not voided on or before it). */
export function invoiceLiveAsOf(inv: ArInvoice, asOf: Date): boolean {
  if (inv.status === "draft" || !inv.issueDate) return false;
  if (t(inv.issueDate) > t(asOf)) return false;
  if (inv.status === "void" && inv.voidedAt && t(inv.voidedAt) <= t(asOf)) return false;
  return true;
}

/** Sum of the allocations in force on `asOf` for one invoice. */
export function allocatedAsOf(invoiceId: string, allocations: readonly ArAllocation[], asOf: Date): number {
  let sum = 0;
  for (const a of allocations) {
    if (a.invoiceId !== invoiceId) continue;
    if (t(a.appliedOn) > t(asOf)) continue;
    if (a.voidedAt && t(a.voidedAt) <= t(asOf)) continue;
    sum += a.amountCents;
  }
  return sum;
}

/** Open balance of one invoice on `asOf` (0 when it is not live, paid or over-covered). */
export function invoiceBalanceAsOf(inv: ArInvoice, allocations: readonly ArAllocation[], asOf: Date): number {
  if (!invoiceLiveAsOf(inv, asOf)) return 0;
  return Math.max(0, inv.totalCents - allocatedAsOf(inv.id, allocations, asOf));
}

export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: "Current",
  d1_30: "1-30 days",
  d31_60: "31-60 days",
  d61_90: "61-90 days",
  d90_plus: "Over 90 days",
};

/** Bucket by days past DUE date: <= 0 current; 1-30; 31-60; 61-90; 91 and more. */
export function agingBucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "d1_30";
  if (daysPastDue <= 60) return "d31_60";
  if (daysPastDue <= 90) return "d61_90";
  return "d90_plus";
}

export type BucketTotals = Record<AgingBucket, number> & { totalCents: number };
const emptyBuckets = (): BucketTotals => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, totalCents: 0 });

export interface AgingInvoiceRow {
  invoiceId: string;
  clientId: string;
  displayNumber: string | null;
  dueDate: Date | null;
  balanceCents: number;
  daysPastDue: number;
  bucket: AgingBucket;
}

export interface AgingReport {
  asOf: Date;
  rows: AgingInvoiceRow[];
  byClient: Map<string, BucketTotals>;
  totals: BucketTotals;
}

export function buildAging(invoices: readonly ArInvoice[], allocations: readonly ArAllocation[], asOf: Date): AgingReport {
  const rows: AgingInvoiceRow[] = [];
  const byClient = new Map<string, BucketTotals>();
  const totals = emptyBuckets();
  for (const inv of invoices) {
    const balance = invoiceBalanceAsOf(inv, allocations, asOf);
    if (balance <= 0) continue;
    const due = inv.dueDate ?? inv.issueDate;
    const daysPastDue = due ? Math.round((t(asOf) - t(due)) / 86_400_000) : 0;
    const bucket = agingBucketFor(daysPastDue);
    rows.push({ invoiceId: inv.id, clientId: inv.clientId, displayNumber: inv.displayNumber, dueDate: inv.dueDate, balanceCents: balance, daysPastDue, bucket });
    const c = byClient.get(inv.clientId) ?? emptyBuckets();
    c[bucket] += balance;
    c.totalCents += balance;
    byClient.set(inv.clientId, c);
    totals[bucket] += balance;
    totals.totalCents += balance;
  }
  rows.sort((a, b) => b.daysPastDue - a.daysPastDue || (a.displayNumber ?? "").localeCompare(b.displayNumber ?? ""));
  return { asOf, rows, byClient, totals };
}

/** What is left of a payment (a deposit on account) after its non-void allocations. Never negative. */
export function unallocatedRemainder(amountCents: number, allocationAmountsCents: readonly number[]): number {
  return Math.max(0, amountCents - allocationAmountsCents.reduce((s, a) => s + a, 0));
}

export interface DepositSource {
  clientId: string;
  amountCents: number;
  /** Non-void allocation amounts of this payment. */
  allocationAmountsCents: readonly number[];
  active: boolean; // not void
}

/** Deposits on account = the unapplied remainders of the client's recorded payments (prepayments and overpayments), per client. */
export function depositsOnAccount(sources: readonly DepositSource[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sources) {
    if (!s.active) continue;
    const r = unallocatedRemainder(s.amountCents, s.allocationAmountsCents);
    if (r > 0) out.set(s.clientId, (out.get(s.clientId) ?? 0) + r);
  }
  return out;
}

/** Whether `addCents` more can be allocated to an invoice (balance now) or from a source (remainder now). */
export function canAllocate(addCents: number, invoiceBalanceCents: number, sourceRemainderCents: number): { ok: true } | { ok: false; error: string } {
  if (!Number.isSafeInteger(addCents) || addCents <= 0) return { ok: false, error: "The amount applied must be greater than zero." };
  if (addCents > invoiceBalanceCents) return { ok: false, error: "That is more than the invoice balance." };
  if (addCents > sourceRemainderCents) return { ok: false, error: "That is more than what is left of this payment." };
  return { ok: true };
}
