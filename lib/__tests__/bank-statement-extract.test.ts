import { describe, it, expect } from "vitest";
import { parseStatementResponse } from "@/lib/bank-statement-extract";

describe("parseStatementResponse", () => {
  it("parses a clean single-account statement response", () => {
    const json = JSON.stringify({
      summary: "JCSB business checking statement for August 2026",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      accounts: [
        { accountMask: "1234", institutionName: "JCSB", openingBalanceCents: 1_250_000, closingBalanceCents: 1_310_000 },
      ],
    });
    const parsed = parseStatementResponse(json);
    expect(parsed.periodStart).toBe("2026-08-01");
    expect(parsed.periodEnd).toBe("2026-08-31");
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]!.closingBalanceCents).toBe(1_310_000);
    expect(parsed.accounts[0]!.openingBalanceCents).toBe(1_250_000);
    expect(parsed.accounts[0]!.accountMask).toBe("1234");
  });

  it("strips markdown fences", () => {
    const fenced = "```json\n" + JSON.stringify({
      summary: "stmt",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      accounts: [{ accountMask: null, institutionName: "JCSB", openingBalanceCents: null, closingBalanceCents: 500 }],
    }) + "\n```";
    const parsed = parseStatementResponse(fenced);
    expect(parsed.accounts[0]!.closingBalanceCents).toBe(500);
  });

  it("handles multi-account statements", () => {
    const json = JSON.stringify({
      summary: "Combined statement",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      accounts: [
        { accountMask: "1111", institutionName: "JCSB", openingBalanceCents: 100, closingBalanceCents: 200 },
        { accountMask: "2222", institutionName: "JCSB", openingBalanceCents: 300, closingBalanceCents: 400 },
      ],
    });
    const parsed = parseStatementResponse(json);
    expect(parsed.accounts).toHaveLength(2);
  });

  it("tolerates nulls and missing fields", () => {
    const json = JSON.stringify({ summary: "partial" });
    const parsed = parseStatementResponse(json);
    expect(parsed.periodStart).toBeNull();
    expect(parsed.periodEnd).toBeNull();
    expect(parsed.accounts).toHaveLength(0);
    expect(parsed.summary).toBe("partial");
  });

  it("returns a graceful fallback on unparseable text", () => {
    const parsed = parseStatementResponse("not json at all");
    expect(parsed.summary).toContain("Could not parse");
    expect(parsed.accounts).toHaveLength(0);
  });

  it("rounds non-integer cents to integers", () => {
    const json = JSON.stringify({
      summary: "s",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      accounts: [{ accountMask: "1", institutionName: null, openingBalanceCents: 100.5, closingBalanceCents: 200.7 }],
    });
    const parsed = parseStatementResponse(json);
    expect(parsed.accounts[0]!.openingBalanceCents).toBe(101);
    expect(parsed.accounts[0]!.closingBalanceCents).toBe(201);
  });
});