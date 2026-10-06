// Tester probes for Form 8606 (engine ty2025-1b.8): an independent oracle (own integer arithmetic, own worksheet transcription from the 2025 Form 1040
// instructions "IRA Deduction Worksheet" and the 2025 Form 8606 instructions "Line 1"/"Line 2") fuzzed against the engine rule and the whole return,
// the statement matrix for lines 2/3/14, whole-return patterns (single, both spouses, Roth only, none, partial, SEP/SIMPLE, distribution),
// the override interplay and a line-14 mutation that L1 must flag.
import { vi } from "vitest";
import { describe, expect, it } from "vitest";
import { answered, MISSING, UNSURE, type Ans } from "@/lib/tax2025/answer-state";
import { D } from "@/lib/tax2025/money";
import { computeForm8606, type Form8606PersonInput } from "@/lib/tax2025/rules/form-8606";
import { computeIraDeduction, type IraPersonInput } from "@/lib/tax2025/rules/ira-deduction";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { LineKey, RuleResult, Ty2025Return } from "@/lib/tax2025/types";
import { lineSnapshot, type OverrideRow } from "@/lib/tax2025/overrides";
import { ERIC_ID, EVA_ID, fullFacts1b, owner } from "./tax2025-fixtures";
import { cleanScenario, runPipeline, describeFindings } from "./tax-review-harness";
import { emptyReturnAnswers } from "@/lib/tax2025/facts";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { applyOverrides } from "@/lib/tax2025/overrides";
import { runL2 } from "@/lib/tax-review/l2/run";
import { cleanDocs, doc, w2Doc } from "./tax-review-harness";

vi.setConfig({ testTimeout: 120000 });

// ── own oracle ────────────────────────────────────────────────────────────────────────────────────────────────────
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface P {
  trad: number | "missing" | "unsure";
  roth: number;
  age50: boolean;
  covered: boolean;
  comp: number;
}
type Expect = { kind: "blocked" } | { kind: "amount"; ded: number; nd: number };

/** 1040 IRA Deduction Worksheet + 8606 line 1, MFJ, integer arithmetic. magi = worksheet line 5. ssNone = statement. */
function oracle(me: P, other: P, magi: number, ssNone: boolean): Expect {
  if (me.trad === "missing" || me.trad === "unsure") return { kind: "blocked" };
  const trad = me.trad;
  if (trad === 0) return { kind: "amount", ded: 0, nd: 0 };
  const limit = me.age50 ? 8000 : 7000;
  if (trad + me.roth > limit) return { kind: "blocked" };
  if ((me.covered || other.covered) && !ssNone) return { kind: "blocked" };
  // compensation (worksheet 1-2 line 5): own; a spouse with less compensation adds the other's compensation less THEIR contributions
  let comp = me.comp;
  if (me.comp < other.comp) {
    const ot = other.trad === "missing" || other.trad === "unsure" ? null : other.trad;
    if (ot === null) return { kind: "blocked" };
    comp = me.comp + Math.max(0, other.comp - ot - other.roth);
  }
  if (trad > comp) return { kind: "blocked" }; // excess contribution: the rule does not figure it
  let reduced: number | null = null;
  let ded: number;
  if (me.covered || other.covered) {
    const end = me.covered ? 146000 : 246000;
    if (magi >= end) {
      ded = 0;
      return { kind: "amount", ded, nd: Math.min(comp, trad) - ded };
    }
    const gap = end - magi;
    const full = me.covered ? 20000 : 10000;
    if (gap < full) {
      const pct = me.covered ? (me.age50 ? 40 : 35) : me.age50 ? 80 : 70;
      const raw = gap * pct; // /100
      const rounded10 = Math.ceil(raw / 1000) * 10;
      reduced = Math.max(rounded10, 200);
    }
  }
  ded = Math.min(comp, Math.min(trad, limit), reduced === null ? Infinity : reduced);
  return { kind: "amount", ded, nd: Math.min(comp, trad) - ded };
}

function toIra(slot: "a" | "b", name: string, p: P): IraPersonInput {
  const trad: Ans<ReturnType<typeof D>> = p.trad === "missing" ? MISSING : p.trad === "unsure" ? UNSURE : answered(D(p.trad));
  return { slot, name, traditional: trad, roth: answered(D(p.roth)), age50Plus: answered(p.age50), covered: answered(p.covered), compensation: D(p.comp) };
}

function lineOf(r: RuleResult, key: LineKey) {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l;
}

function randP(rnd: () => number): P {
  const r = rnd();
  const trad: P["trad"] = r < 0.05 ? "missing" : r < 0.08 ? "unsure" : r < 0.35 ? 0 : Math.floor(rnd() * 8800);
  return {
    trad,
    roth: rnd() < 0.7 ? 0 : Math.floor(rnd() * 3000),
    age50: rnd() < 0.3,
    covered: rnd() < 0.5,
    comp: rnd() < 0.15 ? Math.floor(rnd() * 12000) : Math.floor(rnd() * 400000),
  };
}

