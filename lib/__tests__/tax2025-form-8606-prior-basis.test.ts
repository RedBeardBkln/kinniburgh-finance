// The earlier-year basis for Form 8606 line 2 as an owner AMOUNT per person (Return completeness nodes `ibasis_eric` / `ibasis_eva`): visibility, validation
// (never negative), how the answer reaches the engine facts with its provenance, and that adding the question changed neither the questionnaire version nor
// how any saved answer parses. Pure: no DB.

import { describe, expect, it } from "vitest";
import { UNSURE_ID, validateAnswerValue, validateDefinition, visibleNodes, type AnswerValue, type EffectiveAnswers } from "@/lib/tax-questionnaire";
import { RETURN_COMPLETENESS_ID, SOURCE_IDS, questionnaireById } from "@/lib/tax-questionnaire-content";
import { RC_CONTEXT, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { NONE_GROUP_TEXT } from "@/lib/tax2025/line-catalog";

const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
const PEOPLE = [
  { userId: "u-eric", name: "Eric Kinniburgh" },
  { userId: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" },
];
const eff = (stored: Record<string, AnswerValue>): EffectiveAnswers =>
  Object.fromEntries(Object.entries(stored).map(([id, value]) => [id, { value, source: "questionnaire" as const, at: "2026-10-06T12:00:00.000Z", by: "u-eric" }]));
const shown = (e: EffectiveAnswers): string[] => visibleNodes(def, RC_CONTEXT, e).map((n) => n.id);

describe("the earlier-year IRA basis amount question", () => {
  it("is in the definition, which still validates and keeps version 2 (no questionnaire version bump)", () => {
    expect(validateDefinition(def, SOURCE_IDS)).toEqual([]);
    expect(def.version).toBe(2);
    for (const k of ["eric", "eva"]) {
      const n = def.nodes.find((x) => x.id === `ibasis_${k}`);
      expect(n?.kind).toBe("dollars");
      expect(n?.kind === "dollars" ? n.min : null).toBe(0);
    }
  });

  it("asks per person in plain language, quoting the 2024 Form 8606 line 14, with no CPA wording", () => {
    const eric = def.nodes.find((x) => x.id === "ibasis_eric")!;
    const eva = def.nodes.find((x) => x.id === "ibasis_eva")!;
    expect(eric.prompt).toBe("In Eric's most recent filed Form 8606 (for 2024), what is the amount on line 14 (Eric's total basis in traditional IRAs)? (Enter 0 if Eric had none or never filed one.)");
    expect(eva.prompt).toContain("In Eva's most recent filed Form 8606 (for 2024), what is the amount on line 14");
    expect(JSON.stringify(eric)).not.toMatch(/CPA/);
    expect(JSON.stringify(eva)).not.toMatch(/CPA/);
    expect(eric.sources).toEqual(["8606I"]);
  });

  it("is shown only for a person who contributed to an IRA, never first", () => {
    expect(shown({})).not.toContain("ibasis_eric");
    expect(shown(eff({ ira_eric: "none" }))).not.toContain("ibasis_eric");
    const e = eff({ ira_eric: "some", ira_eva: "none" });
    expect(shown(e)).toContain("ibasis_eric");
    expect(shown(e)).not.toContain("ibasis_eva");
    expect(shown(eff({ ira_eric: "some", ira_eva: "some" }))).toContain("ibasis_eva");
  });

  it("is an amount that can never be negative (the questionnaire refuses it)", () => {
    const n = def.nodes.find((x) => x.id === "ibasis_eric")!;
    expect(validateAnswerValue(n, 730_000).ok).toBe(true);
    expect(validateAnswerValue(n, 0).ok).toBe(true);
    expect(validateAnswerValue(n, -30_000).ok).toBe(false);
    expect(validateAnswerValue(n, UNSURE_ID).ok).toBe(true);
  });
});

describe("how the answer reaches the engine facts", () => {
  const base = { ira_eric: "some", tira_eric: 700_000, roth_eric: 0, ira50_eric: "no", ira_eva: "none" } as Record<string, AnswerValue>;

  it("Eric: 7,300 becomes priorBasisCents with an owner basis and a ref to the question", () => {
    const p = parseCompletenessAnswers(eff({ ...base, ibasis_eric: 730_000 }), PEOPLE).returnAnswers.people;
    const leaf = p[0]!.priorBasisCents;
    expect(leaf?.value).toBe(730_000);
    expect(leaf?.basis).toBe("answer_owner");
    expect(leaf?.refs.some((r) => r.kind === "questionnaire" && r.id === `${RETURN_COMPLETENESS_ID}.ibasis_eric`)).toBe(true);
    expect(leaf?.refs[0]?.label).toContain("2024 Form 8606, line 14");
    // Eva (no IRA contribution): the question is hidden, so nothing is set for her
    expect(p[1]!.priorBasisCents).toBeUndefined();
  });

  it("an answer of 0 is a real stated 0 (not 'missing')", () => {
    const leaf = parseCompletenessAnswers(eff({ ...base, ibasis_eric: 0 }), PEOPLE).returnAnswers.people[0]!.priorBasisCents;
    expect(leaf?.value).toBe(0);
    expect(leaf?.basis).toBe("answer_owner");
  });

  it("'Not sure' is an owner leaf with no value (the engine blocks it); unanswered leaves the field absent", () => {
    const unsure = parseCompletenessAnswers(eff({ ...base, ibasis_eric: UNSURE_ID }), PEOPLE).returnAnswers.people[0]!.priorBasisCents;
    expect(unsure?.value).toBeNull();
    expect(unsure?.basis).toBe("answer_owner");
    expect(parseCompletenessAnswers(eff(base), PEOPLE).returnAnswers.people[0]!.priorBasisCents).toBeUndefined();
  });

  it("a stored answer for a hidden question is ignored (as everywhere in the questionnaire)", () => {
    const p = parseCompletenessAnswers(eff({ ira_eric: "none", ibasis_eric: 730_000 }), PEOPLE).returnAnswers.people[0]!;
    expect(p.priorBasisCents).toBeUndefined();
  });

  it("Eva's own amount goes to her slot only", () => {
    const p = parseCompletenessAnswers(eff({ ...base, ira_eva: "some", tira_eva: 500_000, roth_eva: 0, ira50_eva: "no", ibasis_eric: 730_000, ibasis_eva: 100_000 }), PEOPLE).returnAnswers.people;
    expect(p[0]!.priorBasisCents?.value).toBe(730_000);
    expect(p[1]!.priorBasisCents?.value).toBe(100_000);
  });
});

describe("the statement about 2025 IRA withdrawals, conversions and recharacterizations (ira_basis_other)", () => {
  it("no longer claims to cover earlier-year basis (that is the amount question); its text names only 2025 events", () => {
    expect(NONE_GROUP_TEXT.ira_basis_other).toContain("No distribution from a traditional IRA");
    expect(NONE_GROUP_TEXT.ira_basis_other).toContain("2025");
    expect(NONE_GROUP_TEXT.ira_basis_other).not.toMatch(/nondeductible contribution to a traditional IRA for 2024/);
    expect(NONE_GROUP_TEXT.ira_basis_other).not.toMatch(/CPA/);
  });

  it("answering None / Yes still maps to the stated-none statement the engine reads", () => {
    expect(parseCompletenessAnswers(eff({ g_ira_basis_other: "none" }), PEOPLE).statedNone.ira_basis_other).toBe(true);
    expect(parseCompletenessAnswers(eff({ g_ira_basis_other: "some" }), PEOPLE).statedNone.ira_basis_other).toBe(false);
    expect(parseCompletenessAnswers(eff({}), PEOPLE).statedNone.ira_basis_other).toBeUndefined();
  });
});
