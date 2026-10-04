// Schedule 1-A: EVERY printed money line (task ty2025-sch1a-8960-pdfs). The rule emits all 41 keyed lines in every
// branch, derives each line from the whole-dollar lines above it (so the printed form foots), and marks a part that is
// not used with not_applicable on all of its lines. Expected values are worked by hand from the 2025 form text
// (data/forms/2025/f1040s1a.pdf) and the instructions in the 2025 Form 1040 instructions (pp. 101-110).

import { describe, expect, it } from "vitest";
import { answered, MISSING, UNSURE } from "@/lib/tax2025/answer-state";
import { LINE_KEYS } from "@/lib/tax2025/line-catalog";
import { D } from "@/lib/tax2025/money";
import { computeSchedule1a, type Sch1aInput, type Sch1aPersonInput } from "@/lib/tax2025/rules/schedule-1a";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

const S1A_KEYS = LINE_KEYS.filter((k) => k.startsWith("sch1a."));

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
const tipper = (name: string, tips: number): Sch1aPersonInput => person(name, { tips: answered("some"), tipsAmount: answered(D(tips)) });
const overtimer = (name: string, ot: number): Sch1aPersonInput => person(name, { overtime: answered("premium"), overtimeAmount: answered(D(ot)) });

function input(over: Partial<Sch1aInput> = {}): Sch1aInput {
  return {
    magi: D(100000),
    magiExclusionsNone: answered(true),
    people: [person("Alex"), person("Sam")],
    carLoan: { choice: answered("none"), qualifies: MISSING, interestPaid: MISSING, deductedElsewhere: MISSING },
    tipsEmployers: null,
    scheduleCOwnerTips: answered("none"),
    ...over,
  };
}

/** The golden stand-in for the household: Sam tips 4,545.80 from ONE employer (W-2 box 7), overtime premium 2,408, MAGI 270,980. */
function golden(over: Partial<Sch1aInput> = {}): Sch1aInput {
  return input({
    magi: D(270980),
    people: [person("Alex"), person("Sam", { tips: answered("some"), tipsAmount: answered(D("4545.80")), overtime: answered("premium"), overtimeAmount: answered(D(2408)) })],
    tipsEmployers: { employersWithBox7: 1, box7Total: D("4545.80") },
    ...over,
  });
}

