import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Everything external is mocked: no database, no storage, no Anthropic client.
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const mockDb = vi.hoisted(() => ({
  document: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  confirmDocumentExtraction,
  saveDocumentCorrections,
  unverifyDocumentExtraction,
} from "@/actions/document-verification";
import { STALE_READING_ERROR } from "@/lib/document-extraction-state";

const USER = "11111111-1111-4111-8111-111111111111";
const DOC = "c0000000-0000-4000-8000-000000000001";
const EXTRACTED_AT = new Date("2026-10-02T15:00:00.000Z");
const EXTRACTED_ISO = EXTRACTED_AT.toISOString();

const AI = {
  docType: "w2",
  schemaVersion: 2,
  summary: "W-2",
  data: { taxYear: 2025, employerName: "Acme", wagesCents: 5000000, federalWithheldCents: 800000 },
};

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: DOC,
    docType: "w2",
    extractionStatus: "complete",
    extractionData: AI,
    extractionCorrections: null,
    extractedAt: EXTRACTED_AT,
    extractionConfirmedAt: null,
    ...over,
  };
}

function input(fields: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return { documentId: DOC, expectedExtractedAt: EXTRACTED_ISO, fields, ...over };
}

function lastWrite() {
  return mockDb.document.updateMany.mock.calls[0]?.[0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.document.findFirst.mockResolvedValue(docRow());
  mockDb.document.updateMany.mockResolvedValue({ count: 1 });
});

