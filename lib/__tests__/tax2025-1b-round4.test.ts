import { describe, expect, it } from "vitest";
import { effectiveAnswers, validateDefinition, visibleNodes, type EffectiveAnswers } from "@/lib/tax-questionnaire";
import { RETURN_COMPLETENESS_ID, SOURCE_IDS, questionnaireById } from "@/lib/tax-questionnaire-content";
import { RC_CONTEXT, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { ERIC_ID, EVA_ID, fullFacts, fullFacts1b } from "@/lib/__tests__/tax2025-fixtures";

const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
const PEOPLE = [
  { userId: ERIC_ID, name: "Eric K" },
  { userId: EVA_ID, name: "Eva" },
];
const eff = (v: Record<string, string>): EffectiveAnswers =>
  Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { value, source: "questionnaire" as const, at: "2026-10-04T00:00:00.000Z", by: null }]));

const divDoc: RawDocument = {
  id: "div-1",
  docType: "1099",
  taxYear: 2025,
  extractionStatus: "complete",
  extractionData: { summary: "x", data: { formVariant: "1099-DIV", payerName: "Robinhood", div_box1aCents: 10_000, div_box1bCents: 8_000 } },
  verified: true,
  legacyFormat: false,
  subjectType: "person",
  subjectUserId: ERIC_ID,
  documentName: null,
};
function raw(confirmed: boolean | undefined): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people: PEOPLE,
    scheduleCOwner: null,
    documents: [divDoc],
    planning: { filingStatus: "mfj", householdMembers: "none", evVehicle: "no", businessMileage: "no", homeOfficeEligibility: "no", homeOfficeSqft: null, solarCredit: null, donationsNone: true, fixedAssetsEkcNone: true, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
    answers: { statedNone: {}, returnAnswers: fullFacts1b().returnAnswers, ...(confirmed === undefined ? {} : { dividendBoxes2b2dConfirmedZero: confirmed }) },
    primaryResidence: null,
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  };
}
const item = (r: ReturnType<typeof resolveFacts>) => r.openItems.find((o) => o.id === "dividend-boxes-2b-2d");

describe("Round 4: Form 1099-DIV boxes 2b-2d confirmation", () => {
  it("the node is a plain yes / no / not sure choice, always shown, and the definition still validates", () => {
    const n = def.nodes.find((x) => x.id === "div2b")!;
    expect(n.kind).toBe("single");
    expect(n.showWhen).toBeNull();
    expect(visibleNodes(def, RC_CONTEXT, {}).map((x) => x.id)).toContain("div2b");
    expect(n.prompt).toContain("box 2b");
    expect(n.prompt).toContain("box 2c");
    expect(n.prompt).toContain("box 2d");
    expect(n.prompt).not.toContain("$");
    expect((n as unknown as { options: { id: string }[] }).options.map((o) => o.id)).toEqual(["yes", "no", "unsure"]);
    expect(validateDefinition(def, SOURCE_IDS)).toEqual([]);
    expect(def.version).toBe(2);
  });

  it("mapping: Yes -> true, No -> false, Not sure / unanswered -> absent", () => {
    expect(parseCompletenessAnswers(eff({ div2b: "yes" }), PEOPLE).dividendBoxes2b2dConfirmedZero).toBe(true);
    expect(parseCompletenessAnswers(eff({ div2b: "no" }), PEOPLE).dividendBoxes2b2dConfirmedZero).toBe(false);
    expect(parseCompletenessAnswers(eff({ div2b: "unsure" }), PEOPLE).dividendBoxes2b2dConfirmedZero).toBeUndefined();
    expect(parseCompletenessAnswers({}, PEOPLE).dividendBoxes2b2dConfirmedZero).toBeUndefined();
  });

  it("the blocking item clears on Yes only; No keeps it with a CPA action; Not sure / unanswered keep it", () => {
    expect(item(resolveFacts(raw(true)))).toBeUndefined();
    const no = item(resolveFacts(raw(false)))!;
    expect(no.severity).toBe("blocking");
    expect(no.action).toContain("CPA");
    expect(no.action).toContain("Schedule D Tax Worksheet");
    expect(item(resolveFacts(raw(undefined)))?.severity).toBe("blocking");
    expect(item(resolveFacts(raw(undefined)))?.action).toContain("Return completeness");
  });

  it("saved answers without the new node are still valid (it is just unanswered); golden return unchanged", () => {
    const saved = effectiveAnswers(def, { age_eric: { v: "no", at: "2026-10-03T00:00:00.000Z", by: null } }, [], RC_CONTEXT);
    expect(saved.age_eric?.value).toBe("no");
    expect(saved.div2b).toBeUndefined();
    const r = computeTy2025Return(fullFacts());
    expect(r.headline.federal.totalTax.amount).toBe(27015);
    expect(r.headline.connecticut.tax.amount).toBe(8788);
  });
});
