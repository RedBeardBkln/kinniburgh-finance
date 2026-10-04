import { describe, expect, it } from "vitest";
import { D } from "@/lib/tax2025/money";
import {
  computeCtPayments,
  computeExcessSocialSecurity,
  computeFederalPayments,
  maxEmployeeSocialSecurityTax,
  type FederalPaymentsInput,
} from "@/lib/tax2025/rules/payments";
import {
  computeCtBalance,
  computeCtPropertyTaxCredit,
  computeCtTax,
  ctPropertyTaxPhaseOutDecimal,
  type CtCreditBill,
  type CtTaxInput,
} from "@/lib/tax2025/rules/ct";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

function amt(r: RuleResult, key: LineKey): string | null {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toString();
}
function st(r: RuleResult, key: LineKey): string | undefined {
  return r.lines.find((x) => x.key === key)?.status;
}

describe("excess Social Security (Schedule 3 line 11)", () => {
  it("the maximum employee tax is 6.2% of the $176,100 wage base = $10,918.20", () => {
    expect(maxEmployeeSocialSecurityTax().toString()).toBe("10918.2");
  });

  it("a spouse with two employers: 8,000 + 5,000 = 13,000 withheld -> excess 2,081.80 -> $2,082; a single-employer spouse gets nothing", () => {
    const r = computeExcessSocialSecurity({
      people: [
        { name: "Eric", w2Count: 2, totalWithheld: D(13000) },
        { name: "Eva", w2Count: 1, totalWithheld: D(11500) },
      ],
      unattributedW2Count: 0,
    });
    expect(r.status).toBe("computed");
    expect(amt(r, "sch3.11")).toBe("2082");
  });

  it("exactly at the maximum -> $0 (no excess)", () => {
    const r = computeExcessSocialSecurity({
      people: [{ name: "Eric", w2Count: 2, totalWithheld: D("10918.20") }],
      unattributedW2Count: 0,
    });
    expect(amt(r, "sch3.11")).toBe("0");
  });

  it("excess is figured per spouse and added before rounding", () => {
    const r = computeExcessSocialSecurity({
      people: [
        { name: "Eric", w2Count: 2, totalWithheld: D("11918.20") },
        { name: "Eva", w2Count: 2, totalWithheld: D("10918.70") },
      ],
      unattributedW2Count: 0,
    });
    // 1,000.00 + 0.50 = 1,000.50 -> 1,001
    expect(amt(r, "sch3.11")).toBe("1001");
  });

  it("nobody with two employers -> computed $0 with a reason", () => {
    const r = computeExcessSocialSecurity({
      people: [{ name: "Eric", w2Count: 1, totalWithheld: D(9000) }],
      unattributedW2Count: 0,
    });
    expect(amt(r, "sch3.11")).toBe("0");
    expect(r.reasons[0]).toContain("no excess");
  });

  it("a W-2 with no person, or a missing box 4 for a two-employer spouse -> missing_input", () => {
    expect(computeExcessSocialSecurity({ people: [], unattributedW2Count: 1 }).status).toBe("missing_input");
    const r = computeExcessSocialSecurity({
      people: [{ name: "Eric", w2Count: 2, totalWithheld: null }],
      unattributedW2Count: 0,
    });
    expect(r.status).toBe("missing_input");
    expect(amt(r, "sch3.11")).toBeNull();
  });
});

function fedInput(over: Partial<FederalPaymentsInput> = {}): FederalPaymentsInput {
  return {
    w2Withheld: D(15000),
    hasW2: true,
    form1099Withheld: D(0),
    additionalMedicareWithheld: D(900),
    estimates: D(8000),
    priorYearOverpaymentApplied: D(500),
    extensionPayment: D(2000),
    excessSocialSecurity: D(2082),
    ...over,
  };
}