describe("Schedule 1-A: every printed line is emitted (golden household)", () => {
  const r = computeSchedule1a(golden());

  it("emits each of the 41 keyed lines exactly once, in every branch", () => {
    expect(S1A_KEYS).toHaveLength(41);
    for (const input_ of [golden(), input(), input({ magi: null }), golden({ magi: null }), golden({ scheduleCOwnerTips: null })]) {
      const res = computeSchedule1a(input_);
      expect(res.lines.map((l) => l.key).sort()).toEqual([...S1A_KEYS].sort());
    }
  });

  it("Part I: line 1 and line 3 are the MAGI", () => {
    expect([n(r, "sch1a.1"), n(r, "sch1a.3")]).toEqual([270980, 270980]);
  });

  it("Part II: 4a 4,546 (one employer, W-2 box 7), 4b 0 not applicable, 4c 4,546, 5 0, 6 and 7 4,546, no reduction", () => {
    expect(n(r, "sch1a.4a")).toBe(4546);
    expect(st(r, "sch1a.4a")).toBe("computed");
    expect([n(r, "sch1a.4b"), st(r, "sch1a.4b")]).toEqual([0, "not_applicable"]);
    expect(n(r, "sch1a.4c")).toBe(4546);
    expect([n(r, "sch1a.5"), st(r, "sch1a.5")]).toEqual([0, "not_applicable"]);
    expect([n(r, "sch1a.6"), n(r, "sch1a.7"), n(r, "sch1a.8"), n(r, "sch1a.9")]).toEqual([4546, 4546, 270980, 300000]);
    // MAGI 270,980 is not over 300,000: lines 10-12 are skipped and line 7 goes straight to line 13
    for (const k of ["sch1a.10", "sch1a.11", "sch1a.12"] as const) expect([n(r, k), st(r, k)], k).toEqual([0, "not_applicable"]);
    expect(line(r, "sch1a.10").reason).toContain("not over");
    expect([n(r, "sch1a.13"), st(r, "sch1a.13")]).toEqual([4546, "computed"]);
  });

  it("Part III: 14a 2,408, 14b not applicable, 14c 2,408, 15 2,408, 16 MAGI, 17 300,000, 18-20 skipped, 21 2,408", () => {
    expect([n(r, "sch1a.14a"), n(r, "sch1a.14c"), n(r, "sch1a.15"), n(r, "sch1a.16"), n(r, "sch1a.17")]).toEqual([2408, 2408, 2408, 270980, 300000]);
    expect(st(r, "sch1a.14b")).toBe("not_applicable");
    for (const k of ["sch1a.18", "sch1a.19", "sch1a.20"] as const) expect(st(r, k), k).toBe("not_applicable");
    expect(n(r, "sch1a.21")).toBe(2408);
  });

  it("Parts IV and V are not used: every line not applicable (blank on the form); 36a 36b 37 are 0", () => {
    const unused: LineKey[] = ["sch1a.23", "sch1a.24", "sch1a.25", "sch1a.26", "sch1a.27", "sch1a.28", "sch1a.29", "sch1a.30", "sch1a.31", "sch1a.32", "sch1a.33", "sch1a.34", "sch1a.35", "sch1a.36a", "sch1a.36b", "sch1a.37"];
    for (const k of unused) expect([n(r, k), st(r, k)], k).toEqual([0, "not_applicable"]);
  });

  it("Part VI: line 38 = 4,546 + 2,408 = 6,954", () => {
    expect([n(r, "sch1a.38"), st(r, "sch1a.38")]).toEqual([6954, "computed"]);
  });
});

describe("Schedule 1-A: a part that is not used emits not_applicable for ALL its lines", () => {
  it("nothing claimed: Part I only (MAGI present); Parts II-V are all not_applicable, 38 is a not_applicable zero", () => {
    const r = computeSchedule1a(input());
    expect(st(r, "sch1a.1")).toBe("computed");
    for (const k of S1A_KEYS.filter((x) => !["sch1a.1", "sch1a.3"].includes(x))) expect(st(r, k), k).toBe("not_applicable");
    expect(n(r, "sch1a.38")).toBe(0);
  });

  it("nothing claimed and the MAGI not computed: no MAGI is needed, nothing blocks", () => {
    const r = computeSchedule1a(input({ magi: null }));
    expect(r.status).toBe("not_applicable");
    expect(S1A_KEYS.every((k) => st(r, k) === "not_applicable")).toBe(true);
  });

  it("only overtime used: the whole tips part (4a-13) and Parts IV and V stay not applicable", () => {
    const r = computeSchedule1a(input({ people: [person("Alex"), overtimer("Sam", 3000)] }));
    for (const k of ["sch1a.4a", "sch1a.4b", "sch1a.4c", "sch1a.5", "sch1a.6", "sch1a.7", "sch1a.8", "sch1a.9", "sch1a.10", "sch1a.11", "sch1a.12", "sch1a.13"] as const) {
      expect(st(r, k), k).toBe("not_applicable");
    }
    expect(n(r, "sch1a.21")).toBe(3000);
    expect(n(r, "sch1a.38")).toBe(3000);
  });

  it("a person without a valid SSN has 0 qualified amount, so the part is not used", () => {
    const r = computeSchedule1a(input({ people: [person("Alex"), person("Sam", { tips: answered("some"), tipsAmount: answered(D(900)), validSsn: answered(false) })] }));
    expect(st(r, "sch1a.4c")).toBe("not_applicable");
    expect(line(r, "sch1a.4c").reason).toContain("Social Security number");
    expect(n(r, "sch1a.38")).toBe(0);
  });
});

