import { describe, expect, it } from "vitest";
import { D } from "@/lib/tax2025/money";
import {
  computeScheduleA,
  saltCapForMagi,
  type DonationInput,
  type MortgageInput,
  type PropertyBillInput,
  type ScheduleAInput,
} from "@/lib/tax2025/rules/schedule-a";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

function amt(r: RuleResult, key: LineKey): string | null {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toString();
}
function st(r: RuleResult, key: LineKey): string | undefined {
  return r.lines.find((x) => x.key === key)?.status;
}

const mortgage = (interest: string, principal = "400000", extra: Partial<MortgageInput> = {}): MortgageInput => ({
  docId: "m1",
  label: "Lender",
  interest: D(interest),
  principal: D(principal),
  mortgageInsurance: null,
  points: null,
  legacyFormat: false,
  ...extra,
});
const billOf = (kind: PropertyBillInput["kind"], paid: string | null, label = "bill"): PropertyBillInput => ({
  docId: `b-${label}`,
  label,
  kind,
  paid: paid === null ? null : D(paid),
});
const gift = (kind: "cash" | "noncash", dollars: number, substantiation = "written_acknowledgment"): DonationInput => ({
  id: `d-${kind}-${dollars}`,
  kind,
  amount: D(dollars),
  amountCents: dollars * 100,
  substantiation,
  receiptDocumentId: "r1",
});

function base(over: Partial<ScheduleAInput> = {}): ScheduleAInput {
  return {
    agi: D(150000),
    ctWithholding: D(4200),
    ctEstimatesPaidIn2025: D(2000),
    ctPriorYearBalancePaidIn2025: D(500),
    propertyBills: [billOf("primary_residence", "6000", "home"), billOf("motor_vehicle", "300", "car")],
    propertyTaxNoneConfirmed: false,
    mortgages: [mortgage("18882.69")],
    donations: [],
    donationsNoneConfirmed: true,
    ...over,
  };
}

// Schedule A SALT cap worksheet (2025 Schedule A instructions): line 1 $40,000; line 6 = MAGI over
// $500,000; line 7 = line 6 x 30%; line 8 = line 1 - line 7; line 9 = larger of line 8 or $10,000.
describe("saltCapForMagi (acceptance 6)", () => {
  it("MAGI at or under $500,000 -> $40,000", () => {
    expect(saltCapForMagi(D(100000)).toString()).toBe("40000");
    expect(saltCapForMagi(D(500000)).toString()).toBe("40000");
  });
  it("MAGI $520,000 -> 40,000 - 0.3 x 20,000 = $34,000", () => {
    expect(saltCapForMagi(D(520000)).toString()).toBe("34000");
  });
  it("MAGI $510,000 -> $37,000", () => {
    expect(saltCapForMagi(D(510000)).toString()).toBe("37000");
  });
  it("MAGI $900,000 -> 40,000 - 120,000 is below the floor -> $10,000", () => {
    expect(saltCapForMagi(D(900000)).toString()).toBe("10000");
  });
  it("the floor is reached at MAGI $600,000 (40,000 - 30,000 = 10,000) and stays", () => {
    expect(saltCapForMagi(D(600000)).toString()).toBe("10000");
    expect(saltCapForMagi(D(700000)).toString()).toBe("10000");
  });
  it("rounds line 7 to whole dollars (MAGI $533,334 -> 33,334 x 30% = 10,000.2 -> 10,000 -> cap 30,000)", () => {
    expect(saltCapForMagi(D(533334)).toString()).toBe("30000");
  });
});