describe("computeFederalPayments (D2: federal only; CT is separate)", () => {
  it("25d = 15,000 + 0 + 900; line 26 = 8,000 + 500; Schedule 3 = 2,000 + 2,082; line 33 = 15,900 + 8,500 + 4,082", () => {
    const r = computeFederalPayments(fedInput());
    expect(r.status).toBe("computed");
    expect(amt(r, "f1040.25a")).toBe("15000");
    expect(amt(r, "f1040.25c")).toBe("900");
    expect(amt(r, "f1040.25d")).toBe("15900");
    expect(amt(r, "f1040.26")).toBe("8500");
    expect(amt(r, "sch3.10")).toBe("2000");
    expect(amt(r, "sch3.11")).toBe("2082");
    expect(amt(r, "sch3.15")).toBe("4082");
    expect(amt(r, "f1040.31")).toBe("4082");
    expect(amt(r, "f1040.33")).toBe("28482");
  });

  it("estimated payments unknown -> line 26 and 33 are missing_input (not 0); the reason says to enter federal and CT separately", () => {
    const r = computeFederalPayments(fedInput({ estimates: null }));
    expect(st(r, "f1040.26")).toBe("missing_input");
    expect(amt(r, "f1040.26")).toBeNull();
    expect(amt(r, "f1040.33")).toBeNull();
    expect(r.lines.find((l) => l.key === "f1040.26")?.reason).toContain("separately");
    expect(r.status).toBe("missing_input");
  });

  it("no W-2 on file -> withholding is unknown, not 0", () => {
    const r = computeFederalPayments(fedInput({ hasW2: false, w2Withheld: null }));
    expect(st(r, "f1040.25a")).toBe("missing_input");
    expect(st(r, "f1040.25d")).toBe("missing_input");
  });

  it("no extension payment stated -> Schedule 3 line 10 missing_input", () => {
    const r = computeFederalPayments(fedInput({ extensionPayment: null }));
    expect(st(r, "sch3.10")).toBe("missing_input");
    expect(st(r, "f1040.31")).toBe("missing_input");
  });

  it("Form 8959 not computed -> 25c missing_input", () => {
    const r = computeFederalPayments(fedInput({ additionalMedicareWithheld: null }));
    expect(st(r, "f1040.25c")).toBe("missing_input");
  });

  it("1099 withholding goes to 25b", () => {
    const r = computeFederalPayments(fedInput({ form1099Withheld: D("123.50") }));
    expect(amt(r, "f1040.25b")).toBe("124");
  });
});

describe("computeCtPayments (acceptance 9: CT payments reach lines 18-20)", () => {
  it("withholding 5,400; estimates 1,000 + overpayment 500; extension 750", () => {
    const r = computeCtPayments({
      withholding: D(5400),
      hasW2: true,
      estimates: D(1000),
      priorYearOverpaymentApplied: D(500),
      extensionPayment: D(750),
    });
    expect(amt(r, "ct1040.18")).toBe("5400");
    expect(amt(r, "ct1040.19")).toBe("1500");
    expect(amt(r, "ct1040.20")).toBe("750");
    expect(r.status).toBe("computed");
  });
  it("unknown CT estimates / extension payment -> missing_input", () => {
    const r = computeCtPayments({
      withholding: D(5400),
      hasW2: true,
      estimates: null,
      priorYearOverpaymentApplied: D(0),
      extensionPayment: null,
    });
    expect(st(r, "ct1040.19")).toBe("missing_input");
    expect(st(r, "ct1040.20")).toBe("missing_input");
    expect(st(r, "ct1040.18")).toBe("computed");
  });
});