describe("Schedule 1-A: the tips lines (4a-13) at the thresholds", () => {
  const tips = (magi: number, amount = 4546) => computeSchedule1a(input({ magi: D(magi), people: [tipper("Alex", amount), person("Sam")] }));

  it("MAGI 300,000 and 300,999: line 10 is not skipped at 300,999 but line 11 is 0 (rounded DOWN); 301,000 reduces by 100", () => {
    const at = tips(300000);
    expect(st(at, "sch1a.10")).toBe("not_applicable"); // zero or less: lines 11 and 12 skipped
    expect(n(at, "sch1a.13")).toBe(4546);
    const r = tips(300999);
    expect([n(r, "sch1a.10"), n(r, "sch1a.11"), n(r, "sch1a.12"), n(r, "sch1a.13")]).toEqual([999, 0, 0, 4546]);
    const s = tips(301000);
    expect([n(s, "sch1a.10"), n(s, "sch1a.11"), n(s, "sch1a.12"), n(s, "sch1a.13")]).toEqual([1000, 1, 100, 4446]);
  });

  it("tips 4,546 at MAGI 345,999 -> reduction 100 x 45 = 4,500 -> line 13 = 46; at 346,000 -> 4,600 -> 0 (computed zero)", () => {
    const a = tips(345999);
    expect([n(a, "sch1a.11"), n(a, "sch1a.12"), n(a, "sch1a.13")]).toEqual([45, 4500, 46]);
    const b = tips(346000);
    expect([n(b, "sch1a.11"), n(b, "sch1a.12"), n(b, "sch1a.13"), st(b, "sch1a.13")]).toEqual([46, 4600, 0, "computed"]);
  });

  it("the 25,000 maximum is combined: 20,000 + 10,000 = 30,000 -> line 7 = 25,000", () => {
    const r = computeSchedule1a(input({ people: [tipper("Alex", 20000), tipper("Sam", 10000)] }));
    expect([n(r, "sch1a.4c"), n(r, "sch1a.6"), n(r, "sch1a.7"), n(r, "sch1a.13")]).toEqual([30000, 30000, 25000, 25000]);
  });
});

describe("Schedule 1-A: lines 4a and 4b (more than one employer)", () => {
  const sam = (amount: number) => [person("Alex"), tipper("Sam", amount)];

  it("exactly one employer with box 7 equal to the owner's tips: 4a is the amount, rounded to whole dollars", () => {
    const r = computeSchedule1a(input({ people: sam(1999.5), tipsEmployers: { employersWithBox7: 1, box7Total: D("1999.50") } }));
    expect(n(r, "sch1a.4a")).toBe(2000);
    expect(n(r, "sch1a.4c")).toBe(2000);
  });

  it("two employers with box 7: 4a and 4b are blank (not_yet_computed, informational), 4c keeps the owner's total", () => {
    const r = computeSchedule1a(input({ people: sam(5000), tipsEmployers: { employersWithBox7: 2, box7Total: D(5000) } }));
    for (const k of ["sch1a.4a", "sch1a.4b"] as const) {
      expect(st(r, k), k).toBe("not_yet_computed");
      expect(n(r, k), k).toBeNull();
      expect(line(r, k).informational).toBe(true);
      expect(line(r, k).reason).toContain("More Than One Employer");
    }
    expect(n(r, "sch1a.4c")).toBe(5000);
    expect(n(r, "sch1a.38")).toBe(5000);
    expect(r.status).toBe("computed"); // informational lines never block the rule
  });

  it("no W-2 box 7 or an amount that differs: 4a and 4b blank, 4c the owner's total", () => {
    for (const te of [null, { employersWithBox7: 0, box7Total: D(0) }, { employersWithBox7: 1, box7Total: D(4999) }]) {
      const r = computeSchedule1a(input({ people: sam(5000), tipsEmployers: te }));
      expect(st(r, "sch1a.4a")).toBe("not_yet_computed");
      expect(n(r, "sch1a.4c")).toBe(5000);
    }
  });
});

