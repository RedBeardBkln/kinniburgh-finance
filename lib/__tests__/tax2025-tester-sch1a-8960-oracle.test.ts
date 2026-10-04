// Tester oracles for Schedule 1-A and Form 8960 (task ty2025-sch1a-8960-pdfs). Written independently of the Coder's tests, from the printed
// 2025 forms and instructions (Schedule 1-A: Form 1040 instructions pp. 101-110; Form 8960: i8960.pdf Feb 4, 2026), using plain integer math
// (no engine helper, no engine constant).

import { describe, expect, it } from "vitest";
import { answered, MISSING, UNSURE } from "@/lib/tax2025/answer-state";
import { D } from "@/lib/tax2025/money";
import { computeForm8960, type Form8960Input, type Form8960Lead } from "@/lib/tax2025/rules/form-8960";
import { computeSchedule1a, type Sch1aInput, type Sch1aPersonInput } from "@/lib/tax2025/rules/schedule-1a";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

const num = (r: RuleResult, key: LineKey): number | null => {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toNumber();
};
const status = (r: RuleResult, key: LineKey): string => {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.status ?? r.status;
};
const roundHalfUp = (x: number): number => Math.floor(x + 0.5);

// ───────────────────────── Schedule 1-A ─────────────────────────
function person(name: string, over: Partial<Sch1aPersonInput> = {}): Sch1aPersonInput {
  return { name, bornBefore1961: answered(false), validSsn: answered(true), tips: answered("none"), tipsAmount: MISSING, overtime: answered("none"), overtimeAmount: MISSING, ...over };
}
function s1a(over: Partial<Sch1aInput>): Sch1aInput {
  return {
    magi: D(100000),
    magiExclusionsNone: answered(true),
    people: [person("A"), person("B")],
    carLoan: { choice: answered("none"), qualifies: MISSING, interestPaid: MISSING, deductedElsewhere: MISSING },
    tipsEmployers: null,
    scheduleCOwnerTips: answered("none"),
    ...over,
  };
}

/** Oracle straight from the printed form: whole dollars throughout. */
function oracle1a(o: { magi: number; tipsA: number; tipsB: number; otA: number; otB: number; car: number; seniors: number }) {
  const magi = Math.round(o.magi);
  const tips = roundHalfUp(o.tipsA + o.tipsB);
  const l7 = Math.min(tips, 25000);
  const l13 = magi - 300000 <= 0 ? l7 : Math.max(0, l7 - Math.floor((magi - 300000) / 1000) * 100);
  const ot = roundHalfUp(o.otA + o.otB);
  const l15 = Math.min(ot, 25000);
  const l21 = magi - 300000 <= 0 ? l15 : Math.max(0, l15 - Math.floor((magi - 300000) / 1000) * 100);
  const l24 = Math.min(o.car, 10000);
  const l30 = magi - 200000 <= 0 ? l24 : Math.max(0, l24 - Math.ceil((magi - 200000) / 1000) * 200);
  const l35 = magi - 150000 <= 0 ? 6000 : Math.max(0, 6000 - roundHalfUp((magi - 150000) * 0.06));
  const l37 = l35 * o.seniors;
  return { l13: tips === 0 ? 0 : l13, l21: ot === 0 ? 0 : l21, l30: o.car === 0 ? 0 : l30, l37: o.seniors === 0 ? 0 : l37, l38: (tips === 0 ? 0 : l13) + (ot === 0 ? 0 : l21) + (o.car === 0 ? 0 : l30) + (o.seniors === 0 ? 0 : l37) };
}

