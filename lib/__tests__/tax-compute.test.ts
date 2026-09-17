import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  computeFederalBracketTax,
  selectDeductionMethod,
  computeSelfEmploymentTax,
  computeAdditionalMedicareTax,
  computeQBIDeduction,
  computeItemizedDeduction,
  computeScheduleCNetProfit,
  computeMileageDeduction,
  computeHomeOfficeSimplifiedDeduction,
  computeCtPersonalExemption,
  computeCtInitialTax,
  computeCtPhaseOutAddback,
  computeCtRecapture,
  computeCtPersonalCreditDecimal,
  computeConnecticutTax,
  computeFederalTax,
  computePersonalTaxReturn,
  STANDARD_DEDUCTION_MFJ_2025,
  SE_NET_EARNINGS_FACTOR,
  SE_WAGE_BASE_2025,
  SALT_CAP_MFJ_2025,
  type MileageEntryInput,
} from "../tax-compute";

const D = (s: string) => new Decimal(s);
const d = (iso: string) => new Date(iso + "T00:00:00Z");

// ── computeFederalBracketTax ──────────────────────────────────────────────────

describe("computeFederalBracketTax", () => {
  it("$0 and negative taxable income -> Decimal(0)", () => {
    expect(computeFederalBracketTax(D("0")).toString()).toBe("0");
    expect(computeFederalBracketTax(D("-100")).toString()).toBe("0");
  });

  it("exactly at each bracket boundary — value stays in the lower band", () => {
    expect(computeFederalBracketTax(D("23850")).toString()).toBe("2385");
    expect(computeFederalBracketTax(D("96950")).toString()).toBe("11157");
    expect(computeFederalBracketTax(D("206700")).toString()).toBe("35302");
    expect(computeFederalBracketTax(D("394600")).toString()).toBe("80398");
    expect(computeFederalBracketTax(D("501050")).toString()).toBe("114462");
    expect(computeFederalBracketTax(D("751600")).toString()).toBe("202154.5");
  });

  it("one dollar past each boundary — first dollar taxed at the next rate", () => {
    expect(computeFederalBracketTax(D("23851")).toString()).toBe("2385.12");
    expect(computeFederalBracketTax(D("96951")).toString()).toBe("11157.22");
    expect(computeFederalBracketTax(D("206701")).toString()).toBe("35302.24");
    expect(computeFederalBracketTax(D("394601")).toString()).toBe("80398.32");
    expect(computeFederalBracketTax(D("501051")).toString()).toBe("114462.35");
    expect(computeFederalBracketTax(D("751601")).toString()).toBe("202154.87");
  });

  it("an income figure spanning all 7 brackets ($900,000)", () => {
    expect(computeFederalBracketTax(D("900000")).toString()).toBe("257062.5");
  });
});

// ── selectDeductionMethod ─────────────────────────────────────────────────────

describe("selectDeductionMethod", () => {
  it("itemized $1 below standard -> standard", () => {
    expect(selectDeductionMethod(D("31499"), D(String(STANDARD_DEDUCTION_MFJ_2025)))).toBe("standard");
  });
  it("itemized exactly equal to standard -> standard (tie-break)", () => {
    expect(selectDeductionMethod(D("31500"), D(String(STANDARD_DEDUCTION_MFJ_2025)))).toBe("standard");
  });
  it("itemized $1 above standard -> itemized", () => {
    expect(selectDeductionMethod(D("31501"), D(String(STANDARD_DEDUCTION_MFJ_2025)))).toBe("itemized");
  });
});

// ── computeSelfEmploymentTax ──────────────────────────────────────────────────

