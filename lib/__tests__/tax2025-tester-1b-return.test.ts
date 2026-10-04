// Tester (independent) verification of Phase 1b at the RETURN level and of the "Return completeness" questionnaire:
// golden-return regression, the age/blind standard deduction flow-through, answers -> facts -> return, per-person matching,
// tree integrity, hidden-answer leakage, and the "no silent zero" invariant fuzzed over the 1b answer space.
import { describe, expect, it } from "vitest";
import {
  UNSURE_ID,
  coveringAnswerPaths,
  visibleNodes,
  validateDefinition,
  type AnswerValue,
  type ChoiceNode,
  type EffectiveAnswers,
  type QNode,
} from "@/lib/tax-questionnaire";
import { SOURCE_IDS, QUESTIONNAIRES, RETURN_COMPLETENESS_ID, RC_PAYMENT_WINDOWS, questionnaireById } from "@/lib/tax-questionnaire-content";
import { RC_CONTEXT, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { NONE_GROUP_IDS, NONE_GROUP_TEXT, LINE_CATALOG } from "@/lib/tax2025/line-catalog";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { hasAmount, type LineKey, type RuleStatus, type Ty2025Return } from "@/lib/tax2025/types";
import { emptyFacts, gl, fullFacts, fullFacts1b, owner, ERIC_ID, EVA_ID, w2 } from "@/lib/__tests__/tax2025-fixtures";
import type { Ty2025Facts } from "@/lib/tax2025/facts";

const amt = (r: Ty2025Return, k: LineKey): number | null => r.lines[k]?.amount ?? null;
const st = (r: Ty2025Return, k: LineKey): RuleStatus | undefined => r.lines[k]?.status;
const [ERIC, EVA] = [0, 1] as const;
const isChoiceNodeForTests = (n: QNode): n is ChoiceNode => n.kind === "single" || n.kind === "multi";

function withPerson(f: Ty2025Facts, i: 0 | 1, patch: Partial<Ty2025Facts["returnAnswers"]["people"][number]>): Ty2025Facts {
  const p = f.returnAnswers.people[i]!;
  Object.assign(p, patch);
  return f;
}

// ── Golden regression ────────────────────────────────────────────────────────
describe("golden return is unchanged by Phase 1b", () => {
  for (const [name, make] of [["fullFacts (stated amounts)", fullFacts], ["fullFacts1b (answers drive the 1b lines)", fullFacts1b]] as const) {
    it(`${name}: federal total tax 27,015; CT tax 8,788; AGI 177,967`, () => {
      const r = computeTy2025Return(make());
      expect(r.headline.federal.totalTax.amount).toBe(27015);
      expect(r.headline.connecticut.tax.amount).toBe(8788);
      expect(r.headline.federal.agi.amount).toBe(177967);
      expect(r.headline.complete).toBe(true);
    });
  }
});

// ── Standard deduction age / blind flow-through ─────────────────────────────
describe("standard deduction boxes flow through the whole return", () => {
  const withBoxes = (n: number): Ty2025Facts => {
    const f = fullFacts1b();
    const flags = [true, true, true, true].map((_, i) => i < n);
    withPerson(f, ERIC, { bornBefore1961: owner(flags[0]!), blind: owner(flags[1]!), validSsn: owner(true) });
    withPerson(f, EVA, { bornBefore1961: owner(flags[2]!), blind: owner(flags[3]!), validSsn: owner(true) });
    f.returnAnswers.magiExclusionsNone = owner(true);
    return f;
  };
  const expected = [31500, 33100, 34700, 36300, 37900];
  for (let n = 0; n <= 4; n++) {
    it(`${n} box(es): Form 1040 line 12e = ${expected[n]}; taxable income = AGI - 12e - 13a - 13b`, () => {
      const r = computeTy2025Return(withBoxes(n));
      expect(amt(r, "std.total")).toBe(expected[n]);
      expect(amt(r, "f1040.12e")).toBe(expected[n]);
      const agi = amt(r, "f1040.11b")!;
      const ti = agi - amt(r, "f1040.12e")! - amt(r, "f1040.13a")! - amt(r, "f1040.13b")!;
      expect(amt(r, "f1040.14")).toBe(amt(r, "f1040.12e")! + amt(r, "f1040.13a")! + amt(r, "f1040.13b")!);
      expect(amt(r, "f1040.15")).toBe(Math.max(0, ti));
    });
  }
  it("seniors: Eric + Eva both born before 1961 with SSNs at AGI 177,967 -> each 6,000 - 6% x 27,967 = 4,321.98 -> line 36a/36b 4,322, 13b = 8,644 (sum of the printed rounded lines); 12e = 34,700 (2 boxes)", () => {
    const f = withBoxes(0);
    withPerson(f, ERIC, { bornBefore1961: owner(true) });
    withPerson(f, EVA, { bornBefore1961: owner(true) });
    const r = computeTy2025Return(f);
    expect(amt(r, "sch1a.36a")).toBe(4322);
    expect(amt(r, "sch1a.36b")).toBe(4322);
    expect(amt(r, "f1040.13b")).toBe(8644);
    expect(amt(r, "f1040.12e")).toBe(34700);
  });
  it("MAGI for Schedule 1-A is Form 1040 line 11b AFTER the HSA deduction: HSA 3,000 -> AGI 174,967 -> senior 6,000 - 6% x 24,967 = 4,501.98 -> 4,502", () => {
    const f = withBoxes(0);
    withPerson(f, ERIC, { bornBefore1961: owner(true) });
    f.adjustments.hsa = owner(300_000); // stated override of the HSA deduction (cents) lowers AGI
    const r = computeTy2025Return(f);
    expect(amt(r, "f1040.11b")).toBe(174967);
    expect(amt(r, "sch1a.3")).toBe(174967);
    expect(amt(r, "sch1a.36a")).toBe(4502);
  });
  it("blank or 'not sure' age/blind box BLOCKS 12e, the comparison, taxable income and tax (never silently 31,500)", () => {
    for (const bad of [{ value: null, basis: null, refs: [] }, { value: null, basis: "answer_owner" as const, refs: [] }]) {
      const f = fullFacts1b();
      withPerson(f, ERIC, { blind: bad });
      const r = computeTy2025Return(f);
      expect(amt(r, "std.total")).toBeNull();
      for (const k of ["f1040.12e", "f1040.14", "f1040.15", "f1040.16", "f1040.24"] as const) {
        expect(amt(r, k), k).toBeNull();
        expect(hasAmount(st(r, k)!), k).toBe(false);
      }
      expect(r.headline.federal.taxableIncome.amount).toBeNull();
      expect(r.headline.complete).toBe(false);
      expect(r.formsRequired.scha?.required).toBe("blocking");
      expect(r.openItems.some((o) => o.severity === "blocking" && /standard deduction/i.test(o.message))).toBe(true);
    }
  });
  it("itemize crossover uses the adjusted amount: itemized 33,500 beats 31,500 and 33,100 but loses to 34,700 / 36,300 / 37,900", () => {
    for (const n of [0, 1, 2, 3, 4]) {
      const f = withBoxes(n);
      f.deductions.mortgages[0]!.interestCents = 1_888_269 + 441_700 + 0; // itemized = 23,299.69 + SALT 10,200 = 33,500
      const r = computeTy2025Return(f);
      const l17 = amt(r, "scha.17");
      expect(l17, `n=${n}`).toBe(33500);
      const itemizes = 33500 > expected[n]!;
      expect(amt(r, "f1040.12e"), `n=${n}`).toBe(itemizes ? 33500 : expected[n]);
      expect(r.formsRequired.scha?.required, `n=${n}`).toBe(itemizes);
    }
  });
  it("AMT screen add-back uses the ADJUSTED standard deduction: with two BLIND boxes (34,700, no Schedule 1-A effect) AMTI equals the 31,500 case (taxable income falls by exactly what is added back)", () => {
    const blind = (n: number): Ty2025Facts => {
      const f = fullFacts1b();
      withPerson(f, ERIC, { blind: owner(n >= 1) });
      withPerson(f, EVA, { blind: owner(n >= 2) });
      return f;
    };
    const a = computeTy2025Return(blind(0));
    const b = computeTy2025Return(blind(2));
    expect(amt(b, "f1040.12e")).toBe(34700);
    const amtiA = amt(a, "f6251.amti");
    expect(amtiA).not.toBeNull();
    expect(amt(b, "f6251.amti")).toBe(amtiA);
    expect(amt(a, "f1040.15")! - amt(b, "f1040.15")!).toBe(3200); // taxable income falls by exactly 2 x 1,600 (QBI limit not binding)
  });
});

// ── Saver's credit / Schedule 1-A inside the return, boundary AGIs ──────────
describe("return-level boundaries", () => {
  /** A low-income MFJ return: wages only (interest 500 + dividends 1,000 stay), no Schedule C profit. */
  function lowIncome(ericWages: number, evaWages: number): Ty2025Facts {
    const f = fullFacts1b();
    f.income.w2s = [
      w2({ docId: "w2-e", personUserId: ERIC_ID, wagesCents: ericWages * 100, socialSecurityWagesCents: ericWages * 100, medicareWagesCents: ericWages * 100, fedWithheldCents: 300_000, ctWithheldCents: 100_000 }),
      w2({ docId: "w2-v", personUserId: EVA_ID, wagesCents: evaWages * 100, socialSecurityWagesCents: evaWages * 100, medicareWagesCents: evaWages * 100, fedWithheldCents: 200_000, ctWithheldCents: 80_000 }),
    ];
    f.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 0)];
    return f;
  }
  it("AGI exactly 79,000: saver's credit applies at 0.1 (contributions 2,000 each) = 400; AGI 79,001: ineligible 0", () => {
    for (const [ericW, expectedCredit, expectedConclusion] of [[50000, 400, "eligible"], [50001, 0, "ineligible"]] as const) {
      const f = lowIncome(ericW, 27500);
      withPerson(f, ERIC, { deferralsCents: owner(200_000) });
      withPerson(f, EVA, { rothIraCents: owner(200_000), traditionalIraCents: owner(0) });
      const r = computeTy2025Return(f);
      expect(amt(r, "f1040.11a"), `eric ${ericW}`).toBe(ericW + 27500 + 1500);
      expect(amt(r, "sch3.4"), `eric ${ericW}`).toBe(expectedCredit);
      expect(r.results.find((x) => x.ruleId === "saver-8880")?.conclusion, `eric ${ericW}`).toBe(expectedConclusion);
    }
  });
  it("credit flows to Schedule 3 line 8, Form 1040 line 20 and lowers tax after credits by exactly the credit", () => {
    const base = lowIncome(30000, 26500); // AGI 58,000 -> 0.1 band
    const withCredit = lowIncome(30000, 26500);
    withPerson(withCredit, ERIC, { deferralsCents: owner(200_000) });
    withPerson(withCredit, EVA, { traditionalIraCents: owner(0), rothIraCents: owner(200_000) });
    const a = computeTy2025Return(base);
    const b = computeTy2025Return(withCredit);
    expect(amt(a, "sch3.4")).toBe(0);
    expect(amt(b, "sch3.4")).toBe(400);
    expect(amt(b, "sch3.8")).toBe(400);
    expect(amt(b, "f1040.20")).toBe(400);
    expect(amt(a, "f1040.22")! - amt(b, "f1040.22")!).toBe(400);
  });
  it("overtime at return-level MAGI 310,000 -> 19,000 flows to 13b and taxable income", () => {
    const f = fullFacts1b();
    f.income.w2s = [
      w2({ docId: "w2-e", personUserId: ERIC_ID, wagesCents: 20_000_000, socialSecurityWagesCents: 17_610_000, socialSecurityWithheldCents: 1_091_820, medicareWagesCents: 20_000_000, medicareWithheldCents: 290_000, fedWithheldCents: 4_000_000, ctWithheldCents: 500_000 }),
      w2({ docId: "w2-v", personUserId: EVA_ID, wagesCents: 10_850_000, socialSecurityWagesCents: 10_850_000, socialSecurityWithheldCents: 672_700, medicareWagesCents: 10_850_000, medicareWithheldCents: 157_325, fedWithheldCents: 1_500_000, ctWithheldCents: 300_000 }),
    ];
    f.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 0)];
    withPerson(f, ERIC, { overtimeChoice: owner("premium"), overtimeCents: owner(2_000_000), validSsn: owner(true) });
    f.returnAnswers.magiExclusionsNone = owner(true);
    const r = computeTy2025Return(f);
    expect(amt(r, "f1040.11b")).toBe(310000); // 200,000 + 108,500 + 1,500
    expect(amt(r, "sch1a.21")).toBe(19000);
    expect(amt(r, "f1040.13b")).toBe(19000);
  });
});

