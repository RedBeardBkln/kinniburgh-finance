// Return completeness: the capital-gains questions (cgco / cgcos / cgcol / cgall / cgadj) and the two
// capital-gain "stated none" groups, mapped through lib/tax2025/answers.ts (schedule-d-capture).
import { describe, expect, it } from "vitest";
import {
  UNSURE_ID,
  coveringAnswerPaths,
  validateAnswerValue,
  validateDefinition,
  visibleNodes,
  type AnswerValue,
  type ChoiceNode,
  type EffectiveAnswers,
  type NumberNode,
} from "@/lib/tax-questionnaire";
import {
  QUESTIONNAIRES,
  RC_NONE_GROUP_IDS,
  RETURN_COMPLETENESS_ID,
  SOURCES,
  SOURCE_IDS,
  questionnaireById,
} from "@/lib/tax-questionnaire-content";
import { RC_CONTEXT, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { NONE_GROUP_IDS } from "@/lib/tax2025/line-catalog";
import { emptyReturnAnswers, parseTy2025Facts } from "@/lib/tax2025/facts";
import { fullFacts } from "@/lib/__tests__/tax2025-fixtures";

const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
const PEOPLE = [
  { userId: "u-eric", name: "Eric Kinniburgh" },
  { userId: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" },
];
const ea = (m: Record<string, AnswerValue>): EffectiveAnswers =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: v, source: "questionnaire" as const, at: "2026-10-04T12:00:00.000Z", by: "u-eric" }]));
const node = (id: string) => def.nodes.find((n) => n.id === id)!;
const CAPITAL_GROUPS = ["capital_gain_other", "capital_special_rates"] as const;

