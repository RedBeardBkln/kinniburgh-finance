import { describe, expect, it } from "vitest";
import { answered, MISSING, UNSURE } from "@/lib/tax2025/answer-state";
import { D } from "@/lib/tax2025/money";
import { computeCtUseTax } from "@/lib/tax2025/rules/ct-use-tax";
import { computeForeignTaxCredit } from "@/lib/tax2025/rules/foreign-tax";
import { computePenalty2210, dayNumber, figurePenalty, penaltyForPeriod, type Penalty2210Input } from "@/lib/tax2025/rules/penalty-2210";
import { computeSchedule3Summary } from "@/lib/tax2025/rules/schedule-3";
import { computeScheduleA, type ScheduleAInput } from "@/lib/tax2025/rules/schedule-a";
import { computeAmtScreen } from "@/lib/tax2025/rules/screens";
import { computeStandardDeduction, type StandardDeductionPerson } from "@/lib/tax2025/rules/standard-deduction";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

function amt(r: RuleResult, key: LineKey): string | null {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toString();
}
function st(r: RuleResult, key: LineKey): string | undefined {
  const l = r.lines.find((x) => x.key === key);
  return l ? (l.status ?? r.status) : undefined;
}

// ── Form 2210 regular-method estimate ────────────────────────────────────────
// Hand calculation (2025 Form 2210 + instructions): required annual payment 8,000 -> four installments of 2,000;
// withholding 6,000 counts 1,500 on each due date, so every installment is 500 short and stays unpaid until
// April 15, 2026 (rate period 4 ends there): days 365 / 304 / 212 / 90, rate 7% / 365.
//   500 x 0.07 x (365 + 304 + 212 + 90) / 365 = 35 x 971 / 365 = 93.11 -> 93

function penaltyInput(over: Partial<Penalty2210Input> = {}): Penalty2210Input {
  return {
    line1: D(10000),
    line2: D(8000),
    line3: D(0),
    line6: D(6000),
    prior: { totalTax: D(8000), agi: D(120000), filingStatus: "mfj", filedJoint: answered(true), hadExcludedTaxOrRefundable: answered(false) },
    estimates: [],
    priorYearOverpaymentApplied: D(0),
    ...over,
  };
}

describe("Form 2210 helpers", () => {
  it("day counts match the printed Table 2 (365 / 304 / 212 / 90 days to 4/15/26)", () => {
    const end = "2026-04-15";
    expect(dayNumber(end) - dayNumber("2025-04-15")).toBe(365);
    expect(dayNumber(end) - dayNumber("2025-06-15")).toBe(304);
    expect(dayNumber(end) - dayNumber("2025-09-15")).toBe(212);
    expect(dayNumber(end) - dayNumber("2026-01-15")).toBe(90);
  });

  it("a full-year underpayment of 1,000 costs 1,000 x 0.07 = 70", () => {
    expect(penaltyForPeriod(D(1000), "2025-04-15", "2026-04-15").toString()).toBe("70");
  });

  it("figurePenalty: a late payment is applied to the OLDEST underpayment first (instructions, Example 2 shape)", () => {
    // installments 500; one payment of 500 on 2025-05-10 pays the April 15 underpayment (25 days late)
    const r = figurePenalty(D(500), [{ paidOn: "2025-05-10", amount: D(500) }], ["2025-04-15", "2025-06-15", "2025-09-15", "2026-01-15"], "2026-04-15");
    // a: 500 x 25 days; b, c, d unpaid: 304 + 212 + 90 days  ->  35 x (25 + 304 + 212 + 90) / 365
    expect(r.penalty.toFixed(4)).toBe(D(35).times(631).div(365).toFixed(4));
    expect(r.underpayments.map((u) => u.toString())).toEqual(["500", "500", "500", "500"]);
  });
});

