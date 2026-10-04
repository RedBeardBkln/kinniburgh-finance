import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Everything external is mocked (repo convention: no DB, no storage, no Anthropic).
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: (props: { href: string; children?: React.ReactNode }) => createElement("a", { href: props.href }, props.children),
}));

const mockDb = vi.hoisted(() => ({
  document: { findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/supabase-storage", () => ({
  getDocumentFileSignedUrl: vi.fn(),
  downloadDocumentFile: vi.fn(),
  getSignedUploadUrl: vi.fn(),
}));
vi.mock("@/lib/statement-ledger", () => ({ loadLedgerIndexes: vi.fn() }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));

import { TAX_DOC_TYPES, isTaxDocType, suggestIssuerFromExtraction } from "@/lib/document-attribution";
import { EXTRACTABLE_DOC_TYPES, isExtractableDocType, describeDocumentRow } from "@/lib/document-extraction-state";
import { EXPANDED_RAW_DOC_TYPES, schemaTypeForDocType } from "@/lib/tax-extraction-schema";
import { classifyDocType } from "@/lib/doc-extract";
import { deriveDocumentTaxYear, deriveEffectiveDocumentTaxYear, planYearFill } from "@/lib/document-year";
import { documentTypeLabel, generateDocumentName } from "@/lib/doc-naming";
import { docTypeLabel } from "@/lib/tax-forms";
import { RETYPE_TARGET_OPTIONS, RETYPE_TARGETS, VERIFIED_RETYPE_ERROR, isPlaceholderName, retypeBlockReason, retypeTargetLabel } from "@/lib/document-retype";
import { RETIREMENT_PICKER_LABEL } from "@/lib/retirement-statement";
import { changeDocumentType } from "@/actions/documents";
import { TaxReviewClient } from "@/components/documents/tax-review-client";

(globalThis as { React?: typeof React }).React = React;

const read = (f: string) => readFileSync(resolve(__dirname, "../../", f), "utf8");
const T = "retirement_contribution";

describe("every tax doc type is enumerated consistently (sweep incl. the new type)", () => {
  it.each([...TAX_DOC_TYPES])("%s has a name label, a Forms label, and is a tax doc type", (t) => {
    expect(isTaxDocType(t)).toBe(true);
    expect(documentTypeLabel(t).length).toBeGreaterThan(0);
    expect(docTypeLabel(t).length).toBeGreaterThan(0);
    if (t !== "1099") {
      expect(documentTypeLabel(t)).not.toBe(t);
      expect(docTypeLabel(t)).not.toBe(t);
    }
  });
});

describe("retirement_contribution is known to the shared helpers", () => {
  it("is a tax doc type, extractable, has a schema, is an expanded type, and classifies to itself", () => {
    expect(TAX_DOC_TYPES).toContain(T);
    expect(isTaxDocType(T)).toBe(true);
    expect(EXTRACTABLE_DOC_TYPES).toContain(T);
    expect(isExtractableDocType(T)).toBe(true);
    expect(schemaTypeForDocType(T)).toBe(T);
    expect(EXPANDED_RAW_DOC_TYPES).toContain(T);
    expect(classifyDocType(T)).toBe(T);
    // a file name alone never guesses it (the owner picks the type)
    expect(classifyDocType("other", "betterment-5498-2025.pdf")).toBe("other");
  });

  it("is a retype target (so an 'Other' document can be re-typed to it) with the owner-facing label", () => {
    expect(RETYPE_TARGETS).toContain(T);
    expect(retypeTargetLabel(T)).toBe("Retirement contributions (IRA / 401(k) statement or Form 5498)");
    expect(RETYPE_TARGET_OPTIONS.find((o) => o.value === T)?.label).toBe(RETIREMENT_PICKER_LABEL);
  });

  it("labels: name label and Forms label", () => {
    expect(documentTypeLabel(T)).toBe("Retirement Contributions");
    expect(docTypeLabel(T)).toBe("Retirement contributions");
  });

  it("the trustee is the suggested issuer", () => {
    expect(suggestIssuerFromExtraction(T, { summary: "x", data: { issuerName: " Betterment " } })).toBe("Betterment");
    expect(suggestIssuerFromExtraction(T, { summary: "x", data: { issuerName: null } })).toBeNull();
  });
});

describe("document year comes from the extraction (the year the contributions are FOR)", () => {
  const ext = (data: Record<string, unknown>) => ({ docType: T, summary: "", data });

  it("is the integer taxYear", () => {
    expect(deriveDocumentTaxYear(T, ext({ taxYear: 2025 }), 2026)).toBe(2025);
    expect(deriveDocumentTaxYear(T, ext({ taxYear: 2025, postponedForYear: 2024 }), 2026)).toBe(2025);
  });

  it("never guesses: missing, string, float, implausible and malformed all derive null", () => {
    expect(deriveDocumentTaxYear(T, ext({ taxYear: null }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear(T, ext({ taxYear: "2025" }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear(T, ext({ taxYear: 2025.5 }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear(T, ext({ taxYear: 1980 }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear(T, ext({ taxYear: 2031 }), 2026)).toBeNull();
    expect(deriveDocumentTaxYear(T, null, 2026)).toBeNull();
    expect(deriveDocumentTaxYear(T, { data: "x" }, 2026)).toBeNull();
  });

  it("uses the owner's corrected year (a corrected null clears it)", () => {
    const base = { docType: T, extractionData: ext({ taxYear: 2024 }), extractionConfirmedAt: null };
    const corr = (v: unknown) => ({ version: 1, fields: { taxYear: { value: v, aiValue: 2024 } }, events: [] });
    expect(deriveEffectiveDocumentTaxYear({ ...base, extractionCorrections: corr(2025) }, 2026)).toBe(2025);
    expect(deriveEffectiveDocumentTaxYear({ ...base, extractionCorrections: corr(null) }, 2026)).toBeNull();
  });

  it("feeds the 'fill in missing years' plan like the other annual forms", () => {
    const plan = planYearFill([{ id: "a", docType: T, extractionData: ext({ taxYear: 2025 }), extractionCorrections: null, extractionConfirmedAt: null }]);
    expect(plan.fills).toEqual([{ id: "a", year: 2025 }]);
  });
});

describe("document name", () => {
  it("is 'Retirement Contributions — Trustee (year the contributions are for)'", () => {
    expect(generateDocumentName(T, null, { docType: "other", data: { issuerName: "Betterment", taxYear: 2025 } })).toBe(
      "Retirement Contributions — Betterment (2025)"
    );
  });
  it("falls back to the filed-under year, then to the bare label", () => {
    expect(generateDocumentName(T, 2025, { docType: "other", data: { issuerName: "Betterment" } })).toBe("Retirement Contributions — Betterment (2025)");
    expect(generateDocumentName(T, 2025, null)).toBe("Retirement Contributions (2025)");
    expect(generateDocumentName(T, null, null)).toBe("Retirement Contributions");
  });
  it("the label is a placeholder name, so a retype from 'Other' may refresh it but a typed name is kept", () => {
    expect(isPlaceholderName("Retirement Contributions", T, null)).toBe(true);
    expect(isPlaceholderName("Retirement Contributions (2025)", T, 2025)).toBe(true);
    expect(isPlaceholderName("Betterment Roth IRA 5498", T, 2025)).toBe(false);
  });
});

describe("re-typing an existing 'Other' document to Retirement contributions", () => {
  it("is allowed for an unverified Other document, and refused (un-verify first) for a verified one", () => {
    expect(retypeBlockReason({ currentDocType: "other", nextDocType: T, verified: false })).toBeNull();
    expect(retypeBlockReason({ currentDocType: "other", nextDocType: T, verified: true })).toBe(VERIFIED_RETYPE_ERROR);
    expect(retypeBlockReason({ currentDocType: T, nextDocType: "other", verified: true })).toBe(VERIFIED_RETYPE_ERROR);
    expect(retypeBlockReason({ currentDocType: T, nextDocType: T, verified: true })).toBeNull();
  });
});

describe("changeDocumentType to retirement_contribution (mocked db)", () => {
  const USER = "11111111-1111-4111-8111-111111111111";
  const DOC = "c0000000-0000-4000-8000-000000000001";
  const row = (over: Record<string, unknown> = {}) => ({
    docType: "other",
    extractionConfirmedAt: null,
    documentName: "Document",
    taxYear: null,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: USER } });
    mockDb.document.findFirst.mockResolvedValue(row());
    mockDb.document.updateMany.mockResolvedValue({ count: 1 });
  });

  it("re-types an Other document, refreshes its placeholder name, and asks the client to read it", async () => {
    const r = await changeDocumentType({ documentId: DOC, docType: T });
    expect(r).toEqual({ ok: true, changed: true, extract: true });
    expect(mockDb.document.updateMany).toHaveBeenCalledWith({
      where: { id: DOC, archivedAt: null, docType: "other", extractionConfirmedAt: null },
      data: { docType: T, documentName: "Retirement Contributions" },
    });
  });

  it("keeps a name the owner typed", async () => {
    mockDb.document.findFirst.mockResolvedValue(row({ documentName: "Betterment 5498 (from Eric)" }));
    await changeDocumentType({ documentId: DOC, docType: T });
    expect(mockDb.document.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { docType: T } }));
  });

  it("refuses a verified document (un-verify first) and writes nothing", async () => {
    mockDb.document.findFirst.mockResolvedValue(row({ extractionConfirmedAt: new Date() }));
    expect(await changeDocumentType({ documentId: DOC, docType: T })).toEqual({ ok: false, error: VERIFIED_RETYPE_ERROR });
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("source: the action's allowed types come from the retype list that includes the new type", () => {
    const src = read("actions/documents.ts");
    expect(src).toContain("RETYPE_TARGETS.includes(value)");
    expect(src).toContain("extract: isExtractableDocType(nextDocType)");
  });
});

// ── source-level enumeration sites ────────────────────────────────────────────

describe("source-level enumeration sites", () => {
  it("actions/documents.ts DOC_TYPES (vault upload enum)", () => {
    const src = read("actions/documents.ts");
    const start = src.indexOf("const DOC_TYPES");
    expect(src.slice(start, src.indexOf("] as const", start))).toContain('"retirement_contribution"');
  });

  it("actions/tax-planning.ts: the type enum AND the inline extractable check", () => {
    const src = read("actions/tax-planning.ts");
    const enumStart = src.indexOf("const TAX_DOC_TYPES");
    expect(src.slice(enumStart, src.indexOf("] as const", enumStart))).toContain('"retirement_contribution"');
    const ext = src.indexOf("const extractable");
    expect(src.slice(ext, src.indexOf(";", ext))).toContain('docType === "retirement_contribution"');
  });

  it("components/tax/tax-document-upload.tsx: picker option with the exact label, TaxDocType union", () => {
    const src = read("components/tax/tax-document-upload.tsx");
    expect(src).toContain('{ value: "retirement_contribution", label: RETIREMENT_PICKER_LABEL }');
    const union = src.indexOf("export type TaxDocType");
    expect(src.slice(union, src.indexOf(";", union))).toContain('"retirement_contribution"');
  });

  it("components/documents/document-upload-form.tsx: picker option", () => {
    const src = read("components/documents/document-upload-form.tsx");
    expect(src).toContain('value: "retirement_contribution"');
    expect(src).toContain("RETIREMENT_PICKER_LABEL");
  });

  it("app/documents/page.tsx: badge label, colour, and a filter chip", () => {
    const src = read("app/documents/page.tsx");
    expect(src).toContain("retirement_contribution: RETIREMENT_BADGE_LABEL");
    expect(src).toMatch(/retirement_contribution: "bg-emerald-50/);
    expect(src).toContain('chipHref({ docType: "retirement_contribution" })');
  });

  it("lib/doc-extract.ts: DocType, PROMPTS and the classify map", () => {
    const src = read("lib/doc-extract.ts");
    expect(src).toContain('| "retirement_contribution"');
    expect(src).toContain('retirement_contribution: buildTaxExtractionPrompt("retirement_contribution")');
    expect(src).toContain('retirement_contribution: "retirement_contribution"');
  });

  it("the picker label is the specified wording everywhere it is used", () => {
    expect(RETIREMENT_PICKER_LABEL).toBe("Retirement contributions (IRA / 401(k) statement or Form 5498)");
  });
});

describe("the Documents list row for a retirement statement", () => {
  it("reads as extracted-unverified once the AI has read it, with a Review action", () => {
    const display = describeDocumentRow({
      docType: T,
      extractionStatus: "complete",
      updatedAt: new Date("2026-10-04T12:00:00Z"),
      extractionData: { docType: T, schemaVersion: 2, summary: "x", data: { iraContributionsCents: 700000, issuerName: "Betterment" } },
      extractionConfirmedAt: null,
      extractionCorrections: null,
      extractionError: null,
    });
    expect(display.kind).toBe("extracted_unverified");
    expect(display.actions).toContain("review");
  });

  it("is verified only when the owner confirmed it", () => {
    const display = describeDocumentRow({
      docType: T,
      extractionStatus: "complete",
      updatedAt: new Date("2026-10-04T12:00:00Z"),
      extractionData: { docType: T, schemaVersion: 2, summary: "x", data: { iraContributionsCents: 700000 } },
      extractionConfirmedAt: new Date("2026-10-04T13:00:00Z"),
      extractionCorrections: null,
      extractionError: null,
    });
    expect(display.kind).toBe("verified");
  });

  it("a reading with no usable value is not shown as extracted (the AI read nothing)", () => {
    const display = describeDocumentRow({
      docType: T,
      extractionStatus: "complete",
      updatedAt: new Date("2026-10-04T12:00:00Z"),
      extractionData: { docType: T, schemaVersion: 2, summary: "x", data: { taxYear: 2025 } },
      extractionConfirmedAt: null,
      extractionCorrections: null,
      extractionError: null,
    });
    expect(display.kind).not.toBe("extracted_unverified");
    expect(display.kind).not.toBe("verified");
  });
});

// ── review screen render smoke ────────────────────────────────────────────────

describe("review screen for a retirement statement (render smoke)", () => {
  const render = (aiData: Record<string, unknown>, corrections: Record<string, { value: unknown; aiValue: unknown }> = {}) =>
    renderToStaticMarkup(
      createElement(TaxReviewClient, {
        documentId: "c0000000-0000-4000-8000-000000000001",
        docTypeLabel: "Retirement Contributions",
        schemaType: "retirement_contribution",
        documentTaxYear: 2025,
        extractedAtIso: "2026-10-04T12:00:00.000Z",
        summary: "Betterment Form 5498 for 2025",
        warnings: [],
        aiData,
        corrections,
        display: { kind: "extracted_unverified", label: "Read by AI, not yet verified", tone: "amber", actions: ["review"], outdated: false, correctionCount: 0 },
        verifiedBy: null,
        fileUrl: null,
        isImage: false,
        backHref: "/documents" as never,
        backLabel: "Back to documents",
      })
    );

  const AI = {
    taxYear: 2025,
    formVariant: "form_5498",
    issuerName: "Betterment",
    accountKind: "roth_ira",
    iraContributionsCents: null,
    rothIraContributionsCents: 700000,
    fairMarketValueCents: 5123456,
  };

  it("shows plain-language field labels, the box numbers and the AI-read (unverified) state", () => {
    const html = render(AI);
    expect(html).toContain("Year the contributions are for");
    expect(html).toContain("Trustee / issuer");
    expect(html).toContain("Kind of account");
    expect(html).toContain("Roth IRA contributions");
    expect(html).toContain("Traditional IRA contributions");
    expect(html).toContain("Rollovers into the IRA");
    expect(html).toContain("Account value at year end");
    expect(html).toContain("Retirement Contributions: Read by AI, not yet verified");
    expect(html).toContain("Betterment");
  });

  it("choices read in plain words, never the stored keys", () => {
    const html = render(AI);
    expect(html).toContain(">Roth IRA<");
    expect(html).toContain(">Traditional IRA<");
    expect(html).toContain(">401(k) or other employer plan statement<");
    expect(html).toContain(">IRS Form 5498 (IRA Contribution Information)<");
    expect(html).not.toContain(">traditional_ira<");
    expect(html).not.toContain(">employer_plan<");
    expect(html).not.toContain(">form_5498<");
  });

  it("starts from the effective value: the owner's corrected figure shows, and the dollars are formatted", () => {
    const html = render(AI, { rothIraContributionsCents: { value: 650000, aiValue: 700000 } });
    expect(html).toContain('value="6500.00"');
  });

  it("has no input for an account number, name, address or taxpayer id", () => {
    const html = render(AI).toLowerCase();
    expect(html).not.toContain("account number");
    expect(html).not.toContain("social security");
    expect(html).not.toMatch(/aria-label="[^"]*(address|participant|ssn)/);
  });
});

// ── no schema migration ───────────────────────────────────────────────────────

describe("no database change", () => {
  it("docType stays a free string column: the schema file does not know the new type at all", () => {
    const src = read("prisma/schema.prisma");
    expect(src).not.toContain("retirement_contribution");
    expect(src).toMatch(/docType\s+String\b/);
  });
});