describe("the capital-gains questions: tree integrity", () => {
  it("the definition (and every other questionnaire) still validates, with the two new sources registered and used", () => {
    expect(validateDefinition(def, SOURCE_IDS)).toEqual([]);
    expect(SOURCES.SCHD?.url).toBe("https://www.irs.gov/instructions/i1040sd");
    expect(SOURCES["8949"]?.url).toBe("https://www.irs.gov/instructions/i8949");
    expect(SOURCES.SCHD?.verifiedOn).toBe("2026-10-04");
    const used = new Set(def.nodes.flatMap((n) => n.sources ?? []));
    expect(used.has("SCHD")).toBe(true);
    expect(used.has("8949")).toBe(true);
    expect(QUESTIONNAIRES.filter((q) => q.id === RETURN_COMPLETENESS_ID)).toHaveLength(1);
  });

  it("the version is NOT bumped (stored answers stay valid; the new nodes are simply unanswered)", () => {
    expect(def.version).toBe(2);
  });

  it("cgco / cgall / cgadj are single choices with exactly one Not sure; cgcos / cgcol are dollars shown only after Yes", () => {
    for (const id of ["cgco", "cgall", "cgadj"]) {
      const n = node(id) as ChoiceNode;
      expect(n.kind, id).toBe("single");
      expect(n.options.filter((o) => o.unsure), id).toHaveLength(1);
      expect(n.showWhen, id).toBeNull();
    }
    expect((node("cgco") as ChoiceNode).options.map((o) => o.id)).toEqual(["some", "none", UNSURE_ID]);
    for (const id of ["cgall", "cgadj"]) expect((node(id) as ChoiceNode).options.map((o) => o.id)).toEqual(["yes", "no", UNSURE_ID]);
    for (const id of ["cgcos", "cgcol"]) {
      const n = node(id) as NumberNode;
      expect(n.kind, id).toBe("dollars");
      expect(n.showWhen, id).toEqual({ kind: "in", node: "cgco", values: ["some"] });
      expect(validateAnswerValue(n, UNSURE_ID).ok, id).toBe(true);
    }
    const first = visibleNodes(def, RC_CONTEXT, {}).map((n) => n.id);
    expect(first).toContain("cgco");
    expect(first).not.toContain("cgcos");
    expect(visibleNodes(def, RC_CONTEXT, ea({ cgco: "some" })).map((n) => n.id)).toEqual(expect.arrayContaining(["cgcos", "cgcol"]));
  });

  it("every node is shown by the covering walks (nothing unreachable) and the capital questions sit before the none statements", () => {
    const paths = coveringAnswerPaths(def, RC_CONTEXT);
    const seen = new Set<string>();
    for (const p of paths) for (const [id, a] of Object.entries(p)) seen.add(`${id}:${Array.isArray(a.value) ? a.value.join("+") : String(a.value)}`);
    for (const id of ["cgco", "cgcos", "cgcol", "cgall", "cgadj", ...CAPITAL_GROUPS.flatMap((g) => [`g_${g}`, `ga_${g}`])]) {
      expect([...seen].some((s) => s.startsWith(`${id}:`)), `${id} never shown`).toBe(true);
    }
    for (const o of (node("cgco") as ChoiceNode).options) expect(seen.has(`cgco:${o.id}`), `cgco:${o.id}`).toBe(true);
    const ids = def.nodes.map((n) => n.id);
    expect(ids.indexOf("cgadj")).toBeLessThan(ids.indexOf(`g_${RC_NONE_GROUP_IDS[0]}`));
  });

  it("the none-groups: both capital groups are asked, no group is dropped, prompts are unique, plain language", () => {
    for (const g of NONE_GROUP_IDS) expect(RC_NONE_GROUP_IDS).toContain(g);
    for (const g of CAPITAL_GROUPS) expect(RC_NONE_GROUP_IDS).toContain(g);
    expect(new Set(RC_NONE_GROUP_IDS).size).toBe(RC_NONE_GROUP_IDS.length);
    const prompts = def.nodes.map((n) => n.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    const p1 = node("g_capital_gain_other").prompt;
    expect(p1).toMatch(/installment sale/);
    expect(p1).toMatch(/Section 1256 contracts/);
    expect(p1).toMatch(/like-kind exchange/);
    expect(p1).toMatch(/undistributed capital gains/);
    expect(p1).toMatch(/Schedule K-1/);
    const p2 = node("g_capital_special_rates").prompt;
    expect(p2).toMatch(/collectibles/);
    expect(p2).toMatch(/GLD, SLV or IAU/);
    expect(p2).toMatch(/qualified small business \(QSB\)/);
    expect(p2).toMatch(/depreciation was claimed/);
    expect(p2).toMatch(/qualified opportunity fund \(QOF\)/);
    for (const g of CAPITAL_GROUPS) {
      const n = node(`g_${g}`) as ChoiceNode;
      expect(n.options.map((o) => o.id)).toEqual(["some", "none", UNSURE_ID]);
      expect((node(`ga_${g}`) as NumberNode).showWhen).toEqual({ kind: "in", node: `g_${g}`, values: ["some"] });
    }
  });

  it("the questions name the household and the year and never state a dollar figure or give advice", () => {
    for (const id of ["cgco", "cgcos", "cgcol", "cgall", "cgadj"]) {
      const n = node(id);
      expect(n.prompt, id).not.toMatch(/\$\d/);
      // a prompt may carry one explanatory parenthetical after the question mark (same rule as the content test)
      expect(n.prompt.replace(/\s*\((?:[^()]|\([^()]*\))*\)$/, "").trim(), id).toMatch(/\?$/);
      expect(n.help ?? "", id).not.toMatch(/\$\d|you should|eligible for|you qualify/i);
    }
    expect(node("cgco").prompt).toMatch(/from 2024 into 2025/);
    expect(node("cgall").prompt).toMatch(/in 2025/);
  });
});

describe("answers.ts: carryover from 2024 (cgco)", () => {
  const cg = (m: Record<string, AnswerValue>) => parseCompletenessAnswers(ea(m), PEOPLE).returnAnswers.capitalGains;

  it("None -> both carryovers are a stated 0 with the owner basis and the question as provenance (this household's answer)", () => {
    const c = cg({ cgco: "none" });
    for (const leaf of [c.carryoverShortCents, c.carryoverLongCents]) {
      expect(leaf.value).toBe(0);
      expect(leaf.basis).toBe("answer_owner");
      expect(leaf.refs[0]).toMatchObject({ kind: "questionnaire", id: "return-completeness.cgco" });
    }
  });

  it("Yes -> the two amounts, in CENTS, short and long kept apart", () => {
    const c = cg({ cgco: "some", cgcos: 123_456, cgcol: 7_890_000 });
    expect(c.carryoverShortCents).toMatchObject({ value: 123_456, basis: "answer_owner" });
    expect(c.carryoverLongCents).toMatchObject({ value: 7_890_000, basis: "answer_owner" });
    expect(cg({ cgco: "some", cgcos: 0, cgcol: 0 }).carryoverShortCents.value).toBe(0);
  });

  it("Yes with only one amount answered: the other stays missing (never 0)", () => {
    const c = cg({ cgco: "some", cgcos: 500 });
    expect(c.carryoverShortCents.value).toBe(500);
    expect(c.carryoverLongCents).toMatchObject({ value: null, basis: null });
  });

  it("Not sure -> an owner-basis leaf with no value (the rules turn it into needs_cpa); an unanswered question stays missing", () => {
    for (const leaf of [cg({ cgco: UNSURE_ID }).carryoverShortCents, cg({ cgco: UNSURE_ID }).carryoverLongCents]) {
      expect(leaf.value).toBeNull();
      expect(leaf.basis).toBe("answer_owner");
    }
    for (const leaf of [cg({}).carryoverShortCents, cg({}).carryoverLongCents]) expect(leaf).toMatchObject({ value: null, basis: null });
  });

  it("a stale stored amount for a hidden node never leaks (cgco = None ignores cgcos / cgcol)", () => {
    const c = cg({ cgco: "none", cgcos: 999_999, cgcol: 888_888 });
    expect(c.carryoverShortCents.value).toBe(0);
    expect(c.carryoverLongCents.value).toBe(0);
  });
});

describe("answers.ts: cgall and cgadj", () => {
  const cg = (m: Record<string, AnswerValue>) => parseCompletenessAnswers(ea(m), PEOPLE).returnAnswers.capitalGains;

  it("cgall: Yes = the statement lists every sale (true), No = false, Not sure = owner leaf without a value, unanswered = missing", () => {
    expect(cg({ cgall: "yes" }).salesComplete).toMatchObject({ value: true, basis: "answer_owner" });
    expect(cg({ cgall: "no" }).salesComplete).toMatchObject({ value: false, basis: "answer_owner" });
    expect(cg({ cgall: UNSURE_ID }).salesComplete).toMatchObject({ value: null, basis: "answer_owner" });
    expect(cg({}).salesComplete).toMatchObject({ value: null, basis: null });
  });

  it("cgadj: Yes = something the broker could not know (true), No = false, Not sure / unanswered as above", () => {
    expect(cg({ cgadj: "yes" }).brokerAdjustments).toMatchObject({ value: true, basis: "answer_owner" });
    expect(cg({ cgadj: "no" }).brokerAdjustments).toMatchObject({ value: false, basis: "answer_owner" });
    expect(cg({ cgadj: UNSURE_ID }).brokerAdjustments).toMatchObject({ value: null, basis: "answer_owner" });
    expect(cg({}).brokerAdjustments).toMatchObject({ value: null, basis: null });
  });
});

describe("answers.ts: the capital-gain stated-none groups", () => {
  it("mapped like every group (none -> true, some -> false + optional amount, Not sure / unanswered -> absent) once the engine lists them", () => {
    const engineKnows = (g: string) => (NONE_GROUP_IDS as readonly string[]).includes(g);
    const p = parseCompletenessAnswers(
      ea({ g_capital_gain_other: "none", g_capital_special_rates: "some", ga_capital_special_rates: 250_000 }),
      PEOPLE
    );
    // Before line-catalog.ts lists the two ids (engine side) they are asked but not parsed; after, they behave like any group.
    const stated = p.statedNone as Record<string, boolean | undefined>;
    expect(stated.capital_gain_other).toBe(engineKnows("capital_gain_other") ? true : undefined);
    expect(stated.capital_special_rates).toBe(engineKnows("capital_special_rates") ? false : undefined);
    if (engineKnows("capital_special_rates")) {
      expect((p.returnAnswers.statedSomeAmounts as Record<string, { value: number | null }>).capital_special_rates?.value).toBe(250_000);
    }
    const unsure = parseCompletenessAnswers(ea({ g_capital_gain_other: UNSURE_ID }), PEOPLE);
    expect("capital_gain_other" in unsure.statedNone).toBe(false);
  });

  it("the existing 14 groups map exactly as before", () => {
    const all: EffectiveAnswers = {};
    for (const g of NONE_GROUP_IDS) all[`g_${g}`] = { value: "none", source: "questionnaire", at: null, by: null };
    const p = parseCompletenessAnswers(all, PEOPLE);
    expect(Object.keys(p.statedNone).sort()).toEqual([...NONE_GROUP_IDS].sort());
    expect(Object.values(p.statedNone).every((v) => v === true)).toBe(true);
  });
});

describe("saved answers stay valid and facts shape", () => {
  it("answers saved before the capital questions existed parse with every capital leaf missing and nothing else changed", () => {
    const saved = ea({ digital: "no", foreign: "no", sehi: "no", serp: "no", g_other_income: "none", pyjoint: "yes" });
    const p = parseCompletenessAnswers(saved, PEOPLE);
    expect(p.returnAnswers.capitalGains).toEqual(emptyReturnAnswers().capitalGains);
    expect(p.returnAnswers.attestations.digitalAssets).toMatchObject({ value: false, basis: "answer_owner" });
    expect(p.seHealthInsuranceCents).toBe(0);
    expect(p.statedNone.other_income).toBe(true);
    // the stored answers are still accepted by the (unchanged) definition
    for (const [id, a] of Object.entries(saved)) {
      const n = node(id);
      expect(validateAnswerValue(n, a.value as AnswerValue).ok, id).toBe(true);
    }
  });

  it("emptyReturnAnswers carries the four capital leaves, all missing, and the facts zod schema accepts them", () => {
    const e = emptyReturnAnswers().capitalGains;
    expect(Object.keys(e).sort()).toEqual(["brokerAdjustments", "carryoverLongCents", "carryoverShortCents", "salesComplete"]);
    for (const leaf of Object.values(e)) expect(leaf).toMatchObject({ value: null, basis: null });
    expect(() => parseTy2025Facts(fullFacts())).not.toThrow();
    const f = fullFacts();
    f.returnAnswers = { ...f.returnAnswers, ...parseCompletenessAnswers(ea({ cgco: "none", cgall: "yes", cgadj: "no" }), PEOPLE).returnAnswers };
    expect(() => parseTy2025Facts(f)).not.toThrow();
  });
});
