import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const mockDb = vi.hoisted(() => ({
  document: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const storage = vi.hoisted(() => ({
  getDocumentFileSignedUrl: vi.fn(),
  downloadDocumentFile: vi.fn(),
  getSignedUploadUrl: vi.fn(),
  downloadTaxFile: vi.fn(),
  getTaxSignedUploadUrl: vi.fn(),
}));
vi.mock("@/lib/supabase-storage", () => storage);

const extractMock = vi.hoisted(() => ({
  extractDocument: vi.fn(),
  extractDocumentOrThrow: vi.fn(),
  classifyDocType: vi.fn(() => "w2"),
}));
vi.mock("@/lib/doc-extract", () => extractMock);

// Not exercised here, but imported (transitively) by the action modules.
vi.mock("@/lib/statement-ledger", () => ({ loadLedgerIndexes: vi.fn() }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));

import {
  updateDocumentAttribution,
  finalizeDocumentUpload,
} from "@/actions/documents";
import { finalizeTaxDocumentUpload } from "@/actions/tax-planning";
import { buildDocumentFileKey } from "@/lib/document-upload";
import { buildTaxDocumentFileKey } from "@/lib/tax-document-upload";

const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const DOC = "c0000000-0000-4000-8000-000000000001";
const ENTITY = "e0000000-0000-4000-8000-000000000003";
const ERIC = "a0000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: SESSION_USER } });
  mockDb.document.findFirst.mockResolvedValue({ id: DOC });
  mockDb.document.update.mockResolvedValue({});
  mockDb.document.create.mockResolvedValue({});
  mockDb.user.findUnique.mockResolvedValue({ id: ERIC });
});

describe("updateDocumentAttribution", () => {
  it("rejects without a session before any DB call", async () => {
    authMock.mockResolvedValue(null);
    await expect(
      updateDocumentAttribution({ documentId: DOC, subjectType: "joint", subjectUserId: null, issuerName: "X" })
    ).rejects.toThrow("Unauthorized");
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(mockDb.document.update).not.toHaveBeenCalled();
  });

  it("returns an error for a non-uuid document id without DB access", async () => {
    const r = await updateDocumentAttribution({ documentId: "nope", subjectType: null, subjectUserId: null, issuerName: null });
    expect(r).toHaveProperty("error");
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
  });

  it("returns an error for invalid attribution without DB access", async () => {
    const r = await updateDocumentAttribution({ documentId: DOC, subjectType: "person", subjectUserId: null, issuerName: null });
    expect(r).toHaveProperty("error");
    expect(mockDb.document.findFirst).not.toHaveBeenCalled();
    expect(mockDb.document.update).not.toHaveBeenCalled();
  });

  it("only operates on non-archived documents and errors when missing", async () => {
    mockDb.document.findFirst.mockResolvedValue(null);
    const r = await updateDocumentAttribution({ documentId: DOC, subjectType: "joint", subjectUserId: null, issuerName: null });
    expect(r).toEqual({ error: "Document not found" });
    expect(mockDb.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DOC, archivedAt: null } })
    );
    expect(mockDb.document.update).not.toHaveBeenCalled();
  });

  it("errors on an unknown user for a person subject", async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    const r = await updateDocumentAttribution({ documentId: DOC, subjectType: "person", subjectUserId: ERIC, issuerName: null });
    expect(r).toHaveProperty("error");
    expect(mockDb.document.update).not.toHaveBeenCalled();
  });

  it("does not look up a user for joint/unassigned", async () => {
    await updateDocumentAttribution({ documentId: DOC, subjectType: "joint", subjectUserId: null, issuerName: null });
    await updateDocumentAttribution({ documentId: DOC, subjectType: null, subjectUserId: null, issuerName: null });
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });

  it("writes only the three columns and revalidates both paths", async () => {
    const r = await updateDocumentAttribution({
      documentId: DOC,
      subjectType: "person",
      subjectUserId: ERIC,
      issuerName: "  Alpine Bio ",
    });
    expect(r).toEqual({ success: true });
    expect(mockDb.document.update).toHaveBeenCalledTimes(1);
    expect(mockDb.document.update).toHaveBeenCalledWith({
      where: { id: DOC },
      data: { subjectType: "person", subjectUserId: ERIC, issuerName: "Alpine Bio" },
    });
    expect(revalidateMock).toHaveBeenCalledWith("/documents");
    expect(revalidateMock).toHaveBeenCalledWith("/tax");
  });

  it("can clear attribution (full replacement with nulls)", async () => {
    await updateDocumentAttribution({ documentId: DOC, subjectType: null, subjectUserId: null, issuerName: "" });
    expect(mockDb.document.update).toHaveBeenCalledWith({
      where: { id: DOC },
      data: { subjectType: null, subjectUserId: null, issuerName: null },
    });
  });
});

