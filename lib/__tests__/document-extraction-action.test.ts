import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Everything external is mocked: no real Anthropic call, no storage download,
// no database. Every guard test asserts the paid/IO calls were NEVER made.
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const mockDb = vi.hoisted(() => ({
  document: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const storage = vi.hoisted(() => ({
  getDocumentFileSignedUrl: vi.fn(),
  downloadDocumentFile: vi.fn(),
  getSignedUploadUrl: vi.fn(),
}));
vi.mock("@/lib/supabase-storage", () => storage);

const extractMock = vi.hoisted(() => ({
  extractDocumentOrThrow: vi.fn(),
  classifyDocType: vi.fn(() => "w2"),
}));
vi.mock("@/lib/doc-extract", () => extractMock);

vi.mock("@/lib/statement-ledger", () => ({ loadLedgerIndexes: vi.fn() }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));

import {
  confirmDocExtraction,
  runDocumentExtraction,
  triggerExtraction,
} from "@/actions/documents";
import {
  ALREADY_UP_TO_DATE_ERROR,
  NOT_EXTRACTED_TYPE_ERROR,
  VERIFIED_REEXTRACT_ERROR,
} from "@/lib/document-extraction-state";

const USER = "11111111-1111-4111-8111-111111111111";
const DOC = "c0000000-0000-4000-8000-000000000001";

const GOOD_W2 = {
  docType: "w2",
  schemaVersion: 2,
  summary: "W-2",
  data: { taxYear: 2025, employerName: "Acme", wagesCents: 5000000, federalWithheldCents: 800000 },
};
const NEW_W2 = { ...GOOD_W2, summary: "W-2 (fresh)" };
// An extraction made before the expanded schemas: no schemaVersion.
const LEGACY_W2 = { docType: "w2", summary: "W-2", data: GOOD_W2.data };

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: DOC,
    docType: "w2",
    fileKey: "tax/e/d.pdf",
    extractionStatus: "complete",
    extractionData: GOOD_W2,
    extractionConfirmedAt: null,
    extractionConfirmedById: null,
    extractionCorrections: null,
    extractionError: null,
    updatedAt: new Date(),
    archivedAt: null,
    bankStatement: null,
    ...over,
  };
}

function expectNoPaidWork() {
  expect(storage.downloadDocumentFile).not.toHaveBeenCalled();
  expect(extractMock.extractDocumentOrThrow).not.toHaveBeenCalled();
  expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  expect(mockDb.document.update).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.document.findFirst.mockResolvedValue(docRow());
  mockDb.document.updateMany.mockResolvedValue({ count: 1 });
  mockDb.document.update.mockResolvedValue({});
  storage.downloadDocumentFile.mockResolvedValue(Buffer.from("pdf"));
  extractMock.extractDocumentOrThrow.mockResolvedValue(NEW_W2);
});