describe("computeSelfEmploymentTax", () => {
  it("net SE earnings well under the wage base — OASDI applies to the full amount", () => {
    const r = computeSelfEmploymentTax({ scheduleCNetProfit: D("50000") });
    expect(r.netSEEarnings.toString()).toBe("46175");
    expect(r.oasdiTax.toString()).toBe("5725.7");
    expect(r.medicareTax.toString()).toBe("1339.075");
    expect(r.totalSETax.toString()).toBe("7064.775");
    expect(r.deductibleHalf.toString()).toBe("3532.3875");
  });

  it("net SE earnings exactly at the $176,100 wage base — OASDI caps, Medicare uncapped", () => {
    const profitAtCap = D("176100").div(SE_NET_EARNINGS_FACTOR);
    const r = computeSelfEmploymentTax({ scheduleCNetProfit: profitAtCap });
    expect(r.netSEEarnings.toDecimalPlaces(2).toString()).toBe("176100");
    expect(r.oasdiTax.toDecimalPlaces(2).toString()).toBe("21836.4");
    expect(r.medicareTax.toDecimalPlaces(2).toString()).toBe("5106.9");
  });

  it("net SE earnings above the wage base — OASDI capped, Medicare uncapped keeps growing", () => {
    const r = computeSelfEmploymentTax({ scheduleCNetProfit: D("300000") });
    expect(r.netSEEarnings.toString()).toBe("277050");
    expect(r.oasdiTax.toString()).toBe("21836.4"); // capped at wage base * 12.4%
    expect(r.medicareTax.toString()).toBe("8034.45"); // uncapped
    expect(r.totalSETax.toString()).toBe("29870.85");
    expect(r.deductibleHalf.toString()).toBe("14935.425");
  });

  it("Schedule C net loss -> all components $0, never negative", () => {
    const r = computeSelfEmploymentTax({ scheduleCNetProfit: D("-50000") });
    expect(r.netSEEarnings.toString()).toBe("0");
    expect(r.oasdiTax.toString()).toBe("0");
    expect(r.medicareTax.toString()).toBe("0");
    expect(r.totalSETax.toString()).toBe("0");
    expect(r.deductibleHalf.toString()).toBe("0");
  });

  it("nonzero priorSocialSecurityWages reduces the OASDI-taxable amount", () => {
    const r = computeSelfEmploymentTax({ scheduleCNetProfit: D("100000"), priorSocialSecurityWages: D("150000") });
    expect(r.netSEEarnings.toString()).toBe("92350");
    // OASDI-taxable capped at wage base(176100) - priorWages(150000) = 26100
    expect(r.oasdiTax.toString()).toBe("3236.4");
    expect(r.medicareTax.toString()).toBe("2678.15"); // uncapped, unaffected by prior wages
  });

  it("priorSocialSecurityWages already meets/exceeds the wage base — OASDI-taxable -> $0, Medicare still applies", () => {
    const r = computeSelfEmploymentTax({ scheduleCNetProfit: D("100000"), priorSocialSecurityWages: D("200000") });
    expect(r.oasdiTax.toString()).toBe("0");
    expect(r.medicareTax.toString()).toBe("2678.15");
  });

  it(`SE_WAGE_BASE_2025 constant is 176100`, () => {
    expect(SE_WAGE_BASE_2025).toBe(176100);
  });
});

// ── computeAdditionalMedicareTax ──────────────────────────────────────────────

describe("computeAdditionalMedicareTax", () => {
  it("combined wages + SE earnings at $249,999 -> $0", () => {
    const r = computeAdditionalMedicareTax({ medicareWages: D("249999"), netSEEarnings: D("0") });
    expect(r.toString()).toBe("0");
  });
  it("exactly $250,000 -> $0 (threshold is exclusive)", () => {
    const r = computeAdditionalMedicareTax({ medicareWages: D("150000"), netSEEarnings: D("100000") });
    expect(r.toString()).toBe("0");
  });
  it("$250,001 -> tax on the $1 excess only", () => {
    const r = computeAdditionalMedicareTax({ medicareWages: D("150001"), netSEEarnings: D("100000") });
    expect(r.toString()).toBe("0.009");
  });
  it("a combined figure well above threshold -> correct 0.9% on the full excess", () => {
    const r = computeAdditionalMedicareTax({ medicareWages: D("300000"), netSEEarnings: D("100000") });
    expect(r.toString()).toBe("1350"); // (400000-250000)*0.009
  });
});

// ── computeQBIDeduction ────────────────────────────────────────────────────────

