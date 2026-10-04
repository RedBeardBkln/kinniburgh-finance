import { describe, it, expect } from "vitest";
import {
  QUESTIONNAIRES,
  questionnaireById,
  SOURCES,
} from "@/lib/tax-questionnaire-content";
import {
  buildCardState,
  buildSummary,
  computeOutcome,
  computeStatus,
  effectiveAnswers,
  coveringAnswerPaths,
  enumerateAnswerPaths,
  isUnsureValue,
  nodeOptions,
  parseStoredAnswers,
  resolveBoundWrite,
  resolveQuestionnaireScope,
  validateAnswerValue,
  visibleNodes,
  UNSURE_ID,
  type AnswerValue,
  type ChoiceNode,
  type Cond,
  type EffectiveAnswers,
  type NumberNode,
  type PlanningAnswerInput,
  type QNode,
  type QuestionnaireContext,
  type QuestionnaireDef,
  type QuestionnaireRowInput,
  type ScopeEntity,
} from "@/lib/tax-questionnaire";
import {
  buildFormsPageData,
  listQuestionnaireEntries,
  type FormEntry,
  type FormsCatalogInput,
  type FormsDocumentInput,
  type FormsEntityInput,
  type FormsPageData,
  type TaxDraftSummary,
} from "@/lib/tax-forms";
import { parseDollarAnswerToCents, parseSqftAnswer } from "@/lib/tax-compute-build";

// ── Tester probe (independent of the Coder's tests): engine invariants, content
//    graph, parser agreement, Forms-page enumeration and differential. ─────────

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isChoice = (n: QNode): n is ChoiceNode => n.kind === "single" || n.kind === "multi";

const CTXS: QuestionnaireContext[] = [];
for (const ekcActive of [true, false]) for (const svActive of [true, false]) {
  CTXS.push({ year: 2025, entityName: "Test Entity LLC", ekcActive, svActive });
}

function randomValue(node: QNode, ctx: QuestionnaireContext, r: () => number): AnswerValue {
  if (isChoice(node)) {
    const opts = nodeOptions(node, ctx);
    if (node.kind === "single") return opts[Math.floor(r() * opts.length)]!.id;
    const plain = opts.filter((o) => !o.unsure && !o.exclusive);
    const excl = opts.filter((o) => o.unsure || o.exclusive);
    if (r() < 0.25 && excl.length) return [excl[Math.floor(r() * excl.length)]!.id];
    const pick = plain.filter(() => r() < 0.5);
    return pick.length ? pick.map((o) => o.id) : [plain[0]!.id];
  }
  if (r() < 0.2) return UNSURE_ID;
  const n = node as NumberNode;
  const v = n.min + Math.floor(r() * Math.min(1000, n.max - n.min + 1));
  return n.kind === "dollars" ? v * 100 : v;
}

function randomFull(def: QuestionnaireDef, ctx: QuestionnaireContext, r: () => number): EffectiveAnswers {
  const out: EffectiveAnswers = {};
  for (const n of def.nodes) {
    out[n.id] = { value: randomValue(n, ctx, r), source: "questionnaire", at: "2026-10-03T12:00:00.000Z", by: null };
  }
  return out;
}