describe("runDocumentExtraction - guards (no storage / API call when a guard trips)", () => {
  it("rejects without a session before any DB access", async () => {
    authMock.mockResolvedValue(null);
    await expect(runDocumentExtraction(DOC)).rejects.toThrow("Unauthorized");
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
    expectNoPaidWork();
  });

  it("reads only non-archived documents and errors cleanly when missing", async () => {
    mockDb.document.findFirst.mockResolvedValue(null);
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: false, error: "Document not found" });
    expect(mockDb.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DOC, archivedAt: null } })
    );
    expectNoPaidWork();
  });

  it.each(["other", "extension"])("rejects the non-extractable type %s before storage or API", async (docType) => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ docType, extractionStatus: null, extractionData: null }));
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: false, error: NOT_EXTRACTED_TYPE_ERROR });
    expectNoPaidWork();
  });

  it("refuses to re-extract a verified document without discardVerification", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionConfirmedAt: new Date() }));
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: false, error: VERIFIED_REEXTRACT_ERROR });
    expectNoPaidWork();
  });

  it("expect=unextracted on a document that is already extracted is skipped with no API call", async () => {
    const r = await runDocumentExtraction(DOC, { force: true, expect: "unextracted" });
    expect(r).toEqual({ ok: false, error: ALREADY_UP_TO_DATE_ERROR });
    expectNoPaidWork();
  });

  it("expect=outdated is skipped when nothing is outdated", async () => {
    const r = await runDocumentExtraction(DOC, { force: true, expect: "outdated" });
    expect(r).toEqual({ ok: false, error: ALREADY_UP_TO_DATE_ERROR });
    expectNoPaidWork();
  });

  it("expect=outdated never touches a VERIFIED older-format document (no storage / API call)", async () => {
    mockDb.document.findFirst.mockResolvedValue(
      docRow({ extractionData: LEGACY_W2, extractionConfirmedAt: new Date(), extractionConfirmedById: USER })
    );
    const r = await runDocumentExtraction(DOC, { force: true, expect: "outdated", discardVerification: true });
    expect(r).toEqual({ ok: false, error: ALREADY_UP_TO_DATE_ERROR });
    expectNoPaidWork();
  });

  it("expect=outdated never touches a hand-corrected older-format document", async () => {
    mockDb.document.findFirst.mockResolvedValue(
      docRow({
        extractionData: LEGACY_W2,
        extractionCorrections: { version: 1, fields: { wagesCents: { value: 1, aiValue: 2 } }, events: [] },
      })
    );
    const r = await runDocumentExtraction(DOC, { force: true, expect: "outdated" });
    expect(r).toEqual({ ok: false, error: ALREADY_UP_TO_DATE_ERROR });
    expectNoPaidWork();
  });

  it("a non-forced run on a document that already has usable data returns it without any work", async () => {
    const r = await runDocumentExtraction(DOC);
    expect(r).toEqual({ ok: true });
    expectNoPaidWork();
  });

  it("ignores a garbage expect value from the browser (does not treat it as a guard)", async () => {
    const r = await runDocumentExtraction(DOC, { expect: "bogus" as unknown as "unextracted" });
    expect(r).toEqual({ ok: true }); // non-forced, usable -> early return, still no work
    expectNoPaidWork();
  });

  it("triggerExtraction inherits the gates (other docs rejected, no work)", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ docType: "other", extractionStatus: null, extractionData: null }));
    expect(await triggerExtraction(DOC, { force: true })).toBeNull();
    expectNoPaidWork();
  });
});