// ── Forms required, HSA return-level, attestation items ─────────────────────
describe("forms required and open items for the 1b forms", () => {
  it("Schedule 1-A is required exactly when line 38 > 0; Form 8880 only with a computed credit; Form 8889 with employer HSA money even when nothing is deductible", () => {
    const base = computeTy2025Return(fullFacts1b());
    expect(base.formsRequired.sch1a?.required).toBe(false);
    expect(base.formsRequired.f8880?.required).toBe(false);
    expect(base.formsRequired.f8889?.required).toBe(false);
    const f = fullFacts1b();
    withPerson(f, ERIC, { overtimeChoice: owner("premium"), overtimeCents: owner(100_000), validSsn: owner(true) });
    f.returnAnswers.magiExclusionsNone = owner(true);
    expect(computeTy2025Return(f).formsRequired.sch1a?.required).toBe(true);
    // employer HSA contributions (W-2 box 12 code W) with family coverage and no direct contributions: no deduction, Form 8889 still required
    const g = fullFacts1b();
    g.income.w2s[0]!.box12 = [{ code: "W", amountCents: 200_000 }];
    withPerson(g, ERIC, {
      hsaCoverage: owner("family"), hsaMonthsEligible: owner(12), hsaEligibleDec1: owner(true), hsaMedicareOrDependent: owner(false),
      age55Plus: owner(false), hsaDirectContributionsCents: owner(0), hsaEmployerOtherYear: owner(false),
    });
    const rg = computeTy2025Return(g);
    expect(amt(rg, "f8889a.9")).toBe(2000);
    expect(amt(rg, "sch1.13")).toBe(0);
    expect(rg.formsRequired.f8889?.required).toBe(true);
    // W-2 code W with an owner answer of no HDHP coverage is a conflict and blocks the HSA deduction
    const h = fullFacts1b();
    h.income.w2s[0]!.box12 = [{ code: "W", amountCents: 200_000 }];
    const rh = computeTy2025Return(h);
    expect(st(rh, "sch1.13")).toBe("needs_cpa_judgment");
    expect(rh.formsRequired.f8889?.required).toBe("blocking");
  });
  it("attestations: Yes / blank / not sure are blocking items; No is not", () => {
    const f = fullFacts1b();
    f.returnAnswers.attestations = { digitalAssets: owner(true), foreignAccounts: { value: null, basis: null, refs: [] } };
    const r = computeTy2025Return(f);
    expect(r.openItems.filter((o) => o.id.startsWith("attest:") && o.severity === "blocking")).toHaveLength(2);
    expect(computeTy2025Return(fullFacts1b()).openItems.filter((o) => o.id.startsWith("attest:"))).toHaveLength(0);
  });
});

