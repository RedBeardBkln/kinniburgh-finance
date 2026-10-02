import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const mockDb = vi.hoisted(() => ({
  taxWorkspace: { findUnique: vi.fn() },
  document: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const runnerMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/statement-archive-runner", () => ({ archiveDocumentWithStatement: runnerMock }));

import { archiveWorkspaceStatement } from "@/actions/statement-archive";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "b0000000-0000-4000-8000-000000000001";
const DOC = "c0000000-0000-4000-8000-000000000001";
const EKC = "e0000000-0000-4000-8000-000000000003";
const SV = "e0000000-0000-4000-8000-000000000002";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.taxWorkspace.findUnique.mockResolvedValue({ entityId: EKC });
  mockDb.document.findUnique.mockResolvedValue({
    entityId: EKC,
    docType: "bank_statement",
    archivedAt: null,
  });
  runnerMock.mockResolvedValue({ documentArchived: true, statementsArchived: 1 });
});

describe("archiveWorkspaceStatement", () => {
  it("rejects without a session and touches no DB or runner", async () => {
    authMock.mockResolvedValue(null);
    await expect(archiveWorkspaceStatement({ workspaceId: WS, documentId: DOC })).rejects.toThrow(
      "Unauthorized",
    );
    expect(mockDb.taxWorkspace.findUnique).not.toHaveBeenCalled();
    expect(mockDb.document.findUnique).not.toHaveBeenCalled();
    expect(runnerMock).not.toHaveBeenCalled();
  });

  it("returns an error for non-UUID ids without any DB access", async () => {
    const r = await archiveWorkspaceStatement({ workspaceId: "nope", documentId: DOC });
    expect(r).toHaveProperty("error");
    const r2 = await archiveWorkspaceStatement({ workspaceId: WS, documentId: "nope" });
    expect(r2).toHaveProperty("error");
    expect(mockDb.taxWorkspace.findUnique).not.toHaveBeenCalled();
    expect(runnerMock).not.toHaveBeenCalled();
  });

  it("returns an error for an unknown workspace", async () => {
    mockDb.taxWorkspace.findUnique.mockResolvedValue(null);
    expect(await archiveWorkspaceStatement({ workspaceId: WS, documentId: DOC })).toEqual({
      error: "Workspace not found",
    });
    expect(runnerMock).not.toHaveBeenCalled();
  });

  it("returns an error for an unknown document", async () => {
    mockDb.document.findUnique.mockResolvedValue(null);
    expect(await archiveWorkspaceStatement({ workspaceId: WS, documentId: DOC })).toEqual({
      error: "Document not found",
    });
    expect(runnerMock).not.toHaveBeenCalled();
  });

  it("rejects an already-archived document", async () => {
    mockDb.document.findUnique.mockResolvedValue({
      entityId: EKC,
      docType: "bank_statement",
      archivedAt: new Date(),
    });
    const r = await archiveWorkspaceStatement({ workspaceId: WS, documentId: DOC });
    expect(r).toEqual({ error: "Statement is already archived" });
    expect(runnerMock).not.toHaveBeenCalled();
  });

  it("rejects a document belonging to a different entity than the workspace", async () => {
    mockDb.document.findUnique.mockResolvedValue({
      entityId: SV,
      docType: "bank_statement",
      archivedAt: null,
    });
    const r = await archiveWorkspaceStatement({ workspaceId: WS, documentId: DOC });
    expect(r).toHaveProperty("error");
    expect(runnerMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("rejects a non-bank_statement document server-side", async () => {
    mockDb.document.findUnique.mockResolvedValue({
      entityId: EKC,
      docType: "w2",
      archivedAt: null,
    });
    const r = await archiveWorkspaceStatement({ workspaceId: WS, documentId: DOC });
    expect(r).toEqual({ error: "Only bank statements can be archived here" });
    expect(runnerMock).not.toHaveBeenCalled();
  });

  it("archives via the runner scoped to the workspace entity and revalidates", async () => {
    const r = await archiveWorkspaceStatement({ workspaceId: WS, documentId: DOC });
    expect(r).toEqual({ success: true });
    expect(runnerMock).toHaveBeenCalledWith(DOC, { entityId: EKC });
    expect(revalidateMock).toHaveBeenCalledWith("/tax");
    expect(revalidateMock).toHaveBeenCalledWith("/documents");
    expect(revalidateMock).toHaveBeenCalledWith("/business");
  });

  it("returns an error when a concurrent archive wins the race", async () => {
    runnerMock.mockResolvedValue({ documentArchived: false, statementsArchived: 0 });
    const r = await archiveWorkspaceStatement({ workspaceId: WS, documentId: DOC });
    expect(r).toEqual({ error: "Statement is already archived" });
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});
