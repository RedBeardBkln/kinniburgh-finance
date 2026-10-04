import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Everything external is mocked: no Anthropic call, no storage, no database.
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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
  classifyDocType: vi.fn(() => "1099"),
}));
vi.mock("@/lib/doc-extract", () => extractMock);

vi.mock("@/lib/statement-ledger", () => ({ loadLedgerIndexes: vi.fn() }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));

import { rereadDocumentWithSalesSummary } from "@/actions/documents";

const USER = "11111111-1111-4111-8111-111111111111";
const DOC = "c0000000-0000-4000-8000-000000000001";

// The old read of the owner's consolidated 1099: boxes read, sales summary never read.
const OLD_READ = {
  docType: "1099",
  schemaVersion: 2,
  summary: "Consolidated 1099",
  data: {
    taxYear: 2025,
    formVariant: "consolidated",
    variantsPresent: ["1099-DIV", "1099-B"],
    payerName: "Robinhood Markets, Inc.",
    payerEIN: "46-4136152",
    amountCents: 238,
    federalWithheldCents: 0,
    int_box1Cents: 120,
    div_box1aCents: 238,
    bSummary: null,
  },
};
const NEW_READ = {
  ...OLD_READ,
  summary: "Consolidated 1099 (fresh)",
  data: {
    ...OLD_READ.data,
    div_box1aCents: 240, // the fresh read differs on one box
    bSummary: [
      { form: "1099-B", box: "A", proceedsCents: 587231, costCents: 528550, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 599, gainLossCents: 59280 },
      { form: "1099-B", box: "D", proceedsCents: 1700168, costCents: 1203728, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: 0, gainLossCents: 496440 },
    ],
    sec1256AggregateCents: 0,
  },
};

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: DOC,
    docType: "1099",
    fileKey: "tax/e/d.pdf",
    extractionStatus: "complete",
    extractionData: OLD_READ,
    extractionConfirmedAt: new Date("2026-10-01T12:00:00Z"),
    extractionConfirmedById: USER,
    extractionCorrections: null,
    extractionError: null,
    updatedAt: new Date(),
    taxYear: 2025,
    archivedAt: null,
    bankStatement: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.document.findFirst.mockResolvedValue(docRow());
  mockDb.document.updateMany.mockResolvedValue({ count: 1 });
  mockDb.document.update.mockResolvedValue({});
  storage.downloadDocumentFile.mockResolvedValue(Buffer.from("pdf"));
  extractMock.classifyDocType.mockReturnValue("1099");
  extractMock.extractDocumentOrThrow.mockResolvedValue(NEW_READ);
});

function expectNoPaidWork() {
  expect(storage.downloadDocumentFile).not.toHaveBeenCalled();
  expect(extractMock.extractDocumentOrThrow).not.toHaveBeenCalled();
  expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  expect(mockDb.document.update).not.toHaveBeenCalled();
}

describe("rereadDocumentWithSalesSummary: source pins", () => {
  const src = readFileSync(resolve(__dirname, "../../actions/documents.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("export async function rereadDocumentWithSalesSummary");
  const body = src.slice(start, src.indexOf("\n}\n", start));

  it("starts with requireAuth() and validates its input with zod before touching the database", () => {
    expect(start).toBeGreaterThan(-1);
    const firstStatement = body
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("//"));
    expect(firstStatement).toBe("const user = await requireAuth();");
    expect(src).toMatch(/const rereadSummarySchema = z\.object\(\{ documentId: z\.string\(\)\.uuid\(\) \}\);/);
    expect(body.indexOf("rereadSummarySchema.safeParse")).toBeGreaterThan(body.indexOf("requireAuth()"));
    expect(body.indexOf("rereadSummarySchema.safeParse")).toBeLessThan(body.indexOf("db.document.findFirst"));
  });

  it("only ever forces a re-extract that discards verification (never a delta edit of extractionData)", () => {
    expect(body).toMatch(/runExtraction\(documentId, \{ force: true, discardVerification: true \}, user\.id\)/);
    expect(body).not.toMatch(/db\.document\.(update|updateMany|upsert|delete)\(/); // the action itself writes nothing
    expect(body).toMatch(/archivedAt: null/);
  });
});

describe("rereadDocumentWithSalesSummary: guards (no paid work when one trips)", () => {
  it("rejects without a session before any DB access", async () => {
    authMock.mockResolvedValue(null);
    await expect(rereadDocumentWithSalesSummary({ documentId: DOC })).rejects.toThrow("Unauthorized");
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
    expectNoPaidWork();
  });

  it("rejects a malformed id without reading the database", async () => {
    const r = await rereadDocumentWithSalesSummary({ documentId: "not-a-uuid" });
    expect(r.ok).toBe(false);
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
    expectNoPaidWork();
  });

  it("reads only non-archived documents and errors cleanly when missing", async () => {
    mockDb.document.findFirst.mockResolvedValue(null);
    const r = await rereadDocumentWithSalesSummary({ documentId: DOC });
    expect(r).toEqual({ ok: false, error: "Document not found" });
    expect(mockDb.document.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: DOC, archivedAt: null } }));
    expectNoPaidWork();
  });

  it("refuses any document that is not a 1099", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ docType: "w2" }));
    const r = await rereadDocumentWithSalesSummary({ documentId: DOC });
    expect(r).toMatchObject({ ok: false });
    expectNoPaidWork();
  });

  it("refuses when the sales summary was already read (the ordinary Re-extract covers that)", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionData: NEW_READ }));
    const r = await rereadDocumentWithSalesSummary({ documentId: DOC });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already read/) });
    expectNoPaidWork();
  });
});