describe("IRA deduction at return level: Worksheet 1-1 MAGI", () => {
  it("MAGI = Form 1040 line 9 minus Schedule 1 lines 11-19a (so after the HSA deduction, before the IRA deduction itself); AGI then falls by the IRA deduction", () => {
    const f = fullFacts1b();
    f.adjustments.hsa = owner(300_000); // stated 3,000 HSA deduction (Schedule 1 line 13)
    withPerson(f, ERIC, { traditionalIraCents: owner(700_000), age50Plus: owner(false), coveredByWorkplacePlan: owner(false) });
    const r = computeTy2025Return(f);
    expect(amt(r, "ira.magi")).toBe(174967); // 177,967 - 3,000, NOT reduced by the IRA deduction
    expect(amt(r, "sch1.20")).toBe(7000);
    expect(amt(r, "f1040.11a")).toBe(167967); // 177,967 - 3,000 - 7,000
  });
  it("covered by a plan at MAGI over 146,000: contribution not deductible, AGI unchanged apart from the HSA", () => {
    const f = fullFacts1b();
    withPerson(f, ERIC, { traditionalIraCents: owner(700_000), age50Plus: owner(false), coveredByWorkplacePlan: owner(true) });
    const r = computeTy2025Return(f);
    expect(amt(r, "sch1.20")).toBe(0);
    expect(amt(r, "f1040.11a")).toBe(177967);
  });
});