describe("Tester oracle: Schedule 1-A deductions against an independent hand formula", () => {
  const magis = [0, 74999, 75000, 149999, 150000, 150001, 150999, 151000, 175000, 199999, 200000, 200001, 200999, 201000, 209999, 210000, 299999, 300000, 300001, 300999, 301000, 301001, 325000, 345460, 345999, 346000, 350000, 400000, 1000000];
  const tipsOpts: Array<[number, number]> = [[0, 0], [4545.8, 0], [25000, 0], [20000, 20000], [999.5, 25000.5]];
  const otOpts: Array<[number, number]> = [[0, 0], [2408, 0], [12500, 12500], [30000, 30000]];
  const carOpts = [0, 3333, 10000, 15000];
  const seniorOpts = [0, 1, 2];
  let cases = 0;
  for (const magi of magis) {
    for (const [ta, tb] of tipsOpts) {
      for (const [oa, ob] of otOpts) {
        for (const car of carOpts) {
          for (const seniors of seniorOpts) {
            // thin the grid so the file stays quick but every dimension is crossed with the edge MAGIs
            if ((cases++ * 7) % 11 !== 0 && magi !== 300000 && magi !== 300001 && magi !== 200001 && magi !== 150001) continue;
            it(`MAGI ${magi} tips ${ta}+${tb} OT ${oa}+${ob} car ${car} seniors ${seniors}`, () => {
              const people = [
                person("A", {
                  tips: ta > 0 ? answered("some") : answered("none"),
                  tipsAmount: ta > 0 ? answered(D(ta)) : MISSING,
                  overtime: oa > 0 ? answered("premium") : answered("none"),
                  overtimeAmount: oa > 0 ? answered(D(oa)) : MISSING,
                  bornBefore1961: answered(seniors >= 1),
                }),
                person("B", {
                  tips: tb > 0 ? answered("some") : answered("none"),
                  tipsAmount: tb > 0 ? answered(D(tb)) : MISSING,
                  overtime: ob > 0 ? answered("premium") : answered("none"),
                  overtimeAmount: ob > 0 ? answered(D(ob)) : MISSING,
                  bornBefore1961: answered(seniors >= 2),
                }),
              ];
              const r = computeSchedule1a(
                s1a({
                  magi: D(magi),
                  people,
                  carLoan: car > 0 ? { choice: answered("some"), qualifies: answered(true), interestPaid: answered(D(car)), deductedElsewhere: answered(D(0)) } : { choice: answered("none"), qualifies: MISSING, interestPaid: MISSING, deductedElsewhere: MISSING },
                })
              );
              const o = oracle1a({ magi, tipsA: ta, tipsB: tb, otA: oa, otB: ob, car, seniors });
              expect(num(r, "sch1a.13")).toBe(o.l13);
              expect(num(r, "sch1a.21")).toBe(o.l21);
              expect(num(r, "sch1a.30")).toBe(o.l30);
              expect(num(r, "sch1a.37")).toBe(o.l37);
              expect(num(r, "sch1a.38")).toBe(o.l38);
              expect(status(r, "sch1a.38")).toBe(o.l38 === 0 ? "not_applicable" : "computed");
            });
          }
        }
      }
    }
  }

  it("golden: 4,545.80 tips + 2,408 overtime at MAGI 270,980 = 4,546 / 2,408 / 6,954", () => {
    const r = computeSchedule1a(
      s1a({
        magi: D(270980),
        people: [person("A"), person("B", { tips: answered("some"), tipsAmount: answered(D("4545.80")), overtime: answered("premium"), overtimeAmount: answered(D(2408)) })],
        tipsEmployers: { employersWithBox7: 1, box7Total: D("4545.80") },
      })
    );
    expect([num(r, "sch1a.13"), num(r, "sch1a.21"), num(r, "sch1a.38")]).toEqual([4546, 2408, 6954]);
  });

  it("edge MAGI: 300,000 skips lines 10-12; 300,001 shows line 10 = 1, 11 = 0, 12 = 0, 13 unreduced; 301,000 reduces by 100", () => {
    const mk = (m: number) => computeSchedule1a(s1a({ magi: D(m), people: [person("A", { tips: answered("some"), tipsAmount: answered(D(5000)) }), person("B")], tipsEmployers: { employersWithBox7: 1, box7Total: D(5000) } }));
    const a = mk(300000);
    expect(status(a, "sch1a.10")).toBe("not_applicable");
    expect(num(a, "sch1a.13")).toBe(5000);
    const b = mk(300001);
    expect([num(b, "sch1a.10"), num(b, "sch1a.11"), num(b, "sch1a.12"), num(b, "sch1a.13")]).toEqual([1, 0, 0, 5000]);
    const c = mk(301000);
    expect([num(c, "sch1a.10"), num(c, "sch1a.11"), num(c, "sch1a.12"), num(c, "sch1a.13")]).toEqual([1000, 1, 100, 4900]);
  });

  it("combined limits: both spouses' tips share ONE 25,000 cap, both spouses' overtime share ONE 25,000 cap", () => {
    const r = computeSchedule1a(
      s1a({
        magi: D(100000),
        people: [
          person("A", { tips: answered("some"), tipsAmount: answered(D(20000)), overtime: answered("premium"), overtimeAmount: answered(D(20000)) }),
          person("B", { tips: answered("some"), tipsAmount: answered(D(20000)), overtime: answered("premium"), overtimeAmount: answered(D(20000)) }),
        ],
      })
    );
    expect([num(r, "sch1a.7"), num(r, "sch1a.13"), num(r, "sch1a.15"), num(r, "sch1a.21")]).toEqual([25000, 25000, 25000, 25000]);
  });

  it("senior deduction: $6,000 each, 6% above 150,000: MAGI 200,000 -> 6,000 - 3,000 = 3,000 each; two seniors = 6,000; MAGI 250,000 -> 0", () => {
    const sen = (m: number, n: 1 | 2) =>
      computeSchedule1a(s1a({ magi: D(m), people: [person("A", { bornBefore1961: answered(true) }), person("B", { bornBefore1961: answered(n === 2) })] }));
    expect([num(sen(200000, 1), "sch1a.35"), num(sen(200000, 1), "sch1a.37")]).toEqual([3000, 3000]);
    expect(num(sen(200000, 2), "sch1a.37")).toBe(6000);
    expect(num(sen(250000, 2), "sch1a.35")).toBe(0);
    expect(num(sen(150000, 2), "sch1a.37")).toBe(12000);
  });

  it("an invalid SSN removes that person's tips, overtime and senior amount", () => {
    const r = computeSchedule1a(
      s1a({
        people: [person("A", { validSsn: answered(false), tips: answered("some"), tipsAmount: answered(D(3000)), overtime: answered("premium"), overtimeAmount: answered(D(1000)), bornBefore1961: answered(true) }), person("B")],
      })
    );
    expect(num(r, "sch1a.38")).toBe(0);
  });

  it("every unanswered / unsure / ask-employer input blocks line 38 (never a silent 0)", () => {
    const blocked = (over: Partial<Sch1aInput>) => {
      const r = computeSchedule1a(s1a(over));
      expect(num(r, "sch1a.38")).toBeNull();
      expect(["missing_input", "needs_cpa_judgment"]).toContain(status(r, "sch1a.38"));
    };
    blocked({ people: [person("A", { tips: MISSING }), person("B")] });
    blocked({ people: [person("A", { tips: UNSURE }), person("B")] });
    blocked({ people: [person("A", { tips: answered("ask_employer") }), person("B")] });
    blocked({ people: [person("A", { tips: answered("some"), tipsAmount: MISSING }), person("B")] });
    blocked({ people: [person("A", { overtime: MISSING }), person("B")] });
    blocked({ people: [person("A", { overtime: answered("total"), overtimeAmount: UNSURE }), person("B")] });
    blocked({ people: [person("A", { bornBefore1961: MISSING }), person("B")] });
    blocked({ people: [person("A", { bornBefore1961: answered(true), validSsn: UNSURE }), person("B")] });
    blocked({ carLoan: { choice: MISSING, qualifies: MISSING, interestPaid: MISSING, deductedElsewhere: MISSING } });
    blocked({ carLoan: { choice: answered("some"), qualifies: answered(true), interestPaid: MISSING, deductedElsewhere: answered(D(0)) } });
    blocked({ magi: null, people: [person("A", { tips: answered("some"), tipsAmount: answered(D(100)) }), person("B")] });
    blocked({ magiExclusionsNone: UNSURE, people: [person("A", { tips: answered("some"), tipsAmount: answered(D(100)) }), person("B")] });
    blocked({ magiExclusionsNone: answered(false), people: [person("A", { tips: answered("some"), tipsAmount: answered(D(100)) }), person("B")] });
  });

  it("overtime 'total' is divided by three; 'premium' is taken as stated", () => {
    const a = computeSchedule1a(s1a({ people: [person("A", { overtime: answered("total"), overtimeAmount: answered(D(7224)) }), person("B")] }));
    expect(num(a, "sch1a.14a")).toBe(2408);
    const b = computeSchedule1a(s1a({ people: [person("A", { overtime: answered("premium"), overtimeAmount: answered(D(7224)) }), person("B")] }));
    expect(num(b, "sch1a.14a")).toBe(7224);
  });

  it("line 4a/4b: two W-2s with box 7 -> blank (not_yet_computed), 4c keeps the owner's total; no W-2 box 7 -> same", () => {
    const base = { magi: D(100000), people: [person("A", { tips: answered("some"), tipsAmount: answered(D(4000)) }), person("B")] };
    const two = computeSchedule1a(s1a({ ...base, tipsEmployers: { employersWithBox7: 2, box7Total: D(4000) } }));
    expect([num(two, "sch1a.4a"), status(two, "sch1a.4a"), num(two, "sch1a.4c")]).toEqual([null, "not_yet_computed", 4000]);
    const none = computeSchedule1a(s1a({ ...base, tipsEmployers: { employersWithBox7: 0, box7Total: D(0) } }));
    expect([num(none, "sch1a.4a"), status(none, "sch1a.4a")]).toEqual([null, "not_yet_computed"]);
    const mismatch = computeSchedule1a(s1a({ ...base, tipsEmployers: { employersWithBox7: 1, box7Total: D(3999) } }));
    expect(status(mismatch, "sch1a.4a")).toBe("not_yet_computed");
  });

  it("line 5: Schedule C owner states 'some' / not sure / missing / no owner -> blocked, never 0", () => {
    for (const st of [answered("some" as const), answered("ask_employer" as const), UNSURE, MISSING, null]) {
      const r = computeSchedule1a(s1a({ people: [person("A", { tips: answered("some"), tipsAmount: answered(D(4000)) }), person("B")], tipsEmployers: { employersWithBox7: 1, box7Total: D(4000) }, scheduleCOwnerTips: st }));
      expect(num(r, "sch1a.5")).toBeNull();
      expect(num(r, "sch1a.38")).toBeNull();
    }
  });
});

