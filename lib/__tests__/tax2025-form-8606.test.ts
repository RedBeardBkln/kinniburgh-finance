// Form 8606 (Nondeductible IRAs), Part I: the nondeductible amount from the IRA deduction rule (ira.<slot>.nd) and the form's own lines
// 1, 2, 3 and 14 (rules/form-8606.ts). Every number is worked by hand from the 2025 Form 8606 instructions ("Line 1": the smaller of the IRA
// Deduction Worksheet's line 10 (compensation) or line 11 (the contribution), minus its line 12 (the deduction)) and the 1040 IRA Deduction
// Worksheet (specs/09, "Form 8606"). Pure: no DB.

import { describe, expect, it } from "vitest";
import { answered, MISSING, UNSURE } from "@/lib/tax2025/answer-state";
import { D } from "@/lib/tax2025/money";
import { computeForm8606, type Form8606PersonInput } from "@/lib/tax2025/rules/form-8606";
import { computeIraDeduction, type IraPersonInput } from "@/lib/tax2025/rules/ira-deduction";
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

function person(slot: "a" | "b", name: string, over: Partial<IraPersonInput> = {}): IraPersonInput {
  return { slot, name, traditional: answered(D(0)), roth: answered(D(0)), age50Plus: answered(false), covered: answered(false), compensation: D(100000), ...over };
}
function ira(people: IraPersonInput[], magi: number | null, noSs: boolean | null = true): RuleResult {
  return computeIraDeduction({ people, magi: magi === null ? null : D(magi), noSocialSecurityBenefits: noSs });
}

/** The 8606 rule fed from the IRA rule's ira.<slot>.nd lines, the way return.ts does it. */
function form(r: RuleResult, basis: boolean | null = true, dist: boolean | null = true, names: [string, string] = ["Eric", "Eva"]): RuleResult {
  const lead = (slot: "a" | "b"): Form8606PersonInput => {
    const key = `ira.${slot}.nd` as LineKey;
    const l = r.lines.find((x) => x.key === key);
    if (!l) throw new Error(`no line ${key}`);
    return { slot, name: names[slot === "a" ? 0 : 1], nondeductible: { amount: l.amount, status: l.status ?? r.status, reason: l.reason ?? null } };
  };
  return computeForm8606({ people: [lead("a"), lead("b")], noEarlierBasisOrOtherIraEvent: basis, noIraDistributions: dist });
}

/** Eric (a): not covered by a plan at work; Eva (b): covered. MFJ, both under 50. */
const ERIC = (over: Partial<IraPersonInput> = {}) => person("a", "Eric", { traditional: answered(D(7000)), covered: answered(false), ...over });
const EVA = (over: Partial<IraPersonInput> = {}) => person("b", "Eva", { covered: answered(true), ...over });