// ── Questionnaire: tree integrity ───────────────────────────────────────────
describe("Return completeness questionnaire: tree integrity", () => {
  const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
  const ctx = RC_CONTEXT;

  /** Walk the tree answering every visible question with `pick`; returns the effective answers. */
  function walk(pick: (node: (typeof def.nodes)[number]) => AnswerValue): EffectiveAnswers {
    const answers: EffectiveAnswers = {};
    for (let guard = 0; guard < 500; guard++) {
      const next = visibleNodes(def, ctx, answers).find((n) => answers[n.id] === undefined);
      if (!next) return answers;
      answers[next.id] = { value: pick(next), source: "questionnaire", at: null, by: null };
    }
    throw new Error("a path did not terminate");
  }
  const noneOrNo = (n: (typeof def.nodes)[number]): AnswerValue => {
    if (isChoiceNodeForTests(n)) {
      const ids = n.options.map((o) => o.id);
      for (const want of ["none", "no"]) if (ids.includes(want)) return want;
      return ids[0]!;
    }
    return n.min;
  };

  it("definition validates (ids, sources, unsure options, copy rules, reachability)", () => {
    expect(validateDefinition(def, SOURCE_IDS)).toEqual([]);
    expect(QUESTIONNAIRES.filter((q) => q.id === RETURN_COMPLETENESS_ID)).toHaveLength(1);
  });
  it("the all-none path is ~45 questions (the report says 45 of 107 nodes) and terminates", () => {
    const a = walk(noneOrNo);
    expect(Object.keys(a).length).toBeGreaterThanOrEqual(40);
    expect(Object.keys(a).length).toBeLessThanOrEqual(50);
    expect(def.nodes.length).toBe(115); // 109 + utbuy2 (round 2) + the four SE health / retirement nodes (round 3) + div2b (round 4)
  });
  it("every showWhen references only EARLIER nodes (no dangling / forward reference) and the unsure option exists on every choice node", () => {
    const idx = new Map(def.nodes.map((n, i) => [n.id, i]));
    const refs = (c: unknown, out: string[]): void => {
      const x = c as { kind: string; node?: string; of?: unknown[] };
      if (x.kind === "in" || x.kind === "hidden") out.push(x.node!);
      else for (const y of x.of ?? []) refs(y, out);
    };
    def.nodes.forEach((n, i) => {
      if (!n.showWhen) return;
      const out: string[] = [];
      refs(n.showWhen, out);
      for (const r of out) {
        expect(idx.has(r), `${n.id} -> ${r}`).toBe(true);
        expect(idx.get(r)!, `${n.id} -> ${r}`).toBeLessThan(i);
      }
    });
    for (const n of def.nodes) if (isChoiceNodeForTests(n)) expect(n.options.some((o) => o.id === UNSURE_ID)).toBe(true);
  });
  it("covering walks realise every option of every question; every walk terminates", () => {
    const paths = coveringAnswerPaths(def, ctx);
    expect(paths.length).toBeGreaterThan(2);
    const seen = new Set<string>();
    for (const p of paths) for (const [id, a] of Object.entries(p)) seen.add(`${id}:${Array.isArray(a.value) ? a.value.join("+") : String(a.value)}`);
    for (const n of def.nodes) {
      if (!isChoiceNodeForTests(n)) {
        expect([...seen].some((s) => s.startsWith(`${n.id}:`)), `${n.id} never shown`).toBe(true);
        continue;
      }
      for (const o of n.options) expect(seen.has(`${n.id}:${o.id}`), `${n.id}:${o.id} unreachable`).toBe(true);
    }
  });
  it("each of the 14 stated-none groups has exactly one g_ question and one ga_ amount node, and every NoneGroupId has line-catalog text", () => {
    expect(NONE_GROUP_IDS).toHaveLength(14);
    const ids = new Set(def.nodes.map((n) => n.id));
    for (const g of NONE_GROUP_IDS) {
      expect(ids.has(`g_${g}`), g).toBe(true);
      expect(ids.has(`ga_${g}`), g).toBe(true);
      expect(NONE_GROUP_TEXT[g].length, g).toBeGreaterThan(10);
      expect(LINE_CATALOG.some((m) => m.group === g), `${g} gates at least one catalog line`).toBe(true);
    }
    expect(def.nodes.filter((n) => n.id.startsWith("g_"))).toHaveLength(14);
  });
  it("no new file uses window.confirm", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "..", "..");
    const files = ["lib/tax2025/answers.ts", "lib/tax2025/answer-state.ts", "lib/tax-questionnaire-content.ts", "lib/tax-questionnaire.ts", "lib/tax-forms.ts"];
    for (const dir of ["lib/tax2025/rules"]) for (const f of readdirSync(join(root, dir))) files.push(`${dir}/${f}`);
    for (const f of files) expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/window\.confirm|\bconfirm\(/);
    void statSync;
  });
});