describe("engine invariants over every definition (random answer states)", () => {
  for (const def of QUESTIONNAIRES) {
    it(`${def.id}: hidden answers never leak into status, facts, open questions or outcome`, () => {
      const r = mulberry32(1234 + def.id.length);
      for (const ctx of CTXS) {
        for (let i = 0; i < 300; i++) {
          const full = randomFull(def, ctx, r);
          const vis = visibleNodes(def, ctx, full);
          const visIds = new Set(vis.map((n) => n.id));
          const stripped: EffectiveAnswers = {};
          for (const id of visIds) stripped[id] = full[id]!;

          const s1 = buildSummary(def, ctx, full, "n");
          const s2 = buildSummary(def, ctx, stripped, "n");
          expect(s1).toEqual(s2);
          expect(computeOutcome(def, ctx, full)).toBe(computeOutcome(def, ctx, stripped));
          expect(computeStatus(def, ctx, full)).toEqual(computeStatus(def, ctx, stripped));
          for (const f of s1.facts) expect(visIds.has(f.nodeId)).toBe(true);
          expect(s1.facts.length).toBe(visIds.size); // all visible answered
          // form-4562 with BOTH entity flags off shows nothing at all (its card cannot exist then)
          expect(s1.status.kind).toBe(vis.length === 0 ? "not_started" : "answered");
        }
      }
    });

    it(`${def.id}: flipping an upstream answer hides dependents and flipping back restores the exact summary`, () => {
      const r = mulberry32(99 + def.nodes.length);
      const ctx = CTXS[0]!;
      for (let i = 0; i < 200; i++) {
        const base = randomFull(def, ctx, r);
        const k = def.nodes[Math.floor(r() * def.nodes.length)]!;
        const alt = randomValue(k, ctx, r);
        const flipped: EffectiveAnswers = { ...base, [k.id]: { ...base[k.id]!, value: alt } };
        const back: EffectiveAnswers = { ...flipped, [k.id]: base[k.id]! };
        expect(buildSummary(def, ctx, back, null)).toEqual(buildSummary(def, ctx, base, null));
        const visF = new Set(visibleNodes(def, ctx, flipped).map((n) => n.id));
        for (const f of buildSummary(def, ctx, flipped, null).facts) expect(visF.has(f.nodeId)).toBe(true);
      }
    });
  }
});

// ── Independent static graph checks (do not use validateDefinition) ───────────

function condRefs(c: Cond, out: { node: string; values?: readonly string[] }[]): void {
  if (c.kind === "in") out.push({ node: c.node, values: c.values });
  else if (c.kind === "hidden") out.push({ node: c.node });
  else for (const x of c.of) condRefs(x, out);
}

describe("content graph (own walker)", () => {
  for (const def of QUESTIONNAIRES) {
    it(`${def.id}: showWhen only references EARLIER nodes; no dangling node/option refs`, () => {
      const idx = new Map(def.nodes.map((n, i) => [n.id, i]));
      expect(idx.size).toBe(def.nodes.length);
      def.nodes.forEach((n, i) => {
        if (!n.showWhen) return;
        const refs: { node: string; values?: readonly string[] }[] = [];
        condRefs(n.showWhen, refs);
        for (const ref of refs) {
          const j = idx.get(ref.node);
          expect(j, `${def.id}.${n.id} -> ${ref.node}`).toBeDefined();
          expect(j!, `${def.id}.${n.id} forward ref ${ref.node}`).toBeLessThan(i);
          if (ref.values) {
            const t = def.nodes[j!]!;
            expect(isChoice(t)).toBe(true);
            const ids = new Set((t as ChoiceNode).options.map((o) => o.id));
            for (const v of ref.values) expect(ids.has(v), `${def.id}.${n.id}: ${ref.node} has no ${v}`).toBe(true);
          }
        }
      });
      for (const rule of def.outcomeRules) {
        const refs: { node: string; values?: readonly string[] }[] = [];
        condRefs(rule.when, refs);
        for (const ref of refs) expect(idx.has(ref.node)).toBe(true);
      }
    });

    it(`${def.id}: every path terminates, resolves an outcome, in every context combination; every option selectable; every rule can fire`, () => {
      const firedRules = new Set<number>();
      const outcomesSeen = new Set<string>();
      const nodeSeenVisible = new Set<string>();
      const condValueSeen = new Set<string>(); // "node:value" required by some Cond and realised on a path
      const wanted: string[] = [];
      for (const n of def.nodes) {
        if (!n.showWhen) continue;
        const refs: { node: string; values?: readonly string[] }[] = [];
        condRefs(n.showWhen, refs);
        for (const ref of refs) for (const v of ref.values ?? []) wanted.push(`${ref.node}:${v}`);
      }
      for (const rule of def.outcomeRules) {
        const refs: { node: string; values?: readonly string[] }[] = [];
        condRefs(rule.when, refs);
        for (const ref of refs) for (const v of ref.values ?? []) wanted.push(`${ref.node}:${v}`);
      }
      for (const ctx of CTXS) {
        // The Return completeness flow is a long chain of independent sections: its full cartesian product is
        // astronomically large, so its paths are the engine's covering walks (every option of every shown node).
        const large = def.id === "return-completeness";
        const { paths, truncated } = large ? { paths: coveringAnswerPaths(def, ctx), truncated: false } : enumerateAnswerPaths(def, ctx, 50000);
        expect(truncated, `${def.id} truncated`).toBe(false);
        expect(paths.length).toBeGreaterThan(0);
        for (const p of paths) {
          const vis = visibleNodes(def, ctx, p);
          const st = computeStatus(def, ctx, p);
          if (vis.length === 0) {
            expect(st.kind).toBe("not_started");
            continue;
          }
          expect(st.kind).toBe("answered");
          const o = computeOutcome(def, ctx, p);
          expect(["applies", "not_applies", "unsure"]).toContain(o);
          outcomesSeen.add(o);
          // which rule fired (re-evaluate by running rules one by one using a def with only that rule)
          for (let i = 0; i < def.outcomeRules.length; i++) {
            const solo: QuestionnaireDef = { ...def, outcomeRules: [def.outcomeRules[i]!], outcomeDefault: o === "applies" ? "not_applies" : "applies" };
            const earlier: QuestionnaireDef = { ...def, outcomeRules: def.outcomeRules.slice(0, i), outcomeDefault: "unsure" };
            const soloOutcome = computeOutcome(solo, ctx, p);
            const matches = soloOutcome === def.outcomeRules[i]!.outcome && soloOutcome !== solo.outcomeDefault;
            // earlier rules must not match for rule i to be the first match
            const e = def.outcomeRules.slice(0, i).some((er) => {
              const t: QuestionnaireDef = { ...def, outcomeRules: [er], outcomeDefault: er.outcome === "applies" ? "not_applies" : "applies" };
              return computeOutcome(t, ctx, p) === er.outcome;
            });
            void earlier;
            if (matches && !e) firedRules.add(i);
          }
          for (const n of vis) {
            nodeSeenVisible.add(n.id);
            const a = p[n.id]!;
            if (isChoice(n)) {
              const ids = Array.isArray(a.value) ? a.value : [a.value as string];
              for (const id of ids) condValueSeen.add(`${n.id}:${id}`);
            }
          }
        }
      }
      for (const n of def.nodes) {
        // a node gated by context in every ctx would never be visible; at least one ctx must show it
        expect(nodeSeenVisible.has(n.id), `${def.id}.${n.id} never visible`).toBe(true);
      }
      for (const w of wanted) expect(condValueSeen.has(w), `${def.id}: cond value ${w} never realised`).toBe(true);
      // report rules that can never be the first match (dead rules)
      const dead = def.outcomeRules.map((_, i) => i).filter((i) => !firedRules.has(i));
      expect(dead, `${def.id} dead outcome rules`).toEqual([]);
      // every outcome that has copy and is reachable; unreachable ones documented below
      const unreachable = (["applies", "not_applies", "unsure"] as const).filter((o) => !outcomesSeen.has(o));
      if (def.id === "k1-handling") expect(unreachable).toEqual(["not_applies"]);
    });
  }
});

