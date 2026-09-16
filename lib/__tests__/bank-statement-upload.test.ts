import { describe, it, expect } from "vitest";
import {
  ALLOWED_MIME_TYPES,
  MAX_SIZE_BYTES,
  extensionForMimeType,
  validateStatementFile,
  buildStatementFileKey,
} from "@/lib/bank-statement-upload";

describe("extensionForMimeType", () => {
  it("maps application/pdf to pdf", () => {
    expect(extensionForMimeType("application/pdf")).toBe("pdf");
  });

  it("maps image/jpeg to jpeg", () => {
    expect(extensionForMimeType("image/jpeg")).toBe("jpeg");
  });

  it("maps image/png to png", () => {
    expect(extensionForMimeType("image/png")).toBe("png");
  });

  it("maps image/webp to webp", () => {
    expect(extensionForMimeType("image/webp")).toBe("webp");
  });

  it("returns null for an unrecognized MIME type", () => {
    expect(extensionForMimeType("application/zip")).toBeNull();
    expect(extensionForMimeType("text/plain")).toBeNull();
    expect(extensionForMimeType("")).toBeNull();
  });
});

describe("validateStatementFile", () => {
  it("passes for each allowed MIME type at a normal size", () => {
    for (const mime of ALLOWED_MIME_TYPES) {
      expect(validateStatementFile(mime, 1024)).toEqual({ ok: true });
    }
  });

  it("fails for a disallowed MIME type", () => {
    const result = validateStatementFile("application/zip", 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unsupported file type/i);
  });

  it("passes when size is exactly at MAX_SIZE_BYTES", () => {
    expect(validateStatementFile("application/pdf", MAX_SIZE_BYTES)).toEqual({ ok: true });
  });

  it("fails when size is one byte over MAX_SIZE_BYTES", () => {
    const result = validateStatementFile("application/pdf", MAX_SIZE_BYTES + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/20MB/);
  });
});

describe("buildStatementFileKey", () => {
  it("builds the expected key shape for a known entityId/statementId/type", () => {
    const key = buildStatementFileKey("e1", "s1", "application/pdf");
    expect(key).toBe("statements/e1/s1.pdf");
  });

  it("builds the correct extension for each allowed image type", () => {
    expect(buildStatementFileKey("e1", "s1", "image/jpeg")).toBe("statements/e1/s1.jpeg");
    expect(buildStatementFileKey("e1", "s1", "image/png")).toBe("statements/e1/s1.png");
    expect(buildStatementFileKey("e1", "s1", "image/webp")).toBe("statements/e1/s1.webp");
  });

  it("returns null for an unrecognized MIME type", () => {
    expect(buildStatementFileKey("e1", "s1", "application/zip")).toBeNull();
  });
});
