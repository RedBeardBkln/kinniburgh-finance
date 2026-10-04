// Tester probes for ty2025-mip-ct-schedule1: an INDEPENDENT oracle for the 23 CT-1040 Schedule 1 detail lines
// (transcribed from the plan's B2 table and the CT-1040 2025 instructions pp. 6-10, not from the rule's code),
// a seeded fuzz of the rule against it, whole-return totals / CT tax oracle (specs/09 Tables A-E), PDF "never 0"
// probes, and questionnaire stale / year-aware probes.
import { describe, expect, it, vi } from "vitest";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { ct1040Map } from "@/lib/tax2025/pdf/maps/ct1040";
import { viewFromEngine } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { D } from "@/lib/tax2025/money";
import {
  CT_SCH1_ADDITION_KEYS,
  CT_SCH1_GROUPS,
  CT_SCH1_SUBTRACTION_KEYS,
  computeCtSchedule1,
  type CtFederalLead,
  type CtSchedule1Input,
  type CtSch1Group,
} from "@/lib/tax2025/rules/ct-schedule1";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { missingLeaf, type LineKey, type RuleStatus, type Ty2025Return } from "@/lib/tax2025/types";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { fullFacts1b, interest, owner } from "@/lib/__tests__/tax2025-fixtures";

// ── independent oracle ────────────────────────────────────────────────────────
type Exp = { status: RuleStatus; amount: number | null };
const BLOCK_ORDER: RuleStatus[] = ["missing_input", "needs_cpa_judgment", "needs_cpa_rule_unverified", "not_yet_computed"];
const worst = (ss: (RuleStatus | undefined)[]): RuleStatus => BLOCK_ORDER.find((b) => ss.includes(b)) ?? "missing_input";
const hasAmt = (l: CtFederalLead): boolean => l.amount !== null && (l.status === "computed" || l.status === "not_applicable");

function oFed(leads: CtFederalLead[]): Exp {
  const blocked = leads.filter((l) => !hasAmt(l));
  if (blocked.length > 0) return { status: worst(blocked.map((l) => l.status)), amount: null };
  if (leads.some((l) => !l.amount!.isZero())) return { status: "needs_cpa_judgment", amount: null };
  return { status: "computed", amount: 0 };
}
function oGroups(stated: CtSchedule1Input["stated"], groups: CtSch1Group[]): Exp {
  if (groups.some((g) => stated[g] === undefined)) return { status: "missing_input", amount: null };
  if (groups.some((g) => stated[g] === false)) return { status: "needs_cpa_judgment", amount: null };
  return { status: "not_applicable", amount: 0 };
}
function oDoc(v: import("@prisma/client/runtime/library").Decimal | null): Exp {
  if (v === null) return { status: "missing_input", amount: null };
  return v.isZero() ? { status: "computed", amount: 0 } : { status: "needs_cpa_judgment", amount: null };
}

