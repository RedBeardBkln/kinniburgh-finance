import { describe, it, expect, vi, beforeEach } from "vitest";

// Everything external is mocked: no real Anthropic call, no storage download,
// no database.
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const mockDb = vi.hoisted(() => ({
  document: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
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
  classifyDocType: vi.fn(() => "bank_statement"),
}));
vi.mock("@/lib/doc-extract", () => extractMock);

vi.mock("@/lib/statement-ledger", () => ({ loadLedgerIndexes: vi.fn() }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));

import { fillMissingDocumentYears, runDocumentExtraction } from "@/actions/documents";

const USER = "11111111-1111-4111-8111-111111111111";
const DOC = "c0000000-0000-4000-8000-000000000001";

const STATEMENT = {
  docType: "bank_statement",
  summary: "stmt",
  period: "2025-04",
  data: { periodStart: "2025-03-28", periodEnd: "2025-04-27" },
};

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: DOC,
    docType: "bank_statement",
    fileKey: "statements/e/d.pdf",
    extractionStatus: null,
    extractionData: null,
    extractionConfirmedAt: null,
    extractionConfirmedById: null,
    extractionCorrections: null,
    extractionError: null,
    taxYear: null,
    updatedAt: new Date(),
    archivedAt: null,
    bankStatement: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  revalidateMock.mockReset();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.document.findFirst.mockResolvedValue(docRow());
  mockDb.document.updateMany.mockResolvedValue({ count: 1 });
  mockDb.document.update.mockResolvedValue({});
  storage.downloadDocumentFile.mockResolvedValue(Buffer.from("pdf"));
  extractMock.extractDocumentOrThrow.mockResolvedValue(STATEMENT);
});

describe("runExtraction - fills a missing year after a successful extraction", () => {
  it("runs one extra guarded updateMany AFTER the claim, with the derived year", async () => {
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.updateMany).toHaveBeenCalledTimes(2);
    // 1st call is the extraction claim, 2nd is the year fill.
    expect(mockDb.document.updateMany.mock.calls[0]?.[0].data).toEqual({ extractionStatus: "processing" });
    expect(mockDb.document.updateMany.mock.calls[1]?.[0]).toEqual({
      where: { id: DOC, archivedAt: null, taxYear: null },
      data: { taxYear: 2025 },
    });
    // The year is NOT part of the extraction write, and no second `update` happens.
    expect(mockDb.document.update).toHaveBeenCalledTimes(1);
    expect(mockDb.document.update.mock.calls[0]?.[0].data).not.toHaveProperty("taxYear");
  });

  it("does not write a year when the document already has one", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ taxYear: 2024 }));
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.updateMany).toHaveBeenCalledTimes(1); // only the claim
  });

  it("does not write a year when none can be derived", async () => {
    extractMock.extractDocumentOrThrow.mockResolvedValue({ docType: "bank_statement", summary: "x", data: {} });
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not write a year when the extraction failed", async () => {
    extractMock.extractDocumentOrThrow.mockRejectedValue(new Error("API overloaded"));
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: false, error: "API overloaded" });
    expect(mockDb.document.updateMany).toHaveBeenCalledTimes(1); // only the claim
  });

  it("derives a tax form's year from the EFFECTIVE data (owner correction wins)", async () => {
    mockDb.document.findFirst.mockResolvedValue(
      docRow({
        docType: "w2",
        extractionCorrections: { version: 1, fields: { taxYear: { value: 2024, aiValue: 2025 } }, events: [] },
      })
    );
    extractMock.extractDocumentOrThrow.mockResolvedValue({
      docType: "w2",
      schemaVersion: 2,
      summary: "W-2",
      data: { taxYear: 2025, employerName: "Acme", wagesCents: 5000000, federalWithheldCents: 800000 },
    });
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.updateMany.mock.calls[1]?.[0].data).toEqual({ taxYear: 2024 });
  });

  it("a failing year write is swallowed: result is still ok and the status is never flipped to failed", async () => {
    mockDb.document.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockRejectedValueOnce(new Error("db hiccup")); // year write
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.update).toHaveBeenCalledTimes(1);
    expect(mockDb.document.update.mock.calls[0]?.[0].data).toMatchObject({ extractionStatus: "complete" });
  });
});

