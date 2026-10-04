import { describe, expect, it } from "vitest";
import { answered, MISSING, UNSURE } from "@/lib/tax2025/answer-state";
import { D } from "@/lib/tax2025/money";
import { computeHsa8889, type HsaPersonInput } from "@/lib/tax2025/rules/hsa-8889";
import { computeIraDeduction, type IraPersonInput } from "@/lib/tax2025/rules/ira-deduction";
import { computeSaversCredit, type SaverInput } from "@/lib/tax2025/rules/saver-8880";
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

// ── Form 8889 ────────────────────────────────────────────────────────────────
// 2025 Form 8889 and instructions: line 3 limit 4,300 self-only / 8,550 family (+1,000 age 55+: on line 3 for
// self-only, on line 7 for married family coverage); line 12 = 8 - employer contributions (W-2 box 12 W);
// line 13 = smaller of line 2 and line 12; months / 12 unless eligible on December 1 (last-month rule).

function hsaPerson(slot: "a" | "b", name: string, over: Partial<HsaPersonInput> = {}): HsaPersonInput {
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
function covered(over: Partial<HsaPersonInput> = {}): Partial<HsaPersonInput> {
  return {
    coverage: answered("family"),
    monthsEligible: answered(12),
    eligibleDec1: answered(true),
    medicareOrDependent: answered(false),
    age55Plus: answered(false),
    directContributions: answered(D(0)),
    employerOtherYear: answered(false),
    ...over,
  };
}

describe("computeHsa8889", () => {
  it("neither spouse has HDHP coverage: a not_applicable zero for Schedule 1 line 13, with the reason", () => {
    const r = computeHsa8889({ people: [hsaPerson("a", "Eric"), hsaPerson("b", "Eva")] });
    expect(r.status).toBe("not_applicable");
    expect(amt(r, "sch1.13")).toBe("0");
    expect(r.lines.find((l) => l.key === "sch1.13")?.reason).toContain("Neither spouse");
    expect(st(r, "f8889a.13")).toBe("not_applicable");
  });

  it("family coverage all year, Eric alone has an HSA: limit 8,550 - employer 2,000 = 6,550; direct 3,000 -> deduction 3,000", () => {
    const r = computeHsa8889({ people: [hsaPerson("a", "Eric", covered({ directContributions: answered(D(3000)), employerContributionsW2: D(2000) })), hsaPerson("b", "Eva")] });
    expect(r.status).toBe("computed");
    expect(amt(r, "f8889a.3")).toBe("8550");
    expect(amt(r, "f8889a.8")).toBe("8550");
    expect(amt(r, "f8889a.9")).toBe("2000");
    expect(amt(r, "f8889a.12")).toBe("6550");
    expect(amt(r, "f8889a.13")).toBe("3000");
    expect(amt(r, "sch1.13")).toBe("3000");
  });

  it("contributions above the limit are an excess (Form 5329): needs_cpa_judgment, not capped silently", () => {
    const r = computeHsa8889({ people: [hsaPerson("a", "Eric", covered({ directContributions: answered(D(7000)), employerContributionsW2: D(2000) })), hsaPerson("b", "Eva")] });
    expect(st(r, "sch1.13")).toBe("needs_cpa_judgment");
    expect(amt(r, "sch1.13")).toBeNull();
  });

  it("self-only, age 55+: 4,300 + 1,000 = 5,300 on line 3", () => {
    const r = computeHsa8889({
      people: [hsaPerson("a", "Eric", covered({ coverage: answered("self_only"), age55Plus: answered(true), directContributions: answered(D(5300)) })), hsaPerson("b", "Eva")],
    });
    expect(amt(r, "f8889a.3")).toBe("5300");
    expect(amt(r, "f8889a.13")).toBe("5300");
  });

  it("family coverage with both spouses holding an HSA: the 8,550 is split equally (4,275), age 55+ adds 1,000 on line 7", () => {
    const r = computeHsa8889({
      people: [
        hsaPerson("a", "Eric", covered({ age55Plus: answered(true), directContributions: answered(D(5275)) })),
        hsaPerson("b", "Eva", covered({ directContributions: answered(D(4275)) })),
      ],
    });
    expect(amt(r, "f8889a.8")).toBe("5275");
    expect(amt(r, "f8889a.13")).toBe("5275");
    expect(amt(r, "f8889b.8")).toBe("4275");
    expect(amt(r, "sch1.13")).toBe("9550");
  });

  it("a spouse with self-only coverage is treated as family when the other spouse has a family plan", () => {
    const r = computeHsa8889({
      people: [hsaPerson("a", "Eric", covered({ coverage: answered("family"), directContributions: answered(D(1000)) })), hsaPerson("b", "Eva", covered({ coverage: answered("self_only"), directContributions: answered(D(1000)) }))],
    });
    expect(amt(r, "f8889b.3")).toBe("8550");
    expect(amt(r, "f8889b.8")).toBe("4275");
  });

  it("not covered on December 1 and 6 months: 4,300 x 6 / 12 = 2,150; covered on December 1 (last-month rule): the full 4,300", () => {
    const part = computeHsa8889({ people: [hsaPerson("a", "Eric", covered({ coverage: answered("self_only"), monthsEligible: answered(6), eligibleDec1: answered(false), directContributions: answered(D(5000)) })), hsaPerson("b", "Eva")] });
    expect(amt(part, "f8889a.3")).toBe("2150");
    expect(st(part, "sch1.13")).toBe("needs_cpa_judgment"); // 5,000 exceeds the 2,150 limit
    const dec1 = computeHsa8889({ people: [hsaPerson("a", "Eric", covered({ coverage: answered("self_only"), monthsEligible: answered(6), eligibleDec1: answered(true), directContributions: answered(D(4000)) })), hsaPerson("b", "Eva")] });
    expect(amt(dec1, "f8889a.3")).toBe("4300");
    expect(amt(dec1, "f8889a.13")).toBe("4000");
    expect(dec1.reasons.join(" ")).toContain("last-month rule");
  });

  it("changed coverage, Medicare / dependent months, other-year employer money, distributions, W-2 code W without coverage: all CPA matters", () => {
    const one = (over: Partial<HsaPersonInput>) => computeHsa8889({ people: [hsaPerson("a", "Eric", over), hsaPerson("b", "Eva")] });
    expect(st(one({ coverage: answered("changed") }), "sch1.13")).toBe("needs_cpa_judgment");
    expect(st(one(covered({ medicareOrDependent: answered(true) })), "sch1.13")).toBe("needs_cpa_judgment");
    expect(st(one(covered({ employerOtherYear: answered(true) })), "sch1.13")).toBe("needs_cpa_judgment");
    expect(st(one({ distributions: answered("some") }), "sch1.13")).toBe("needs_cpa_judgment");
    expect(st(one({ employerContributionsW2: D(1500) }), "sch1.13")).toBe("needs_cpa_judgment");
  });

  it("unanswered is missing_input and 'not sure' is needs_cpa_judgment (never a guess)", () => {
    expect(st(computeHsa8889({ people: [hsaPerson("a", "Eric", { coverage: MISSING }), hsaPerson("b", "Eva")] }), "sch1.13")).toBe("missing_input");
    expect(st(computeHsa8889({ people: [hsaPerson("a", "Eric", { coverage: UNSURE }), hsaPerson("b", "Eva")] }), "sch1.13")).toBe("needs_cpa_judgment");
    expect(st(computeHsa8889({ people: [hsaPerson("a", "Eric", covered({ age55Plus: MISSING })), hsaPerson("b", "Eva")] }), "sch1.13")).toBe("missing_input");
  });
});

// ── IRA deduction ────────────────────────────────────────────────────────────
// Pub. 590-A (2025) Worksheet 1-2: line 1 = 146,000 (MFJ covered) or 246,000 (not covered, spouse covered);
// line 3 = line 1 - MAGI; line 4 = line 3 x 35% / 40% (covered MFJ) or 70% / 80% (others), rounded UP to a multiple of 10,
// at least 200; deduction = smallest of line 4, compensation (line 5) and the contribution (line 6, max 7,000 / 8,000).

function iraPerson(slot: "a" | "b", name: string, over: Partial<IraPersonInput> = {}): IraPersonInput {
  return { slot, name, traditional: answered(D(0)), roth: answered(D(0)), age50Plus: answered(false), covered: answered(false), compensation: D(100000), ...over };
}
function ira(people: IraPersonInput[], magi: number | null, noSs: boolean | null = true) {
  return computeIraDeduction({ people, magi: magi === null ? null : D(magi), noSocialSecurityBenefits: noSs });
}

describe("computeIraDeduction", () => {
  it("no contribution: a not_applicable zero line", () => {
    const r = ira([iraPerson("a", "Eric"), iraPerson("b", "Eva")], 200000);
    expect(st(r, "sch1.20")).toBe("not_applicable");
    expect(amt(r, "sch1.20")).toBe("0");
  });

  it("Pub. 590-A Example 1 inputs: covered, MAGI 126,500: 19,500 x 35% = 6,825, rounded UP to 6,830 (the Pub's own example prints 6,825; the written rule is followed)", () => {
    const r = ira([iraPerson("a", "Eric", { traditional: answered(D(7000)), covered: answered(true), compensation: D(66000) }), iraPerson("b", "Eva", { covered: answered(false), compensation: D(51500) })], 126500);
    expect(amt(r, "ira.a.7")).toBe("6830");
    expect(amt(r, "sch1.20")).toBe("6830");
    expect(amt(r, "ira.magi")).toBe("126500");
  });

  it("Pub. 590-A Example 2: spouse's IRA, not covered, spouse covered, MAGI 238,500: 7,500 x 70% = 5,250 (compensation 45,500 - 7,000 = 38,500)", () => {
    const r = ira(
      [
        iraPerson("a", "Eric", { traditional: answered(D(7000)), covered: answered(true), compensation: D(45500) }),
        iraPerson("b", "Eva", { traditional: answered(D(7000)), covered: answered(false), compensation: D(0) }),
      ],
      238500
    );
    expect(amt(r, "ira.a.7")).toBe("0"); // covered and MAGI over 146,000
    expect(amt(r, "ira.b.7")).toBe("5250");
    expect(amt(r, "sch1.20")).toBe("5250");
  });

  it("covered, MAGI 146,000 or more: not deductible (a computed zero); MAGI 126,000 full; 125,999 or less full", () => {
    const base = (magi: number) => ira([iraPerson("a", "Eric", { traditional: answered(D(7000)), covered: answered(true) }), iraPerson("b", "Eva")], magi);
    expect(amt(base(146000), "ira.a.7")).toBe("0");
    expect(amt(base(145999), "ira.a.7")).toBe("200"); // 1 x 35% = 0.35 -> 10 -> raised to the 200 minimum
    expect(amt(base(126000), "ira.a.7")).toBe("7000");
    expect(amt(base(100000), "ira.a.7")).toBe("7000");
    expect(amt(base(126001), "ira.a.7")).toBe("7000"); // 19,999 x 35% = 6,999.65 -> 7,000
  });

  it("age 50+: limit 8,000 and 40%: MAGI 130,000 covered -> 16,000 x 40% = 6,400", () => {
    const r = ira([iraPerson("a", "Eric", { traditional: answered(D(8000)), covered: answered(true), age50Plus: answered(true) }), iraPerson("b", "Eva")], 130000);
    expect(amt(r, "ira.a.7")).toBe("6400");
    const full = ira([iraPerson("a", "Eric", { traditional: answered(D(8000)), age50Plus: answered(true) }), iraPerson("b", "Eva")], 100000);
    expect(amt(full, "ira.a.7")).toBe("8000");
  });

  it("neither covered: no phase-out at any MAGI; compensation can limit (3,000 compensation)", () => {
    const r = ira([iraPerson("a", "Eric", { traditional: answered(D(7000)), compensation: D(3000) }), iraPerson("b", "Eva", { compensation: D(0) })], 900000);
    expect(amt(r, "ira.a.7")).toBe("3000"); // spouse has no compensation to add
  });

  it("traditional plus Roth over the limit, Social Security not ruled out, unknown compensation: CPA / missing, never guessed", () => {
    expect(st(ira([iraPerson("a", "Eric", { traditional: answered(D(5000)), roth: answered(D(3000)) }), iraPerson("b", "Eva")], 100000), "sch1.20")).toBe("needs_cpa_judgment");
    expect(st(ira([iraPerson("a", "Eric", { traditional: answered(D(5000)), covered: answered(true) }), iraPerson("b", "Eva")], 100000, null), "sch1.20")).toBe("missing_input");
    expect(st(ira([iraPerson("a", "Eric", { traditional: answered(D(5000)), compensation: null }), iraPerson("b", "Eva")], 100000), "sch1.20")).toBe("missing_input");
    expect(st(ira([iraPerson("a", "Eric", { traditional: answered(D(5000)), covered: answered(true) }), iraPerson("b", "Eva")], null), "sch1.20")).toBe("missing_input");
    expect(st(ira([iraPerson("a", "Eric", { traditional: MISSING }), iraPerson("b", "Eva")], 100000), "sch1.20")).toBe("missing_input");
    expect(st(ira([iraPerson("a", "Eric", { traditional: UNSURE }), iraPerson("b", "Eva")], 100000), "sch1.20")).toBe("needs_cpa_judgment");
  });
});

// ── Form 8880 ────────────────────────────────────────────────────────────────
// 2025 Form 8880: no credit if line 11a is more than 79,000 (MFJ); line 6 caps each person's contributions at 2,000;
// line 9 decimal (MFJ) 0.5 to 47,500, 0.2 to 51,000, 0.1 to 79,000; line 11 = tax limit.

function saver(over: Partial<SaverInput> = {}): SaverInput {
  return {
    agi: D(47500),
    people: [
      { name: "Eric", iraContributions: answered(D(2000)), deferrals: answered(D(0)) },
      { name: "Eva", iraContributions: answered(D(0)), deferrals: answered(D(2000)) },
    ],
    distributionsSince2022: answered(false),
    studentOrDependent: answered(false),
    taxBeforeCredits: D(5000),
    otherCredits: D(0),
    ...over,
  };
}

describe("computeSaversCredit", () => {
  it("acceptance 4: AGI 79,001 -> ineligible with the Form 8880 citation, a computed zero", () => {
    const r = computeSaversCredit(saver({ agi: D(79001) }));
    expect(r.status).toBe("computed");
    expect(r.conclusion).toBe("ineligible");
    expect(amt(r, "sch3.4")).toBe("0");
    expect(r.reasons[0]).toContain("more than $79,000");
    expect(r.citations).toContain("SAVERS_RATE_BANDS_MFJ");
  });

  it("acceptance 4: AGI 47,500 with 2,000 per spouse -> 4,000 x 0.5 = 2,000", () => {
    const r = computeSaversCredit(saver());
    expect(r.conclusion).toBe("eligible");
    expect(amt(r, "f8880.7")).toBe("4000");
    expect(amt(r, "f8880.10")).toBe("2000");
    expect(amt(r, "sch3.4")).toBe("2000");
  });

  it("band edges: 47,501 -> 20% = 800; 51,000 -> 800; 51,001 -> 10% = 400; 79,000 -> 400", () => {
    expect(amt(computeSaversCredit(saver({ agi: D(47501) })), "sch3.4")).toBe("800");
    expect(amt(computeSaversCredit(saver({ agi: D(51000) })), "sch3.4")).toBe("800");
    expect(amt(computeSaversCredit(saver({ agi: D(51001) })), "sch3.4")).toBe("400");
    expect(amt(computeSaversCredit(saver({ agi: D(79000) })), "sch3.4")).toBe("400");
  });

  it("each person's contributions are capped at 2,000 (3,000 + 3,000 counts 4,000)", () => {
    const r = computeSaversCredit(
      saver({
        people: [
          { name: "Eric", iraContributions: answered(D(1000)), deferrals: answered(D(2000)) },
          { name: "Eva", iraContributions: answered(D(3000)), deferrals: answered(D(0)) },
        ],
      })
    );
    expect(amt(r, "f8880.7")).toBe("4000");
  });

  it("limited by the tax: credit is the smaller of line 10 and the credit limit worksheet (tax 1,500 minus other credits 1,000 = 500)", () => {
    const r = computeSaversCredit(saver({ taxBeforeCredits: D(1500), otherCredits: D(1000) }));
    expect(amt(r, "f8880.11")).toBe("500");
    expect(amt(r, "sch3.4")).toBe("500");
    expect(r.conclusion).toBe("partial");
  });

  it("no contributions at all: a computed zero; a student / dependent / distribution is needs_cpa_judgment; unanswered is missing_input", () => {
    const none = computeSaversCredit(
      saver({ people: [{ name: "Eric", iraContributions: answered(D(0)), deferrals: answered(D(0)) }, { name: "Eva", iraContributions: answered(D(0)), deferrals: answered(D(0)) }] })
    );
    expect(amt(none, "sch3.4")).toBe("0");
    expect(st(computeSaversCredit(saver({ studentOrDependent: answered(true) })), "sch3.4")).toBe("needs_cpa_judgment");
    expect(st(computeSaversCredit(saver({ distributionsSince2022: answered(true) })), "sch3.4")).toBe("needs_cpa_judgment");
    expect(st(computeSaversCredit(saver({ distributionsSince2022: MISSING })), "sch3.4")).toBe("missing_input");
    expect(st(computeSaversCredit(saver({ agi: null })), "sch3.4")).toBe("missing_input");
  });
});