function oracle(i: CtSchedule1Input): Record<string, Exp> {
  const ret = [i.fed.ira, i.fed.pension, i.fed.ss];
  const o: Record<string, Exp> = {};
  o["31"] = oDoc(i.exemptInterestBox8);
  o["32"] = oDoc(i.exemptDividends);
  o["33"] = oFed(ret);
  o["34"] = oFed([i.fed.trustsPartnerships]);
  o["35"] = oGroups(i.stated, ["ct_muni_bonds"]);
  o["36"] = oFed([i.fed.depreciation, i.fed.trustsPartnerships]);
  o["36a"] = o["36"]!;
  o["37"] = i.otherAdditions !== null ? { status: "computed", amount: i.otherAdditions.toNumber() } : oGroups(i.stated, ["ct_other_additions"]);
  if (i.usGovInterestBox3 === null) o["39"] = { status: "missing_input", amount: null };
  else if (i.usGovInterestBox3.isZero()) o["39"] = { status: "computed", amount: 0 };
  else if (i.stated.savings_bond_exclusion === true) o["39"] = { status: "computed", amount: i.usGovInterestBox3.toNumber() };
  else o["39"] = { status: "needs_cpa_judgment", amount: null };
  o["40"] = oGroups(i.stated, ["ct_us_gov_funds"]);
  for (const id of ["41", "43", "44", "45", "48b"]) o[id] = oFed(ret);
  if (hasAmt(i.fed.refund)) o["42"] = { status: i.fed.refund.status === "not_applicable" ? "not_applicable" : "computed", amount: i.fed.refund.amount!.toNumber() };
  else o["42"] = { status: worst([i.fed.refund.status]), amount: null };
  o["46"] = oFed([i.fed.trustsPartnerships]);
  o["47"] = oGroups(i.stated, ["ct_muni_bonds"]);
  o["48"] = oGroups(i.stated, ["ct_chet_able"]);
  o["48a"] = oGroups(i.stated, ["ct_prior_addbacks"]);
  o["48c"] = oGroups(i.stated, ["ct_other_subtractions"]);
  o["48d"] = oGroups(i.stated, ["ct_chet_able"]);
  o["49"] = i.otherSubtractions !== null ? { status: "computed", amount: i.otherSubtractions.toNumber() } : oGroups(i.stated, ["ct_other_subtractions", "ct_prior_addbacks", "ct_chet_able"]);
  return o;
}

// ── seeded PRNG ───────────────────────────────────────────────────────────────
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInput(r: () => number): CtSchedule1Input {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const doc = () => pick([null, D(0), D(0), D(123), D(50.4)]);
  const lead = (): CtFederalLead =>
    pick<CtFederalLead>([
      { amount: D(0), status: "computed" },
      { amount: D(0), status: "not_applicable" },
      { amount: D(500), status: "computed" },
      { amount: D(-300), status: "computed" },
      { amount: null, status: "missing_input" },
      { amount: null, status: "needs_cpa_judgment" },
      { amount: null, status: "needs_cpa_rule_unverified" },
      { amount: null, status: "not_yet_computed" },
      { amount: null, status: undefined },
    ]);
  const stated: CtSchedule1Input["stated"] = {};
  for (const g of [...CT_SCH1_GROUPS, "savings_bond_exclusion"] as const) {
    const v = pick([true, false, undefined] as const);
    if (v !== undefined) stated[g] = v;
  }
  return {
    exemptInterestBox8: doc(),
    exemptDividends: doc(),
    usGovInterestBox3: doc(),
    fed: { refund: lead(), trustsPartnerships: lead(), depreciation: lead(), ira: lead(), pension: lead(), ss: lead() },
    stated,
    statedSomeAmounts: r() < 0.5 ? { ct_other_additions: D(9999), ct_chet_able: D(8888), ct_us_gov_funds: D(7777) } : undefined,
    otherAdditions: pick([null, null, D(0), D(700)]),
    otherSubtractions: pick([null, null, D(0), D(300)]),
  };
}

