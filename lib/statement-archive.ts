// Pure decision + message logic for archiving a bank statement from a tax
// workspace's "Other years" list. No DB access, no "use server" — the DB side
// lives in lib/statement-archive-runner.ts and the auth/validation entry point
// in actions/statement-archive.ts.

export interface StatementArchiveInput {
  /** Entity the workspace belongs to (TaxWorkspace.entityId). */
  workspaceEntityId: string;
  /** The Document row as loaded from the DB, or null if it doesn't exist. */
  doc: { entityId: string; docType: string; archivedAt: Date | null } | null;
}

export type StatementArchiveDecision = { ok: true } | { ok: false; error: string };

/**
 * Decide whether a document may be archived through the workspace Archive
 * button. Rules are checked in order.
 *
 * Deliberately NO tax-year equality check: the "Other years" list is by
 * definition the documents whose taxYear differs from the workspace's
 * (including null), so "belongs to this workspace" means "same entity" only.
 */
export function evaluateStatementArchive(input: StatementArchiveInput): StatementArchiveDecision {
  const { doc, workspaceEntityId } = input;
  if (!doc) return { ok: false, error: "Document not found" };
  if (doc.archivedAt !== null) return { ok: false, error: "Statement is already archived" };
  // Generic message: don't reveal that the id exists under another entity.
  if (doc.entityId !== workspaceEntityId) {
    return { ok: false, error: "Document does not belong to this workspace's entity" };
  }
  if (doc.docType !== "bank_statement") {
    return { ok: false, error: "Only bank statements can be archived here" };
  }
  return { ok: true };
}

/**
 * Text for the window.confirm shown before archiving. Honest about the
 * consequences and about there being no in-app undo yet.
 */
export function buildStatementArchiveConfirmMessage(displayName: string): string {
  return (
    `Archive "${displayName}"? ` +
    `It will be removed from this list, the Statements page, and balance sheets ` +
    `(its closing balance will no longer be used), and rows from it can't be imported. ` +
    `Transactions already imported are not affected. ` +
    `The file is kept - nothing is deleted. There is no undo button yet.`
  );
}
