import { describe, it, expect } from "vitest";
import { summarizeUploadBatch, MAX_BATCH_FILES, type UploadBatchResult } from "../tax-doc-batch";

describe("MAX_BATCH_FILES", () => {
  it("is a positive, reasonable cap", () => {
    expect(MAX_BATCH_FILES).toBe(25);
  });
});

describe("summarizeUploadBatch", () => {
  it("handles the empty-array case without throwing", () => {
    expect(() => summarizeUploadBatch([])).not.toThrow();
    expect(summarizeUploadBatch([])).toBe("No files were submitted.");
  });

  it("summarizes an all-success batch (plural)", () => {
    const results: UploadBatchResult[] = [
      { fileName: "w2.pdf", success: true, documentId: "1", documentName: "W-2 — Acme (2025)", extraction: null },
      { fileName: "1099.pdf", success: true, documentId: "2", documentName: "1099 — Fiverr (2025)", extraction: null },
    ];
    const summary = summarizeUploadBatch(results);
    expect(summary).toContain("2 uploaded");
    expect(summary).not.toContain("failed");
  });

  it("summarizes a singleton all-success batch by name", () => {
    const results: UploadBatchResult[] = [
      { fileName: "w2.pdf", success: true, documentId: "1", documentName: "W-2 — Acme (2025)", extraction: null },
    ];
    const summary = summarizeUploadBatch(results);
    expect(summary).toContain("W-2 — Acme (2025)");
    expect(summary).not.toContain("failed");
  });

  it("summarizes an all-failure batch, naming the failed file(s) and reason(s)", () => {
    const results: UploadBatchResult[] = [
      { fileName: "bad-scan.pdf", success: false, error: "Unsupported file type" },
    ];
    const summary = summarizeUploadBatch(results);
    expect(summary).toContain("bad-scan.pdf");
    expect(summary).toContain("Unsupported file type");
  });

  it("summarizes a mixed success/failure batch, never silently dropping the failure", () => {
    const results: UploadBatchResult[] = [
      { fileName: "w2.pdf", success: true, documentId: "1", documentName: "W-2 — Acme (2025)", extraction: null },
      { fileName: "huge-file.pdf", success: false, error: "File exceeds 20MB limit" },
      { fileName: "1099.pdf", success: true, documentId: "2", documentName: "1099 — Fiverr (2025)", extraction: null },
    ];
    const summary = summarizeUploadBatch(results);
    expect(summary).toContain("2 uploaded");
    expect(summary).toContain("1 failed");
    expect(summary).toContain("huge-file.pdf");
    expect(summary).toContain("File exceeds 20MB limit");
  });

  it("summarizes multiple failures, listing every one", () => {
    const results: UploadBatchResult[] = [
      { fileName: "bad1.pdf", success: false, error: "Unsupported file type" },
      { fileName: "bad2.pdf", success: false, error: "File exceeds 20MB limit" },
    ];
    const summary = summarizeUploadBatch(results);
    expect(summary).toContain("bad1.pdf");
    expect(summary).toContain("bad2.pdf");
    expect(summary).toContain("2 failed");
  });
});