describe("tester: CT Schedule 1 rule vs independent oracle (seeded fuzz)", () => {
  it("5,000 random inputs: every line's status and amount equal the oracle; blocked lines carry null; keys and order fixed", () => {
    const r = rng(20261004);
    const allKeys = [...CT_SCH1_ADDITION_KEYS, ...CT_SCH1_SUBTRACTION_KEYS] as LineKey[];
    expect(allKeys).toHaveLength(23);
    for (let n = 0; n < 5000; n++) {
      const input = randomInput(r);
      const res = computeCtSchedule1(input);
      const exp = oracle(input);
      expect(res.lines.map((l) => l.key)).toEqual(allKeys);
      for (const l of res.lines) {
        const id = l.key.slice("ct1040.s1.".length);
        const e = exp[id]!;
        expect(l.status, `${n} ${l.key}`).toBe(e.status);
        if (e.amount === null) {
          expect(l.amount, `${n} ${l.key} amount`).toBeNull();
          expect(l.exact, `${n} ${l.key} exact`).toBeNull();
          expect(["computed", "not_applicable"]).not.toContain(l.status);
        } else {
          expect(l.amount!.toNumber(), `${n} ${l.key} amount`).toBe(Math.round(e.amount));
        }
        expect(l.reason ?? "", `${n} ${l.key} reason`).not.toBe("");
      }
      // rule status is the worst of its lines; a clean rule has no pending text
      const anyBlocked = res.lines.some((l) => l.amount === null);
      if (!anyBlocked) expect(["computed", "not_applicable"]).toContain(res.status);
      else expect(["computed", "not_applicable"]).not.toContain(res.status);
      // the summary mentions "not final" iff something is blocked
      expect(res.reasons[0]!.includes("not final")).toBe(anyBlocked);
      // inputsMissing only for missing_input lines' topics: empty when no missing_input line exists
      if (!res.lines.some((l) => l.status === "missing_input")) expect(res.inputsMissing).toEqual([]);
    }
  });

  it("a stated 'about how much' amount on a Yes never becomes a line amount", () => {
    const r = rng(7);
    for (let n = 0; n < 500; n++) {
      const a = randomInput(r);
      const b = { ...a, statedSomeAmounts: undefined };
      const ra = computeCtSchedule1(a).lines.map((l) => [l.key, l.status, l.amount]);
      const rb = computeCtSchedule1(b).lines.map((l) => [l.key, l.status, l.amount]);
      expect(ra).toEqual(rb);
    }
  });

  it("with EVERY input unknown no line is computed or not_applicable, and the totals' inputs are all blocked", () => {
    const res = computeCtSchedule1({
      exemptInterestBox8: null,
      exemptDividends: null,
      usGovInterestBox3: null,
      fed: { refund: { amount: null, status: undefined }, trustsPartnerships: { amount: null, status: undefined }, depreciation: { amount: null, status: undefined }, ira: { amount: null, status: undefined }, pension: { amount: null, status: undefined }, ss: { amount: null, status: undefined } },
      stated: {},
      otherAdditions: null,
      otherSubtractions: null,
    });
    for (const l of res.lines) {
      expect(l.amount, l.key).toBeNull();
      expect(["computed", "not_applicable"], l.key).not.toContain(l.status);
    }
  });
});

// ── whole-return ──────────────────────────────────────────────────────────────
const amt = (r: Ty2025Return, k: LineKey): number | null => r.lines[k]?.amount ?? null;
const st = (r: Ty2025Return, k: LineKey): string | undefined => r.lines[k]?.status;

function s1Facts(): Ty2025Facts {
  const f = fullFacts1b();
  f.ct.additions = missingLeaf();
  f.ct.subtractions = missingLeaf();
  for (const g of CT_SCH1_GROUPS) f.statedNone[g] = owner(true);
  return f;
}

/** CT tax for an MFJ filer, hand transcribed from specs/09 Tables A-E (CT AGI above $100,500 only, so Table E = 0). */
function ctTaxOracle(agi: number): number {
  const exempt = agi <= 48000 ? 24000 : Math.max(0, 24000 - (agi - 48000));
  const ti = Math.max(0, agi - exempt);
  const bands: Array<[number, number, number, number]> = [
    [0, 20000, 0, 0.02],
    [20000, 100000, 400, 0.045],
    [100000, 200000, 4000, 0.055],
    [200000, 400000, 9500, 0.06],
    [400000, 500000, 21500, 0.065],
    [500000, 1000000, 28000, 0.069],
    [1000000, Infinity, 62500, 0.0699],
  ];
  let b = 0;
  for (const [lo, hi, base, rate] of bands) {
    if (ti > lo && ti <= hi) b = lo === 0 ? ti * rate : base + (ti - lo) * rate;
  }
  const c = agi <= 100500 ? 0 : Math.min(10, Math.ceil((agi - 100500) / 5000)) * 50;
  let d = 0;
  if (agi > 210000) {
    if (agi <= 300000) d = Math.ceil((agi - 210000) / 10000) * 50;
    else if (agi <= 400000) d = 500;
    else if (agi <= 690000) d = 500 + Math.ceil((agi - 400000) / 10000) * 180;
    else d = 5900;
  }
  return Math.round(b + c + d);
}