describe("computePenalty2210", () => {
  it("withholding only: the estimate is 93 and the result is informational", () => {
    const r = computePenalty2210(penaltyInput());
    expect(r.status).toBe("computed");
    expect(r.informational).toBe(true);
    expect(amt(r, "f2210.4")).toBe("18000");
    expect(amt(r, "f2210.5")).toBe("16200");
    expect(amt(r, "f2210.6")).toBe("6000");
    expect(amt(r, "f2210.7")).toBe("12000");
    expect(amt(r, "f2210.8")).toBe("8000");
    expect(amt(r, "f2210.9")).toBe("8000");
    expect(amt(r, "f2210.19")).toBe("93");
    expect(r.reasons.join(" ")).toContain("IRS figures this penalty itself");
  });

  it("one 500 estimated payment on 2025-05-10 pays the April installment late: 35 x 631 / 365 = 60.5 -> 61", () => {
    const r = computePenalty2210(penaltyInput({ estimates: [{ paidOn: "2025-05-10", amount: D(500) }] }));
    expect(amt(r, "f2210.19")).toBe("61");
  });

  it("500 paid on each due date covers every installment: a computed zero penalty", () => {
    const r = computePenalty2210(
      penaltyInput({ estimates: ["2025-04-15", "2025-06-15", "2025-09-15", "2026-01-15"].map((d) => ({ paidOn: d, amount: D(500) })) })
    );
    expect(amt(r, "f2210.19")).toBe("0");
  });

  it("a 2024 overpayment applied counts on April 15, 2025; payments after January 15, 2026 are not Form 2210 payments", () => {
    const withOverpay = computePenalty2210(penaltyInput({ priorYearOverpaymentApplied: D(500) }));
    // 500 on 4/15 closes installment a: 35 x (304 + 212 + 90) / 365 = 58.11 -> 58
    expect(amt(withOverpay, "f2210.19")).toBe("58");
    const late = computePenalty2210(penaltyInput({ estimates: [{ paidOn: "2026-03-01", amount: D(2000) }] }));
    expect(amt(late, "f2210.19")).toBe("93");
    expect(late.reasons.join(" ")).toContain("not Form 2210 payments");
  });

  it("the no-penalty exits: tax under 1,000, tax after withholding under 1,000, withholding at least the required payment", () => {
    expect(amt(computePenalty2210(penaltyInput({ line1: D(600), line2: D(0) })), "f2210.19")).toBe("0");
    expect(amt(computePenalty2210(penaltyInput({ line6: D(17500) })), "f2210.19")).toBe("0");
    const covered = computePenalty2210(penaltyInput({ prior: { ...penaltyInput().prior, totalTax: D(3000) } }));
    expect(amt(covered, "f2210.9")).toBe("3000");
    expect(amt(covered, "f2210.19")).toBe("0");
  });

  it("prior-year AGI over 150,000 uses 110% of the prior tax (150,000 does not)", () => {
    const line8 = (agi: number) => amt(computePenalty2210(penaltyInput({ prior: { ...penaltyInput().prior, totalTax: D(10000), agi: D(agi) } })), "f2210.8");
    expect(line8(150000)).toBe("10000");
    expect(line8(150001)).toBe("11000");
  });

  it("never a guess: missing prior-year data / answers are advisory-grade missing_input, a 2024 surcharge or a non-joint 2024 return is a CPA matter", () => {
    const status = (over: Partial<Penalty2210Input>) => computePenalty2210(penaltyInput(over)).status;
    expect(status({ prior: { ...penaltyInput().prior, totalTax: null } })).toBe("missing_input");
    expect(status({ prior: { ...penaltyInput().prior, hadExcludedTaxOrRefundable: { state: "missing" } } })).toBe("missing_input");
    expect(status({ prior: { ...penaltyInput().prior, hadExcludedTaxOrRefundable: answered(true) } })).toBe("needs_cpa_judgment");
    expect(status({ prior: { ...penaltyInput().prior, hadExcludedTaxOrRefundable: UNSURE } })).toBe("needs_cpa_judgment");
    expect(status({ prior: { ...penaltyInput().prior, filedJoint: answered(false) } })).toBe("needs_cpa_judgment");
    expect(status({ prior: { ...penaltyInput().prior, filedJoint: MISSING, filingStatus: "single" } })).toBe("needs_cpa_judgment");
    expect(status({ estimates: null })).toBe("missing_input");
    expect(status({ line1: null })).toBe("missing_input");
    expect(computePenalty2210(penaltyInput({ estimates: null })).informational).toBe(true);
  });
});

