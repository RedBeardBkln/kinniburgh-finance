// Plain fixtures for the TY2025 engine tests. No DB, no network. NOT a test file
// (vitest only collects *.test.ts); imported by the tax2025-*.test.ts files.

import {
  emptyReturnAnswers,
  type DividendFact,
  type GlLineFact,
  type InterestFact,
  type PropertyTaxBill,
  type Ty2025Facts,
  type W2Fact,
} from "@/lib/tax2025/facts";
import { NONE_GROUP_IDS } from "@/lib/tax2025/line-catalog";
import { missingLeaf, sourced, type Sourced } from "@/lib/tax2025/types";

export const ERIC_ID = "user-eric";
export const EVA_ID = "user-eva";

export function owner<T>(value: T): Sourced<T> {
  return sourced(value, "answer_owner", [{ kind: "planning", id: "fixture", label: "fixture answer" }]);
}

/** Every leaf missing: the "nothing known yet" facts object. */
export function emptyFacts(): Ty2025Facts {
  return {
    taxYear: 2025,
    household: {
      filingStatus: missingLeaf(),
      people: [
        { userId: ERIC_ID, name: "Eric" },
        { userId: EVA_ID, name: "Eva" },
      ],
      noDependents: missingLeaf(),
      noEvPurchase: missingLeaf(),
    },
    income: {
      w2s: [],
      w2Unusable: [],
      interest: [],
      noInterestConfirmed: missingLeaf(),
      dividends: [],
      noDividendsConfirmed: missingLeaf(),
      otherIncomeBoxes: [],
      scheduleC: {
        ownerUserId: missingLeaf(),
        glLines: [],
        booksEmpty: true,
        glExcludedTransactionCount: 0,
        mileage: [],
        mileageNoneConfirmed: missingLeaf(),
        homeOfficeEligibility: missingLeaf(),
        homeOfficeSqft: missingLeaf(),
        fixedAssets: [],
        fixedAssetsNoneConfirmed: false,
      },
    },
    adjustments: {
      sch1a: missingLeaf(),
      hsa: missingLeaf(),
      ira: missingLeaf(),
      seRetirement: missingLeaf(),
      seHealthInsurance: missingLeaf(),
    },
    credits: { foreignTax: missingLeaf(), savers: missingLeaf() },
    statedNone: {},
    deductions: {
      mortgages: [],
      propertyTaxBills: [],
      noPropertyTaxConfirmed: missingLeaf(),
      donations: [],
      noDonationsConfirmed: missingLeaf(),
      primaryResidenceAddress: missingLeaf(),
    },
    payments: {
      federal1099WithheldCents: 0,
      federalPaystubWithheldCents: 0,
      ctPaystubWithheldCents: 0,
      federalEstimates: missingLeaf(),
      federalExtensionPayment: missingLeaf(),
      federalPriorYearOverpaymentApplied: missingLeaf(),
      ctEstimates: missingLeaf(),
      ctExtensionPayment: missingLeaf(),
      ctPriorYearOverpaymentApplied: missingLeaf(),
      ctPriorYearBalancePaidIn2025: missingLeaf(),
      combinedEstimatesAnswer: missingLeaf(),
    },
    ct: { useTax: missingLeaf(), additions: missingLeaf(), subtractions: missingLeaf() },
    priorYear: { totalTaxCents: missingLeaf(), agiCents: missingLeaf(), filingStatus: missingLeaf() },
    returnAnswers: emptyReturnAnswers([
      { slot: "a", userId: ERIC_ID, name: "Eric" },
      { slot: "b", userId: EVA_ID, name: "Eva" },
    ]),
  };
}