describe("computeQBIDeduction", () => {
  it("taxable income well below $394,600 -> full 20% of QBI", () => {
    const r = computeQBIDeduction({ qualifiedBusinessIncome: D("100000"), taxableIncomeBeforeQBI: D("300000") });
    expect(r.deduction.toString()).toBe("20000");
    expect(r.phaseInFraction).toBeNull();
    expect(r.notes).toEqual([]);
  });

  it("exactly at $394,600 -> still full 20%", () => {
    const r = computeQBIDeduction({ qualifiedBusinessIncome: D("100000"), taxableIncomeBeforeQBI: D("394600") });
    expect(r.deduction.toString()).toBe("20000");
    expect(r.notes).toEqual([]);
  });

  it("midpoint of the phase-in band ($444,600) -> documented linear interpolation, notes populated", () => {
    const r = computeQBIDeduction({ qualifiedBusinessIncome: D("100000"), taxableIncomeBeforeQBI: D("444600") });
    // fullDeduction = min(20000, 444600*0.2=88920) = 20000; phaseInFraction = (494600-444600)/100000 = 0.5
    expect(r.phaseInFraction!.toString()).toBe("0.5");
    expect(r.deduction.toString()).toBe("10000");
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it("exactly at $494,600 and above -> $0 with documented stub notes", () => {
    const atEnd = computeQBIDeduction({ qualifiedBusinessIncome: D("100000"), taxableIncomeBeforeQBI: D("494600") });
    expect(atEnd.deduction.toString()).toBe("0");
    expect(atEnd.notes.length).toBeGreaterThan(0);
    expect(atEnd.notes[0]).toMatch(/494,600/);

    const above = computeQBIDeduction({ qualifiedBusinessIncome: D("100000"), taxableIncomeBeforeQBI: D("600000") });
    expect(above.deduction.toString()).toBe("0");
    expect(above.notes.length).toBeGreaterThan(0);
  });

  it("taxable-income cap binds (QBI x 20% > taxable income x 20%)", () => {
    const r = computeQBIDeduction({ qualifiedBusinessIncome: D("500000"), taxableIncomeBeforeQBI: D("50000") });
    expect(r.deduction.toString()).toBe("10000"); // 50000*0.2, the lower cap
  });
});

// ── computeItemizedDeduction / SALT cap ───────────────────────────────────────

describe("computeItemizedDeduction", () => {
  it("SALT sum under the cap -> uncapped sum used", () => {
    const r = computeItemizedDeduction({
      mortgageInterestCents: 1_000_000, // $10,000
      propertyTaxCents: 500_000, // $5,000
      ctIncomeTaxWithheldCents: 300_000, // $3,000
      charitableCents: 0,
      saltCapCents: SALT_CAP_MFJ_2025 * 100, // $40,000
    });
    expect(r.saltBeforeCap.toString()).toBe("8000");
    expect(r.saltAfterCap.toString()).toBe("8000");
    expect(r.itemizedTotal.toString()).toBe("18000");
    expect(r.notes).toEqual([]);
  });

  it("SALT sum over the cap -> capped exactly at saltCapCents", () => {
    const r = computeItemizedDeduction({
      mortgageInterestCents: 1_000_000,
      propertyTaxCents: 3_000_000, // $30,000
      ctIncomeTaxWithheldCents: 2_000_000, // $20,000
      charitableCents: 0,
      saltCapCents: SALT_CAP_MFJ_2025 * 100,
    });
    expect(r.saltBeforeCap.toString()).toBe("50000");
    expect(r.saltAfterCap.toString()).toBe("40000"); // capped
    expect(r.itemizedTotal.toString()).toBe("50000"); // 10000 mortgage + 40000 capped SALT
  });

  it("charitableCents: null -> treated as $0, not an error", () => {
    const r = computeItemizedDeduction({
      mortgageInterestCents: 0,
      propertyTaxCents: 0,
      ctIncomeTaxWithheldCents: 0,
      charitableCents: null,
      saltCapCents: SALT_CAP_MFJ_2025 * 100,
    });
    expect(r.charitable.toString()).toBe("0");
    expect(r.itemizedTotal.toString()).toBe("0");
  });

  it("flags a note (not a computed phase-down) when MAGI exceeds $500,000", () => {
    const r = computeItemizedDeduction({
      mortgageInterestCents: 1_000_000,
      propertyTaxCents: 500_000,
      ctIncomeTaxWithheldCents: 300_000,
      charitableCents: 0,
      saltCapCents: SALT_CAP_MFJ_2025 * 100,
      magiForSaltPhaseDown: D("600000"),
    });
    expect(r.saltAfterCap.toString()).toBe("8000"); // NOT reduced — phase-down not modeled
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]).toMatch(/500,000/);
  });
});

