import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Everything external is mocked (repo convention: no integrated DB tests, no real
// Anthropic call, no storage download).
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockDb = vi.hoisted(() => ({
  entity: { findFirst: vi.fn() },
  document: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  donation: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
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
  classifyDocType: vi.fn(() => "donation_receipt"),
}));
vi.mock("@/lib/doc-extract", () => extractMock);

vi.mock("@/lib/statement-ledger", () => ({ loadLedgerIndexes: vi.fn() }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));

import { createDonation, updateDonation } from "@/actions/donations";
import { changeDocumentType, runDocumentExtraction } from "@/actions/documents";
import { VERIFIED_RETYPE_ERROR } from "@/lib/document-retype";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const RECEIPT = "44444444-4444-4444-8444-444444444444";
const ROW = "55555555-5555-4555-8555-555555555555";
const OTHER_ROW = "66666666-6666-4666-8666-666666666666";
const DOC = "c0000000-0000-4000-8000-000000000001";

const input = {
  date: "2025-06-15",
  recipient: "Connecticut Food Bank",
  amount: "250.00",
  kind: "cash" as const,
  substantiation: "written_acknowledgment" as const,
  receiptDocumentId: RECEIPT,
  notes: "private note",
};

const savedRow = {
  id: ROW,
  entityId: PERSONAL,
  date: new Date("2025-06-15T12:00:00Z"),
  recipient: "Connecticut Food Bank",
  amountCents: 25000,
  kind: "cash",
  substantiation: "written_acknowledgment",
  receiptDocumentId: RECEIPT,
  notes: "private note",
};
const otherGift = {
  id: OTHER_ROW,
  date: new Date("2025-03-01T12:00:00Z"),
  recipient: "Connecticut Food Bank",
  amountCents: 10000,
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.entity.findFirst.mockResolvedValue({ id: PERSONAL });
  mockDb.document.findFirst.mockResolvedValue({ id: RECEIPT });
  mockDb.donation.findMany.mockResolvedValue([]);
  mockDb.donation.create.mockResolvedValue(savedRow);
  mockDb.donation.findFirst.mockResolvedValue({ ...savedRow, receiptDocumentId: null });
  mockDb.donation.update.mockResolvedValue(savedRow);
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("createDonation - auth and the double-link guard", () => {
  it("rejects an unauthenticated caller before any db call", async () => {
    authMock.mockResolvedValue(null);
    await expect(createDonation(input)).rejects.toThrow("Unauthorized");
    expect(mockDb.entity.findFirst).not.toHaveBeenCalled();
    expect(mockDb.donation.findMany).not.toHaveBeenCalled();
    expect(mockDb.donation.create).not.toHaveBeenCalled();
  });

  it("a receipt already linked to a non-archived gift is refused with conflicts and NO create", async () => {
    mockDb.donation.findMany.mockResolvedValueOnce([otherGift]);
    const res = await createDonation(input);
    expect(res).toMatchObject({ ok: false, code: "receipt_already_linked" });
    if (!res.ok) {
      expect(res.conflicts).toEqual([
        { id: OTHER_ROW, dateIso: "2025-03-01", recipient: "Connecticut Food Bank", amountCents: 10000 },
      ]);
      expect(res.error).toMatch(/already attached/);
    }
    expect(mockDb.donation.create).not.toHaveBeenCalled();
  });

  it("the guard query only counts non-archived gifts linked to that receipt", async () => {
    await createDonation(input);
    expect(mockDb.donation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { receiptDocumentId: RECEIPT, archivedAt: null } })
    );
  });

  it("with confirmSharedReceipt the shared receipt is allowed and the gift is created", async () => {
    mockDb.donation.findMany.mockResolvedValueOnce([otherGift]).mockResolvedValueOnce([]);
    const res = await createDonation({ ...input, confirmSharedReceipt: true });
    expect(res).toEqual({ ok: true, id: ROW });
    expect(mockDb.donation.create).toHaveBeenCalledTimes(1);
  });

  it("an unlinked receipt (or no receipt) needs no confirmation", async () => {
    expect(await createDonation(input)).toEqual({ ok: true, id: ROW });
    expect(await createDonation({ ...input, receiptDocumentId: null })).toEqual({ ok: true, id: ROW });
  });

  it("a receipt not found under Personal keeps the existing error and creates nothing", async () => {
    mockDb.document.findFirst.mockResolvedValue(null);
    const res = await createDonation(input);
    expect(res).toEqual({ ok: false, error: "That receipt document was not found under Personal." });
    expect(mockDb.donation.create).not.toHaveBeenCalled();
  });
});