describe("auth", () => {
  it("every action rejects without a session before any DB access", async () => {
    authMock.mockResolvedValue(null);
    await expect(saveDocumentCorrections(input({}))).rejects.toThrow("Unauthorized");
    await expect(confirmDocumentExtraction(input({}))).rejects.toThrow("Unauthorized");
    await expect(unverifyDocumentExtraction(DOC)).rejects.toThrow("Unauthorized");
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("requireAuth is the first statement of each exported action", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/document-verification.ts"), "utf8");
    for (const name of ["saveDocumentCorrections", "confirmDocumentExtraction", "unverifyDocumentExtraction"]) {
      const body = src.slice(src.indexOf(`export async function ${name}`));
      const firstStatement = body.slice(body.indexOf("{") + 1).trimStart();
      expect(firstStatement.startsWith("const user = await requireAuth();")).toBe(true);
    }
  });
});

describe("guards (nothing is written)", () => {
  it("reads only non-archived documents; a missing / archived document is a clean error", async () => {
    mockDb.document.findFirst.mockResolvedValue(null);
    const r = await saveDocumentCorrections(input({ wagesCents: 1 }));
    expect(r).toEqual({ ok: false, error: "Document not found" });
    expect(mockDb.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DOC, archivedAt: null } })
    );
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it.each(["insurance_policy", "bank_statement", "utility_bill", "other", "extension", "mortgage_statement"])(
    "refuses non-reviewable document type %s",
    async (docType) => {
      mockDb.document.findFirst.mockResolvedValue(docRow({ docType }));
      const r = await confirmDocumentExtraction(input({}));
      expect(r.ok).toBe(false);
      expect(mockDb.document.updateMany).not.toHaveBeenCalled();
    }
  );

  it.each(["w2", "1099", "k1", "mortgage_interest", "property_tax", "tax_return", "donation_receipt"])(
    "accepts the tax document type %s (bank statements never become Verified here)",
    async (docType) => {
      mockDb.document.findFirst.mockResolvedValue(
        docRow({
          docType,
          extractionData: { docType, summary: "", data: { taxYear: 2025, organizationName: "Food Bank", wagesCents: 1, interestCents: 1, amountCents: 1, ordinaryIncomeCents: 1, totalTaxBilledCents: 1 } },
        })
      );
      // A donation receipt has no taxYear field (its year comes from the gift date).
      const r = await confirmDocumentExtraction(
        input(docType === "donation_receipt" ? { organizationName: "Food Bank Inc" } : { taxYear: 2024 })
      );
      expect(r).toEqual({ ok: true });
    }
  );

  it("refuses when there is no usable extraction to review", async () => {
    for (const over of [
      { extractionStatus: "failed" },
      { extractionStatus: "processing" },
      { extractionStatus: null },
      { extractionData: null },
      { extractionData: { docType: "w2", summary: "", data: { wagesCents: null, federalWithheldCents: null } } },
    ]) {
      mockDb.document.findFirst.mockResolvedValue(docRow(over));
      const r = await confirmDocumentExtraction(input({ taxYear: 2024 }));
      expect(r.ok).toBe(false);
    }
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a stale expectedExtractedAt (a re-extract landed since the page loaded)", async () => {
    const r = await confirmDocumentExtraction(input({ wagesCents: 1 }, { expectedExtractedAt: "2026-10-01T00:00:00.000Z" }));
    expect(r).toEqual({ ok: false, error: STALE_READING_ERROR });
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("rejects when the stored extractedAt is null but the reviewer thought it was set (and the reverse)", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractedAt: null }));
    expect((await saveDocumentCorrections(input({ wagesCents: 1 }))).ok).toBe(false);
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
    // null === null is fine
    const ok = await saveDocumentCorrections(input({ wagesCents: 1 }, { expectedExtractedAt: null }));
    expect(ok).toEqual({ ok: true });
  });

  it("a race that lands between the read and the write is rejected by the write's own WHERE", async () => {
    mockDb.document.updateMany.mockResolvedValue({ count: 0 });
    const r = await confirmDocumentExtraction(input({ wagesCents: 1 }));
    expect(r).toEqual({ ok: false, error: STALE_READING_ERROR });
    expect(lastWrite().where).toEqual({
      id: DOC,
      archivedAt: null,
      extractionStatus: "complete",
      extractedAt: EXTRACTED_AT,
    });
  });

  it("rejects unknown keys, SSN-shaped text, bad cents and malformed input without writing", async () => {
    const bad: Record<string, unknown>[] = [
      { notAField: 1 },
      { ssn: "123-45-6789" },
      { employerName: "123-45-6789" },
      { employerEIN: "123456789" },
      { wagesCents: 12.5 },
      { wagesCents: "100" },
      { wagesCents: -1 },
    ];
    for (const fields of bad) {
      const r = await confirmDocumentExtraction(input(fields));
      expect(r.ok).toBe(false);
    }
    expect((await saveDocumentCorrections({ documentId: "nope", expectedExtractedAt: null, fields: {} })).ok).toBe(false);
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });
});