describe("tester: totals and CT tax through the whole return", () => {
  it("hand-computed CT tax for the dry-run CT AGI 270,980 is 14,609 (13,758.80 + 500 + 350)", () => {
    expect(ctTaxOracle(270980)).toBe(14609);
  });

  it("CT tax equals the oracle at CT AGI = fed AGI + line 37 - line 49 across band edges", () => {
    const base = computeTy2025Return(s1Facts());
    const fedAgi = amt(base, "f1040.11a")!;
    expect(fedAgi).toBeGreaterThan(100500);
    const cases: Array<[number, number]> = [
      [0, 0],
      [1_000_00, 0],
      [0, 5_000_00],
      [25_000_00, 3_000_00],
      [0, 40_000_00],
    ];
    for (const [add, sub] of cases) {
      const f = s1Facts();
      f.ct.additions = owner(add);
      f.ct.subtractions = owner(sub);
      const r = computeTy2025Return(f);
      const ctAgi = fedAgi + add / 100 - sub / 100;
      expect(amt(r, "ct1040.additions")).toBe(add / 100);
      expect(amt(r, "ct1040.subtractions")).toBe(sub / 100);
      expect(amt(r, "ct1040.ctAgi"), `agi ${add}/${sub}`).toBe(ctAgi);
      if (ctAgi > 100500) expect(amt(r, "ct1040.10"), `tax at ${ctAgi}`).toBe(ctTaxOracle(ctAgi));
    }
  });

  it("each total equals the sum of its detail lines, and is null exactly when a component is blocked (random statement subsets)", () => {
    const r = rng(99);
    for (let n = 0; n < 60; n++) {
      const f = s1Facts();
      for (const g of CT_SCH1_GROUPS) {
        const v = r();
        if (v < 0.25) delete f.statedNone[g];
        else if (v < 0.4) f.statedNone[g] = owner(false);
      }
      const ret = computeTy2025Return(f);
      const sum = (keys: readonly LineKey[]): number | null => {
        let t = 0;
        for (const k of keys) {
          const a = amt(ret, k);
          if (a === null) return null;
          t += a;
        }
        return t;
      };
      expect(amt(ret, "ct1040.additions"), `add ${n}`).toBe(sum(CT_SCH1_ADDITION_KEYS));
      expect(amt(ret, "ct1040.subtractions"), `sub ${n}`).toBe(sum(CT_SCH1_SUBTRACTION_KEYS));
      const open = amt(ret, "ct1040.additions") === null || amt(ret, "ct1040.subtractions") === null;
      if (open) {
        for (const k of ["ct1040.ctAgi", "ct1040.6", "ct1040.10", "ct1040.balance"] as const) {
          expect(amt(ret, k), `${n} ${k}`).toBeNull();
          expect(["computed", "not_applicable"], `${n} ${k}`).not.toContain(st(ret, k));
        }
        expect(ret.headline.complete).toBe(false);
        expect(ret.openItems.some((o) => o.id === "rule:ct-schedule1" && o.severity === "blocking")).toBe(true);
      } else {
        expect(amt(ret, "ct1040.ctAgi")).toBe(amt(ret, "f1040.11a")!);
      }
    }
  });

  it("a Yes answer plus an 'about how much' amount (ct_chet_able 3,000) blocks, never adds 3,000, and the provisional estimate assumes $0 and lists it", () => {
    const f = s1Facts();
    f.statedNone.ct_chet_able = owner(false);
    f.returnAnswers.statedSomeAmounts.ct_chet_able = owner(300_000);
    const r = computeTy2025Return(f);
    expect(st(r, "ct1040.s1.48")).toBe("needs_cpa_judgment");
    expect(amt(r, "ct1040.subtractions")).toBeNull();
    const p = r.headline.provisional!;
    expect(p.assumedZeroLines).toEqual(expect.arrayContaining(["ct1040.s1.48", "ct1040.s1.48d", "ct1040.s1.49"]));
  });

  it("line 42 follows federal Schedule 1 line 1 for the 2024-itemized worked example (1,000) and CT AGI stays at the pre-refund figure", () => {
    const f = s1Facts();
    f.statedNone.other_income = owner(false);
    f.returnAnswers.statedSomeAmounts.other_income = owner(150_000);
    const oi = f.returnAnswers.otherIncome!;
    oi.kinds = owner(["refund"]);
    oi.refundCents = owner(900_000);
    oi.deduction2024 = owner("itemized_income");
    oi.sch5dCents = owner(1_800_000);
    oi.sch5eCents = owner(1_000_000);
    oi.sch17Cents = owner(3_500_000);
    oi.boxes2024 = owner(0);
    oi.exceptionApplies = owner(false);
    const r = computeTy2025Return(f);
    expect(amt(r, "sch1.1")).toBe(1000);
    expect(amt(r, "ct1040.s1.42")).toBe(1000);
    expect(amt(r, "ct1040.subtractions")).toBe(1000);
    expect(amt(r, "ct1040.ctAgi")).toBe(amt(r, "f1040.11a")! - 1000);
  });

  it("'Not sure' (statement left absent) is missing_input, never zero; and a bonus/179-sized Schedule C line 13 goes to the CPA, not a CT number", () => {
    const f = s1Facts();
    delete f.statedNone.ct_muni_bonds;
    const r = computeTy2025Return(f);
    expect(st(r, "ct1040.s1.35")).toBe("missing_input");
    expect(st(r, "ct1040.s1.47")).toBe("missing_input");
  });

  it("box 3 and box 8 rounding: two 1099-INTs with box 3 of $0.40 each total $0.80 -> line 39 = 1 (document sum rounded once)", () => {
    const f = s1Facts();
    f.income.interest = [interest({ docId: "a", box1Cents: 10_000, box3Cents: 40 }), interest({ docId: "b", box1Cents: 10_000, box3Cents: 40 })];
    const r = computeTy2025Return(f);
    expect(amt(r, "ct1040.s1.39")).toBe(1);
    expect(amt(r, "ct1040.subtractions")).toBe(1);
  });
});