// ── Numeric / multi-select edges ──────────────────────────────────────────────

describe("validateAnswerValue edge cases", () => {
  const ho5 = questionnaireById("form-8829")!.nodes.find((n) => n.id === "ho5") as NumberNode;
  const ut3 = questionnaireById("form-2210")!.nodes.find((n) => n.id === "ut3") as NumberNode;
  const cd2 = questionnaireById("child-dependent-credits")!.nodes.find((n) => n.id === "cd2") as NumberNode;
  const s34 = questionnaireById("schedule-3-federal")!.nodes.find((n) => n.id === "s34") as ChoiceNode;
  const qb1 = questionnaireById("qbi-deduction")!.nodes.find((n) => n.id === "qb1") as ChoiceNode;

  it("whole-number node bounds and junk", () => {
    for (const bad of [0, -1, 100000, 1.5, NaN, Infinity, -Infinity, "12", "unsure ", "", null, undefined, true, [], {}, 1e21]) {
      expect(validateAnswerValue(ho5, bad).ok, String(bad)).toBe(false);
    }
    for (const good of [1, 180, 99999, UNSURE_ID]) expect(validateAnswerValue(ho5, good).ok).toBe(true);
    expect(validateAnswerValue(cd2, 21).ok).toBe(false);
    expect(validateAnswerValue(cd2, 20).ok).toBe(true);
    expect(validateAnswerValue(cd2, 0).ok).toBe(false);
  });

  it("dollar node is integer cents (cents allowed), bounded", () => {
    for (const bad of [-100, -1, 100.5, 10_000_000 * 100 + 1, 1e21, NaN, "5", "12000", {}, null]) {
      expect(validateAnswerValue(ut3, bad).ok, String(bad)).toBe(false);
    }
    for (const good of [0, 50, 100, 150, 1_200_050, 1_200_000, 10_000_000 * 100, UNSURE_ID]) expect(validateAnswerValue(ut3, good).ok, String(good)).toBe(true);
  });

  it("multi-select: dedupe, exclusive, unsure, empty, unknown, non-strings", () => {
    const v = validateAnswerValue(s34, ["foreign_tax", "foreign_tax"]);
    expect(v).toEqual({ ok: true, value: ["foreign_tax"] });
    expect(validateAnswerValue(s34, ["none", "foreign_tax"]).ok).toBe(false);
    expect(validateAnswerValue(s34, [UNSURE_ID, "education"]).ok).toBe(false);
    expect(validateAnswerValue(s34, ["none"]).ok).toBe(true);
    expect(validateAnswerValue(s34, [UNSURE_ID]).ok).toBe(true);
    expect(validateAnswerValue(s34, []).ok).toBe(false);
    expect(validateAnswerValue(s34, ["bogus"]).ok).toBe(false);
    expect(validateAnswerValue(s34, [1 as unknown as string]).ok).toBe(false);
    expect(validateAnswerValue(s34, "foreign_tax").ok).toBe(false); // string on a multi
    // a string-array on a single
    const ho1 = questionnaireById("form-8829")!.nodes[0] as ChoiceNode;
    expect(validateAnswerValue(ho1, ["no"]).ok).toBe(false);
    // context-gated options are rejected when the context is off
    const off: QuestionnaireContext = { year: 2025, entityName: null, ekcActive: false, svActive: false };
    expect(validateAnswerValue(qb1, ["ekc"], off).ok).toBe(false);
    expect(validateAnswerValue(qb1, ["sv"], off).ok).toBe(false);
    expect(validateAnswerValue(qb1, ["k1"], off).ok).toBe(true);
    expect(validateAnswerValue(qb1, ["ekc"], { ...off, ekcActive: true }).ok).toBe(true);
  });

  it("stored garbage / stale option ids are dropped by effectiveAnswers, never throw", () => {
    const def = questionnaireById("form-8889")!;
    const ctx = CTXS[0]!;
    const garbage: unknown[] = [null, "x", 5, [], { hs1: null }, { hs1: { v: { a: 1 }, at: "t", by: 1 } }, { hs1: { v: "zzz", at: "t", by: null } }, { hs4: { v: ["direct", 5], at: "t", by: null } }];
    for (const g of garbage) {
      const eff = effectiveAnswers(def, parseStoredAnswers(g), [], ctx);
      expect(eff.hs1).toBeUndefined();
      expect(computeStatus(def, ctx, eff).kind).toBe("not_started");
    }
  });
});