// ── Foreign tax credit ───────────────────────────────────────────────────────
describe("computeForeignTaxCredit", () => {
  it("unknown / none / within the 600 MFJ direct limit / over it", () => {
    expect(computeForeignTaxCredit({ foreignTaxPaid: null }).status).toBe("missing_input");
    const none = computeForeignTaxCredit({ foreignTaxPaid: D(0) });
    expect(none.status).toBe("not_applicable");
    expect(amt(none, "sch3.1")).toBe("0");
    const ok = computeForeignTaxCredit({ foreignTaxPaid: D("450.40") });
    expect(ok.status).toBe("computed");
    expect(amt(ok, "sch3.1")).toBe("450");
    expect(amt(computeForeignTaxCredit({ foreignTaxPaid: D(600) }), "sch3.1")).toBe("600");
    expect(computeForeignTaxCredit({ foreignTaxPaid: D("600.01") }).status).toBe("needs_cpa_judgment");
    expect(ok.citations).toContain("FOREIGN_TAX_DIRECT_LIMIT_MFJ");
  });
});

// ── CT use tax ───────────────────────────────────────────────────────────────
describe("computeCtUseTax", () => {
  const some = { choice: answered("some" as const), generalRatePurchases: answered(D(1000)), otherRateItems: answered(false), taxPaidToOtherState: answered(D(20)) };
  it("none is 0; purchases are taxed at 6.35% minus tax paid elsewhere", () => {
    const none = computeCtUseTax({ ...some, choice: answered("none") });
    expect(none.ok && none.amount.toString()).toBe("0");
    const r = computeCtUseTax(some);
    expect(r.ok && r.amount.toString()).toBe("43.5"); // 1,000 x 0.0635 = 63.50 - 20
    const over = computeCtUseTax({ ...some, taxPaidToOtherState: answered(D(100)) });
    expect(over.ok && over.amount.toString()).toBe("0");
  });
  it("special-rate items are a CPA matter; unanswered is missing_input; not sure is needs_cpa_judgment", () => {
    const special = computeCtUseTax({ ...some, otherRateItems: answered(true) });
    expect(!special.ok && special.status).toBe("needs_cpa_judgment");
    const missing = computeCtUseTax({ ...some, choice: MISSING });
    expect(!missing.ok && missing.status).toBe("missing_input");
    const unsure = computeCtUseTax({ ...some, generalRatePurchases: UNSURE });
    expect(!unsure.ok && unsure.status).toBe("needs_cpa_judgment");
  });
});

// ── Schedule 3 assembly ──────────────────────────────────────────────────────
describe("computeSchedule3Summary", () => {
  it("is informational, cites the line map and says the solar credit is not a 2025 item", () => {
    const r = computeSchedule3Summary({
      foreignTax: D(100),
      savers: D(0),
      total8: D(100),
      extensionPayment: D(500),
      excessSocialSecurity: D(0),
      total15: D(500),
      total8Status: "computed",
      total15Status: "computed",
    });
    expect(r.status).toBe("computed");
    expect(r.informational).toBe(true);
    expect(r.citations).toContain("SCH3_LINE_MAP");
    expect(r.reasons.join(" ")).toContain("not a 2025 item");
    const open = computeSchedule3Summary({ foreignTax: null, savers: null, total8: null, extensionPayment: null, excessSocialSecurity: null, total15: null, total8Status: "missing_input", total15Status: "missing_input" });
    expect(open.status).toBe("missing_input");
  });
});

// ── Standard deduction with the line 12d boxes ───────────────────────────────
// 2025 Form 1040 instructions, Standard Deduction Chart (MFJ): 1 box 33,100; 2 boxes 34,700; 3 boxes 36,300; 4 boxes 37,900.
function person(name: string, born: boolean, blind: boolean): StandardDeductionPerson {
  return { name, bornBefore1961: answered(born), blind: answered(blind) };
}

