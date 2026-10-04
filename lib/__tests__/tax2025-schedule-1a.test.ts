import { describe, expect, it } from "vitest";
import { answered, MISSING, UNSURE } from "@/lib/tax2025/answer-state";
import { D } from "@/lib/tax2025/money";
import { computeSchedule1a, type Sch1aInput, type Sch1aPersonInput } from "@/lib/tax2025/rules/schedule-1a";
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

function person(name: string, over: Partial<Sch1aPersonInput> = {}): Sch1aPersonInput {
  return {
    name,
    bornBefore1961: answered(false),
    validSsn: answered(true),
    tips: answered("none"),
    tipsAmount: MISSING,
    overtime: answered("none"),
    overtimeAmount: MISSING,
    ...over,
  };
}

function input(over: Partial<Sch1aInput> = {}): Sch1aInput {
  return {
    magi: D(100000),
    magiExclusionsNone: answered(true),
    people: [person("Eric"), person("Eva")],
    carLoan: { choice: answered("none"), qualifies: MISSING, interestPaid: MISSING, deductedElsewhere: MISSING },
    tipsEmployers: null,
    scheduleCOwnerTips: answered("none"),
    ...over,
  };
}

// Every expected value below is worked by hand from the 2025 Schedule 1-A (f1040s1a.pdf) lines 3-38:
//   tips: line 7 = min(line 6, 25,000); line 11 = floor((MAGI - 300,000) / 1,000); line 12 = 100 x line 11; line 13 = 7 - 12
//   overtime: line 15 = min(14c, 25,000 MFJ); same reduction;  car loan: line 24 = min(23, 10,000);
//   line 28 = ceil((MAGI - 200,000) / 1,000); line 29 = 200 x line 28;  seniors: line 35 = 6,000 - 6% x (MAGI - 150,000).
describe("computeSchedule1a: all four parts answered none", () => {
  it("is a not_applicable zero total with a reason, never a silent 0", () => {
    const r = computeSchedule1a(input());
    expect(r.status).toBe("computed"); // the MAGI line is computed; the deduction lines are not_applicable zeros
    expect(amt(r, "sch1a.38")).toBe("0");
    expect(st(r, "sch1a.38")).toBe("not_applicable");
    expect(r.lines.every((l) => l.reason !== undefined)).toBe(true);
    expect(r.citations).toContain("SCH1A_TIPS_MAX");
  });

  it("needs no MAGI at all when nothing is claimed", () => {
    const r = computeSchedule1a(input({ magi: null }));
    expect(r.status).toBe("not_applicable");
    expect(amt(r, "sch1a.38")).toBe("0");
  });
});

