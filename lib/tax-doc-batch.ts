// Pure: batch tax-document upload result summarization. Used by the shared
// upload component so the UI never silently drops a per-file failure.

import type { ExtractedDocument } from "./doc-extract";

// Deliberate, arbitrary-but-reasonable cap on files per batch submission —
// bounds worst-case serial in-request extraction time (no queueing/background
// job system exists in this codebase). Easy to change later.
export const MAX_BATCH_FILES = 25;

export interface UploadBatchSuccess {
  fileName: string;
  success: true;
  documentId: string;
  documentName: string | null;
  extraction: ExtractedDocument | null;
}

export interface UploadBatchFailure {
  fileName: string;
  success: false;
  error: string;
}

export type UploadBatchResult = UploadBatchSuccess | UploadBatchFailure;

/**
 * Summarizes a batch upload result array into a short, honest, human-readable
 * string, e.g. "4 uploaded & parsed, 1 failed: bad-scan.pdf (Unsupported file
 * type)." Never throws, including on an empty array (defensive — the calling
 * action already guards against an empty batch).
 */
export function summarizeUploadBatch(results: UploadBatchResult[]): string {
  if (results.length === 0) return "No files were submitted.";

  const successes = results.filter((r): r is UploadBatchSuccess => r.success);
  const failures = results.filter((r): r is UploadBatchFailure => !r.success);

  if (failures.length === 0) {
    return successes.length === 1
      ? `✓ Uploaded — saved as "${successes[0]!.documentName ?? successes[0]!.fileName}".`
      : `✓ ${successes.length} uploaded & parsed.`;
  }

  const failureDetail = failures.map((f) => `${f.fileName} (${f.error})`).join(", ");

  if (successes.length === 0) {
    return failures.length === 1
      ? `Failed: ${failureDetail}`
      : `${failures.length} failed: ${failureDetail}`;
  }

  return `${successes.length} uploaded & parsed, ${failures.length} failed: ${failureDetail}.`;
}
