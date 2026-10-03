import { describe, it, expect } from "vitest";
import { PERSONAL_FORM_PLAN } from "@/lib/tax-guidance";
import { resolveFieldFixes, type FixContext } from "@/lib/tax-form-fixes";
import type { FormsDocumentInput } from "@/lib/tax-forms";

const PERSONAL = "11111111-1111-1111-1111-111111111111";

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

  it("is honest that donations and depreciation have no data source in the app", () => {
    for (const line of ["Gifts to charity (line 11)", "Depreciation (line 13)", "Depreciation (line 18)"]) {
      const fixes = resolveFieldFixes(line, ctx());
      expect(fixes).toHaveLength(1);
      expect(fixes[0]?.kind).toBe("none");
    }
  });

  it("books and mileage lines link to the entity's pages", () => {
    expect(resolveFieldFixes("Gross receipts (line 1)", ctx())).toEqual([
      expect.objectContaining({ kind: "link", href: "/transactions?bucket=ek-consulting" }),
    ]);
    expect(resolveFieldFixes("Car and truck expenses (line 9)", ctx())).toEqual([
      expect.objectContaining({ kind: "link", href: "/business/ek-consulting/mileage" }),
    ]);
    expect(resolveFieldFixes("Taxes (line 16)", ctx({ svSlug: null }))[0]?.kind).toBe("none");
  });
});