describe("computeScheduleA: itemizing", () => {
  it("totals SALT (withholding + 2025 estimates + 2024 balance + bills), interest, gifts; itemizes when strictly more than $31,500", () => {
    // 5a = 4,200 + 2,000 + 500 = 6,700; 5b = 6,000; 5c = 300; 5d = 13,000 (under the cap);
    // 8a = 18,882.69 -> 18,883; gifts 0 (none confirmed); line 17 = 13,000 + 18,883 = 31,883 > 31,500
    const r = computeScheduleA(base());
    expect(amt(r, "scha.5a")).toBe("6700");
    expect(amt(r, "scha.5b")).toBe("6000");
    expect(amt(r, "scha.5c")).toBe("300");
    expect(amt(r, "scha.5d")).toBe("13000");
    expect(amt(r, "scha.5e")).toBe("13000");
    expect(amt(r, "scha.8a")).toBe("18883");
    expect(amt(r, "scha.14")).toBe("0");
    expect(amt(r, "scha.17")).toBe("31883");
    expect(amt(r, "f1040.12e")).toBe("31883");
    expect(r.status).toBe("computed");
    expect(r.lines.find((l) => l.key === "f1040.12e")?.label).toBe("Itemized deductions");
    expect(r.decision).toBeUndefined(); // no non-primary real estate bill -> no X5
  });

  it("D6: CT estimated payments and the 2024 balance count; withholding alone would give less", () => {
    const withholdingOnly = computeScheduleA(base({ ctEstimatesPaidIn2025: D(0), ctPriorYearBalancePaidIn2025: D(0) }));
    expect(amt(withholdingOnly, "scha.5a")).toBe("4200");
    const full = computeScheduleA(base());
    expect(amt(full, "scha.5a")).toBe("6700");
  });

  it("an exact tie with the standard deduction takes the standard deduction (31,500)", () => {
    // SALT 10,000 (bill) ... build itemized = 31,500: mortgage 21,500 + SALT 10,000
    const r = computeScheduleA(
      base({
        ctWithholding: D(0),
        ctEstimatesPaidIn2025: D(0),
        ctPriorYearBalancePaidIn2025: D(0),
        propertyBills: [billOf("primary_residence", "10000")],
        mortgages: [mortgage("21500")],
      })
    );
    expect(amt(r, "scha.17")).toBe("31500");
    expect(amt(r, "f1040.12e")).toBe("31500");
    expect(r.lines.find((l) => l.key === "f1040.12e")?.label).toBe("Standard deduction");
    expect(r.reasons.join(" ")).toContain("tie");
  });

  it("$1 over the standard deduction itemizes", () => {
    const r = computeScheduleA(
      base({
        ctWithholding: D(0),
        ctEstimatesPaidIn2025: D(0),
        ctPriorYearBalancePaidIn2025: D(0),
        propertyBills: [billOf("primary_residence", "10000")],
        mortgages: [mortgage("21501")],
      })
    );
    expect(amt(r, "f1040.12e")).toBe("31501");
    expect(r.lines.find((l) => l.key === "f1040.12e")?.label).toBe("Itemized deductions");
  });

  it("standard deduction wins when itemized is lower", () => {
    const r = computeScheduleA(base({ mortgages: [mortgage("2000")] }));
    expect(amt(r, "scha.17")).toBe("15000");
    expect(amt(r, "f1040.12e")).toBe("31500");
  });

  it("the SALT cap binds: $45,000 of taxes at MAGI $400,000 -> $40,000; at MAGI $520,000 -> $34,000", () => {
    const common = {
      ctWithholding: D(20000),
      ctEstimatesPaidIn2025: D(10000),
      ctPriorYearBalancePaidIn2025: D(0),
      propertyBills: [billOf("primary_residence", "15000")],
    };
    const lowMagi = computeScheduleA(base({ ...common, agi: D(400000) }));
    expect(amt(lowMagi, "scha.5d")).toBe("45000");
    expect(amt(lowMagi, "scha.5e")).toBe("40000");
    const highMagi = computeScheduleA(base({ ...common, agi: D(520000) }));
    expect(amt(highMagi, "scha.5e")).toBe("34000");
    expect(highMagi.reasons.join(" ")).toContain("lost to the cap");
  });
});

