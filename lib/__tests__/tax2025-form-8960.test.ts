// Form 8960 (Net Investment Income Tax, individuals), every printed line of Parts I-III (task ty2025-sch1a-8960-pdfs).
// Expected values are worked by hand from the 2025 form (data/forms/2025/f8960.pdf) and its instructions
// (https://www.irs.gov/pub/irs-pdf/i8960.pdf): NIIT = 3.8% x the smaller of line 12 (net investment income, not below 0) or
// line 15 (MAGI over $250,000, not below 0), each line derived from the whole-dollar lines above it.

import { describe, expect, it } from "vitest";
import { answered, MISSING, UNSURE } from "@/lib/tax2025/answer-state";
import { LINE_KEYS } from "@/lib/tax2025/line-catalog";
import { D } from "@/lib/tax2025/money";
import { FORM_8960_KEYS, computeForm8960, type Form8960Input, type Form8960Lead } from "@/lib/tax2025/rules/form-8960";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

const lead = (n: number | null, status: Form8960Lead["status"] = n === null ? "missing_input" : "computed"): Form8960Lead => ({ amount: n === null ? null : D(n), status });

/** The household stand-in: interest 1,138, dividends 4, Schedule D line 16 = 1040 line 7a = 5,557, Schedule C loss -9,010, AGI 270,980. */
function input(over: Partial<Form8960Input> = {}): Form8960Input {
  return {
    agi: lead(270980),
    magiExclusionsNone: answered(true),
    interest: lead(1138),
    dividends: lead(4),
    pensions: lead(0),
    gain7a: lead(5557),
    sch1Line3: lead(-9010),
    sch1Line4: lead(0),
    sch1Line5: lead(0),
    sch1Line6: lead(0),
    schA5a: lead(15591),
    schA5d: lead(25018),
    schA5e: lead(25018),
    schA9: lead(0),
    itemizing: false,
    itemizingStatus: undefined,
    statedNoOtherIncome: true,
    statedNoCapitalOther: true,
    niitOther: true,
    otherInvestmentIncomePresent: false,
    ...over,
  };
}

const line = (r: RuleResult, key: LineKey) => {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`rule emitted no line ${key}`);
  return l;
};
const n = (r: RuleResult, key: LineKey): number | null => {
  const l = line(r, key);
  return l.amount === null ? null : l.amount.toNumber();
};
const st = (r: RuleResult, key: LineKey): string => line(r, key).status ?? r.status;

describe("Form 8960: every printed line is emitted", () => {
  it("emits the 26 keys (25 form lines for an individual + Schedule 2 line 12) exactly once, in every branch", () => {
    expect(FORM_8960_KEYS).toHaveLength(26);
    for (const k of FORM_8960_KEYS) expect(LINE_KEYS, k).toContain(k);
    const variants: Partial<Form8960Input>[] = [
      {},
      { itemizing: true },
      { agi: lead(200000) },
      { agi: lead(null) },
      { niitOther: undefined },
      { otherInvestmentIncomePresent: true },
      { interest: lead(null) },
      { magiExclusionsNone: MISSING },
    ];
    for (const v of variants) {
      expect(computeForm8960(input(v)).lines.map((l) => l.key).sort()).toEqual([...FORM_8960_KEYS].sort());
    }
  });
});

