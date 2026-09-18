import { Prisma } from "@prisma/client";

// $75: specs/10-receipt-substantiation-threshold.md (IRS Pub. 463 / Treas. Reg. §1.274-5(c)(2)(iii)).
// Cite that file for any future tax-year/rule change — never hardcode 75 anywhere else.
export const RECEIPT_THRESHOLD_DOLLARS = 75;

// Paying down a credit card balance isn't itself a substantiatable purchase — the receipts belong to
// the underlying card charges, which the credit-card-statement-import flow already excludes via its
// "payment" lineType. That exclusion only applies at import time from a credit card statement though;
// a card payment that lands as an ordinary bank-statement debit (the normal case — it's an outflow on
// the checking account) has no lineType and would otherwise get swept in here like a real expense.
// Matched against payeeNormalized (see lib/tags.ts#normalizePayee), so this is case/punctuation-safe.
const NON_EXPENSE_PAYEE_PATTERNS = ["crcardpmt"];

// `entity: { type: "business" }` is unconditional — appended regardless of whether entityId is also
// supplied, so a caller can never accidentally flag a Personal transaction by passing Personal's own
// real entity id (Personal is a real Entity row, not a null bucket — getEntityBySlug("personal")
// returns one). This was caught explicitly while planning this task; do not "simplify" it away.
export function needsReceiptWhere(entityId?: string): Prisma.TransactionWhereInput {
  return {
    archivedAt: null,
    receiptId: null,
    transferPairId: null,
    amount: { lte: -RECEIPT_THRESHOLD_DOLLARS },
    entity: { type: "business" },
    NOT: NON_EXPENSE_PAYEE_PATTERNS.map((pattern) => ({ payeeNormalized: { contains: pattern } })),
    ...(entityId ? { entityId } : {}),
  };
}

export function receiptDismissalKey(transactionId: string): string {
  return `receipt_not_required:${transactionId}`;
}

export interface ReceiptDismissal {
  dismissedById: string;
  dismissedAt: string; // ISO datetime
  reason: string | null;
}

export function serializeReceiptDismissal(d: {
  dismissedById: string;
  dismissedAt: string;
  reason?: string | null;
}): string {
  return JSON.stringify({ dismissedById: d.dismissedById, dismissedAt: d.dismissedAt, reason: d.reason ?? null });
}

export function parseReceiptDismissal(raw: string | null | undefined): ReceiptDismissal | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReceiptDismissal>;
    if (typeof parsed.dismissedById !== "string" || typeof parsed.dismissedAt !== "string") return null;
    return { dismissedById: parsed.dismissedById, dismissedAt: parsed.dismissedAt, reason: parsed.reason ?? null };
  } catch {
    return null;
  }
}

// ─── Merge/sort for the two Needs-Review item shapes ──────────────────────

export interface ReviewReceiptItem {
  kind: "receipt";
  id: string;
  vendor: string | null;
  amountDollars: number | null;
  itemDate: string | null; // ISO date, or null if unextracted
  sortAt: string;          // ISO datetime driving merged order (createdAt)
}

export interface ReviewFlaggedTransactionItem {
  kind: "flagged_transaction";
  id: string; // transactionId
  payeeRaw: string | null;
  amountDollars: number; // always positive (abs of the outflow)
  itemDate: string;      // ISO date (postedAt)
  entityName: string;
  entitySlug: string | null;
  sortAt: string;
}

export type ReviewItem = ReviewReceiptItem | ReviewFlaggedTransactionItem;

// Single merged list, most-recent-activity-first. Simpler than two separate
// sub-lists/sections, and matches this page's existing single-table layout.
export function mergeReviewItems(
  receipts: ReviewReceiptItem[],
  flagged: ReviewFlaggedTransactionItem[]
): ReviewItem[] {
  // sortAt is always a plain ISO 8601 datetime string, so a lexicographic
  // compare is also a correct chronological compare (same convention as
  // lib/statement-review.ts#isWithinPlaidCoverage's own ISO-string comparison).
  return [...receipts, ...flagged].sort((a, b) => b.sortAt.localeCompare(a.sortAt));
}
