import { describe, it, expect, vi, beforeEach } from "vitest";

// Tester-added adversarial coverage for document-year-from-extraction.
// Everything external is mocked: no DB, no storage, no Anthropic.
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
  classifyDocType: vi.fn(() => "w2"),
}));
vi.mock("@/lib/doc-extract", () => extractMock);

vi.mock("@/lib/statement-ledger", () => ({ loadLedgerIndexes: vi.fn() }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));

import { runDocumentExtraction, triggerExtraction } from "@/actions/documents";
import { deriveDocumentTaxYear, planYearFill } from "@/lib/document-year";
import { VERIFIED_REEXTRACT_ERROR, ALREADY_UP_TO_DATE_ERROR, NOT_EXTRACTED_TYPE_ERROR } from "@/lib/document-extraction-state";

const USER = "11111111-1111-4111-8111-111111111111";
const DOC = "c0000000-0000-4000-8000-000000000001";

const GOOD_W2 = {
  docType: "w2",
  schemaVersion: 2,
  summary: "W-2",
  data: { taxYear: 2025, employerName: "Acme", wagesCents: 5000000, federalWithheldCents: 800000 },
};
const NEW_W2 = { ...GOOD_W2, summary: "W-2 (fresh)" };

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
    taxYear: null,
    updatedAt: new Date(),
    archivedAt: null,
    bankStatement: null,
    ...over,
  };
}

function expectNothingWritten() {
  expect(storage.downloadDocumentFile).not.toHaveBeenCalled();
  expect(extractMock.extractDocumentOrThrow).not.toHaveBeenCalled();
  expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  expect(mockDb.document.update).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  revalidateMock.mockReset();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.document.findFirst.mockResolvedValue(docRow());
  mockDb.document.updateMany.mockResolvedValue({ count: 1 });
  mockDb.document.update.mockResolvedValue({});
  storage.downloadDocumentFile.mockResolvedValue(Buffer.from("pdf"));
  extractMock.extractDocumentOrThrow.mockResolvedValue(NEW_W2);
});

describe("runExtraction year fill - guard paths never write a year (yearless doc)", () => {
  it("verified doc, forced, no discard -> refused, no writes at all", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionConfirmedAt: new Date() }));
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: false, error: VERIFIED_REEXTRACT_ERROR });
    expectNothingWritten();
  });

  it("stale expect -> already up to date, no writes at all", async () => {
    const r = await runDocumentExtraction(DOC, { force: true, expect: "unextracted" });
    expect(r).toEqual({ ok: false, error: ALREADY_UP_TO_DATE_ERROR });
    expectNothingWritten();
  });

  it("non-forced with usable data returns the existing result and writes nothing", async () => {
    const r = await runDocumentExtraction(DOC);
    expect(r).toEqual({ ok: true });
    expectNothingWritten();
  });

  it("non-extractable type -> no writes", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ docType: "other", extractionStatus: null, extractionData: null }));
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: false, error: NOT_EXTRACTED_TYPE_ERROR });
    expectNothingWritten();
  });

  it("document missing/archived -> no writes", async () => {
    mockDb.document.findFirst.mockResolvedValue(null);
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: false, error: "Document not found" });
    expectNothingWritten();
  });

  it("lost the claim (another extraction running) -> adopts the winner's result, writes no year", async () => {
    mockDb.document.updateMany.mockResolvedValueOnce({ count: 0 });
    mockDb.document.findUnique.mockResolvedValue({ extractionStatus: "complete", extractionData: GOOD_W2 });
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.updateMany).toHaveBeenCalledTimes(1); // claim only
    expect(mockDb.document.update).not.toHaveBeenCalled();
    expect(storage.downloadDocumentFile).not.toHaveBeenCalled();
    expect(extractMock.extractDocumentOrThrow).not.toHaveBeenCalled();
  });

  it("tax form where the AI read nothing usable -> failure, no year write", async () => {
    extractMock.extractDocumentOrThrow.mockResolvedValue({
      docType: "w2",
      schemaVersion: 2,
      summary: "x",
      data: { taxYear: 2025 },
    });
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r.ok).toBe(false);
    expect(mockDb.document.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("runExtraction year fill - other success shapes", () => {
  it("verified doc re-extracted WITH discard: year comes from the fresh AI data, one year updateMany", async () => {
    mockDb.document.findFirst.mockResolvedValue(
      docRow({ extractionConfirmedAt: new Date(), extractionConfirmedById: USER })
    );
    const r = await runDocumentExtraction(DOC, { force: true, discardVerification: true });
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.updateMany).toHaveBeenCalledTimes(2);
    expect(mockDb.document.updateMany.mock.calls[1]?.[0]).toEqual({
      where: { id: DOC, archivedAt: null, taxYear: null },
      data: { taxYear: 2025 },
    });
    expect(mockDb.document.update.mock.calls[0]?.[0].data).toMatchObject({ extractionConfirmedAt: null });
  });

  it("the guarded year write matching zero rows (year set meanwhile) is harmless", async () => {
    mockDb.document.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.update).toHaveBeenCalledTimes(1);
  });

  it("year write is skipped (not just guarded) when the doc already has a year", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ taxYear: 2023 }));
    await runDocumentExtraction(DOC, { force: true });
    // only the claim: a set year is never even targeted
    expect(mockDb.document.updateMany).toHaveBeenCalledTimes(1);
  });

  it("credit-card-linked bank_statement uses the RAW docType for year derivation", async () => {
    mockDb.document.findFirst.mockResolvedValue(
      docRow({
        docType: "bank_statement",
        extractionStatus: null,
        extractionData: null,
        bankStatement: { account: { accountType: "credit_card" } },
      })
    );
    extractMock.extractDocumentOrThrow.mockResolvedValue({
      docType: "credit_card_statement",
      summary: "cc",
      period: "2025-01",
      data: { periodStart: "2024-12-28", periodEnd: "2025-01-27" },
    });
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: true });
    expect(extractMock.extractDocumentOrThrow.mock.calls[0]?.[2]).toBe("credit_card_statement");
    expect(mockDb.document.updateMany.mock.calls[1]?.[0].data).toEqual({ taxYear: 2025 });
  });

  it("triggerExtraction (cron/other entry) also fills the year", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionStatus: null, extractionData: null }));
    const out = await triggerExtraction(DOC);
    expect(out).not.toBeNull();
    expect(mockDb.document.updateMany.mock.calls[1]?.[0].data).toEqual({ taxYear: 2025 });
  });

  it("a thrown year-derivation error (corrupt corrections JSON) is swallowed", async () => {
    mockDb.document.findFirst.mockResolvedValue(
      docRow({ extractionStatus: null, extractionData: null, extractionCorrections: "garbage", taxYear: null })
    );
    const r = await runDocumentExtraction(DOC, { force: true });
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.update).toHaveBeenCalledTimes(1);
  });
});