describe("computeSchedule1a: overtime", () => {
  it("acceptance 5: overtime 20,000 at MAGI 310,000 MFJ -> 20,000 - 100 x 10 = 19,000", () => {
    const r = computeSchedule1a(
      input({ magi: D(310000), people: [person("Eric"), person("Eva", { overtime: answered("premium"), overtimeAmount: answered(D(20000)) })] })
    );
    expect(r.status).toBe("computed");
    expect(amt(r, "sch1a.14a")).toBe("20000");
    expect(amt(r, "sch1a.15")).toBe("20000");
    expect(amt(r, "sch1a.21")).toBe("19000");
    expect(amt(r, "sch1a.38")).toBe("19000");
  });

  it("the maximum is COMBINED for the couple: 18,000 + 12,000 = 30,000 -> 25,000", () => {
    const r = computeSchedule1a(
      input({
        magi: D(100000),
        people: [person("Eric", { overtime: answered("premium"), overtimeAmount: answered(D(18000)) }), person("Eva", { overtime: answered("premium"), overtimeAmount: answered(D(12000)) })],
      })
    );
    expect(amt(r, "sch1a.14a")).toBe("30000");
    expect(amt(r, "sch1a.15")).toBe("25000");
    expect(amt(r, "sch1a.21")).toBe("25000");
  });

  it("'total pay for the overtime hours' is divided by three (instructions Example 1: 15,000 -> 5,000)", () => {
    const r = computeSchedule1a(input({ people: [person("Eric"), person("Eva", { overtime: answered("total"), overtimeAmount: answered(D(15000)) })] }));
    expect(amt(r, "sch1a.14a")).toBe("5000");
    expect(amt(r, "sch1a.21")).toBe("5000");
  });

  it("MAGI exactly 300,000 or 300,999 gives no reduction (rounded DOWN), 301,000 reduces by 100", () => {
    const o = (magi: number) => computeSchedule1a(input({ magi: D(magi), people: [person("Eric"), person("Eva", { overtime: answered("premium"), overtimeAmount: answered(D(5000)) })] }));
    expect(amt(o(300000), "sch1a.21")).toBe("5000");
    expect(amt(o(300999), "sch1a.21")).toBe("5000");
    expect(amt(o(301000), "sch1a.21")).toBe("4900");
  });

  it("the reduction can take the deduction to zero (never negative)", () => {
    const r = computeSchedule1a(input({ magi: D(400000), people: [person("Eric"), person("Eva", { overtime: answered("premium"), overtimeAmount: answered(D(5000)) })] }));
    expect(amt(r, "sch1a.21")).toBe("0");
  });

  it("no valid SSN: the amount does not qualify (zero, with the reason)", () => {
    const r = computeSchedule1a(input({ people: [person("Eric"), person("Eva", { overtime: answered("premium"), overtimeAmount: answered(D(5000)), validSsn: answered(false) })] }));
    expect(amt(r, "sch1a.14a")).toBe("0");
    expect(r.lines.find((l) => l.key === "sch1a.14a")?.reason).toContain("Social Security number");
  });

  it("'ask the employer' is missing_input, 'not sure' is needs_cpa_judgment, never 0", () => {
    const ask = computeSchedule1a(input({ people: [person("Eric"), person("Eva", { overtime: answered("ask_employer") })] }));
    expect(ask.status).toBe("missing_input");
    expect(st(ask, "sch1a.21")).toBe("missing_input");
    expect(st(ask, "sch1a.38")).toBe("missing_input");
    expect(ask.inputsMissing.join(" ")).toContain("employer");
    const unsure = computeSchedule1a(input({ people: [person("Eric"), person("Eva", { overtime: UNSURE })] }));
    expect(st(unsure, "sch1a.21")).toBe("needs_cpa_judgment");
    expect(amt(unsure, "sch1a.38")).toBeNull();
  });
});

describe("computeSchedule1a: tips", () => {
  it("tips 30,000 are capped at 25,000; MAGI 301,000 reduces by 100", () => {
    const base = { people: [person("Eric", { tips: answered("some"), tipsAmount: answered(D(30000)) }), person("Eva")] };
    const r = computeSchedule1a(input({ ...base, magi: D(300000) }));
    expect(amt(r, "sch1a.4c")).toBe("30000");
    expect(amt(r, "sch1a.7")).toBe("25000");
    expect(amt(r, "sch1a.13")).toBe("25000");
    expect(amt(computeSchedule1a(input({ ...base, magi: D(301000) })), "sch1a.13")).toBe("24900");
  });

  it("the 25,000 maximum is combined, not per spouse (20,000 + 10,000)", () => {
    const r = computeSchedule1a(
      input({ people: [person("Eric", { tips: answered("some"), tipsAmount: answered(D(20000)) }), person("Eva", { tips: answered("some"), tipsAmount: answered(D(10000)) })] })
    );
    expect(amt(r, "sch1a.7")).toBe("25000");
    expect(amt(r, "sch1a.13")).toBe("25000");
  });

  it("a positive base with MAGI not computed yet is missing_input (never 0)", () => {
    const r = computeSchedule1a(input({ magi: null, people: [person("Eric", { tips: answered("some"), tipsAmount: answered(D(1000)) }), person("Eva")] }));
    expect(st(r, "sch1a.13")).toBe("missing_input");
    expect(st(r, "sch1a.38")).toBe("missing_input");
  });

  it("excluded income (Puerto Rico / Form 2555) makes the MAGI a CPA matter; unanswered is missing_input", () => {
    const some = [person("Eric", { tips: answered("some"), tipsAmount: answered(D(1000)) }), person("Eva")];
    expect(st(computeSchedule1a(input({ people: some, magiExclusionsNone: answered(false) })), "sch1a.13")).toBe("needs_cpa_judgment");
    expect(st(computeSchedule1a(input({ people: some, magiExclusionsNone: MISSING })), "sch1a.13")).toBe("missing_input");
    expect(st(computeSchedule1a(input({ people: some, magiExclusionsNone: UNSURE })), "sch1a.13")).toBe("needs_cpa_judgment");
  });
});