// ───────────────────────── Form 8960 ─────────────────────────
const lead = (n: number | null): Form8960Lead => ({ amount: n === null ? null : D(n), status: n === null ? "missing_input" : "computed" });
function f8960(over: Partial<Form8960Input> = {}): Form8960Input {
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
    itemizing: true,
    itemizingStatus: undefined,
    statedNoCapitalOther: true,
    niitOther: true,
    otherInvestmentIncomePresent: false,
    ...over,
  };
}

function oracle8960(o: { agi: number; interest: number; div: number; schC: number; gain: number; itemizing: boolean; stateTax: number; invInt?: number }) {
  const l1 = o.interest;
  const l2 = o.div;
  const l4a = o.schC;
  const l4b = -o.schC; // nonpassive
  const l5a = o.gain;
  const l8 = l1 + l2 + (l4a + l4b) + l5a;
  const l9a = o.itemizing ? (o.invInt ?? 0) : 0;
  const l9b = o.itemizing && l8 > 0 && o.agi > 0 ? roundHalfUp((o.stateTax * Math.min(l8, o.agi)) / o.agi) : 0;
  const l11 = l9a + l9b;
  const l12 = Math.max(0, l8 - l11);
  const l15 = Math.max(0, o.agi - 250000);
  const l16 = Math.min(l12, l15);
  const l17 = roundHalfUp(l16 * 0.038);
  return { l8, l9b, l11, l12, l15, l16, l17 };
}