// ── Answers -> facts: units, matching, none statements, leakage ─────────────
describe("answers.ts: answers -> facts", () => {
  const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
  const people = [
    { userId: ERIC_ID, name: "Eric Kinniburgh" },
    { userId: EVA_ID, name: "Eva-Laura Ramirez-Wisiackas" },
  ];
  const ea = (m: Record<string, AnswerValue>): EffectiveAnswers => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: v, source: "questionnaire" as const, at: null, by: null }]));

  it("units: dollars are CENTS in the answer and CENTS in the facts leaf; months stay a plain integer; the engine converts to dollars", () => {
    const p = parseCompletenessAnswers(
      ea({ def_eric: "some", defamt_eric: 1_234_500, hsa_eric: "self_only", hsam_eric: 7, hsadir_eric: 250_000, ira_eric: "some", tira_eric: 600_000, roth_eric: 100_000, tips_eva: "some", tipsamt_eva: 1_800_000 }),
      people
    );
    const e = p.returnAnswers.people[0]!;
    expect(e.deferralsCents.value).toBe(1_234_500);
    expect(e.hsaMonthsEligible.value).toBe(7);
    expect(e.hsaDirectContributionsCents.value).toBe(250_000);
    expect(e.traditionalIraCents.value).toBe(600_000);
    expect(e.rothIraCents.value).toBe(100_000);
    expect(p.returnAnswers.people[1]!.tipsCents.value).toBe(1_800_000);
  });
  it("end to end: Eva's 18,000 of tips typed as dollars flows to Schedule 1-A line 4c = 18,000 (not 180 or 1,800,000)", () => {
    const parsed = parseCompletenessAnswers(ea({ tips_eva: "some", tipsamt_eva: 1_800_000, ssn_eva: "yes", pr: "no" }), people);
    const f = fullFacts1b();
    const eva = f.returnAnswers.people[1]!;
    eva.tipsChoice = parsed.returnAnswers.people[1]!.tipsChoice;
    eva.tipsCents = parsed.returnAnswers.people[1]!.tipsCents;
    eva.validSsn = parsed.returnAnswers.people[1]!.validSsn;
    f.returnAnswers.magiExclusionsNone = parsed.returnAnswers.magiExclusionsNone;
    const r = computeTy2025Return(f);
    expect(amt(r, "sch1a.4c")).toBe(18000);
    expect(amt(r, "sch1a.13")).toBe(18000);
  });
  it("people are matched by an EXACT first-name token (round 2, L5): unmatched, duplicate and look-alike names -> userId null, never first-wins", () => {
    const unmatched = parseCompletenessAnswers({}, [{ userId: "u1", name: "Eric K" }]);
    expect(unmatched.returnAnswers.people[0]!.userId).toBe("u1");
    expect(unmatched.returnAnswers.people[1]!.userId).toBeNull();
    const dup = parseCompletenessAnswers({}, [{ userId: "u1", name: "Eric K" }, { userId: "u2", name: "Eric Sr" }, { userId: "u3", name: "Eva" }]);
    expect(dup.returnAnswers.people[0]!.userId).toBeNull(); // ambiguous: two Erics
    expect(dup.returnAnswers.people[1]!.userId).toBe("u3");
    const evan = parseCompletenessAnswers({}, [{ userId: "u1", name: "Eric K" }, { userId: "u9", name: "Evan Smith" }]);
    expect(evan.returnAnswers.people[1]!.userId).toBeNull(); // "Evan" is not "eva"
    const reversed = parseCompletenessAnswers({}, [{ userId: "u1", name: "Kinniburgh, Eric" }, { userId: "u3", name: "Ramirez, Eva" }]);
    expect(reversed.returnAnswers.people[0]!.userId).toBeNull(); // "Last, First" order is not matched
  });
  it("stated-none mapping: none -> true, some -> false, not sure / unanswered -> absent (line stays open)", () => {
    const g = NONE_GROUP_IDS;
    const p = parseCompletenessAnswers(ea({ [`g_${g[0]}`]: "none", [`g_${g[1]}`]: "some", [`ga_${g[1]}`]: 50_000, [`g_${g[2]}`]: UNSURE_ID }), people);
    expect(p.statedNone[g[0]!]).toBe(true);
    expect(p.statedNone[g[1]!]).toBe(false);
    expect(g[2]! in p.statedNone).toBe(false);
    expect(g[3]! in p.statedNone).toBe(false);
    expect(p.returnAnswers.statedSomeAmounts[g[1]!]?.value).toBe(50_000);
  });
  it("all-none answers set statedNone for exactly the 14 groups and the engine finishes the rare lines as explicit not_applicable zeros", () => {
    const answers: EffectiveAnswers = {};
    for (const gid of NONE_GROUP_IDS) answers[`g_${gid}`] = { value: "none", source: "questionnaire", at: null, by: null };
    const p = parseCompletenessAnswers(answers, people);
    expect(Object.keys(p.statedNone).sort()).toEqual([...NONE_GROUP_IDS].sort());
    expect(Object.values(p.statedNone).every((v) => v === true)).toBe(true);
  });
  it("hidden answers never leak: a stored answer for a node that is hidden is ignored", () => {
    // tira_eric is hidden unless ira_eric = some; a stale stored value must not become the traditional IRA amount
    const p = parseCompletenessAnswers(ea({ ira_eric: "none", tira_eric: 700_000, roth_eric: 500_000 }), people);
    expect(p.returnAnswers.people[0]!.traditionalIraCents.value).toBe(0);
    expect(p.returnAnswers.people[0]!.rothIraCents.value).toBe(0);
    const p2 = parseCompletenessAnswers(ea({ car: "none", carint: 900_000, carq: "yes" }), people);
    expect(p2.returnAnswers.carLoan.interestPaidCents.value).toBeNull();
    expect(p2.returnAnswers.carLoan.qualifies.value).toBeNull();
    const p3 = parseCompletenessAnswers(ea({ fe: "none", fe1: 500_000 }), people);
    expect(p3.federalEstimates).toEqual([]);
  });
  it("fuzz: parsing the full random answer set equals parsing only the VISIBLE answers (no hidden answer reaches a fact)", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let iter = 0; iter < 400; iter++) {
      const all: EffectiveAnswers = {};
      for (const n of def.nodes) {
        if (rnd() < 0.15) continue; // leave some unanswered
        let value: AnswerValue;
        if (isChoiceNodeForTests(n)) value = n.options[Math.floor(rnd() * n.options.length)]!.id;
        else value = rnd() < 0.1 ? UNSURE_ID : Math.floor(rnd() * (n.kind === "dollars" ? 5_000_000 : 13));
        all[n.id] = { value, source: "questionnaire", at: null, by: null };
      }
      const vis = new Set(visibleNodes(def, RC_CONTEXT, all).map((n) => n.id));
      const pruned: EffectiveAnswers = Object.fromEntries(Object.entries(all).filter(([id]) => vis.has(id)));
      expect(JSON.stringify(parseCompletenessAnswers(all, people))).toBe(JSON.stringify(parseCompletenessAnswers(pruned, people)));
    }
  });
  it("estimated payments: five windows, each recorded with the window's date; an unanswered window leaves the whole list unknown (never a partial list)", () => {
    const m: Record<string, AnswerValue> = { fe: "some" };
    for (const w of RC_PAYMENT_WINDOWS) m[`fe${w.n}`] = w.n === "3" ? 0 : 100_000 * Number(w.n);
    const full = parseCompletenessAnswers(ea(m), people);
    expect(full.federalEstimates).toEqual([
      { paidOn: "2025-04-15", amountCents: 100_000, appliesToTaxYear: 2025 },
      { paidOn: "2025-06-15", amountCents: 200_000, appliesToTaxYear: 2025 },
      { paidOn: "2025-12-31", amountCents: 400_000, appliesToTaxYear: 2025 },
      { paidOn: "2026-01-15", amountCents: 500_000, appliesToTaxYear: 2025 },
    ]);
    delete m.fe4;
    expect(parseCompletenessAnswers(ea(m), people).federalEstimates).toBeUndefined();
  });
});

