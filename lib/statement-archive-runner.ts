// DB-aware half of the statement-archive feature (pure half:
// lib/statement-archive.ts). No "use server" and no auth here — callers
// (actions/statement-archive.ts) are responsible for requireAuth() and
// validation.

import { db } from "@/lib/db";

export interface ArchiveDocumentResult {
  documentArchived: boolean;
  statementsArchived: number;
}

/**
 * Soft-archive a Document and its linked BankStatement(s) in ONE transaction
 * with ONE shared timestamp. The shared timestamp lets a future restore pair
 * them exactly (clear only BankStatements whose archivedAt equals the
 * Document's) without resurrecting a statement archived separately earlier.
 *
 * The Document update is guarded by `archivedAt: null` (and optionally
 * `entityId`), so a concurrent archive loses cleanly with documentArchived:
 * false and the BankStatement update is skipped.
 */
export async function archiveDocumentWithStatement(
  documentId: string,
  opts?: { entityId?: string },
): Promise<ArchiveDocumentResult> {
  return db.$transaction(async (tx) => {
    const now = new Date();
    const docResult = await tx.document.updateMany({
      where: {
        id: documentId,
        archivedAt: null,
        ...(opts?.entityId ? { entityId: opts.entityId } : {}),
      },
      data: { archivedAt: now },
    });
    if (docResult.count === 0) return { documentArchived: false, statementsArchived: 0 };

    const stmtResult = await tx.bankStatement.updateMany({
      where: { documentId, archivedAt: null },
      data: { archivedAt: now },
    });
    return { documentArchived: true, statementsArchived: stmtResult.count };
  });
}