describe("createDonation - the duplicate guard (warn, never a silent block)", () => {
  const sameGift = {
    id: OTHER_ROW,
    date: new Date("2025-06-15T12:00:00Z"),
    recipient: "connecticut food bank, inc.",
    amountCents: 25000,
  };

  it("same date + amount + charity is refused with code duplicate and no create", async () => {
    mockDb.donation.findMany.mockResolvedValue([sameGift]);
    const res = await createDonation({ ...input, receiptDocumentId: null });
    expect(res).toMatchObject({ ok: false, code: "duplicate" });
    if (!res.ok) {
      expect(res.error).toMatch(/already logged/);
      expect(res.error).toContain("$250.00");
      expect(res.conflicts?.[0]).toMatchObject({ id: OTHER_ROW, dateIso: "2025-06-15", amountCents: 25000 });
    }
    expect(mockDb.donation.create).not.toHaveBeenCalled();
  });

  it("the same-day lookup is Personal-only, non-archived and exact on the stored noon-UTC date", async () => {
    await createDonation({ ...input, receiptDocumentId: null });
    const arg = mockDb.donation.findMany.mock.calls[0]![0];
    expect(arg.where).toEqual({
      entityId: PERSONAL,
      archivedAt: null,
      date: new Date("2025-06-15T12:00:00Z"),
    });
  });

  it("with acknowledgeDuplicate the gift is created", async () => {
    mockDb.donation.findMany.mockResolvedValue([sameGift]);
    const res = await createDonation({ ...input, receiptDocumentId: null, acknowledgeDuplicate: true });
    expect(res).toEqual({ ok: true, id: ROW });
    expect(mockDb.donation.create).toHaveBeenCalledTimes(1);
  });

  it("a different amount or charity on the same day is not a duplicate", async () => {
    mockDb.donation.findMany.mockResolvedValue([
      { ...sameGift, amountCents: 5000 },
      { ...sameGift, recipient: "Red Cross" },
    ]);
    expect(await createDonation({ ...input, receiptDocumentId: null })).toEqual({ ok: true, id: ROW });
  });

  it("the confirmation flags are not persisted and not audited; the audit row gains only the receipt id", async () => {
    mockDb.donation.findMany.mockResolvedValueOnce([otherGift]).mockResolvedValueOnce([sameGift]);
    await createDonation({ ...input, confirmSharedReceipt: true, acknowledgeDuplicate: true });
    const data = mockDb.donation.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("confirmSharedReceipt");
    expect(data).not.toHaveProperty("acknowledgeDuplicate");
    expect(data.receiptDocumentId).toBe(RECEIPT);
    const audit = mockDb.auditLog.create.mock.calls[0]![0].data as { after: Record<string, unknown> };
    expect(audit.after.receiptDocumentId).toBe(RECEIPT);
    const text = JSON.stringify(audit);
    expect(text).not.toContain("private note");
    expect(text).not.toContain("Connecticut Food Bank");
    expect(text).not.toContain("confirmSharedReceipt");
  });
});