describe("Tester oracle: Form 8960 lines 1-17 against a hand formula (MFJ)", () => {
  const agis = [-5000, 0, 100000, 249999, 250000, 250001, 250100, 270980, 300000, 1000000];
  const interests = [0, 1138, 25000];
  const gains = [-3000, 0, 5557, 80000];
  const schCs = [-9010, 0, 40000];
  for (const agi of agis) {
    for (const interest of interests) {
      for (const gain of gains) {
        for (const schC of schCs) {
          for (const itemizing of [false, true]) {
            it(`AGI ${agi} int ${interest} 7a ${gain} SchC ${schC} ${itemizing ? "itemized" : "standard"}`, () => {
              const r = computeForm8960(f8960({ agi: lead(agi), interest: lead(interest), gain7a: lead(gain), sch1Line3: lead(schC), itemizing }));
              const o = oracle8960({ agi, interest, div: 4, schC, gain, itemizing, stateTax: 15591 });
              expect(num(r, "f8960.8")).toBe(o.l8);
              expect(num(r, "f8960.9b")).toBe(o.l9b);
              expect(num(r, "f8960.11")).toBe(o.l11);
              expect(num(r, "f8960.nii")).toBe(o.l12);
              expect(num(r, "f8960.15")).toBe(o.l15);
              expect(num(r, "f8960.16")).toBe(o.l16);
              expect(num(r, "f8960.niit")).toBe(o.l17);
              expect(num(r, "sch2.12")).toBe(o.l17);
              expect(r.lines.every((l) => l.status !== undefined || r.status)).toBe(true);
            });
          }
        }
      }
    }
  }

  it("golden: no allocation -> 12 = 6,699, 17 = 255; allocation -> 9b 385, 12 = 6,314, 17 = 240", () => {
    const std = computeForm8960(f8960({ itemizing: false }));
    expect([num(std, "f8960.8"), num(std, "f8960.nii"), num(std, "f8960.niit")]).toEqual([6699, 6699, 255]);
    const it_ = computeForm8960(f8960({ itemizing: true }));
    expect([num(it_, "f8960.9b"), num(it_, "f8960.nii"), num(it_, "f8960.niit")]).toEqual([385, 6314, 240]);
  });

  it("threshold edges: 250,000 -> 15 = 0, 17 = 0, nothing blocks; 250,001 -> 15 = 1, 17 = 0", () => {
    const a = computeForm8960(f8960({ agi: lead(250000), niitOther: undefined }));
    expect([num(a, "f8960.15"), num(a, "f8960.niit"), num(a, "sch2.12")]).toEqual([0, 0, 0]);
    expect(a.lines.filter((l) => l.amount === null)).toEqual([]);
    expect(a.conclusion).toBe("ineligible");
    const b = computeForm8960(f8960({ agi: lead(250001) }));
    expect([num(b, "f8960.15"), num(b, "f8960.niit")]).toEqual([1, 0]);
    expect(b.conclusion).toBe("eligible");
  });

  it("capital loss limited to -3,000: interest 1,000 + dividends 500 - 3,000 = -1,500 -> line 12 = 0, NIIT 0", () => {
    const r = computeForm8960(f8960({ interest: lead(1000), dividends: lead(500), gain7a: lead(-3000), sch1Line3: lead(0), agi: lead(400000) }));
    expect([num(r, "f8960.5a"), num(r, "f8960.8"), num(r, "f8960.nii"), num(r, "f8960.niit")]).toEqual([-3000, -1500, 0, 0]);
    expect(num(r, "f8960.9b")).toBe(0); // base <= 0: nothing allocated
  });

  it("SALT cap binding (5e < 5d) -> 9b needs_cpa_judgment and the NIIT / Schedule 2 line 12 are blocked when over the threshold", () => {
    const r = computeForm8960(f8960({ schA5d: lead(45000), schA5e: lead(40000) }));
    expect(status(r, "f8960.9b")).toBe("needs_cpa_judgment");
    expect(num(r, "f8960.niit")).toBeNull();
    expect(num(r, "sch2.12")).toBeNull();
  });

  it("Schedule C loss is non-passive (4b reverses it); positive profit too; Schedule 1 line 5 or 6 non-zero -> 4b to the CPA", () => {
    const loss = computeForm8960(f8960());
    expect([num(loss, "f8960.4a"), num(loss, "f8960.4b"), num(loss, "f8960.4c")]).toEqual([-9010, 9010, 0]);
    const gain = computeForm8960(f8960({ sch1Line3: lead(40000) }));
    expect([num(gain, "f8960.4a"), num(gain, "f8960.4b"), num(gain, "f8960.4c")]).toEqual([40000, -40000, 0]);
    for (const k of ["sch1Line5", "sch1Line6"] as const) {
      const r = computeForm8960(f8960({ [k]: lead(1200) }));
      expect(status(r, "f8960.4b")).toBe("needs_cpa_judgment");
      expect(num(r, "f8960.niit")).toBeNull();
    }
  });

  it("line 5c / 5b: Schedule 1 line 4 or line 5 non-zero, or capital-other not stated -> not a silent 0", () => {
    expect(status(computeForm8960(f8960({ sch1Line4: lead(500) })), "f8960.5b")).toBe("needs_cpa_judgment");
    expect(status(computeForm8960(f8960({ sch1Line5: lead(500) })), "f8960.5c")).toBe("needs_cpa_judgment");
    expect(status(computeForm8960(f8960({ statedNoCapitalOther: undefined })), "f8960.5b")).toBe("missing_input");
    expect(status(computeForm8960(f8960({ statedNoCapitalOther: undefined })), "f8960.5c")).toBe("missing_input");
    expect(status(computeForm8960(f8960({ statedNoCapitalOther: false })), "f8960.5c")).toBe("needs_cpa_judgment");
  });

  it("line 3: 1040 line 5b non-zero -> CPA; line 5b pensions blocked -> blocked", () => {
    expect(status(computeForm8960(f8960({ pensions: lead(1000) })), "f8960.3")).toBe("needs_cpa_judgment");
    expect(num(computeForm8960(f8960({ pensions: lead(null) })), "f8960.niit")).toBeNull();
  });

  it("niit_other: unanswered -> 6/7/10 missing_input and NIIT blocked (over); 'Yes' -> needs_cpa_judgment; under threshold -> nothing blocks", () => {
    const u = computeForm8960(f8960({ niitOther: undefined }));
    for (const k of ["f8960.6", "f8960.7", "f8960.10"] as const) expect(status(u, k)).toBe("missing_input");
    expect(num(u, "f8960.niit")).toBeNull();
    expect(status(u, "f8960.niit")).toBe("missing_input");
    const y = computeForm8960(f8960({ niitOther: false }));
    for (const k of ["f8960.6", "f8960.7", "f8960.10"] as const) expect(status(y, k)).toBe("needs_cpa_judgment");
    expect(status(y, "f8960.niit")).toBe("needs_cpa_judgment");
    const under = computeForm8960(f8960({ niitOther: undefined, agi: lead(200000) }));
    expect(under.lines.filter((l) => l.amount === null)).toEqual([]);
  });

  it("MAGI exclusions Yes / unsure -> line 13 blocked (needs_cpa_judgment); unanswered is read as none", () => {
    expect(status(computeForm8960(f8960({ magiExclusionsNone: answered(false) })), "f8960.13")).toBe("needs_cpa_judgment");
    expect(status(computeForm8960(f8960({ magiExclusionsNone: UNSURE })), "f8960.13")).toBe("needs_cpa_judgment");
    expect(num(computeForm8960(f8960({ magiExclusionsNone: MISSING })), "f8960.13")).toBe(270980);
  });

  it("other investment income present over the threshold -> 5a / 8 / 12 / 16 / 17 / sch2.12 needs_cpa_judgment; under threshold -> nothing blocks", () => {
    const r = computeForm8960(f8960({ otherInvestmentIncomePresent: true }));
    for (const k of ["f8960.5a", "f8960.8", "f8960.nii", "f8960.16", "f8960.niit", "sch2.12"] as const) expect(status(r, k), k).toBe("needs_cpa_judgment");
    const u = computeForm8960(f8960({ otherInvestmentIncomePresent: true, agi: lead(100000) }));
    expect(u.lines.filter((l) => l.amount === null)).toEqual([]);
  });

  it("AGI blocked -> everything that depends on it is blocked, nothing is zero", () => {
    const r = computeForm8960(f8960({ agi: lead(null) }));
    for (const k of ["f8960.13", "f8960.15", "f8960.16", "f8960.niit", "sch2.12"] as const) expect(num(r, k), k).toBeNull();
  });

  it("itemizing undecided -> 9a/9b blocked, never 0", () => {
    const r = computeForm8960(f8960({ itemizing: null }));
    expect(num(r, "f8960.9a")).toBeNull();
    expect(num(r, "f8960.9b")).toBeNull();
    expect(num(r, "f8960.niit")).toBeNull();
  });

  it("line 9b allocation never exceeds the state income tax (ratio capped at 1) and AGI <= 0 gives 0", () => {
    const r = computeForm8960(f8960({ agi: lead(251000), interest: lead(900000), schA5a: lead(12000), schA5d: lead(12000), schA5e: lead(12000), sch1Line3: lead(0) }));
    expect(num(r, "f8960.9b")).toBe(12000);
    expect(num(r, "f8960.nii")).toBeGreaterThanOrEqual(0);
  });
});