describe("runDocumentExtraction - runs", () => {
  it("runs a never-extracted document and writes the result, clearing any previous error", async () => {
    mockDb.document.findFirst.mockResolvedValue(
      docRow({ extractionStatus: null, extractionData: null, extractionError: "old error" })
    );
    const r = await runDocumentExtraction(DOC, { expect: "unextracted" });
    expect(r).toEqual({ ok: true });
    expect(extractMock.extractDocumentOrThrow).toHaveBeenCalledTimes(1);
    const data = mockDb.document.update.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ extractionStatus: "complete", extractionData: NEW_W2, extractionError: null });
    expect(data).not.toHaveProperty("extractionConfirmedAt");
    expect(data).not.toHaveProperty("extractionCorrections");
  });

  it("the claim is guarded by archivedAt: null", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionStatus: null, extractionData: null }));
    await runDocumentExtraction(DOC);
    expect(mockDb.document.updateMany.mock.calls[0]?.[0].where).toMatchObject({ id: DOC, archivedAt: null });
  });

  it("forced re-extract of an UNverified document keeps corrections and does not touch verification columns", async () => {
    mockDb.document.findFirst.mockResolvedValue(
      docRow({ extractionCorrections: { version: 1, fields: { wagesCents: { value: 1, aiValue: 2 } }, events: [] } })
    );
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: true });
    const data = mockDb.document.update.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty("extractionCorrections");
    expect(data).not.toHaveProperty("extractionConfirmedAt");
  });

  it("forced re-extract of a verified document WITH discardVerification clears verification, keeps corrections, logs an event", async () => {
    const corrections = { version: 1, fields: { wagesCents: { value: 1, aiValue: 2 } }, events: [] };
    mockDb.document.findFirst.mockResolvedValue(
      docRow({ extractionConfirmedAt: new Date(), extractionConfirmedById: USER, extractionCorrections: corrections })
    );
    const r = await runDocumentExtraction(DOC, { force: true, discardVerification: true });
    expect(r).toEqual({ ok: true });
    const data = mockDb.document.update.mock.calls[0]?.[0].data;
    expect(data.extractionConfirmedAt).toBeNull();
    expect(data.extractionConfirmedById).toBeNull();
    expect(data.extractionCorrections.fields).toEqual(corrections.fields);
    expect(data.extractionCorrections.events).toEqual([
      expect.objectContaining({ type: "re-extracted", by: USER }),
    ]);
  });

  it("a failed forced re-extract of a document with good data restores 'complete' and records the reason", async () => {
    extractMock.extractDocumentOrThrow.mockRejectedValue(new Error("Extraction output was cut off before it finished"));
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: false, error: "Extraction output was cut off before it finished" });
    const failureWrite = mockDb.document.update.mock.calls[0]?.[0].data;
    expect(failureWrite).toEqual({
      extractionStatus: "complete",
      extractionError: "Extraction output was cut off before it finished",
    });
    expect(failureWrite).not.toHaveProperty("extractionData");
  });

  it("re-extracts an unverified, uncorrected older-format document when expect=outdated (one call, new data stamped by the extractor)", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionData: LEGACY_W2 }));
    const r = await runDocumentExtraction(DOC, { force: true, expect: "outdated" });
    expect(r).toEqual({ ok: true });
    expect(extractMock.extractDocumentOrThrow).toHaveBeenCalledTimes(1);
    const data = mockDb.document.update.mock.calls[0]?.[0].data;
    expect(data.extractionData).toEqual(NEW_W2);
    expect(data).not.toHaveProperty("extractionCorrections");
    expect(data).not.toHaveProperty("extractionConfirmedAt");
  });

  it("a tax re-extract where the AI read nothing usable is a FAILURE: good data is kept, status stays complete", async () => {
    extractMock.extractDocumentOrThrow.mockResolvedValue({
      docType: "w2",
      schemaVersion: 2,
      summary: "blank",
      data: { taxYear: 2025, wagesCents: null, federalWithheldCents: null },
    });
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r.ok).toBe(false);
    const write = mockDb.document.update.mock.calls[0]?.[0].data;
    expect(write).toMatchObject({ extractionStatus: "complete" });
    expect(write).not.toHaveProperty("extractionData");
  });

  it("a failed first run marks the document failed with the reason", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionStatus: null, extractionData: null }));
    extractMock.extractDocumentOrThrow.mockRejectedValue(new Error("API overloaded"));
    const r = await runDocumentExtraction(DOC);
    expect(r).toEqual({ ok: false, error: "API overloaded" });
    expect(mockDb.document.update.mock.calls[0]?.[0].data).toEqual({
      extractionStatus: "failed",
      extractionError: "API overloaded",
    });
  });

  it("persists a bounded, single-line reason", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionStatus: null, extractionData: null }));
    extractMock.extractDocumentOrThrow.mockRejectedValue(new Error(`bad\n${"x".repeat(2000)}`));
    await runDocumentExtraction(DOC);
    const reason = mockDb.document.update.mock.calls[0]?.[0].data.extractionError as string;
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason).not.toMatch(/\n/);
  });
});