// ── computeScheduleCNetProfit (sanity) ────────────────────────────────────────

describe("computeScheduleCNetProfit", () => {
  it("nets GL income/expense against mileage and home-office deductions", () => {
    const r = computeScheduleCNetProfit({
      glIncomeTotal: D("80000"),
      glExpenseTotal: D("30000"),
      mileageDeduction: D("700"),
      homeOfficeSimplifiedDeduction: D("1000"),
    });
    expect(r.toString()).toBe("48300");
  });
});

// ── Mileage / home office ─────────────────────────────────────────────────────

describe("computeMileageDeduction", () => {
  it("mixed 2024 (67c) / 2025 (70c) rates — sums each entry's own stored rate; only mismatched 2025 entries flagged", () => {
    const entries: MileageEntryInput[] = [
      { miles: 100, ratePerMile: D("0.67"), date: d("2024-06-01") }, // 2024, correct-for-year rate
      { miles: 200, ratePerMile: D("0.70"), date: d("2025-06-01") }, // 2025, correct rate
      { miles: 50, ratePerMile: D("0.65"), date: d("2025-07-01") }, // 2025, MISMATCHED rate
    ];
    const r = computeMileageDeduction({ entries, taxYear: 2025 });
    expect(r.deduction.toString()).toBe("239.5"); // 67 + 140 + 32.5
    expect(r.mismatchedRateEntries.length).toBe(1);
    expect(r.mismatchedRateEntries[0]!.miles).toBe(50);
  });
});

describe("computeHomeOfficeSimplifiedDeduction", () => {
  it("sqft: null -> $0", () => {
    expect(computeHomeOfficeSimplifiedDeduction(null).toString()).toBe("0");
  });
  it("sqft: 400 (over the 300 cap) -> capped at 300*5 = 1500", () => {
    expect(computeHomeOfficeSimplifiedDeduction(400).toString()).toBe("1500");
  });
  it("sqft under the cap -> uncapped", () => {
    expect(computeHomeOfficeSimplifiedDeduction(200).toString()).toBe("1000");
  });
});

// ── CT Table A — computeCtPersonalExemption ───────────────────────────────────

describe("computeCtPersonalExemption (CT Table A)", () => {
  it("CT AGI <= $48,000 -> exactly $24,000", () => {
    expect(computeCtPersonalExemption(D("48000")).toString()).toBe("24000");
    expect(computeCtPersonalExemption(D("30000")).toString()).toBe("24000");
  });
  it("CT AGI at $49,000 (one step in) -> $23,000", () => {
    expect(computeCtPersonalExemption(D("49000")).toString()).toBe("23000");
  });
  it("CT AGI exactly $71,000 -> the documented interpretation's value (last nonzero step, $1,000)", () => {
    expect(computeCtPersonalExemption(D("71000")).toString()).toBe("1000");
  });
  it("CT AGI at $71,001+ -> $0", () => {
    expect(computeCtPersonalExemption(D("71001")).toString()).toBe("0");
    expect(computeCtPersonalExemption(D("100000")).toString()).toBe("0");
  });
});

// ── CT Table B — computeCtInitialTax ──────────────────────────────────────────

describe("computeCtInitialTax (CT Table B)", () => {
  const cases: [string, string][] = [
    ["10000", "200"], // inside band 0 (2%)
    ["20000", "400"], // boundary 1 — still flat 2% of $20,000
    ["20001", "400.045"], // one dollar past — 4.5% starts
    ["60000", "2200"], // inside band 1
    ["100000", "4000"], // boundary 2
    ["100001", "4000.055"],
    ["150000", "6750"], // inside band 2
    ["200000", "9500"], // boundary 3
    ["200001", "9500.06"],
    ["300000", "15500"], // inside band 3
    ["400000", "21500"], // boundary 4
    ["400001", "21500.065"],
    ["450000", "24750"], // inside band 4
    ["500000", "28000"], // boundary 5
    ["500001", "28000.069"],
    ["750000", "45250"], // inside band 5
    ["1000000", "62500"], // boundary 6
    ["1000001", "62500.0699"],
    ["1500000", "97450"], // inside band 6
  ];
  it.each(cases)("ctTaxableIncome=%s -> %s", (income, expected) => {
    expect(computeCtInitialTax(D(income)).toString()).toBe(expected);
  });
});

