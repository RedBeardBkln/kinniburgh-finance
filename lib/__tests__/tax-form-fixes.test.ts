import { describe, it, expect } from "vitest";
import { PERSONAL_FORM_PLAN } from "@/lib/tax-guidance";
import { resolveFieldFixes, type FixContext } from "@/lib/tax-form-fixes";
import type { FormsDocumentInput } from "@/lib/tax-forms";

const PERSONAL = "11111111-1111-1111-1111-111111111111";
const EKC = "22222222-2222-2222-2222-222222222222";
const SV = "33333333-3333-3333-3333-333333333333";

function doc(overrides: Partial<FormsDocumentInput> = {}): FormsDocumentInput {
  return {
    id: "d1",
    docType: "property_tax",
    documentName: "Property tax bill 2025",
    entityId: PERSONAL,
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: null,
    archivedAt: null,
    subjectType: null,
    subjectUser: null,
    issuerName: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<FixContext> = {}): FixContext {
  return {
    taxYear: 2025,
    personalEntityId: PERSONAL,
    ekcSlug: "ek-consulting",
    svSlug: "sudden-valley",
    ekcEntityId: EKC,
    svEntityId: SV,
    questions: [],
    documents: [],
    lineHasData: {},
    ...overrides,
  };
}

describe("resolveFieldFixes", () => {
  it("handles every Personal form-plan line (a renamed line must not silently lose its fix)", () => {
    for (const form of PERSONAL_FORM_PLAN) {
      for (const field of form.fields) {
        // Everything missing: the worst case, where every dependent fix applies.
        const lineHasData = Object.fromEntries(
          PERSONAL_FORM_PLAN.flatMap((f) => f.fields.map((x) => [x.line, false]))
        );
        expect(resolveFieldFixes(field.line, ctx({ lineHasData })), field.line).not.toHaveLength(0);
      }
    }
  });

  it("returns nothing for a line it does not know", () => {
    expect(resolveFieldFixes("Not a real line", ctx())).toEqual([]);
  });

  it("offers only the still-unanswered credit questions", () => {
    const fixes = resolveFieldFixes(
      "Credits (lines 19-21)",
      ctx({
        questions: [
          { key: "solar_credit", answer: "claimed_already", skippedReason: null },
          { key: "ev_vehicle", answer: "no", skippedReason: null },
          { key: "household_members", answer: null, skippedReason: null },
          { key: "retirement_contributions", answer: "x", skippedReason: "Skipped for now" },
        ],
      })
    );
    expect(fixes).toEqual([
      { kind: "question", questionKey: "household_members" },
      { kind: "question", questionKey: "retirement_contributions" },
    ]);
  });

  it("lists only matching, non-archived, same-year Personal documents as 'existing'", () => {
    const fixes = resolveFieldFixes(
      "State/local taxes (line 5e)",
      ctx({
        documents: [
          doc({ id: "keep" }),
          doc({ id: "other-year", taxYear: 2024 }),
          doc({ id: "other-type", docType: "w2" }),
          doc({ id: "other-entity", entityId: "22222222-2222-2222-2222-222222222222" }),
          doc({ id: "archived", archivedAt: new Date("2026-01-01") }),
        ],
      })
    );
    expect(fixes).toHaveLength(1);
    const fix = fixes[0];
    if (!fix || fix.kind !== "document") throw new Error("expected a document fix");
    expect(fix.docType).toBe("property_tax");
    expect(fix.existing.map((d) => d.id)).toEqual(["keep"]);
    expect(fix.entityId).toBe(PERSONAL);
    expect(fix.documentsHref).toContain("docType=property_tax");
    expect(fix.documentsHref).toContain("year=2025");
  });

  it("tells you to upload first when no property tax bill is on file", () => {
    const fix = resolveFieldFixes("State/local taxes (line 5e)", ctx())[0];
    if (!fix || fix.kind !== "document") throw new Error("expected a document fix");
    expect(fix.hint).toMatch(/^Upload the property tax bill, then open/);
    const withBill = resolveFieldFixes("State/local taxes (line 5e)", ctx({ documents: [doc()] }))[0];
    if (!withBill || withBill.kind !== "document") throw new Error("expected a document fix");
    expect(withBill.hint).toMatch(/^Open the bill's review screen/);
  });

  it("only asks for the half of line 12 that is actually missing", () => {
    const onlyTaxMissing = resolveFieldFixes(
      "Standard or itemized (line 12)",
      ctx({ lineHasData: { "Home mortgage interest (line 8a)": true, "State/local taxes (line 5e)": false } })
    );
    expect(onlyTaxMissing.map((f) => (f.kind === "document" ? f.docType : f.kind))).toEqual(["property_tax"]);

    const both = resolveFieldFixes(
      "Standard or itemized (line 12)",
      ctx({ lineHasData: { "Home mortgage interest (line 8a)": false, "State/local taxes (line 5e)": false } })
    );
    expect(both.map((f) => (f.kind === "document" ? f.docType : f.kind))).toEqual(["mortgage_interest", "property_tax"]);
  });

  it("CT AGI: asks for filing status when unanswered, and for a W-2 only when there is no income at all", () => {
    const noIncome = resolveFieldFixes("CT adjusted gross income", ctx({ lineHasData: {} }));
    expect(noIncome.map((f) => f.kind)).toEqual(["question", "document"]);

    const hasWages = resolveFieldFixes(
      "CT adjusted gross income",
      ctx({ lineHasData: { "Wages (line 1a)": true }, questions: [{ key: "filing_status", answer: "mfj", skippedReason: null }] })
    );
    expect(hasWages).toEqual([]);
  });

  it("donations: quick-add + confirm-none + a link to the full log (never the old 'no data source' text)", () => {
    const fixes = resolveFieldFixes("Gifts to charity (line 11)", ctx());
    expect(fixes.map((f) => f.kind)).toEqual(["donation", "confirm_none", "link"]);
    expect(fixes[0]).toEqual({ kind: "donation", taxYear: 2025, logHref: "/tax/donations/2025" });
    expect(fixes[1]).toEqual(
      expect.objectContaining({ kind: "confirm_none", questionKey: "donations_none", taxYear: 2025 })
    );
    expect(fixes[2]).toEqual(expect.objectContaining({ kind: "link", href: "/tax/donations/2025" }));
    expect(JSON.stringify(fixes)).not.toMatch(/no donation log|no data source/i);
  });

  it("EK Consulting depreciation: quick-add for EKC (not real property) + confirm-none + link", () => {
    const fixes = resolveFieldFixes("Depreciation (line 13)", ctx({ taxYear: 2026 }));
    expect(fixes.map((f) => f.kind)).toEqual(["fixed_asset", "confirm_none", "link"]);
    expect(fixes[0]).toEqual(
      expect.objectContaining({
        kind: "fixed_asset",
        entityId: EKC,
        entityLabel: "EK Consulting",
        taxYear: 2026,
        realProperty: false,
        listHref: "/tax/fixed-assets/2026",
      })
    );
    expect(fixes[1]).toEqual(expect.objectContaining({ kind: "confirm_none", questionKey: "fixed_assets_ekc" }));
    expect(fixes[2]).toEqual(expect.objectContaining({ kind: "link", href: "/tax/fixed-assets/2026" }));
  });

  it("Sudden Valley depreciation: quick-add pre-set to real property with the land hint + confirm-none + link", () => {
    const fixes = resolveFieldFixes("Depreciation (line 18)", ctx());
    expect(fixes.map((f) => f.kind)).toEqual(["fixed_asset", "confirm_none", "link"]);
    const add = fixes[0];
    if (!add || add.kind !== "fixed_asset") throw new Error("expected a fixed_asset fix");
    expect(add.entityId).toBe(SV);
    expect(add.entityLabel).toBe("Sudden Valley");
    expect(add.realProperty).toBe(true);
    expect(add.hint).toMatch(/56 Arbor Rd/);
    expect(add.hint).toMatch(/land value/i);
    expect(fixes[1]).toEqual(expect.objectContaining({ kind: "confirm_none", questionKey: "fixed_assets_sv" }));
  });

  it("falls back to an honest 'not found' only when the entity id is missing", () => {
    expect(resolveFieldFixes("Gifts to charity (line 11)", ctx({ personalEntityId: null }))).toEqual([
      { kind: "none", reason: "The Personal entity was not found." },
    ]);
    expect(resolveFieldFixes("Depreciation (line 13)", ctx({ ekcEntityId: null }))).toEqual([
      { kind: "none", reason: "EK Consulting was not found." },
    ]);
    expect(resolveFieldFixes("Depreciation (line 18)", ctx({ svEntityId: null }))).toEqual([
      { kind: "none", reason: "Sudden Valley was not found." },
    ]);
  });

  it("omits the confirm-none chip when 'none' is already confirmed (guard when called directly)", () => {
    const done = (key: string) => ({ key, answer: "none", skippedReason: null });
    expect(
      resolveFieldFixes("Gifts to charity (line 11)", ctx({ questions: [done("donations_none")] })).map((f) => f.kind)
    ).toEqual(["donation", "link"]);
    expect(
      resolveFieldFixes("Depreciation (line 13)", ctx({ questions: [done("fixed_assets_ekc")] })).map((f) => f.kind)
    ).toEqual(["fixed_asset", "link"]);
    // "some" is not a confirmation: the chip stays.
    expect(
      resolveFieldFixes("Depreciation (line 18)", ctx({ questions: [{ key: "fixed_assets_sv", answer: "some", skippedReason: null }] })).map(
        (f) => f.kind
      )
    ).toEqual(["fixed_asset", "confirm_none", "link"]);
  });

  it("books and mileage lines link to the entity's pages", () => {
    expect(resolveFieldFixes("Gross receipts (line 1)", ctx())).toEqual([
      expect.objectContaining({ kind: "link", href: "/transactions?bucket=ek-consulting" }),
    ]);
    expect(resolveFieldFixes("Car and truck expenses (line 9)", ctx())).toEqual([
      { kind: "question", questionKey: "business_mileage" },
      expect.objectContaining({ kind: "link", href: "/business/ek-consulting/mileage" }),
    ]);
    // Once "no business driving" is answered, only the log link remains.
    expect(
      resolveFieldFixes(
        "Car and truck expenses (line 9)",
        ctx({ questions: [{ key: "business_mileage", answer: "no", skippedReason: null }] })
      )
    ).toEqual([expect.objectContaining({ kind: "link", href: "/business/ek-consulting/mileage" })]);
    expect(resolveFieldFixes("Taxes (line 16)", ctx({ svSlug: null }))[0]?.kind).toBe("none");
  });
});
