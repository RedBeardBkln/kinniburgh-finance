import { describe, expect, it } from "vitest";
import { D } from "@/lib/tax2025/money";
import { computeAmtScreen, type AmtScreenInput } from "@/lib/tax2025/rules/screens";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

function amt(r: RuleResult, key: LineKey): string | null {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toString();
}

/**
 * Form 6251 Part I inputs for a household with no senior deduction: AGI (1040 line 11b) and total deductions (line 14) chosen so that
 * line 1b equals the given taxable income (line 11b minus line 14).
 */
function fromTaxableIncome(ti: number, deductions: number): Pick<AmtScreenInput, "agi" | "deductionsLine14" | "seniorDeduction"> {
  return { agi: D(ti + deductions), deductionsLine14: D(deductions), seniorDeduction: D(0) };
}

function amtInput(over: Partial<AmtScreenInput> = {}): AmtScreenInput {
  return {
    ...fromTaxableIncome(150000, 31500),
    itemizing: false,
    scheduleATaxes: null,
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
      amtInput({ ...fromTaxableIncome(400000, 45000), itemizing: true, scheduleATaxes: D(40000), standardDeduction: null, regularTax: D(82126) })
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
        ...fromTaxableIncome(100000, 45000),
        itemizing: true,
        scheduleATaxes: D(40000),
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
        ...fromTaxableIncome(100000, 45000),
        itemizing: true,
        scheduleATaxes: D(40000),
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
    const at = computeAmtScreen(amtInput({ ...fromTaxableIncome(1221200, 31500), regularTax: D(900000) }));
    expect(amt(at, "f6251.amti")).toBe("1252700");
    expect(at.status).toBe("computed");
    const over = computeAmtScreen(amtInput({ ...fromTaxableIncome(1221201, 31500), regularTax: D(900000) }));
    expect(over.status).toBe("needs_cpa_rule_unverified");
    expect(amt(over, "f6251.amt")).toBeNull();
  });

  it("missing inputs -> missing_input", () => {
    const r = computeAmtScreen(amtInput({ agi: null }));
    expect(r.status).toBe("missing_input");
    expect(amt(r, "sch2.2")).toBeNull();
    const noTaxes = computeAmtScreen(amtInput({ itemizing: true, scheduleATaxes: null }));
    expect(noTaxes.status).toBe("missing_input");
    expect(computeAmtScreen(amtInput({ deductionsLine14: null })).status).toBe("missing_input");
  });
});

