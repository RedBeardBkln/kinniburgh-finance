// CT-1040 Schedule 1 (rules/ct-schedule1.ts): the full status / amount matrix for every detail line.
import { describe, expect, it } from "vitest";
import { allConstants } from "@/lib/tax2025/constants";
import {
  CT_SCH1_ADDITION_KEYS,
  CT_SCH1_GROUPS,
  CT_SCH1_SUBTRACTION_KEYS,
  computeCtSchedule1,
  type CtFederalLead,
  type CtSchedule1Input,
  type CtSch1Group,
} from "@/lib/tax2025/rules/ct-schedule1";
import { D } from "@/lib/tax2025/money";
import type { LineKey, RuleResult, RuleStatus } from "@/lib/tax2025/types";

const ALL_KEYS: readonly LineKey[] = [...CT_SCH1_ADDITION_KEYS, ...CT_SCH1_SUBTRACTION_KEYS];

const zeroLead = (status: RuleStatus = "not_applicable"): CtFederalLead => ({ amount: D(0), status });
const blockedLead = (status: RuleStatus): CtFederalLead => ({ amount: null, status });
const amountLead = (n: number): CtFederalLead => ({ amount: D(n), status: "computed" });

/** Everything known and nothing to report: every line is a zero. */
function base(over: Partial<CtSchedule1Input> = {}): CtSchedule1Input {
  const stated: CtSchedule1Input["stated"] = { savings_bond_exclusion: true };
  for (const g of CT_SCH1_GROUPS) stated[g] = true;
  return {
    exemptInterestBox8: D(0),
    exemptDividends: D(0),
    usGovInterestBox3: D(0),
    fed: { refund: zeroLead(), trustsPartnerships: zeroLead(), depreciation: zeroLead("computed"), ira: zeroLead(), pension: zeroLead(), ss: zeroLead() },
    stated,
    otherAdditions: null,
    otherSubtractions: null,
    ...over,
  };
}
/** Nothing known: no document totals, no statements, every federal source blocked. */
function unknown(): CtSchedule1Input {
  return {
    exemptInterestBox8: null,
    exemptDividends: null,
    usGovInterestBox3: null,
    fed: {
      refund: blockedLead("not_yet_computed"),
      trustsPartnerships: blockedLead("not_yet_computed"),
      depreciation: blockedLead("not_yet_computed"),
      ira: blockedLead("not_yet_computed"),
      pension: blockedLead("not_yet_computed"),
      ss: blockedLead("not_yet_computed"),
    },
    stated: {},
    otherAdditions: null,
    otherSubtractions: null,
  };
}
const withStated = (over: Partial<Record<CtSch1Group | "savings_bond_exclusion", boolean | undefined>>): CtSchedule1Input["stated"] => {
  const s = base().stated;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete s[k as CtSch1Group];
    else s[k as CtSch1Group] = v;
  }
  return s;
};

const line = (r: RuleResult, key: LineKey) => {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l;
};
const st = (r: RuleResult, key: LineKey): RuleStatus | undefined => line(r, key).status;
const amt = (r: RuleResult, key: LineKey): string | null => {
  const a = line(r, key).amount;
  return a === null ? null : a.toString();
};

describe("computeCtSchedule1: shape", () => {
  it("emits exactly the 23 detail lines, each once, in form order", () => {
    const r = computeCtSchedule1(base());
    expect(r.lines.map((l) => l.key)).toEqual(ALL_KEYS);
    expect(ALL_KEYS).toHaveLength(23);
    expect(r.ruleId).toBe("ct-schedule1");
  });

  it("everything known / none: every line is a zero, the rule is computed and the summary says nothing is outstanding", () => {
    const r = computeCtSchedule1(base());
    for (const k of ALL_KEYS) expect(amt(r, k), k).toBe("0");
    expect(r.status).toBe("computed");
    expect(r.reasons[0]).toContain("all computed or stated none");
    expect(r.inputsMissing).toEqual([]);
  });

  it("property: with every input unknown no line is computed or not_applicable (never a silent zero), and no line has an amount", () => {
    const r = computeCtSchedule1(unknown());
    for (const k of ALL_KEYS) {
      expect(["computed", "not_applicable"], k).not.toContain(st(r, k));
      expect(line(r, k).amount, k).toBeNull();
    }
    expect(r.status).not.toBe("computed");
  });

  it("every cited constant id exists in the registry; every line reason cites the CT-1040 instructions", () => {
    const ids = new Set(allConstants().map((c) => c.id));
    const r = computeCtSchedule1(base());
    expect(r.citations.length).toBeGreaterThan(0);
    for (const c of r.citations) expect(ids.has(c), c).toBe(true);
    for (const l of r.lines) expect(l.reason, l.key).toContain("CT-1040 instructions, Schedule 1 line");
  });
});

