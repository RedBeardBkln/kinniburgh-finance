import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Everything external is mocked (repo convention: no DB, no storage, no Anthropic).
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const mockDb = vi.hoisted(() => ({
  document: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/supabase-storage", () => ({
  getDocumentFileSignedUrl: vi.fn(),
  downloadDocumentFile: vi.fn(),
  getSignedUploadUrl: vi.fn(),
}));
vi.mock("@/lib/doc-extract", () => ({ extractDocumentOrThrow: vi.fn(), classifyDocType: vi.fn(() => "property_tax") }));
vi.mock("@/lib/statement-ledger", () => ({ loadLedgerIndexes: vi.fn() }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { renameDocument } from "@/actions/documents";
import { saveDocumentCorrections, confirmDocumentExtraction } from "@/actions/document-verification";
import { DOCUMENT_NAME_MAX, refreshAutoNameForYear, validateDocumentName } from "@/lib/document-rename";
import { generateDocumentName } from "@/lib/doc-naming";
import { DocumentNameCell, DocumentNameForm } from "@/components/documents/document-name-cell";

(globalThis as { React?: typeof React }).React = React;

const read = (f: string) => readFileSync(resolve(__dirname, "../../", f), "utf8");

const USER = "11111111-1111-4111-8111-111111111111";
const DOC = "c0000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.document.findFirst.mockResolvedValue({ id: DOC, documentName: "Property Tax Bill (2024)" });
  mockDb.document.updateMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockResolvedValue({});
});

// ── validateDocumentName ──────────────────────────────────────────────────────

describe("validateDocumentName", () => {
  it("trims and accepts 1-200 characters", () => {
    expect(validateDocumentName("  Property tax bill 2025  ")).toEqual({ ok: true, name: "Property tax bill 2025" });
    expect(validateDocumentName("x")).toEqual({ ok: true, name: "x" });
    expect(validateDocumentName("x".repeat(DOCUMENT_NAME_MAX))).toEqual({ ok: true, name: "x".repeat(DOCUMENT_NAME_MAX) });
  });
  it("rejects blank, whitespace-only, over-long and non-string input in plain words", () => {
    for (const bad of ["", "   ", "\n\t", null, undefined, 5, {}]) {
      expect(validateDocumentName(bad)).toEqual({ ok: false, error: "Enter a name for the document." });
    }
    expect(validateDocumentName("x".repeat(201))).toEqual({ ok: false, error: "The name can be at most 200 characters." });
  });
  it("200 is the limit (trimmed length counts)", () => {
    expect(validateDocumentName(` ${"x".repeat(200)} `).ok).toBe(true);
  });
});

// ── renameDocument action ─────────────────────────────────────────────────────

