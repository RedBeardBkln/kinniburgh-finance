// The retirement contribution document (Form 5498) as a fact: read through lib/retirement-statement.ts by resolveFacts, tied out against the
// owner's traditional IRA answer (a conflict when they differ), cited on Form 8606 line 1 (provenance), never used for a number.
// Pure: rows in, facts out.

import { describe, expect, it } from "vitest";
import { emptyReturnAnswers, ty2025FactsSchema } from "@/lib/tax2025/facts";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { ERIC_ID, EVA_ID, owner } from "@/lib/__tests__/tax2025-fixtures";

const DOC_ID = "ba3c7bda-5498";

function retirementDoc(over: Partial<RawDocument> = {}, data: Record<string, unknown> = {}): RawDocument {
  return {
    id: DOC_ID,
    docType: "retirement_contribution",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      summary: "x",
      data: {
        formVariant: "form_5498",
        issuerName: "Inspira Financial Trust, LLC",
        accountKind: "traditional_ira",
        taxYear: 2025,
        iraContributionsCents: 700_000,
        rothIraContributionsCents: 0,
        rolloverContributionsCents: 0,
        recharacterizedContributionsCents: 0,
        fairMarketValueCents: 4_914_679,
        ...data,
      },
    },
    verified: true,
    legacyFormat: false,
    subjectType: "person",
    subjectUserId: ERIC_ID,
    documentName: null,
    ...over,
  };
}

function raw(documents: RawDocument[], traditionalCents: number | null = 700_000): RawTy2025Inputs {
  const ra = emptyReturnAnswers([
    { slot: "a", userId: ERIC_ID, name: "Eric" },
    { slot: "b", userId: EVA_ID, name: "Eva" },
  ]);
  if (traditionalCents !== null) ra.people[0]!.traditionalIraCents = owner(traditionalCents);
  return {
    taxYear: 2025,
    people: [
      { userId: ERIC_ID, name: "Eric" },
      { userId: EVA_ID, name: "Eva" },
    ],
    scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "x" },
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
    answers: { returnAnswers: ra },
    primaryResidence: { address: "27 Old Barry Rd", basis: "derived", note: "x" },
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  };
}

describe("retirement statements as facts", () => {
  it("Eric's verified 5498: box 1 and the year-end value are carried with the person and the document reference; the value is read but no line uses it", () => {
    const { facts, conflicts, openItems } = resolveFacts(raw([retirementDoc()]));
    const s = facts.income.retirementStatements ?? [];
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      docId: DOC_ID,
      personUserId: ERIC_ID,
      basis: "doc_verified",
      legacyFormat: false,
      traditionalIraCents: 700_000,
      rothIraCents: 0,
      fairMarketValueCents: 4_914_679,
      rothConversionCents: null,
    });
    expect(s[0]!.refs).toEqual([{ kind: "document", id: DOC_ID, label: "Retirement statement Inspira Financial Trust, LLC" }]);
    // the owner answer (7,000.00) equals box 1: no conflict, no document advisory
    expect(conflicts.filter((c) => c.factKey.includes("traditionalIra"))).toEqual([]);
    expect(openItems.filter((o) => o.id.includes(DOC_ID))).toEqual([]);
    expect(ty2025FactsSchema.safeParse(facts).success).toBe(true);
  });

  it("the owner's answer and box 1 differ (7,000 versus 6,000): a conflict that keeps the owner answer and says what box 1 counts", () => {
    const { conflicts } = resolveFacts(raw([retirementDoc({}, { iraContributionsCents: 600_000 })]));
    const c = conflicts.find((x) => x.factKey === "returnAnswers.a.traditionalIra");
    expect(c).toBeDefined();
    expect(c!.candidates.map((x) => [x.basis, x.value])).toEqual([
      ["answer_owner", 700_000],
      ["doc_verified", 600_000],
    ]);
    expect(c!.chosen).toContain("owner answer");
    expect(c!.reason).toContain("April 15, 2026");
    expect(c!.reason).not.toMatch(/CPA/);
  });

  it("no owner answer for the traditional contribution: no conflict is raised (nothing to compare)", () => {
    const { conflicts } = resolveFacts(raw([retirementDoc()], null));
    expect(conflicts.filter((c) => c.factKey.includes("traditionalIra"))).toEqual([]);
  });

  it("box 3 (conversion), box 4 (recharacterization) or box 13a on the statement: an advisory item that points at the Form 8606 question, never a number", () => {
    const { openItems } = resolveFacts(raw([retirementDoc({}, { rothConversionCents: 1_000_000, recharacterizedContributionsCents: 50_000, postponedContributionCents: 20_000, postponedForYear: 2024 })]));
    const i = openItems.find((o) => o.id === `retirement-doc-ira-event:${DOC_ID}`);
    expect(i).toBeDefined();
    expect(i!.severity).toBe("advisory");
    expect(i!.message).toContain("a Roth conversion (box 3: $10000.00)");
    expect(i!.message).toContain("a recharacterized contribution (box 4: $500.00)");
    expect(i!.message).toContain("box 13a: $200.00 for 2024");
    expect(i!.message).not.toMatch(/CPA/);
    expect(i!.refs.map((r) => r.id)).toEqual([DOC_ID]);
  });

  it("an unverified AI read raises the standard doc-unverified advisory; the fact is labelled doc_unverified", () => {
    const { facts, openItems } = resolveFacts(raw([retirementDoc({ verified: false })]));
    expect(facts.income.retirementStatements?.[0]?.basis).toBe("doc_unverified");
    expect(openItems.find((o) => o.id === `doc-unverified:${DOC_ID}`)?.severity).toBe("advisory");
  });

  it("a legacy-format read raises doc-legacy", () => {
    const { openItems } = resolveFacts(raw([retirementDoc({ legacyFormat: true })]));
    expect(openItems.some((o) => o.id === `doc-legacy:${DOC_ID}`)).toBe(true);
  });

  it("another tax year is ignored: a document year of 2024, and a 2025 document whose form year is 2024", () => {
    expect(resolveFacts(raw([retirementDoc({ taxYear: 2024 })])).facts.income.retirementStatements).toEqual([]);
    expect(resolveFacts(raw([retirementDoc({}, { taxYear: 2024 })])).facts.income.retirementStatements).toEqual([]);
  });

  it("a document with no readable figure is not a fact", () => {
    expect(resolveFacts(raw([retirementDoc({ extractionData: { summary: "x", data: {} } })])).facts.income.retirementStatements).toEqual([]);
  });

  it("a statement not assigned to a person: an advisory item only (it cannot be compared or cited for a person); no conflict", () => {
    const { facts, conflicts, openItems } = resolveFacts(raw([retirementDoc({ subjectType: null, subjectUserId: null }, { iraContributionsCents: 100 })]));
    expect(facts.income.retirementStatements?.[0]?.personUserId).toBeNull();
    expect(conflicts.filter((c) => c.factKey.includes("traditionalIra"))).toEqual([]);
    const i = openItems.find((o) => o.id === `retirement-doc-no-person:${DOC_ID}`);
    expect(i?.severity).toBe("advisory");
    expect(i?.message).not.toMatch(/CPA/);
  });

  it("two statements for the same person are summed against the one owner answer", () => {
    const second = retirementDoc({ id: "b-5498" }, { iraContributionsCents: 100_000 });
    const { conflicts } = resolveFacts(raw([retirementDoc({}, { iraContributionsCents: 600_000 }), second]));
    expect(conflicts.find((x) => x.factKey === "returnAnswers.a.traditionalIra")).toBeUndefined(); // 600,000 + 100,000 = 700,000
  });
});