export function w2(overrides: Partial<W2Fact> & { docId: string }): W2Fact {
  return {
    employer: "Employer",
    employerEin: null,
    personUserId: ERIC_ID,
    subjectType: "person",
    basis: "doc_verified",
    legacyFormat: false,
    refs: [{ kind: "document", id: overrides.docId, label: "W-2" }],
    wagesCents: 0,
    fedWithheldCents: 0,
    socialSecurityWagesCents: 0,
    socialSecurityWithheldCents: 0,
    medicareWagesCents: 0,
    medicareWithheldCents: 0,
    socialSecurityTipsCents: null,
    dependentCareBenefitsCents: null,
    box12: [],
    retirementPlan: null,
    box14: [],
    stateLines: [],
    ctWithheldCents: 0,
    ...overrides,
  };
}

export function interest(overrides: Partial<InterestFact> & { docId: string }): InterestFact {
  return {
    payer: "Bank",
    basis: "doc_verified",
    legacyFormat: false,
    refs: [{ kind: "document", id: overrides.docId, label: "1099-INT" }],
    box1Cents: 0,
    usedLegacyHeadline: false,
    box3Cents: 0,
    box4Cents: null,
    box6Cents: 0,
    box8Cents: 0,
    box9Cents: 0,
    ...overrides,
  };
}

export function dividend(overrides: Partial<DividendFact> & { docId: string }): DividendFact {
  return {
    payer: "Broker",
    basis: "doc_verified",
    legacyFormat: false,
    refs: [{ kind: "document", id: overrides.docId, label: "1099-DIV" }],
    box1aCents: 0,
    box1bCents: 0,
    box2aCents: 0,
    box3Cents: 0,
    box4Cents: null,
    box5Cents: 0,
    box7Cents: 0,
    box11Cents: 0,
    ...overrides,
  };
}

export function gl(code: string, name: string, glType: "revenue" | "expense", totalCents: number): GlLineFact {
  return { glCodeId: `id-${code}`, code, name, glType, totalCents };
}

export function bill(overrides: Partial<PropertyTaxBill> & { docId: string }): PropertyTaxBill {
  return {
    label: "Town",
    basis: "doc_verified",
    legacyFormat: false,
    refs: [{ kind: "document", id: overrides.docId, label: "bill" }],
    taxType: "real_estate",
    address: null,
    billedCents: null,
    paidInYearCents: null,
    kind: "primary_residence",
    kindBasis: "answer_owner",
    ...overrides,
  };
}

/**
 * Eric's shape with everything answered, so every strict line is computable:
 * two W-2 earners (Eric: Employer A with SS wages above the base + a second job; Eva one job),
 * Schedule C profit from GL lines, interest, dividends, a primary-residence mortgage and property tax,
 * stated "none" for every adjustment/credit that a later phase computes.
 */
