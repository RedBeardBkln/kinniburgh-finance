import { describe, expect, it } from "vitest";
import { coveringAnswerPaths, validateDefinition, visibleNodes, UNSURE_ID, type AnswerValue, type EffectiveAnswers, type QNode } from "@/lib/tax-questionnaire";
import { RC_PAYMENT_WINDOWS, RC_PERSONS, RETURN_COMPLETENESS_ID, SOURCE_IDS, questionnaireById } from "@/lib/tax-questionnaire-content";
import { K } from "@/lib/tax2025/constants";
import { RC_CONTEXT, matchPerson, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { NONE_GROUP_IDS } from "@/lib/tax2025/line-catalog";

const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
const PEOPLE = [
  { userId: "u-eric", name: "Eric Kinniburgh" },
  { userId: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" },
];

type Chooser = (node: QNode) => AnswerValue;

/** Answers the questionnaire the way the runner does: top to bottom, each VISIBLE question once. */
function answerAll(choose: Chooser, overrides: Record<string, AnswerValue> = {}): EffectiveAnswers {
  const eff: EffectiveAnswers = {};
  for (const node of def.nodes) {
    const shown = visibleNodes(def, RC_CONTEXT, eff).some((n) => n.id === node.id);
    if (!shown) continue;
    const value = overrides[node.id] ?? choose(node);
    eff[node.id] = { value, source: "questionnaire", at: "2026-10-04T12:00:00.000Z", by: "u-eric" };
  }
  return eff;
}

/** "none" / "no" / zero everywhere. */
const allNone: Chooser = (node) => {
  if (node.kind === "single" || node.kind === "multi") {
    const ids = node.options.map((o) => o.id);
    const pick = ids.includes("none") ? "none" : ids.includes("no") ? "no" : (node.options.find((o) => !o.unsure)?.id as string);
    return node.kind === "multi" ? [pick] : pick;
  }
  return node.kind === "dollars" ? 0 : 12;
};

describe("the Return completeness definition", () => {
  it("validates, has one node per none group and per payment window, and every group id is asked", () => {
    expect(validateDefinition(def, SOURCE_IDS)).toEqual([]);
    const ids = new Set(def.nodes.map((n) => n.id));
    for (const g of NONE_GROUP_IDS) {
      expect(ids.has(`g_${g}`), g).toBe(true);
      expect(ids.has(`ga_${g}`), g).toBe(true);
    }
    for (const j of ["fe", "ce"]) for (const w of RC_PAYMENT_WINDOWS) expect(ids.has(`${j}${w.n}`), `${j}${w.n}`).toBe(true);
    for (const P of RC_PERSONS) for (const base of ["age", "blind", "plan", "def", "ira", "hsa", "tips", "ot", "hsadist"]) expect(ids.has(`${base}_${P.key}`), `${base}_${P.key}`).toBe(true);
  });

  it("follow-up amounts appear only after 'some' (the first screen has no follow-ups)", () => {
    const first = visibleNodes(def, RC_CONTEXT, {}).map((n) => n.id);
    expect(first).not.toContain("defamt_eric");
    expect(first).not.toContain("fe1");
    expect(first).not.toContain("ga_other_income");
    const some = answerAll(allNone, { fe: "some", g_other_income: "some" });
    const ids = visibleNodes(def, RC_CONTEXT, some).map((n) => n.id);
    expect(ids).toContain("fe1");
    expect(ids).toContain("ga_other_income");
    expect(ids).not.toContain("ce1");
  });

  it("the payment windows are the Form 2210 due dates for the first three and end at the January 15, 2026 installment", () => {
    const due = K.FORM_2210_DUE_DATES.value;
    expect(RC_PAYMENT_WINDOWS.map((w) => w.date)).toEqual([due[0], due[1], due[2], "2025-12-31", due[3]]);
  });

  it("every question the Phase 1b rules read is answerable on a covering path (the parser never meets an unknown id)", () => {
    for (const path of coveringAnswerPaths(def, RC_CONTEXT)) {
      const parsed = parseCompletenessAnswers(path, PEOPLE);
      expect(parsed.returnAnswers.people).toHaveLength(2);
    }
  });
});

describe("parseCompletenessAnswers", () => {
  it("matches the questions' people to household users by first name", () => {
    expect(matchPerson("Eric Kinniburgh", "eric")).toBe(true);
    expect(matchPerson("  eva-laura", "eva")).toBe(true);
    expect(matchPerson("Evan", "eva")).toBe(true); // first-name prefix, documented: an open item is raised when a name cannot be matched
    const parsed = parseCompletenessAnswers(answerAll(allNone), PEOPLE);
    expect(parsed.returnAnswers.people.map((p) => [p.slot, p.userId])).toEqual([
      ["a", "u-eric"],
      ["b", "u-eva"],
    ]);
    const unmatched = parseCompletenessAnswers(answerAll(allNone), [{ userId: "x", name: "Someone Else" }]);
    expect(unmatched.returnAnswers.people.every((p) => p.userId === null)).toBe(true);
  });

  it("an all-none run: every group stated none, no payments, zero contributions, with provenance on every leaf", () => {
    const p = parseCompletenessAnswers(answerAll(allNone), PEOPLE);
    for (const g of NONE_GROUP_IDS) expect(p.statedNone[g], g).toBe(true);
    expect(p.federalEstimates).toEqual([]);
    expect(p.ctEstimates).toEqual([]);
    expect(p.federalExtensionPaymentCents).toBe(0);
    expect(p.ctExtensionPaymentCents).toBe(0);
    expect(p.federalOverpaymentAppliedCents).toBe(0);
    expect(p.ctOverpaymentAppliedCents).toBe(0);
    expect(p.ctPriorYearBalancePaidIn2025Cents).toBe(0);
    const eric = p.returnAnswers.people[0]!;
    expect(eric.deferralsCents.value).toBe(0);
    expect(eric.traditionalIraCents.value).toBe(0);
    expect(eric.rothIraCents.value).toBe(0);
    expect(eric.tipsChoice.value).toBe("none");
    expect(eric.overtimeChoice.value).toBe("none");
    expect(eric.hsaCoverage.value).toBe("none");
    expect(eric.bornBefore1961.value).toBe(false);
    expect(eric.blind.value).toBe(false);
    expect(eric.bornBefore1961.basis).toBe("answer_owner");
    expect(eric.bornBefore1961.refs[0]?.kind).toBe("questionnaire");
    expect(eric.bornBefore1961.note).toContain("2026-10-04");
    expect(p.returnAnswers.useTax.choice.value).toBe("none");
    expect(p.returnAnswers.carLoan.choice.value).toBe("none");
    // no contributions: the saver's-credit distribution / student questions are implied, not asked
    expect(p.returnAnswers.retirementDistributionSince2022.value).toBe(false);
    expect(p.returnAnswers.retirementDistributionSince2022.basis).toBe("derived");
    expect(p.returnAnswers.studentOrDependent.value).toBe(false);
  });

  it("'some' for a group is a stated FALSE (the engine hands the line to the CPA) and keeps the estimated amount", () => {
    const p = parseCompletenessAnswers(answerAll(allNone, { g_other_income: "some", ga_other_income: 1_250_000 }), PEOPLE);
    expect(p.statedNone.other_income).toBe(false);
    expect(p.returnAnswers.statedSomeAmounts.other_income?.value).toBe(1_250_000);
    expect(p.statedNone.other_taxes).toBe(true);
  });

  it("'Not sure' leaves the group unstated and the answer a no-value owner leaf (never a guess)", () => {
    const p = parseCompletenessAnswers(answerAll(allNone, { g_other_taxes: UNSURE_ID, tips_eva: UNSURE_ID, age_eric: UNSURE_ID }), PEOPLE);
    expect(p.statedNone.other_taxes).toBeUndefined();
    const eva = p.returnAnswers.people[1]!;
    expect(eva.tipsChoice.value).toBeNull();
    expect(eva.tipsChoice.basis).toBe("answer_owner");
    const eric = p.returnAnswers.people[0]!;
    expect(eric.bornBefore1961.value).toBeNull();
    expect(eric.bornBefore1961.basis).toBe("answer_owner");
  });

  it("an unanswered question is a MISSING leaf (value null, basis null)", () => {
    const p = parseCompletenessAnswers({}, PEOPLE);
    const eric = p.returnAnswers.people[0]!;
    expect(eric.bornBefore1961).toMatchObject({ value: null, basis: null });
    expect(p.statedNone.other_income).toBeUndefined();
    expect(p.federalEstimates).toBeUndefined();
    expect(p.federalExtensionPaymentCents).toBeUndefined();
  });

  it("estimated payments: each window becomes a dated entry; a zero window is dropped; an unanswered window leaves the whole list unknown", () => {
    const p = parseCompletenessAnswers(answerAll(allNone, { fe: "some", fe1: 150_000, fe2: 0, fe3: 150_000, fe4: 0, fe5: 160_000, ce: "some", ce1: 50_000, ce2: 0, ce3: 0, ce4: 0, ce5: 50_000 }), PEOPLE);
    expect(p.federalEstimates).toEqual([
      { paidOn: "2025-04-15", amountCents: 150_000, appliesToTaxYear: 2025 },
      { paidOn: "2025-09-15", amountCents: 150_000, appliesToTaxYear: 2025 },
      { paidOn: "2026-01-15", amountCents: 160_000, appliesToTaxYear: 2025 },
    ]);
    expect(p.ctEstimates).toEqual([
      { paidOn: "2025-04-15", amountCents: 50_000, appliesToTaxYear: 2025 },
      { paidOn: "2026-01-15", amountCents: 50_000, appliesToTaxYear: 2025 },
    ]);
    const eff = answerAll(allNone, { fe: "some" });
    delete eff.fe3;
    expect(parseCompletenessAnswers(eff, PEOPLE).federalEstimates).toBeUndefined();
  });

  it("extension payments, overpayments applied and the 2024 CT tax paid in 2025", () => {
    const p = parseCompletenessAnswers(answerAll(allNone, { fext: "some", fextamt: 700_000, cext: "some", cextamt: 90_000, fov: "some", fovamt: 20_000, cov: "some", covamt: 5_000, cpy: "some", cpyamt: 123_400 }), PEOPLE);
    expect(p.federalExtensionPaymentCents).toBe(700_000);
    expect(p.ctExtensionPaymentCents).toBe(90_000);
    expect(p.federalOverpaymentAppliedCents).toBe(20_000);
    expect(p.ctOverpaymentAppliedCents).toBe(5_000);
    expect(p.ctPriorYearBalancePaidIn2025Cents).toBe(123_400);
  });

  it("retirement, HSA, tips, overtime and car-loan answers land on the right person and leaf", () => {
    const p = parseCompletenessAnswers(
      answerAll(allNone, {
        def_eric: "some",
        defamt_eric: 2_300_000,
        ira_eva: "some",
        tira_eva: 700_000,
        roth_eva: 0,
        ira50_eva: "yes",
        plan_eric: "yes",
        hsa_eva: "family",
        hsam_eva: 12,
        hsad1_eva: "yes",
        hsamed_eva: "no",
        hsa55_eva: "no",
        hsadir_eva: 400_000,
        hsaemp_eva: "no",
        tips_eva: "some",
        tipsamt_eva: 600_000,
        ot_eric: "total",
        otamt_eric: 1_500_000,
        car: "some",
        carq: "yes",
        carint: 480_000,
        carelse: 0,
      }),
      PEOPLE
    );
    const [eric, eva] = p.returnAnswers.people;
    expect(eric!.deferralsCents.value).toBe(2_300_000);
    expect(eric!.coveredByWorkplacePlan.value).toBe(true);
    expect(eric!.overtimeChoice.value).toBe("total");
    expect(eric!.overtimeCents.value).toBe(1_500_000);
    expect(eva!.traditionalIraCents.value).toBe(700_000);
    expect(eva!.rothIraCents.value).toBe(0);
    expect(eva!.age50Plus.value).toBe(true);
    expect(eva!.hsaCoverage.value).toBe("family");
    expect(eva!.hsaMonthsEligible.value).toBe(12);
    expect(eva!.hsaDirectContributionsCents.value).toBe(400_000);
    expect(eva!.tipsChoice.value).toBe("some");
    expect(eva!.tipsCents.value).toBe(600_000);
    expect(p.returnAnswers.carLoan).toMatchObject({ choice: { value: "some" }, qualifies: { value: true }, interestPaidCents: { value: 480_000 }, deductedElsewhereCents: { value: 0 } });
    // contributions exist, so the saver's-credit questions are real answers now
    expect(p.returnAnswers.retirementDistributionSince2022.basis).toBe("answer_owner");
  });

  it("answers stored for a node that is currently HIDDEN are ignored (a stale follow-up cannot leak into the facts)", () => {
    const eff = answerAll(allNone);
    eff.defamt_eric = { value: 9_999_900, source: "questionnaire", at: "2026-10-04T12:00:00.000Z", by: null };
    eff.fe1 = { value: 5_000_000, source: "questionnaire", at: "2026-10-04T12:00:00.000Z", by: null };
    const p = parseCompletenessAnswers(eff, PEOPLE);
    expect(p.returnAnswers.people[0]!.deferralsCents.value).toBe(0);
    expect(p.federalEstimates).toEqual([]);
  });

  it("use tax and the attestations", () => {
    const p = parseCompletenessAnswers(answerAll(allNone, { ut: "some", utbuy: 100_000, utother: "no", uttax: 2_000, digital: "yes", foreign: "unsure" }), PEOPLE);
    expect(p.returnAnswers.useTax).toMatchObject({ choice: { value: "some" }, generalRatePurchasesCents: { value: 100_000 }, otherRateItems: { value: false }, taxPaidToOtherStateCents: { value: 2_000 } });
    expect(p.returnAnswers.attestations.digitalAssets.value).toBe(true);
    expect(p.returnAnswers.attestations.foreignAccounts).toMatchObject({ value: null, basis: "answer_owner" });
  });
});