describe("updateDonation - double-link guard only for a NEWLY attached receipt", () => {
  it("re-saving an unchanged linked gift is never blocked (and does not even query)", async () => {
    mockDb.donation.findFirst.mockResolvedValue({ ...savedRow, receiptDocumentId: RECEIPT });
    mockDb.donation.findMany.mockResolvedValue([{ ...otherGift, id: ROW }, otherGift]);
    const res = await updateDonation(ROW, input);
    expect(res).toEqual({ ok: true, id: ROW });
    expect(mockDb.donation.findMany).not.toHaveBeenCalled();
  });

  it("newly linking a receipt that is attached to another gift is refused without confirmation", async () => {
    mockDb.donation.findMany.mockResolvedValue([otherGift]);
    const res = await updateDonation(ROW, input);
    expect(res).toMatchObject({ ok: false, code: "receipt_already_linked" });
    expect(mockDb.donation.update).not.toHaveBeenCalled();
  });

  it("with confirmSharedReceipt the new link is allowed", async () => {
    mockDb.donation.findMany.mockResolvedValue([otherGift]);
    expect(await updateDonation(ROW, { ...input, confirmSharedReceipt: true })).toEqual({ ok: true, id: ROW });
  });

  it("the donation's own id is excluded from the linked set", async () => {
    mockDb.donation.findMany.mockResolvedValue([{ ...otherGift, id: ROW }]);
    expect(await updateDonation(ROW, input)).toEqual({ ok: true, id: ROW });
  });

  it("clearing the receipt (null) never runs the guard", async () => {
    mockDb.donation.findFirst.mockResolvedValue({ ...savedRow, receiptDocumentId: RECEIPT });
    await updateDonation(ROW, { ...input, receiptDocumentId: null });
    expect(mockDb.donation.findMany).not.toHaveBeenCalled();
  });

  it("applies no duplicate guard on update", async () => {
    mockDb.donation.findFirst.mockResolvedValue({ ...savedRow, receiptDocumentId: null });
    mockDb.donation.findMany.mockResolvedValue([]);
    await updateDonation(ROW, { ...input, receiptDocumentId: null });
    expect(mockDb.donation.findMany).not.toHaveBeenCalled();
  });
});

describe("changeDocumentType", () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    docType: "other",
    extractionConfirmedAt: null,
    documentName: "Document",
    taxYear: null,
    ...over,
  });

  beforeEach(() => {
    mockDb.document.findFirst.mockResolvedValue(doc());
    mockDb.document.updateMany.mockResolvedValue({ count: 1 });
  });

  it("requireAuth() is the first statement and the unauthenticated call touches nothing", async () => {
    const src = readFileSync(resolve(__dirname, "../../actions/documents.ts"), "utf8").replace(/\r\n/g, "\n");
    const start = src.indexOf("export async function changeDocumentType");
    const body = src.slice(src.indexOf("{\n", src.indexOf("Promise<", start)) + 2);
    expect(body.trimStart().startsWith("await requireAuth();")).toBe(true);

    authMock.mockResolvedValue(null);
    await expect(changeDocumentType({ documentId: DOC, docType: "donation_receipt" })).rejects.toThrow("Unauthorized");
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("validates input", async () => {
    expect((await changeDocumentType({ documentId: "nope", docType: "donation_receipt" })).ok).toBe(false);
    expect((await changeDocumentType({ documentId: DOC, docType: "bank_statement" })).ok).toBe(false);
    expect((await changeDocumentType({ documentId: DOC, docType: "nonsense" })).ok).toBe(false);
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
  });

  it("a missing or archived document is an error (read is guarded by archivedAt: null)", async () => {
    mockDb.document.findFirst.mockResolvedValue(null);
    const res = await changeDocumentType({ documentId: DOC, docType: "donation_receipt" });
    expect(res).toEqual({ ok: false, error: "Document not found" });
    expect(mockDb.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DOC, archivedAt: null } })
    );
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("a verified document is refused with the exact un-verify message and nothing is written", async () => {
    mockDb.document.findFirst.mockResolvedValue(doc({ docType: "w2", extractionConfirmedAt: new Date() }));
    const res = await changeDocumentType({ documentId: DOC, docType: "donation_receipt" });
    expect(res).toEqual({ ok: false, error: VERIFIED_RETYPE_ERROR });
    expect(VERIFIED_RETYPE_ERROR).toBe("This document is verified. Un-verify it before changing its type.");
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it.each(["bank_statement", "utility_bill", "insurance_policy", "mortgage_statement", "statement", "policy"])(
    "refuses to retype a %s document",
    async (docType) => {
      mockDb.document.findFirst.mockResolvedValue(doc({ docType }));
      const res = await changeDocumentType({ documentId: DOC, docType: "donation_receipt" });
      expect(res.ok).toBe(false);
      expect(mockDb.document.updateMany).not.toHaveBeenCalled();
    }
  );

  it("the same type is a no-op", async () => {
    mockDb.document.findFirst.mockResolvedValue(doc({ docType: "donation_receipt" }));
    expect(await changeDocumentType({ documentId: DOC, docType: "donation_receipt" })).toEqual({
      ok: true,
      changed: false,
      extract: false,
    });
    expect(mockDb.document.updateMany).not.toHaveBeenCalled();
  });

  it("other -> donation_receipt: guarded write, extract is true, placeholder name refreshed", async () => {
    const res = await changeDocumentType({ documentId: DOC, docType: "donation_receipt" });
    expect(res).toEqual({ ok: true, changed: true, extract: true });
    const arg = mockDb.document.updateMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: DOC, archivedAt: null, docType: "other", extractionConfirmedAt: null });
    expect(arg.data).toEqual({ docType: "donation_receipt", documentName: "Donation Receipt" });
  });

  it("a name the owner typed is preserved", async () => {
    mockDb.document.findFirst.mockResolvedValue(doc({ documentName: "Church letter from Pastor Dan" }));
    await changeDocumentType({ documentId: DOC, docType: "donation_receipt" });
    expect(mockDb.document.updateMany.mock.calls[0]![0].data).toEqual({ docType: "donation_receipt" });
  });

  it("a null name counts as a placeholder; the year is kept in the generated name", async () => {
    mockDb.document.findFirst.mockResolvedValue(doc({ documentName: null, taxYear: 2025 }));
    await changeDocumentType({ documentId: DOC, docType: "donation_receipt" });
    expect(mockDb.document.updateMany.mock.calls[0]![0].data).toEqual({
      docType: "donation_receipt",
      documentName: "Donation Receipt (2025)",
    });
  });

  it("a verification landing between the read and the write is caught (count 0)", async () => {
    mockDb.document.updateMany.mockResolvedValue({ count: 0 });
    const res = await changeDocumentType({ documentId: DOC, docType: "donation_receipt" });
    expect(res).toEqual({ ok: false, error: "The document changed while you were editing - reload and try again." });
  });

  it.each(["other", "extension"])("a non-extractable target (%s) reports extract: false", async (target) => {
    mockDb.document.findFirst.mockResolvedValue(doc({ docType: "donation_receipt", documentName: "x" }));
    expect(await changeDocumentType({ documentId: DOC, docType: target })).toEqual({
      ok: true,
      changed: true,
      extract: false,
    });
  });

  it("never calls storage or the AI itself (the client runs the forced extraction next)", async () => {
    await changeDocumentType({ documentId: DOC, docType: "donation_receipt" });
    expect(storage.downloadDocumentFile).not.toHaveBeenCalled();
    expect(extractMock.extractDocumentOrThrow).not.toHaveBeenCalled();
  });
});

