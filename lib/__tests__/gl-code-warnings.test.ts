import { describe, it, expect } from "vitest";
import { buildTypeChangeWarning } from "@/lib/gl-code-warnings";

describe("buildTypeChangeWarning", () => {
  it("uses singular transaction/month wording for count of 1", () => {
    const msg = buildTypeChangeWarning({ transactionCount: 1, distinctPeriods: 1 }, "expense", "revenue");
    expect(msg).toContain("1 transaction across 1 month");
    expect(msg).not.toContain("1 transactions");
    expect(msg).not.toContain("1 months");
  });

  it("uses plural transaction/month wording for counts greater than 1", () => {
    const msg = buildTypeChangeWarning({ transactionCount: 12, distinctPeriods: 4 }, "expense", "revenue");
    expect(msg).toContain("12 transactions across 4 months");
  });

  it("includes the before/after type names in the message", () => {
    const msg = buildTypeChangeWarning({ transactionCount: 5, distinctPeriods: 2 }, "expense", "revenue");
    expect(msg).toContain("from expense to revenue");
  });

  it("handles transactionCount of 0 gracefully without crashing", () => {
    const msg = buildTypeChangeWarning({ transactionCount: 0, distinctPeriods: 0 }, "asset", "liability");
    expect(msg).toContain("0 transactions across 0 months");
    expect(typeof msg).toBe("string");
  });

  it("ends with a Continue? prompt", () => {
    const msg = buildTypeChangeWarning({ transactionCount: 3, distinctPeriods: 1 }, "revenue", "expense");
    expect(msg.endsWith("Continue?")).toBe(true);
  });
});