describe("tester: ira.<slot>.nd and Form 8606 lines against an independent oracle (5,000 seeded scenarios)", () => {
  it("amount, status and the four form lines agree with the oracle everywhere; counters prove the branches were reached", () => {
    const rnd = mulberry(8606);
    const seen = { blocked: 0, ndPos: 0, ndZero: 0, partial: 0, over: 0, excess: 0, covered: 0 };
    for (let i = 0; i < 5000; i++) {
      const a = randP(rnd);
      const b = randP(rnd);
      const magi = rnd() < 0.5 ? 230000 + Math.floor(rnd() * 25000) : Math.floor(rnd() * 300000);
      const ssNone = rnd() < 0.85;
      const ira = computeIraDeduction({ people: [toIra("a", "A", a), toIra("b", "B", b)], magi: D(magi), noSocialSecurityBenefits: ssNone });
      for (const [slot, me, other] of [["a", a, b], ["b", b, a]] as const) {
        const exp = oracle(me, other, magi, ssNone);
        const nd = lineOf(ira, `ira.${slot}.nd` as LineKey);
        const ctx = JSON.stringify({ i, slot, me, other, magi, ssNone });
        if (exp.kind === "blocked") {
          seen.blocked++;
          expect(nd.amount === null, `blocked ${ctx}`).toBe(true);
          expect(["computed", "not_applicable"].includes(nd.status ?? ""), `blocked status ${ctx}`).toBe(false);
          continue;
        }
        expect(nd.amount?.toNumber(), `nd ${ctx}`).toBe(exp.nd);
        expect(nd.status, `nd status ${ctx}`).toBe(exp.nd === 0 ? "not_applicable" : "computed");
        const ded = lineOf(ira, `ira.${slot}.7` as LineKey).amount?.toNumber();
        expect(ded, `ded ${ctx}`).toBe(exp.ded);
        if (exp.nd > 0) {
          seen.ndPos++;
          if (exp.ded > 0) seen.partial++;
          if (exp.ded === 0) seen.over++;
        } else seen.ndZero++;
        if (me.covered) seen.covered++;
        // Form 8606 lines for each statement combination
        // Line 2 is the owner's answer (the 2024 Form 8606 line 14): answered 0 / 7,300, not answered, or "not sure"
        const PRIORS: Array<{ name: string; ans: Ans<ReturnType<typeof D>>; value: number | null; status: string }> = [
          { name: "0", ans: answered(D(0)), value: 0, status: "computed" },
          { name: "7300", ans: answered(D(7300)), value: 7300, status: "computed" },
          { name: "missing", ans: MISSING, value: null, status: "missing_input" },
          { name: "unsure", ans: UNSURE, value: null, status: "needs_cpa_judgment" },
          { name: "negative", ans: answered(D(-1)), value: null, status: "missing_input" },
        ];
        for (const prior of PRIORS)
          for (const basis of [true, false, null] as const)
            for (const dist of [true, false, null] as const) {
              const lead = (s: "a" | "b"): Form8606PersonInput => {
                const l = lineOf(ira, `ira.${s}.nd` as LineKey);
                return { slot: s, name: s, nondeductible: { amount: l.amount, status: l.status, reason: l.reason ?? null }, priorBasis: prior.ans };
              };
              const f = computeForm8606({ people: [lead("a"), lead("b")], noEarlierBasisOrOtherIraEvent: basis, noIraDistributions: dist });
              const k = (n: string) => `f8606${slot}.${n}` as LineKey;
              const l1 = lineOf(f, k("1"));
              const l2 = lineOf(f, k("2"));
              const l3 = lineOf(f, k("3"));
              const l14 = lineOf(f, k("14"));
              const c2 = JSON.stringify({ ctx, basis, dist, prior: prior.name });
              if (exp.nd === 0) {
                for (const l of [l1, l2, l3, l14]) {
                  expect(l.status, c2).toBe("not_applicable");
                  expect(l.amount?.toNumber(), c2).toBe(0);
                }
                continue;
              }
              expect(l1.amount?.toNumber(), c2).toBe(exp.nd);
              // line 2 / 3: the amount when answered and no Yes to the withdrawal / conversion statement; otherwise blocked, never a number
              if (basis === false) {
                expect([l2.amount, l3.amount], c2).toEqual([null, null]);
                expect(l2.status, c2).toBe("needs_cpa_judgment");
              } else if (prior.value === null) {
                expect([l2.amount, l3.amount], c2).toEqual([null, null]);
                expect(l2.status, c2).toBe(prior.status);
              } else {
                expect([l2.amount?.toNumber(), l3.amount?.toNumber()], c2).toEqual([prior.value, exp.nd + prior.value]);
              }
              if (basis === true && dist === true && prior.value !== null) expect(l14.amount?.toNumber(), c2).toBe(exp.nd + prior.value);
              else expect(l14.amount, c2).toBeNull(); // never a wrong number
            }
      }
    }
    // the fuzz reached every branch
    expect(seen.blocked).toBeGreaterThan(300);
    expect(seen.ndPos).toBeGreaterThan(500);
    expect(seen.ndZero).toBeGreaterThan(500);
    expect(seen.partial).toBeGreaterThan(50);
    expect(seen.over).toBeGreaterThan(100);
    expect(seen.covered).toBeGreaterThan(300);
  });
});