describe("rereadDocumentWithSalesSummary: the forced re-read of a verified document", () => {
  it("re-extracts, clears the verification in the SAME write that stores the new read, keeps the corrections, and returns a before / after", async () => {
    const corrections = { version: 1, fields: { int_box1Cents: { value: 125, aiValue: 120 } }, events: [] };
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionCorrections: corrections }));
    const r = await rereadDocumentWithSalesSummary({ documentId: DOC });

    expect(extractMock.extractDocumentOrThrow).toHaveBeenCalledTimes(1);
    const write = mockDb.document.update.mock.calls.find((c) => (c[0] as { data: { extractionData?: unknown } }).data.extractionData !== undefined);
    expect(write).toBeTruthy();
    const data = (write![0] as { data: Record<string, unknown> }).data;
    expect(data.extractionConfirmedAt).toBeNull();
    expect(data.extractionConfirmedById).toBeNull();
    expect(data.extractionStatus).toBe("complete");
    const overlay = data.extractionCorrections as { fields: unknown; events: { type: string; by: string }[] };
    expect(overlay.fields).toEqual(corrections.fields); // corrections untouched
    expect(overlay.events.at(-1)).toMatchObject({ type: "re-extracted", by: USER });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wasVerified).toBe(true);
    expect(r.summaryRows).toBe(2);
    expect(r.comparison.filter((c) => c.changed).map((c) => [c.key, c.before, c.after])).toEqual([["div_box1aCents", "$2.38", "$2.40"]]);
    // nothing identifying travels back to the browser
    const text = JSON.stringify(r);
    expect(text).not.toContain("Robinhood");
    expect(text).not.toContain("46-4136152");
  });

  it("an unverified document is re-read without touching a verification that does not exist", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionConfirmedAt: null, extractionConfirmedById: null }));
    const r = await rereadDocumentWithSalesSummary({ documentId: DOC });
    expect(r.ok && r.wasVerified).toBe(false);
    const write = mockDb.document.update.mock.calls.find((c) => (c[0] as { data: { extractionData?: unknown } }).data.extractionData !== undefined);
    expect("extractionConfirmedAt" in (write![0] as { data: Record<string, unknown> }).data).toBe(false);
  });

  it("a failed read keeps the old data (status restored to complete) and reports the error", async () => {
    extractMock.extractDocumentOrThrow.mockRejectedValue(new Error("Extraction output was cut off before it finished"));
    const r = await rereadDocumentWithSalesSummary({ documentId: DOC });
    expect(r).toEqual({ ok: false, error: "Extraction output was cut off before it finished" });
    const writes = mockDb.document.update.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(writes.some((d) => d.extractionData !== undefined)).toBe(false); // old extractionData never overwritten
    expect(writes.some((d) => d.extractionConfirmedAt === null)).toBe(false); // verification kept on a failed read
    expect(writes.at(-1)).toMatchObject({ extractionStatus: "complete" });
  });

  it("a new read that again has no sales summary is reported as unread (summaryRows null), not as zero sales", async () => {
    extractMock.extractDocumentOrThrow.mockResolvedValue({ ...OLD_READ, data: { ...OLD_READ.data, bSummary: null } });
    const r = await rereadDocumentWithSalesSummary({ documentId: DOC });
    expect(r.ok && r.summaryRows).toBeNull();
  });
});