describe("lines 31 / 32: exempt interest and exempt-interest dividends from the documents", () => {
  it("box 8 = 0 -> computed 0; null -> missing_input; > 0 -> needs_cpa_judgment naming the amount", () => {
    expect(st(computeCtSchedule1(base()), "ct1040.s1.31")).toBe("computed");
    const missing = computeCtSchedule1(base({ exemptInterestBox8: null }));
    expect(st(missing, "ct1040.s1.31")).toBe("missing_input");
    expect(amt(missing, "ct1040.s1.31")).toBeNull();
    const some = computeCtSchedule1(base({ exemptInterestBox8: D("250.50") }));
    expect(st(some, "ct1040.s1.31")).toBe("needs_cpa_judgment");
    expect(line(some, "ct1040.s1.31").reason).toContain("$250.50");
  });

  it("exempt-interest dividends: 0 -> computed 0; null -> missing_input; > 0 -> needs_cpa_judgment (fund percentage is not on the 1099)", () => {
    expect(st(computeCtSchedule1(base()), "ct1040.s1.32")).toBe("computed");
    expect(st(computeCtSchedule1(base({ exemptDividends: null })), "ct1040.s1.32")).toBe("missing_input");
    const some = computeCtSchedule1(base({ exemptDividends: D(40) }));
    expect(st(some, "ct1040.s1.32")).toBe("needs_cpa_judgment");
    expect(line(some, "ct1040.s1.32").reason).toContain("percentage");
  });
});

describe("line 39: U.S. government obligation interest (1099-INT box 3)", () => {
  it("box 3 = 0 -> computed 0", () => {
    expect(amt(computeCtSchedule1(base()), "ct1040.s1.39")).toBe("0");
    expect(st(computeCtSchedule1(base()), "ct1040.s1.39")).toBe("computed");
  });
  it("null -> missing_input", () => {
    expect(st(computeCtSchedule1(base({ usGovInterestBox3: null })), "ct1040.s1.39")).toBe("missing_input");
  });
  it("box 3 > 0 with the savings-bond exclusion stated none -> that amount (computed); Yes or absent -> needs_cpa_judgment", () => {
    const none = computeCtSchedule1(base({ usGovInterestBox3: D("50.00") }));
    expect(st(none, "ct1040.s1.39")).toBe("computed");
    expect(amt(none, "ct1040.s1.39")).toBe("50");
    expect(line(none, "ct1040.s1.39").reason).toContain("Fannie Mae");
    for (const v of [false, undefined]) {
      const r = computeCtSchedule1(base({ usGovInterestBox3: D(50), stated: withStated({ savings_bond_exclusion: v }) }));
      expect(st(r, "ct1040.s1.39"), String(v)).toBe("needs_cpa_judgment");
      expect(amt(r, "ct1040.s1.39")).toBeNull();
    }
  });
});

describe("lines 33 / 41 / 43 / 44 / 45 / 48b: follow Form 1040 lines 4b, 5b, 6b", () => {
  const KEYS: LineKey[] = ["ct1040.s1.33", "ct1040.s1.41", "ct1040.s1.43", "ct1040.s1.44", "ct1040.s1.45", "ct1040.s1.48b"];
  it("all three are $0 -> every one computed 0", () => {
    const r = computeCtSchedule1(base());
    for (const k of KEYS) expect([st(r, k), amt(r, k)], k).toEqual(["computed", "0"]);
  });
  it("a blocked source gives that source's status (worst wins) with a 'waits for' reason", () => {
    for (const status of ["missing_input", "needs_cpa_judgment", "needs_cpa_rule_unverified", "not_yet_computed"] as const) {
      const r = computeCtSchedule1(base({ fed: { ...base().fed, ss: blockedLead(status) } }));
      for (const k of KEYS) {
        expect(st(r, k), `${status} ${k}`).toBe(status);
        expect(line(r, k).reason).toContain("waits for Form 1040 line 6b");
      }
    }
    const worst = computeCtSchedule1(base({ fed: { ...base().fed, ira: blockedLead("not_yet_computed"), pension: blockedLead("needs_cpa_judgment") } }));
    expect(st(worst, "ct1040.s1.48b")).toBe("needs_cpa_judgment");
  });
  it("a positive source -> needs_cpa_judgment (the worksheets are not built)", () => {
    for (const lead of ["ira", "pension", "ss"] as const) {
      const r = computeCtSchedule1(base({ fed: { ...base().fed, [lead]: amountLead(1000) } }));
      for (const k of KEYS) {
        expect(st(r, k), `${lead} ${k}`).toBe("needs_cpa_judgment");
        expect(line(r, k).amount).toBeNull();
      }
      expect(line(r, "ct1040.s1.41").reason).toContain("not built");
    }
  });
});