describe("runDocumentExtraction on a donation_receipt (mocked AI)", () => {
  const AI = {
    docType: "donation_receipt",
    schemaVersion: 2,
    summary: "Receipt",
    data: {
      organizationName: "Food Bank",
      organizationEIN: null,
      giftDate: "2025-06-15",
      cashAmountCents: 25000,
      nonCashDescription: null,
      coversMultipleGifts: false,
      readsAsWrittenAcknowledgment: true,
      noGoodsOrServicesStated: true,
      benefitStatement: null,
    },
  };
  const row = (over: Record<string, unknown> = {}) => ({
    id: DOC,
    docType: "donation_receipt",
    fileKey: "documents/e/d.png",
    documentName: "Donation Receipt",
    taxYear: null,
    extractionStatus: null,
    extractionData: null,
    extractionConfirmedAt: null,
    extractionConfirmedById: null,
    extractionCorrections: null,
    extractionError: null,
    updatedAt: new Date(),
    archivedAt: null,
    bankStatement: null,
    ...over,
  });

  beforeEach(() => {
    mockDb.document.findFirst.mockResolvedValue(row());
    mockDb.document.updateMany.mockResolvedValue({ count: 1 });
    mockDb.document.update.mockResolvedValue({});
    storage.downloadDocumentFile.mockResolvedValue(Buffer.from("png"));
    extractMock.extractDocumentOrThrow.mockResolvedValue(AI);
  });

  it("sends the stored file's real media type (png -> image/png), fills a null year from the gift date, refreshes a placeholder name", async () => {
    const res = await runDocumentExtraction(DOC, { force: true });
    expect(res).toEqual({ ok: true });
    expect(extractMock.extractDocumentOrThrow).toHaveBeenCalledWith(expect.anything(), "image/png", "donation_receipt");

    const yearFill = mockDb.document.updateMany.mock.calls.find((c) => "taxYear" in c[0].data);
    expect(yearFill![0]).toEqual({ where: { id: DOC, archivedAt: null, taxYear: null }, data: { taxYear: 2025 } });

    const nameRefresh = mockDb.document.updateMany.mock.calls.find((c) => "documentName" in c[0].data);
    expect(nameRefresh![0]).toEqual({
      where: { id: DOC, archivedAt: null, documentName: "Donation Receipt" },
      data: { documentName: "Donation Receipt — Food Bank (2025)" },
    });
  });

  it("an owner-typed name is never refreshed, and an existing year is never overwritten", async () => {
    mockDb.document.findFirst.mockResolvedValue(row({ documentName: "Church letter", taxYear: 2024 }));
    await runDocumentExtraction(DOC, { force: true });
    expect(mockDb.document.updateMany.mock.calls.some((c) => "documentName" in c[0].data)).toBe(false);
    expect(mockDb.document.updateMany.mock.calls.some((c) => "taxYear" in c[0].data)).toBe(false);
  });

  it("a failing name refresh never turns a good extraction into a failure", async () => {
    mockDb.document.updateMany.mockImplementation(async (arg: { data: Record<string, unknown> }) => {
      if ("documentName" in arg.data) throw new Error("db hiccup");
      return { count: 1 };
    });
    const res = await runDocumentExtraction(DOC, { force: true });
    expect(res).toEqual({ ok: true });
    const writes = mockDb.document.update.mock.calls.map((c) => c[0].data.extractionStatus);
    expect(writes).toContain("complete");
    expect(writes).not.toContain("failed");
  });

  it("an all-null reading is a failure, never saved as complete", async () => {
    extractMock.extractDocumentOrThrow.mockResolvedValue({
      docType: "donation_receipt",
      schemaVersion: 2,
      summary: "x",
      data: { organizationName: null, giftDate: null, cashAmountCents: null, nonCashDescription: null },
    });
    const res = await runDocumentExtraction(DOC, { force: true });
    expect(res).toEqual({ ok: false, error: "The AI read no usable values from this document" });
    const statuses = mockDb.document.update.mock.calls.map((c) => c[0].data.extractionStatus);
    expect(statuses).toContain("failed");
    expect(statuses).not.toContain("complete");
  });

  it("a retyped document keeps its verification protection: a verified one cannot be force-re-read without discarding", async () => {
    mockDb.document.findFirst.mockResolvedValue(
      row({ extractionStatus: "complete", extractionData: AI, extractionConfirmedAt: new Date() })
    );
    const res = await runDocumentExtraction(DOC, { force: true });
    expect(res.ok).toBe(false);
    expect(extractMock.extractDocumentOrThrow).not.toHaveBeenCalled();
  });
});