describe("computeScheduleA: missing input is never zero", () => {
  it("unknown CT estimated payments -> 5a missing_input, itemized and line 12 missing_input", () => {
    const r = computeScheduleA(base({ ctEstimatesPaidIn2025: null }));
    expect(st(r, "scha.5a")).toBe("missing_input");
    expect(amt(r, "scha.5a")).toBeNull();
    expect(st(r, "scha.17")).toBe("missing_input");
    expect(st(r, "f1040.12e")).toBe("missing_input");
    expect(r.status).toBe("missing_input");
    expect(r.inputsMissing).toContain("CT estimated payments made in 2025");
  });

  it("no property tax bills and no confirmation -> missing_input; with confirmation -> $0", () => {
    const none = computeScheduleA(base({ propertyBills: [] }));
    expect(st(none, "scha.5b")).toBe("missing_input");
    const confirmed = computeScheduleA(base({ propertyBills: [], propertyTaxNoneConfirmed: true }));
    expect(amt(confirmed, "scha.5b")).toBe("0");
  });

  it("an unclassified bill or a bill with no paid amount blocks property tax", () => {
    const unclassified = computeScheduleA(base({ propertyBills: [billOf("unclassified", "6000", "Old Barry")] }));
    expect(st(unclassified, "scha.5b")).toBe("missing_input");
    expect(unclassified.lines.find((l) => l.key === "scha.5b")?.reason).toContain("classify");
    const unpaid = computeScheduleA(base({ propertyBills: [billOf("other_real_estate", null, "Arbor Rd")] }));
    expect(st(unpaid, "scha.5b")).toBe("missing_input");
    expect(unpaid.lines.find((l) => l.key === "scha.5b")?.reason).toContain("Arbor Rd");
  });

  it("no AGI -> the SALT cap cannot be applied", () => {
    const r = computeScheduleA(base({ agi: null }));
    expect(st(r, "scha.5e")).toBe("missing_input");
    expect(st(r, "f1040.12e")).toBe("missing_input");
  });

  it("no Form 1098 -> mortgage interest missing_input", () => {
    const r = computeScheduleA(base({ mortgages: [] }));
    expect(st(r, "scha.8a")).toBe("missing_input");
  });
});

describe("computeScheduleA: mortgage rules", () => {
  it("principal exactly $750,000 is within the limit; $750,001 -> needs_cpa_rule_unverified", () => {
    const within = computeScheduleA(base({ mortgages: [mortgage("30000", "750000")] }));
    expect(st(within, "scha.8a")).toBe("computed");
    const over = computeScheduleA(base({ mortgages: [mortgage("30000", "750001")] }));
    expect(st(over, "scha.8a")).toBe("needs_cpa_rule_unverified");
    expect(over.status).toBe("needs_cpa_rule_unverified");
    expect(st(over, "f1040.12e")).toBe("needs_cpa_rule_unverified");
  });

  it("the limit applies to the SUM of principal across 1098s", () => {
    const r = computeScheduleA(base({ mortgages: [mortgage("20000", "500000"), mortgage("10000", "300000", { docId: "m2" })] }));
    expect(st(r, "scha.8a")).toBe("needs_cpa_rule_unverified");
  });

  it("points (box 6) or mortgage insurance premiums (box 5) reported -> line 8a needs_cpa_rule_unverified", () => {
    const points = computeScheduleA(base({ mortgages: [mortgage("18000", "400000", { points: D(5000) })] }));
    expect(st(points, "scha.8a")).toBe("needs_cpa_rule_unverified");
    expect(st(points, "scha.17")).toBe("needs_cpa_rule_unverified");
    expect(points.lines.find((l) => l.key === "scha.8a")?.reason).toContain("points");
    const mip = computeScheduleA(base({ mortgages: [mortgage("18000", "400000", { mortgageInsurance: D(900) })] }));
    expect(st(mip, "scha.8a")).toBe("needs_cpa_rule_unverified");
    expect(mip.lines.find((l) => l.key === "scha.8a")?.reason).toContain("no line");
  });

  it("missing box 2 principal -> the limit cannot be checked: missing_input", () => {
    const r = computeScheduleA(base({ mortgages: [{ ...mortgage("18000"), principal: null }] }));
    expect(st(r, "scha.8a")).toBe("missing_input");
  });
});

