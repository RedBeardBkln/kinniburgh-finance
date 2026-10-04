// Tester (independent) verification of the Phase 1b rules. Every expected value below was derived BY HAND from the
// printed IRS forms / instructions (Schedule 1-A, Form 8889 + instructions, Pub. 590-A Worksheet 1-2, Form 8880, Form 2210,
// the 2025 Form 1040 instructions standard deduction chart, the CT-1040 use tax worksheet), NOT copied from the
// implementation. The Form 2210 expectations also come from an independent Python re-implementation of the form's
// Part III Section A lines 10-18 and the penalty worksheet (Fraction arithmetic).
import { describe, expect, it } from "vitest";
import { answered, MISSING, UNSURE } from "@/lib/tax2025/answer-state";
import { D } from "@/lib/tax2025/money";
import { computeCtUseTax } from "@/lib/tax2025/rules/ct-use-tax";
import { computeForeignTaxCredit } from "@/lib/tax2025/rules/foreign-tax";
import { computeHsa8889, type HsaPersonInput } from "@/lib/tax2025/rules/hsa-8889";
import { computeIraDeduction, type IraPersonInput } from "@/lib/tax2025/rules/ira-deduction";
import { computePenalty2210 } from "@/lib/tax2025/rules/penalty-2210";
import { computeSaversCredit } from "@/lib/tax2025/rules/saver-8880";
import { computeSchedule1a, type Sch1aInput, type Sch1aPersonInput } from "@/lib/tax2025/rules/schedule-1a";
import { computeStandardDeduction } from "@/lib/tax2025/rules/standard-deduction";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

const amt = (r: RuleResult, key: LineKey): string | null => {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toString();
};
const st = (r: RuleResult, key: LineKey): string | undefined => {
  const l = r.lines.find((x) => x.key === key);
  return l ? (l.status ?? r.status) : undefined;
};

// ─────────────────────────────────────────────────────────────────────────────
// Schedule 1-A
// ─────────────────────────────────────────────────────────────────────────────
function s1aPerson(name: string, over: Partial<Sch1aPersonInput> = {}): Sch1aPersonInput {
  return { name, bornBefore1961: answered(false), validSsn: answered(true), tips: answered("none"), tipsAmount: MISSING, overtime: answered("none"), overtimeAmount: MISSING, ...over };
}
function s1a(magi: number | null, people: Sch1aPersonInput[], car: Partial<Sch1aInput["carLoan"]> = {}): RuleResult {
  return computeSchedule1a({
    magi: magi === null ? null : D(magi),
    magiExclusionsNone: answered(true),
    people,
    carLoan: { choice: answered("none"), qualifies: MISSING, interestPaid: MISSING, deductedElsewhere: MISSING, ...car },
    tipsEmployers: null,
    scheduleCOwnerTips: answered("none"),
  });
}
const otPerson = (name: string, premium: number): Sch1aPersonInput => s1aPerson(name, { overtime: answered("premium"), overtimeAmount: answered(D(premium)) });
const tipPerson = (name: string, tips: number): Sch1aPersonInput => s1aPerson(name, { tips: answered("some"), tipsAmount: answered(D(tips)) });
const none = (n: string) => s1aPerson(n);

describe("Schedule 1-A: overtime (Part III, lines 14-21: smaller of 14c or 25,000; reduce $100 per full $1,000 of MAGI over 300,000, rounded DOWN)", () => {
  // [premium, MAGI, expected line 21]
  const cases: [number, number, string][] = [
    [20000, 310000, "19000"], // plan criterion 5: 20,000 - 100 x 10
    [20000, 300000, "20000"], // no excess
    [20000, 300001, "20000"], // 0.001 rounds DOWN to 0
    [20000, 300999, "20000"], // 0.999 rounds DOWN to 0
    [20000, 301000, "19900"], // exactly 1
    [20000, 310999, "19000"], // 10.999 -> 10
    [20000, 311000, "18900"],
    [30000, 300000, "25000"], // cap 25,000 MFJ
    [25000, 330000, "22000"], // 25,000 - 3,000
    [20000, 500000, "0"], // 200 x 100 = 20,000 -> 0
    [20000, 900000, "0"], // never negative
  ];
  for (const [premium, magi, expected] of cases) {
    it(`premium ${premium} at MAGI ${magi} -> ${expected}`, () => {
      const r = s1a(magi, [otPerson("Eric", premium), none("Eva")]);
      expect(amt(r, "sch1a.21")).toBe(expected);
      expect(amt(r, "sch1a.38")).toBe(expected);
    });
  }
  it("the 25,000 cap is COMBINED, not per spouse: 15,000 + 15,000 = 30,000 -> 25,000; at MAGI 305,000 -> 24,500", () => {
    const r = s1a(305000, [otPerson("Eric", 15000), otPerson("Eva", 15000)]);
    expect(amt(r, "sch1a.15")).toBe("25000");
    expect(amt(r, "sch1a.21")).toBe("24500");
  });
  it("'total pay for the overtime hours' is divided by three (instructions Example 1: 15,000 -> 5,000)", () => {
    const r = s1a(100000, [s1aPerson("Eric", { overtime: answered("total"), overtimeAmount: answered(D(15000)) }), none("Eva")]);
    expect(amt(r, "sch1a.14a")).toBe("5000");
    expect(amt(r, "sch1a.21")).toBe("5000");
  });
  it("SSN: a person with overtime but no valid SSN gets 0; an unanswered SSN blocks (never 0); 'not sure' = needs_cpa_judgment", () => {
    expect(amt(s1a(100000, [s1aPerson("Eric", { overtime: answered("premium"), overtimeAmount: answered(D(5000)), validSsn: answered(false) }), none("Eva")]), "sch1a.21")).toBe("0");
    const miss = s1a(100000, [s1aPerson("Eric", { overtime: answered("premium"), overtimeAmount: answered(D(5000)), validSsn: MISSING }), none("Eva")]);
    expect(amt(miss, "sch1a.21")).toBeNull();
    expect(st(miss, "sch1a.21")).toBe("missing_input");
    expect(amt(miss, "sch1a.38")).toBeNull();
    const uns = s1a(100000, [s1aPerson("Eric", { overtime: answered("premium"), overtimeAmount: answered(D(5000)), validSsn: UNSURE }), none("Eva")]);
    expect(st(uns, "sch1a.21")).toBe("needs_cpa_judgment");
  });
  it("ask-the-employer is missing_input and blocks the total; not-sure is needs_cpa_judgment", () => {
    const ask = s1a(100000, [s1aPerson("Eric", { overtime: answered("ask_employer") }), none("Eva")]);
    expect(st(ask, "sch1a.21")).toBe("missing_input");
    expect(amt(ask, "sch1a.38")).toBeNull();
    const uns = s1a(100000, [s1aPerson("Eric", { overtime: UNSURE }), none("Eva")]);
    expect(st(uns, "sch1a.21")).toBe("needs_cpa_judgment");
  });
});