// ── CT Table C — computeCtPhaseOutAddback ─────────────────────────────────────

describe("computeCtPhaseOutAddback (CT Table C)", () => {
  it("CT AGI <= $100,500 -> $0", () => {
    expect(computeCtPhaseOutAddback(D("100500")).toString()).toBe("0");
    expect(computeCtPhaseOutAddback(D("90000")).toString()).toBe("0");
  });

  it("CT AGI at $145,500 exactly -> $500 (cap anchor, per the documented fence-post formula)", () => {
    expect(computeCtPhaseOutAddback(D("145500")).toString()).toBe("500");
  });

  it("CT AGI at $145,501+ -> still capped at $500", () => {
    expect(computeCtPhaseOutAddback(D("145501")).toString()).toBe("500");
    expect(computeCtPhaseOutAddback(D("300000")).toString()).toBe("500");
  });

  // NOTE: the plan's own Test Expectations illustrative mid-range example
  // ("$110,500, one $5,000 step in -> $50") is NOT reproduced verbatim here.
  // Under this table's implementation (a fence-post `floor(excess/5000)+1`
  // step count, chosen specifically so the $145,500 -> $500 cap anchor spec
  // 09 states explicitly lands exactly), $110,500 actually computes to $150
  // (2 full $5,000 bands crossed -> 3 fence-post steps), not $50 — the two
  // anchors ($0 at $100,500, $500 at $145,500) are mutually incompatible
  // with a plain per-$5,000 formula that also produces $50 at $110,500 (see
  // this function's own doc comment for the full derivation). This deviation
  // is called out explicitly in the implementation report.
  it("mid-range value, one $5,000 step in ($105,000) -> $50", () => {
    expect(computeCtPhaseOutAddback(D("105000")).toString()).toBe("50");
  });
  it("mid-range value, two $5,000 steps in ($110,500) -> $150 (see NOTE above)", () => {
    expect(computeCtPhaseOutAddback(D("110500")).toString()).toBe("150");
  });
});

// ── CT Table D — computeCtRecapture ───────────────────────────────────────────

describe("computeCtRecapture (CT Table D)", () => {
  it("CT AGI <= $210,000 -> $0, no manual lookup needed", () => {
    const r = computeCtRecapture(D("210000"));
    expect(r.amount!.toString()).toBe("0");
    expect(r.requiresManualLookup).toBe(false);
  });
  it("CT AGI at $210,001 -> resolved to $50 (first $10k step), no manual lookup", () => {
    const r = computeCtRecapture(D("210001"));
    expect(r.amount!.toString()).toBe("50");
    expect(r.requiresManualLookup).toBe(false);
  });
  it("CT AGI at $280,000 (the $270k-$280k step) -> $350", () => {
    expect(computeCtRecapture(D("280000")).amount!.toString()).toBe("350");
  });

  // Flat band #1: $300,000-$400,000 stays at $500 (no step) — spec 09 calls
  // this out explicitly as a case a naive formula would get wrong.
  it("flat band 1 low edge — exactly $300,000 -> $450 (last step BEFORE the flat band)", () => {
    expect(computeCtRecapture(D("300000")).amount!.toString()).toBe("450");
  });
  it("flat band 1 — $399,999 -> $500 (still flat, proves no mid-band step)", () => {
    expect(computeCtRecapture(D("399999")).amount!.toString()).toBe("500");
  });
  it("flat band 1 high edge — $400,001 -> $680 (next stepped band resumes)", () => {
    expect(computeCtRecapture(D("400001")).amount!.toString()).toBe("680");
  });

  // Flat band #2: $690,000-$1,000,000 stays at $5,900 (no step).
  it("flat band 2 low edge — exactly $690,000 -> $5,720 (last step BEFORE the flat band)", () => {
    expect(computeCtRecapture(D("690000")).amount!.toString()).toBe("5720");
  });
  it("flat band 2 — $999,999 -> $5,900 (still flat, proves no mid-band step)", () => {
    expect(computeCtRecapture(D("999999")).amount!.toString()).toBe("5900");
  });
  it("flat band 2 high edge — $1,000,001 -> $6,000 (next stepped band resumes)", () => {
    expect(computeCtRecapture(D("1000001")).amount!.toString()).toBe("6000");
  });

  it("outer edge — CT AGI exactly $1,080,000 -> $6,700 (last stepped band, not yet the cap)", () => {
    const r = computeCtRecapture(D("1080000"));
    expect(r.amount!.toString()).toBe("6700");
    expect(r.requiresManualLookup).toBe(false);
  });
  it("outer edge — CT AGI at $1,080,001+ -> capped at $6,800, no manual lookup", () => {
    expect(computeCtRecapture(D("1080001")).amount!.toString()).toBe("6800");
    expect(computeCtRecapture(D("2000000")).amount!.toString()).toBe("6800");
    expect(computeCtRecapture(D("2000000")).requiresManualLookup).toBe(false);
  });
});