describe("computeSchedule1a: car-loan interest", () => {
  const car = (interest: number, elsewhere = 0) => ({
    choice: answered("some" as const),
    qualifies: answered(true),
    interestPaid: answered(D(interest)),
    deductedElsewhere: answered(D(elsewhere)),
  });

  it("acceptance 5: MAGI 200,001 -> the reduction rounds UP to one step: 10,000 - 200 = 9,800", () => {
    const r = computeSchedule1a(input({ magi: D(200001), carLoan: car(12000) }));
    expect(amt(r, "sch1a.23")).toBe("12000");
    expect(amt(r, "sch1a.24")).toBe("10000");
    expect(amt(r, "sch1a.30")).toBe("9800");
  });

  it("MAGI exactly 200,000: no reduction; 205,000 = 5 steps = 1,000", () => {
    expect(amt(computeSchedule1a(input({ magi: D(200000), carLoan: car(12000) })), "sch1a.30")).toBe("10000");
    expect(amt(computeSchedule1a(input({ magi: D(205000), carLoan: car(12000) })), "sch1a.30")).toBe("9000");
  });

  it("interest deducted on Schedule C is excluded (column ii): 6,000 - 1,000 = 5,000", () => {
    const r = computeSchedule1a(input({ magi: D(100000), carLoan: car(6000, 1000) }));
    expect(amt(r, "sch1a.23")).toBe("5000");
    expect(amt(r, "sch1a.30")).toBe("5000");
  });

  it("a vehicle or loan that fails the conditions is a not_applicable zero; 'not sure' is a CPA matter", () => {
    const no = computeSchedule1a(input({ carLoan: { ...car(5000), qualifies: answered(false) } }));
    expect(amt(no, "sch1a.30")).toBe("0");
    expect(st(no, "sch1a.30")).toBe("not_applicable");
    const unsure = computeSchedule1a(input({ carLoan: { ...car(5000), qualifies: UNSURE } }));
    expect(st(unsure, "sch1a.30")).toBe("needs_cpa_judgment");
  });
});

describe("computeSchedule1a: enhanced deduction for seniors", () => {
  const senior = (name: string, over: Partial<Sch1aPersonInput> = {}) => person(name, { bornBefore1961: answered(true), ...over });

  it("acceptance 5: one senior at MAGI 160,000 -> 6,000 - 6% x 10,000 = 5,400", () => {
    const r = computeSchedule1a(input({ magi: D(160000), people: [senior("Eric"), person("Eva")] }));
    expect(amt(r, "sch1a.36a")).toBe("5400");
    expect(amt(r, "sch1a.36b")).toBe("0");
    expect(amt(r, "sch1a.37")).toBe("5400");
    expect(amt(r, "sch1a.38")).toBe("5400");
  });

  it("two seniors at MAGI 150,000 get 12,000; at 250,000 the deduction is gone (6% x 100,000 = 6,000)", () => {
    expect(amt(computeSchedule1a(input({ magi: D(150000), people: [senior("Eric"), senior("Eva")] })), "sch1a.37")).toBe("12000");
    expect(amt(computeSchedule1a(input({ magi: D(250000), people: [senior("Eric"), senior("Eva")] })), "sch1a.37")).toBe("0");
  });

  it("a senior without a valid SSN gets nothing; unanswered ages block the total", () => {
    const r = computeSchedule1a(input({ magi: D(100000), people: [senior("Eric", { validSsn: answered(false) }), person("Eva")] }));
    expect(amt(r, "sch1a.36a")).toBe("0");
    const miss = computeSchedule1a(input({ people: [person("Eric", { bornBefore1961: MISSING }), person("Eva")] }));
    expect(st(miss, "sch1a.38")).toBe("missing_input");
  });

  it("all four parts add: tips 10,000 + overtime 5,000 + car 4,000 + senior 6,000 = 25,000 at MAGI 100,000", () => {
    const r = computeSchedule1a(
      input({
        magi: D(100000),
        people: [
          senior("Eric", { tips: answered("some"), tipsAmount: answered(D(10000)) }),
          person("Eva", { overtime: answered("premium"), overtimeAmount: answered(D(5000)) }),
        ],
        carLoan: { choice: answered("some"), qualifies: answered(true), interestPaid: answered(D(4000)), deductedElsewhere: answered(D(0)) },
      })
    );
    expect(amt(r, "sch1a.38")).toBe("25000");
    expect(r.status).toBe("computed");
  });
});