// CT property tax credit: max $300; MFJ full at CT AGI <= $70,500; decimals .15/.30/.45/.60/.75/.90, 1.00 above $130,500.
describe("CT property tax credit (acceptance 8)", () => {
  const bill = (kind: CtCreditBill["kind"], paid: string | null, label = "bill"): CtCreditBill => ({
    docId: `b-${label}`,
    label,
    kind,
    paid: paid === null ? null : D(paid),
  });

  it("phase-out decimal by band edge", () => {
    expect(ctPropertyTaxPhaseOutDecimal(D(70500)).toString()).toBe("0");
    expect(ctPropertyTaxPhaseOutDecimal(D(70501)).toString()).toBe("0.15");
    expect(ctPropertyTaxPhaseOutDecimal(D(80500)).toString()).toBe("0.15");
    expect(ctPropertyTaxPhaseOutDecimal(D(80501)).toString()).toBe("0.3");
    expect(ctPropertyTaxPhaseOutDecimal(D(130500)).toString()).toBe("0.9");
    expect(ctPropertyTaxPhaseOutDecimal(D(130501)).toString()).toBe("1");
  });

  it("CT AGI $70,500: full credit = min(paid, 300)", () => {
    const big = computeCtPropertyTaxCredit({ ctAgi: D(70500), bills: [bill("primary_residence", "4000")], ctTaxBeforeCredits: D(5000) });
    expect(amt(big, "ct1040.11")).toBe("300");
    expect(big.conclusion).toBe("eligible");
    const small = computeCtPropertyTaxCredit({ ctAgi: D(70500), bills: [bill("primary_residence", "120")], ctTaxBeforeCredits: D(5000) });
    expect(amt(small, "ct1040.11")).toBe("120");
  });

  it("CT AGI $80,000: 300 x (1 - .15) = $255; $130,500: 300 x .10 = $30", () => {
    const at80 = computeCtPropertyTaxCredit({ ctAgi: D(80000), bills: [bill("primary_residence", "4000")], ctTaxBeforeCredits: D(5000) });
    expect(amt(at80, "ct1040.11")).toBe("255");
    const at130 = computeCtPropertyTaxCredit({ ctAgi: D(130500), bills: [bill("primary_residence", "4000")], ctTaxBeforeCredits: D(9000) });
    expect(amt(at130, "ct1040.11")).toBe("30");
  });

  it("CT AGI $130,501: $0 even with bills missing paid amounts (fully phased out)", () => {
    const r = computeCtPropertyTaxCredit({ ctAgi: D(130501), bills: [bill("unclassified", null)], ctTaxBeforeCredits: null });
    expect(r.status).toBe("computed");
    expect(amt(r, "ct1040.11")).toBe("0");
    expect(r.conclusion).toBe("ineligible");
  });

  it("the Arbor Rd bill (other real estate) is excluded; only the primary residence counts", () => {
    const r = computeCtPropertyTaxCredit({
      ctAgi: D(70000),
      bills: [bill("primary_residence", "100", "27 Old Barry Rd"), bill("other_real_estate", "3000", "56 Arbor Rd")],
      ctTaxBeforeCredits: D(5000),
    });
    expect(amt(r, "ct1040.11")).toBe("100");
    expect(r.reasons.join(" ")).toContain("56 Arbor Rd");
  });

  it("only up to two motor vehicles count (the two largest)", () => {
    const r = computeCtPropertyTaxCredit({
      ctAgi: D(70000),
      bills: [bill("motor_vehicle", "100", "a"), bill("motor_vehicle", "90", "b"), bill("motor_vehicle", "80", "c")],
      ctTaxBeforeCredits: D(5000),
    });
    expect(amt(r, "ct1040.11")).toBe("190");
  });

  it("the credit cannot exceed the CT income tax (not refundable)", () => {
    const r = computeCtPropertyTaxCredit({ ctAgi: D(70000), bills: [bill("primary_residence", "4000")], ctTaxBeforeCredits: D(50) });
    expect(amt(r, "ct1040.11")).toBe("50");
  });

  it("unclassified bill, unpaid bill, unknown tax or unknown CT AGI -> missing_input", () => {
    const unclassified = computeCtPropertyTaxCredit({ ctAgi: D(70000), bills: [bill("unclassified", "4000")], ctTaxBeforeCredits: D(5000) });
    expect(unclassified.status).toBe("missing_input");
    const unpaid = computeCtPropertyTaxCredit({ ctAgi: D(70000), bills: [bill("primary_residence", null)], ctTaxBeforeCredits: D(5000) });
    expect(unpaid.status).toBe("missing_input");
    const noTax = computeCtPropertyTaxCredit({ ctAgi: D(70000), bills: [bill("primary_residence", "4000")], ctTaxBeforeCredits: null });
    expect(noTax.status).toBe("missing_input");
    const noAgi = computeCtPropertyTaxCredit({ ctAgi: null, bills: [], ctTaxBeforeCredits: null });
    expect(noAgi.status).toBe("missing_input");
  });
});

function ctInput(over: Partial<CtTaxInput> = {}): CtTaxInput {
  return {
    federalAgi: D(150000),
    additions: D(0),
    subtractions: D(0),
    federalAmt: D(0),
    otherStateWithholdingPresent: false,
    ...over,
  };
}