describe("Form 8960: golden, no state-tax allocation (the standard deduction: line 9b is 0)", () => {
  const r = computeForm8960(input());

  it("Part I: 1,138 / 4 / 0 / -9,010 +9,010 = 0 / 5,557 / 6 and 7 stated none / line 8 = 6,699", () => {
    expect([n(r, "f8960.1"), n(r, "f8960.2"), n(r, "f8960.3")]).toEqual([1138, 4, 0]);
    expect([n(r, "f8960.4a"), n(r, "f8960.4b"), n(r, "f8960.4c")]).toEqual([-9010, 9010, 0]);
    expect([n(r, "f8960.5a"), n(r, "f8960.5b"), n(r, "f8960.5c"), n(r, "f8960.5d")]).toEqual([5557, 0, 0, 5557]);
    expect([n(r, "f8960.6"), n(r, "f8960.7"), n(r, "f8960.8")]).toEqual([0, 0, 6699]);
  });

  it("Part II: all zero; Part III: 12 = 6,699, MAGI 270,980, 14 = 250,000, 15 = 20,980, 16 = 6,699, 17 = 255 = Schedule 2 line 12", () => {
    expect([n(r, "f8960.9a"), n(r, "f8960.9b"), n(r, "f8960.9c"), n(r, "f8960.9d"), n(r, "f8960.10"), n(r, "f8960.11")]).toEqual([0, 0, 0, 0, 0, 0]);
    expect([n(r, "f8960.nii"), n(r, "f8960.13"), n(r, "f8960.14"), n(r, "f8960.15"), n(r, "f8960.16"), n(r, "f8960.niit")]).toEqual([6699, 270980, 250000, 20980, 6699, 255]);
    expect(n(r, "sch2.12")).toBe(255); // 0.038 x 6,699 = 254.562
    expect(r.status).toBe("computed");
    expect(r.conclusion).toBe("eligible");
  });
});

describe("Form 8960: golden with the state-income-tax allocation on line 9b (itemizing)", () => {
  const r = computeForm8960(input({ itemizing: true }));

  it("line 9b = 15,591 x 6,699 / 270,980 = 385; 9d = 11 = 385; line 12 = 6,314; 17 = 240 (not 255)", () => {
    expect([n(r, "f8960.9a"), n(r, "f8960.9b"), n(r, "f8960.9c"), n(r, "f8960.9d"), n(r, "f8960.10"), n(r, "f8960.11")]).toEqual([0, 385, 0, 385, 0, 385]);
    expect([n(r, "f8960.8"), n(r, "f8960.nii"), n(r, "f8960.15"), n(r, "f8960.16"), n(r, "f8960.niit"), n(r, "sch2.12")]).toEqual([6699, 6314, 20980, 6314, 240, 240]);
  });

  it("the line 9b reason and the rule reasons show the no-allocation alternative (255 against 240)", () => {
    expect(line(r, "f8960.9b").reason).toContain("With no allocation the tax would be $255");
    expect(r.reasons.join(" ")).toContain("With no allocation (line 9b = 0) line 17 would be $255 instead of $240");
  });

  it("another reasonable method (investment income over total income 273,291) also gives 240: the result is insensitive to the method", () => {
    // 15,591 x 6,699 / 273,291 = 382.2 -> 382; line 12 = 6,317; 6,317 x 3.8% = 240.05
    expect(Math.round(15591 * (6699 / 273291))).toBe(382);
    expect(Math.round((6699 - 382) * 0.038)).toBe(240);
  });
});

describe("Form 8960: independent footing oracle on a grid", () => {
  const agis = [249999, 250000, 250001, 270980, 300000, 600000];
  const interests = [0, 500, 1138, 20000];
  const gains = [-3000, 0, 5557, 100000];
  for (const agi of agis) {
    for (const interest of interests) {
      for (const gain of gains) {
        for (const itemizing of [false, true]) {
          it(`AGI ${agi}, interest ${interest}, line 7a ${gain}, ${itemizing ? "itemizing" : "standard"}`, () => {
            const r = computeForm8960(input({ agi: lead(agi), interest: lead(interest), gain7a: lead(gain), itemizing, schA5a: lead(12000), schA5d: lead(20000), schA5e: lead(20000) }));
            const g = (k: LineKey) => n(r, k) ?? 0;
            // each derived line equals the arithmetic on the PRINTED lines above it
            expect(g("f8960.4c")).toBe(g("f8960.4a") + g("f8960.4b"));
            expect(g("f8960.5d")).toBe(g("f8960.5a") + g("f8960.5b") + g("f8960.5c"));
            expect(g("f8960.9d")).toBe(g("f8960.9a") + g("f8960.9b") + g("f8960.9c"));
            expect(g("f8960.11")).toBe(g("f8960.9d") + g("f8960.10"));
            expect(g("f8960.15")).toBe(Math.max(0, agi - 250000));
            expect(g("f8960.16")).toBe(Math.min(g("f8960.nii"), g("f8960.15")));
            expect(g("f8960.niit")).toBe(Math.round(g("f8960.16") * 0.038));
            expect(g("sch2.12")).toBe(g("f8960.niit"));
            if (agi > 250000) {
              expect(g("f8960.8")).toBe(g("f8960.1") + g("f8960.2") + g("f8960.3") + g("f8960.4c") + g("f8960.5d") + g("f8960.6") + g("f8960.7"));
              expect(g("f8960.nii")).toBe(Math.max(0, g("f8960.8") - g("f8960.11")));
              // the hand oracle from the inputs: line 8 = interest + 4 + the capital line, line 9b = state tax x line 8 / AGI (ratio capped at 1)
              const l8 = interest + 4 + gain;
              expect(g("f8960.8")).toBe(l8);
              const l9b = itemizing && l8 > 0 ? Math.round((12000 * Math.min(l8, agi)) / agi) : 0;
              expect(g("f8960.9b")).toBe(l9b);
              expect(g("f8960.nii")).toBe(Math.max(0, l8 - l9b));
            }
          });
        }
      }
    }
  }
});