describe("ira.<slot>.nd: the contribution that is not deducted (Form 8606 line 1)", () => {
  it("Eric's real shape: 7,000 traditional, he is not covered, Eva is, MAGI 270,980 (over 246,000): deduction 0, 7,000 nondeductible", () => {
    const r = ira([ERIC(), EVA()], 270980);
    expect(amt(r, "ira.a.7")).toBe("0");
    expect(amt(r, "sch1.20")).toBe("0");
    expect(amt(r, "ira.a.nd")).toBe("7000");
    expect(st(r, "ira.a.nd")).toBe("computed");
    expect(r.reasons.join(" ")).toContain("Form 8606 line 1");
    // Eva made no traditional contribution: no Form 8606 for her
    expect(st(r, "ira.b.nd")).toBe("not_applicable");
    expect(amt(r, "ira.b.nd")).toBe("0");
  });

  it("fully deductible (neither spouse covered): nothing is nondeductible, not_applicable 0 (no Form 8606)", () => {
    const r = ira([ERIC(), EVA({ covered: answered(false) })], 270980);
    expect(amt(r, "ira.a.7")).toBe("7000");
    expect(amt(r, "ira.a.nd")).toBe("0");
    expect(st(r, "ira.a.nd")).toBe("not_applicable");
  });

  it("spouse covered only, MAGI 236,000 or less: the full 7,000 is deducted, so no Form 8606", () => {
    const r = ira([ERIC(), EVA()], 236000);
    expect(amt(r, "ira.a.7")).toBe("7000");
    expect(st(r, "ira.a.nd")).toBe("not_applicable");
  });

  it("partial deduction, spouse covered only, MAGI 240,000: gap 246,000 - 240,000 = 6,000 x 70% = 4,200 (already a multiple of 10); 7,000 - 4,200 = 2,800", () => {
    const r = ira([ERIC(), EVA()], 240000);
    expect(amt(r, "ira.a.7")).toBe("4200");
    expect(amt(r, "ira.a.nd")).toBe("2800");
    expect(st(r, "ira.a.nd")).toBe("computed");
  });

  it("round-up case, MAGI 244,321: gap 1,679 x 70% = 1,175.30, rounded UP to a multiple of 10 = 1,180; 7,000 - 1,180 = 5,820", () => {
    const r = ira([ERIC(), EVA()], 244321);
    expect(amt(r, "ira.a.7")).toBe("1180");
    expect(amt(r, "ira.a.nd")).toBe("5820");
  });

  it("the $200 minimum, MAGI 245,900: gap 100 x 70% = 70, below 200 so the reduced limit is 200; 7,000 - 200 = 6,800", () => {
    const r = ira([ERIC(), EVA()], 245900);
    expect(amt(r, "ira.a.7")).toBe("200");
    expect(amt(r, "ira.a.nd")).toBe("6800");
  });

  it("MAGI exactly 246,000: no deduction, everything is nondeductible", () => {
    const r = ira([ERIC(), EVA()], 246000);
    expect(amt(r, "ira.a.7")).toBe("0");
    expect(amt(r, "ira.a.nd")).toBe("7000");
  });

  it("the person IS covered at work (MAGI 130,000, under 50): gap 146,000 - 130,000 = 16,000 (under 20,000) x 35% = 5,600; 7,000 - 5,600 = 1,400", () => {
    const r = ira([ERIC({ covered: answered(true) }), EVA({ covered: answered(false) })], 130000);
    expect(amt(r, "ira.a.7")).toBe("5600");
    expect(amt(r, "ira.a.nd")).toBe("1400");
  });

  it("age 50 or older (limit 8,000, 8,000 traditional, covered, MAGI 140,000): gap 6,000 x 40% = 2,400; 8,000 - 2,400 = 5,600", () => {
    const r = ira([ERIC({ traditional: answered(D(8000)), covered: answered(true), age50Plus: answered(true) }), EVA({ covered: answered(false) })], 140000);
    expect(amt(r, "ira.a.7")).toBe("2400");
    expect(amt(r, "ira.a.nd")).toBe("5600");
  });

  it("a contribution above the compensation that counts is an excess contribution (Form 5329): the deduction logic is unchanged, the nondeductible amount is blocked, never guessed", () => {
    // both spouses have little compensation, so nothing is added from the spouse: line 5 = 3,000 < the 7,000 contribution
    const r = ira([ERIC({ compensation: D(3000) }), EVA({ covered: answered(false), compensation: D(0) })], 900000);
    expect(amt(r, "ira.a.7")).toBe("3000"); // unchanged deduction logic
    expect(st(r, "ira.a.nd")).toBe("needs_cpa_judgment");
    expect(amt(r, "ira.a.nd")).toBeNull();
    expect(r.reasons.join(" ")).toContain("excess contribution (Form 5329)");
    expect(r.inputsMissing.join(" ")).toContain("excess contribution");
  });

  it("a contribution over the yearly limit blocks both the deduction and the nondeductible amount (the existing stop carries over)", () => {
    const r = ira([ERIC({ traditional: answered(D(7500)) }), EVA()], 270980);
    expect(st(r, "ira.a.7")).toBe("needs_cpa_judgment");
    expect(st(r, "ira.a.nd")).toBe("needs_cpa_judgment");
    expect(amt(r, "ira.a.nd")).toBeNull();
  });

  it("an unanswered or unsure input stops the nondeductible amount with the SAME status", () => {
    expect(st(ira([ERIC({ traditional: MISSING }), EVA()], 270980), "ira.a.nd")).toBe("missing_input");
    expect(st(ira([ERIC({ traditional: UNSURE }), EVA()], 270980), "ira.a.nd")).toBe("needs_cpa_judgment");
    expect(st(ira([ERIC(), EVA()], null), "ira.a.nd")).toBe("missing_input"); // MAGI not figured yet
    expect(st(ira([ERIC(), EVA()], 270980, null), "ira.a.nd")).toBe("missing_input"); // the no-retirement-income statement
    expect(st(ira([ERIC({ compensation: null }), EVA()], 270980), "ira.a.nd")).toBe("missing_input");
  });

  it("no second person: both ira.b lines are not_applicable zeros", () => {
    const r = ira([ERIC({ covered: answered(false) })], 270980);
    expect(st(r, "ira.b.nd")).toBe("not_applicable");
  });
});

