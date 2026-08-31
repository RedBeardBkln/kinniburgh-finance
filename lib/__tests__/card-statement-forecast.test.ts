import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { generateCardStatementPayment } from "@/lib/forecast";

function d(iso: string) {
  return new Date(iso + "T00:00:00Z");
}

const FUNDING = "acct-cc-2631";

function makeCard(overrides: Partial<{
  nickname: string;
  ccDueDate: Date;
  ccStatementBalance: Decimal | string | number | null;
}> = {}) {
  return {
    id: "card-1",
    nickname: overrides.nickname ?? "Capital One card",
    fundingAccountId: FUNDING,
    ccDueDate: overrides.ccDueDate ?? d("2026-09-15"),
    ccStatementBalance:
      overrides.ccStatementBalance === undefined
        ? new Decimal("1234.56")
        : overrides.ccStatementBalance,
  };
}

describe("generateCardStatementPayment", () => {
  it("projects the statement balance as an outflow on the due date", () => {
    const events = generateCardStatementPayment(makeCard(), d("2026-09-01"), d("2026-10-01"));
    expect(events).toHaveLength(1);
    expect(events[0]!.amount.toString()).toBe("-1234.56");
    expect(events[0]!.accountId).toBe(FUNDING);
    expect(events[0]!.type).toBe("bill");
    expect(events[0]!.date.toISOString()).toBe(d("2026-09-15").toISOString());
    expect(events[0]!.description).toContain("Capital One card");
  });

  it("skips when the due date is outside the window", () => {
    expect(generateCardStatementPayment(makeCard(), d("2026-10-01"), d("2026-11-01"))).toHaveLength(0);
    // due date is the exclusive end
    expect(generateCardStatementPayment(makeCard({ ccDueDate: d("2026-10-01") }), d("2026-09-01"), d("2026-10-01"))).toHaveLength(0);
  });

  it("skips when there is no statement balance", () => {
    expect(generateCardStatementPayment(makeCard({ ccStatementBalance: null }), d("2026-09-01"), d("2026-10-01"))).toHaveLength(0);
  });

  it("skips zero or negative balances", () => {
    expect(generateCardStatementPayment(makeCard({ ccStatementBalance: new Decimal(0) }), d("2026-09-01"), d("2026-10-01"))).toHaveLength(0);
    expect(generateCardStatementPayment(makeCard({ ccStatementBalance: new Decimal(-5) }), d("2026-09-01"), d("2026-10-01"))).toHaveLength(0);
  });

  it("accepts string and number balances", () => {
    const fromStr = generateCardStatementPayment(makeCard({ ccStatementBalance: "99.99" }), d("2026-09-01"), d("2026-10-01"));
    expect(fromStr[0]!.amount.toString()).toBe("-99.99");
    const fromNum = generateCardStatementPayment(makeCard({ ccStatementBalance: 50 }), d("2026-09-01"), d("2026-10-01"));
    expect(fromNum[0]!.amount.toString()).toBe("-50");
  });

  it("normalizes due dates with time components to start of day", () => {
    const withTime = makeCard({ ccDueDate: new Date("2026-09-15T14:30:00Z") });
    const events = generateCardStatementPayment(withTime, d("2026-09-01"), d("2026-10-01"));
    expect(events[0]!.date.toISOString()).toBe(d("2026-09-15").toISOString());
  });

  it("handles invalid dates gracefully", () => {
    const bad = makeCard({ ccDueDate: new Date("invalid") });
    expect(generateCardStatementPayment(bad, d("2026-09-01"), d("2026-10-01"))).toHaveLength(0);
  });
});