describe("Schedule 1-A: line 5 (tips received in the course of a trade or business)", () => {
  const withOwner = (scheduleCOwnerTips: Sch1aInput["scheduleCOwnerTips"]) => computeSchedule1a(golden({ scheduleCOwnerTips }));

  it("the Schedule C owner states no tips: line 5 is a not_applicable 0 and the deduction follows", () => {
    const r = withOwner(answered("none"));
    expect([n(r, "sch1a.5"), st(r, "sch1a.5")]).toEqual([0, "not_applicable"]);
    expect(n(r, "sch1a.38")).toBe(6954);
  });

  it("some tips / ask the employer / not sure: needs_cpa_judgment, line 6 and everything after it blocks (never a silent 0)", () => {
    for (const a of [answered("some" as const), answered("ask_employer" as const), UNSURE]) {
      const r = withOwner(a);
      expect(st(r, "sch1a.5")).toBe("needs_cpa_judgment");
      expect(n(r, "sch1a.6")).toBeNull();
      expect(n(r, "sch1a.13")).toBeNull();
      expect(n(r, "sch1a.38")).toBeNull();
    }
  });

  it("the answer is missing: missing_input; no Schedule C owner identified: needs_cpa_judgment", () => {
    expect(st(withOwner(MISSING), "sch1a.5")).toBe("missing_input");
    expect(st(withOwner(null), "sch1a.5")).toBe("needs_cpa_judgment");
  });

  it("line 5 is only looked at when Part II is used", () => {
    const r = computeSchedule1a(input({ scheduleCOwnerTips: UNSURE }));
    expect(n(r, "sch1a.38")).toBe(0);
    expect(st(r, "sch1a.5")).toBe("not_applicable");
  });
});

describe("Schedule 1-A: overtime lines 14a-21", () => {
  it("MAGI 310,000, overtime 20,000: 18 = 10,000, 19 = 10, 20 = 1,000, 21 = 19,000 (14b not applicable, 14c = 14a)", () => {
    const r = computeSchedule1a(input({ magi: D(310000), people: [person("Alex"), overtimer("Sam", 20000)] }));
    expect([n(r, "sch1a.14a"), n(r, "sch1a.14c"), n(r, "sch1a.15"), n(r, "sch1a.16"), n(r, "sch1a.17")]).toEqual([20000, 20000, 20000, 310000, 300000]);
    expect([n(r, "sch1a.18"), n(r, "sch1a.19"), n(r, "sch1a.20"), n(r, "sch1a.21")]).toEqual([10000, 10, 1000, 19000]);
  });

  it("a total of 40,000 is capped at 25,000 (combined); MAGI exactly 300,000 skips lines 19 and 20", () => {
    const r = computeSchedule1a(input({ magi: D(300000), people: [overtimer("Alex", 25000), overtimer("Sam", 15000)] }));
    expect([n(r, "sch1a.14c"), n(r, "sch1a.15"), n(r, "sch1a.21")]).toEqual([40000, 25000, 25000]);
    expect(st(r, "sch1a.19")).toBe("not_applicable");
  });
});