describe("source checks", () => {
  it("no `any` and no hard delete in the touched donation/receipt files", () => {
    for (const file of [
      "actions/donations.ts",
      "lib/donation-receipt.ts",
      "lib/donation-receipts-build.ts",
      "lib/document-retype.ts",
      "components/donations/receipt-to-donation.tsx",
      "components/donations/unlinked-receipts.tsx",
      "components/documents/document-type-cell.tsx",
    ]) {
      const src = readFileSync(resolve(__dirname, "../../", file), "utf8");
      expect(src, file).not.toMatch(/:\s*any\b|as any\b/);
      expect(src, file).not.toMatch(/\.delete\(|\.deleteMany\(/);
    }
    const docs = readFileSync(resolve(__dirname, "../../actions/documents.ts"), "utf8");
    expect(docs).not.toMatch(/db\.document\.delete/);
  });

  it("no code path creates a donation from an extraction: createDonation is called only from the donation form", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".next", ".git", ".claude", "__tests__"].includes(entry.name)) continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && /createDonation\(/.test(readFileSync(full, "utf8"))) {
          callers.push(full.replace(/\\/g, "/").split("/kinniburgh-finance/")[1] ?? full);
        }
      }
    };
    for (const dir of ["actions", "app", "components", "lib"]) walk(resolve(__dirname, "../../", dir));
    // The action itself plus the donation form, whose submit button is the owner's explicit click.
    expect(callers.sort()).toEqual(["actions/donations.ts", "components/donations/donation-form.tsx"]);
    expect(callers).not.toContain("actions/documents.ts");
    expect(callers.some((c) => c.startsWith("lib/"))).toBe(false);
  });
});
