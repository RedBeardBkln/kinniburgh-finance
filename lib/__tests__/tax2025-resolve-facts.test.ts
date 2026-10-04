import { describe, expect, it } from "vitest";
import { addressesMatch, normalizeAddress, resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { ty2025FactsSchema } from "@/lib/tax2025/facts";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { ERIC_ID, EVA_ID, fullFacts } from "@/lib/__tests__/tax2025-fixtures";

function doc(over: Partial<RawDocument> & { id: string; docType: string; data: Record<string, unknown> }): RawDocument {
  const { data, ...rest } = over;
  return {
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: { summary: "x", data },
    verified: true,
    legacyFormat: false,
    subjectType: "person",
    subjectUserId: ERIC_ID,
    documentName: null,
    ...rest,
  };
}

function raw(over: Partial<RawTy2025Inputs> = {}): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people: [
      { userId: ERIC_ID, name: "Eric" },
      { userId: EVA_ID, name: "Eva" },
    ],
    scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "name matches the entity name" },
    documents: [],
    planning: {
      filingStatus: "mfj",
      householdMembers: "none",
      evVehicle: "no",
      businessMileage: "no",
      homeOfficeEligibility: "no",
      homeOfficeSqft: null,
      solarCredit: null,
      donationsNone: true,
      fixedAssetsEkcNone: true,
      retirementContributionCents: null,
      estimatedPaymentsCombinedCents: null,
    },
    primaryResidence: { address: "27 Old Barry Rd", basis: "derived", note: "address on the home mortgage Form 1098" },
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
    ...over,
  };
}

const w2doc = (id: string, person: string | null, data: Record<string, unknown>, over: Partial<RawDocument> = {}) =>
  doc({
    id,
    docType: "w2",
    subjectType: person ? "person" : null,
    subjectUserId: person,
    data: {
      employerName: "Alpine Bio",
      employerEIN: "12-3456789",
      wagesCents: 9_000_000,
      federalWithheldCents: 1_100_000,
      socialSecurityWagesCents: 9_000_000,
      socialSecurityWithheldCents: 558_000,
      medicareWagesCents: 9_000_000,
      medicareWithheldCents: 130_500,
      stateLines: [{ stateCode: "CT", stateWagesCents: 9_000_000, stateWithheldCents: 300_000 }],
      box12: [],
      ...data,
    },
    ...over,
  });

describe("resolveFacts: W-2s (per person, boxes 3/4/5/6/7/12/13/14, CT lines, EIN)", () => {
  it("splits W-2s by Document.subjectUserId and reads the boxes; carries employerEin", () => {
    const { facts } = resolveFacts(
      raw({ documents: [w2doc("a", ERIC_ID, {}), w2doc("b", EVA_ID, { employerName: "Brewery", employerEIN: "98-7654321", wagesCents: 4_000_000 })] })
    );
    expect(facts.income.w2s.map((w) => [w.docId, w.personUserId, w.employer, w.employerEin, w.wagesCents])).toEqual([
      ["a", ERIC_ID, "Alpine Bio", "12-3456789", 9_000_000],
      ["b", EVA_ID, "Brewery", "98-7654321", 4_000_000],
    ]);
    expect(facts.income.w2s[0]).toMatchObject({
      socialSecurityWagesCents: 9_000_000,
      socialSecurityWithheldCents: 558_000,
      medicareWagesCents: 9_000_000,
      medicareWithheldCents: 130_500,
      ctWithheldCents: 300_000,
      basis: "doc_verified",
    });
    expect(ty2025FactsSchema.safeParse(facts).success).toBe(true);
  });

  it("non-CT state lines are excluded from CT withholding and reported; legacy flat state withholding is assumed CT", () => {
    const { facts, openItems } = resolveFacts(
      raw({
        documents: [
          w2doc("a", ERIC_ID, {
            stateLines: [
              { stateCode: "CT", stateWagesCents: 100, stateWithheldCents: 300_000 },
              { stateCode: "NY", stateWagesCents: 100, stateWithheldCents: 50_000 },
            ],
          }),
          w2doc("legacy", EVA_ID, { stateLines: undefined, stateWithheldCents: 120_000 }, { legacyFormat: true }),
        ],
      })
    );
    expect(facts.income.w2s[0]!.ctWithheldCents).toBe(300_000);
    expect(facts.income.w2s[1]!.ctWithheldCents).toBe(120_000);
    expect(openItems.some((o) => o.id === "w2-non-ct-state:a")).toBe(true);
  });

  it("a W-2 with no person is a blocking open item (and the return reports SE / excess SS missing)", () => {
    const { facts, openItems } = resolveFacts(raw({ documents: [w2doc("a", null, {})] }));
    expect(facts.income.w2s[0]!.personUserId).toBeNull();
    const item = openItems.find((o) => o.id === "w2-no-person:a");
    expect(item?.severity).toBe("blocking");
    expect(computeTy2025Return(facts).lines["sch3.11"]?.status).toBe("missing_input");
  });

  it("a W-2 with no numeric wages is unusable (never counted as $0) and a blocking open item", () => {
    const { facts, openItems } = resolveFacts(raw({ documents: [w2doc("bad", ERIC_ID, { wagesCents: null })] }));
    expect(facts.income.w2s).toHaveLength(0);
    expect(facts.income.w2Unusable).toEqual([expect.objectContaining({ docId: "bad" })]);
    expect(openItems.find((o) => o.id === "w2-unusable:bad")?.severity).toBe("blocking");
  });

  it("only documents for the tax year with a finished extraction are used; unverified docs are labelled and advisory", () => {
    const { facts, openItems } = resolveFacts(
      raw({
        documents: [
          w2doc("y2024", ERIC_ID, {}, { taxYear: 2024 }),
          w2doc("processing", ERIC_ID, {}, { extractionStatus: "processing" }),
          w2doc("unverified", ERIC_ID, {}, { verified: false }),
        ],
      })
    );
    expect(facts.income.w2s.map((w) => w.docId)).toEqual(["unverified"]);
    expect(facts.income.w2s[0]!.basis).toBe("doc_unverified");
    expect(openItems.find((o) => o.id === "doc-unverified:unverified")?.severity).toBe("advisory");
  });

  it("identical W-2s from the same employer are flagged as a possible duplicate", () => {
    const { openItems } = resolveFacts(raw({ documents: [w2doc("a", ERIC_ID, {}), w2doc("b", ERIC_ID, {})] }));
    expect(openItems.some((o) => o.id.startsWith("w2-duplicate:"))).toBe(true);
  });
});