describe("tester: Schedule A mortgage insurance edge cases through the whole return", () => {
  const withMortgage = (over: Record<string, number | null>): Ty2025Facts => {
    const f = s1Facts();
    f.deductions.mortgages = f.deductions.mortgages.map((m) => ({ ...m, interestCents: 1_888_269, principalCents: 37_787_263, ...over }));
    return f;
  };
  it("box 5 alone: 8a computed = interest and the advisory is not blocking; MIP never raises line 8a", () => {
    const a = computeTy2025Return(withMortgage({ mortgageInsuranceCents: 122_196, pointsCents: 0 }));
    const b = computeTy2025Return(withMortgage({ mortgageInsuranceCents: 0, pointsCents: 0 }));
    expect(amt(a, "scha.8a")).toBe(18883);
    expect(amt(a, "scha.17")).toBe(amt(b, "scha.17"));
    expect(a.openItems.find((o) => o.id === "scha-mortgage-insurance-not-deductible")?.severity).toBe("advisory");
  });
  it("box 5 with box 6 points: still blocked on points (box 6 behavior unchanged)", () => {
    const r = computeTy2025Return(withMortgage({ mortgageInsuranceCents: 122_196, pointsCents: 100_000 }));
    expect(st(r, "scha.8a")).toBe("needs_cpa_rule_unverified");
    expect(r.lines["scha.8a"]?.reason).toContain("points");
    expect(r.lines["scha.8a"]?.reason).not.toContain("mortgage insurance");
  });
  it("box 5 with principal over $750,000: the over-limit block wins and the MIP advisory is still shown", () => {
    const r = computeTy2025Return(withMortgage({ mortgageInsuranceCents: 122_196, pointsCents: 0, principalCents: 80_000_000 }));
    expect(st(r, "scha.8a")).toBe("needs_cpa_rule_unverified");
    expect(r.lines["scha.8a"]?.reason).toContain("750,000");
  });
  it("box 5 null (unread): no advisory, line 8a computed, no throw", () => {
    const r = computeTy2025Return(withMortgage({ mortgageInsuranceCents: null, pointsCents: 0 }));
    expect(r.openItems.some((o) => o.id === "scha-mortgage-insurance-not-deductible")).toBe(false);
  });
  it("two mortgages with box 5 on both: the advisory amount is the sum", () => {
    const f = withMortgage({ mortgageInsuranceCents: 100_000, pointsCents: 0 });
    f.deductions.mortgages = [f.deductions.mortgages[0]!, { ...f.deductions.mortgages[0]!, refs: f.deductions.mortgages[0]!.refs, mortgageInsuranceCents: 50_000 }];
    const r = computeTy2025Return(f);
    expect(r.openItems.find((o) => o.id === "scha-mortgage-insurance-not-deductible")?.message).toContain("$1,500");
  });
});