describe("renameDocument", () => {
  it("requires a session before any DB access", async () => {
    authMock.mockResolvedValue(null);
    await expect(renameDocument({ documentId: DOC, documentName: "x" })).rejects.toThrow("Unauthorized");
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("source: requireAuth is the first statement; input is zod-parsed, trimmed 1-200", () => {
    const src = read("actions/documents.ts");
    const body = src.slice(src.indexOf("export async function renameDocument"));
    // The signature's return type has braces of its own: anchor on `Promise<...> {`.
    expect(body).toMatch(/^[\s\S]*?\)\s*:\s*Promise<[\s\S]*?>\s*\{\s*const user = await requireAuth\(\);/);
    expect(body.indexOf("requireAuth()")).toBeLessThan(body.indexOf("safeParse"));
    expect(body.indexOf("requireAuth()")).toBeLessThan(body.indexOf("db."));
    const schemaSrc = src.slice(src.indexOf("const renameDocumentSchema"), src.indexOf("export type RenameDocumentInput"));
    expect(schemaSrc).toContain("z.string().uuid()");
    expect(schemaSrc).toContain(".trim()");
    expect(schemaSrc).toContain(".min(1");
    expect(schemaSrc).toContain(".max(DOCUMENT_NAME_MAX");
    expect(DOCUMENT_NAME_MAX).toBe(200);
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain("renameDocumentSchema.safeParse(input)");
  });

  it("renames, trimming the name, with an archivedAt guard on both the read and the write", async () => {
    const r = await renameDocument({ documentId: DOC, documentName: "  Property Tax Bill - 27 Old Barry Rd (2025)  " });
    expect(r).toEqual({ ok: true, changed: true, documentName: "Property Tax Bill - 27 Old Barry Rd (2025)" });
    expect(mockDb.document.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: DOC, archivedAt: null } }));
    expect(mockDb.document.updateMany).toHaveBeenCalledWith({
      where: { id: DOC, archivedAt: null },
      data: { documentName: "Property Tax Bill - 27 Old Barry Rd (2025)" },
    });
  });

  it("writes ONLY documentName (not type, year, extraction, verification or archive)", async () => {
    await renameDocument({ documentId: DOC, documentName: "New name" });
    const write = mockDb.document.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(Object.keys(write.data)).toEqual(["documentName"]);
    expect(mockDb.document.update).not.toHaveBeenCalled();
  });

  it("is allowed for a VERIFIED document (the extraction is untouched): the read never asks about verification", async () => {
    mockDb.document.findFirst.mockResolvedValue({ id: DOC, documentName: "W-2 (2025)", extractionConfirmedAt: new Date() });
    const r = await renameDocument({ documentId: DOC, documentName: "Eric W-2 Alpine Bio" });
    expect(r.ok).toBe(true);
    const select = (mockDb.document.findFirst.mock.calls[0]![0] as { select: Record<string, boolean> }).select;
    expect(select).not.toHaveProperty("extractionConfirmedAt");
    const src = read("actions/documents.ts");
    const body = src.slice(src.indexOf("export async function renameDocument"), src.indexOf("User-initiated backfill"));
    expect(body).not.toContain("VERIFIED_RETYPE_ERROR");
    expect(body).not.toContain("extractionConfirmedAt");
  });

  it("writes an audit entry with ids and the field name only, never the name text", async () => {
    await renameDocument({ documentId: DOC, documentName: "Secret-ish name 2025" });
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const entry = mockDb.auditLog.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(entry.data.changedBy).toBe(USER);
    expect(entry.data.changeType).toBe("document_rename");
    expect(JSON.stringify(entry)).not.toContain("Secret-ish");
    expect(JSON.stringify(entry)).toContain(DOC);
  });

  it("refuses blank / over-long names and a bad id without touching the DB", async () => {
    for (const documentName of ["", "   ", "x".repeat(201)]) {
      const r = await renameDocument({ documentId: DOC, documentName });
      expect(r.ok).toBe(false);
    }
    expect((await renameDocument({ documentId: "not-a-uuid", documentName: "x" })).ok).toBe(false);
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("a missing or archived document is a clean error (nothing written, no audit)", async () => {
    mockDb.document.findFirst.mockResolvedValue(null);
    expect(await renameDocument({ documentId: DOC, documentName: "x" })).toEqual({ ok: false, error: "Document not found" });
    mockDb.document.findFirst.mockResolvedValue({ id: DOC, documentName: "old" });
    mockDb.document.updateMany.mockResolvedValue({ count: 0 });
    expect(await renameDocument({ documentId: DOC, documentName: "x" })).toEqual({ ok: false, error: "Document not found" });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("the same name is a no-op (no write, no audit)", async () => {
    const r = await renameDocument({ documentId: DOC, documentName: " Property Tax Bill (2024) " });
    expect(r).toEqual({ ok: true, changed: false, documentName: "Property Tax Bill (2024)" });
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("a revalidation failure never turns a successful rename into an error", async () => {
    revalidateMock.mockImplementationOnce(() => {
      throw new Error("outside request");
    });
    expect((await renameDocument({ documentId: DOC, documentName: "x" })).ok).toBe(true);
  });
});

// ── refreshAutoNameForYear: the property tax bill misread as 2024 ─────────────

const PT_DATA_2024 = { taxYear: 2024, taxType: "real_estate", jurisdictionName: "Town of Bellingham", totalTaxBilledCents: 450000 };

describe("refreshAutoNameForYear", () => {
  it("regenerates 'Property Tax Bill (2024)' to 2025 when the year is corrected (Eric's case)", () => {
    // How the upload named it: the AI's misread 2024 wins over the filed-under year.
    const original = generateDocumentName("property_tax", 2025, { docType: "other", data: PT_DATA_2024 });
    expect(original).toBe("Property Tax Bill (2024)");
    expect(
      refreshAutoNameForYear({ docType: "property_tax", documentName: original, oldYears: [2025, 2024, 2024], newYear: 2025, dataVariants: [PT_DATA_2024] })
    ).toBe("Property Tax Bill (2025)");
  });

  it("works when the old name's year is only the AI year, or only the filed-under year", () => {
    expect(
      refreshAutoNameForYear({ docType: "property_tax", documentName: "Property Tax Bill (2024)", oldYears: [null, 2024], newYear: 2025, dataVariants: [{}] })
    ).toBe("Property Tax Bill (2025)");
    expect(
      refreshAutoNameForYear({ docType: "property_tax", documentName: "Property Tax Bill (2024)", oldYears: [2024], newYear: 2023, dataVariants: [] })
    ).toBe("Property Tax Bill (2023)");
  });

  it("keeps the source in a W-2 / donation / retirement name and changes only the year", () => {
    expect(
      refreshAutoNameForYear({ docType: "w2", documentName: "W-2 — Alpine Bio (2024)", oldYears: [2024], newYear: 2025, dataVariants: [{ employerName: "Alpine Bio", taxYear: 2024 }] })
    ).toBe("W-2 — Alpine Bio (2025)");
    expect(
      refreshAutoNameForYear({
        docType: "retirement_contribution",
        documentName: "Retirement Contributions — Betterment (2024)",
        oldYears: [2024],
        newYear: 2025,
        dataVariants: [{ issuerName: "Betterment", taxYear: 2024 }],
      })
    ).toBe("Retirement Contributions — Betterment (2025)");
  });

  it("NEVER overwrites a name the owner typed", () => {
    for (const typed of [
      "Bellingham tax bill",
      "Property tax - lake house",
      "Property Tax Bill (2024) FINAL",
      "property tax bill (2024)",
      "My 2024 property tax",
      "Property Tax Bill — 27 Old Barry Rd (2024)",
    ]) {
      expect(
        refreshAutoNameForYear({ docType: "property_tax", documentName: typed, oldYears: [2024], newYear: 2025, dataVariants: [PT_DATA_2024] }),
        typed
      ).toBeNull();
    }
  });

  it("leaves a name alone when the year did not change, was cleared, or the name is blank", () => {
    const base = { docType: "property_tax", documentName: "Property Tax Bill (2024)", oldYears: [2024] as number[], dataVariants: [PT_DATA_2024] };
    expect(refreshAutoNameForYear({ ...base, newYear: 2024 })).toBeNull();
    expect(refreshAutoNameForYear({ ...base, newYear: null })).toBeNull();
    expect(refreshAutoNameForYear({ ...base, documentName: null, newYear: 2025 })).toBeNull();
    expect(refreshAutoNameForYear({ ...base, documentName: "   ", newYear: 2025 })).toBeNull();
  });

  it("the bare type label is a placeholder and gains the new year", () => {
    expect(refreshAutoNameForYear({ docType: "property_tax", documentName: "Property Tax Bill", oldYears: [null], newYear: 2025, dataVariants: [] })).toBe(
      "Property Tax Bill (2025)"
    );
  });

  it("a name for a year that was not the old year is not auto for this change", () => {
    expect(
      refreshAutoNameForYear({ docType: "property_tax", documentName: "Property Tax Bill (2022)", oldYears: [2024, 2025], newYear: 2023, dataVariants: [PT_DATA_2024] })
    ).toBeNull();
  });
});

// ── the review-screen correction hooks the refresh (the only path that changes a document's year) ──

const EXTRACTED_AT = new Date("2026-10-02T15:00:00.000Z");
function ptRow(over: Record<string, unknown> = {}) {
  return {
    id: DOC,
    docType: "property_tax",
    extractionStatus: "complete",
    extractionData: { docType: "property_tax", schemaVersion: 2, summary: "bill", data: PT_DATA_2024 },
    extractionCorrections: null,
    extractedAt: EXTRACTED_AT,
    extractionConfirmedAt: null,
    documentName: "Property Tax Bill (2024)",
    taxYear: 2025,
    ...over,
  };
}
const reviewInput = (fields: Record<string, unknown>) => ({ documentId: DOC, expectedExtractedAt: EXTRACTED_AT.toISOString(), fields });
const nameWrites = () =>
  mockDb.document.updateMany.mock.calls.filter((c) => "documentName" in ((c[0] as { data: Record<string, unknown> }).data ?? {}));

describe("correcting the tax year on the review screen refreshes an auto name", () => {
  it("Property Tax Bill (2024) -> Property Tax Bill (2025) after the owner corrects 2024 to 2025 (save)", async () => {
    mockDb.document.findFirst.mockResolvedValue(ptRow());
    expect(await saveDocumentCorrections(reviewInput({ taxYear: 2025 }))).toEqual({ ok: true });
    const writes = nameWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toEqual({
      where: { id: DOC, archivedAt: null, documentName: "Property Tax Bill (2024)" },
      data: { documentName: "Property Tax Bill (2025)" },
    });
  });

  it("also on confirm, and the name write comes after the corrections write", async () => {
    mockDb.document.findFirst.mockResolvedValue(ptRow());
    expect(await confirmDocumentExtraction(reviewInput({ taxYear: 2025 }))).toEqual({ ok: true });
    expect(mockDb.document.updateMany.mock.calls).toHaveLength(2);
    expect("extractionCorrections" in (mockDb.document.updateMany.mock.calls[0]![0] as { data: object }).data).toBe(true);
    expect(nameWrites()).toHaveLength(1);
  });

  it("never touches a name the owner typed", async () => {
    mockDb.document.findFirst.mockResolvedValue(ptRow({ documentName: "Bellingham tax bill (lake house)" }));
    expect(await saveDocumentCorrections(reviewInput({ taxYear: 2025 }))).toEqual({ ok: true });
    expect(nameWrites()).toHaveLength(0);
  });

  it("does nothing when the corrected field is not the year", async () => {
    mockDb.document.findFirst.mockResolvedValue(ptRow());
    expect(await saveDocumentCorrections(reviewInput({ jurisdictionName: "Bellingham" }))).toEqual({ ok: true });
    expect(nameWrites()).toHaveLength(0);
  });

  it("a failing name write never fails the review save that already succeeded", async () => {
    mockDb.document.findFirst.mockResolvedValue(ptRow());
    mockDb.document.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error("db down"));
    expect(await saveDocumentCorrections(reviewInput({ taxYear: 2025 }))).toEqual({ ok: true });
  });

  it("source: the refresh is best-effort (own try/catch) and guarded on the name it read", () => {
    const src = read("actions/document-verification.ts");
    const fn = src.slice(src.indexOf("async function refreshNameForYearChange"), src.indexOf("async function applyReview"));
    expect(fn).toContain("try {");
    expect(fn).toContain("catch");
    expect(fn).toContain("archivedAt: null, documentName: doc.documentName");
  });
});

// ── UI render smoke (no DOM, no browser) ──────────────────────────────────────

describe("Rename control render", () => {
  it("every row shows the name and an obvious Rename control", () => {
    const html = renderToStaticMarkup(createElement(DocumentNameCell, { documentId: DOC, documentName: "Property Tax Bill (2025)", fallbackText: null }));
    expect(html).toContain("Property Tax Bill (2025)");
    expect(html).toContain(">Rename<");
    expect(html).toContain('aria-label="Rename Property Tax Bill (2025)"');
  });

  it("an unnamed document shows the upload note, and a dash when there is neither", () => {
    expect(renderToStaticMarkup(createElement(DocumentNameCell, { documentId: DOC, documentName: null, fallbackText: "uploaded by hand" }))).toContain(
      "uploaded by hand"
    );
    const empty = renderToStaticMarkup(createElement(DocumentNameCell, { documentId: DOC, documentName: null, fallbackText: null }));
    expect(empty).toContain("—");
    expect(empty).toContain(">Rename<");
  });

  it("the edit form has a labelled input, plain-language help, Save and Cancel, and shows an error", () => {
    const html = renderToStaticMarkup(
      createElement(DocumentNameForm, { value: "Draft", busy: false, error: "Enter a name for the document.", onChange: () => {}, onSave: () => {}, onCancel: () => {} })
    );
    expect(html).toContain('aria-label="Document name"');
    expect(html).toContain('value="Draft"');
    expect(html).toContain("Changes the name only");
    expect(html).toContain("Save name");
    expect(html).toContain("Cancel");
    expect(html).toContain("Enter a name for the document.");
    expect(html).not.toContain('disabled=""');
    const busy = renderToStaticMarkup(createElement(DocumentNameForm, { value: "Draft", busy: true, error: null, onChange: () => {}, onSave: () => {}, onCancel: () => {} }));
    expect(busy).toContain("Saving...");
    expect(busy).toContain('disabled=""');
  });

  it("the cell never uses window.confirm / alert, and the page wires it into the name column", () => {
    const cell = read("components/documents/document-name-cell.tsx");
    expect(cell).not.toMatch(/window\.confirm|\bconfirm\(|\balert\(/);
    const page = read("app/documents/page.tsx");
    expect(page).toContain("<DocumentNameCell");
    expect(page).toContain("documentName={doc.documentName}");
    expect(page).toContain("fallbackText={doc.notes}");
  });
});
