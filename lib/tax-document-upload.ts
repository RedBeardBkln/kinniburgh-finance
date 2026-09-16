// Pure validation/fileKey helpers for the tax-planning upload site. No DB, no
// "use server" — shared between the client (pre-flight validation before
// requesting a signed upload slot) and the server actions (authoritative
// re-check). Same MIME/size rules as lib/document-upload.ts today, but kept
// as a separate module — this site's bucket/prefix shape (taxes bucket,
// `taxes/{entityId}/{documentId}.{ext}`) genuinely differs from
// lib/document-upload.ts's (receipts bucket, `documents/...`), and the
// bank-statement precedent (lib/bank-statement-upload.ts) established one lib
// file per fileKey-shape rather than one global "upload validation" module
// (see .claude/pipeline/fix-remaining-upload-body-limit/01-plan.md).

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

export type TaxDocumentFileValidation = { ok: true } | { ok: false; error: string };

/**
 * Validates a tax document file's reported MIME type and size before a
 * signed upload slot is requested. Matches the size comparison
 * (`size > MAX_SIZE_BYTES` fails; exactly MAX_SIZE_BYTES passes) previously
 * enforced inline in tax-planning.ts's uploadTaxDocument/uploadTaxDocuments.
 */
export function validateTaxDocumentFile(fileType: string, fileSize: number): TaxDocumentFileValidation {
  if (!ALLOWED_MIME_TYPES.includes(fileType as AllowedMimeType)) {
    return { ok: false, error: "Unsupported file type. Upload PDF, JPEG, PNG, or WebP." };
  }
  if (fileSize > MAX_SIZE_BYTES) {
    return { ok: false, error: "File exceeds 20MB limit" };
  }
  return { ok: true };
}

/**
 * Builds the storage fileKey for a tax document, preserving the existing
 * `taxes/{entityId}/{documentId}.{ext}` shape (taxes bucket) so nothing
 * downstream (bucket routing in lib/supabase-storage.ts,
 * getTaxDocumentSignedUrl/downloadTaxDocument) needs to change. Returns null
 * if the MIME type isn't recognized.
 */
export function buildTaxDocumentFileKey(
  entityId: string,
  documentId: string,
  fileType: string
): string | null {
  const ext = extensionForMimeType(fileType);
  if (!ext) return null;
  return `taxes/${entityId}/${documentId}.${ext}`;
}