describe("computeScheduleA: charitable gifts from the donation log", () => {
  it("gifts within 20% of AGI are deducted in full", () => {
    const r = computeScheduleA(base({ donations: [gift("cash", 500), gift("noncash", 200)], donationsNoneConfirmed: false }));
    expect(amt(r, "scha.11")).toBe("500");
    expect(amt(r, "scha.12")).toBe("200");
    expect(amt(r, "scha.14")).toBe("700");
  });

  it("gifts over 20% of AGI -> needs_cpa_rule_unverified (60% cash limit not verified)", () => {
    // AGI 150,000 -> 20% = 30,000; gifts 30,001
    const r = computeScheduleA(base({ donations: [gift("cash", 30001)], donationsNoneConfirmed: false }));
    expect(st(r, "scha.14")).toBe("needs_cpa_rule_unverified");
    expect(st(r, "f1040.12e")).toBe("needs_cpa_rule_unverified");
    // exactly 20% is fine
    const at = computeScheduleA(base({ donations: [gift("cash", 30000)], donationsNoneConfirmed: false }));
    expect(st(at, "scha.14")).toBe("computed");
  });

  it("empty log with no confirmation -> missing_input; empty log with 'none' -> $0", () => {
    const missing = computeScheduleA(base({ donations: [], donationsNoneConfirmed: false }));
    expect(st(missing, "scha.14")).toBe("missing_input");
    const none = computeScheduleA(base({ donations: [], donationsNoneConfirmed: true }));
    expect(amt(none, "scha.14")).toBe("0");
  });

  it("noncash gifts over $500 flag Form 8283; unsubstantiated gifts are flagged", () => {
    const r = computeScheduleA(
      base({ donations: [gift("noncash", 501, "none")], donationsNoneConfirmed: false })
    );
    expect(r.reasons.join(" ")).toContain("Form 8283");
    expect(r.reasons.join(" ")).toContain("substantiation");
  });

  it("noncash gifts of exactly $500 do not require Form 8283", () => {
    const r = computeScheduleA(base({ donations: [gift("noncash", 500)], donationsNoneConfirmed: false }));
    expect(r.reasons.join(" ")).not.toContain("Form 8283");
  });
});

describe("computeScheduleA: decision X5 (non-primary real estate, 56 Arbor Rd)", () => {
  const withArbor = () =>
    base({
      ctWithholding: D(0),
      ctEstimatesPaidIn2025: D(0),
      ctPriorYearBalancePaidIn2025: D(0),
      propertyBills: [billOf("primary_residence", "6000", "home"), billOf("other_real_estate", "3000", "Arbor Rd")],
      mortgages: [mortgage("25000")],
    });

  it("undecided: Schedule A is used and marked default, undecided; both alternatives are computed side by side", () => {
    const r = computeScheduleA(withArbor());
    expect(amt(r, "scha.5b")).toBe("9000");
    expect(r.decision).toMatchObject({ id: "X5", chosen: "schedule_a", status: "default_undecided" });
    expect(r.alternatives).toHaveLength(2);
    const [a, b] = r.alternatives!;
    expect(a!.id).toBe("schedule_a");
    expect(a!.isDefault).toBe(true);
    expect(a!.inForce).toBe(true);
    expect(a!.effect!.amount!.toString()).toBe("34000"); // 9,000 + 25,000
    expect(b!.id).toBe("capitalize");
    expect(b!.inForce).toBe(false);
    expect(b!.effect!.amount!.toString()).toBe("31000"); // 6,000 + 25,000
  });

  it("decided: capitalize removes the Arbor Rd tax from Schedule A and records who decided", () => {
    const r = computeScheduleA({
      ...withArbor(),
      arborDecision: { chosen: "capitalize", by: "cpa", at: "2026-10-05T12:00:00Z" },
    });
    expect(amt(r, "scha.5b")).toBe("6000");
    expect(r.decision).toMatchObject({ chosen: "capitalize", status: "decided", decidedBy: "cpa" });
    expect(r.alternatives!.find((x) => x.id === "capitalize")!.inForce).toBe(true);
    expect(r.alternatives!.find((x) => x.id === "schedule_a")!.inForce).toBe(false);
  });
});