// ── CT Table E — computeCtPersonalCreditDecimal ───────────────────────────────

describe("computeCtPersonalCreditDecimal (CT Table E)", () => {
  it("outer edge — CT AGI <= $24,000 -> moot placeholder decimal, no manual lookup", () => {
    const r = computeCtPersonalCreditDecimal(D("24000"));
    expect(r.decimal!.toString()).toBe("1");
    expect(r.requiresManualLookup).toBe(false);
  });
  it("CT AGI at $24,001 (just past the moot band) -> $0.75", () => {
    expect(computeCtPersonalCreditDecimal(D("24001")).decimal!.toString()).toBe("0.75");
  });
  it("CT AGI at $100,500 exactly -> resolved to $0.01, no manual lookup", () => {
    const r = computeCtPersonalCreditDecimal(D("100500"));
    expect(r.decimal!.toString()).toBe("0.01");
    expect(r.requiresManualLookup).toBe(false);
  });
  it("CT AGI at $100,501+ -> confirmed $0.00, no manual lookup", () => {
    const r = computeCtPersonalCreditDecimal(D("100501"));
    expect(r.decimal!.toString()).toBe("0");
    expect(r.requiresManualLookup).toBe(false);
  });
  it("CT AGI at $50,000 (interior value) -> $0.15, no manual lookup", () => {
    const r = computeCtPersonalCreditDecimal(D("50000"));
    expect(r.decimal!.toString()).toBe("0.15");
    expect(r.requiresManualLookup).toBe(false);
  });
  it("outer edge — very large CT AGI -> still $0.00, no manual lookup", () => {
    expect(computeCtPersonalCreditDecimal(D("5000000")).decimal!.toString()).toBe("0");
  });
});

// ── computeConnecticutTax ─────────────────────────────────────────────────────

describe("computeConnecticutTax", () => {
  it("computes a full CT liability when both Table D and Table E are within their confirmed boundaries", () => {
    const r = computeConnecticutTax({ ctAGI: D("135887.713675"), ctWithholdingCents: 700_000 });
    expect(r.personalExemption.toString()).toBe("0");
    expect(r.initialTax.toString()).toBe("5973.824252125");
    expect(r.phaseOutAddback.toString()).toBe("400");
    expect(r.netTaxBeforeCreditsUnknown).toBe(false);
    expect(r.ctTaxComputed!.toString()).toBe("6373.824252125");
    expect(r.balanceDueOrRefund!.toString()).toBe("626.175747875");
  });

  it("computes a full CT liability at a higher CT AGI now that Tables D/E are fully resolved ($300,000)", () => {
    const r = computeConnecticutTax({ ctAGI: D("300000"), ctWithholdingCents: 0 });
    // personalExemption: $0 (ctAGI far past the $71,000 Table A ceiling)
    // initialTax (Table B, ctTaxableIncome=$300,000): 9500 + (300000-200000)*0.06 = 15500
    // phaseOutAddback (Table C, ctAGI=$300,000): capped at $500
    // recapture (Table D, ctAGI=$300,000, last step before the flat band): $450
    // personalCredit (Table E, ctAGI=$300,000): $0.00
    // ctTaxComputed = 15500 + 500 + 450 - 15500*0 = 16450
    expect(r.netTaxBeforeCreditsUnknown).toBe(false);
    expect(r.initialTax.toString()).toBe("15500");
    expect(r.phaseOutAddback.toString()).toBe("500");
    expect(r.recapture.amount!.toString()).toBe("450");
    expect(r.personalCredit.decimal!.toString()).toBe("0");
    expect(r.ctTaxComputed!.toString()).toBe("16450");
    expect(r.balanceDueOrRefund!.toString()).toBe("-16450");
  });
});

