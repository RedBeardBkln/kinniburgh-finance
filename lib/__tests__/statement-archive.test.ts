import { describe, it, expect } from "vitest";
import {
  evaluateStatementArchive,
  buildStatementArchiveConfirmMessage,
} from "@/lib/statement-archive";

const ENTITY = "entity-a";
const OTHER = "entity-b";

function doc(over: Partial<{ entityId: string; docType: string; archivedAt: Date | null }> = {}) {
  return { entityId: ENTITY, docType: "bank_statement", archivedAt: null, ...over };
}

describe("evaluateStatementArchive", () => {
  it("allows an active bank_statement in the workspace's entity", () => {
    expect(evaluateStatementArchive({ workspaceEntityId: ENTITY, doc: doc() })).toEqual({ ok: true });
  });

  it("rejects a missing document", () => {
    expect(evaluateStatementArchive({ workspaceEntityId: ENTITY, doc: null })).toEqual({
      ok: false,
      error: "Document not found",
    });
  });

  it("rejects an already-archived document", () => {
    const r = evaluateStatementArchive({
      workspaceEntityId: ENTITY,
      doc: doc({ archivedAt: new Date("2026-01-01T00:00:00Z") }),
    });
    expect(r).toEqual({ ok: false, error: "Statement is already archived" });
  });

  it("rejects a document from another entity", () => {
    const r = evaluateStatementArchive({ workspaceEntityId: ENTITY, doc: doc({ entityId: OTHER }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/entity/);
  });

  it("rejects non-bank_statement doc types", () => {
    const r = evaluateStatementArchive({ workspaceEntityId: ENTITY, doc: doc({ docType: "w2" }) });
    expect(r).toEqual({ ok: false, error: "Only bank statements can be archived here" });
  });

  it("does not look at tax year at all (other-years list is year-mismatched by definition)", () => {
    // The input type has no taxYear field; extra fields are ignored at runtime.
    const withYear = { ...doc(), taxYear: null } as ReturnType<typeof doc>;
    expect(evaluateStatementArchive({ workspaceEntityId: ENTITY, doc: withYear })).toEqual({ ok: true });
  });

  it("checks already-archived before entity/docType", () => {
    const r = evaluateStatementArchive({
      workspaceEntityId: ENTITY,
      doc: doc({ archivedAt: new Date(), entityId: OTHER, docType: "w2" }),
    });
    expect(r).toEqual({ ok: false, error: "Statement is already archived" });
  });
});

describe("buildStatementArchiveConfirmMessage", () => {
  const msg = buildStatementArchiveConfirmMessage("EKC Jan 2025.pdf");

  it("names the document", () => {
    expect(msg).toContain('"EKC Jan 2025.pdf"');
  });

  it("states balance-sheet, import and not-deleted consequences", () => {
    expect(msg).toMatch(/balance sheets/i);
    expect(msg).toMatch(/imported/i);
    expect(msg).toMatch(/nothing is deleted/i);
  });

  it("does not promise a restore/undo", () => {
    expect(msg).not.toMatch(/restore/i);
    expect(msg).toMatch(/no undo/i);
  });
});