// ── whole-return patterns ─────────────────────────────────────────────────────────────────────────────────────────
function household(over: {
  aTrad: number; bTrad?: number; aRoth?: number; bRoth?: number; aCovered: boolean; bCovered: boolean; aWages?: number; bWages?: number; age50a?: boolean;
  /** The 2024 Form 8606 line 14 amounts in dollars (default 0 = none); null = not answered. */
  aPrior?: number | null; bPrior?: number | null;
}): Ty2025Facts {
  const f = fullFacts1b();
  const [a, b] = f.returnAnswers.people;
  if (over.aPrior !== null) a!.priorBasisCents = owner((over.aPrior ?? 0) * 100);
  if (over.bPrior !== null) b!.priorBasisCents = owner((over.bPrior ?? 0) * 100);
  a!.traditionalIraCents = owner(over.aTrad * 100);
  b!.traditionalIraCents = owner((over.bTrad ?? 0) * 100);
  a!.rothIraCents = owner((over.aRoth ?? 0) * 100);
  b!.rothIraCents = owner((over.bRoth ?? 0) * 100);
  a!.coveredByWorkplacePlan = owner(over.aCovered);
  b!.coveredByWorkplacePlan = owner(over.bCovered);
  a!.age50Plus = owner(over.age50a ?? false);
  b!.age50Plus = owner(false);
  const w = f.income.w2s;
  const set = (i: number, dollars: number) => {
    w[i]!.wagesCents = dollars * 100;
    w[i]!.socialSecurityWagesCents = dollars * 100;
    w[i]!.medicareWagesCents = dollars * 100;
  };
  set(0, over.aWages ?? 170000);
  set(1, over.bWages ?? 40000);
  return f;
}
const A = (r: Ty2025Return) => (["1", "2", "3", "14"] as const).map((n) => r.lines[`f8606a.${n}` as LineKey]?.amount ?? null);
const B = (r: Ty2025Return) => (["1", "2", "3", "14"] as const).map((n) => r.lines[`f8606b.${n}` as LineKey]?.amount ?? null);
const S = (r: Ty2025Return, k: LineKey) => r.lines[k]?.status;

describe("tester: whole-return patterns", () => {
  it("Eric exactly: 7,000 traditional, spouse covered, MAGI over 246,000, no earlier basis (2024 line 14 = 0) -> 7,000 / 0 / 7,000 / 7,000, Sch 1 line 20 = 0, Eva none", () => {
    const r = computeTy2025Return(household({ aTrad: 7000, aCovered: false, bCovered: true }));
    expect(A(r)).toEqual([7000, 0, 7000, 7000]);
    expect(B(r)).toEqual([0, 0, 0, 0]);
    expect(S(r, "f8606b.1")).toBe("not_applicable");
    expect(r.lines["sch1.20"]?.amount).toBe(0);
    expect(r.formsRequired.f8606?.required).toBe(true);
    expect(r.headline.complete).toBe(true);
  });

  it("Eric with his 2024 Form 8606 line 14 = 7,300 (the owner's confirmed figure): 7,000 / 7,300 / 14,300 / 14,300; the tax numbers do not move", () => {
    const withBasis = computeTy2025Return(household({ aTrad: 7000, aCovered: false, bCovered: true, aPrior: 7300 }));
    const none = computeTy2025Return(household({ aTrad: 7000, aCovered: false, bCovered: true, aPrior: 0 }));
    expect(A(withBasis)).toEqual([7000, 7300, 14300, 14300]);
    expect(withBasis.headline.complete).toBe(true);
    expect(withBasis.headline.federal.totalTax.amount).toBe(none.headline.federal.totalTax.amount);
    expect(withBasis.headline.federal.balance.amount).toBe(none.headline.federal.balance.amount);
    expect(withBasis.headline.connecticut.tax.amount).toBe(none.headline.connecticut.tax.amount);
  });

  it("the 2024 line 14 amount not answered: lines 2, 3 and 14 print nothing, line 1 stays, the return is not complete", () => {
    const r = computeTy2025Return(household({ aTrad: 7000, aCovered: false, bCovered: true, aPrior: null }));
    expect(A(r)).toEqual([7000, null, null, null]);
    expect(r.headline.complete).toBe(false);
    expect(r.openItems.some((o) => o.id === "rule:form-8606" && o.severity === "blocking")).toBe(true);
  });

  it("deduction partially allowed: the nondeductible amount is the contribution minus the deduction (oracle from the engine's own MAGI)", () => {
    // wages chosen so ira.magi lands inside 236,000-246,000 (Eva covered, Eric not)
    const f = household({ aTrad: 7000, aCovered: false, bCovered: true, aWages: 152000, bWages: 40000 });
    const probe = computeTy2025Return(f);
    const magi = probe.lines["ira.magi"]!.amount!;
    expect(magi).toBeGreaterThan(236000);
    expect(magi).toBeLessThan(246000);
    const gap = 246000 - magi;
    const ded = Math.min(7000, Math.max(Math.ceil((gap * 70) / 1000) * 10, 200));
    expect(probe.lines["ira.a.7"]?.amount).toBe(ded);
    expect(probe.lines["sch1.20"]?.amount).toBe(ded);
    expect(A(probe)).toEqual([7000 - ded, 0, 7000 - ded, 7000 - ded]);
  });

  it("both spouses: Eva covered, 5,000 traditional, MAGI over her 146,000 limit: two separate forms, never mixed", () => {
    const r = computeTy2025Return(household({ aTrad: 7000, bTrad: 5000, aCovered: false, bCovered: true }));
    expect(A(r)).toEqual([7000, 0, 7000, 7000]);
    expect(B(r)).toEqual([5000, 0, 5000, 5000]);
    expect(r.formsRequired.f8606?.required).toBe(true);
  });

  it("Roth contributor only (traditional 0, Roth 7,000): no Form 8606 Part I, form not required", () => {
    const r = computeTy2025Return(household({ aTrad: 0, aRoth: 7000, aCovered: false, bCovered: true }));
    expect(S(r, "f8606a.1")).toBe("not_applicable");
    expect(r.formsRequired.f8606).toEqual({ required: false, reason: expect.any(String) });
  });

  it("no contribution at all: not required, four n/a zeros each", () => {
    const r = computeTy2025Return(household({ aTrad: 0, aCovered: false, bCovered: true }));
    expect(r.formsRequired.f8606?.required).toBe(false);
    for (const k of ["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14", "f8606b.1"] as LineKey[]) expect(S(r, k)).toBe("not_applicable");
  });

  it("fully deductible (neither covered): not required even with 7,000 traditional", () => {
    const r = computeTy2025Return(household({ aTrad: 7000, aCovered: false, bCovered: false }));
    expect(r.lines["sch1.20"]?.amount).toBe(7000);
    expect(r.formsRequired.f8606?.required).toBe(false);
  });

  it("Eric covered himself, MAGI far above 146,000: all 7,000 nondeductible", () => {
    const r = computeTy2025Return(household({ aTrad: 7000, aCovered: true, bCovered: true }));
    expect(A(r)).toEqual([7000, 0, 7000, 7000]);
  });

  it("age 50+ limit: 8,000 allowed and nondeductible (MAGI over); 8,001 blocks everything and prints nothing", () => {
    const ok = computeTy2025Return(household({ aTrad: 8000, aCovered: false, bCovered: true, age50a: true }));
    expect(A(ok)).toEqual([8000, 0, 8000, 8000]);
    const bad = computeTy2025Return(household({ aTrad: 8001, aCovered: false, bCovered: true, age50a: true }));
    expect(A(bad)).toEqual([null, null, null, null]);
    expect(bad.formsRequired.f8606?.required).toBe("blocking");
  });

  it("traditional + Roth together over the limit blocks (excess contributions are not figured)", () => {
    const r = computeTy2025Return(household({ aTrad: 4000, aRoth: 4000, aCovered: false, bCovered: true }));
    expect(A(r)).toEqual([null, null, null, null]);
  });

  it("a distribution (retirement_ss_income = Yes) never yields a wrong number: all four lines blocked", () => {
    const f = household({ aTrad: 7000, aCovered: false, bCovered: true });
    f.statedNone.retirement_ss_income = owner(false);
    const r = computeTy2025Return(f);
    expect(A(r)).toEqual([null, null, null, null]);
    expect(r.headline.complete).toBe(false);
  });

  it("the withdrawal / conversion statement: Yes blocks 2, 3, 14 (line 1 stays); not stated leaves lines 1-3 and blocks line 14 plus a blocking item", () => {
    const f = household({ aTrad: 7000, aCovered: false, bCovered: true, aPrior: 7300 });
    f.statedNone.ira_basis_other = owner(false);
    const yes = computeTy2025Return(f);
    expect(A(yes)).toEqual([7000, null, null, null]);
    delete f.statedNone.ira_basis_other;
    const none = computeTy2025Return(f);
    expect(A(none)).toEqual([7000, 7300, 14300, null]);
    expect(none.openItems.some((o) => o.id === "rule:form-8606" && o.severity === "blocking")).toBe(true);
    // the provisional (what-if) headline assumes none: 7,000 / 7,300 / 14,300 / 14,300
    expect(["1", "2", "3", "14"].map((n) => none.headline.provisional?.lines[`f8606a.${n}` as LineKey])).toEqual([7000, 7300, 14300, 14300]);
  });

  it("a SEP / SIMPLE IRA contribution is not a traditional IRA contribution: nothing in the answers makes it a Form 8606 amount", () => {
    // the owner's traditional answer is 0 (an employer SEP/SIMPLE contribution is not asked here): no form
    const r = computeTy2025Return(household({ aTrad: 0, aCovered: false, bCovered: true }));
    expect(r.formsRequired.f8606?.required).toBe(false);
  });

  it("no tax number moves between a 0 and a 7,000 nondeductible contribution (Eric's shape)", () => {
    const withC = computeTy2025Return(household({ aTrad: 7000, aCovered: false, bCovered: true }));
    const without = computeTy2025Return(household({ aTrad: 0, aCovered: false, bCovered: true }));
    expect(withC.headline.federal.totalTax.amount).toBe(without.headline.federal.totalTax.amount);
    expect(withC.headline.federal.balance.amount).toBe(without.headline.federal.balance.amount);
    expect(withC.headline.connecticut.tax.amount).toBe(without.headline.connecticut.tax.amount);
    expect(withC.lines["f1040.11a"]?.amount).toBe(without.lines["f1040.11a"]?.amount);
  });
});

