import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { answered } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { computeCtUseTax } from "@/lib/tax2025/rules/ct-use-tax";
import { D } from "@/lib/tax2025/money";
import { RETURN_COMPLETENESS_ID, questionnaireById } from "@/lib/tax-questionnaire-content";
import { ERIC_ID, EVA_ID, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";
import { computeTy2025Return } from "@/lib/tax2025/return";

const read = (f: string) => readFileSync(resolve(__dirname, "../../", f), "utf8").replace(/\s+/g, " ");

describe("D1: the Form 2210 line 8 '2024 tax' claim matches the Instructions for Form 2210 (2025)", () => {
  it("the constant, spec 09 and the penalty rule header say Additional Medicare Tax and NIIT ARE included (lines 11 and 12 are in the chart)", () => {
    const note = String(K.FORM_2210_PRIOR_YEAR_TAX_NOTE.value);
    expect(note).toContain("Schedule 2 lines 4, 8 (distributions only), 9, 10, 11, 12, 14, 15, 16, 17a, 17c-17j, 17l, 17z, 19");
    expect(note).toContain("ARE included");
    expect(note).not.toContain("does NOT include");
    const spec = read("specs/09-tax-year-2025-constants.md");
    expect(spec).toContain("Additional Medicare Tax (line 11) and NIIT (line 12) ARE included");
    expect(spec).not.toContain("NOT Additional Medicare Tax or NIIT");
    const rule = read("lib/tax2025/rules/penalty-2210.ts").replace(/\/\/ /g, "");
    expect(rule).toContain("ARE included");
    expect(rule).not.toContain("it does NOT include the 2024");
  });

  it("the pyextra question asks ONLY about refundable credits / Schedule 2 lines 5-7 and 13, and its help says Additional Medicare Tax and NIIT are included", () => {
    const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
    const n = def.nodes.find((x) => x.id === "pyextra")!;
    expect(n.prompt).toContain("refundable credit");
    expect(n.prompt).not.toMatch(/Additional Medicare|net investment/i);
    expect(n.help).toContain("includes Additional Medicare Tax and net investment income tax");
    expect(n.help).not.toContain("does not include Additional Medicare");
    expect(def.version).toBe(2); // saved answers written against version 1 show stale
  });

  it("a 'yes' to the old question no longer matters: no refundable credit / unreported-tip tax -> the estimate runs", () => {
    const r = computeTy2025Return(fullFacts1b());
    expect(r.lines["f2210.19"]?.status).toBe("computed");
  });
});

describe("L2: CT use tax is floored at zero per purchase row", () => {
  const base = { choice: answered("some" as const), otherRateItems: answered(false) };
  it("1,000 taxed 10% elsewhere (100 paid) + 1,000 untaxed: 0 + 63.50 = 63.50 (not 127 - 100 = 27)", () => {
    const r = computeCtUseTax({ ...base, generalRatePurchases: answered(D(1000)), taxPaidToOtherState: answered(D(100)), untaxedPurchases: answered(D(1000)) });
    expect(r.ok && r.amount.toString()).toBe("63.5");
  });
  it("without a second row the single-row behaviour is unchanged; a missing second row blocks", () => {
    const one = computeCtUseTax({ ...base, generalRatePurchases: answered(D(1000)), taxPaidToOtherState: answered(D(20)) });
    expect(one.ok && one.amount.toString()).toBe("43.5");
    const miss = computeCtUseTax({ ...base, generalRatePurchases: answered(D(1000)), taxPaidToOtherState: answered(D(20)), untaxedPurchases: { state: "missing" } });
    expect(!miss.ok && miss.status).toBe("missing_input");
  });
  it("flows through the return: taxed 1,000 (paid 100) + untaxed 1,000 -> CT-1040 line 15 = 64 (63.50 rounded)", () => {
    const f = fullFacts1b();
    f.returnAnswers.useTax = {
      choice: owner("some"),
      generalRatePurchasesCents: owner(100_000),
      otherRateItems: owner(false),
      taxPaidToOtherStateCents: owner(10_000),
      untaxedPurchasesCents: owner(100_000),
    };
    expect(computeTy2025Return(f).lines["ct1040.15"]?.amount).toBe(64);
  });
});

function w2doc(person: string, box12: { code: string; amountCents: number }[]): RawDocument {
  return {
    id: `w-${person}`,
    docType: "w2",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: { summary: "x", data: { employerName: "A", wagesCents: 9_000_000, federalWithheldCents: 1, socialSecurityWagesCents: 9_000_000, socialSecurityWithheldCents: 1, medicareWagesCents: 9_000_000, medicareWithheldCents: 1, box12 } },
    verified: true,
    legacyFormat: false,
    subjectType: "person",
    subjectUserId: person,
    documentName: null,
  };
}
function raw(people: { userId: string; name: string }[], documents: RawDocument[], returnAnswers = fullFacts1b().returnAnswers): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people,
    scheduleCOwner: null,
    documents,
    planning: { filingStatus: "mfj", householdMembers: "none", evVehicle: "no", businessMileage: "no", homeOfficeEligibility: "no", homeOfficeSqft: null, solarCredit: null, donationsNone: true, fixedAssetsEkcNone: true, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
    answers: { statedNone: {}, returnAnswers },
    primaryResidence: null,
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  };
}

describe("L4: W-2 box 12 code EE (designated Roth 457(b)) counts in the deferral cross-check", () => {
  it("an EE amount equal to the owner's deferrals is no conflict; a different one is", () => {
    const ra = fullFacts1b().returnAnswers;
    ra.people[0]!.deferralsCents = owner(500_000);
    const people = [{ userId: ERIC_ID, name: "Eric" }, { userId: EVA_ID, name: "Eva" }];
    const ok = resolveFacts(raw(people, [w2doc(ERIC_ID, [{ code: "EE", amountCents: 500_000 }])], ra));
    expect(ok.conflicts.some((c) => c.factKey === "returnAnswers.a.deferrals")).toBe(false);
    const bad = resolveFacts(raw(people, [w2doc(ERIC_ID, [{ code: "EE", amountCents: 600_000 }])], ra));
    expect(bad.conflicts.find((c) => c.factKey === "returnAnswers.a.deferrals")?.candidates[1]?.value).toBe(600_000);
  });
});

describe("L5: exact first-name token matching; ambiguity or no match is a BLOCKING item", () => {
  const ids = (r: ReturnType<typeof resolveFacts>) => r.openItems.filter((o) => o.id.startsWith("rc-person-unmatched"));
  it("Eric / Eva-Laura match; no item", () => {
    const people = [{ userId: ERIC_ID, name: "Eric Kinniburgh" }, { userId: EVA_ID, name: "Eva-Laura Ramirez-Wisiackas" }];
    const ra = fullFacts1b().returnAnswers;
    ra.people[0]!.userId = ERIC_ID;
    ra.people[1]!.userId = EVA_ID;
    expect(ids(resolveFacts(raw(people, [], ra)))).toEqual([]);
  });
  it("two users named Eric, or 'Evan' for Eva: userId null and a blocking item with the reason", () => {
    const ra = fullFacts1b().returnAnswers;
    ra.people[0]!.userId = null;
    ra.people[1]!.userId = null;
    const dup = resolveFacts(raw([{ userId: "1", name: "Eric A" }, { userId: "2", name: "Eric B" }, { userId: "3", name: "Evan C" }], [], ra));
    const items = ids(dup);
    expect(items.map((i) => i.severity)).toEqual(["blocking", "blocking"]);
    expect(items[0]!.message).toContain("more than one");
    expect(items[1]!.message).toContain("no household member");
  });
});
