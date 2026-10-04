import { describe, expect, it } from "vitest";
import { inferPrimaryResidence, inferScheduleCOwner, planningFromRows } from "@/lib/tax2025/derive";
import type { RawDocument } from "@/lib/tax2025/resolve-facts";
import { parseDollarAnswerToCents, parseSqftAnswer } from "@/lib/tax-compute-build";

const parsers = { parseDollarAnswerToCents, parseSqftAnswer };

describe("inferScheduleCOwner", () => {
  const users = [
    { id: "u-eric", name: "Eric Kinniburgh" },
    { id: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" },
  ];
  it("matches the user whose name appears in the single-member LLC's name, as a derived value with a note", () => {
    const owner = inferScheduleCOwner("Eric Kinniburgh Consulting, LLC", users);
    expect(owner).toMatchObject({ userId: "u-eric", basis: "derived" });
    expect(owner?.note).toContain("Eric Kinniburgh");
  });
  it("falls back to a first-name match; a full-name match wins over a first-name match", () => {
    expect(inferScheduleCOwner("Eric Smith Consulting LLC", users)?.userId).toBe("u-eric");
    expect(
      inferScheduleCOwner("Eric Kinniburgh Consulting, LLC", [{ id: "a", name: "Eric Jones" }, { id: "b", name: "Eric Kinniburgh" }])?.userId
    ).toBe("b");
  });
  it("returns null when nobody matches or the match is ambiguous (never a guess)", () => {
    expect(inferScheduleCOwner("Sudden Valley Property Management LLC", users)).toBeNull();
    expect(inferScheduleCOwner("Eric Consulting LLC", [{ id: "a", name: "Eric Jones" }, { id: "b", name: "Eric Smith" }])).toBeNull();
    expect(inferScheduleCOwner("Eric Kinniburgh Consulting, LLC", [])).toBeNull();
  });
});

describe("inferPrimaryResidence", () => {
  const f1098 = (id: string, address: string | null, over: Partial<RawDocument> = {}): RawDocument => ({
    id,
    docType: "mortgage_interest",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: { data: { propertyAddress: address } },
    verified: true,
    legacyFormat: false,
    subjectType: null,
    subjectUserId: null,
    ...over,
  });
  it("uses the single address on the home mortgage 1098 and says it was derived", () => {
    const r = inferPrimaryResidence([f1098("a", "27 Old Barry Rd")], 2025);
    expect(r).toMatchObject({ address: "27 Old Barry Rd", basis: "derived" });
    expect(r?.note).toContain("Form 1098");
  });
  it("two 1098s for the same property still give one address; two different properties give null", () => {
    expect(inferPrimaryResidence([f1098("a", "27 Old Barry Rd"), f1098("b", "27 Old Barry Road")], 2025)?.address).toBe("27 Old Barry Rd");
    expect(inferPrimaryResidence([f1098("a", "27 Old Barry Rd"), f1098("b", "56 Arbor Rd")], 2025)).toBeNull();
  });
  it("ignores other years, other document types and blank addresses", () => {
    expect(inferPrimaryResidence([f1098("a", "27 Old Barry Rd", { taxYear: 2024 })], 2025)).toBeNull();
    expect(inferPrimaryResidence([f1098("a", null)], 2025)).toBeNull();
    expect(inferPrimaryResidence([f1098("a", "27 Old Barry Rd", { docType: "w2" })], 2025)).toBeNull();
    expect(inferPrimaryResidence([], 2025)).toBeNull();
  });
});

describe("planningFromRows", () => {
  const rows = [
    { key: "filing_status", answer: "mfj", skippedReason: null },
    { key: "household_members", answer: "none", skippedReason: null },
    { key: "ev_vehicle", answer: "no", skippedReason: null },
    { key: "business_mileage", answer: "no", skippedReason: null },
    { key: "home_office_ekc", answer: "yes_exclusive", skippedReason: null },
    { key: "home_office_sqft", answer: "180 sq ft", skippedReason: null },
    { key: "solar_credit", answer: "claimed_already", skippedReason: null },
    { key: "donations_none", answer: "some", skippedReason: null },
    { key: "fixed_assets_ekc", answer: "none", skippedReason: null },
    { key: "retirement_contribution_amount", answer: "$12,000", skippedReason: null },
    { key: "estimated_tax_payments_amount", answer: "Paid Q1-Q4 totaling $8,000", skippedReason: null },
  ];
  it("maps answered rows; 'none' is the only answer that confirms none; prose is never read as a dollar figure", () => {
    expect(planningFromRows(rows, parsers)).toEqual({
      filingStatus: "mfj",
      householdMembers: "none",
      evVehicle: "no",
      businessMileage: "no",
      homeOfficeEligibility: "yes_exclusive",
      homeOfficeSqft: 180,
      solarCredit: "claimed_already",
      donationsNone: false,
      fixedAssetsEkcNone: true,
      retirementContributionCents: 1_200_000,
      estimatedPaymentsCombinedCents: null,
    });
  });
  it("unanswered and skipped questions are null / false, never a default answer", () => {
    const p = planningFromRows(
      [
        { key: "filing_status", answer: "mfj", skippedReason: "Skipped for now" },
        { key: "retirement_contribution_amount", answer: "skipped", skippedReason: "Skipped for now" },
      ],
      parsers
    );
    expect(p.filingStatus).toBeNull();
    expect(p.householdMembers).toBeNull();
    expect(p.businessMileage).toBeNull();
    expect(p.retirementContributionCents).toBeNull();
    expect(p.donationsNone).toBe(false);
    expect(p.homeOfficeSqft).toBeNull();
  });
});
