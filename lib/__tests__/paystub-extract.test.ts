import { describe, it, expect } from "vitest";
import {
  parseExtractedPaystub,
  verifyPaystubMath,
  inferPayFrequency,
  type LabeledAmount,
} from "@/lib/paystub-math";

// ── Helpers ───────────────────────────────────────────────────────────────────

function amounts(items: [string, number][]): LabeledAmount[] {
  return items.map(([label, amountCents]) => ({ label, amountCents }));
}

// ── parseExtractedPaystub ─────────────────────────────────────────────────────

describe("parseExtractedPaystub", () => {
  const validJson = JSON.stringify({
    employeeName: "Eric Kinniburgh",
    employerName: "Acme Corp",
    payPeriodStart: "2026-08-01",
    payPeriodEnd: "2026-08-15",
    payDate: "2026-08-15",
    payFrequency: "semi_monthly",
    grossPayCents: 250000,
    pretaxDeductions: [{ label: "401(k)", amountCents: 10000 }],
    taxBreakdown: [{ label: "Federal", amountCents: 42000 }],
    additionalWithholding: [{ label: "Federal extra (W-4)", amountCents: 5000 }],
    netPayCents: 188000,
  });

  it("parses a valid extraction response", () => {
    const result = parseExtractedPaystub(validJson);
    expect(result.employeeName).toBe("Eric Kinniburgh");
    expect(result.grossPayCents).toBe(250000);
    expect(result.pretaxDeductions).toEqual([{ label: "401(k)", amountCents: 10000 }]);
    expect(result.additionalWithholding).toEqual([
      { label: "Federal extra (W-4)", amountCents: 5000 },
    ]);
    expect(result.payFrequency).toBe("semi_monthly");
  });

  it("strips markdown fences", () => {
    const result = parseExtractedPaystub("```json\n" + validJson + "\n```");
    expect(result.grossPayCents).toBe(250000);
  });

  it("returns nulls on unparseable text", () => {
    const result = parseExtractedPaystub("not json at all");
    expect(result.grossPayCents).toBeNull();
    expect(result.pretaxDeductions).toEqual([]);
    expect(result.netPayCents).toBeNull();
  });

  it("rounds float cents, rejects non-numeric cents and bad dates", () => {
    const result = parseExtractedPaystub(
      JSON.stringify({
        grossPayCents: 123.45,
        payDate: "08/15/2026",
        payFrequency: "bogus",
        netPayCents: "not a number",
        pretaxDeductions: [{ label: "HSA", amountCents: "x" }, { label: "", amountCents: 5 }],
        taxBreakdown: [{ label: "State", amountCents: null }],
      })
    );
    expect(result.grossPayCents).toBe(123);
    expect(result.netPayCents).toBeNull();
    expect(result.payDate).toBeNull();
    expect(result.payFrequency).toBeNull();
    expect(result.pretaxDeductions).toEqual([]);
    expect(result.taxBreakdown).toEqual([]);
  });
});

// ── verifyPaystubMath ─────────────────────────────────────────────────────────

