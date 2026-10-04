import { describe, expect, it } from "vitest";
import { D } from "@/lib/tax2025/money";
import { computeAmtScreen, type AmtScreenInput } from "@/lib/tax2025/rules/screens";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

function amt(r: RuleResult, key: LineKey): string | null {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toString();
}

function amtInput(over: Partial<AmtScreenInput> = {}): AmtScreenInput {
  return {
    taxableIncome: D(150000),
    itemizing: false,
    saltDeduction: null,
    standardDeduction: D(31500),
    privateActivityBondInterest: D(0),
    regularTax: D(22828),
    hasPreferentialIncome: false,
    ...over,
  };
}

// Form 6251 (2025 instructions): exemption $137,000 MFJ; 26% on the first $239,100 of the excess, 28% above;
// line 2a adds back the Schedule A taxes (or the standard deduction); exemption phase-out starts at $1,252,700.
describe("computeAmtScreen (Form 6251)", () => {
  it("standard deduction, TI $150,000: AMTI 181,500, excess 44,500, TMT 26% = 11,570 <= regular tax 22,828 -> no AMT", () => {
    const r = computeAmtScreen(amtInput());
    expect(r.status).toBe("computed");
    expect(amt(r, "f6251.amti")).toBe("181500");
    expect(amt(r, "f6251.tmt")).toBe("11570");
    expect(amt(r, "f6251.amt")).toBe("0");
    expect(amt(r, "sch2.2")).toBe("0");
    expect(r.conclusion).toBe("ineligible");
    expect(r.reasons[0]).toContain("No AMT");
  });

  it("itemizing adds back the SALT deduction: TI 400,000 + 40,000 = AMTI 440,000; excess 303,000; TMT = 62,166 + 17,892 = 80,058 <= 82,126", () => {
    // 26% x 239,100 = 62,166; 28% x (303,000 - 239,100 = 63,900) = 17,892; regular tax on 400,000 = 80,398 + 32% x 5,400 = 82,126
    const r = computeAmtScreen(
      amtInput({ taxableIncome: D(400000), itemizing: true, saltDeduction: D(40000), standardDeduction: null, regularTax: D(82126) })
    );
    expect(amt(r, "f6251.amti")).toBe("440000");
    expect(amt(r, "f6251.tmt")).toBe("80058");
    expect(amt(r, "f6251.amt")).toBe("0");
  });

  it("AMT applies when the tentative minimum tax is higher: private activity bond interest pushes AMTI to 740,000", () => {
    // TI 100,000 + SALT 40,000 + PAB 600,000 = 740,000; excess 603,000; TMT = 62,166 + 28% x 363,900 (101,892) = 164,058;
    // regular tax 11,828 -> AMT = 152,230
    const r = computeAmtScreen(
      amtInput({
        taxableIncome: D(100000),
        itemizing: true,
        saltDeduction: D(40000),
        standardDeduction: null,
        privateActivityBondInterest: D(600000),
        regularTax: D(11828),
      })
    );
    expect(amt(r, "f6251.tmt")).toBe("164058");
    expect(amt(r, "f6251.amt")).toBe("152230");
    expect(amt(r, "sch2.2")).toBe("152230");
    expect(r.conclusion).toBe("eligible");
    expect(r.reasons[0]).toContain("CT-6251");
  });

  it("with qualified dividends / capital gain, an AMT result is not guessed (Part III not verified) -> needs_cpa_rule_unverified", () => {
    const r = computeAmtScreen(
      amtInput({
        taxableIncome: D(100000),
        itemizing: true,
        saltDeduction: D(40000),
        standardDeduction: null,
        privateActivityBondInterest: D(600000),
        regularTax: D(11828),
        hasPreferentialIncome: true,
      })
    );
    expect(r.status).toBe("needs_cpa_rule_unverified");
    expect(amt(r, "f6251.amt")).toBeNull();
  });

  it("with preferential income but TMT still below regular tax, 'no AMT' holds (upper bound)", () => {
    const r = computeAmtScreen(amtInput({ hasPreferentialIncome: true }));
    expect(r.status).toBe("computed");
    expect(amt(r, "f6251.amt")).toBe("0");
    expect(r.reasons[0]).toContain("upper bound");
  });

  it("AMTI exactly $1,252,700 is computed; $1,252,701 -> needs_cpa_rule_unverified (phase-out rate not verified)", () => {
    const at = computeAmtScreen(amtInput({ taxableIncome: D(1221200), regularTax: D(900000) }));
    expect(amt(at, "f6251.amti")).toBe("1252700");
    expect(at.status).toBe("computed");
    const over = computeAmtScreen(amtInput({ taxableIncome: D(1221201), regularTax: D(900000) }));
    expect(over.status).toBe("needs_cpa_rule_unverified");
    expect(amt(over, "f6251.amt")).toBeNull();
  });

  it("missing inputs -> missing_input", () => {
    const r = computeAmtScreen(amtInput({ taxableIncome: null }));
    expect(r.status).toBe("missing_input");
    expect(amt(r, "sch2.2")).toBeNull();
    const noSalt = computeAmtScreen(amtInput({ itemizing: true, saltDeduction: null }));
    expect(noSalt.status).toBe("missing_input");
  });
});

// The Form 8960 (net investment income tax) cases moved to tax2025-form-8960.test.ts when the screen became the full form.