// ── The all-none questionnaire path, end to end ─────────────────────────────
describe("all-none questionnaire path -> parse -> engine", () => {
  const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
  const people = [
    { userId: ERIC_ID, name: "Eric Kinniburgh" },
    { userId: EVA_ID, name: "Eva-Laura Ramirez-Wisiackas" },
  ];
  function allNone(overrides: Record<string, AnswerValue> = {}): EffectiveAnswers {
    const answers: EffectiveAnswers = {};
    for (let guard = 0; guard < 500; guard++) {
      const next = visibleNodes(def, RC_CONTEXT, answers).find((n) => answers[n.id] === undefined);
      if (!next) break;
      let value: AnswerValue;
      if (overrides[next.id] !== undefined) value = overrides[next.id]!;
      else if (next.kind === "single" || next.kind === "multi") {
        const ids = (next as ChoiceNode).options.map((o) => o.id);
        value = ids.find((x) => x === "none" || x === "no") ?? ids[0]!;
      } else value = (next as Exclude<QNode, ChoiceNode>).min;
      answers[next.id] = { value, source: "questionnaire", at: null, by: null };
    }
    return answers;
  }
  function engineFrom(answers: EffectiveAnswers): Ty2025Return {
    const parsed = parseCompletenessAnswers(answers, people);
    const f = fullFacts();
    f.adjustments = { sch1a: { value: null, basis: null, refs: [] }, hsa: { value: null, basis: null, refs: [] }, ira: { value: null, basis: null, refs: [] }, seRetirement: owner(0), seHealthInsurance: owner(0) };
    f.credits = { foreignTax: { value: null, basis: null, refs: [] }, savers: { value: null, basis: null, refs: [] } };
    f.ct.useTax = { value: null, basis: null, refs: [] };
    f.statedNone = {};
    for (const [g, v] of Object.entries(parsed.statedNone)) f.statedNone[g as keyof typeof f.statedNone] = owner(v);
    f.payments.federalEstimates = parsed.federalEstimates ? owner(parsed.federalEstimates) : { value: null, basis: null, refs: [] };
    f.payments.ctEstimates = parsed.ctEstimates ? owner(parsed.ctEstimates) : { value: null, basis: null, refs: [] };
    f.payments.federalExtensionPayment = parsed.federalExtensionPaymentCents !== undefined ? owner(parsed.federalExtensionPaymentCents) : { value: null, basis: null, refs: [] };
    f.payments.ctExtensionPayment = parsed.ctExtensionPaymentCents !== undefined ? owner(parsed.ctExtensionPaymentCents) : { value: null, basis: null, refs: [] };
    f.payments.federalPriorYearOverpaymentApplied = parsed.federalOverpaymentAppliedCents !== undefined ? owner(parsed.federalOverpaymentAppliedCents) : { value: null, basis: null, refs: [] };
    f.payments.ctPriorYearOverpaymentApplied = parsed.ctOverpaymentAppliedCents !== undefined ? owner(parsed.ctOverpaymentAppliedCents) : { value: null, basis: null, refs: [] };
    f.payments.ctPriorYearBalancePaidIn2025 = parsed.ctPriorYearBalancePaidIn2025Cents !== undefined ? owner(parsed.ctPriorYearBalancePaidIn2025Cents) : { value: null, basis: null, refs: [] };
    f.returnAnswers = parsed.returnAnswers;
    f.priorYear = { totalTaxCents: owner(2_000_000), agiCents: owner(12_000_000), filingStatus: owner("mfj") };
    return computeTy2025Return(f);
  }
  it("with 'No' to everything except 'was the 2024 return joint' the golden numbers reproduce from the REAL parse (federal 27,015, CT tax 8,788), the headline is complete, and no 1b line is blocked", () => {
    const r = engineFrom(allNone({ pyjoint: "yes" }));
    expect(r.headline.federal.totalTax.amount).toBe(27015);
    expect(r.headline.connecticut.tax.amount).toBe(8788);
    expect(r.headline.complete).toBe(true);
    for (const k of ["sch1a.38", "std.total", "sch1.13", "sch1.20", "sch3.1", "sch3.4", "ct1040.15", "f1040.38"] as const) expect(hasAmount(st(r, k)!), k).toBe(true);
    expect(amt(r, "f1040.38")).toBe(233);
    expect(r.openItems.filter((o) => o.severity === "blocking").map((o) => o.id)).toEqual(expect.not.arrayContaining(["return-completeness-not-started"]));
  });
  it("answering 'No' to 'was the 2024 return a joint return' (the naive all-No path) hands the Form 2210 estimate to the CPA instead of guessing (advisory only)", () => {
    const r = engineFrom(allNone());
    expect(amt(r, "f2210.19")).toBeNull();
    expect(r.openItems.find((o) => o.id === "rule:penalty-2210-estimate")?.severity).toBe("advisory");
    expect(r.headline.complete).toBe(true);
  });
  it("a single 'Not sure' on the blind box blocks the headline; a 'Yes' to a rare-line group (some) blocks only that group's lines", () => {
    const blind = engineFrom(allNone({ pyjoint: "yes", blind_eric: UNSURE_ID }));
    expect(blind.headline.complete).toBe(false);
    expect(amt(blind, "f1040.12e")).toBeNull();
    const some = engineFrom(allNone({ pyjoint: "yes", g_other_income: "some" }));
    expect(st(some, "f1040.7b")).toBeDefined();
    expect(some.lines["sch1.8z"] === undefined || !hasAmount(some.lines["sch1.8z"]!.status)).toBe(true);
    expect(some.headline.complete).toBe(false);
  });
});

