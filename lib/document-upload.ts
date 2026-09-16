// Pure validation/fileKey helpers shared by the documents.ts and
// actions/insurance.ts upload sites (identical MIME allowlist, size cap,
// bucket, and fileKey shape — "documents/{entityId}/{documentId}.{ext}" in
// the receipts bucket). No DB, no "use server" — shared between the client
// (pre-flight validation before requesting a signed upload slot) and the
// server actions (authoritative re-check). Mirrors the shape of
// lib/bank-statement-upload.ts (see
// .claude/pipeline/fix-remaining-upload-body-limit/01-plan.md).

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
  if (!ALLOWED_MIME_TYPES.includes(fileType as AllowedMimeType)) return null;
  if (fileType === "application/pdf") return "pdf";
  return fileType.split("/")[1] ?? null;
}

export type DocumentFileValidation = { ok: true } | { ok: false; error: string };

/**
 * Validates a document file's reported MIME type and size before a signed
 * upload slot is requested. Matches the size comparison
 * (`size > MAX_SIZE_BYTES` fails; exactly MAX_SIZE_BYTES passes) previously
 * enforced inline in documents.ts's uploadDocument and the insurance upload
 * Route Handler.
 */
export function validateDocumentFile(fileType: string, fileSize: number): DocumentFileValidation {
  if (!ALLOWED_MIME_TYPES.includes(fileType as AllowedMimeType)) {
    return { ok: false, error: "Unsupported file type. Upload PDF, JPEG, PNG, or WebP." };
  }
  if (fileSize > MAX_SIZE_BYTES) {
    return { ok: false, error: "File exceeds 20MB limit" };
  }
  return { ok: true };
}

/**
 * Builds the storage fileKey for a document, preserving the existing
 * `documents/{entityId}/{documentId}.{ext}` shape (receipts bucket) so
 * nothing downstream (getDocumentFileSignedUrl/downloadDocumentFile in
 * lib/supabase-storage.ts, triggerExtraction) needs to change. Returns null
 * if the MIME type isn't recognized.
 */
export function buildDocumentFileKey(
  entityId: string,
  documentId: string,
  fileType: string
): string | null {
  const ext = extensionForMimeType(fileType);
  if (!ext) return null;
  return `documents/${entityId}/${documentId}.${ext}`;
}