describe("Schedule 1-A: car-loan lines 22-30", () => {
  const car = (paid: number, elsewhere = 0) => ({ choice: answered("some" as const), qualifies: answered(true), interestPaid: answered(D(paid)), deductedElsewhere: answered(D(elsewhere)) });

  it("MAGI 200,001 rounds the reduction UP to one step: 27 = 1 (200,001 - 200,000 = 1), 28 = ceil(0.001) = 1, 29 = 200, 30 = 9,800", () => {
    const r = computeSchedule1a(input({ magi: D(200001), carLoan: car(12000) }));
    expect([n(r, "sch1a.23"), n(r, "sch1a.24"), n(r, "sch1a.25"), n(r, "sch1a.26")]).toEqual([12000, 10000, 200001, 200000]);
    expect([n(r, "sch1a.27"), n(r, "sch1a.28"), n(r, "sch1a.29"), n(r, "sch1a.30")]).toEqual([1, 1, 200, 9800]);
  });

  it("MAGI exactly 200,000 skips lines 28 and 29 and puts line 24 on line 30; 205,000 -> 5 steps -> 1,000 off", () => {
    const a = computeSchedule1a(input({ magi: D(200000), carLoan: car(8000) }));
    expect([st(a, "sch1a.27"), st(a, "sch1a.28"), st(a, "sch1a.29"), n(a, "sch1a.30")]).toEqual(["not_applicable", "not_applicable", "not_applicable", 8000]);
    const b = computeSchedule1a(input({ magi: D(205000), carLoan: car(8000) }));
    expect([n(b, "sch1a.28"), n(b, "sch1a.29"), n(b, "sch1a.30")]).toEqual([5, 1000, 7000]);
  });

  it("interest deducted on Schedule C is excluded; all of it deducted there leaves Part IV unused", () => {
    expect(n(computeSchedule1a(input({ carLoan: car(6000, 1000) })), "sch1a.23")).toBe(5000);
    const none = computeSchedule1a(input({ carLoan: car(1000, 1000) }));
    expect(st(none, "sch1a.23")).toBe("not_applicable");
    expect(n(none, "sch1a.38")).toBe(0);
  });
});

describe("Schedule 1-A: seniors lines 31-37", () => {
  const senior = (name: string) => person(name, { bornBefore1961: answered(true) });

  it("one senior at MAGI 160,000: 33 = 10,000, 34 = 600, 35 = 5,400, 36a = 5,400, 36b 0, 37 = 5,400", () => {
    const r = computeSchedule1a(input({ magi: D(160000), people: [senior("Alex"), person("Sam")] }));
    expect([n(r, "sch1a.31"), n(r, "sch1a.32"), n(r, "sch1a.33"), n(r, "sch1a.34"), n(r, "sch1a.35")]).toEqual([160000, 150000, 10000, 600, 5400]);
    expect([n(r, "sch1a.36a"), st(r, "sch1a.36b"), n(r, "sch1a.37"), n(r, "sch1a.38")]).toEqual([5400, "not_applicable", 5400, 5400]);
  });

  it("MAGI exactly 150,000 skips lines 33-34 and puts 6,000 on line 35; two seniors get 12,000", () => {
    const r = computeSchedule1a(input({ magi: D(150000), people: [senior("Alex"), senior("Sam")] }));
    expect([st(r, "sch1a.33"), st(r, "sch1a.34"), n(r, "sch1a.35")]).toEqual(["not_applicable", "not_applicable", 6000]);
    expect(n(r, "sch1a.37")).toBe(12000);
  });

  it("line 34 is rounded to whole dollars BEFORE line 35 (a person filling the form): MAGI 150,008 -> 0.48 -> 0; 150,009 -> 0.54 -> 1", () => {
    // 6% of 8 = 0.48 rounds to 0, so line 35 = 6,000; 6% of 9 = 0.54 rounds to 1, so line 35 = 5,999
    expect(n(computeSchedule1a(input({ magi: D(150008), people: [senior("Alex"), person("Sam")] })), "sch1a.35")).toBe(6000);
    expect(n(computeSchedule1a(input({ magi: D(150009), people: [senior("Alex"), person("Sam")] })), "sch1a.35")).toBe(5999);
  });

  it("an unanswered age blocks the shared lines and 38; a senior without a valid SSN leaves the part unused", () => {
    const miss = computeSchedule1a(input({ people: [person("Alex", { bornBefore1961: MISSING }), person("Sam")] }));
    expect(st(miss, "sch1a.31")).toBe("missing_input");
    expect(st(miss, "sch1a.38")).toBe("missing_input");
    const noSsn = computeSchedule1a(input({ people: [person("Alex", { bornBefore1961: answered(true), validSsn: answered(false) }), person("Sam")] }));
    expect(st(noSsn, "sch1a.35")).toBe("not_applicable");
    expect(n(noSsn, "sch1a.38")).toBe(0);
  });
});