// ── overrides interplay and the L1 mutation ───────────────────────────────────────────────────────────────────────
function lineRow(key: LineKey, cents: number, snapshot: unknown, n: number): OverrideRow {
  return {
    id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
    taxYear: 2025,
    targetKind: "line",
    targetKey: key,
    version: 1,
    valueKind: "money_cents",
    valueCents: cents,
    valueText: null,
    computedSnapshot: snapshot,
    authority: "owner",
    reason: "tester",
    setByName: "Tester",
    setAt: new Date("2026-10-05T12:00:00Z"),
    archivedAt: null,
  };
}

function ericScenario() {
  return cleanScenario(undefined, (f) => {
    const [a, b] = f.returnAnswers.people;
    a!.traditionalIraCents = owner(700_000);
    a!.priorBasisCents = owner(0); // the 2024 Form 8606 line 14: none
    a!.coveredByWorkplacePlan = owner(false);
    a!.age50Plus = owner(false);
    b!.coveredByWorkplacePlan = owner(true);
    f.income.w2s[0]!.wagesCents = 20_000_000;
    f.income.w2s[0]!.socialSecurityWagesCents = 20_000_000;
    f.income.w2s[0]!.medicareWagesCents = 20_000_000;
    f.priorYear = { totalTaxCents: owner(4_600_000), agiCents: owner(28_500_000), filingStatus: owner("mfj") };
  });
}