describe("computeCtTax", () => {
  it("CT AGI 150,000: initial 4,000 + 5.5% x 50,000 = 6,750; Table C 500; Table D 0; personal credit .00 -> $7,250", () => {
    const r = computeCtTax(ctInput());
    expect(amt(r, "ct1040.ctAgi")).toBe("150000");
    expect(amt(r, "ct1040.6")).toBe("7250");
    expect(st(r, "ct1040.9")).toBe("not_applicable");
    expect(amt(r, "ct1040.10")).toBe("7250");
  });

  it("Table C edge via the engine: CT AGI 145,500 uses $450; 145,501 uses $500", () => {
    // 145,500: 4,000 + .055 x 45,500 = 6,502.50; + 450 = 6,952.50 -> 6,953 (half up)
    expect(amt(computeCtTax(ctInput({ federalAgi: D(145500) })), "ct1040.6")).toBe("6953");
    // 145,501: 4,000 + .055 x 45,501 = 6,502.555; + 500 = 7,002.555 -> 7,003
    expect(amt(computeCtTax(ctInput({ federalAgi: D(145501) })), "ct1040.6")).toBe("7003");
  });

  it("Schedule 1 additions and subtractions move CT AGI: 150,000 + 5,000 - 2,000 = 153,000", () => {
    const r = computeCtTax(ctInput({ additions: D(5000), subtractions: D(2000) }));
    expect(amt(r, "ct1040.ctAgi")).toBe("153000");
  });

  it("modifications not stated -> not_yet_computed (never silently 0)", () => {
    const r = computeCtTax(ctInput({ additions: null, subtractions: null }));
    expect(r.status).toBe("not_yet_computed");
    expect(st(r, "ct1040.ctAgi")).toBe("not_yet_computed");
    expect(amt(r, "ct1040.6")).toBeNull();
  });

  it("modificationsBlock (from the CT Schedule 1 rule) sets the status and reason of the totals, CT AGI, tax, AMT and line 10", () => {
    for (const status of ["missing_input", "needs_cpa_judgment", "needs_cpa_rule_unverified"] as const) {
      const r = computeCtTax(ctInput({ additions: null, subtractions: null, modificationsBlock: { status, reason: "Schedule 1 line 40 waits." } }));
      expect(r.status).toBe(status);
      for (const k of ["ct1040.additions", "ct1040.subtractions", "ct1040.ctAgi", "ct1040.6", "ct1040.9", "ct1040.10"] as const) {
        expect(st(r, k), `${status} ${k}`).toBe(status);
        expect(amt(r, k), k).toBeNull();
      }
      expect(r.reasons[0]).toContain("line 40");
    }
  });

  it("only one of the two totals is final: that total keeps its amount, CT AGI and tax stay blocked", () => {
    const r = computeCtTax(ctInput({ additions: D(300), subtractions: null, modificationsBlock: { status: "missing_input", reason: "Line 40 waits." } }));
    expect(amt(r, "ct1040.additions")).toBe("300");
    expect(amt(r, "ct1040.subtractions")).toBeNull();
    expect(st(r, "ct1040.ctAgi")).toBe("missing_input");
  });

  it("CT AGI at or under $24,000 -> no tax (verified); up to $102,000 -> needs_cpa_rule_unverified with the TCS figure in the reason", () => {
    expect(amt(computeCtTax(ctInput({ federalAgi: D(24000) })), "ct1040.6")).toBe("0");
    const mid = computeCtTax(ctInput({ federalAgi: D(90000) }));
    expect(st(mid, "ct1040.6")).toBe("needs_cpa_rule_unverified");
    // TCS reference: initial 400 + 4.5% x 70,000 = 3,550; personal credit .10 -> 3,195
    expect(mid.reasons.join(" ")).toContain("$3,195");
    expect(st(computeCtTax(ctInput({ federalAgi: D(102001) })), "ct1040.6")).toBe("computed");
    expect(st(computeCtTax(ctInput({ federalAgi: D(102000) })), "ct1040.6")).toBe("needs_cpa_rule_unverified");
  });

  it("federal AMT: unknown -> missing_input; > 0 -> CT-6251 needs_cpa_rule_unverified", () => {
    expect(st(computeCtTax(ctInput({ federalAmt: null })), "ct1040.9")).toBe("missing_input");
    expect(st(computeCtTax(ctInput({ federalAmt: D(100) })), "ct1040.9")).toBe("needs_cpa_rule_unverified");
  });

  it("non-CT state withholding on a W-2 -> line 10 needs_cpa_judgment", () => {
    expect(st(computeCtTax(ctInput({ otherStateWithholdingPresent: true })), "ct1040.10")).toBe("needs_cpa_judgment");
  });

  it("federal AGI missing -> missing_input", () => {
    const r = computeCtTax(ctInput({ federalAgi: null }));
    expect(r.status).toBe("missing_input");
    expect(amt(r, "ct1040.6")).toBeNull();
  });
});

describe("computeCtBalance", () => {
  it("tax 7,250 - credit 0 + use tax 0 - payments 6,900 = 350 owed; penalty and interest flagged unverified", () => {
    const r = computeCtBalance({ taxBeforeCredits: D(7250), propertyTaxCredit: D(0), useTax: D(0), totalPayments: D(6900) });
    expect(amt(r, "ct1040.balance")).toBe("350");
    expect(amt(r, "ct1040.15")).toBe("0");
    expect(st(r, "ct1040.27")).toBe("needs_cpa_rule_unverified");
    expect(st(r, "ct1040.28")).toBe("needs_cpa_rule_unverified");
    expect(amt(r, "ct1040.27")).toBeNull();
  });

  it("use tax not answered -> line 15 missing_input (must enter 0 or an amount) and no balance", () => {
    const r = computeCtBalance({ taxBeforeCredits: D(7250), propertyTaxCredit: D(0), useTax: null, totalPayments: D(6900) });
    expect(st(r, "ct1040.15")).toBe("missing_input");
    expect(amt(r, "ct1040.balance")).toBeNull();
  });

  it("an overpayment is negative", () => {
    const r = computeCtBalance({ taxBeforeCredits: D(1000), propertyTaxCredit: D(100), useTax: D(0), totalPayments: D(1500) });
    expect(amt(r, "ct1040.balance")).toBe("-600");
  });
});