describe("Schedule 1-A: tips (Part II, lines 4-13: smaller of 6 or 25,000 combined; same MAGI reduction)", () => {
  const cases: [number, number, string][] = [
    [18000, 100000, "18000"],
    [30000, 100000, "25000"], // cap
    [25000, 320000, "23000"], // excess 20,000 -> 20 -> 2,000
    [25000, 300999, "25000"],
    [25000, 301000, "24900"],
    [25000, 550000, "0"], // 250 -> 25,000 -> 0
  ];
  for (const [tips, magi, expected] of cases) {
    it(`tips ${tips} at MAGI ${magi} -> ${expected}`, () => {
      const r = s1a(magi, [tipPerson("Eric", tips), none("Eva")]);
      expect(amt(r, "sch1a.13")).toBe(expected);
    });
  }
  it("combined cap: 18,000 + 12,000 = 30,000 -> 25,000 (not 25,000 each)", () => {
    const r = s1a(100000, [tipPerson("Eric", 18000), tipPerson("Eva", 12000)]);
    expect(amt(r, "sch1a.7")).toBe("25000");
    expect(amt(r, "sch1a.13")).toBe("25000");
  });
});

describe("Schedule 1-A: qualified car-loan interest (Part IV, lines 22-30: max 10,000; reduce $200 per $1,000 over 200,000 rounded UP)", () => {
  const car = (paid: number, elsewhere = 0): Partial<Sch1aInput["carLoan"]> => ({ choice: answered("some"), qualifies: answered(true), interestPaid: answered(D(paid)), deductedElsewhere: answered(D(elsewhere)) });
  // [interest paid, deducted elsewhere, MAGI, expected line 30]
  const cases: [number, number, number, string][] = [
    [12000, 0, 150000, "10000"], // cap
    [12000, 0, 200000, "10000"], // at the start: no reduction
    [12000, 0, 200001, "9800"], // plan criterion 5: 0.001 rounds UP to 1 -> 200
    [12000, 0, 201000, "9800"], // exactly 1
    [12000, 0, 201001, "9600"], // 1.001 -> 2
    [12000, 0, 250000, "0"], // 50 x 200 = 10,000
    [12000, 0, 250001, "0"], // 51 x 200 -> negative -> 0
    [3000, 1000, 100000, "2000"], // column (ii): deducted on Schedule C is excluded
    [3000, 3000, 100000, "0"],
    [3000, 5000, 100000, "0"], // more deducted elsewhere than paid never goes negative
    [3000, 0, 205000, "2000"], // 5 x 200 = 1,000
  ];
  for (const [paid, elsewhere, magi, expected] of cases) {
    it(`interest ${paid} (elsewhere ${elsewhere}) at MAGI ${magi} -> ${expected}`, () => {
      const r = s1a(magi, [none("Eric"), none("Eva")], car(paid, elsewhere));
      expect(amt(r, "sch1a.30")).toBe(expected);
    });
  }
  it("a vehicle/loan that fails a condition is a zero with a reason; unanswered / not sure never zero", () => {
    const fail = s1a(100000, [none("Eric"), none("Eva")], { choice: answered("some"), qualifies: answered(false), interestPaid: answered(D(5000)), deductedElsewhere: answered(D(0)) });
    expect(amt(fail, "sch1a.30")).toBe("0");
    expect(st(fail, "sch1a.30")).toBe("not_applicable");
    const missing = s1a(100000, [none("Eric"), none("Eva")], { choice: MISSING });
    expect(amt(missing, "sch1a.30")).toBeNull();
    expect(st(missing, "sch1a.30")).toBe("missing_input");
    const unsure = s1a(100000, [none("Eric"), none("Eva")], { choice: UNSURE });
    expect(st(unsure, "sch1a.30")).toBe("needs_cpa_judgment");
  });
});