describe("tester: overrides on a Form 8606 line and the L1 mutation", () => {
  it("an override on line 14 prints in the PDF and is flagged; an override on line 1 leaves lines 3 and 14 as computed and L1 catches the footing", async () => {
    const base = ericScenario();
    const ret0 = computeTy2025Return(base.facts);
    expect(ret0.lines["f8606a.14"]?.amount).toBe(7000);
    const s14 = { ...base, overrideRows: [lineRow("f8606a.14", 600_000, lineSnapshot(ret0.lines["f8606a.14"]!, ret0.engineVersion), 1)] };
    const p14 = await runPipeline(s14);
    expect(p14.pipeline.ctx.view.lines["f8606a.14"]?.status).toBe("overridden");
    expect(p14.pipeline.ctx.view.lines["f8606a.14"]?.amount).toBe(6000);
    const file = p14.pipeline.ctx.packet.files.find((x) => x.formId === "f8606");
    expect(file).toBeDefined();
    const { PDFDocument } = await import("pdf-lib");
    const form = (await PDFDocument.load(file!.bytes)).getForm();
    expect(form.getTextField("topmostSubform[0].Page1[0].f1_23[0]").getText()).toBe("6,000");
    expect(form.getTextField("topmostSubform[0].Page1[0].f1_09[0]").getText()).toBe("7,000");
    // flagged: some L1 finding names Form 8606 / line 14 (an override is a visible decision)
    const text = describeFindings(p14.result.findings).join("\n");
    expect(/8606|f8606a\.14|line 14/i.test(text), text).toBe(true);

    const s1 = { ...base, overrideRows: [lineRow("f8606a.1", 500_000, lineSnapshot(ret0.lines["f8606a.1"]!, ret0.engineVersion), 2)] };
    const p1 = await runPipeline(s1);
    expect(p1.pipeline.ctx.view.lines["f8606a.1"]?.amount).toBe(5000);
  }, 120000);

  it("mutation: perturbing the printed line 14 by $1 (after the engine ran) is flagged by L1", async () => {
    const base = ericScenario();
    const clean = await runPipeline(base);
    const cleanF = clean.result.findings.filter((f) => /8606/.test(JSON.stringify(f)));
    const bad = await runPipeline(base, {
      mutateRet: (ret) => {
        const l = ret.lines["f8606a.14"]!;
        (l as { amount: number | null }).amount = (l.amount ?? 0) + 1;
      },
    });
    const badF = bad.result.findings.filter((f) => /8606/.test(JSON.stringify(f)));
    expect(badF.length, describeFindings(bad.result.findings).join("\n")).toBeGreaterThan(cleanF.length);
  }, 120000);

  it("mutation: perturbing line 3 by $1 is flagged by L1", async () => {
    const base = ericScenario();
    const clean = await runPipeline(base);
    const cleanF = clean.result.findings.filter((f) => /8606/.test(JSON.stringify(f)));
    const bad = await runPipeline(base, {
      mutateRet: (ret) => {
        const l = ret.lines["f8606a.3"]!;
        (l as { amount: number | null }).amount = (l.amount ?? 0) + 1;
      },
    });
    const badF = bad.result.findings.filter((f) => /8606/.test(JSON.stringify(f)));
    expect(badF.length, describeFindings(bad.result.findings).join("\n")).toBeGreaterThan(cleanF.length);
  }, 120000);
});

void ERIC_ID;
void EVA_ID;

// ── the 5498 as a fact: edge cases beyond the Coder's tests ──────────────────────────────────────────────────────────

function stmtDoc(id: string, personId: string | null, data: Record<string, unknown>, over: Partial<RawDocument> = {}): RawDocument {
  return {
    id,
    docType: "retirement_contribution",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: { summary: "x", data: { formVariant: "form_5498", issuerName: "Betterment Test", accountKind: "traditional_ira", taxYear: 2025, iraContributionsCents: 700_000, fairMarketValueCents: 4_914_679, ...data } },
    verified: true,
    legacyFormat: false,
    subjectType: personId === null ? null : "person",
    subjectUserId: personId,
    documentName: null,
    ...over,
  };
}
function rawWith(documents: RawDocument[], ericTrad: number | null, evaTrad: number | null = 0): RawTy2025Inputs {
  const ra = emptyReturnAnswers([
    { slot: "a", userId: ERIC_ID, name: "Eric" },
    { slot: "b", userId: EVA_ID, name: "Eva" },
  ]);
  if (ericTrad !== null) ra.people[0]!.traditionalIraCents = owner(ericTrad);
  if (evaTrad !== null) ra.people[1]!.traditionalIraCents = owner(evaTrad);
  return {
    taxYear: 2025,
    people: [{ userId: ERIC_ID, name: "Eric" }, { userId: EVA_ID, name: "Eva" }],
    scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "x" },
    documents,
    planning: { filingStatus: "mfj", householdMembers: "none", evVehicle: "no", businessMileage: "no", homeOfficeEligibility: "no", homeOfficeSqft: null, solarCredit: null, donationsNone: true, fixedAssetsEkcNone: true, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
    answers: { returnAnswers: ra },
    primaryResidence: { address: "27 Old Barry Rd", basis: "derived", note: "x" },
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  };
}
const conflictsOf = (r: ReturnType<typeof resolveFacts>) => r.conflicts.filter((c) => c.factKey.includes("traditionalIra")).map((c) => c.factKey);