describe("Form 8960: the threshold", () => {
  it("MAGI exactly 250,000: line 15 = 0, line 17 = 0, Schedule 2 line 12 = 0, the form is not required and nothing blocks", () => {
    const r = computeForm8960(input({ agi: lead(250000), niitOther: undefined }));
    expect(r.status).toBe("computed");
    expect(r.conclusion).toBe("ineligible");
    expect([n(r, "f8960.15"), n(r, "f8960.16"), n(r, "f8960.niit"), n(r, "sch2.12")]).toEqual([0, 0, 0, 0]);
    expect(r.reasons[0]).toContain("not over");
    // the statement that only matters over the threshold is not asked: lines 6, 7 and 10 are not applicable zeros
    for (const k of ["f8960.6", "f8960.7", "f8960.10"] as const) expect(st(r, k), k).toBe("not_applicable");
  });

  it("everything unresolved under the threshold is a not_applicable zero, never a block", () => {
    const r = computeForm8960(input({ agi: lead(200000), interest: lead(null), sch1Line5: lead(null), niitOther: undefined, otherInvestmentIncomePresent: true }));
    expect(r.status).toBe("computed");
    for (const l of r.lines) expect(["computed", "not_applicable"], l.key).toContain(l.status ?? r.status);
    expect(n(r, "sch2.12")).toBe(0);
    expect(st(r, "f8960.1")).toBe("not_applicable");
    expect(line(r, "f8960.1").reason).toContain("not required");
  });

  it("MAGI 250,001: line 15 = 1, 3.8% of 1 rounds to 0, but the form is still required (over the threshold with investment income)", () => {
    const r = computeForm8960(input({ agi: lead(250001) }));
    expect([n(r, "f8960.15"), n(r, "f8960.16"), n(r, "f8960.niit")]).toEqual([1, 1, 0]);
    expect(n(r, "f8960.8")).toBe(6699);
  });

  it("a limited capital loss reduces investment income by at most 3,000: 1,000 + 500 - 3,000 = -1,500 -> line 12 = 0", () => {
    const r = computeForm8960(input({ interest: lead(1000), dividends: lead(500), gain7a: lead(-3000), sch1Line3: lead(0) }));
    expect([n(r, "f8960.5a"), n(r, "f8960.8"), n(r, "f8960.nii"), n(r, "f8960.niit")]).toEqual([-3000, -1500, 0, 0]);
    expect(st(r, "f8960.niit")).toBe("computed");
  });

  it("a large gain and a loss that does not exceed the other income: 500 + 1,000 - 1,000 = 500 -> 3.8% = 19", () => {
    const r = computeForm8960(input({ agi: lead(300000), interest: lead(500), dividends: lead(1000), gain7a: lead(-1000), sch1Line3: lead(0) }));
    expect([n(r, "f8960.nii"), n(r, "f8960.niit")]).toEqual([500, 19]);
  });
});