describe("deriveDocumentTaxYear - fuzz: never throws; result is null or an in-range integer", () => {
  const CY = 2026;
  const junk: unknown[] = [
    null, undefined, 0, -1, 1e308, NaN, Infinity, -Infinity, "", " ", "2025", "2025-04-27T00:00:00Z", "2025-04-27 ", " 2025-04-27",
    "０２０２５-04-27", "2025/04/27", "2025-4-7", "2025-13-40", "0000-00-00", "0099-01-01", "9999-12-31", "-2025-01-01",
    true, false, [], [1], {}, { a: 1 }, () => 1, Symbol.for("x"), BigInt(10), new Date("2025-04-27"),
    { toString: () => "2025-04-27" },
  ];
  const types = [
    "bank_statement", "statement", "credit_card_statement", "mortgage_statement", "utility_bill",
    "w2", "1099", "k1", "mortgage_interest", "form_1098", "property_tax", "tax_return",
    "insurance_policy", "policy", "other", "extension", "", "__proto__", "constructor", "toString",
  ];

  it("garbage in every slot", () => {
    for (const t of types) {
      for (const j of junk) {
        const shapes: unknown[] = [
          j,
          { data: j },
          { period: j },
          { data: { periodEnd: j } },
          { data: { periodStart: j, periodEnd: "2025-04-27" } },
          { data: { periodEnd: "2025-04-27", periodStart: j } },
          { period: j, data: { period: j, periodEnd: j, taxYear: j } },
          { data: { taxYear: j } },
        ];
        for (const s of shapes) {
          let out: number | null | undefined;
          expect(() => {
            out = deriveDocumentTaxYear(t, s, CY);
          }).not.toThrow();
          expect(out === null || (Number.isInteger(out) && (out as number) >= 2000 && (out as number) <= CY + 1)).toBe(true);
        }
      }
    }
  });

  it("huge/negative/float tax years -> null", () => {
    for (const y of [-2025, 0, 1, 99, 1999, 2028, 3000, 20250, 1e9, Number.MAX_SAFE_INTEGER, 2025.0000001, -0]) {
      expect(deriveDocumentTaxYear("w2", { data: { taxYear: y } }, CY)).toBeNull();
    }
    expect(deriveDocumentTaxYear("w2", { data: { taxYear: 2025.0 } }, CY)).toBe(2025);
  });

  it("prototype-ish docTypes derive null", () => {
    for (const t of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(deriveDocumentTaxYear(t, { data: { periodEnd: "2025-04-27", taxYear: 2025 } }, CY)).toBeNull();
    }
  });

  it("dates parsed as strings only: Date objects / timestamps are not accepted for periodEnd", () => {
    expect(deriveDocumentTaxYear("bank_statement", { data: { periodEnd: new Date("2025-04-27") } }, CY)).toBeNull();
    expect(deriveDocumentTaxYear("bank_statement", { data: { periodEnd: 1745712000000 } }, CY)).toBeNull();
  });

  it("year 0000-0099 round-trip rejection", () => {
    expect(deriveDocumentTaxYear("bank_statement", { data: { periodEnd: "0025-04-27" } }, CY)).toBeNull();
  });

  it("periodStart equal to periodEnd is allowed; string-order boundary across year", () => {
    expect(deriveDocumentTaxYear("bank_statement", { data: { periodStart: "2025-04-27", periodEnd: "2025-04-27" } }, CY)).toBe(2025);
    expect(deriveDocumentTaxYear("bank_statement", { data: { periodStart: "2025-01-01", periodEnd: "2024-12-31" } }, CY)).toBeNull();
  });
});

describe("planYearFill - robustness", () => {
  it("rows with corrupt corrections / null data do not throw and count as skipped", () => {
    const rows = [
      { id: "a", docType: "w2", extractionData: null, extractionCorrections: "x", extractionConfirmedAt: null },
      { id: "b", docType: "w2", extractionData: { data: { taxYear: 2025 } }, extractionCorrections: { fields: 5 }, extractionConfirmedAt: new Date() },
      { id: "c", docType: "bank_statement", extractionData: { data: { periodEnd: "2025-06-27" } }, extractionCorrections: [], extractionConfirmedAt: null },
    ];
    const plan = planYearFill(rows, 2026);
    expect(plan.fills.map((f) => f.id)).toContain("c");
    expect(plan.fills.length + plan.skippedNoYear).toBe(3);
  });
});