describe("fillMissingDocumentYears", () => {
  const row = (id: string, docType: string, extractionData: unknown) => ({
    id,
    docType,
    extractionData,
    extractionCorrections: null,
    extractionConfirmedAt: null,
  });
  const stmt = (periodEnd: string) => ({ docType: "bank_statement", summary: "s", data: { periodEnd } });

  function expectNoPaidWork() {
    expect(storage.downloadDocumentFile).not.toHaveBeenCalled();
    expect(storage.getDocumentFileSignedUrl).not.toHaveBeenCalled();
    expect(extractMock.extractDocumentOrThrow).not.toHaveBeenCalled();
  }

  it("rejects without a session before any DB call", async () => {
    authMock.mockResolvedValue(null);
    await expect(fillMissingDocumentYears()).rejects.toThrow("Unauthorized");
    expect(mockDb.document.findMany).not.toHaveBeenCalled();
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
    expectNoPaidWork();
  });

  it("reads only non-archived, yearless documents", async () => {
    mockDb.document.findMany.mockResolvedValue([]);
    await fillMissingDocumentYears();
    expect(mockDb.document.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.document.findMany.mock.calls[0]?.[0].where).toEqual({ archivedAt: null, taxYear: null });
  });

  it("groups fills by year and writes each group with the null + archived guards", async () => {
    mockDb.document.findMany.mockResolvedValue([
      row("a", "bank_statement", stmt("2025-04-27")),
      row("b", "bank_statement", stmt("2025-05-27")),
      row("c", "bank_statement", stmt("2024-12-27")),
      row("d", "other", { data: {} }),
    ]);
    mockDb.document.updateMany.mockImplementation(async (arg: { where: { id: { in: string[] } } }) => ({
      count: arg.where.id.in.length,
    }));
    const r = await fillMissingDocumentYears();
    expect(r).toEqual({ updated: 3, skippedNoYear: 1 });
    expect(mockDb.document.updateMany).toHaveBeenCalledTimes(2);
    expect(mockDb.document.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] }, archivedAt: null, taxYear: null },
      data: { taxYear: 2025 },
    });
    expect(mockDb.document.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["c"] }, archivedAt: null, taxYear: null },
      data: { taxYear: 2024 },
    });
    // Only taxYear is ever written; no per-row update.
    expect(mockDb.document.update).not.toHaveBeenCalled();
    expectNoPaidWork();
  });

  it("reports what the database changed, not what was planned", async () => {
    mockDb.document.findMany.mockResolvedValue([
      row("a", "bank_statement", stmt("2025-04-27")),
      row("b", "bank_statement", stmt("2025-05-27")),
      row("c", "bank_statement", stmt("2025-06-27")),
    ]);
    mockDb.document.updateMany.mockResolvedValue({ count: 2 }); // someone set one concurrently
    const r = await fillMissingDocumentYears();
    expect(r).toEqual({ updated: 2, skippedNoYear: 0 });
  });

  it("with nothing fillable performs no write and returns {0, N}", async () => {
    mockDb.document.findMany.mockResolvedValue([row("d", "other", { data: {} }), row("e", "bank_statement", null)]);
    const r = await fillMissingDocumentYears();
    expect(r).toEqual({ updated: 0, skippedNoYear: 2 });
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
    expectNoPaidWork();
  });

  it("a revalidatePath failure is not fatal", async () => {
    mockDb.document.findMany.mockResolvedValue([row("a", "bank_statement", stmt("2025-04-27"))]);
    revalidateMock.mockImplementation(() => {
      throw new Error("revalidate during render");
    });
    await expect(fillMissingDocumentYears()).resolves.toEqual({ updated: 1, skippedNoYear: 0 });
  });
});