describe("Form 8960: line 9 and the deductions", () => {
  it("itemizing: line 9a is Schedule A line 9 (investment interest)", () => {
    const r = computeForm8960(input({ itemizing: true, schA9: lead(300) }));
    expect(n(r, "f8960.9a")).toBe(300);
    expect(n(r, "f8960.9d")).toBe(300 + (n(r, "f8960.9b") ?? 0));
  });

  it("the standard deduction in force: 9a = 9b = 0 (not applicable, with the reason)", () => {
    const r = computeForm8960(input({ itemizing: false, schA9: lead(300) }));
    expect([n(r, "f8960.9a"), n(r, "f8960.9b")]).toEqual([0, 0]);
    expect(st(r, "f8960.9b")).toBe("not_applicable");
    expect(line(r, "f8960.9b").reason).toContain("standard deduction");
  });

  it("the state tax cap binding (5e below 5d): the instructions do not say how to split it -> needs_cpa_judgment, the tax is blocked", () => {
    const r = computeForm8960(input({ itemizing: true, schA5d: lead(52000), schA5e: lead(40000) }));
    expect(st(r, "f8960.9b")).toBe("needs_cpa_judgment");
    expect(n(r, "f8960.niit")).toBeNull();
    expect(st(r, "f8960.niit")).toBe("needs_cpa_judgment");
    expect(st(r, "sch2.12")).toBe("needs_cpa_judgment");
    expect(r.status).toBe("needs_cpa_judgment");
  });

  it("total investment income not positive: nothing is allocated (9b = 0, not applicable); AGI not positive likewise", () => {
    const loss = computeForm8960(input({ itemizing: true, interest: lead(0), dividends: lead(0), gain7a: lead(-3000) }));
    expect([n(loss, "f8960.8"), n(loss, "f8960.9b")]).toEqual([-3000, 0]);
    expect(st(loss, "f8960.9b")).toBe("not_applicable");
  });

  it("the ratio of line 8 to AGI is capped at 1 (line 8 above AGI cannot allocate more than the tax)", () => {
    // AGI 260,000 but investment income 500,000 (offset by a large business loss): 100% of the 12,000 state tax
    const r = computeForm8960(input({ agi: lead(260000), itemizing: true, interest: lead(500000), schA5a: lead(12000), schA5d: lead(12000), schA5e: lead(12000) }));
    expect(n(r, "f8960.9b")).toBe(12000);
  });

  it("line 9c is 0 for 2025 (miscellaneous investment expenses are no longer deductible)", () => {
    const r = computeForm8960(input({ itemizing: true }));
    expect([n(r, "f8960.9c"), st(r, "f8960.9c")]).toEqual([0, "not_applicable"]);
    expect(line(r, "f8960.9c").reason).toContain("no longer deductible");
  });
});

describe("Form 8960: Part I classification", () => {
  it("Schedule C profit +20,000: line 4a = 20,000, line 4b = -20,000, line 4c = 0 (a non-passive trade or business is not investment income)", () => {
    const r = computeForm8960(input({ sch1Line3: lead(20000) }));
    expect([n(r, "f8960.4a"), n(r, "f8960.4b"), n(r, "f8960.4c")]).toEqual([20000, -20000, 0]);
  });

  it("no Schedule C: line 4b is a not_applicable 0", () => {
    const r = computeForm8960(input({ sch1Line3: lead(0) }));
    expect([n(r, "f8960.4a"), n(r, "f8960.4b"), st(r, "f8960.4b")]).toEqual([0, 0, "not_applicable"]);
  });

  it("Schedule 1 line 5 or 6 not zero: whether it is passive is unknown, so line 4b goes to the CPA and the tax is blocked", () => {
    for (const over of [{ sch1Line5: lead(7000) }, { sch1Line6: lead(-300) }]) {
      const r = computeForm8960(input(over));
      expect(st(r, "f8960.4b")).toBe("needs_cpa_judgment");
      expect(n(r, "f8960.4c")).toBeNull();
      expect(n(r, "f8960.niit")).toBeNull();
    }
  });

  it("pensions or annuities on Form 1040 line 5b: line 3 goes to the CPA; not computed -> blocked with that status", () => {
    expect(st(computeForm8960(input({ pensions: lead(12000) })), "f8960.3")).toBe("needs_cpa_judgment");
    expect(st(computeForm8960(input({ pensions: lead(null, "not_yet_computed") })), "f8960.3")).toBe("not_yet_computed");
  });

  it("other gains on Schedule 1 line 4 or an unanswered / Yes capital statement: lines 5b and 5c need the CPA or an answer, never a silent 0", () => {
    expect(st(computeForm8960(input({ sch1Line4: lead(800) })), "f8960.5b")).toBe("needs_cpa_judgment");
    expect(st(computeForm8960(input({ statedNoCapitalOther: undefined })), "f8960.5b")).toBe("missing_input");
    expect(st(computeForm8960(input({ statedNoCapitalOther: false })), "f8960.5c")).toBe("needs_cpa_judgment");
    expect(st(computeForm8960(input({ statedNoOtherIncome: undefined })), "f8960.5c")).toBe("missing_input");
  });

  it("interest or dividends not computed: the line and everything that adds it is blocked with that status", () => {
    const r = computeForm8960(input({ interest: lead(null) }));
    expect(st(r, "f8960.1")).toBe("missing_input");
    for (const k of ["f8960.8", "f8960.nii", "f8960.16", "f8960.niit", "sch2.12"] as const) expect(st(r, k), k).toBe("missing_input");
    expect(n(r, "f8960.15")).toBe(20980); // the MAGI side does not depend on it
  });
});