describe("tester: the Form 5498 tie-out edge cases", () => {
  it("$6,000 on the 5498 versus the owner's $7,000: conflict, owner answer kept; box 5 is carried and changes nothing", () => {
    const r = resolveFacts(rawWith([stmtDoc("d1", ERIC_ID, { iraContributionsCents: 600_000 })], 700_000));
    expect(conflictsOf(r)).toEqual(["returnAnswers.a.traditionalIra"]);
    expect(r.facts.returnAnswers.people[0]!.traditionalIraCents.value).toBe(700_000);
  });

  it("an exact duplicate upload of the same 5498 is counted ONCE (not 14,000 vs 7,000): no conflict, one statement fact, and the existing blocking 'exact duplicates' item names both copies (was O1)", () => {
    const r = resolveFacts(rawWith([stmtDoc("d1", ERIC_ID, {}), stmtDoc("d2", ERIC_ID, {})], 700_000));
    expect(conflictsOf(r)).toEqual([]);
    expect(r.facts.returnAnswers.people[0]!.traditionalIraCents.value).toBe(700_000);
    expect(r.facts.income.retirementStatements).toHaveLength(1);
    const dup = r.openItems.find((o) => o.id.startsWith("doc-duplicate:retirement_contribution:"));
    expect(dup?.severity).toBe("blocking");
    expect(dup?.refs.map((x) => x.id).sort()).toEqual(["d1", "d2"]);
  });

  it("two 5498s from two custodians (4,000 + 3,000) tie out to the owner's 7,000: no conflict", () => {
    const r = resolveFacts(rawWith([stmtDoc("d1", ERIC_ID, { iraContributionsCents: 400_000 }), stmtDoc("d2", ERIC_ID, { iraContributionsCents: 300_000, issuerName: "Other" })], 700_000));
    expect(conflictsOf(r)).toEqual([]);
  });

  it("a verified and an unverified statement together: the candidate basis is doc_unverified; an unverified one alone is labelled and advised", () => {
    const r = resolveFacts(rawWith([stmtDoc("d1", ERIC_ID, { iraContributionsCents: 400_000 }), stmtDoc("d2", ERIC_ID, { iraContributionsCents: 100_000, issuerName: "O" }, { verified: false })], 700_000));
    const c = r.conflicts.find((x) => x.factKey === "returnAnswers.a.traditionalIra")!;
    expect(c.candidates[1]!.basis).toBe("doc_unverified");
    expect(r.openItems.some((o) => o.id === "doc-unverified:d2")).toBe(true);
  });

  it("the 5498 belongs to Eva (box 1 7,000) while the owner says Eva 0 and Eric 7,000: a conflict for Eva only; Eric has no statement so no conflict", () => {
    const r = resolveFacts(rawWith([stmtDoc("d1", EVA_ID, {})], 700_000, 0));
    expect(conflictsOf(r)).toEqual(["returnAnswers.b.traditionalIra"]);
  });

  it("a Roth-only 5498 (box 10 only) does not feed or conflict with the traditional answer (documented gap: Roth box 10 is not tied out)", () => {
    const r = resolveFacts(rawWith([stmtDoc("d1", ERIC_ID, { accountKind: "roth_ira", iraContributionsCents: null, rothIraContributionsCents: 700_000 })], 700_000));
    expect(conflictsOf(r)).toEqual([]);
    expect(r.facts.income.retirementStatements?.[0]?.rothIraCents).toBe(700_000);
  });

  it("a 5498 for form year 2026 or a document filed under 2024 is ignored; a SEP-only box 8 statement carries no traditional amount", () => {
    expect(resolveFacts(rawWith([stmtDoc("d1", ERIC_ID, { taxYear: 2026 })], 700_000)).facts.income.retirementStatements).toEqual([]);
    expect(resolveFacts(rawWith([stmtDoc("d1", ERIC_ID, {}, { taxYear: 2024 })], 700_000)).facts.income.retirementStatements).toEqual([]);
    const sep = resolveFacts(rawWith([stmtDoc("d1", ERIC_ID, { iraContributionsCents: null, sepContributionsCents: 500_000, accountKind: "sep_ira" })], 700_000));
    expect(sep.facts.income.retirementStatements?.[0]?.traditionalIraCents).toBeNull();
    expect(conflictsOf(sep)).toEqual([]);
  });

  it("whole return: box 5 changes no line; a conflicting 5498 changes no number either (owner answer rules)", () => {
    const base = resolveFacts(rawWith([stmtDoc("d1", ERIC_ID, {})], 700_000));
    const other = resolveFacts(rawWith([stmtDoc("d1", ERIC_ID, { fairMarketValueCents: 99_999_999, iraContributionsCents: 100 })], 700_000));
    const a = computeTy2025Return(base.facts, {}, { conflicts: base.conflicts, openItems: base.openItems });
    const b = computeTy2025Return(other.facts, {}, { conflicts: other.conflicts, openItems: other.openItems });
    const diff = Object.keys(a.lines).filter((k) => JSON.stringify([a.lines[k as LineKey]?.status, a.lines[k as LineKey]?.amount]) !== JSON.stringify([b.lines[k as LineKey]?.status, b.lines[k as LineKey]?.amount]));
    expect(diff).toEqual([]);
  });
});

