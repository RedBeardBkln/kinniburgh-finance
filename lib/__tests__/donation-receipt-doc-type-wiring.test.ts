import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TAX_DOC_TYPES, isTaxDocType, suggestIssuerFromExtraction } from "@/lib/document-attribution";
import { EXTRACTABLE_DOC_TYPES, isExtractableDocType } from "@/lib/document-extraction-state";
import { EXPANDED_RAW_DOC_TYPES, schemaTypeForDocType } from "@/lib/tax-extraction-schema";
import { classifyDocType } from "@/lib/doc-extract";
import { deriveDocumentTaxYear, deriveEffectiveDocumentTaxYear } from "@/lib/document-year";
import { documentTypeLabel, generateDocumentName } from "@/lib/doc-naming";
import { docTypeLabel } from "@/lib/tax-forms";
import { RETYPE_TARGETS } from "@/lib/document-retype";

// "Every place that enumerates doc types knows the new one."

const read = (f: string) => readFileSync(resolve(__dirname, "../../", f), "utf8");

describe("every tax doc type is enumerated consistently", () => {
  it.each([...TAX_DOC_TYPES])("%s has a name label and a Forms label, and is a tax doc type", (t) => {
    expect(isTaxDocType(t)).toBe(true);
    // "1099" is its own label; every other type's label must differ from the raw key (the unknown-type fallback).
    expect(documentTypeLabel(t).length).toBeGreaterThan(0);
    expect(docTypeLabel(t).length).toBeGreaterThan(0);
    if (t !== "1099") {
      expect(documentTypeLabel(t)).not.toBe(t);
      expect(docTypeLabel(t)).not.toBe(t);
    }
  });
});

describe("donation_receipt is known to the shared helpers", () => {
  it("is a tax doc type and extractable", () => {
    expect(TAX_DOC_TYPES).toContain("donation_receipt");
    expect(isTaxDocType("donation_receipt")).toBe(true);
    expect(EXTRACTABLE_DOC_TYPES).toContain("donation_receipt");
    expect(isExtractableDocType("donation_receipt")).toBe(true);
  });

  it("has a schema, an expanded (versioned) raw type and a classification", () => {
    expect(schemaTypeForDocType("donation_receipt")).toBe("donation_receipt");
    expect(EXPANDED_RAW_DOC_TYPES).toContain("donation_receipt");
    expect(classifyDocType("donation_receipt")).toBe("donation_receipt");
    // A file name alone never classifies as a donation receipt.
    expect(classifyDocType("other", "donation-receipt.pdf")).toBe("other");
  });

  it("is a retype target", () => {
    expect(RETYPE_TARGETS).toContain("donation_receipt");
  });

  it("labels: 'Donation Receipt' (name) and 'Donation receipt' (Forms)", () => {
    expect(documentTypeLabel("donation_receipt")).toBe("Donation Receipt");
    expect(docTypeLabel("donation_receipt")).toBe("Donation receipt");
  });

  it("suggests the charity as the issuer", () => {
    expect(
      suggestIssuerFromExtraction("donation_receipt", { summary: "x", data: { organizationName: " Food Bank " } })
    ).toBe("Food Bank");
    expect(suggestIssuerFromExtraction("donation_receipt", { summary: "x", data: { organizationName: null } })).toBeNull();
  });
});