describe("Form 8960: lines 6, 7 and 10 need an owner statement", () => {
  it("not answered over the threshold: missing_input on each, and the tax is blocked with it", () => {
    const r = computeForm8960(input({ niitOther: undefined }));
    for (const k of ["f8960.6", "f8960.7", "f8960.10"] as const) expect(st(r, k), k).toBe("missing_input");
    expect(st(r, "f8960.niit")).toBe("missing_input");
    expect(r.status).toBe("missing_input");
    expect(r.inputsMissing.join(" ")).toContain("Form 8960 lines 6, 7 and 10");
  });

  it("answered Yes: needs_cpa_judgment; stated none: a not_applicable zero that quotes the statement", () => {
    const yes = computeForm8960(input({ niitOther: false }));
    expect(st(yes, "f8960.6")).toBe("needs_cpa_judgment");
    const none = computeForm8960(input({ niitOther: true }));
    expect(line(none, "f8960.6").reason).toContain("foreign corporation");
  });
});

describe("Form 8960: MAGI and the other investment income the engine does not compute", () => {
  it("excluded income (Puerto Rico / Form 2555 / 4563) answered Yes or not sure: line 13 goes to the CPA; unanswered (the question is only asked when a Schedule 1-A part applies): none is reported", () => {
    for (const a of [UNSURE, answered(false)]) {
      const r = computeForm8960(input({ magiExclusionsNone: a }));
      expect(st(r, "f8960.13")).toBe("needs_cpa_judgment");
      expect(st(r, "f8960.niit")).toBe("needs_cpa_judgment");
    }
    const unanswered = computeForm8960(input({ magiExclusionsNone: MISSING }));
    expect([st(unanswered, "f8960.13"), n(unanswered, "f8960.13"), n(unanswered, "f8960.niit")]).toEqual(["computed", 270980, 255]);
    expect(line(unanswered, "f8960.13").reason).toContain("not answered");
  });

  it("an unread 1099-B / other boxes over the threshold: line 5a, 8, 12, 16, 17 and Schedule 2 line 12 are needs_cpa_judgment", () => {
    const r = computeForm8960(input({ otherInvestmentIncomePresent: true }));
    for (const k of ["f8960.5a", "f8960.5d", "f8960.8", "f8960.nii", "f8960.16", "f8960.niit", "sch2.12"] as const) expect(st(r, k), k).toBe("needs_cpa_judgment");
    expect(r.status).toBe("needs_cpa_judgment");
    // below the threshold the conclusion does not depend on it
    expect(computeForm8960(input({ agi: lead(200000), otherInvestmentIncomePresent: true })).status).toBe("computed");
  });

  it("AGI not computed: every line that needs the MAGI waits (13, 15, 16, 17), the Part I lines are still computed", () => {
    const r = computeForm8960(input({ agi: lead(null) }));
    expect(st(r, "f8960.13")).toBe("missing_input");
    expect(st(r, "f8960.niit")).toBe("missing_input");
    expect(n(r, "f8960.1")).toBe(1138);
  });
});