describe("computeStandardDeduction", () => {
  const total = (boxes: [boolean, boolean, boolean, boolean]) =>
    amt(computeStandardDeduction({ people: [person("Eric", boxes[0], boxes[1]), person("Eva", boxes[2], boxes[3])] }), "std.total");

  it("0 to 4 boxes: 31,500 / 33,100 / 34,700 / 36,300 / 37,900", () => {
    expect(total([false, false, false, false])).toBe("31500");
    expect(total([true, false, false, false])).toBe("33100");
    expect(total([false, true, false, false])).toBe("33100");
    expect(total([true, false, true, false])).toBe("34700");
    expect(total([true, true, false, false])).toBe("34700");
    expect(total([true, true, true, false])).toBe("36300");
    expect(total([true, true, true, true])).toBe("37900");
  });

  it("the additional amount and the per-box reason are shown", () => {
    const r = computeStandardDeduction({ people: [person("Eric", true, false), person("Eva", false, true)] });
    expect(amt(r, "std.additional")).toBe("3200");
    expect(r.reasons[0]).toContain("2 box(es)");
    expect(r.citations).toContain("STANDARD_DEDUCTION_ADDITIONAL_MFJ");
  });

  it("a null answer BLOCKS the line (never silently 31,500): missing -> missing_input, not sure -> needs_cpa_judgment", () => {
    const missing = computeStandardDeduction({ people: [{ name: "Eric", bornBefore1961: MISSING, blind: answered(false) }, person("Eva", false, false)] });
    expect(missing.status).toBe("missing_input");
    expect(amt(missing, "std.total")).toBeNull();
    const unsure = computeStandardDeduction({ people: [person("Eric", false, false), { name: "Eva", bornBefore1961: answered(false), blind: UNSURE }] });
    expect(unsure.status).toBe("needs_cpa_judgment");
    expect(amt(unsure, "std.additional")).toBeNull();
    expect(computeStandardDeduction({ people: [person("Eric", false, false)] }).status).toBe("missing_input");
  });
});

describe("standard deduction flows into Schedule A and the AMT screen", () => {
  const base: ScheduleAInput = {
    agi: D(150000),
    ctWithholding: D(4200),
    ctEstimatesPaidIn2025: D(2000),
    ctPriorYearBalancePaidIn2025: D(500),
    propertyBills: [{ docId: "b1", label: "home", kind: "primary_residence", paid: D(6000) }],
    propertyTaxNoneConfirmed: false,
    mortgages: [{ docId: "m1", label: "Lender", interest: D("18882.69"), principal: D(400000), mortgageInsurance: null, points: null, legacyFormat: false }],
    donations: [],
    donationsNoneConfirmed: true,
  };
  const itemized = Number(amt(computeScheduleA(base), "scha.17"));

  it("omitted = the base amount (Phase 1a behaviour); the itemized total ties the standard deduction -> standard wins", () => {
    expect(itemized).toBeGreaterThan(31500);
    const tie = computeScheduleA({ ...base, standardDeduction: D(itemized) });
    expect(amt(tie, "f1040.12e")).toBe(String(itemized));
    expect(tie.lines.find((l) => l.key === "f1040.12e")?.label).toBe("Standard deduction");
  });

  it("the itemize crossover moves with the additional amount: standard one dollar below the itemized total -> itemized; one box raises it", () => {
    const below = computeScheduleA({ ...base, standardDeduction: D(itemized - 1) });
    expect(below.lines.find((l) => l.key === "f1040.12e")?.label).toBe("Itemized deductions");
    const oneBox = computeScheduleA({ ...base, standardDeduction: D(33100) });
    expect(amt(oneBox, "f1040.12e")).toBe(String(Math.max(itemized, 33100)));
  });

  it("an unknown standard deduction (null) blocks 12e with missing_input and a reason, never the base amount", () => {
    const r = computeScheduleA({ ...base, standardDeduction: null });
    expect(st(r, "f1040.12e")).toBe("missing_input");
    expect(amt(r, "f1040.12e")).toBeNull();
    expect(r.lines.find((l) => l.key === "f1040.12e")?.reason).toContain("line 12d");
    expect(r.inputsMissing.join(" ")).toContain("standard deduction");
  });

  it("the AMT screen adds back the ADJUSTED standard deduction: TI 150,000 + 34,700 = AMTI 184,700; (184,700 - 137,000) x 26% = 12,402", () => {
    const r = computeAmtScreen({
      taxableIncome: D(150000),
      itemizing: false,
      saltDeduction: null,
      standardDeduction: D(34700),
      privateActivityBondInterest: D(0),
      regularTax: D(22828),
      hasPreferentialIncome: false,
    });
    expect(amt(r, "f6251.amti")).toBe("184700");
    expect(amt(r, "f6251.tmt")).toBe("12402");
    expect(amt(r, "f6251.amt")).toBe("0");
  });
});
