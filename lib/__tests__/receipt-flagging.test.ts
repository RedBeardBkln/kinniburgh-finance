import { describe, it, expect } from "vitest";
import {
  RECEIPT_THRESHOLD_DOLLARS,
  needsReceiptWhere,
  receiptDismissalKey,
  serializeReceiptDismissal,
  parseReceiptDismissal,
  mergeReviewItems,
  type ReviewReceiptItem,
  type ReviewFlaggedTransactionItem,
} from "@/lib/receipt-flagging";

describe("RECEIPT_THRESHOLD_DOLLARS", () => {
  it("is $75, per specs/10-receipt-substantiation-threshold.md", () => {
    expect(RECEIPT_THRESHOLD_DOLLARS).toBe(75);
  });
});

describe("needsReceiptWhere", () => {
  it("always includes entity: { type: 'business' } with no entityId", () => {
    const where = needsReceiptWhere();
    expect(where.entity).toEqual({ type: "business" });
  });

  it("always includes entity: { type: 'business' } even when an entityId is supplied", () => {
    // Including when entityId is Personal's own real entity id — Personal is a
    // real Entity row, not a null bucket, so this unconditional filter is the
    // only thing preventing a Personal transaction from ever being flagged.
    const where = needsReceiptWhere("personal-entity-id");
    expect(where.entity).toEqual({ type: "business" });
    expect(where.entityId).toBe("personal-entity-id");
  });

  it("omits entityId narrowing when not supplied", () => {
    const where = needsReceiptWhere();
    expect(where.entityId).toBeUndefined();
  });

  it("uses the exact -75 threshold (lte, dollars not cents)", () => {
    const where = needsReceiptWhere();
    expect(where.amount).toEqual({ lte: -75 });
  });

  it("excludes archived, already-receipted, and transfer-pair transactions", () => {
    const where = needsReceiptWhere();
    expect(where.archivedAt).toBeNull();
    expect(where.receiptId).toBeNull();
    expect(where.transferPairId).toBeNull();
  });

  it("excludes credit card bill payments (not a substantiatable purchase)", () => {
    // e.g. payeeRaw "CAPITAL ONE-CRCARDPMT" -> payeeNormalized "capital one crcardpmt"
    const where = needsReceiptWhere();
    expect(where.NOT).toEqual([{ payeeNormalized: { contains: "crcardpmt" } }]);
  });
});

describe("receiptDismissalKey", () => {
  it("is stable and prefixed with receipt_not_required:", () => {
    expect(receiptDismissalKey("abc-123")).toBe("receipt_not_required:abc-123");
    expect(receiptDismissalKey("abc-123")).toBe(receiptDismissalKey("abc-123"));
  });
});

describe("serializeReceiptDismissal / parseReceiptDismissal", () => {
  it("round-trips a dismissal with a reason", () => {
    const value = serializeReceiptDismissal({
      dismissedById: "user-1",
      dismissedAt: "2026-09-18T12:00:00.000Z",
      reason: "card payment, not a purchase",
    });
    expect(parseReceiptDismissal(value)).toEqual({
      dismissedById: "user-1",
      dismissedAt: "2026-09-18T12:00:00.000Z",
      reason: "card payment, not a purchase",
    });
  });

  it("round-trips a dismissal with no reason as null", () => {
    const value = serializeReceiptDismissal({
      dismissedById: "user-1",
      dismissedAt: "2026-09-18T12:00:00.000Z",
    });
    expect(parseReceiptDismissal(value)).toEqual({
      dismissedById: "user-1",
      dismissedAt: "2026-09-18T12:00:00.000Z",
      reason: null,
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseReceiptDismissal("{not json")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(parseReceiptDismissal(null)).toBeNull();
    expect(parseReceiptDismissal(undefined)).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(parseReceiptDismissal(JSON.stringify({ dismissedAt: "2026-09-18T12:00:00.000Z" }))).toBeNull();
    expect(parseReceiptDismissal(JSON.stringify({ dismissedById: "user-1" }))).toBeNull();
  });
});

describe("mergeReviewItems", () => {
  const receipt = (id: string, sortAt: string): ReviewReceiptItem => ({
    kind: "receipt",
    id,
    vendor: "Test Vendor",
    amountDollars: 42,
    itemDate: "2026-09-01",
    sortAt,
  });
  const flagged = (id: string, sortAt: string): ReviewFlaggedTransactionItem => ({
    kind: "flagged_transaction",
    id,
    payeeRaw: "Test Payee",
    amountDollars: 100,
    itemDate: "2026-09-01",
    entityName: "EK Consulting",
    entitySlug: "ek-consulting",
    sortAt,
  });

  it("interleaves both kinds, most-recent-first", () => {
    const result = mergeReviewItems(
      [receipt("r1", "2026-09-10T00:00:00.000Z"), receipt("r2", "2026-09-15T00:00:00.000Z")],
      [flagged("t1", "2026-09-12T00:00:00.000Z"), flagged("t2", "2026-09-20T00:00:00.000Z")]
    );
    expect(result.map((r) => r.id)).toEqual(["t2", "r2", "t1", "r1"]);
  });

  it("handles an empty receipts array", () => {
    const result = mergeReviewItems([], [flagged("t1", "2026-09-12T00:00:00.000Z")]);
    expect(result.map((r) => r.id)).toEqual(["t1"]);
  });

  it("handles an empty flagged array", () => {
    const result = mergeReviewItems([receipt("r1", "2026-09-10T00:00:00.000Z")], []);
    expect(result.map((r) => r.id)).toEqual(["r1"]);
  });

  it("handles both empty", () => {
    expect(mergeReviewItems([], [])).toEqual([]);
  });

  it("is stable when sortAt values are equal", () => {
    const result = mergeReviewItems(
      [receipt("r1", "2026-09-10T00:00:00.000Z")],
      [flagged("t1", "2026-09-10T00:00:00.000Z")]
    );
    expect(result.map((r) => r.id)).toEqual(["r1", "t1"]);
  });
});
