import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { normalizePlaidTransaction, type PlaidTransactionShape } from "@/lib/plaid-sync";

const ACCOUNT_ID = "acct-uuid-1234";
const ENTITY_ID = "entity-uuid-5678";

function makeTx(overrides: Partial<PlaidTransactionShape> = {}): PlaidTransactionShape {
  return {
    transaction_id: "tx-plaid-001",
    pending: false,
    amount: 42.50,
    date: "2026-06-12",
    name: "STARBUCKS",
    merchant_name: null,
    ...overrides,
  };
}

describe("normalizePlaidTransaction", () => {
  it("negates a positive Plaid amount (outflow becomes negative)", () => {
    const result = normalizePlaidTransaction(makeTx({ amount: 42.50 }), ACCOUNT_ID, ENTITY_ID);
    expect(result.amount.equals(new Decimal("-42.50"))).toBe(true);
  });

  it("negates a negative Plaid amount (income deposit becomes positive)", () => {
    const result = normalizePlaidTransaction(makeTx({ amount: -2350.00 }), ACCOUNT_ID, ENTITY_ID);
    expect(result.amount.equals(new Decimal("2350.00"))).toBe(true);
  });

  it("zero amount stays zero", () => {
    const result = normalizePlaidTransaction(makeTx({ amount: 0 }), ACCOUNT_ID, ENTITY_ID);
    expect(result.amount.equals(new Decimal("0"))).toBe(true);
  });

  it("preserves pending: true", () => {
    const result = normalizePlaidTransaction(makeTx({ pending: true }), ACCOUNT_ID, ENTITY_ID);
    expect(result.pending).toBe(true);
  });

  it("preserves pending: false (posted)", () => {
    const result = normalizePlaidTransaction(makeTx({ pending: false }), ACCOUNT_ID, ENTITY_ID);
    expect(result.pending).toBe(false);
  });

  it("prefers merchant_name over name for payeeRaw", () => {
    const result = normalizePlaidTransaction(
      makeTx({ name: "WHOLEFDS #12345", merchant_name: "Whole Foods Market" }),
      ACCOUNT_ID, ENTITY_ID
    );
    expect(result.payeeRaw).toBe("Whole Foods Market");
  });

  it("falls back to name when merchant_name is null", () => {
    const result = normalizePlaidTransaction(
      makeTx({ name: "STARBUCKS #00221", merchant_name: null }),
      ACCOUNT_ID, ENTITY_ID
    );
    expect(result.payeeRaw).toBe("STARBUCKS #00221");
  });

  it("falls back to name when merchant_name is empty string", () => {
    const result = normalizePlaidTransaction(
      makeTx({ name: "TRANSFER OUT", merchant_name: "" }),
      ACCOUNT_ID, ENTITY_ID
    );
    expect(result.payeeRaw).toBe("TRANSFER OUT");
  });

  it("converts ISO date string to UTC midnight Date", () => {
    const result = normalizePlaidTransaction(makeTx({ date: "2026-06-12" }), ACCOUNT_ID, ENTITY_ID);
    expect(result.postedAt.toISOString()).toBe("2026-06-12T00:00:00.000Z");
  });

  it("preserves plaidTransactionId exactly", () => {
    const result = normalizePlaidTransaction(
      makeTx({ transaction_id: "abc-plaid-xyz-999" }),
      ACCOUNT_ID, ENTITY_ID
    );
    expect(result.plaidTransactionId).toBe("abc-plaid-xyz-999");
  });

  it("source is always 'plaid'", () => {
    const result = normalizePlaidTransaction(makeTx(), ACCOUNT_ID, ENTITY_ID);
    expect(result.source).toBe("plaid");
  });

  it("passes accountId and entityId through", () => {
    const result = normalizePlaidTransaction(makeTx(), ACCOUNT_ID, ENTITY_ID);
    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(result.entityId).toBe(ENTITY_ID);
  });
});
