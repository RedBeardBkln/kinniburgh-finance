import { describe, it, expect } from "vitest";
import {
  buildTypeChangeWarning,
  isPLGlType,
  buildNonPLMappingWarning,
  buildPLExclusionNotice,
} from "@/lib/gl-code-warnings";

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

describe("isPLGlType", () => {
  it("is true for revenue and expense", () => {
    expect(isPLGlType("revenue")).toBe(true);
    expect(isPLGlType("expense")).toBe(true);
  });

  it("is false for asset, liability, equity and unexpected values", () => {
    expect(isPLGlType("asset")).toBe(false);
    expect(isPLGlType("liability")).toBe(false);
    expect(isPLGlType("equity")).toBe(false);
    expect(isPLGlType("income")).toBe(false);
    expect(isPLGlType("")).toBe(false);
  });
});

describe("buildNonPLMappingWarning", () => {
  const tagName = "Revenue";

  it("returns null for revenue and expense codes", () => {
    expect(
      buildNonPLMappingWarning({ tagName, glCode: { code: "4000", name: "Consulting", type: "revenue" }, usageCount: 3 })
    ).toBeNull();
    expect(
      buildNonPLMappingWarning({ tagName, glCode: { code: "5000", name: "Software", type: "expense" }, usageCount: 3 })
    ).toBeNull();
  });

  it.each(["asset", "liability", "equity"])("warns for %s codes naming tag, code, type and the P&L", (type) => {
    const msg = buildNonPLMappingWarning({
      tagName,
      glCode: { code: "1000", name: "Cash", type },
      usageCount: 0,
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain('"Revenue"');
    expect(msg).toContain("1000 Cash");
    expect(msg).toContain(`(${type})`);
    expect(msg).toContain("Profit & Loss");
    expect(msg!.endsWith("Save anyway?")).toBe(true);
  });

  it("includes the retroactivity caveat", () => {
    const msg = buildNonPLMappingWarning({
      tagName,
      glCode: { code: "1000", name: "Cash", type: "asset" },
      usageCount: 0,
    });
    expect(msg).toContain("does not recode transactions that are already coded");
  });

  it("uses correct singular/plural wording for usage count and omits it at zero", () => {
    const base = { tagName, glCode: { code: "1000", name: "Cash", type: "asset" } };
    expect(buildNonPLMappingWarning({ ...base, usageCount: 1 })).toContain("used on 1 transaction.");
    expect(buildNonPLMappingWarning({ ...base, usageCount: 4 })).toContain("used on 4 transactions.");
    expect(buildNonPLMappingWarning({ ...base, usageCount: 0 })).not.toContain("currently used");
  });
});

describe("buildPLExclusionNotice", () => {
  it("uses singular wording for one transaction", () => {
    const msg = buildPLExclusionNotice({ transactionCount: 1, formattedAmount: "$3,000.00" });
    expect(msg).toContain("1 transaction (net $3,000.00) is coded");
    expect(msg).not.toContain("1 transactions");
    expect(msg).toContain("is not included in this P&L");
  });

  it("uses plural wording and includes the formatted amount", () => {
    const msg = buildPLExclusionNotice({ transactionCount: 2, formattedAmount: "$6,000.00" });
    expect(msg).toContain("2 transactions (net $6,000.00) are coded");
    expect(msg).toContain("are not included in this P&L");
  });

  it("handles a count of 0 without crashing", () => {
    const msg = buildPLExclusionNotice({ transactionCount: 0, formattedAmount: "$0.00" });
    expect(typeof msg).toBe("string");
    expect(msg).toContain("0 transactions");
  });
});