describe("year from extraction (the gift date)", () => {
  const ext = (data: Record<string, unknown>) => ({ docType: "donation_receipt", summary: "", data });

  it("is the calendar year of the gift date", () => {
    expect(deriveDocumentTaxYear("donation_receipt", ext({ giftDate: "2025-12-31" }), 2026)).toBe(2025);
    expect(deriveDocumentTaxYear("donation_receipt", ext({ giftDate: "2026-01-01" }), 2026)).toBe(2026);
  });

  it("is null for a multi-gift letter, a missing/invalid/implausible date, or junk", () => {
    expect(deriveDocumentTaxYear("donation_receipt", ext({ giftDate: "2025-06-15", coversMultipleGifts: true }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear("donation_receipt", ext({ giftDate: null }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear("donation_receipt", ext({ giftDate: "2025-02-30" }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear("donation_receipt", ext({ giftDate: "June 2025" }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear("donation_receipt", ext({ giftDate: "1980-01-01" }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear("donation_receipt", ext({ giftDate: "2031-01-01" }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear("donation_receipt", null, 2026)).toBeNull();
    expect(deriveDocumentTaxYear("donation_receipt", { data: "x" }, 2026)).toBeNull();
  });

  it("uses the owner's corrected gift date (a corrected null clears it)", () => {
    const base = {
      docType: "donation_receipt",
      extractionData: ext({ giftDate: "2025-06-15" }),
      extractionConfirmedAt: null,
    };
    const corr = (v: unknown) => ({ version: 1, fields: { giftDate: { value: v, aiValue: "2025-06-15" } }, events: [] });
    expect(deriveEffectiveDocumentTaxYear({ ...base, extractionCorrections: corr("2024-12-30") }, 2026)).toBe(2024);
    expect(deriveEffectiveDocumentTaxYear({ ...base, extractionCorrections: corr(null) }, 2026)).toBeNull();
  });
});

describe("document name", () => {
  it("is 'Donation Receipt — Charity (year of the gift)'", () => {
    expect(
      generateDocumentName("donation_receipt", null, {
        docType: "donation_receipt",
        data: { organizationName: "Food Bank", giftDate: "2025-06-15" },
      })
    ).toBe("Donation Receipt — Food Bank (2025)");
  });

  it("prefers the year the document is filed under, falls back to the label", () => {
    expect(
      generateDocumentName("donation_receipt", 2024, {
        docType: "donation_receipt",
        data: { organizationName: "Food Bank", giftDate: "2025-06-15" },
      })
    ).toBe("Donation Receipt — Food Bank (2024)");
    expect(generateDocumentName("donation_receipt", null, null)).toBe("Donation Receipt");
    expect(generateDocumentName("donation_receipt", 2025, null)).toBe("Donation Receipt (2025)");
    expect(
      generateDocumentName("donation_receipt", null, { docType: "donation_receipt", data: { giftDate: "garbage" } })
    ).toBe("Donation Receipt");
  });
});

describe("source-level enumeration sites", () => {
  it("actions/documents.ts DOC_TYPES (vault upload enum)", () => {
    const src = read("actions/documents.ts");
    expect(src.slice(src.indexOf("const DOC_TYPES"), src.indexOf("] as const", src.indexOf("const DOC_TYPES")))).toContain(
      '"donation_receipt"'
    );
  });

  it("actions/tax-planning.ts: the type enum AND the inline extractable check", () => {
    const src = read("actions/tax-planning.ts");
    const enumStart = src.indexOf("const TAX_DOC_TYPES");
    expect(src.slice(enumStart, src.indexOf("] as const", enumStart))).toContain('"donation_receipt"');
    const ext = src.indexOf("const extractable");
    expect(src.slice(ext, src.indexOf(";", ext))).toContain('docType === "donation_receipt"');
  });

  it("components/tax/tax-document-upload.tsx: option (with the right label), TaxDocType union, no duplicated literal cast", () => {
    const src = read("components/tax/tax-document-upload.tsx");
    expect(src).toContain('{ value: "donation_receipt", label: "Donation receipt / acknowledgment" }');
    const union = src.indexOf("export type TaxDocType");
    expect(src.slice(union, src.indexOf(";", union))).toContain('"donation_receipt"');
    expect(src).not.toMatch(/docType as "w2" \|/);
  });

  it("components/documents/document-upload-form.tsx: option", () => {
    expect(read("components/documents/document-upload-form.tsx")).toContain('value: "donation_receipt"');
  });

  it("app/documents/page.tsx: label and colour maps, and the Change-type cell is wired", () => {
    const src = read("app/documents/page.tsx");
    expect(src).toContain('donation_receipt: "Donation Receipt"');
    expect(src).toMatch(/donation_receipt: "bg-rose-50/);
    expect(src).toContain("<DocumentTypeCell");
  });

  it("lib/doc-extract.ts: DocType, PROMPTS and the classify map", () => {
    const src = read("lib/doc-extract.ts");
    expect(src).toContain('| "donation_receipt"');
    expect(src).toContain('donation_receipt: buildTaxExtractionPrompt("donation_receipt")');
    expect(src).toContain('donation_receipt: "donation_receipt"');
  });

  it("prisma/schema.prisma only documents the new value in the docType comment (no structural change)", () => {
    const src = read("prisma/schema.prisma");
    expect(src).toMatch(/docType\s+String\s+\/\/[^\n]*donation_receipt/);
  });
});