// ── computeFederalTax (orchestrator sanity) ───────────────────────────────────

describe("computeFederalTax", () => {
  it("wires SE tax / itemized-vs-standard / QBI / bracket tax together", () => {
    const r = computeFederalTax({
      wages: D("90000"),
      interestIncome: D("1000"),
      scheduleCNetProfit: D("48300"),
      medicareWages: D("90000"),
      itemizedDeductionInput: {
        mortgageInterestCents: 1_200_000,
        propertyTaxCents: 800_000,
        ctIncomeTaxWithheldCents: 600_000,
        charitableCents: 100_000,
        saltCapCents: SALT_CAP_MFJ_2025 * 100,
      },
      federalWithholdingCents: 1_500_000,
      estimatedPaymentsCents: 200_000,
    });
    expect(r.agiUpperBound.toString()).toBe("135887.713675");
    expect(r.deductionMethod).toBe("standard");
    expect(r.deductionUsed.toString()).toBe("31500");
    expect(r.qbi.deduction.toString()).toBe("9660");
    expect(r.taxableIncome.toString()).toBe("94727.713675");
    expect(r.bracketTax.toString()).toBe("10890.325641");
    expect(r.totalTaxBeforeCredits.toString()).toBe("17714.898291");
    expect(r.totalPayments.toString()).toBe("17000");
    expect(r.balanceDueOrRefundBeforeCredits.toString()).toBe("-714.898291");
  });
});

// ── computePersonalTaxReturn (end-to-end) ─────────────────────────────────────