describe("verifyPaystubMath", () => {
  it("balanced stub: gross − pretax − taxes = net", () => {
    const math = verifyPaystubMath({
      grossPayCents: 250000,
      pretaxDeductions: amounts([
        ["401(k)", 10000],
        ["Health premium", 5000],
      ]),
      taxesCents: 47000,
      taxBreakdown: amounts([
        ["Federal", 42000],
        ["Social Security", 5000],
      ]),
      netPayCents: 188000,
    });
    expect(math.pretaxTotalCents).toBe(15000);
    expect(math.computedNetCents).toBe(188000);
    expect(math.balanceDiffCents).toBe(0);
    expect(math.isBalanced).toBe(true);
    expect(math.taxesBreakdownBalanced).toBe(true);
  });

  it("detects a discrepancy (stub doesn't balance)", () => {
    const math = verifyPaystubMath({
      grossPayCents: 250000,
      pretaxDeductions: amounts([["401(k)", 10000]]),
      taxesCents: 47000,
      taxBreakdown: [],
      netPayCents: 188000, // true net would be 193000
    });
    expect(math.computedNetCents).toBe(193000);
    expect(math.balanceDiffCents).toBe(5000);
    expect(math.isBalanced).toBe(false);
  });

  it("derives taxes from breakdown when total is missing", () => {
    const math = verifyPaystubMath({
      grossPayCents: 100000,
      pretaxDeductions: [],
      taxesCents: null,
      taxBreakdown: amounts([
        ["Federal", 12000],
        ["Medicare", 1450],
      ]),
      netPayCents: 86550,
    });
    expect(math.taxesTotalCents).toBe(13450);
    expect(math.computedNetCents).toBe(86550);
    expect(math.isBalanced).toBe(true);
    // breakdown balance unknown when taxesCents is null
    expect(math.taxesBreakdownBalanced).toBeNull();
  });

  it("flags tax breakdown that doesn't sum to stated total", () => {
    const math = verifyPaystubMath({
      grossPayCents: 100000,
      pretaxDeductions: [],
      taxesCents: 15000,
      taxBreakdown: amounts([
        ["Federal", 12000],
        ["Medicare", 1450],
      ]),
      netPayCents: 85000,
    });
    expect(math.taxesBreakdownBalanced).toBe(false);
  });

  it("returns null verification when fields are missing", () => {
    const math = verifyPaystubMath({
      grossPayCents: null,
      pretaxDeductions: amounts([["HSA", 100]]),
      taxesCents: null,
      taxBreakdown: [],
      netPayCents: null,
    });
    expect(math.pretaxTotalCents).toBe(100);
    expect(math.computedNetCents).toBeNull();
    expect(math.balanceDiffCents).toBeNull();
    expect(math.isBalanced).toBeNull();
  });

  it("no pretax deductions still balances", () => {
    const math = verifyPaystubMath({
      grossPayCents: 50000,
      pretaxDeductions: [],
      taxesCents: 10000,
      taxBreakdown: amounts([["Federal", 10000]]),
      netPayCents: 40000,
    });
    expect(math.pretaxTotalCents).toBe(0);
    expect(math.isBalanced).toBe(true);
  });
});

// ── inferPayFrequency ─────────────────────────────────────────────────────────

describe("inferPayFrequency", () => {
  it("semi-monthly: 1st → 15th", () => {
    expect(inferPayFrequency("2026-08-01", "2026-08-15", "2026-08-15")).toBe("semi_monthly");
  });

  it("semi-monthly: 16th → month end", () => {
    expect(inferPayFrequency("2026-08-16", "2026-08-31", "2026-08-31")).toBe("semi_monthly");
  });

  it("biweekly: mid-month to mid-month", () => {
    expect(inferPayFrequency("2026-08-06", "2026-08-19", "2026-08-19")).toBe("biweekly");
  });

  it("weekly: 7-day period", () => {
    expect(inferPayFrequency("2026-08-03", "2026-08-09", "2026-08-09")).toBe("weekly");
  });

  it("monthly: full calendar month", () => {
    expect(inferPayFrequency("2026-08-01", "2026-08-31", "2026-08-31")).toBe("monthly");
  });

  it("falls back to semi_monthly for 15th/30th pay dates", () => {
    expect(inferPayFrequency("2026-08-10", "2026-08-20", "2026-08-30")).toBe("semi_monthly");
  });

  it("returns null for unknown pay-date and ambiguous period", () => {
    expect(inferPayFrequency("2026-08-10", "2026-08-20", "2026-08-22")).toBeNull();
  });

  it("returns null when dates are missing or invalid", () => {
    expect(inferPayFrequency(null, "2026-08-15", null)).toBeNull();
    expect(inferPayFrequency("2026-08-15", "2026-08-01", null)).toBeNull(); // end before start
  });
});