describe("lines 34 / 46: fiduciary adjustment follows federal Schedule 1 line 5", () => {
  it("$0 -> computed 0 on both; blocked -> inherits; non-zero -> needs_cpa_judgment", () => {
    const zero = computeCtSchedule1(base());
    expect([st(zero, "ct1040.s1.34"), st(zero, "ct1040.s1.46")]).toEqual(["computed", "computed"]);
    const blocked = computeCtSchedule1(base({ fed: { ...base().fed, trustsPartnerships: blockedLead("needs_cpa_judgment") } }));
    expect([st(blocked, "ct1040.s1.34"), st(blocked, "ct1040.s1.46")]).toEqual(["needs_cpa_judgment", "needs_cpa_judgment"]);
    const some = computeCtSchedule1(base({ fed: { ...base().fed, trustsPartnerships: amountLead(-300) } }));
    expect([st(some, "ct1040.s1.34"), st(some, "ct1040.s1.46")]).toEqual(["needs_cpa_judgment", "needs_cpa_judgment"]);
  });
});

describe("lines 36 / 36a: bonus depreciation and Section 179 follow Schedule C line 13 and Schedule 1 line 5", () => {
  it("both $0 -> computed 0 (no fixed assets)", () => {
    const r = computeCtSchedule1(base());
    expect([amt(r, "ct1040.s1.36"), amt(r, "ct1040.s1.36a")]).toEqual(["0", "0"]);
    expect(line(r, "ct1040.s1.36").reason).toContain("Schedule C line 13");
  });
  it("Schedule C line 13 blocked (an asset on the register) -> inherits and names the percentages from the constants", () => {
    const r = computeCtSchedule1(base({ fed: { ...base().fed, depreciation: blockedLead("not_yet_computed") } }));
    expect(st(r, "ct1040.s1.36")).toBe("not_yet_computed");
    expect(st(r, "ct1040.s1.36a")).toBe("not_yet_computed");
    expect(line(r, "ct1040.s1.36").reason).toContain("100% of bonus depreciation and 80% of Section 179");
  });
  it("Schedule C line 13 > 0 -> needs_cpa_judgment; Schedule 1 line 5 blocked -> needs_cpa_judgment inherited", () => {
    const pos = computeCtSchedule1(base({ fed: { ...base().fed, depreciation: amountLead(2500) } }));
    expect([st(pos, "ct1040.s1.36"), st(pos, "ct1040.s1.36a")]).toEqual(["needs_cpa_judgment", "needs_cpa_judgment"]);
    const pass = computeCtSchedule1(base({ fed: { ...base().fed, trustsPartnerships: blockedLead("needs_cpa_judgment") } }));
    expect([st(pass, "ct1040.s1.36"), st(pass, "ct1040.s1.36a")]).toEqual(["needs_cpa_judgment", "needs_cpa_judgment"]);
  });
});

describe("line 42: the taxable state refund repeats federal Schedule 1 line 1", () => {
  it("$0 not_applicable (2024 standard deduction) -> same amount and status", () => {
    const r = computeCtSchedule1(base());
    expect([st(r, "ct1040.s1.42"), amt(r, "ct1040.s1.42")]).toEqual(["not_applicable", "0"]);
  });
  it("1,000 computed -> 1,000 computed; blocked -> inherits", () => {
    const r = computeCtSchedule1(base({ fed: { ...base().fed, refund: amountLead(1000) } }));
    expect([st(r, "ct1040.s1.42"), amt(r, "ct1040.s1.42")]).toEqual(["computed", "1000"]);
    const b = computeCtSchedule1(base({ fed: { ...base().fed, refund: blockedLead("missing_input") } }));
    expect(st(b, "ct1040.s1.42")).toBe("missing_input");
  });
});