describe("resolveFacts: 1099, 1098, property tax", () => {
  it("reads interest (box 1 and box 3), dividends (1a, 1b, 2a, 5), exempt interest, withholding and keeps other boxes", () => {
    const { facts, openItems } = resolveFacts(
      raw({
        documents: [
          doc({
            id: "c1",
            docType: "1099",
            data: {
              formVariant: "consolidated",
              payerName: "Robinhood",
              federalWithheldCents: 1_000,
              int_box1Cents: 12_345,
              int_box3Cents: 2_000,
              int_box8Cents: 500,
              div_box1aCents: 100_000,
              div_box1bCents: 80_000,
              div_box2aCents: 3_000,
              div_box5Cents: 4_000,
              div_box7Cents: 700,
              otherBoxes: [{ variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 900_000 }],
            },
          }),
        ],
      })
    );
    expect(facts.income.interest[0]).toMatchObject({ box1Cents: 12_345, box3Cents: 2_000, box8Cents: 500, payer: "Robinhood" });
    expect(facts.income.dividends[0]).toMatchObject({ box1aCents: 100_000, box1bCents: 80_000, box2aCents: 3_000, box5Cents: 4_000, box7Cents: 700 });
    expect(facts.payments.federal1099WithheldCents).toBe(1_000);
    expect(facts.income.otherIncomeBoxes).toEqual([expect.objectContaining({ variant: "1099-B", amountCents: 900_000 })]);
    expect(openItems.find((o) => o.id === "other-income-boxes")?.severity).toBe("blocking");
    expect(openItems.some((o) => o.id === "interest-box3")).toBe(true);
    expect(openItems.some((o) => o.id === "foreign-tax-paid")).toBe(true);
  });

  it("blank boxes read as 0 on a current-format document and stay unknown on a legacy one", () => {
    const current = resolveFacts(raw({ documents: [doc({ id: "n", docType: "1099", data: { formVariant: "1099-DIV", div_box1aCents: 5_000 } })] }));
    expect(current.facts.income.dividends[0]).toMatchObject({ box1aCents: 5_000, box1bCents: 0, box2aCents: 0, box5Cents: 0 });
    const legacy = resolveFacts(
      raw({ documents: [doc({ id: "l", docType: "1099", legacyFormat: true, data: { formVariant: "1099-DIV", amountCents: 5_000 } })] })
    );
    expect(legacy.facts.income.dividends[0]).toMatchObject({ box1aCents: 5_000, box1bCents: null, box2aCents: null, box5Cents: null });
    // so the engine cannot silently use the unknown boxes
    expect(computeTy2025Return(legacy.facts).lines["f1040.3a"]?.status).toBe("missing_input");
  });

  it("a legacy 1099-INT headline amount is used when box 1 was never read; a differing box 1 is a conflict", () => {
    const legacy = resolveFacts(raw({ documents: [doc({ id: "i", docType: "1099", legacyFormat: true, data: { formVariant: "1099-INT", amountCents: 7_700 } })] }));
    expect(legacy.facts.income.interest[0]).toMatchObject({ box1Cents: 7_700, usedLegacyHeadline: true });
    const conflicted = resolveFacts(raw({ documents: [doc({ id: "i2", docType: "1099", data: { formVariant: "1099-INT", amountCents: 9_000, int_box1Cents: 8_000 } })] }));
    expect(conflicted.conflicts).toEqual([expect.objectContaining({ factKey: "income.interest.i2", chosen: "Interest box 1" })]);
  });

  it("reads a Form 1098 (also under the legacy mortgage_interest type)", () => {
    const { facts } = resolveFacts(
      raw({
        documents: [
          doc({
            id: "m",
            docType: "mortgage_interest",
            data: { servicerName: "PennyMac", interestCents: 1_888_269, principalBalanceCents: 40_000_000, originationDate: "2020-06-01", box10Cents: 0, propertyAddress: "27 Old Barry Rd" },
          }),
        ],
      })
    );
    expect(facts.deductions.mortgages[0]).toMatchObject({ lender: "PennyMac", interestCents: 1_888_269, principalCents: 40_000_000, propertyAddress: "27 Old Barry Rd" });
  });

  const bill = (id: string, data: Record<string, unknown>) => doc({ id, docType: "property_tax", data: { jurisdictionName: "Town", ...data } });

  it("classifies property tax bills: primary address match, other real estate, motor vehicle, owner override, unclassified without a known primary", () => {
    const { facts, openItems } = resolveFacts(
      raw({
        documents: [
          bill("home", { taxType: "real_estate", propertyAddress: "27 Old Barry Road", paidInTaxYearCents: 600_000 }),
          bill("arbor", { taxType: "real_estate", propertyAddress: "56 Arbor Rd", paidInTaxYearCents: 300_000 }),
          bill("car", { taxType: "motor_vehicle", paidInTaxYearCents: 20_000 }),
          bill("override", { taxType: "real_estate", propertyAddress: "99 Elm St", paidInTaxYearCents: 1_000 }),
        ],
        answers: { billClassifications: { override: "primary_residence" } },
      })
    );
    const kinds = Object.fromEntries(facts.deductions.propertyTaxBills.map((b) => [b.docId, b.kind]));
    expect(kinds).toEqual({ home: "primary_residence", arbor: "other_real_estate", car: "motor_vehicle", override: "primary_residence" });
    expect(facts.deductions.propertyTaxBills.find((b) => b.docId === "override")?.kindBasis).toBe("answer_owner");
    expect(openItems.some((o) => o.id === "primary-residence-derived")).toBe(true);
    expect(openItems.some((o) => o.id === "no-second-property-bill")).toBe(false); // Arbor Rd bill exists
    const noPrimary = resolveFacts(raw({ primaryResidence: null, documents: [bill("home", { taxType: "real_estate", propertyAddress: "27 Old Barry Rd", paidInTaxYearCents: 1 })] }));
    expect(noPrimary.facts.deductions.propertyTaxBills[0]!.kind).toBe("unclassified");
    expect(noPrimary.openItems.some((o) => o.id === "bill-unclassified:home")).toBe(true);
  });

  it("a bill with no 'paid in the tax year' amount is a blocking open item; no second real-estate bill is an advisory", () => {
    const { facts, openItems } = resolveFacts(raw({ documents: [bill("home", { taxType: "real_estate", propertyAddress: "27 Old Barry Rd", paidInTaxYearCents: null })] }));
    expect(facts.deductions.propertyTaxBills[0]!.paidInYearCents).toBeNull();
    expect(openItems.find((o) => o.id === "bill-no-paid:home")?.severity).toBe("blocking");
    expect(openItems.find((o) => o.id === "no-second-property-bill")?.severity).toBe("advisory");
  });

  it("1098 box 10 that differs from the entered bill amount is a conflict (bill amount used, box 10 never added)", () => {
    const { conflicts } = resolveFacts(
      raw({
        documents: [
          doc({ id: "m", docType: "mortgage_interest", data: { interestCents: 1, box10Cents: 500_000, propertyAddress: "27 Old Barry Rd" } }),
          bill("home", { taxType: "real_estate", propertyAddress: "27 Old Barry Rd", paidInTaxYearCents: 600_000 }),
        ],
      })
    );
    expect(conflicts.find((c) => c.factKey === "deductions.propertyTax.home")?.chosen).toContain("Bill");
  });
});