describe("confirmDocExtraction (non-tax owner confirmation)", () => {
  it("rejects without a session", async () => {
    authMock.mockResolvedValue(null);
    await expect(confirmDocExtraction(DOC)).rejects.toThrow("Unauthorized");
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
  });

  it("returns an error for a missing / archived document", async () => {
    mockDb.document.findFirst.mockResolvedValue(null);
    const r = await confirmDocExtraction(DOC);
    expect(r).toEqual({ ok: false, error: "Document not found" });
    expect(mockDb.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DOC, archivedAt: null } })
    );
    expect(mockDb.document.update).not.toHaveBeenCalled();
  });

  it.each(["w2", "1099", "k1", "mortgage_interest", "property_tax", "tax_return", "donation_receipt"])(
    "rejects the tax document type %s",
    async (docType) => {
      mockDb.document.findFirst.mockResolvedValue({ id: DOC, docType });
      const r = await confirmDocExtraction(DOC);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toMatch(/review screen/);
      expect(mockDb.document.update).not.toHaveBeenCalled();
    }
  );

  it("on a non-tax document writes ONLY the confirmation columns (never extractionData)", async () => {
    mockDb.document.findFirst.mockResolvedValue({ id: DOC, docType: "insurance_policy" });
    const r = await confirmDocExtraction(DOC);
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.update).toHaveBeenCalledTimes(1);
    const arg = mockDb.document.update.mock.calls[0]?.[0];
    expect(arg.where).toEqual({ id: DOC });
    expect(Object.keys(arg.data).sort()).toEqual(["extractionConfirmedAt", "extractionConfirmedById"]);
    expect(arg.data.extractionConfirmedById).toBe(USER);
    expect(arg.data.extractionConfirmedAt).toBeInstanceOf(Date);
  });
});

describe("bulk bar safety (source)", () => {
  const bulkSrc = () => readFileSync(resolve(__dirname, "../../components/documents/extraction-bulk-bar.tsx"), "utf8");

  it("never sends discardVerification and re-checks each document on the server with expect", () => {
    const src = bulkSrc();
    expect(src).not.toMatch(/discardVerification\s*:\s*true/);
    expect(src).toMatch(/expect:\s*mode === "outdated" \? "outdated" : "unextracted"/);
  });

  it("confirm dialog: 'outdated' says Re-extract / replaced / verified+corrected excluded / paid-call count; 'missing' keeps Extract", () => {
    const src = bulkSrc();
    expect(src).toMatch(/mode === "outdated"\s*\?\s*`Re-extract \$\{docs\} now\?/);
    expect(src).toMatch(/existing AI reading of each document is replaced/);
    expect(src).toMatch(/Verified or hand-corrected documents are\s*"\s*\+\s*"excluded/);
    expect(src).toMatch(/This makes \$\{calls\}/);
    expect(src).toMatch(/const calls = `\$\{batchSize\} paid AI API call/);
    expect(src).toMatch(/:\s*`Extract \$\{docs\} now\?/);
  });

  it("is rendered for both modes on the Documents page, from the server-computed plan", () => {
    const src = readFileSync(resolve(__dirname, "../../app/documents/page.tsx"), "utf8");
    expect(src).toMatch(/mode="missing"/);
    expect(src).toMatch(/mode="outdated"/);
    expect(src).toMatch(/bulkPlan\.outdated/);
  });
});

describe("the Documents page never starts an extraction on render", () => {
  it("does not import any extraction-running action", () => {
    const src = readFileSync(resolve(__dirname, "../../app/documents/page.tsx"), "utf8");
    expect(src).not.toMatch(/runDocumentExtraction|triggerExtraction/);
    // Only the client leaf components (button-driven) run extraction.
    expect(src).toMatch(/ExtractionCell/);
  });

  it("the cell and bulk bar only call the runner from event handlers, never from an effect", () => {
    for (const f of ["extraction-cell.tsx", "extraction-bulk-bar.tsx"]) {
      const src = readFileSync(resolve(__dirname, "../../components/documents", f), "utf8");
      expect(src).not.toMatch(/useEffect/);
    }
  });
});