// ── Parser agreement with the repo's real parsers ─────────────────────────────

describe("bound number nodes agree with the repo parsers", () => {
  const ho5Def = questionnaireById("form-8829")!;
  const ut3Def = questionnaireById("form-2210")!;
  const ctx = CTXS[0]!;
  const strings = [
    "180", "180 sq ft", "180sqft", "180 sqft", "180 sq. ft.", "180 SQ FT", " 180 ", "0", "00180", "99999", "100000", "about 180", "180.5", "1,800", "",
    "$12,000", "12000", "12,000.50", "$ 12000", "12000.5", "12000.555", ".5", "$", "twelve thousand", "12k", "12,000 per year", "-5", "1e3", "0", "10000000", "10000001",
  ];
  it("ho5 (sqft): engine maps iff parseSqftAnswer succeeds and in range", () => {
    for (const s of strings) {
      const real = parseSqftAnswer(s, null);
      const eff = effectiveAnswers(ho5Def, {}, [{ key: "home_office_sqft", answer: s, skippedReason: null }], ctx);
      const expectMapped = !real.unparseable && real.sqft !== null && real.sqft >= 1 && real.sqft <= 99999;
      expect(eff.ho5 !== undefined, `sqft ${JSON.stringify(s)}`).toBe(expectMapped);
      if (expectMapped) expect(eff.ho5!.value).toBe(real.sqft);
    }
  });
  it("ut3 (dollars): engine maps iff parseDollarAnswerToCents succeeds and in range", () => {
    for (const s of strings) {
      const real = parseDollarAnswerToCents(s, null);
      const eff = effectiveAnswers(ut3Def, {}, [{ key: "estimated_tax_payments_amount", answer: s, skippedReason: null }], ctx);
      const expectMapped = !real.unparseable && real.cents !== null && real.cents >= 0 && real.cents <= 10_000_000 * 100;
      expect(eff.ut3 !== undefined, `dollars ${JSON.stringify(s)}`).toBe(expectMapped);
      if (expectMapped) expect(eff.ut3!.value).toBe(real.cents);
    }
  });
  it("resolveBoundWrite round-trips through the real parsers", () => {
    const ho5 = ho5Def.nodes.find((n) => n.id === "ho5")!;
    const ut3 = ut3Def.nodes.find((n) => n.id === "ut3")!;
    for (const v of [1, 2, 180, 9999, 99999]) {
      const w = resolveBoundWrite(ho5, v)!;
      expect(parseSqftAnswer(w.planningValue, null)).toEqual({ sqft: v, unparseable: false });
    }
    for (const dollars of [0, 1, 99, 12000, 1234567, 10_000_000]) {
      const w = resolveBoundWrite(ut3, dollars * 100)!;
      expect(parseDollarAnswerToCents(w.planningValue, null)).toEqual({ cents: dollars * 100, unparseable: false });
    }
    expect(resolveBoundWrite(ut3, UNSURE_ID)).toEqual({ questionKey: "estimated_tax_payments_amount", planningValue: null });
  });
  it("skipped planning answers count as unanswered for every bound node", () => {
    for (const def of QUESTIONNAIRES) {
      for (const n of def.nodes) {
        if (!n.binding) continue;
        const rows: PlanningAnswerInput[] = [{ key: n.binding.questionKey, answer: "yes_exclusive", skippedReason: "skipped" }];
        expect(effectiveAnswers(def, {}, rows, CTXS[0]!)[n.id]).toBeUndefined();
      }
    }
  });
});

