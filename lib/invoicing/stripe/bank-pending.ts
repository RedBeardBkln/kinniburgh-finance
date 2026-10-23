// A US bank (ACH) payment that is still processing (.claude/pipeline/stripe-ach-pending-hide-pay/01-plan.md). PURE: no DB, no network,
// no clock ("today" is passed in).
//
// Source of truth: the "bank_payment_pending" BillingEvent the Stripe webhook writes when a Checkout Session completes "unpaid" (data
// { amountCents, paymentIntentId, livemode }). A pending row is CLOSED when
//   a. a BillingPayment (any status) carries its PaymentIntent (the async success, a duplicate or a race with a paid card session), or
//   b. an "ach_failed" stripe_flag carries its PaymentIntent (the async failure), or
//   c. the owner's "bank_payment_released" row names it ("Stop waiting for this payment").
// Keying on the PaymentIntent makes the result independent of the order Stripe delivers events in.
//
// While ANY open row exists for an invoice, "Pay online" is hidden everywhere (no "pay the remainder"). A row older than
// BANK_PENDING_CAP_BUSINESS_DAYS business days is only LABELLED overdue: it still blocks, because a lost success event would otherwise
// invite a second payment. Rows of the other Stripe mode (test vs live) are ignored while a mode is configured.

import { BANK_PENDING_CAP_BUSINESS_DAYS } from "@/lib/invoicing/constants";
import { formatCents } from "@/lib/invoicing/money";
import { nyToday } from "@/lib/invoicing/state";

/** One "bank_payment_pending" timeline row, with its data parsed (unknown or malformed values are null). */
export interface PendingRow {
  id: string;
  documentId: string | null;
  /** The row's createdAt (ISO timestamp). */
  createdAt: string;
  amountCents: number | null;
  paymentIntentId: string | null;
  livemode: boolean | null;
}

/** A BillingEvent row as a loader reads it. */
export interface RawEventRow {
  id: string;
  kind: string;
  documentId: string | null;
  createdAt: string;
  data: Record<string, unknown>;
}

export interface BankPendingItem {
  id: string;
  amountCents: number | null;
  /** New York calendar day the payment started, YYYY-MM-DD. */
  startedOn: string;
  overdue: boolean;
  livemode: boolean | null;
}

export interface BankPendingState {
  /** Oldest first. */
  items: BankPendingItem[];
  /** The sum of the items, or null when any amount is unknown. */
  totalCents: number | null;
  /** The earliest start. */
  startedOn: string;
  /** Any item is overdue. */
  overdue: boolean;
}

export interface DeriveInput {
  pending: readonly PendingRow[];
  paidIntents: ReadonlySet<string>;
  failedIntents: ReadonlySet<string>;
  releasedIds: ReadonlySet<string>;
  mode: "test" | "live" | null;
  /** Today as a New York calendar date at 00:00 UTC (lib/invoicing/state.ts#nyToday). */
  today: Date;
  cap?: number;
}

const ID_LIKE = /^[A-Za-z0-9_:.\-]{1,80}$/;

/** A Stripe id that the timeline may store (an id-like token of at most 80 characters), else null (the field is then omitted). */
export function safeStripeIdOrNull(v: unknown): string | null {
  return typeof v === "string" && ID_LIKE.test(v) ? v : null;
}

/** Parses a "bank_payment_pending" row. Wrong types give nulls (an open row with an unknown amount), never a throw. */
export function pendingRowFromEvent(r: RawEventRow): PendingRow {
  const d = r.data;
  return {
    id: r.id,
    documentId: r.documentId,
    createdAt: r.createdAt,
    amountCents: typeof d.amountCents === "number" && Number.isSafeInteger(d.amountCents) && d.amountCents > 0 ? d.amountCents : null,
    paymentIntentId: safeStripeIdOrNull(d.paymentIntentId),
    livemode: typeof d.livemode === "boolean" ? d.livemode : null,
  };
}

/** PaymentIntents of failed bank payments: "stripe_flag" rows with reason "ach_failed" that carry one. */
export function failedIntentsFrom(rows: readonly RawEventRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "stripe_flag" || r.data.reason !== "ach_failed") continue;
    const pi = safeStripeIdOrNull(r.data.paymentIntentId);
    if (pi) out.add(pi);
  }
  return out;
}

