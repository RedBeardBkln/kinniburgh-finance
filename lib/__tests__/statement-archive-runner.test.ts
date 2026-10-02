import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => {
  const tx = {
    document: { updateMany: vi.fn() },
    bankStatement: { updateMany: vi.fn() },
  };
  return {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    _tx: tx,
  };
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { archiveDocumentWithStatement } from "@/lib/statement-archive-runner";

const DOC = "doc-1";
const tx = mockDb._tx;

beforeEach(() => {
  vi.clearAllMocks();
  tx.document.updateMany.mockResolvedValue({ count: 1 });
  tx.bankStatement.updateMany.mockResolvedValue({ count: 1 });
});

describe("archiveDocumentWithStatement", () => {
  it("runs inside a single transaction", async () => {
    await archiveDocumentWithStatement(DOC);
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });

  it("archives the Document and its BankStatement with the same Date", async () => {
    const r = await archiveDocumentWithStatement(DOC);
    expect(r).toEqual({ documentArchived: true, statementsArchived: 1 });

    const docArg = tx.document.updateMany.mock.calls[0]![0];
    const stmtArg = tx.bankStatement.updateMany.mock.calls[0]![0];
    expect(docArg.data.archivedAt).toBeInstanceOf(Date);
    expect(stmtArg.data.archivedAt).toBe(docArg.data.archivedAt);
  });

  it("guards both updates with archivedAt: null and targets the right ids", async () => {
    await archiveDocumentWithStatement(DOC);
    expect(tx.document.updateMany.mock.calls[0]![0].where).toEqual({ id: DOC, archivedAt: null });
    expect(tx.bankStatement.updateMany.mock.calls[0]![0].where).toEqual({
      documentId: DOC,
      archivedAt: null,
    });
  });

  it("scopes the Document update by entityId when supplied", async () => {
    await archiveDocumentWithStatement(DOC, { entityId: "ent-1" });
    expect(tx.document.updateMany.mock.calls[0]![0].where).toEqual({
      id: DOC,
      archivedAt: null,
      entityId: "ent-1",
    });
  });

  it("skips the BankStatement update when the Document update matches nothing (lost race)", async () => {
    tx.document.updateMany.mockResolvedValue({ count: 0 });
    const r = await archiveDocumentWithStatement(DOC);
    expect(r).toEqual({ documentArchived: false, statementsArchived: 0 });
    expect(tx.bankStatement.updateMany).not.toHaveBeenCalled();
  });

  it("still reports documentArchived when no BankStatement is linked", async () => {
    tx.bankStatement.updateMany.mockResolvedValue({ count: 0 });
    const r = await archiveDocumentWithStatement(DOC);
    expect(r).toEqual({ documentArchived: true, statementsArchived: 0 });
  });

  it("never deletes anything", async () => {
    await archiveDocumentWithStatement(DOC);
    expect(Object.keys(tx.document)).toEqual(["updateMany"]);
    expect(Object.keys(tx.bankStatement)).toEqual(["updateMany"]);
  });
});