export function fullFacts(): Ty2025Facts {
  const f = emptyFacts();
  f.household.filingStatus = owner("mfj");
  f.household.noDependents = owner(true);
  f.household.noEvPurchase = owner(true);
  // Form 1040 line 12d: neither spouse is born before January 2, 1961 or blind (so the standard deduction is the base amount).
  for (const p of f.returnAnswers.people) {
    p.bornBefore1961 = owner(false);
    p.blind = owner(false);
  }

  f.income.w2s = [
    w2({
      docId: "w2-eric-a",
      employer: "Alpine Bio",
      personUserId: ERIC_ID,
      wagesCents: 9_000_000,
      fedWithheldCents: 1_100_000,
      socialSecurityWagesCents: 9_000_000,
      socialSecurityWithheldCents: 558_000,
      medicareWagesCents: 9_000_000,
      medicareWithheldCents: 130_500,
      ctWithheldCents: 300_000,
    }),
    w2({
      docId: "w2-eva",
      employer: "Brewery",
      personUserId: EVA_ID,
      wagesCents: 4_000_000,
      fedWithheldCents: 400_000,
      socialSecurityWagesCents: 4_000_000,
      socialSecurityWithheldCents: 248_000,
      medicareWagesCents: 4_000_000,
      medicareWithheldCents: 58_000,
      ctWithheldCents: 120_000,
    }),
  ];
  f.income.interest = [interest({ docId: "int-1", box1Cents: 50_000 })];
  f.income.dividends = [dividend({ docId: "div-1", box1aCents: 100_000, box1bCents: 80_000 })];

  f.income.scheduleC.ownerUserId = sourced(ERIC_ID, "derived");
  f.income.scheduleC.booksEmpty = false;
  f.income.scheduleC.glLines = [
    gl("4000", "Services", "revenue", 6_000_000),
    gl("5010", "Office expenses:Software & apps", "expense", 600_000),
    gl("5020", "Insurance:Business insurance", "expense", 400_000),
  ];
  f.income.scheduleC.homeOfficeEligibility = owner("no");
  f.income.scheduleC.fixedAssetsNoneConfirmed = true;

  f.adjustments = {
    sch1a: owner(0),
    hsa: owner(0),
    ira: owner(0),
    seRetirement: owner(0),
    seHealthInsurance: owner(0),
  };
  f.credits = { foreignTax: owner(0), savers: owner(0) };
  f.income.scheduleC.mileageNoneConfirmed = owner(true);
  for (const g of NONE_GROUP_IDS) f.statedNone[g] = owner(true);

  f.deductions.primaryResidenceAddress = owner("27 Old Barry Rd");
  f.deductions.mortgages = [
    {
      docId: "m-1",
      lender: "Lender",
      basis: "doc_verified",
      legacyFormat: false,
      refs: [{ kind: "document", id: "m-1", label: "1098" }],
      interestCents: 1_888_269,
      principalCents: 40_000_000,
      originationDate: "2020-06-01",
      mortgageInsuranceCents: null,
      pointsCents: null,
      box10Cents: null,
      propertyAddress: "27 Old Barry Rd",
    },
  ];
  f.deductions.propertyTaxBills = [
    bill({ docId: "pt-1", label: "Town of X", address: "27 Old Barry Rd", paidInYearCents: 600_000, kind: "primary_residence" }),
  ];
  f.deductions.noDonationsConfirmed = owner(true);

  f.payments.federalEstimates = owner([]);
  f.payments.federalExtensionPayment = owner(0);
  f.payments.federalPriorYearOverpaymentApplied = owner(0);
  f.payments.ctEstimates = owner([]);
  f.payments.ctExtensionPayment = owner(0);
  f.payments.ctPriorYearOverpaymentApplied = owner(0);
  f.payments.ctPriorYearBalancePaidIn2025 = owner(0);
  f.ct = { useTax: owner(0), additions: owner(0), subtractions: owner(0) };
  return f;
}

/**
 * fullFacts() with the Phase 1b lines driven by the Return completeness ANSWERS instead of stated amounts:
 * every question answered "none" / "no", the stated adjustment / credit / use-tax leaves removed, and a
 * 2024 return (tax 20,000, AGI 120,000, joint) for the Form 2210 estimate.
 */
export function fullFacts1b(): Ty2025Facts {
  const f = fullFacts();
  f.adjustments.sch1a = missingLeaf();
  f.adjustments.hsa = missingLeaf();
  f.adjustments.ira = missingLeaf();
  f.credits.foreignTax = missingLeaf();
  f.credits.savers = missingLeaf();
  f.ct.useTax = missingLeaf();
  for (const p of f.returnAnswers.people) {
    p.coveredByWorkplacePlan = owner(false);
    p.deferralsCents = owner(0);
    p.traditionalIraCents = owner(0);
    p.rothIraCents = owner(0);
    p.hsaCoverage = owner("none");
    p.hsaDistributions = owner("none");
    p.tipsChoice = owner("none");
    p.overtimeChoice = owner("none");
  }
  const ra = f.returnAnswers;
  ra.retirementDistributionSince2022 = owner(false);
  ra.studentOrDependent = owner(false);
  ra.carLoan.choice = owner("none");
  ra.attestations = { digitalAssets: owner(false), foreignAccounts: owner(false) };
  ra.priorYear = { filedJoint: owner(true), hadExcludedTaxOrRefundable: owner(false) };
  ra.useTax.choice = owner("none");
  f.priorYear = { totalTaxCents: owner(2_000_000), agiCents: owner(12_000_000), filingStatus: owner("mfj") };
  return f;
}