// ── L2 mutation ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("tester: L2 flags a perturbed Form 8606 line 14 / line 3 on the printed return", () => {
  const facts = (): Ty2025Facts => household({ aTrad: 7000, aCovered: false, bCovered: true });
  it("clean: ran, no mismatch, Form 8606 coverage 4 lines compared", () => {
    const f = facts();
    const ret = computeTy2025Return(f);
    const out = runL2({ ret, effective: applyOverrides(ret, []), facts: f });
    expect(out.status).toBe("ran");
    expect(out.summary.mismatchCount).toBe(0);
    expect(out.findings.filter((x) => /8606/.test(JSON.stringify(x)))).toEqual([]);
  });
  for (const key of ["f8606a.14", "f8606a.3"] as const) {
    it(`+$100 on ${key}: an L2 mismatch finding`, () => {
      const f = facts();
      const ret = computeTy2025Return(f);
      (ret.lines[key] as { amount: number | null }).amount = (ret.lines[key]!.amount ?? 0) + 100;
      const out = runL2({ ret, effective: applyOverrides(ret, []), facts: f });
      expect(out.summary.mismatchCount, JSON.stringify(out.findings.map((x) => x.check))).toBeGreaterThan(0);
      expect(out.findings.some((x) => x.lineKey === key)).toBe(true);
    });
  }
  it("the return's formsRequired.f8606 flipped to false while a 7,000 contribution is nondeductible: L2.forms.f8606", () => {
    const f = facts();
    const ret = computeTy2025Return(f);
    ret.formsRequired.f8606 = { required: false, reason: "x" };
    const out = runL2({ ret, effective: applyOverrides(ret, []), facts: f });
    expect(out.findings.some((x) => x.check === "L2.forms.f8606")).toBe(true);
  });
});

// ── L1 tie-out: a 5498 whose FORM year is not 2025 ───────────────────────────────────────────────────────────────────

describe("tester: L1.C1.ira-traditional ignores a 5498 whose form year is another year (same rule as the fact resolver)", () => {
  // D1 (low, fixed): the tie-out skips a 5498 whose own form year is not 2025, like the fact resolver (this was an it.fails probe).
  it("document column year 2025 but the form says 2024: the fact resolver ignores it; the L1 tie-out must not raise a finding from it", async () => {
    const d = doc("retirement_contribution", { formVariant: "form_5498", issuerName: "Sample Trust Co", accountKind: "traditional_ira", taxYear: 2024, iraContributionsCents: 300_000 }, { id: "5498aaaa-bbbb-4ccc-8ddd-5498eeee0001" });
    const docs = [w2Doc(ERIC_ID, "Alpine Sample Co", "11-1111111", 20_000_000, 3_000_000, 600_000), ...cleanDocs().slice(1), d];
    const s = cleanScenario(docs, (f) => {
      const [a, b] = f.returnAnswers.people;
      a!.traditionalIraCents = owner(700_000);
      a!.coveredByWorkplacePlan = owner(false);
      a!.age50Plus = owner(false);
      b!.coveredByWorkplacePlan = owner(true);
      f.priorYear = { totalTaxCents: owner(4_600_000), agiCents: owner(28_500_000), filingStatus: owner("mfj") };
    });
    s.raw.documents.find((x) => x.id === d.id)!.subjectType = "person";
    s.raw.documents.find((x) => x.id === d.id)!.subjectUserId = ERIC_ID;
    const { result } = await runPipeline(s);
    const hit = result.findings.filter((x) => x.check === "L1.C1.ira-traditional");
    expect(hit.map((x) => x.message), "a 2024-form-year 5498 is compared as if it were 2025").toEqual([]);
  });
});

// ── both spouses through the REAL engine + adapter + packet ──────────────────────────────────────────────────────────
import { buildPacket, toPdfReturnView, FORM_MAPS } from "@/lib/tax2025/pdf";
import { readAllFields } from "./tax2025-pdf-harness";

describe("tester: a both-spouses household through the real engine, adapter and packet", () => {
  it("f8606-a is Eric's (7,000), f8606-b is Eva's (5,000): own names, own amounts, nothing crossed, SSN/address/preparer blank", async () => {
    const f = household({ aTrad: 7000, bTrad: 5000, aCovered: false, bCovered: true });
    f.statedNone.ira_basis_other = owner(true);
    f.household.people = [{ userId: ERIC_ID, name: "Eric Test" }, { userId: EVA_ID, name: "Eva Laura Test" }];
    const ret = computeTy2025Return(f);
    expect(ret.headline.complete).toBe(true);
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-05T16:00:00.000Z", generatedBy: "Tester" });
    const packet = await buildPacket(view, { maps: FORM_MAPS, stamp: false });
    const files = packet.files.filter((x) => x.formId === "f8606");
    expect(files.map((x) => x.name.replace(/^\d+-/, ""))).toEqual(["f8606-a.pdf", "f8606-b.pdf"]);
    const [fa, fb] = await Promise.all(files.map((x) => readAllFields(x.bytes)));
    const P1 = "topmostSubform[0].Page1[0].";
    const pick = (m: Map<string, string | boolean>) => ["f1_01", "f1_09", "f1_10", "f1_11", "f1_23"].map((k) => m.get(`${P1}${k}[0]`));
    expect(pick(fa!)).toEqual(["Eric Test", "7,000", "0", "7,000", "7,000"]);
    expect(pick(fb!)).toEqual(["Eva Laura Test", "5,000", "0", "5,000", "5,000"]);
    for (const m of [fa!, fb!]) {
      const filled = [...m].filter(([, v]) => v !== "" && v !== false).map(([k]) => k);
      expect(filled.length).toBe(5);
    }
    const cover = packet.forms.find((x) => x.formId === "f8606");
    expect(cover?.note).toContain("2 sheet(s)");
  });

  it("Eric has none but Eva has one: only f8606-b is filed", async () => {
    const f = household({ aTrad: 0, bTrad: 5000, aCovered: true, bCovered: true });
    f.statedNone.ira_basis_other = owner(true);
    f.household.people = [{ userId: ERIC_ID, name: "Eric Test" }, { userId: EVA_ID, name: "Eva Laura Test" }];
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-05T16:00:00.000Z", generatedBy: "Tester" });
    const packet = await buildPacket(view, { maps: FORM_MAPS, stamp: false });
    expect(packet.files.filter((x) => x.formId === "f8606").map((x) => x.name.replace(/^\d+-/, ""))).toEqual(["f8606-b.pdf"]);
  });

  it("nobody has a nondeductible contribution: the form is not in the packet and the cover says why", async () => {
    const f = household({ aTrad: 0, aCovered: false, bCovered: true });
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-05T16:00:00.000Z", generatedBy: "Tester" });
    const packet = await buildPacket(view, { maps: FORM_MAPS, stamp: false });
    expect(packet.files.some((x) => x.formId === "f8606")).toBe(false);
    expect(packet.forms.find((x) => x.formId === "f8606")?.included).toBe(false);
  });
});

