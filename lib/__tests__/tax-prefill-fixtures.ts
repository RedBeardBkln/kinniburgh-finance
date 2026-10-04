// Plain fixtures for the prefill action / render tests. No DB, no network. NOT a test file
// (vitest only collects *.test.ts).

import { computePrefillSuggestions, type PrefillSuggestion } from "@/lib/tax-prefill";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";

export const ERIC = "aaaaaaaa-0000-4000-8000-00000000e001";
export const EVA = "aaaaaaaa-0000-4000-8000-00000000e002";

export const DOC_A = "bbbbbbbb-0000-4000-8000-00000000000a";
export const DOC_B = "bbbbbbbb-0000-4000-8000-00000000000b";
export const DOC_EVA = "bbbbbbbb-0000-4000-8000-00000000000c";
export const DOC_RET = "bbbbbbbb-0000-4000-8000-00000000000d";
export const DOC_RET2 = "bbbbbbbb-0000-4000-8000-00000000000e";
export const DOC_OTHER = "bbbbbbbb-0000-4000-8000-0000000000ff";

export function box12(...e: [string, number][]): { code: string; amountCents: number }[] {
  return e.map(([code, amountCents]) => ({ code, amountCents }));
}

export function w2doc(
  id: string,
  person: string | null,
  data: Record<string, unknown> = {},
  over: Partial<RawDocument> = {}
): RawDocument {
  return {
    id,
    docType: "w2",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      summary: "x",
      data: {
        employerName: `Employer ${id.slice(-1)}`,
        employerEIN: `12-34567${id.slice(-2)}`.slice(0, 10),
        wagesCents: 9_000_000,
        federalWithheldCents: 1_100_000,
        socialSecurityWagesCents: 9_000_000,
        socialSecurityWithheldCents: 558_000,
        medicareWagesCents: 9_000_000,
        medicareWithheldCents: 130_500,
        stateLines: [{ stateCode: "CT", stateWagesCents: 9_000_000, stateWithheldCents: 300_000 }],
        box12: [],
        retirementPlan: false,
        ...data,
      },
    },
    verified: true,
    legacyFormat: false,
    subjectType: person ? "person" : null,
    subjectUserId: person,
    documentName: null,
    ...over,
  };
}

export function returnDoc(id: string, data: Record<string, unknown> = {}, over: Partial<RawDocument> = {}): RawDocument {
  return {
    id,
    docType: "tax_return",
    taxYear: 2024,
    extractionStatus: "complete",
    extractionData: { summary: "x", data: { formType: "1040", filingStatus: "mfj", totalTaxCents: 3_000_000, agiCents: 12_000_000, ...data } },
    verified: true,
    legacyFormat: false,
    subjectType: "joint",
    subjectUserId: null,
    documentName: null,
    ...over,
  };
}

export function rawInputs(documents: RawDocument[], over: Partial<RawTy2025Inputs> = {}): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people: [
      { userId: ERIC, name: "Eric Kinniburgh" },
      { userId: EVA, name: "Eva-Laura Ramirez-Wisiackas" },
    ],
    scheduleCOwner: { userId: ERIC, basis: "derived", note: "x" },
    documents,
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
    primaryResidence: null,
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
    ...over,
  };
}

/** The suggestions the real pipeline (resolveFacts -> computePrefillSuggestions) produces for these documents. */
export function suggestionsFor(documents: RawDocument[], over: Partial<RawTy2025Inputs> = {}): PrefillSuggestion[] {
  const r = rawInputs(documents, over);
  const { facts } = resolveFacts(r);
  return computePrefillSuggestions({
    year: 2025,
    people: r.people,
    w2s: facts.income.w2s,
    w2Unusable: facts.income.w2Unusable,
    documents: r.documents,
    solarCredit: r.planning.solarCredit,
  });
}