describe("Schedule 1-A: the printed form foots on a grid of MAGI, tips and overtime", () => {
  const magis = [299999, 300000, 300001, 300999, 301000, 325000, 345460, 345461, 400000];
  const tipAmounts = [0, 999.5, 4545.8, 25000, 30000];
  const overtimeAmounts = [0, 2408, 12500, 25000, 40000];
  const round = (x: number) => Math.round(x); // test arithmetic on values that never end in exactly .5 except 999.5 (rounds up, as the IRS)

  for (const magi of magis) {
    for (const tips of tipAmounts) {
      for (const ot of overtimeAmounts) {
        it(`MAGI ${magi}, tips ${tips}, overtime ${ot}`, () => {
          const people = [person("Alex"), person("Sam", { ...(tips > 0 ? { tips: answered("some" as const), tipsAmount: answered(D(tips)) } : {}), ...(ot > 0 ? { overtime: answered("premium" as const), overtimeAmount: answered(D(ot)) } : {}) })];
          const r = computeSchedule1a(input({ magi: D(magi), people }));
          expect(n(r, "sch1a.1")).toBe(magi);
          expect(n(r, "sch1a.3")).toBe(magi);
          // an independent oracle from the printed rules
          const t4c = round(tips);
          const t7 = Math.min(t4c, 25000);
          const tDed = t4c === 0 ? 0 : magi - 300000 <= 0 ? t7 : Math.max(0, t7 - Math.floor((magi - 300000) / 1000) * 100);
          const o14 = round(ot);
          const o15 = Math.min(o14, 25000);
          const oDed = o14 === 0 ? 0 : magi - 300000 <= 0 ? o15 : Math.max(0, o15 - Math.floor((magi - 300000) / 1000) * 100);
          expect(n(r, "sch1a.13")).toBe(tDed);
          expect(n(r, "sch1a.21")).toBe(oDed);
          expect(n(r, "sch1a.38")).toBe(tDed + oDed);
          // each derived line equals the arithmetic on the PRINTED (rounded) lines above it
          if (t4c > 0) {
            expect(n(r, "sch1a.6")).toBe((n(r, "sch1a.4c") ?? 0) + (n(r, "sch1a.5") ?? 0));
            expect(n(r, "sch1a.7")).toBe(Math.min(n(r, "sch1a.6") ?? 0, 25000));
            if (magi > 300000) {
              expect(n(r, "sch1a.10")).toBe((n(r, "sch1a.8") ?? 0) - (n(r, "sch1a.9") ?? 0));
              expect(n(r, "sch1a.11")).toBe(Math.floor((n(r, "sch1a.10") ?? 0) / 1000));
              expect(n(r, "sch1a.12")).toBe((n(r, "sch1a.11") ?? 0) * 100);
              expect(n(r, "sch1a.13")).toBe(Math.max(0, (n(r, "sch1a.7") ?? 0) - (n(r, "sch1a.12") ?? 0)));
            }
          }
          if (o14 > 0 && magi > 300000) {
            expect(n(r, "sch1a.14c")).toBe((n(r, "sch1a.14a") ?? 0) + (n(r, "sch1a.14b") ?? 0));
            expect(n(r, "sch1a.18")).toBe((n(r, "sch1a.16") ?? 0) - (n(r, "sch1a.17") ?? 0));
            expect(n(r, "sch1a.20")).toBe((n(r, "sch1a.19") ?? 0) * 100);
            expect(n(r, "sch1a.21")).toBe(Math.max(0, (n(r, "sch1a.15") ?? 0) - (n(r, "sch1a.20") ?? 0)));
          }
          expect(n(r, "sch1a.38")).toBe((n(r, "sch1a.13") ?? 0) + (n(r, "sch1a.21") ?? 0) + (n(r, "sch1a.30") ?? 0) + (n(r, "sch1a.37") ?? 0));
        });
      }
    }
  }

  it("seniors and car loan foot too: line 37 = 36a + 36b, 29 = 200 x 28, 30 = 24 - 29, 35 = 6,000 - 34", () => {
    for (const magi of [100000, 150000, 150001, 175000, 199999, 200000, 200001, 200999, 201000, 250000]) {
      const r = computeSchedule1a(
        input({
          magi: D(magi),
          people: [person("Alex", { bornBefore1961: answered(true) }), person("Sam", { bornBefore1961: answered(true) })],
          carLoan: { choice: answered("some"), qualifies: answered(true), interestPaid: answered(D(7000)), deductedElsewhere: answered(D(0)) },
        })
      );
      expect(n(r, "sch1a.37")).toBe((n(r, "sch1a.36a") ?? 0) + (n(r, "sch1a.36b") ?? 0));
      if (magi > 150000) {
        expect(n(r, "sch1a.34")).toBe(Math.round(((n(r, "sch1a.33") ?? 0) * 6) / 100));
        expect(n(r, "sch1a.35")).toBe(Math.max(0, 6000 - (n(r, "sch1a.34") ?? 0)));
      }
      if (magi > 200000) {
        expect(n(r, "sch1a.28")).toBe(Math.ceil((n(r, "sch1a.27") ?? 0) / 1000));
        expect(n(r, "sch1a.29")).toBe((n(r, "sch1a.28") ?? 0) * 200);
        expect(n(r, "sch1a.30")).toBe(Math.max(0, (n(r, "sch1a.24") ?? 0) - (n(r, "sch1a.29") ?? 0)));
      }
      expect(n(r, "sch1a.38")).toBe((n(r, "sch1a.13") ?? 0) + (n(r, "sch1a.21") ?? 0) + (n(r, "sch1a.30") ?? 0) + (n(r, "sch1a.37") ?? 0));
    }
  });
});