// ───────────────────────── LINE_FLOW completeness (dynamic) ─────────────────────────
// A rule line that CHANGES when an input line changes must be downstream of that input in LINE_FLOW (CPA overrides use it to flag stale
// overrides; the plan says over-flagging is the safe failure, under-flagging is the defect).
import { downstreamOf } from "@/lib/tax2025/line-flow";

describe("Tester: LINE_FLOW covers every Form 8960 / Schedule 1-A line that actually depends on an input line", () => {
  const sig = (r: RuleResult) => new Map(r.lines.map((l) => [l.key, `${l.status}:${l.amount === null ? "null" : l.amount.toString()}`]));
  const leadMap: Array<[keyof Form8960Input, LineKey]> = [
    ["agi", "f1040.11a"],
    ["interest", "f1040.2b"],
    ["dividends", "f1040.3b"],
    ["pensions", "f1040.5b"],
    ["gain7a", "f1040.7a"],
    ["sch1Line3", "sch1.3"],
    ["sch1Line4", "sch1.4"],
    ["sch1Line5", "sch1.5"],
    ["sch1Line6", "sch1.6"],
    ["schA5a", "scha.5a"],
    ["schA5d", "scha.5d"],
    ["schA5e", "scha.5e"],
    ["schA9", "scha.9"],
  ];
  const bases: Array<Partial<Form8960Input>> = [{}, { itemizing: false }, { agi: lead(100000) }, { sch1Line3: lead(30000) }, { schA9: lead(300), schA5d: lead(30000), schA5e: lead(30000) }];
  const values = [0, 1200, -500, 90000, null];

  // (was a defect probe, 03-test-report.md D1: LINE_FLOW missed sch1.5 -> f8960.5c / 5d and scha.17 / std.total -> f8960.9a; fixed)
  it("Form 8960: every changed line is downstream of the perturbed input", () => {
    const gaps = new Set<string>();
    for (const [field, key] of leadMap) {
      const allowed = new Set<string>([key, ...downstreamOf(key)]);
      for (const base of bases) {
        const before = sig(computeForm8960(f8960(base)));
        for (const v of values) {
          const after = sig(computeForm8960(f8960({ ...base, [field]: lead(v) })));
          for (const [k, s] of after) if (before.get(k) !== s && !allowed.has(k)) gaps.add(`${key} -> ${k}`);
        }
      }
    }
    for (const base of bases) {
      const before = sig(computeForm8960(f8960({ ...base, itemizing: true })));
      const after = sig(computeForm8960(f8960({ ...base, itemizing: false })));
      const allowed = new Set<string>([...downstreamOf("scha.17"), ...downstreamOf("std.total"), "scha.17", "std.total"]);
      for (const [k, s] of after) if (before.get(k) !== s && !allowed.has(k)) gaps.add(`itemizing -> ${k}`);
    }
    expect([...gaps].sort()).toEqual([]);
  });

  it("Schedule 1-A: every changed line is downstream of f1040.11b when MAGI changes", () => {
    const allowed = new Set<string>(["f1040.11b", ...downstreamOf("f1040.11b")]);
    const people = [person("A", { tips: answered("some"), tipsAmount: answered(D(4000)), overtime: answered("premium"), overtimeAmount: answered(D(2000)), bornBefore1961: answered(true) }), person("B")];
    const car = { choice: answered("some" as const), qualifies: answered(true), interestPaid: answered(D(5000)), deductedElsewhere: answered(D(0)) };
    const gaps = new Set<string>();
    for (const m of [100000, 160000, 250000, 310000, 400000]) {
      const before = sig(computeSchedule1a(s1a({ people, carLoan: car, magi: D(m), tipsEmployers: { employersWithBox7: 1, box7Total: D(4000) } })));
      for (const m2 of [0, 149000, 205000, 301500, 500000, 2000000]) {
        const after = sig(computeSchedule1a(s1a({ people, carLoan: car, magi: D(m2), tipsEmployers: { employersWithBox7: 1, box7Total: D(4000) } })));
        for (const [k, s] of after) if (before.get(k) !== s && !allowed.has(k)) gaps.add(k);
      }
    }
    expect([...gaps]).toEqual([]);
  });
});