describe("resolveFacts: conflicts, payments split, prior year, statements", () => {
  it("acceptance 10: a retirement answer lower than the W-2 box 12 deferrals is a conflict listing both values", () => {
    const { conflicts } = resolveFacts(
      raw({
        planning: { ...raw().planning, retirementContributionCents: 500_000 },
        documents: [w2doc("a", ERIC_ID, { box12: [{ code: "D", amountCents: 2_300_000 }, { code: "DD", amountCents: 900_000 }] })],
      })
    );
    const c = conflicts.find((x) => x.factKey === "adjustments.retirementContributions");
    expect(c).toBeDefined();
    expect(c!.candidates.map((x) => x.value)).toEqual([500_000, 2_300_000]);
    expect(c!.candidates.map((x) => x.basis)).toEqual(["answer_owner", "doc_verified"]);
    expect(c!.chosen).toBeNull();
  });

  it("no retirement conflict when the answer covers the W-2 deferrals, or when there is no answer", () => {
    const docs = [w2doc("a", ERIC_ID, { box12: [{ code: "D", amountCents: 2_300_000 }] })];
    expect(resolveFacts(raw({ documents: docs, planning: { ...raw().planning, retirementContributionCents: 2_500_000 } })).conflicts).toEqual([]);
    expect(resolveFacts(raw({ documents: docs })).conflicts).toEqual([]);
  });

  it("D2 / acceptance 9: the legacy combined estimates answer is kept but never split; a blocking item asks for federal and CT separately", () => {
    const { facts, openItems } = resolveFacts(raw({ planning: { ...raw().planning, estimatedPaymentsCombinedCents: 1_000_000 } }));
    expect(facts.payments.combinedEstimatesAnswer.value).toBe(1_000_000);
    expect(facts.payments.federalEstimates.value).toBeNull();
    expect(facts.payments.ctEstimates.value).toBeNull();
    expect(openItems.find((o) => o.id === "estimates-combined-unsplittable")?.severity).toBe("blocking");
  });

  it("typed split answers (Phase 1b hooks) fill federal and CT payments separately", () => {
    const { facts, openItems } = resolveFacts(
      raw({
        planning: { ...raw().planning, estimatedPaymentsCombinedCents: 1_000_000 },
        answers: {
          federalEstimates: [{ paidOn: "2025-04-15", amountCents: 600_000, appliesToTaxYear: 2025 }],
          ctEstimates: [{ paidOn: "2026-01-15", amountCents: 400_000, appliesToTaxYear: 2025 }],
          federalExtensionPaymentCents: 0,
        },
      })
    );
    expect(facts.payments.federalEstimates.value).toHaveLength(1);
    expect(facts.payments.ctEstimates.value?.[0]?.paidOn).toBe("2026-01-15");
    expect(facts.payments.federalExtensionPayment.value).toBe(0);
    expect(openItems.some((o) => o.id === "estimates-combined-unsplittable")).toBe(false);
  });

  it("prior-year return: read only from a 2024 tax_return document (formType 1040); absent -> advisory", () => {
    const withReturn = resolveFacts(
      raw({
        documents: [doc({ id: "r24", docType: "tax_return", taxYear: 2024, data: { formType: "1040", totalTaxCents: 2_500_000, agiCents: 17_000_000 } })],
      })
    );
    expect(withReturn.facts.priorYear.totalTaxCents).toMatchObject({ value: 2_500_000, basis: "doc_verified" });
    expect(withReturn.facts.priorYear.agiCents.value).toBe(17_000_000);
    expect(withReturn.openItems.some((o) => o.id === "prior-year-return")).toBe(false);
    const without = resolveFacts(raw());
    expect(without.facts.priorYear.totalTaxCents.value).toBeNull();
    expect(without.openItems.some((o) => o.id === "prior-year-return")).toBe(true);
    // a CT return (formType other) is not mistaken for the federal one
    const ct = resolveFacts(raw({ documents: [doc({ id: "ct24", docType: "tax_return", taxYear: 2024, data: { formType: "other", totalTaxCents: 1, agiCents: 1 } })] }));
    expect(ct.facts.priorYear.totalTaxCents.value).toBeNull();
  });

  it("planning answers become facts with provenance: dependents none, no EV, no business mileage, solar already claimed", () => {
    const { facts } = resolveFacts(raw({ planning: { ...raw().planning, solarCredit: "claimed_already" } }));
    expect(facts.household.noDependents).toMatchObject({ value: true, basis: "answer_owner" });
    expect(facts.household.noEvPurchase.value).toBe(true);
    expect(facts.income.scheduleC.mileageNoneConfirmed.value).toBe(true);
    expect(facts.statedNone.solar_credit?.value).toBe(true);
    expect(facts.income.scheduleC.ownerUserId).toMatchObject({ value: ERIC_ID, basis: "derived" });
    // unanswered -> missing leaf, never false
    const none = resolveFacts(raw({ planning: { ...raw().planning, householdMembers: null, evVehicle: null, businessMileage: null } }));
    expect(none.facts.household.noDependents.value).toBeNull();
    expect(none.facts.income.scheduleC.mileageNoneConfirmed.value).toBeNull();
  });

  it("the planning answer 'no business mileage' conflicts with mileage log entries", () => {
    const { conflicts } = resolveFacts(raw({ ekc: { ...raw().ekc, mileage: [{ miles: 10, ratePerMile: "0.700", dateIso: "2025-03-01" }] } }));
    expect(conflicts.some((c) => c.factKey === "scheduleC.mileage")).toBe(true);
  });

  it("filing status other than MFJ: conflict and a blocking open item; unanswered: advisory", () => {
    const mfs = resolveFacts(raw({ planning: { ...raw().planning, filingStatus: "mfs" } }));
    expect(mfs.openItems.find((o) => o.id === "filing-status-not-mfj")?.severity).toBe("blocking");
    expect(mfs.conflicts.some((c) => c.factKey === "household.filingStatus")).toBe(true);
    const unanswered = resolveFacts(raw({ planning: { ...raw().planning, filingStatus: null } }));
    expect(unanswered.openItems.find((o) => o.id === "filing-status-unanswered")?.severity).toBe("advisory");
    expect(unanswered.facts.household.filingStatus.value).toBeNull();
  });

  it("Schedule C owner unknown -> blocking item; derived owner -> advisory", () => {
    expect(resolveFacts(raw({ scheduleCOwner: null })).openItems.find((o) => o.id === "schedule-c-owner-unknown")?.severity).toBe("blocking");
    expect(resolveFacts(raw()).openItems.find((o) => o.id === "schedule-c-owner-derived")?.severity).toBe("advisory");
  });

  it("stated 'none' statements from answers become provenance-carrying leaves", () => {
    const { facts } = resolveFacts(raw({ answers: { statedNone: { other_income: true, se_other: false }, noInterestConfirmed: true } }));
    expect(facts.statedNone.other_income).toMatchObject({ value: true, basis: "answer_owner" });
    expect(facts.statedNone.se_other?.value).toBe(false);
    expect(facts.income.noInterestConfirmed.value).toBe(true);
    expect(facts.statedNone.other_adjustments).toBeUndefined();
  });

  it("an empty resolution is a valid facts object and the return computes without throwing", () => {
    const { facts } = resolveFacts(raw());
    expect(ty2025FactsSchema.safeParse(facts).success).toBe(true);
    const ret = computeTy2025Return(facts);
    expect(ret.headline.complete).toBe(false);
    expect(ret.lines["f1040.1a"]?.status).toBe("missing_input");
  });
});

