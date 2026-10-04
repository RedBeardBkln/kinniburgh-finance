import { describe, expect, it } from "vitest";
import { effectiveAnswers, visibleNodes, type EffectiveAnswers } from "@/lib/tax-questionnaire";
import { RETURN_COMPLETENESS_ID, questionnaireById } from "@/lib/tax-questionnaire-content";
import { RC_CONTEXT, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { missingLeaf, sourced } from "@/lib/tax2025/types";
import { fullFacts, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";

const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
const PEOPLE = [
  { userId: "u1", name: "Eric K" },
  { userId: "u2", name: "Eva" },
];
const eff = (v: Record<string, string | number>): EffectiveAnswers =>
  Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { value, source: "questionnaire" as const, at: "2026-10-04T00:00:00.000Z", by: null }]));

describe("Round 3: self-employed health insurance and retirement questions", () => {
  it("the four nodes exist, are plain-language, shown only for an active EK Consulting, and the amount only after yes", () => {
    for (const id of ["sehi", "sehiamt", "serp", "serpamt"]) expect(def.nodes.some((n) => n.id === id), id).toBe(true);
    const shown = (ctx = RC_CONTEXT, e: EffectiveAnswers = {}) => visibleNodes(def, ctx, e).map((n) => n.id);
    expect(shown()).toContain("sehi");
    expect(shown()).toContain("serp");
    expect(shown()).not.toContain("sehiamt");
    expect(shown(RC_CONTEXT, eff({ sehi: "yes", serp: "yes" }))).toEqual(expect.arrayContaining(["sehiamt", "serpamt"]));
    expect(shown({ ...RC_CONTEXT, ekcActive: false })).not.toContain("sehi");
    expect(def.nodes.find((n) => n.id === "sehi")!.prompt).toContain("{year}");
    expect(def.version).toBe(2); // appended nodes: saved answers stay valid, no bump
  });

  it("mapping: No -> 0 stated, Yes -> the amount, Not sure / unanswered -> absent", () => {
    const p = (v: Record<string, string | number>) => parseCompletenessAnswers(eff(v), PEOPLE);
    expect(p({ sehi: "no", serp: "no" })).toMatchObject({ seHealthInsuranceCents: 0, seRetirementCents: 0 });
    expect(p({ sehi: "yes", sehiamt: 480_000, serp: "yes", serpamt: 650_000 })).toMatchObject({ seHealthInsuranceCents: 480_000, seRetirementCents: 650_000 });
    const unsure = p({ sehi: "unsure", serp: "yes" });
    expect(unsure.seHealthInsuranceCents).toBeUndefined();
    expect(unsure.seRetirementCents).toBeUndefined(); // yes without an amount
    expect(p({}).seHealthInsuranceCents).toBeUndefined();
  });

  it("existing saved answers (no new nodes) still parse; the new nodes are simply unanswered", () => {
    const saved = effectiveAnswers(def, { age_eric: { v: "no", at: "2026-10-03T00:00:00.000Z", by: null } }, [], RC_CONTEXT);
    expect(saved.age_eric?.value).toBe("no");
    expect(parseCompletenessAnswers(saved, PEOPLE).seRetirementCents).toBeUndefined();
  });

  it("QBI: unanswered blocks, none = 0 unblocks, a positive owner amount keeps Schedule 1 line 16/17 and QBI needs-CPA", () => {
    const f = fullFacts1b();
    f.adjustments.seHealthInsurance = missingLeaf();
    f.adjustments.seRetirement = missingLeaf();
    expect(computeTy2025Return(f).lines["f1040.13a"]?.status).not.toBe("computed");
    f.adjustments.seHealthInsurance = owner(0);
    f.adjustments.seRetirement = owner(0);
    const ok = computeTy2025Return(f);
    expect(ok.lines["f1040.13a"]?.status).toBe("computed");
    expect(ok.lines["f1040.13a"]?.amount).toBe(9293);
    expect(ok.headline.federal.taxableIncome.amount).toBe(137174);
    f.adjustments.seHealthInsurance = owner(500_000);
    const amount = computeTy2025Return(f);
    expect(amount.lines["sch1.17"]?.status).toBe("needs_cpa_rule_unverified");
    expect(amount.lines["sch1.17"]?.amount).toBeNull();
    expect(amount.lines["f1040.13a"]?.status).not.toBe("computed");
    expect(amount.headline.complete).toBe(false);
  });

  it("a CPA-stated amount is used as given", () => {
    const f = fullFacts1b();
    f.adjustments.seHealthInsurance = sourced(500_000, "answer_cpa", []);
    expect(computeTy2025Return(f).lines["sch1.17"]?.amount).toBe(5000);
  });

  it("golden return unchanged", () => {
    const r = computeTy2025Return(fullFacts());
    expect(r.headline.federal.totalTax.amount).toBe(27015);
    expect(r.headline.connecticut.tax.amount).toBe(8788);
  });
});