// ── No silent zero over the 1b answer space ─────────────────────────────────
describe("no silent zero: fuzz the 1b answer space", () => {
  const OWNER_REF = [{ kind: "questionnaire" as const, id: "return-completeness.x", label: "x" }];
  const leaf = <T,>(v: T) => ({ value: v, basis: "answer_owner" as const, refs: OWNER_REF });
  const NONE = { value: null, basis: null, refs: [] };
  const UNS = { value: null, basis: "answer_owner" as const, refs: OWNER_REF };
  let seed = 987654;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const maybe = <T,>(v: () => T) => {
    const r = rnd();
    return r < 0.12 ? NONE : r < 0.22 ? UNS : leaf(v());
  };
  const money = () => pick([0, 0, 100_00, 2_500_00, 6_000_00, 12_345_00, 27_000_00]);

  function randomFacts(): Ty2025Facts {
    const f = rnd() < 0.5 ? fullFacts1b() : fullFacts();
    // fullFacts() removes none of the stated overrides: clear them half the time so the rules run
    if (rnd() < 0.7) {
      f.adjustments.sch1a = NONE;
      f.adjustments.hsa = NONE;
      f.adjustments.ira = NONE;
      f.credits.foreignTax = NONE;
      f.credits.savers = NONE;
      f.ct.useTax = NONE;
    }
    for (const p of f.returnAnswers.people) {
      p.bornBefore1961 = maybe(() => rnd() < 0.3);
      p.blind = maybe(() => rnd() < 0.1);
      p.age50Plus = maybe(() => rnd() < 0.5);
      p.age55Plus = maybe(() => rnd() < 0.5);
      p.validSsn = maybe(() => rnd() < 0.9);
      p.coveredByWorkplacePlan = maybe(() => rnd() < 0.5);
      p.deferralsCents = maybe(money);
      p.traditionalIraCents = maybe(money);
      p.rothIraCents = maybe(money);
      p.hsaCoverage = maybe(() => pick(["none", "self_only", "family", "changed"] as const));
      p.hsaMonthsEligible = maybe(() => pick([0, 3, 6, 12]));
      p.hsaEligibleDec1 = maybe(() => rnd() < 0.5);
      p.hsaMedicareOrDependent = maybe(() => rnd() < 0.2);
      p.hsaDirectContributionsCents = maybe(money);
      p.hsaEmployerOtherYear = maybe(() => rnd() < 0.2);
      p.hsaDistributions = maybe(() => pick(["none", "some"] as const));
      p.tipsChoice = maybe(() => pick(["none", "some", "ask_employer"] as const));
      p.tipsCents = maybe(money);
      p.overtimeChoice = maybe(() => pick(["none", "premium", "total", "ask_employer"] as const));
      p.overtimeCents = maybe(money);
    }
    const ra = f.returnAnswers;
    ra.retirementDistributionSince2022 = maybe(() => rnd() < 0.2);
    ra.studentOrDependent = maybe(() => rnd() < 0.1);
    ra.magiExclusionsNone = maybe(() => rnd() < 0.9);
    ra.carLoan = { choice: maybe(() => pick(["none", "some"] as const)), qualifies: maybe(() => rnd() < 0.8), interestPaidCents: maybe(money), deductedElsewhereCents: maybe(money) };
    ra.attestations = { digitalAssets: maybe(() => rnd() < 0.1), foreignAccounts: maybe(() => rnd() < 0.1) };
    ra.priorYear = { filedJoint: maybe(() => rnd() < 0.9), hadExcludedTaxOrRefundable: maybe(() => rnd() < 0.2) };
    ra.useTax = { choice: maybe(() => pick(["none", "some"] as const)), generalRatePurchasesCents: maybe(money), otherRateItems: maybe(() => rnd() < 0.2), taxPaidToOtherStateCents: maybe(money) };
    if (rnd() < 0.3) f.priorYear = { totalTaxCents: NONE, agiCents: NONE, filingStatus: NONE };
    if (rnd() < 0.3) f.payments.federalEstimates = NONE;
    if (rnd() < 0.2) f.income.w2s = [];
    if (rnd() < 0.2) for (const k of Object.keys(f.statedNone)) if (rnd() < 0.5) delete (f.statedNone as Record<string, unknown>)[k];
    return f;
  }

  it("1,500 random 1b answer states: never throws; a line has an amount iff its status carries one; every non-computed line states why; amounts are integers", () => {
    for (let i = 0; i < 1500; i++) {
      const f = randomFacts();
      const r = computeTy2025Return(f);
      for (const l of Object.values(r.lines)) {
        if (!l) continue;
        if (hasAmount(l.status)) {
          expect(Number.isInteger(l.amount), `${l.key} amount`).toBe(true);
        } else {
          expect(l.amount, `${l.key} blocked line has an amount (silent zero)`).toBeNull();
          expect(l.reason && l.reason.length > 0, `${l.key} blocked without a reason`).toBe(true);
        }
        if (l.status === "not_applicable") expect(l.reason && l.reason.length > 0, `${l.key} n/a without reason`).toBe(true);
      }
    }
  }, 120_000);

  it("1b lines always exist with an explicit status; a 'some' / 'ask the employer' / 'not sure' answer never yields a computed deduction", () => {
    const keys1b: LineKey[] = ["sch1a.38", "f1040.13b", "sch1.13", "sch1.20", "sch3.1", "sch3.4", "f2210.19", "f1040.38", "ct1040.15", "std.total", "f1040.12e"];
    for (let i = 0; i < 2000; i++) {
      const r = computeTy2025Return(randomFacts());
      for (const k of keys1b) {
        expect(r.lines[k], k).toBeDefined();
        expect(r.lines[k]!.status, k).toBeTruthy();
      }
    }
    // targeted: tips "ask_employer" with an amount typed anyway must still block
    const f = fullFacts1b();
    withPerson(f, ERIC, { tipsChoice: owner("ask_employer"), tipsCents: owner(500_000) });
    const r = computeTy2025Return(f);
    expect(amt(r, "sch1a.13")).toBeNull();
    expect(amt(r, "f1040.13b")).toBeNull();
    expect(amt(r, "f1040.15")).toBeNull();
  });

  it("the empty facts object (nothing answered) is total: nothing throws, nothing is a silent zero, and a blocking item exists", () => {
    const r = computeTy2025Return(emptyFacts());
    for (const l of Object.values(r.lines)) {
      if (!l) continue;
      if (!hasAmount(l.status)) {
        expect(l.amount, l.key).toBeNull();
        expect(l.reason, l.key).toBeTruthy();
      }
    }
    for (const k of ["sch1a.38", "std.total", "sch1.13", "sch1.20", "sch3.4", "ct1040.15"] as const) expect(hasAmount(st(r, k)!), k).toBe(false);
    expect(r.openItems.some((o) => o.severity === "blocking")).toBe(true);
    expect(r.headline.complete).toBe(false);
  });
});