// ── Forms-page enumeration and differential ───────────────────────────────────

const ERIC = { id: "11111111-1111-4111-8111-111111111111", name: "Eric Kinniburgh" };
const EVA = { id: "22222222-2222-4222-8222-222222222222", name: "Eva-Laura Ramirez-Wisiackas" };
const PERSONAL: FormsEntityInput = { id: "ent-personal", name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null };
const EKC: FormsEntityInput = { id: "ent-ekc", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", type: "business", foundedDate: null, taxStatusNotes: "Single-member LLC, disregarded entity — Schedule C" };
const EKC_UNRECORDED: FormsEntityInput = { ...EKC, taxStatusNotes: null };
const SV_2026: FormsEntityInput = { id: "ent-sv", name: "Sudden Valley Property Management, LLC", slug: "sudden-valley", type: "business", foundedDate: new Date("2026-02-01"), taxStatusNotes: null };
const SV_2025: FormsEntityInput = { ...SV_2026, foundedDate: new Date("2025-03-01") };
const SV_DISREG: FormsEntityInput = { ...SV_2026, taxStatusNotes: "Single-member LLC, disregarded entity" };
const MEZZO: FormsEntityInput = { id: "ent-mezzo", name: "Mezzo", slug: "mezzo", type: "business", foundedDate: null, taxStatusNotes: "Not yet formed/registered as of June 2026." };
const MEZZO_FORMED: FormsEntityInput = { ...MEZZO, foundedDate: new Date("2026-01-15"), taxStatusNotes: null };

function k1Doc(): FormsDocumentInput {
  return { id: "doc-k1", docType: "k1", documentName: null, entityId: PERSONAL.id, taxYear: 2025, extractionStatus: "complete", extractionData: null, archivedAt: null, subjectType: null, subjectUser: null, issuerName: null };
}
const draft = (se: boolean): TaxDraftSummary => ({ status: "available", deductionMethod: "standard", selfEmploymentTaxPositive: se });

function input(over: Partial<FormsCatalogInput> = {}): FormsCatalogInput {
  return {
    taxYear: 2025,
    people: [ERIC, EVA],
    entities: [PERSONAL, EKC, SV_2026, MEZZO],
    documents: [],
    questions: [],
    personalWorkspaceExists: true,
    workspaceIds: {},
    checklists: {},
    formPlanInput: {
      documents: [], questions: [], ekConsultingPL: null, suddenValleyPL: null, ekConsultingMileageCount: 0,
      solarLoanOriginalCostCents: null, donationCount: 0, ekConsultingFixedAssetCount: 0, suddenValleyBuildingAssetCount: 0,
    },
    taxDraft: { status: "not_computed" },
    ...over,
  };
}

function all(data: FormsPageData): FormEntry[] {
  return [...data.federal, ...data.connecticut, ...data.needsCpaInput, ...data.entities.flatMap((s) => s.entries)];
}

const ENTITY_SETS: Record<string, FormsEntityInput[]> = {
  "sv-not-yet-active(2026 founded)": [PERSONAL, EKC, SV_2026, MEZZO],
  "sv-active-2025": [PERSONAL, EKC, SV_2025, MEZZO],
  "sv-disregarded": [PERSONAL, EKC, SV_DISREG, MEZZO],
  "ekc-unrecorded": [PERSONAL, EKC_UNRECORDED, SV_2026, MEZZO_FORMED],
  "no-sv": [PERSONAL, EKC],
  "no-ekc": [PERSONAL, SV_2025],
  "personal-only": [PERSONAL],
};
const QUESTION_SETS: Record<string, FormsCatalogInput["questions"]> = {
  none: [],
  "ruled out": [
    { key: "home_office_ekc", answer: "yes_shared", skippedReason: null },
    { key: "household_members", answer: "none", skippedReason: null },
    { key: "ev_vehicle", answer: "no", skippedReason: null },
  ],
  "solar": [{ key: "solar_credit", answer: "yes_unclaimed", skippedReason: null }],
  "home office exclusive": [
    { key: "home_office_ekc", answer: "yes_exclusive", skippedReason: null },
    { key: "home_office_sqft", answer: "180", skippedReason: null },
  ],
};

function scenarios(): { name: string; inp: FormsCatalogInput }[] {
  const out: { name: string; inp: FormsCatalogInput }[] = [];
  for (const year of [2024, 2025, 2026, 2027]) {
    for (const [en, ents] of Object.entries(ENTITY_SETS)) {
      for (const [qn, qs] of Object.entries(QUESTION_SETS)) {
        for (const [dn, d, docs] of [["no-draft", { status: "not_computed" } as TaxDraftSummary, []], ["draft-se0", draft(false), []], ["draft-se+", draft(true), [k1Doc()]]] as const) {
          out.push({ name: `${year}/${en}/${qn}/${dn}`, inp: input({ taxYear: year, entities: ents, questions: qs, taxDraft: d, documents: [...docs] }) });
        }
      }
    }
  }
  return out;
}

function toScopeEntities(ents: FormsEntityInput[]): ScopeEntity[] {
  return ents.map((e) => ({ id: e.id, name: e.name, slug: e.slug, type: e.type, foundedDate: e.foundedDate, taxStatusNotes: e.taxStatusNotes }));
}

describe("Forms page: every needs_cpa_input card has a working questionnaire (all years x entity sets x answers)", () => {
  it("enumeration across the scenario matrix", () => {
    const seenIds = new Set<string>();
    let n = 0;
    for (const { name, inp } of scenarios()) {
      const data = buildFormsPageData(inp);
      const entries = all(data);
      const scope = toScopeEntities(inp.entities);
      const hrefs = new Set<string>();
      for (const e of entries) {
        const needs = e.applicability === "needs_cpa_input" || data.needsCpaInput.includes(e);
        if (needs) {
          expect(e.questionnaire, `${name}: ${e.id}`).not.toBeNull();
        }
        if (e.questionnaire) {
          n++;
          const def = questionnaireById(e.questionnaire.questionnaireId);
          expect(def, `${name}: ${e.id}`).toBeTruthy();
          seenIds.add(def!.id);
          // The link must resolve: the server-side scope check the page/actions use must accept it.
          const s = resolveQuestionnaireScope(def!, scope, inp.taxYear, e.questionnaire.entityId);
          expect(s.ok, `${name}: ${e.id} scope -> ${JSON.stringify(s)}`).toBe(true);
          const key = `${def!.id}:${e.questionnaire.entityId}`;
          expect(hrefs.has(key), `${name}: duplicate questionnaire ${key}`).toBe(false);
          hrefs.add(key);
          if (def!.scope === "entity") expect(e.id.startsWith(e.questionnaire.entityId)).toBe(true);
        }
      }
      // loadQuestionnairePage would 404 unless the entry is findable via listQuestionnaireEntries
      const list = listQuestionnaireEntries(data);
      expect(list.length).toBe(entries.filter((e) => e.questionnaire).length);
      expect(data.questionnaireSummary.total).toBe(list.length);
    }
    expect(n).toBeGreaterThan(1000);
    expect([...seenIds].sort()).toEqual(QUESTIONNAIRES.map((q) => q.id).sort());
  });

  it("every household needs-CPA card id maps 1:1 to the same-named registry id", () => {
    for (const { inp } of scenarios()) {
      const data = buildFormsPageData(inp);
      for (const e of data.needsCpaInput) {
        if (e.questionnaire && questionnaireById(e.id)) expect(e.questionnaire.questionnaireId).toBe(e.id);
      }
    }
  });
});

describe("Forms page differential: questionnaire rows never move applicability / readiness / fields / counters", () => {
  const noQ = (data: FormsPageData) => {
    const clean = (e: FormEntry) => {
      const { questionnaire: _q, ...rest } = e;
      void _q;
      return rest;
    };
    const { questionnaireSummary: _s, ...top } = data;
    void _s;
    return {
      ...top,
      federal: data.federal.map(clean),
      connecticut: data.connecticut.map(clean),
      needsCpaInput: data.needsCpaInput.map(clean),
      entities: data.entities.map((s) => ({ ...s, entries: s.entries.map(clean) })),
    };
  };

  it("with random complete answers (plus malformed rows) for every questionnaire", () => {
    const r = mulberry32(777);
    let compared = 0;
    for (const { name, inp } of scenarios()) {
      if (r() > 0.25) continue; // sample a quarter of the matrix for speed
      const base = buildFormsPageData(inp);
      const rows: QuestionnaireRowInput[] = [];
      for (const { questionnaire } of listQuestionnaireEntries(base)) {
        const def = questionnaireById(questionnaire.questionnaireId)!;
        const ctx: QuestionnaireContext = { year: inp.taxYear, entityName: "x", ekcActive: true, svActive: true };
        const full = randomFull(def, ctx, r);
        const answers: Record<string, { v: unknown; at: string; by: null }> = {};
        for (const [id, a] of Object.entries(full)) answers[id] = { v: a.value, at: "2026-10-03T12:00:00.000Z", by: null };
        rows.push({ taxYear: inp.taxYear, entityId: questionnaire.entityId, questionnaireId: def.id, definitionVersion: r() < 0.2 ? 0 : 1, answers, note: "secret" });
      }
      rows.push({ taxYear: inp.taxYear, entityId: "ent-personal", questionnaireId: "form-8889", definitionVersion: 1, answers: "garbage" as unknown, note: null });
      rows.push({ taxYear: inp.taxYear, entityId: "ent-personal", questionnaireId: "nonexistent", definitionVersion: 1, answers: {}, note: null });
      const withRows = buildFormsPageData({ ...inp, questionnaireRows: rows });
      expect(JSON.stringify(noQ(withRows)), name).toBe(JSON.stringify(noQ(base)));
      expect(withRows.summary).toEqual(base.summary);
      const q = withRows.questionnaireSummary;
      expect(q.notStarted + q.inProgress + q.answered).toBe(q.total);
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
  });

  it("buildCardState: stale flag, owner line wording never says 'required' or 'eligible'", () => {
    for (const def of QUESTIONNAIRES) {
      const ctx: QuestionnaireContext = { year: 2025, entityName: "E", ekcActive: true, svActive: true };
      const r = mulberry32(5);
      for (let i = 0; i < 50; i++) {
        const full = randomFull(def, ctx, r);
        const answers: Record<string, unknown> = {};
        for (const [id, a] of Object.entries(full)) answers[id] = { v: a.value, at: "t", by: null };
        const st = buildCardState(def, "e1", ctx, { taxYear: 2025, entityId: "e1", questionnaireId: def.id, definitionVersion: 0, answers, note: null }, []);
        expect(st.stale).toBe(true);
        if (st.ownerLine) {
          expect(st.ownerLine).toMatch(/^Owner (reports|is unsure)/);
          expect(st.ownerLine).not.toMatch(/required|eligible|qualif/i);
        }
        if (st.outcomeText) expect(st.outcomeText).toMatch(/^Owner /);
        if (st.status.kind === "answered") expect(isUnsureValue(UNSURE_ID)).toBe(true);
      }
    }
  });
});

describe("copy and sources (independent greps over the content)", () => {
  const texts: { where: string; text: string }[] = [];
  for (const d of QUESTIONNAIRES) {
    texts.push({ where: `${d.id}.intro`, text: d.intro });
    for (const [k, v] of Object.entries(d.outcomeText)) texts.push({ where: `${d.id}.outcome.${k}`, text: v });
    for (const n of d.nodes) {
      texts.push({ where: `${d.id}.${n.id}.prompt`, text: n.prompt });
      if (n.help) texts.push({ where: `${d.id}.${n.id}.help`, text: n.help });
      if (isChoice(n)) for (const o of n.options) {
        texts.push({ where: `${d.id}.${n.id}.${o.id}`, text: o.label });
        if (o.warning) texts.push({ where: `${d.id}.${n.id}.${o.id}.warning`, text: o.warning });
        if (o.help) texts.push({ where: `${d.id}.${n.id}.${o.id}.help`, text: o.help });
      }
    }
  }
  it("no advice / determinative phrasing anywhere", () => {
    const bad = /\byou (qualify|should|are eligible|are entitled|must file|can claim|may claim|need to file|will owe)\b|\beligible for\b|\bwe recommend\b|\bshould claim\b|\byou are required\b|\bwill be allowed\b/i;
    for (const t of texts) expect(t.text, t.where).not.toMatch(bad);
    // "is required" is only acceptable inside an explicitly attributed IRS/CT paraphrase
    for (const t of texts) {
      if (/\b(is|are) required\b/i.test(t.text)) expect(t.text, t.where).toMatch(/^(The (IRS|Form [\d-]+A? instructions|IRS 1040 instructions)|Connecticut)\b/);
    }
  });
  it("every $-figure in copy sits on a node with a source (and only the four known figures appear)", () => {
    const figs = new Set<string>();
    for (const t of texts) for (const m of t.text.matchAll(/\$[\d,]+/g)) figs.add(m[0]);
    expect([...figs].sort()).toEqual(["$125,000", "$200,000", "$250,000", "$400"].sort());
  });
  it("every factual 'IRS says/instructions' help carries a registered source", () => {
    for (const d of QUESTIONNAIRES) for (const n of d.nodes) {
      if (n.help) {
        expect((n.sources ?? []).length, `${d.id}.${n.id}`).toBeGreaterThan(0);
        for (const s of n.sources ?? []) expect(SOURCES[s], `${d.id}.${n.id} source ${s}`).toBeDefined();
      }
    }
  });
  it("outcome texts always start with 'Owner'", () => {
    for (const t of texts.filter((x) => x.where.includes(".outcome."))) expect(t.text, t.where).toMatch(/^Owner /);
  });
});

describe("documenting: shared (bound) answers DO move the top counters, so UI copy must not claim otherwise", () => {
  it("household_members=none / home_office_ekc=yes_shared / ev_vehicle=no change summary.needsCpaInput and notApplicable", () => {
    const base = buildFormsPageData(input({ taxYear: 2026 }));
    const ruled = buildFormsPageData(input({ taxYear: 2026, questions: QUESTION_SETS["ruled out"] }));
    expect(ruled.summary.needsCpaInput).toBeLessThan(base.summary.needsCpaInput);
    expect(ruled.summary.notApplicable).toBeGreaterThan(base.summary.notApplicable);
    // ...so forms-summary.tsx says the shared Planning answers move them (pinned in tax-questionnaire-forms.test.ts)
  });
});

describe("UI key safety: rendered prompts are unique within a questionnaire (used as React keys in open-questions lists)", () => {
  it("no duplicate prompt text per definition", () => {
    for (const d of QUESTIONNAIRES) {
      const seen = new Set<string>();
      for (const n of d.nodes) {
        const p = n.prompt.replace(/\{[a-zA-Z]+\}/g, "X");
        expect(seen.has(p), `${d.id}.${n.id} duplicate prompt`).toBe(false);
        seen.add(p);
      }
    }
  });
});