describe("saveDocumentCorrections", () => {
  it("writes ONLY the three verification columns, keeps the doc unverified, never touches extractionData", async () => {
    const r = await saveDocumentCorrections(input({ wagesCents: 5100000 }));
    expect(r).toEqual({ ok: true });
    const write = lastWrite();
    expect(Object.keys(write.data).sort()).toEqual([
      "extractionConfirmedAt",
      "extractionConfirmedById",
      "extractionCorrections",
    ]);
    expect(write.data.extractionConfirmedAt).toBeNull();
    expect(write.data.extractionConfirmedById).toBeNull();
    for (const forbidden of ["extractionData", "fileKey", "archivedAt", "extractionStatus", "extractedAt"]) {
      expect(write.data).not.toHaveProperty(forbidden);
    }
    // no hard delete anywhere
    expect(mockDb.document.delete).not.toHaveBeenCalled();
    expect(mockDb.document.update).not.toHaveBeenCalled();
  });

  it("stores the correction with the AI value, who and when, plus a corrected event", async () => {
    await saveDocumentCorrections(input({ wagesCents: 5100000, federalWithheldCents: null }));
    const overlay = lastWrite().data.extractionCorrections as {
      fields: Record<string, { value: unknown; aiValue: unknown; correctedById: string; correctedAt: string }>;
      events: { type: string; by: string }[];
    };
    expect(overlay.fields.wagesCents).toMatchObject({ value: 5100000, aiValue: 5000000, correctedById: USER });
    expect(overlay.fields.federalWithheldCents).toMatchObject({ value: null, aiValue: 800000 });
    expect(typeof overlay.fields.wagesCents?.correctedAt).toBe("string");
    expect(overlay.events).toEqual([expect.objectContaining({ type: "corrected", by: USER })]);
  });

  it("keeps aiValue from the FIRST correction when the same field is corrected again", async () => {
    const existing = {
      version: 1,
      fields: { wagesCents: { value: 5100000, aiValue: 4900000, correctedAt: "2026-10-01T00:00:00.000Z", correctedById: USER } },
      events: [{ type: "corrected", at: "2026-10-01T00:00:00.000Z", by: USER }],
    };
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionCorrections: existing }));
    await saveDocumentCorrections(input({ wagesCents: 5200000 }));
    const overlay = lastWrite().data.extractionCorrections as { fields: Record<string, { value: unknown; aiValue: unknown }>; events: unknown[] };
    expect(overlay.fields.wagesCents).toMatchObject({ value: 5200000, aiValue: 4900000 });
    expect(overlay.events).toHaveLength(2);
  });

  it("any edit un-verifies a verified document", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionConfirmedAt: new Date() }));
    await saveDocumentCorrections(input({ wagesCents: 1 }));
    expect(lastWrite().data.extractionConfirmedAt).toBeNull();
    expect(lastWrite().data.extractionConfirmedById).toBeNull();
  });

  it("a save with nothing changed is a no-op and does NOT drop an existing verification", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionConfirmedAt: new Date() }));
    const r = await saveDocumentCorrections(input({}));
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("a value equal to the AI value is not a correction", async () => {
    const r = await saveDocumentCorrections(input({ wagesCents: 5000000 }));
    expect(r).toEqual({ ok: true });
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("revalidates the document views after a write (from the action, never during render)", async () => {
    await saveDocumentCorrections(input({ wagesCents: 1 }));
    const paths = revalidateMock.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(expect.arrayContaining(["/documents", "/tax", "/tax/forms", `/documents/${DOC}/review`]));
  });

  it("a revalidation failure never turns a successful write into an error", async () => {
    revalidateMock.mockImplementation(() => {
      throw new Error("static generation store missing");
    });
    expect(await saveDocumentCorrections(input({ wagesCents: 1 }))).toEqual({ ok: true });
    revalidateMock.mockReset();
  });
});

describe("confirmDocumentExtraction", () => {
  it("marks the document verified by the acting user and logs corrected + confirmed events", async () => {
    const r = await confirmDocumentExtraction(input({ wagesCents: 5100000 }));
    expect(r).toEqual({ ok: true });
    const write = lastWrite();
    expect(write.data.extractionConfirmedAt).toBeInstanceOf(Date);
    expect(write.data.extractionConfirmedById).toBe(USER);
    const overlay = write.data.extractionCorrections as { events: { type: string }[] };
    expect(overlay.events.map((e) => e.type)).toEqual(["corrected", "confirmed"]);
    expect(write.data).not.toHaveProperty("extractionData");
  });

  it("confirming with no edits verifies the AI values as read (no corrected event)", async () => {
    const r = await confirmDocumentExtraction(input({}));
    expect(r).toEqual({ ok: true });
    const overlay = lastWrite().data.extractionCorrections as { fields: object; events: { type: string }[] };
    expect(overlay.fields).toEqual({});
    expect(overlay.events.map((e) => e.type)).toEqual(["confirmed"]);
    expect(lastWrite().data.extractionConfirmedAt).toBeInstanceOf(Date);
  });

  it("re-confirming an already-verified, unchanged document writes nothing", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionConfirmedAt: new Date() }));
    expect(await confirmDocumentExtraction(input({}))).toEqual({ ok: true });
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("an edit on a verified document re-verifies it only because Confirm was clicked", async () => {
    mockDb.document.findFirst.mockResolvedValue(docRow({ extractionConfirmedAt: new Date("2026-10-01T00:00:00Z") }));
    await confirmDocumentExtraction(input({ wagesCents: 1 }));
    expect(lastWrite().data.extractionConfirmedAt).toBeInstanceOf(Date);
  });

  it("the owner-entered property tax value can be saved and confirmed", async () => {
    mockDb.document.findFirst.mockResolvedValue(
      docRow({
        docType: "property_tax",
        extractionData: { docType: "property_tax", schemaVersion: 2, summary: "", data: { taxYear: 2025, totalTaxBilledCents: 600000, paidInTaxYearCents: null } },
      })
    );
    const r = await confirmDocumentExtraction(input({ paidInTaxYearCents: 300000 }));
    expect(r).toEqual({ ok: true });
    const overlay = lastWrite().data.extractionCorrections as { fields: Record<string, { value: unknown; aiValue: unknown }> };
    expect(overlay.fields.paidInTaxYearCents).toMatchObject({ value: 300000, aiValue: null });
  });
});