describe("computePersonalTaxReturn", () => {
  it("golden path — fully-populated realistic inputs, gaps empty, full chain matches hand-computed values", () => {
    const r = computePersonalTaxReturn({
      taxYear: 2025,
      wages: D("90000"),
      medicareWages: D("90000"),
      interestIncome: D("1000"),
      glIncomeTotal: D("80000"),
      glExpenseTotal: D("30000"),
      mileageEntries: [{ miles: 1000, ratePerMile: D("0.70"), date: d("2025-03-01") }],
      homeOfficeSqft: 200,
      mortgageInterestCents: 1_200_000,
      propertyTaxCents: 800_000,
      ctIncomeTaxWithheldCents: 600_000,
      charitableCents: 100_000,
      saltCapCents: SALT_CAP_MFJ_2025 * 100,
      federalWithholdingCents: 1_500_000,
      estimatedPaymentsCents: 200_000,
      ctWithholdingCents: 700_000,
    });

    expect(r.scheduleC.netProfit.toString()).toBe("48300");
    expect(r.federal.agiUpperBound.toString()).toBe("135887.713675");
    expect(r.federal.taxableIncome.toString()).toBe("94727.713675");
    expect(r.federal.bracketTax.toString()).toBe("10890.325641");
    expect(r.federal.selfEmploymentTax.totalSETax.toString()).toBe("6824.57265");
    expect(r.federal.additionalMedicareTax.toString()).toBe("0");
    expect(r.federal.totalTaxBeforeCredits.toString()).toBe("17714.898291");
    expect(r.federal.balanceDueOrRefundBeforeCredits.toString()).toBe("-714.898291");
    expect(r.connecticut.ctTaxComputed!.toString()).toBe("6373.824252125");
    expect(r.connecticut.balanceDueOrRefund!.toString()).toBe("626.175747875");
    // Not []: two standing gaps fire on every call today (see review finding
    // 2) — AGI-is-an-upper-bound and QBI's raw-Schedule-C-profit
    // simplification. Neither is conditional on this scenario's inputs.
    expect(r.gaps).toEqual([
      "federal AGI is an upper bound — retirement/HSA/self-employed health insurance above-the-line deductions are not subtracted (no structured dollar data exists anywhere in the schema for these yet)",
      "QBI deduction is computed off raw Schedule C net profit, not net of the deductible half of self-employment tax (and not net of SE health insurance, which isn't modeled) — a simplification of the true §199A qualified business income base",
    ]);
  });

  it("gap-heavy scenario — null sqft, empty mileage, null estimated payments, null charitable, CT AGI at $280,000 (now resolvable via the full Table D/E lookup)", () => {
    const r = computePersonalTaxReturn({
      taxYear: 2025,
      wages: D("280000"),
      medicareWages: D("280000"),
      interestIncome: D("0"),
      glIncomeTotal: D("0"),
      glExpenseTotal: D("0"),
      mileageEntries: [],
      homeOfficeSqft: null,
      mortgageInterestCents: 0,
      propertyTaxCents: 0,
      ctIncomeTaxWithheldCents: 0,
      charitableCents: null,
      saltCapCents: SALT_CAP_MFJ_2025 * 100,
      federalWithholdingCents: 0,
      estimatedPaymentsCents: null,
      ctWithholdingCents: 0,
    });

    expect(r.gaps.some((g) => g.includes("home office square footage not captured"))).toBe(true);
    expect(r.gaps.some((g) => g.includes("no mileage entries found"))).toBe(true);
    expect(r.gaps.some((g) => g.includes("estimated tax payments not captured"))).toBe(true);
    expect(r.gaps.some((g) => g.includes("no charitable-donation data source"))).toBe(true);
    // CT Table D/E now fully resolve at CT AGI $280,000 (falls in Table D's
    // $270k-$280k -> $350 step), so the old "interior values not yet
    // transcribed" gap no longer fires here.
    expect(r.gaps.some((g) => g.includes("Table D and/or Table E lookup fell outside"))).toBe(false);
    // The two standing gaps (AGI-upper-bound, QBI-simplification — see the
    // golden-path test above) still fire unconditionally.
    expect(r.gaps.some((g) => g.includes("federal AGI is an upper bound"))).toBe(true);
    expect(r.gaps.some((g) => g.includes("QBI deduction is computed off raw Schedule C net profit"))).toBe(true);
    expect(r.gaps.length).toBe(6); // 4 conditional + 2 standing

    // CT AGI = federal AGI = $280,000 (wages only, no SE income/deduction).
    // personalExemption: $0. ctTaxableIncome: $280,000.
    // initialTax (Table B): 9500 + (280000-200000)*0.06 = 14300
    // phaseOutAddback (Table C): capped at $500
    // recapture (Table D, $270k-$280k step): $350
    // personalCredit (Table E, far past $100,500): $0.00
    // ctTaxComputed = 14300 + 500 + 350 - 14300*0 = 15150
    expect(r.connecticut.netTaxBeforeCreditsUnknown).toBe(false);
    expect(r.connecticut.recapture.requiresManualLookup).toBe(false);
    expect(r.connecticut.recapture.amount!.toString()).toBe("350");
    expect(r.connecticut.ctTaxComputed!.toString()).toBe("15150");
    expect(r.connecticut.balanceDueOrRefund!.toString()).toBe("-15150");
  });

  it("taxYear: 2024 (or any non-2025 value) -> throws", () => {
    const baseInput = {
      taxYear: 2024,
      wages: D("0"),
      medicareWages: D("0"),
      interestIncome: D("0"),
      glIncomeTotal: D("0"),
      glExpenseTotal: D("0"),
      mileageEntries: [] as MileageEntryInput[],
      homeOfficeSqft: null,
      mortgageInterestCents: 0,
      propertyTaxCents: 0,
      ctIncomeTaxWithheldCents: 0,
      charitableCents: null,
      saltCapCents: SALT_CAP_MFJ_2025 * 100,
      federalWithholdingCents: 0,
      estimatedPaymentsCents: null,
      ctWithholdingCents: 0,
    };
    expect(() => computePersonalTaxReturn(baseInput)).toThrow();
    expect(() => computePersonalTaxReturn({ ...baseInput, taxYear: 2026 })).toThrow();
  });
});