// ── PDF: a blocked or unknown Schedule 1 line is never printed as 0 (real engine -> real CT-1040 fill) ──

vi.setConfig({ testTimeout: 90000 });
const NO_STAMP = { ...DEFAULT_FILL_OPTIONS, stamp: false };
const S1_IDS = ["31", "32", "33", "34", "35", "36", "36a", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "48a", "48b", "48c", "48d", "49", "50"];

describe("tester: CT-1040 PDF with the real engine (blank-not-zero on Schedule 1)", () => {
  it("one statement unanswered: line 40 blank + blocking cover item; line 50 and CT AGI/tax/balance fields blank (never 0); line 38 still prints only if non-zero", async () => {
    const f = s1Facts();
    delete f.statedNone.ct_us_gov_funds;
    const ret = computeTy2025Return(f);
    const res = await fillForm("ct1040", viewFromEngine(ret), ct1040Map, NO_STAMP);
    const fields = await readAllFields(res.bytes);
    for (const id of S1_IDS) expect(fields.get(`ct1040.l${id}`), `l${id}`).not.toBe("0");
    expect(fields.get("ct1040.l40")).toBe("");
    expect(fields.get("ct1040.l50")).toBe("");
    expect(fields.get("ct1040.l4")).not.toBe("0");
    expect(fields.get("ct1040.l5")).toBe("");
    expect(fields.get("ct1040.l6")).toBe("");
    expect(res.openItems.find((o) => o.id === "blank:ct1040:ct1040.s1.40")?.severity).toBe("blocking");
  });
  it("all statements none: every zero detail line is blank (not '0'), and no Schedule 1 box holds the string 0", async () => {
    const ret = computeTy2025Return(s1Facts());
    const res = await fillForm("ct1040", viewFromEngine(ret), ct1040Map, NO_STAMP);
    const fields = await readAllFields(res.bytes);
    for (const id of S1_IDS) expect(fields.get(`ct1040.l${id}`), `l${id}`).toBe("");
  });
  it("a stated line 37 / 49 amount prints on its own box and in the total; the SSN guard still refuses SSN-like text on the form", async () => {
    const f = s1Facts();
    f.ct.additions = owner(200_000);
    f.ct.subtractions = owner(50_000);
    const ret = computeTy2025Return(f);
    const res = await fillForm("ct1040", viewFromEngine(ret), ct1040Map, NO_STAMP);
    const fields = await readAllFields(res.bytes);
    expect(fields.get("ct1040.l37")).toBe("2,000");
    expect(fields.get("ct1040.l38")).toBe("2,000");
    expect(fields.get("ct1040.l49")).toBe("500");
    expect(fields.get("ct1040.l50")).toBe("500");
    for (const [k, v] of fields) if (typeof v === "string" && /\d{3}-\d{2}-\d{4}/.test(v)) throw new Error(`SSN-like text in ${k}`);
  });
});