describe("resolveFacts: paystubs", () => {
  it("paystub withholding is never added to the return; it is an advisory item (the W-2 is the year-end source)", () => {
    const { facts, openItems } = resolveFacts(raw({ paystubs: { federalWithheldCents: 10_000, ctWithheldCents: 5_000 } }));
    expect(facts.payments.federalPaystubWithheldCents).toBe(10_000);
    expect(openItems.find((o) => o.id === "paystub-withholding-not-added")?.severity).toBe("advisory");
    // and the engine ignores it
    const f = fullFacts();
    f.payments.federalPaystubWithheldCents = 999_999;
    f.payments.ctPaystubWithheldCents = 999_999;
    const ret = computeTy2025Return(f);
    expect(ret.lines["f1040.25a"]?.amount).toBe(15000);
    expect(ret.lines["ct1040.18"]?.amount).toBe(4200);
  });
});

describe("address matching", () => {
  it("matches the same street number and name across suffix spellings and punctuation", () => {
    expect(normalizeAddress("27 Old Barry Road,")).toBe("27 old barry rd");
    expect(addressesMatch("27 Old Barry Rd", "27 Old Barry Road")).toBe(true);
    expect(addressesMatch("56 Arbor Rd", "27 Old Barry Rd")).toBe(false);
    expect(addressesMatch("27 Old Barry Rd", "27 Old Barry Rd Unit 2")).toBe(true);
    expect(addressesMatch("27 Old Barry Rd", "29 Old Barry Rd")).toBe(false);
  });
});