describe("unverifyDocumentExtraction", () => {
  it("clears the verification, keeps the corrections, logs an unverified event", async () => {
    const corrections = {
      version: 1,
      fields: { wagesCents: { value: 1, aiValue: 2, correctedAt: "x", correctedById: USER } },
      events: [],
    };
    mockDb.document.findFirst.mockResolvedValue({ id: DOC, extractionConfirmedAt: new Date(), extractionCorrections: corrections });
    const r = await unverifyDocumentExtraction(DOC);
    expect(r).toEqual({ ok: true });
    const write = lastWrite();
    expect(write.where).toMatchObject({ id: DOC, archivedAt: null });
    expect(write.data.extractionConfirmedAt).toBeNull();
    expect(write.data.extractionConfirmedById).toBeNull();
    const overlay = write.data.extractionCorrections as { fields: unknown; events: { type: string; by: string }[] };
    expect(overlay.fields).toEqual(corrections.fields);
    expect(overlay.events).toEqual([expect.objectContaining({ type: "unverified", by: USER })]);
    expect(write.data).not.toHaveProperty("extractionData");
  });

  it("errors cleanly for a missing, archived or not-verified document", async () => {
    mockDb.document.findFirst.mockResolvedValue(null);
    expect(await unverifyDocumentExtraction(DOC)).toEqual({ ok: false, error: "Document not found" });
    expect(mockDb.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DOC, archivedAt: null } })
    );
    mockDb.document.findFirst.mockResolvedValue({ id: DOC, extractionConfirmedAt: null, extractionCorrections: null });
    expect((await unverifyDocumentExtraction(DOC)).ok).toBe(false);
    expect((await unverifyDocumentExtraction("not-a-uuid")).ok).toBe(false);
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });
});

describe("source guards", () => {
  it("the verification actions never write extractionData, fileKey or archivedAt, and never delete", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/document-verification.ts"), "utf8");
    // Only `where` clauses may mention these; no `data:` block does.
    const dataBlocks = [...src.matchAll(/data:\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(dataBlocks.length).toBeGreaterThan(0);
    for (const block of dataBlocks) {
      expect(block).not.toMatch(/extractionData|fileKey|archivedAt/);
    }
    expect(src).not.toMatch(/\.delete\(|deleteMany/);
  });

  it("the review page does no writes and starts no extraction for tax documents", () => {
    const src = readFileSync(resolve(__dirname, "../../app/documents/[id]/review/page.tsx"), "utf8");
    expect(src).not.toMatch(/triggerExtraction|runDocumentExtraction/);
    expect(src).not.toMatch(/db\.document\.(update|create|delete)/);
  });
});