// ── Purity / scope ──────────────────────────────────────────────────────────
describe("scope", () => {
  it("lib/tax2025/** imports no prisma client runtime, db, next or fs (transitive walk from every file)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join, resolve, dirname } = await import("node:path");
    const root = resolve(__dirname, "..", "..");
    const listing = (d: string): string[] => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listing(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    // The PDF layer (lib/tax2025/pdf/**) legitimately uses pdf-lib/fflate/node built-ins and has its own purity test;
    // this test guards the RULES.
    const start = listing("lib/tax2025").filter((f) => f.endsWith(".ts") && !f.startsWith("lib/tax2025/pdf/"));
    const seen = new Set<string>();
    const bad: string[] = [];
    const resolveImport = (from: string, spec: string): string | null => {
      let p: string;
      if (spec.startsWith("@/")) p = spec.slice(2);
      else if (spec.startsWith(".")) p = join(dirname(from), spec).replace(/\\/g, "/");
      else return null;
      for (const c of [`${p}.ts`, `${p}/index.ts`, p]) {
        try {
          readFileSync(join(root, c), "utf8");
          return c.replace(/\\/g, "/");
        } catch {
          /* next */
        }
      }
      return null;
    };
    const visit = (f: string): void => {
      if (seen.has(f)) return;
      seen.add(f);
      const src = readFileSync(join(root, f), "utf8");
      for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (/^(next|react|node:|fs$|path$|@\/lib\/db|@\/lib\/prisma|@prisma\/client$)/.test(spec) || spec === "@/lib/db") bad.push(`${f} -> ${spec}`);
        const r = resolveImport(f, spec);
        if (r) visit(r);
      }
    };
    for (const f of start) visit(f);
    expect(bad).toEqual([]);
    expect(seen.size).toBeGreaterThan(20);
  });
});