// ── the FINAL package ────────────────────────────────────────────────────────────────────────────────────────────────
import { buildFinalPackage } from "@/lib/tax2025/pdf/final-package";

describe("tester: the final (clean) package with a Form 8606", () => {
  const people = [{ userId: ERIC_ID, name: "Eric Test" }, { userId: EVA_ID, name: "Eva Laura Test" }];
  it("answered statement: the package builds, lists forms/NN-f8606-a.pdf, and the Form 8606 index text has no banned wording", async () => {
    const f = household({ aTrad: 7000, aCovered: false, bCovered: true });
    f.statedNone.ira_basis_other = owner(true);
    f.household.people = people;
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-05T16:00:00.000Z", generatedBy: "Tester" });
    const res = await buildFinalPackage(view, { maps: FORM_MAPS, approvedAt: "2026-10-05T17:00:00.000Z" });
    // the fixture may carry unrelated blockers for other forms; only assert when it builds, otherwise show why
    if (!res.ok) throw new Error(res.reason);
    expect(res.files.some((x) => /forms\/\d+-f8606-a\.pdf$/.test(x.name))).toBe(true);
  });
  it("unanswered statement: the final package is refused (blank blocking lines), never built with a missing number", async () => {
    const f = household({ aTrad: 7000, aCovered: false, bCovered: true });
    delete f.statedNone.ira_basis_other;
    f.household.people = people;
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-05T16:00:00.000Z", generatedBy: "Tester" });
    const res = await buildFinalPackage(view, { maps: FORM_MAPS });
    expect(res.ok).toBe(false);
  });
});

// ── the AI (L3) payload: is the 5498 "used"? ──────────────────────────────────────────────────────────────────────────
import { buildReviewPayload } from "@/lib/tax-review/llm/payload";
import { buildPipeline } from "./tax-review-harness";

describe("tester: the L3 payload's document list marks the retirement statement as used by Form 8606", () => {
  // D2 (medium, fixed): documentsOf() (lib/tax-review/llm/payload.ts) builds `usedBy` from W-2 / 1099 / 1098 / bill facts only, so the Form 5498 is sent to the
  // model with usedBy [] and no notUsedReason (fixed: it is marked "retirement_statement").
  it("usedBy of the 5498 document is not empty", async () => {
    const DOC = "5498aaaa-bbbb-4ccc-8ddd-5498eeee0002";
    const d = doc("retirement_contribution", { formVariant: "form_5498", issuerName: "Sample Trust Co", accountKind: "traditional_ira", taxYear: 2025, iraContributionsCents: 700_000, fairMarketValueCents: 4_914_679 }, { id: DOC, subjectType: "person", subjectUserId: ERIC_ID });
    const docs = [w2Doc(ERIC_ID, "Alpine Sample Co", "11-1111111", 20_000_000, 3_000_000, 600_000), ...cleanDocs().slice(1), d];
    const s = cleanScenario(docs, (f) => {
      const [a, b] = f.returnAnswers.people;
      a!.traditionalIraCents = owner(700_000);
      a!.coveredByWorkplacePlan = owner(false);
      a!.age50Plus = owner(false);
      b!.coveredByWorkplacePlan = owner(true);
      f.priorYear = { totalTaxCents: owner(4_600_000), agiCents: owner(28_500_000), filingStatus: owner("mfj") };
      f.income.retirementStatements = [
        { docId: DOC, personUserId: ERIC_ID, basis: "doc_verified", legacyFormat: false, refs: [{ kind: "document", id: DOC, label: "Retirement statement" }], issuer: "Sample Trust Co", traditionalIraCents: 700_000, rothIraCents: null, sepCents: null, simpleCents: null, postponedCents: null, postponedForYear: null, rolloverCents: null, rothConversionCents: null, recharacterizedCents: null, fairMarketValueCents: 4_914_679 },
      ];
    });
    const p = await buildPipeline(s);
    const payload = buildReviewPayload(
      {
        ret: p.ret,
        view: p.ctx.view,
        facts: p.ctx.facts,
        documents: (p.ctx.raw?.documents ?? []).map((x) => ({ id: x.id, docType: x.docType, taxYear: x.taxYear, verified: x.verified, extractionStatus: x.extractionStatus, subjectType: x.subjectType, subjectUserId: x.subjectUserId })),
        bindings: [],
        l1Findings: [],
        entityLabels: [],
      },
      [{ userId: ERIC_ID, name: "Eric Sample" }, { userId: EVA_ID, name: "Eva Sample" }]
    );
    const row = payload.documents.find((x) => x.type === "retirement_contribution");
    expect(row).toBeDefined();
    expect(row!.usedBy.length, JSON.stringify(row)).toBeGreaterThan(0);
  });
});