/** Ids of pending rows the owner released ("bank_payment_released" rows, data.pendingEventId). */
export function releasedIdsFrom(rows: readonly RawEventRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "bank_payment_released") continue;
    if (typeof r.data.pendingEventId === "string" && r.data.pendingEventId !== "") out.add(r.data.pendingEventId);
  }
  return out;
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(iso: string): Date | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/** The calendar date `n` business days (Mon-Fri, no holidays) after `isoDate`. A weekend start counts from the next Monday. */
export function addBusinessDays(isoDate: string, n: number): string {
  const start = parseIsoDate(isoDate);
  if (!start) throw new Error("not a calendar date");
  let t = start.getTime();
  let left = Math.max(0, Math.floor(n));
  while (left > 0) {
    t += DAY_MS;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return isoOf(new Date(t));
}

/** True when `today` (YYYY-MM-DD) is after the date `cap` business days after `startedOn`. */
export function isOverdue(startedOn: string, today: string, cap: number = BANK_PENDING_CAP_BUSINESS_DAYS): boolean {
  return today > addBusinessDays(startedOn, cap);
}

/** The New York calendar day (YYYY-MM-DD) of an ISO timestamp. */
export function nyDayOf(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return "1970-01-01";
  return isoOf(nyToday(d));
}

function rowCounts(livemode: boolean | null, mode: "test" | "live" | null): boolean {
  if (mode === null || livemode === null) return true;
  return livemode === (mode === "live");
}

/** The open bank payments per invoice. Invoices with none are absent from the map. */
export function deriveBankPending(input: DeriveInput): Map<string, BankPendingState> {
  const cap = input.cap ?? BANK_PENDING_CAP_BUSINESS_DAYS;
  const today = isoOf(input.today);
  const sorted = [...input.pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const seenIntents = new Set<string>();
  const byDoc = new Map<string, BankPendingItem[]>();
  for (const r of sorted) {
    if (!r.documentId) continue;
    if (!rowCounts(r.livemode, input.mode)) continue;
    if (input.releasedIds.has(r.id)) continue;
    if (r.paymentIntentId) {
      if (input.paidIntents.has(r.paymentIntentId) || input.failedIntents.has(r.paymentIntentId)) continue;
      if (seenIntents.has(r.paymentIntentId)) continue;
      seenIntents.add(r.paymentIntentId);
    }
    const startedOn = nyDayOf(r.createdAt);
    const item: BankPendingItem = { id: r.id, amountCents: r.amountCents, startedOn, overdue: isOverdue(startedOn, today, cap), livemode: r.livemode };
    const list = byDoc.get(r.documentId) ?? [];
    list.push(item);
    byDoc.set(r.documentId, list);
  }
  const out = new Map<string, BankPendingState>();
  for (const [doc, items] of byDoc) {
    const totalCents = items.every((i) => i.amountCents !== null) ? items.reduce((s, i) => s + (i.amountCents as number), 0) : null;
    out.set(doc, { items, totalCents, startedOn: items[0]!.startedOn, overdue: items.some((i) => i.overdue) });
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 23, 2026" for 2026-10-23. */
export function formatBankDate(isoDate: string): string {
  const d = parseIsoDate(isoDate);
  if (!d) return isoDate;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** The client's sentence on /i/<token>, shown instead of "Pay online". */
export function publicBankPendingText(s: BankPendingState): string {
  const many = s.items.length > 1;
  const date = formatBankDate(s.startedOn);
  const amount = s.totalCents !== null ? formatCents(s.totalCents) : null;
  if (s.overdue) {
    if (many) return `Bank payments${amount ? ` totalling ${amount}` : ""}, first started ${date}, are still being confirmed. Please contact us before paying again.`;
    return `A bank payment${amount ? ` of ${amount}` : ""} started ${date} is still being confirmed. Please contact us before paying again.`;
  }
  if (many) return `Bank payments${amount ? ` totalling ${amount}` : ""} are processing (first started ${date}); they usually take up to 4 business days.`;
  return `A bank payment${amount ? ` of ${amount}` : ""} is processing (started ${date}); it usually takes up to 4 business days.`;
}

/** The owner's line for one processing bank payment. */
export function ownerBankPendingItemText(i: BankPendingItem): string {
  const amount = i.amountCents !== null ? formatCents(i.amountCents) : "amount unknown";
  return `${amount}, started ${formatBankDate(i.startedOn)}; it usually takes up to 4 business days.`;
}

export const OWNER_BANK_OVERDUE_TEXT = `Bank payment processing for more than ${BANK_PENDING_CAP_BUSINESS_DAYS} business days: check it in Stripe.`;
export const OWNER_BANK_PENDING_UNREADABLE = "Bank payment status could not be read.";
export const BANK_RELEASE_CONFIRM =
  "Only do this if Stripe shows this bank payment failed or was cancelled. If it still succeeds later, it is recorded as usual and anything above the balance becomes a deposit on account with a flag.";