// Form 6251 Part I as printed (2025): line 1a = Form 1040 line 14 minus Schedule 1-A line 37; line 1b = line 11b minus line 1a
// (negative allowed); line 2a = Schedule A line 7 when itemizing, else Form 1040 line 12e; AMTI = line 4 = 1b + 2a + ... (specs/09).
describe("computeAmtScreen: the senior deduction add-back, a negative line 1b and Schedule A line 7 (engine ty2025-1b.6)", () => {
  it("A1 itemizing with a Schedule 1-A senior deduction: 1a = 103,285 - 5,490 = 97,795; 1b = 158,506 - 97,795 = 60,711; AMTI = 60,711 + 8,255 = 68,966", () => {
    const r = computeAmtScreen(
      amtInput({ agi: D(158506), deductionsLine14: D(103285), seniorDeduction: D(5490), itemizing: true, scheduleATaxes: D(8255), standardDeduction: null, regularTax: D(10000) })
    );
    expect(amt(r, "f6251.amti")).toBe("68966");
    // 68,966 is under the 137,000 exemption: tentative minimum tax 0, no AMT
    expect(amt(r, "f6251.tmt")).toBe("0");
    expect(amt(r, "f6251.amt")).toBe("0");
    expect(r.reasons.join(" ")).toContain("line 1b $60,711");
  });

  it("A1b the same household without the add-back is 5,490 lower (the old engine's AMTI 63,476 = line 15 55,221 + 8,255)", () => {
    const withAddBack = computeAmtScreen(
      amtInput({ agi: D(158506), deductionsLine14: D(103285), seniorDeduction: D(5490), itemizing: true, scheduleATaxes: D(8255), standardDeduction: null, regularTax: D(10000) })
    );
    const without = computeAmtScreen(
      amtInput({ agi: D(158506), deductionsLine14: D(103285), seniorDeduction: D(0), itemizing: true, scheduleATaxes: D(8255), standardDeduction: null, regularTax: D(10000) })
    );
    expect(amt(without, "f6251.amti")).toBe("63476");
    expect(Number(amt(withAddBack, "f6251.amti")) - Number(amt(without, "f6251.amti"))).toBe(5490);
  });

  it("A2 a negative line 1b is honored, not floored: 1a = 39,100 - 6,000 = 33,100; 1b = 30,000 - 33,100 = -3,100; AMTI = -3,100 + 33,100 = 30,000", () => {
    const r = computeAmtScreen(
      amtInput({ agi: D(30000), deductionsLine14: D(39100), seniorDeduction: D(6000), itemizing: false, standardDeduction: D(33100), regularTax: D(0) })
    );
    expect(amt(r, "f6251.amti")).toBe("30000");
    expect(r.reasons.join(" ")).toContain("line 1b -$3,100");
  });

  it("A3 the add-back can cross the exemption: AMTI 142,000 - 137,000 = 5,000 x 26% = tentative minimum tax 1,300", () => {
    const input = { agi: D(162000), deductionsLine14: D(72000), seniorDeduction: D(12000), itemizing: true, scheduleATaxes: D(40000), standardDeduction: null };
    const noAmt = computeAmtScreen(amtInput({ ...input, regularTax: D(12000) }));
    expect(amt(noAmt, "f6251.amti")).toBe("142000");
    expect(amt(noAmt, "f6251.tmt")).toBe("1300");
    expect(amt(noAmt, "f6251.amt")).toBe("0");
    expect(noAmt.conclusion).toBe("ineligible");
    const owed = computeAmtScreen(amtInput({ ...input, regularTax: D(1000) }));
    expect(amt(owed, "f6251.amt")).toBe("300");
    expect(amt(owed, "sch2.2")).toBe("300");
    expect(owed.conclusion).toBe("eligible");
  });

  it("A4 line 2a is Schedule A line 7 (5e plus other taxes): 500 of other taxes raise AMTI by 500", () => {
    const base = { ...fromTaxableIncome(150000, 45000), itemizing: true, standardDeduction: null, regularTax: D(30000) };
    const only5e = computeAmtScreen(amtInput({ ...base, scheduleATaxes: D(40000) }));
    const line7 = computeAmtScreen(amtInput({ ...base, scheduleATaxes: D(40500) }));
    expect(Number(amt(line7, "f6251.amti")) - Number(amt(only5e, "f6251.amti"))).toBe(500);
  });

  it("A5 a Schedule 1-A total with no known senior part (line 37 null) -> missing_input, never a guessed number; the tentative minimum tax is Form 6251 line 9", () => {
    const r = computeAmtScreen(amtInput({ seniorDeduction: null }));
    expect(r.status).toBe("missing_input");
    expect(amt(r, "f6251.amt")).toBeNull();
    expect(r.inputsMissing.join(" ")).toContain("Schedule 1-A line 37");
    const ok = computeAmtScreen(amtInput());
    expect(ok.lines.find((l) => l.key === "f6251.tmt")?.formLine).toBe("6251 line 9");
  });

  it("cites the two new registry rules", () => {
    expect(computeAmtScreen(amtInput()).citations).toEqual(expect.arrayContaining(["AMT_SENIOR_DEDUCTION_ADDBACK", "AMT_LINE_2A_TAXES"]));
  });
});

// The Form 8960 (net investment income tax) cases moved to tax2025-form-8960.test.ts when the screen became the full form.