describe("statement-driven lines: none / Yes / absent", () => {
  const MATRIX: ReadonlyArray<readonly [group: CtSch1Group, keys: readonly LineKey[]]> = [
    ["ct_muni_bonds", ["ct1040.s1.35", "ct1040.s1.47"]],
    ["ct_us_gov_funds", ["ct1040.s1.40"]],
    ["ct_chet_able", ["ct1040.s1.48", "ct1040.s1.48d"]],
    ["ct_prior_addbacks", ["ct1040.s1.48a"]],
    ["ct_other_additions", ["ct1040.s1.37"]],
    ["ct_other_subtractions", ["ct1040.s1.48c"]],
  ];
  for (const [group, keys] of MATRIX) {
    it(`${group}: none -> not_applicable 0; Yes -> needs_cpa_judgment; absent -> missing_input (and the rule names the question)`, () => {
      const none = computeCtSchedule1(base());
      for (const k of keys) expect([st(none, k), amt(none, k)], k).toEqual(["not_applicable", "0"]);
      const yes = computeCtSchedule1(base({ stated: withStated({ [group]: false }) }));
      for (const k of keys) {
        expect(st(yes, k), k).toBe("needs_cpa_judgment");
        expect(amt(yes, k)).toBeNull();
      }
      const absent = computeCtSchedule1(base({ stated: withStated({ [group]: undefined }) }));
      for (const k of keys) expect(st(absent, k), k).toBe("missing_input");
      expect(absent.status).toBe("missing_input");
      expect(absent.inputsMissing.join(" ")).toContain("Return completeness");
      expect(absent.reasons[0]).toContain("Waiting on");
    });
  }

  it("a Yes with an 'about how much' amount shows it in the reason and never changes an amount", () => {
    const r = computeCtSchedule1(base({ stated: withStated({ ct_chet_able: false }), statedSomeAmounts: { ct_chet_able: D(3000) } }));
    expect(line(r, "ct1040.s1.48").reason).toContain("about $3,000");
    expect(amt(r, "ct1040.s1.48")).toBeNull();
    expect(amt(r, "ct1040.s1.49")).toBeNull();
  });
});

describe("lines 37 / 49: a stated total wins over the statements", () => {
  it("override 0 with the group absent -> computed 0 (the override wins) and the stated amount is shown", () => {
    const r = computeCtSchedule1(base({ stated: withStated({ ct_other_additions: undefined }), otherAdditions: D(0) }));
    expect([st(r, "ct1040.s1.37"), amt(r, "ct1040.s1.37")]).toEqual(["computed", "0"]);
    expect(line(r, "ct1040.s1.37").reason).toContain("stated by the owner / CPA");
  });
  it("override 750 on line 49 -> computed 750 even when a group says Yes", () => {
    const r = computeCtSchedule1(base({ stated: withStated({ ct_other_subtractions: false, ct_chet_able: undefined }), otherSubtractions: D(750) }));
    expect([st(r, "ct1040.s1.49"), amt(r, "ct1040.s1.49")]).toEqual(["computed", "750"]);
    // the groups still gate their own lines
    expect(st(r, "ct1040.s1.48c")).toBe("needs_cpa_judgment");
  });
  it("line 49 from the groups: all three none -> not_applicable 0; any absent -> missing_input; any Yes (none absent) -> needs_cpa_judgment", () => {
    expect(st(computeCtSchedule1(base()), "ct1040.s1.49")).toBe("not_applicable");
    for (const g of ["ct_other_subtractions", "ct_prior_addbacks", "ct_chet_able"] as const) {
      expect(st(computeCtSchedule1(base({ stated: withStated({ [g]: undefined }) })), "ct1040.s1.49"), g).toBe("missing_input");
      expect(st(computeCtSchedule1(base({ stated: withStated({ [g]: false }) })), "ct1040.s1.49"), g).toBe("needs_cpa_judgment");
    }
    // one Yes and one absent at once: the worst (missing_input) is the line's status and both are named in the summary
    const mixed = computeCtSchedule1(base({ stated: withStated({ ct_chet_able: false, ct_prior_addbacks: undefined }) }));
    expect(st(mixed, "ct1040.s1.49")).toBe("missing_input");
    expect(mixed.reasons[0]).toContain("CHET and ABLE accounts");
    expect(mixed.reasons[0]).toContain("earlier Connecticut depreciation add-backs");
    expect(mixed.lines.filter((l) => l.key === "ct1040.s1.49")).toHaveLength(1);
  });
});

describe("summary: reasons[0] lists exactly the outstanding topics (the open-item message)", () => {
  it("with only the six owner questions open it names those six and no document-derived line", () => {
    const stated: CtSchedule1Input["stated"] = {};
    stated.savings_bond_exclusion = true;
    const r = computeCtSchedule1(base({ stated }));
    for (const name of ["Connecticut bond sales", "U.S. government bond funds", "CHET and ABLE accounts", "earlier Connecticut depreciation add-backs", "other Connecticut additions", "other Connecticut subtractions"]) {
      expect(r.reasons[0], name).toContain(name);
    }
    expect(r.reasons[0]).not.toContain("1099");
    expect(r.reasons[0]).not.toContain("Form 1040 line");
    expect(r.inputsMissing).toHaveLength(6);
  });
  it("a missing document and a blocked federal line are named once each", () => {
    const r = computeCtSchedule1(base({ exemptInterestBox8: null, usGovInterestBox3: null, fed: { ...base().fed, ss: blockedLead("needs_cpa_judgment") } }));
    expect(r.reasons[0]).toContain("1099-INT documents (lines 31, 39)");
    expect(r.reasons[0]).toContain("federal Form 1040 line 6b (Social Security)");
    expect(r.status).toBe("missing_input");
  });
});