describe("Schedule 1-A: enhanced deduction for seniors (Part V: 6,000 - 6% of MAGI over 150,000 per person born before 1/2/1961 with a valid SSN)", () => {
  const sr = (name: string, ssn = true) => s1aPerson(name, { bornBefore1961: answered(true), validSsn: answered(ssn) });
  const cases: [number, number, string][] = [
    [100000, 1, "6000"],
    [150000, 1, "6000"],
    [160000, 1, "5400"], // plan criterion 5
    [160000, 2, "10800"], // per person on the joint return: 5,400 x 2
    [249000, 1, "60"], // 99,000 x 6% = 5,940
    [250000, 1, "0"], // 100,000 x 6% = 6,000
    [400000, 2, "0"],
  ];
  for (const [magi, n, expected] of cases) {
    it(`${n} senior(s) at MAGI ${magi} -> ${expected}`, () => {
      const r = s1a(magi, n === 1 ? [sr("Eric"), none("Eva")] : [sr("Eric"), sr("Eva")]);
      expect(amt(r, "sch1a.37")).toBe(expected);
    });
  }
  it("a senior without a valid SSN gets nothing; a born-before question left unanswered blocks 37 and 38", () => {
    expect(amt(s1a(160000, [sr("Eric", false), none("Eva")]), "sch1a.37")).toBe("0");
    const miss = s1a(160000, [s1aPerson("Eric", { bornBefore1961: MISSING }), none("Eva")]);
    expect(amt(miss, "sch1a.37")).toBeNull();
    expect(amt(miss, "sch1a.38")).toBeNull();
  });
  it("total (line 38) adds lines 13, 21, 30, 37: tips 10,000 + overtime 5,000 + car 4,000 + senior 6,000 at MAGI 100,000 = 25,000", () => {
    const r = s1a(
      100000,
      [s1aPerson("Eric", { tips: answered("some"), tipsAmount: answered(D(10000)), overtime: answered("premium"), overtimeAmount: answered(D(5000)), bornBefore1961: answered(true) }), none("Eva")],
      { choice: answered("some"), qualifies: answered(true), interestPaid: answered(D(4000)), deductedElsewhere: answered(D(0)) }
    );
    expect(amt(r, "sch1a.38")).toBe("25000");
  });
  it("MAGI unknown (AGI not computed) blocks every deduction that needs it, never 0", () => {
    const r = s1a(null, [otPerson("Eric", 1000), none("Eva")]);
    expect(amt(r, "sch1a.21")).toBeNull();
    expect(amt(r, "sch1a.38")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Form 8889
// ─────────────────────────────────────────────────────────────────────────────
function hsaP(slot: "a" | "b", name: string, over: Partial<HsaPersonInput> = {}): HsaPersonInput {
  return {
    slot,
    name,
    coverage: answered("none"),
    monthsEligible: MISSING,
    eligibleDec1: MISSING,
    medicareOrDependent: MISSING,
    age55Plus: MISSING,
    directContributions: MISSING,
    employerOtherYear: MISSING,
    distributions: answered("none"),
    employerContributionsW2: D(0),
    ...over,
  };
}
const cov = (over: Partial<HsaPersonInput> = {}): Partial<HsaPersonInput> => ({
  coverage: answered("family"),
  monthsEligible: answered(12),
  eligibleDec1: answered(true),
  medicareOrDependent: answered(false),
  age55Plus: answered(false),
  directContributions: answered(D(0)),
  employerOtherYear: answered(false),
  ...over,
});

describe("Form 8889 (Form 8889 + instructions, verified by hand)", () => {
  it("self-only, full year, under 55: limit 4,300; direct 4,300 -> deduction 4,300; direct 4,301 -> excess goes to the CPA (never silently capped)", () => {
    const ok = computeHsa8889({ people: [hsaP("a", "Eric", cov({ coverage: answered("self_only"), directContributions: answered(D(4300)) })), hsaP("b", "Eva")] });
    expect(amt(ok, "f8889a.3")).toBe("4300");
    expect(amt(ok, "sch1.13")).toBe("4300");
    const over = computeHsa8889({ people: [hsaP("a", "Eric", cov({ coverage: answered("self_only"), directContributions: answered(D(4301)) })), hsaP("b", "Eva")] });
    expect(amt(over, "sch1.13")).toBeNull();
    expect(st(over, "sch1.13")).toBe("needs_cpa_judgment");
  });
  it("self-only, 55+: 4,300 + 1,000 = 5,300 on line 3 (not on line 7)", () => {
    const r = computeHsa8889({ people: [hsaP("a", "Eric", cov({ coverage: answered("self_only"), age55Plus: answered(true), directContributions: answered(D(5300)) })), hsaP("b", "Eva")] });
    expect(amt(r, "f8889a.3")).toBe("5300");
    expect(amt(r, "sch1.13")).toBe("5300");
  });
  it("family, 55+: line 3 = 8,550 and the 1,000 is on line 7 (instructions: married with family coverage) -> line 8 = 9,550", () => {
    const r = computeHsa8889({ people: [hsaP("a", "Eric", cov({ age55Plus: answered(true), directContributions: answered(D(9550)) })), hsaP("b", "Eva")] });
    expect(amt(r, "f8889a.3")).toBe("8550");
    expect(amt(r, "f8889a.8")).toBe("9550");
    expect(amt(r, "sch1.13")).toBe("9550");
  });
  it("employer contributions (W-2 box 12 code W) reduce the limit: 8,550 - 2,000 = 6,550; direct 3,000 -> 3,000; payroll money is NOT deducted again", () => {
    const r = computeHsa8889({ people: [hsaP("a", "Eric", cov({ directContributions: answered(D(3000)), employerContributionsW2: D(2000) })), hsaP("b", "Eva")] });
    expect(amt(r, "f8889a.12")).toBe("6550");
    expect(amt(r, "f8889a.13")).toBe("3000");
    expect(amt(r, "sch1.13")).toBe("3000");
    const onlyPayroll = computeHsa8889({ people: [hsaP("a", "Eric", cov({ directContributions: answered(D(0)), employerContributionsW2: D(2000) })), hsaP("b", "Eva")] });
    expect(amt(onlyPayroll, "sch1.13")).toBe("0");
  });
  it("6 months of self-only coverage, no Dec-1 coverage: 4,300 x 6/12 = 2,150", () => {
    const r = computeHsa8889({ people: [hsaP("a", "Eric", cov({ coverage: answered("self_only"), monthsEligible: answered(6), eligibleDec1: answered(false), directContributions: answered(D(2150)) })), hsaP("b", "Eva")] });
    expect(amt(r, "f8889a.3")).toBe("2150");
    expect(amt(r, "sch1.13")).toBe("2150");
  });
  it("last-month rule (instructions line 3 item 1): covered Dec 1 with only 3 months -> full-year 4,300 (self-only), with the testing-period warning", () => {
    const r = computeHsa8889({ people: [hsaP("a", "Eric", cov({ coverage: answered("self_only"), monthsEligible: answered(3), eligibleDec1: answered(true), directContributions: answered(D(4300)) })), hsaP("b", "Eva")] });
    expect(amt(r, "f8889a.3")).toBe("4300");
    expect(r.reasons.join(" ")).toContain("December 1");
  });
  it("family, 6 months, 55+: line 3 = 8,550 x 6/12 = 4,275; line 7 = 1,000 x 6/12 = 500 (Additional Contribution Amount Worksheet); line 8 = 4,775", () => {
    const r = computeHsa8889({ people: [hsaP("a", "Eric", cov({ monthsEligible: answered(6), eligibleDec1: answered(false), age55Plus: answered(true), directContributions: answered(D(4775)) })), hsaP("b", "Eva")] });
    expect(amt(r, "f8889a.3")).toBe("4275");
    expect(amt(r, "f8889a.8")).toBe("4775");
    expect(amt(r, "sch1.13")).toBe("4775");
  });
  it("both spouses with HSAs under family coverage all year: line 6 divides 8,550 equally (4,275 each); Eric 3,000 -> 3,000; Eva 4,275 -> 4,275; total 7,275", () => {
    const r = computeHsa8889({ people: [hsaP("a", "Eric", cov({ directContributions: answered(D(3000)) })), hsaP("b", "Eva", cov({ directContributions: answered(D(4275)) }))] });
    expect(amt(r, "f8889a.8")).toBe("4275");
    expect(amt(r, "f8889b.8")).toBe("4275");
    expect(amt(r, "sch1.13")).toBe("7275");
  });
  it("spouse's family plan makes BOTH spouses 'family' (instructions: use the family amount if you OR your spouse had family coverage)", () => {
    const r = computeHsa8889({ people: [hsaP("a", "Eric", cov({ coverage: answered("family") })), hsaP("b", "Eva", cov({ coverage: answered("self_only"), directContributions: answered(D(2000)) }))] });
    expect(amt(r, "f8889b.3")).toBe("8550");
    expect(amt(r, "sch1.13")).toBe("2000");
  });
  it("Medicare / dependent month, HDHP coverage that changed, an unanswered input, 'not sure' and HSA distributions are never guessed", () => {
    for (const over of [cov({ medicareOrDependent: answered(true) }), cov({ coverage: answered("changed") }), cov({ monthsEligible: MISSING }), cov({ age55Plus: UNSURE }), cov({ directContributions: MISSING }), cov({ distributions: answered("some") })]) {
      const r = computeHsa8889({ people: [hsaP("a", "Eric", over), hsaP("b", "Eva")] });
      expect(amt(r, "sch1.13")).toBeNull();
      expect(["missing_input", "needs_cpa_judgment"]).toContain(st(r, "sch1.13"));
    }
  });
  it("W-2 cross-check: no HDHP coverage but box 12 code W is a CPA item; an unreadable box 12 (null) is missing_input, never $0", () => {
    const conflict = computeHsa8889({ people: [hsaP("a", "Eric", { employerContributionsW2: D(500) }), hsaP("b", "Eva")] });
    expect(st(conflict, "sch1.13")).toBe("needs_cpa_judgment");
    const unknown = computeHsa8889({ people: [hsaP("a", "Eric", cov({ employerContributionsW2: null })), hsaP("b", "Eva")] });
    expect(st(unknown, "sch1.13")).toBe("missing_input");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IRA deduction (Pub. 590-A Worksheet 1-2)
// ─────────────────────────────────────────────────────────────────────────────
function iraP(slot: "a" | "b", name: string, over: Partial<IraPersonInput> = {}): IraPersonInput {
  return { slot, name, traditional: answered(D(0)), roth: answered(D(0)), age50Plus: answered(false), covered: answered(false), compensation: D(100000), ...over };
}
const ira = (people: IraPersonInput[], magi: number | null, noSs: boolean | null = true) => computeIraDeduction({ people, magi: magi === null ? null : D(magi), noSocialSecurityBenefits: noSs });

describe("IRA deduction (Pub. 590-A Worksheet 1-2; the 1040 instructions IRA Deduction Worksheet rounds the same way)", () => {
  it("Pub. 590-A Example 1: covered, MAGI 126,500 -> line 3 = 19,500 x 35% = 6,825.00 -> the WRITTEN rule (round up to a multiple of $10) gives 6,830 (the Pub prints 6,825: see report)", () => {
    const r = ira(
      [iraP("a", "Eric", { traditional: answered(D(7000)), covered: answered(true), compensation: D(66000) }), iraP("b", "Eva", { traditional: answered(D(7000)), covered: answered(false), compensation: D(51500) })],
      126500
    );
    expect(amt(r, "ira.a.7")).toBe("6830");
    expect(amt(r, "ira.b.7")).toBe("7000"); // spouse not covered, MAGI far below 236,000
    expect(amt(r, "sch1.20")).toBe("13830");
  });
  it("Pub. 590-A Example 2: not covered, spouse covered, MAGI 238,500 -> (246,000 - 238,500) x 70% = 5,250 (exact multiple of 10, the Pub prints 5,250); the covered spouse (MAGI over 146,000) gets 0", () => {
    const r = ira(
      [iraP("a", "Eric", { traditional: answered(D(7000)), covered: answered(true), compensation: D(45500) }), iraP("b", "Eva", { traditional: answered(D(7000)), covered: answered(false), compensation: D(0) })],
      238500
    );
    expect(amt(r, "ira.a.7")).toBe("0");
    expect(amt(r, "ira.b.7")).toBe("5250");
    expect(amt(r, "sch1.20")).toBe("5250");
  });
  // covered, MFJ, under 50: [MAGI, expected deduction on a 7,000 contribution]
  const coveredCases: [number, string][] = [
    [125999, "7000"],
    [126000, "7000"], // line 3 = 20,000: "20,000 or more" -> full
    [126001, "7000"], // 19,999 x .35 = 6,999.65 -> 7,000
    [126029, "6990"], // 19,971 x .35 = 6,989.85 -> 6,990
    [130000, "5600"], // 16,000 x .35 = 5,600
    [140000, "2100"], // 6,000 x .35
    [145999, "200"], // 1 x .35 -> 10 -> minimum 200
    [146000, "0"], // line 2 equal to line 1: stop, not deductible
    [200000, "0"],
  ];
  for (const [magi, expected] of coveredCases) {
    it(`covered, MFJ, MAGI ${magi}, contribution 7,000 -> ${expected}`, () => {
      const r = ira([iraP("a", "Eric", { traditional: answered(D(7000)), covered: answered(true) }), iraP("b", "Eva")], magi);
      expect(amt(r, "ira.a.7")).toBe(expected);
    });
  }
  it("age 50+: 40% and an 8,000 limit: MAGI 130,000 -> 16,000 x .40 = 6,400", () => {
    const r = ira([iraP("a", "Eric", { traditional: answered(D(8000)), age50Plus: answered(true), covered: answered(true) }), iraP("b", "Eva")], 130000);
    expect(amt(r, "ira.a.7")).toBe("6400");
  });
  // not covered, spouse covered: range 236,000-246,000
  const spouseCases: [number, string][] = [
    [235999, "7000"],
    [236000, "7000"], // 10,000 -> full
    [236001, "7000"], // 9,999 x .7 = 6,999.3 -> 7,000
    [240000, "4200"], // 6,000 x .7
    [245999, "200"], // 1 x .7 = .7 -> 10 -> 200
    [246000, "0"],
  ];
  for (const [magi, expected] of spouseCases) {
    it(`not covered but spouse covered, MAGI ${magi} -> ${expected}`, () => {
      const r = ira([iraP("a", "Eric", { traditional: answered(D(7000)), covered: answered(false) }), iraP("b", "Eva", { covered: answered(true) })], magi);
      expect(amt(r, "ira.a.7")).toBe(expected);
    });
  }
  it("neither covered: no phase-out at any MAGI; Kay Bailey Hutchison spousal limit: Eva earned 3,800 but may contribute 8,000 (both 53, Pub. 590-A example)", () => {
    const r = ira(
      [
        iraP("a", "Eric", { traditional: answered(D(8000)), age50Plus: answered(true), compensation: D(48000) }),
        iraP("b", "Eva", { traditional: answered(D(8000)), age50Plus: answered(true), compensation: D(3800) }),
      ],
      900000
    );
    expect(amt(r, "ira.a.7")).toBe("8000");
    expect(amt(r, "ira.b.7")).toBe("8000"); // 3,800 + (48,000 - 8,000) = 43,800 >= 8,000
  });
  it("compensation limits the deduction (no spousal help when the other spouse's compensation is also small)", () => {
    const r = ira([iraP("a", "Eric", { traditional: answered(D(7000)), compensation: D(2000) }), iraP("b", "Eva", { compensation: D(1000) })], 50000);
    expect(amt(r, "ira.a.7")).toBe("2000"); // Eric has MORE compensation than Eva, so only his own 2,000
  });
  it("traditional + Roth over the limit, Social Security benefits not ruled out, 'not sure', unknown compensation -> never a number", () => {
    const over = ira([iraP("a", "Eric", { traditional: answered(D(5000)), roth: answered(D(3000)) }), iraP("b", "Eva")], 100000);
    expect(st(over, "sch1.20")).toBe("needs_cpa_judgment");
    const ss = ira([iraP("a", "Eric", { traditional: answered(D(5000)), covered: answered(true) }), iraP("b", "Eva")], 100000, null);
    expect(amt(ss, "sch1.20")).toBeNull();
    const unsure = ira([iraP("a", "Eric", { traditional: answered(D(5000)), covered: UNSURE }), iraP("b", "Eva")], 100000);
    expect(st(unsure, "sch1.20")).toBe("needs_cpa_judgment");
    const nocomp = ira([iraP("a", "Eric", { traditional: answered(D(5000)), compensation: null }), iraP("b", "Eva")], 100000);
    expect(st(nocomp, "sch1.20")).toBe("missing_input");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Form 8880
// ─────────────────────────────────────────────────────────────────────────────
function saver(agi: number, ericIra: number, ericDef: number, evaIra: number, evaDef: number, tax = 50000, other = 0) {
  return computeSaversCredit({
    agi: D(agi),
    people: [
      { name: "Eric", iraContributions: answered(D(ericIra)), deferrals: answered(D(ericDef)) },
      { name: "Eva", iraContributions: answered(D(evaIra)), deferrals: answered(D(evaDef)) },
    ],
    distributionsSince2022: answered(false),
    studentOrDependent: answered(false),
    taxBeforeCredits: D(tax),
    otherCredits: D(other),
  });
}
describe("Form 8880 saver's credit (MFJ table, hand-derived: 0.5 to 47,500; 0.2 to 51,000; 0.1 to 79,000; 0.0 above)", () => {
  const cases: [number, string][] = [
    [23750, "2000"],
    [47500, "2000"], // 4,000 x 0.5
    [47501, "800"], // x 0.2
    [51000, "800"],
    [51001, "400"], // x 0.1
    [59250, "400"],
    [59251, "400"], // MFJ stays 0.1 to 79,000
    [79000, "400"],
    [79001, "0"], // over the 79,000 cut-off: "You cannot take this credit"
    [177967, "0"],
  ];
  for (const [agi, expected] of cases) {
    it(`AGI ${agi}: contributions 2,000 each -> credit ${expected}`, () => {
      const r = saver(agi, 2000, 0, 0, 2000);
      expect(amt(r, "sch3.4")).toBe(expected);
      if (agi > 79000) {
        expect(r.status).toBe("computed");
        expect(r.conclusion).toBe("ineligible");
        expect(r.reasons[0]).toContain("more than $79,000");
      }
    });
  }
  it("$2,000 per-person cap (line 6): Eric 1,500 IRA + 2,500 deferrals = 4,000 counts only 2,000; Eva 500 -> line 7 = 2,500 -> x 0.5 = 1,250", () => {
    const r = saver(40000, 1500, 2500, 500, 0);
    expect(amt(r, "f8880.7")).toBe("2500");
    expect(amt(r, "sch3.4")).toBe("1250");
  });
  it("credit limit worksheet: tax 500 minus other credits 100 = 400 < 2,000 -> credit 400 and a 'partial' conclusion", () => {
    const r = saver(40000, 2000, 0, 2000, 0, 500, 100);
    expect(amt(r, "f8880.10")).toBe("2000");
    expect(amt(r, "f8880.11")).toBe("400");
    expect(amt(r, "sch3.4")).toBe("400");
    expect(r.conclusion).toBe("partial");
  });
  it("a distribution after 2022, a student/dependent spouse, a missing contribution or unknown AGI is never a number", () => {
    const base = {
      agi: D(40000),
      people: [
        { name: "Eric", iraContributions: answered(D(2000)), deferrals: answered(D(0)) },
        { name: "Eva", iraContributions: answered(D(0)), deferrals: answered(D(0)) },
      ],
      distributionsSince2022: answered(false),
      studentOrDependent: answered(false),
      taxBeforeCredits: D(50000),
      otherCredits: D(0),
    };
    expect(st(computeSaversCredit({ ...base, distributionsSince2022: answered(true) }), "sch3.4")).toBe("needs_cpa_judgment");
    expect(st(computeSaversCredit({ ...base, studentOrDependent: answered(true) }), "sch3.4")).toBe("needs_cpa_judgment");
    expect(st(computeSaversCredit({ ...base, studentOrDependent: MISSING }), "sch3.4")).toBe("missing_input");
    expect(st(computeSaversCredit({ ...base, agi: null }), "sch3.4")).toBe("missing_input");
    expect(amt(computeSaversCredit({ ...base, agi: null }), "sch3.4")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Foreign tax credit
// ─────────────────────────────────────────────────────────────────────────────
describe("foreign tax credit (direct credit, no Form 1116: total foreign tax <= 600 MFJ)", () => {
  it("0 -> not_applicable; 600 -> credit 600; 600.01 -> CPA (Form 1116); unknown -> missing_input", () => {
    expect(st(computeForeignTaxCredit({ foreignTaxPaid: D(0) }), "sch3.1")).toBe("not_applicable");
    const ok = computeForeignTaxCredit({ foreignTaxPaid: D(600) });
    expect(amt(ok, "sch3.1")).toBe("600");
    const over = computeForeignTaxCredit({ foreignTaxPaid: D("600.01") });
    expect(amt(over, "sch3.1")).toBeNull();
    expect(st(over, "sch3.1")).toBe("needs_cpa_judgment");
    expect(st(computeForeignTaxCredit({ foreignTaxPaid: null }), "sch3.1")).toBe("missing_input");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Standard deduction (age / blind boxes)
// ─────────────────────────────────────────────────────────────────────────────
describe("standard deduction with the line 12d boxes (2025 Form 1040 instructions chart: MFJ 31,500 / 33,100 / 34,700 / 36,300 / 37,900)", () => {
  const expected = [31500, 33100, 34700, 36300, 37900];
  it("all 16 combinations of the four boxes give 31,500 + 1,600 x boxes", () => {
    for (let mask = 0; mask < 16; mask++) {
      const b = [0, 1, 2, 3].map((i) => (mask >> i) & 1);
      const boxes = b.reduce((x, y) => x + y, 0);
      const r = computeStandardDeduction({
        people: [
          { name: "Eric", bornBefore1961: answered(b[0] === 1), blind: answered(b[1] === 1) },
          { name: "Eva", bornBefore1961: answered(b[2] === 1), blind: answered(b[3] === 1) },
        ],
      });
      expect(amt(r, "std.total"), `mask ${mask}`).toBe(String(expected[boxes]));
    }
  });
  it("any single blank / not sure box blocks line 12e (never silently 31,500)", () => {
    for (let which = 0; which < 4; which++) {
      for (const bad of [MISSING, UNSURE]) {
        const f = [answered(false), answered(false), answered(false), answered(false)] as const;
        const arr = [...f] as unknown as [ReturnType<typeof answered<boolean>>, ReturnType<typeof answered<boolean>>, ReturnType<typeof answered<boolean>>, ReturnType<typeof answered<boolean>>];
        (arr as unknown[])[which] = bad;
        const r = computeStandardDeduction({
          people: [
            { name: "Eric", bornBefore1961: arr[0], blind: arr[1] },
            { name: "Eva", bornBefore1961: arr[2], blind: arr[3] },
          ],
        });
        expect(amt(r, "std.total")).toBeNull();
        expect(st(r, "std.total")).toBe(bad.state === "missing" ? "missing_input" : "needs_cpa_judgment");
      }
    }
  });
  it("fewer than two people answered blocks (no silent 'neither spouse' reading)", () => {
    const r = computeStandardDeduction({ people: [{ name: "Eric", bornBefore1961: answered(false), blind: answered(false) }] });
    expect(amt(r, "std.total")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CT use tax
// ─────────────────────────────────────────────────────────────────────────────
describe("CT use tax (CT-1040 Schedule 4 worksheet Section B: price x 6.35% minus tax paid elsewhere)", () => {
  it("1,000 x 6.35% = 63.50 (matches the CT 'Sample Use Tax Table'); minus 20 paid elsewhere = 43.50; never negative", () => {
    const r = computeCtUseTax({ choice: answered("some"), generalRatePurchases: answered(D(1000)), otherRateItems: answered(false), taxPaidToOtherState: answered(D(0)) });
    expect(r.ok && r.amount.toString()).toBe("63.5");
    const r2 = computeCtUseTax({ choice: answered("some"), generalRatePurchases: answered(D(1000)), otherRateItems: answered(false), taxPaidToOtherState: answered(D(20)) });
    expect(r2.ok && r2.amount.toString()).toBe("43.5");
    const r3 = computeCtUseTax({ choice: answered("some"), generalRatePurchases: answered(D(1000)), otherRateItems: answered(false), taxPaidToOtherState: answered(D(500)) });
    expect(r3.ok && r3.amount.toString()).toBe("0");
  });
  it("'none' is an explicit 0 (line 15 must be '0' or an amount); special-rate items, unanswered and not-sure are never a number", () => {
    const none = computeCtUseTax({ choice: answered("none"), generalRatePurchases: MISSING, otherRateItems: MISSING, taxPaidToOtherState: MISSING });
    expect(none.ok && none.amount.toString()).toBe("0");
    expect(computeCtUseTax({ choice: answered("some"), generalRatePurchases: answered(D(100)), otherRateItems: answered(true), taxPaidToOtherState: answered(D(0)) }).ok).toBe(false);
    expect(computeCtUseTax({ choice: MISSING, generalRatePurchases: MISSING, otherRateItems: MISSING, taxPaidToOtherState: MISSING }).ok).toBe(false);
    expect(computeCtUseTax({ choice: UNSURE, generalRatePurchases: MISSING, otherRateItems: MISSING, taxPaidToOtherState: MISSING }).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Form 2210 (regular-method estimate): oracle = independent Python Fraction implementation of Part III lines 10-18 + worksheet
// ─────────────────────────────────────────────────────────────────────────────
interface Scn {
  name: string;
  l1: number;
  l2: number;
  l3: number;
  l6: number;
  pt: number;
  pa: number;
  est: [string, number][];
  ov: number;
  penalty: number; // exact, from the oracle
}
const SCN: Scn[] = [
  { name: "withholding only, quarter each", l1: 30000, l2: 10000, l3: 0, l6: 16000, pt: 30000, pa: 100000, est: [], ov: 0, penalty: 651.7671232876712 },
  { name: "prior AGI 150,001 -> 110%", l1: 30000, l2: 10000, l3: 0, l6: 16000, pt: 30000, pa: 150001, est: [], ov: 0, penalty: 791.431506849315 },
  { name: "prior AGI exactly 150,000 -> 100%", l1: 30000, l2: 10000, l3: 0, l6: 16000, pt: 30000, pa: 150000, est: [], ov: 0, penalty: 651.7671232876712 },
  { name: "5,000 estimate on each due date -> none", l1: 30000, l2: 10000, l3: 0, l6: 16000, pt: 30000, pa: 100000, est: [["2025-04-15", 5000], ["2025-06-15", 5000], ["2025-09-15", 5000], ["2026-01-15", 5000]], ov: 0, penalty: 0 },
  { name: "9,000 catch-up on 2025-12-31", l1: 30000, l2: 10000, l3: 0, l6: 16000, pt: 30000, pa: 100000, est: [["2025-12-31", 9000]], ov: 0, penalty: 470.5342465753425 },
  { name: "6,000 overpayment applied + 2,000 in window b", l1: 30000, l2: 10000, l3: 0, l6: 16000, pt: 30000, pa: 100000, est: [["2025-05-20", 2000]], ov: 6000, penalty: 162.05479452054794 },
  { name: "refundable credit lowers line 4", l1: 20000, l2: 5000, l3: 3000, l6: 10000, pt: 40000, pa: 300000, est: [["2025-06-10", 1000], ["2025-12-20", 3000]], ov: 0, penalty: 330.2369863013699 },
  { name: "payment after 1/15/2026 is not a Form 2210 payment", l1: 30000, l2: 10000, l3: 0, l6: 16000, pt: 30000, pa: 100000, est: [["2026-02-10", 9000]], ov: 0, penalty: 651.7671232876712 },
  { name: "uneven payments in every window", l1: 50000, l2: 20000, l3: 0, l6: 25000, pt: 52000, pa: 200000, est: [["2025-03-01", 3000], ["2025-06-14", 7000], ["2025-08-30", 2500], ["2025-11-01", 12000], ["2026-01-10", 4000]], ov: 1500, penalty: 243.8013698630137 },
  { name: "golden-like (tax 27,015, withholding 15,000, prior 20,000 / 120,000)", l1: 27015, l2: 0, l3: 0, l6: 15000, pt: 20000, pa: 120000, est: [], ov: 0, penalty: 232.77397260273972 },
  { name: "line 7 under 1,000 -> no penalty", l1: 30000, l2: 10000, l3: 0, l6: 39500, pt: 30000, pa: 100000, est: [], ov: 0, penalty: 0 },
  { name: "withholding >= required annual payment -> no penalty", l1: 30000, l2: 10000, l3: 0, l6: 30000, pt: 30000, pa: 100000, est: [], ov: 0, penalty: 0 },
];
describe("Form 2210 regular-method estimate vs the independent oracle", () => {
  for (const s of SCN) {
    it(s.name, () => {
      const r = computePenalty2210({
        line1: D(s.l1),
        line2: D(s.l2),
        line3: D(s.l3),
        line6: D(s.l6),
        prior: { totalTax: D(s.pt), agi: D(s.pa), filingStatus: "mfj", filedJoint: answered(true), hadExcludedTaxOrRefundable: answered(false) },
        estimates: s.est.map(([paidOn, a]) => ({ paidOn, amount: D(a) })),
        priorYearOverpaymentApplied: D(s.ov),
      });
      expect(r.status).toBe("computed");
      const line = r.lines.find((l) => l.key === "f2210.19");
      expect(line?.exact?.toNumber() ?? 0).toBeCloseTo(s.penalty, 6);
      expect(line?.amount?.toNumber()).toBe(Math.round(s.penalty));
      expect(r.informational).toBe(true);
    });
  }
  it("line 4 uses 1 + 2 - 3 and 90% for line 5; the prior-year AGI > 150,000 rule is strict ('more than')", () => {
    const r = computePenalty2210({
      line1: D(30000), line2: D(10000), line3: D(0), line6: D(16000),
      prior: { totalTax: D(30000), agi: D(150000), filingStatus: "mfj", filedJoint: answered(true), hadExcludedTaxOrRefundable: answered(false) },
      estimates: [], priorYearOverpaymentApplied: D(0),
    });
    expect(amt(r, "f2210.5")).toBe("36000");
    expect(amt(r, "f2210.8")).toBe("30000");
    expect(amt(r, "f2210.9")).toBe("30000");
  });
  it("missing / unsure prior-year facts never produce a number (informational, not blocking, but never 0)", () => {
    const base = { line1: D(30000), line2: D(10000), line3: D(0), line6: D(16000), estimates: [], priorYearOverpaymentApplied: D(0) };
    const miss = computePenalty2210({ ...base, prior: { totalTax: null, agi: null, filingStatus: null, filedJoint: MISSING, hadExcludedTaxOrRefundable: MISSING } });
    expect(amt(miss, "f2210.19")).toBeNull();
    const uns = computePenalty2210({ ...base, prior: { totalTax: D(30000), agi: D(100000), filingStatus: "mfj", filedJoint: answered(true), hadExcludedTaxOrRefundable: UNSURE } });
    expect(amt(uns, "f2210.19")).toBeNull();
    expect(uns.status).toBe("needs_cpa_judgment");
    const nonJoint = computePenalty2210({ ...base, prior: { totalTax: D(30000), agi: D(100000), filingStatus: "single", filedJoint: MISSING, hadExcludedTaxOrRefundable: answered(false) } });
    expect(amt(nonJoint, "f2210.19")).toBeNull();
    const noEst = computePenalty2210({ ...base, estimates: null, prior: { totalTax: D(30000), agi: D(100000), filingStatus: "mfj", filedJoint: answered(true), hadExcludedTaxOrRefundable: answered(false) } });
    expect(amt(noEst, "f2210.19")).toBeNull();
  });
});
