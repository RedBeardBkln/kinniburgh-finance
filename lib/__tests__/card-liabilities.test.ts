import { describe, it, expect } from "vitest";
import { normalizeCardLiability, type PlaidLiabilityCardShape } from "@/lib/plaid-sync";

function d(iso: string) {
  return new Date(iso + "T00:00:00.000Z");
}

describe("normalizeCardLiability", () => {
  it("normalizes a full credit-card liability payload", () => {
    const card: PlaidLiabilityCardShape = {
      account_id: "acct_1",
      aprs: [
        { apr_percentage: 24.99, apr_type: "purchase" },
        { apr_percentage: 29.99, apr_type: "cash_advance" },
      ],
      minimum_payment_amount: 35.0,
      next_payment_due_date: "2026-09-15",
      statement_balance: 1234.56,
    };
    const result = normalizeCardLiability(card);
    expect(result.dueDate?.toISOString()).toBe(d("2026-09-15").toISOString());
    expect(result.statementBalance?.toString()).toBe("1234.56");
    expect(result.minimumPayment?.toString()).toBe("35");
    expect(result.apr?.toString()).toBe("24.99");
  });

  it("prefers purchase APR over other APR types", () => {
    const card: PlaidLiabilityCardShape = {
      account_id: "acct_1",
      aprs: [{ apr_percentage: 29.99, apr_type: "cash_advance" }],
    };
    expect(normalizeCardLiability(card).apr?.toString()).toBe("29.99");
  });

  it("falls back to statement_balance_due_date and last_statement_balance", () => {
    const card: PlaidLiabilityCardShape = {
      account_id: "acct_1",
      next_payment_due_date: null,
      statement_balance: null,
      statement_balance_due_date: "2026-10-01",
      last_statement_balance: 987.65,
    };
    const result = normalizeCardLiability(card);
    expect(result.dueDate?.toISOString()).toBe(d("2026-10-01").toISOString());
    expect(result.statementBalance?.toString()).toBe("987.65");
  });

  it("handles empty payload with nulls", () => {
    const result = normalizeCardLiability({ account_id: "acct_1" });
    expect(result.dueDate).toBeNull();
    expect(result.statementBalance).toBeNull();
    expect(result.minimumPayment).toBeNull();
    expect(result.apr).toBeNull();
  });

  it("rejects invalid dates and non-finite amounts", () => {
    const card: PlaidLiabilityCardShape = {
      account_id: "acct_1",
      next_payment_due_date: "not-a-date",
      statement_balance: Number.NaN,
      minimum_payment_amount: Number.POSITIVE_INFINITY,
    };
    const result = normalizeCardLiability(card);
    expect(result.dueDate).toBeNull();
    expect(result.statementBalance).toBeNull();
    expect(result.minimumPayment).toBeNull();
  });
});