// Pure validation/fileKey helpers for the bank statement upload flow. No DB,
// no "use server" — shared between the client (pre-flight validation before
// requesting a signed upload slot) and the server actions (authoritative
// re-check). Extracted from actions/bank-statements.ts as part of the
// two-phase direct-to-storage upload fix (see
// .claude/pipeline/fix-bank-statement-folder-upload/01-plan.md).

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * Maps an allowed MIME type to its storage file extension. Returns null for
 * anything not in ALLOWED_MIME_TYPES.
 */
export function extensionForMimeType(fileType: string): string | null {
  if (fileType === "application/pdf") return "pdf";
  if (!ALLOWED_MIME_TYPES.includes(fileType as AllowedMimeType)) return null;
  return fileType.split("/")[1] ?? null;
}

export type StatementFileValidation = { ok: true } | { ok: false; error: string };

/**
 * Validates a bank statement file's reported MIME type and size before a
 * signed upload slot is requested. Matches the size comparison
 * (`size > MAX_SIZE_BYTES` fails; exactly MAX_SIZE_BYTES passes) previously
 * enforced in uploadStatementCore.
 */
export function validateStatementFile(fileType: string, fileSize: number): StatementFileValidation {
  if (!ALLOWED_MIME_TYPES.includes(fileType as AllowedMimeType)) {
    return { ok: false, error: "Unsupported file type. Upload PDF, JPEG, PNG, or WebP." };
  }
  if (fileSize > MAX_SIZE_BYTES) {
    return { ok: false, error: "File exceeds 20MB limit" };
  }
  return { ok: true };
}

/**
 * Builds the storage fileKey for a bank statement, preserving the existing
 * `statements/{entityId}/{statementId}.{ext}` shape (taxes bucket) so
 * nothing downstream (bucket routing in lib/supabase-storage.ts,
 * retryStatementExtraction, balance-sheet queries) needs to change. Returns
 * null if the MIME type isn't recognized.
 */
export function buildStatementFileKey(
  entityId: string,
  statementId: string,
  fileType: string
): string | null {
  const ext = extensionForMimeType(fileType);
  if (!ext) return null;
  return `statements/${entityId}/${statementId}.${ext}`;
}