describe("computeForm8606: lines 1, 2, 3 and 14 for Eric", () => {
  it("the Eric case with both statements none: lines 1 / 2 / 3 / 14 = 7,000 / 0 / 7,000 / 7,000, computed; Eva's four lines are not_applicable", () => {
    const f = form(ira([ERIC(), EVA()], 270980), true, true);
    expect(["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14"].map((k) => amt(f, k as LineKey))).toEqual(["7000", "0", "7000", "7000"]);
    expect(["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14"].map((k) => st(f, k as LineKey))).toEqual(["computed", "computed", "computed", "computed"]);
    expect(["f8606b.1", "f8606b.2", "f8606b.3", "f8606b.14"].map((k) => st(f, k as LineKey))).toEqual(["not_applicable", "not_applicable", "not_applicable", "not_applicable"]);
    expect(f.status).toBe("computed");
    // line 2 prints a 0 only because the owner stated it: the reason quotes the statement
    expect(f.lines.find((l) => l.key === "f8606a.2")?.reason).toContain("Stated:");
    expect(f.citations).toEqual(expect.arrayContaining(["FORM_8606_NOT_FILED_PENALTY", "IRA_PHASEOUT_SPOUSE_COVERED_MFJ"]));
  });

  it("a partial deduction flows through: 2,800 on line 1, 3 and 14 (nothing else is added)", () => {
    const f = form(ira([ERIC(), EVA()], 240000));
    expect(["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14"].map((k) => amt(f, k as LineKey))).toEqual(["2800", "0", "2800", "2800"]);
  });

  it("not stated (earlier-year basis): lines 2, 3 and 14 are missing_input with a plain statement, line 1 still computes", () => {
    const f = form(ira([ERIC(), EVA()], 270980), null, true);
    expect(st(f, "f8606a.1")).toBe("computed");
    expect(["f8606a.2", "f8606a.3", "f8606a.14"].map((k) => st(f, k as LineKey))).toEqual(["missing_input", "missing_input", "missing_input"]);
    expect(["f8606a.2", "f8606a.3", "f8606a.14"].map((k) => amt(f, k as LineKey))).toEqual([null, null, null]);
    expect(f.status).toBe("missing_input");
    expect(f.reasons.join(" ")).toContain("Needs an owner statement");
    expect(f.inputsMissing.join(" ")).toContain("earlier-year IRA basis");
  });

  it("answered Yes (earlier basis or another IRA event): lines 2, 3 and 14 are blocked with a plain-language reason, never a printed number", () => {
    const f = form(ira([ERIC(), EVA()], 270980), false, true);
    expect(st(f, "f8606a.1")).toBe("computed");
    expect(["f8606a.2", "f8606a.3", "f8606a.14"].map((k) => st(f, k as LineKey))).toEqual(["needs_cpa_judgment", "needs_cpa_judgment", "needs_cpa_judgment"]);
    const reason = f.lines.find((l) => l.key === "f8606a.2")?.reason ?? "";
    expect(reason).toContain("this app does not figure");
    expect(reason).toContain("2025 Form 8606 instructions");
  });

  it("an IRA distribution (the retirement statement is NOT 'none'): lines 1-3 still compute, line 14 is blocked (the form's flow box sends a distribution to line 4)", () => {
    const f = form(ira([ERIC(), EVA()], 270980), true, false);
    expect(["f8606a.1", "f8606a.2", "f8606a.3"].map((k) => st(f, k as LineKey))).toEqual(["computed", "computed", "computed"]);
    expect(st(f, "f8606a.14")).toBe("needs_cpa_judgment");
    expect(amt(f, "f8606a.14")).toBeNull();
    expect(f.lines.find((l) => l.key === "f8606a.14")?.reason).toContain("lines 4-13 and 15a-15c apply");
  });

  it("the distribution statement unanswered: line 14 is missing_input", () => {
    const f = form(ira([ERIC(), EVA()], 270980), true, null);
    expect(st(f, "f8606a.14")).toBe("missing_input");
    expect(st(f, "f8606a.3")).toBe("computed");
  });

  it("Yes to BOTH: the earlier-basis reason is the one on line 14", () => {
    const f = form(ira([ERIC(), EVA()], 270980), false, false);
    expect(f.lines.find((l) => l.key === "f8606a.14")?.reason).toContain("earlier-year IRA basis");
  });

  it("a person with nothing nondeductible has no Form 8606: all four lines not_applicable zeros", () => {
    const f = form(ira([ERIC(), EVA({ covered: answered(false) })], 270980));
    expect(["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14"].map((k) => st(f, k as LineKey))).toEqual(["not_applicable", "not_applicable", "not_applicable", "not_applicable"]);
    expect(f.status).toBe("not_applicable");
  });

  it("a blocked line 1 (excess contribution) blocks the whole form for that person with the SAME status", () => {
    const f = form(ira([ERIC({ compensation: D(3000) }), EVA({ covered: answered(false), compensation: D(0) })], 900000));
    expect(["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14"].map((k) => st(f, k as LineKey))).toEqual(["needs_cpa_judgment", "needs_cpa_judgment", "needs_cpa_judgment", "needs_cpa_judgment"]);
    expect(f.status).toBe("needs_cpa_judgment");
  });

  it("both spouses with a nondeductible contribution: two independent line sets, never mixed (Eric 7,000, Eva 5,000)", () => {
    const f = form(ira([ERIC(), EVA({ traditional: answered(D(5000)) })], 270980));
    expect(["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14"].map((k) => amt(f, k as LineKey))).toEqual(["7000", "0", "7000", "7000"]);
    expect(["f8606b.1", "f8606b.2", "f8606b.3", "f8606b.14"].map((k) => amt(f, k as LineKey))).toEqual(["5000", "0", "5000", "5000"]);
  });

  it("every emitted line key is a line of this rule, exactly once, and no reason says CPA (owner-facing wording)", () => {
    for (const [basis, dist] of [[true, true], [null, null], [false, true], [true, false], [false, false]] as const) {
      const f = form(ira([ERIC(), EVA()], 270980), basis, dist);
      const keys = f.lines.map((l) => l.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.sort()).toEqual(["f8606a.1", "f8606a.14", "f8606a.2", "f8606a.3", "f8606b.1", "f8606b.14", "f8606b.2", "f8606b.3"]);
      for (const l of f.lines) expect(l.reason ?? "", `${l.key} ${basis}/${dist}`).not.toMatch(/CPA/);
      for (const r of f.reasons) expect(r).not.toMatch(/CPA/);
    }
  });
});