// ───────────────────────── whole-return fuzz ─────────────────────────
import { computeTy2025Return } from "@/lib/tax2025/return";
import { fullFacts1b, owner } from "./tax2025-fixtures";
import type { Ty2025Return } from "@/lib/tax2025/types";

describe("Tester: whole-return fuzz of Schedule 1-A / Form 8960 (footing, no silent zero, Schedule 2 line 12 flow)", () => {
  let seed = 20251004;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const SCH1A = ["1", "3", "4a", "4b", "4c", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14a", "14b", "14c", "15", "16", "17", "18", "19", "20", "21", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36a", "36b", "37", "38"].map((x) => `sch1a.${x}` as LineKey);
  const F8960 = ["1", "2", "3", "4a", "4b", "4c", "5a", "5b", "5c", "5d", "6", "7", "8", "9a", "9b", "9c", "9d", "10", "11", "nii", "13", "14", "15", "16", "niit"].map((x) => `f8960.${x}` as LineKey);
  const amt = (r: Ty2025Return, k: LineKey): number | null => r.lines[k]?.amount ?? null;
  const g = (r: Ty2025Return, k: LineKey): number => amt(r, k) ?? 0;

  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    it(`random return #${i}`, () => {
      const f = fullFacts1b();
      f.income.w2s[0]!.wagesCents = pick([1_000_000, 15_000_000, 19_000_000, 24_000_000, 30_000_000, 36_000_000, 45_000_000]);
      f.income.w2s[0]!.socialSecurityWagesCents = Math.min(f.income.w2s[0]!.wagesCents, 17_610_000);
      f.income.w2s[0]!.medicareWagesCents = f.income.w2s[0]!.wagesCents;
      f.deductions.mortgages[0]!.interestCents = pick([100_000, 4_000_000]);
      const st = pick(["u", "t", "f"] as const);
      if (st === "u") delete f.statedNone.niit_other;
      else f.statedNone.niit_other = owner(st === "t");
      const ra = f.returnAnswers;
      ra.magiExclusionsNone = pick([owner(true), owner(true), owner(false)]);
      ra.people.forEach((p, idx) => {
        p.validSsn = owner(true);
        p.tipsChoice = pick([owner("none" as const), owner("some" as const), owner("some" as const), owner("some" as const), owner("ask_employer" as const)].slice(0, 4 + (rnd() < 0.15 ? 1 : 0)));
        p.tipsCents = owner(pick([0, 99_950, 454_580, 2_500_000, 3_000_000]));
        p.overtimeChoice = pick([owner("none" as const), owner("premium" as const), owner("total" as const)]);
        p.overtimeCents = owner(pick([0, 240_800, 1_250_000, 4_000_000]));
        p.bornBefore1961 = owner(idx === 0 ? pick([true, false]) : pick([true, false, false]));
      });
      ra.carLoan.choice = pick([owner("none" as const), owner("none" as const), owner("some" as const)]);
      if (ra.carLoan.choice.value === "some") {
        ra.carLoan.qualifies = owner(true);
        ra.carLoan.interestPaidCents = owner(pick([300_000, 1_500_000]));
        ra.carLoan.deductedElsewhereCents = owner(0);
      }
      const r = computeTy2025Return(f, {});
      seen.add(`niit:${r.lines["f8960.niit"]?.status}`);
      seen.add(`s1a38:${r.lines["sch1a.38"]?.status}`);
      if ((amt(r, "f8960.niit") ?? 0) > 0) seen.add("niit>0");
      if ((amt(r, "sch1a.12") ?? 0) > 0) seen.add("tips-reduced");
      if ((amt(r, "sch1a.29") ?? 0) > 0) seen.add("car-reduced");
      if ((amt(r, "sch1a.34") ?? 0) > 0) seen.add("senior-reduced");
      // every line has an explicit status; an amount iff computed / not_applicable
      for (const k of [...SCH1A, ...F8960, "sch2.12" as LineKey]) {
        const l = r.lines[k];
        expect(l, k).toBeDefined();
        const hasAmount = l!.amount !== null && l!.amount !== undefined;
        expect(hasAmount, `${k} ${l!.status}`).toBe(l!.status === "computed" || l!.status === "not_applicable");
        if (hasAmount) expect(Number.isInteger(l!.amount), k).toBe(true);
      }
      // Schedule 2 line 12 = Form 8960 line 17
      expect(r.lines["sch2.12"]?.amount ?? null).toBe(r.lines["f8960.niit"]?.amount ?? null);
      expect(r.lines["sch2.12"]?.status).toBe(r.lines["f8960.niit"]?.status);
      // Form 8960 footing when line 17 is computed
      if (r.lines["f8960.niit"]?.status === "computed") {
        expect(g(r, "f8960.4c")).toBe(g(r, "f8960.4a") + g(r, "f8960.4b"));
        expect(g(r, "f8960.5d")).toBe(g(r, "f8960.5a") + g(r, "f8960.5b") + g(r, "f8960.5c"));
        expect(g(r, "f8960.8")).toBe(g(r, "f8960.1") + g(r, "f8960.2") + g(r, "f8960.3") + g(r, "f8960.4c") + g(r, "f8960.5d") + g(r, "f8960.6") + g(r, "f8960.7"));
        expect(g(r, "f8960.9d")).toBe(g(r, "f8960.9a") + g(r, "f8960.9b") + g(r, "f8960.9c"));
        expect(g(r, "f8960.11")).toBe(g(r, "f8960.9d") + g(r, "f8960.10"));
        expect(g(r, "f8960.nii")).toBe(Math.max(0, g(r, "f8960.8") - g(r, "f8960.11")));
        expect(g(r, "f8960.15")).toBe(Math.max(0, g(r, "f8960.13") - 250000));
        expect(g(r, "f8960.16")).toBe(Math.min(g(r, "f8960.nii"), g(r, "f8960.15")));
        expect(g(r, "f8960.niit")).toBe(roundHalfUp(g(r, "f8960.16") * 0.038));
        expect(g(r, "f8960.13")).toBe(g(r, "f1040.11a"));
        // MAGI not over the threshold => no tax and nothing blocked
        if (g(r, "f8960.13") <= 250000) expect(g(r, "f8960.niit")).toBe(0);
      }
      // Schedule 1-A footing when line 38 is computed
      if (r.lines["sch1a.38"]?.status === "computed" || r.lines["sch1a.38"]?.status === "not_applicable") {
        expect(g(r, "sch1a.38")).toBe(g(r, "sch1a.13") + g(r, "sch1a.21") + g(r, "sch1a.30") + g(r, "sch1a.37"));
        expect(amt(r, "f1040.13b")).toBe(amt(r, "sch1a.38"));
        expect(g(r, "sch1a.13")).toBeLessThanOrEqual(25000);
        expect(g(r, "sch1a.21")).toBeLessThanOrEqual(25000);
        expect(g(r, "sch1a.30")).toBeLessThanOrEqual(10000);
        const magi = g(r, "sch1a.3");
        const oracle = (cap: number, start: number, per: number, up: boolean) => (magi - start <= 0 ? cap : Math.max(0, cap - (up ? Math.ceil((magi - start) / 1000) : Math.floor((magi - start) / 1000)) * per));
        if (g(r, "sch1a.6") > 0) expect(g(r, "sch1a.13")).toBe(oracle(Math.min(g(r, "sch1a.6"), 25000), 300000, 100, false));
        if (g(r, "sch1a.14c") > 0) expect(g(r, "sch1a.21")).toBe(oracle(Math.min(g(r, "sch1a.14c"), 25000), 300000, 100, false));
        if (g(r, "sch1a.24") > 0) expect(g(r, "sch1a.30")).toBe(oracle(Math.min(g(r, "sch1a.24"), 10000), 200000, 200, true));
        if (g(r, "sch1a.35") > 0 || g(r, "sch1a.37") > 0) {
          const l35 = magi - 150000 <= 0 ? 6000 : Math.max(0, 6000 - roundHalfUp((magi - 150000) * 0.06));
          expect(g(r, "sch1a.35")).toBe(l35);
        }
      }
      // forms-required verdict agrees with the printed lines
      const fr = r.formsRequired.f8960;
      if (fr && (r.lines["f8960.15"]?.amount ?? null) !== null && (r.lines["f8960.8"]?.amount ?? null) !== null) {
        expect(fr.required).toBe(g(r, "f8960.15") > 0 && g(r, "f8960.8") > 0);
      }
    });
  }
  it("the fuzz reached every branch it claims to cover", () => {
    for (const k of ["niit:computed", "niit:missing_input", "niit:needs_cpa_judgment", "niit>0", "s1a38:computed", "tips-reduced", "car-reduced", "senior-reduced"]) expect(seen.has(k), k + " in " + [...seen].join(",")).toBe(true);
  });
});

describe("Tester: plan criterion 10 reachability", () => {
  it("downstreamOf(f1040.2b) reaches f8960.niit and sch2.12 and f1040.23; downstreamOf(sch1a.4a) reaches sch1a.38 and f1040.13b", () => {
    const a = downstreamOf("f1040.2b");
    for (const k of ["f8960.1", "f8960.8", "f8960.nii", "f8960.niit", "sch2.12", "f1040.23"] as LineKey[]) expect(a, k).toContain(k);
    const b = downstreamOf("sch1a.4a");
    for (const k of ["sch1a.4c", "sch1a.7", "sch1a.13", "sch1a.38", "f1040.13b"] as LineKey[]) expect(b, k).toContain(k);
    const c = downstreamOf("f1040.11a");
    for (const k of ["sch1a.1", "sch1a.38", "f8960.13", "f8960.niit"] as LineKey[]) expect(c, k).toContain(k);
  });
});