describe("Schedule 1-A: blocked inputs block every dependent line, never a 0", () => {
  it("MAGI not computed while tips are claimed: line 1, line 3, line 8 and the deduction wait (missing_input)", () => {
    const r = computeSchedule1a(golden({ magi: null }));
    for (const k of ["sch1a.1", "sch1a.3", "sch1a.8", "sch1a.10", "sch1a.13", "sch1a.38"] as const) {
      expect(st(r, k), k).toBe("missing_input");
      expect(n(r, k), k).toBeNull();
    }
    // the capped amounts that do not need the MAGI are still computed
    expect(n(r, "sch1a.7")).toBe(4546);
    expect(n(r, "sch1a.15")).toBe(2408);
  });

  it("excluded income (Puerto Rico / Form 2555) is a CPA matter on line 3 and everything that copies it", () => {
    const r = computeSchedule1a(golden({ magiExclusionsNone: answered(false) }));
    expect(n(r, "sch1a.1")).toBe(270980); // line 1 is the 1040 line, fine
    expect(st(r, "sch1a.3")).toBe("needs_cpa_judgment");
    expect(st(r, "sch1a.16")).toBe("needs_cpa_judgment");
    expect(st(r, "sch1a.38")).toBe("needs_cpa_judgment");
  });

  it("'not sure' tips block the whole of Part II (4a through 13)", () => {
    const r = computeSchedule1a(input({ people: [person("Alex", { tips: UNSURE }), person("Sam")] }));
    for (const k of ["sch1a.4a", "sch1a.4c", "sch1a.6", "sch1a.7", "sch1a.13"] as const) expect(st(r, k), k).toBe("needs_cpa_judgment");
  });
});