describe("finalizeDocumentUpload (vault) attribution", () => {
  const DOC_ID = "d0000000-0000-4000-8000-000000000009";
  const fileKey = buildDocumentFileKey(ENTITY, DOC_ID, "application/pdf") as string;
  const base = { documentId: DOC_ID, fileKey, entityId: ENTITY, fileType: "application/pdf", docType: "other" as const };

  beforeEach(() => {
    storage.downloadDocumentFile.mockResolvedValue(Buffer.from("x"));
  });

  it("passes attribution into document.create", async () => {
    const r = await finalizeDocumentUpload({ ...base, subjectType: "person", subjectUserId: ERIC, issuerName: "Alpine Bio" });
    expect(r).toEqual({ ok: true, documentId: DOC_ID });
    expect(mockDb.document.create.mock.calls[0]![0].data).toMatchObject({
      subjectType: "person",
      subjectUserId: ERIC,
      issuerName: "Alpine Bio",
    });
  });

  it("still succeeds without attribution (all null)", async () => {
    const r = await finalizeDocumentUpload(base);
    expect(r.ok).toBe(true);
    expect(mockDb.document.create.mock.calls[0]![0].data).toMatchObject({
      subjectType: null,
      subjectUserId: null,
      issuerName: null,
    });
  });

  it("rejects invalid attribution before any storage or DB write", async () => {
    const r = await finalizeDocumentUpload({ ...base, subjectType: "person", subjectUserId: null });
    expect(r.ok).toBe(false);
    expect(storage.downloadDocumentFile).not.toHaveBeenCalled();
    expect(mockDb.document.create).not.toHaveBeenCalled();
  });

  it("rejects a well-formed but non-existent person before any storage or DB write", async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    const r = await finalizeDocumentUpload({ ...base, subjectType: "person", subjectUserId: ERIC });
    expect(r).toEqual({ ok: false, error: "That person was not found" });
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({ where: { id: ERIC }, select: { id: true } });
    expect(storage.downloadDocumentFile).not.toHaveBeenCalled();
    expect(mockDb.document.create).not.toHaveBeenCalled();
  });

  it("does not look up a user for joint/unassigned", async () => {
    await finalizeDocumentUpload({ ...base, subjectType: "joint", subjectUserId: null });
    await finalizeDocumentUpload(base);
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("finalizeTaxDocumentUpload attribution", () => {
  const DOC_ID = "d0000000-0000-4000-8000-000000000008";
  const fileKey = buildTaxDocumentFileKey(ENTITY, DOC_ID, "application/pdf") as string;
  const base = {
    documentId: DOC_ID,
    fileKey,
    entityId: ENTITY,
    fileType: "application/pdf",
    taxYear: 2025,
    // docType "other" is non-extractable: no extraction call needed.
    docType: "other" as const,
  };

  beforeEach(() => {
    storage.downloadTaxFile.mockResolvedValue(Buffer.from("x"));
  });

  it("passes attribution into document.create", async () => {
    const r = await finalizeTaxDocumentUpload({ ...base, subjectType: "joint", subjectUserId: null, issuerName: "Pennymac" });
    expect(r.ok).toBe(true);
    expect(mockDb.document.create.mock.calls[0]![0].data).toMatchObject({
      subjectType: "joint",
      subjectUserId: null,
      issuerName: "Pennymac",
    });
  });

  it("still succeeds without attribution (all null)", async () => {
    const r = await finalizeTaxDocumentUpload(base);
    expect(r.ok).toBe(true);
    expect(mockDb.document.create.mock.calls[0]![0].data).toMatchObject({
      subjectType: null,
      subjectUserId: null,
      issuerName: null,
    });
  });

  it("rejects invalid attribution before any storage or DB write", async () => {
    const r = await finalizeTaxDocumentUpload({ ...base, subjectType: "bogus" });
    expect(r.ok).toBe(false);
    expect(storage.downloadTaxFile).not.toHaveBeenCalled();
    expect(mockDb.document.create).not.toHaveBeenCalled();
  });

  it("rejects a well-formed but non-existent person before any storage or DB write", async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    const r = await finalizeTaxDocumentUpload({ ...base, subjectType: "person", subjectUserId: ERIC });
    expect(r).toEqual({ ok: false, error: "That person was not found" });
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({ where: { id: ERIC }, select: { id: true } });
    expect(storage.downloadTaxFile).not.toHaveBeenCalled();
    expect(mockDb.document.create).not.toHaveBeenCalled();
  });

  it("does not look up a user for joint/unassigned", async () => {
    await finalizeTaxDocumentUpload({ ...base, subjectType: "joint", subjectUserId: null });
    await finalizeTaxDocumentUpload(base);
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });
});
