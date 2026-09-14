import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getDocumentFileSignedUrl, downloadDocumentFile } from "@/lib/supabase-storage";

// Regression coverage for the Document Vault crash fixed in this task: a
// Document.fileKey with an unrecognized/new prefix (e.g. "statements/...")
// must not be signed/downloaded against the wrong bucket. Before the fix,
// getDocumentSignedUrl/triggerExtraction (actions/documents.ts) always
// targeted the "receipts" bucket regardless of fileKey prefix, which threw
// for bank-statement Documents (stored in "taxes") and crashed the whole
// /documents page since nothing there catches the throw.
//
// These tests exercise the real HTTP-request-building logic (mocking only
// global.fetch, the actual network boundary) so a future change that breaks
// the prefix -> bucket mapping fails loudly here instead of only in
// production.

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "aaaa.bbbb.cccc";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("getDocumentFileSignedUrl", () => {
  it("signs a statements/-prefixed fileKey against the taxes bucket with the key unstripped", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signedURL: "/object/sign/taxes/statements/e1/s1.pdf?token=x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await getDocumentFileSignedUrl("statements/e1/s1.pdf");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/sign/taxes/");
    expect(url).not.toContain("/object/sign/receipts/");
    // Key is used exactly as stored — not stripped — matching how
    // actions/bank-statements.ts uploaded it.
    expect(decodeURIComponent(url)).toContain("statements/e1/s1.pdf");
  });

  it("signs a taxes/-prefixed fileKey against the taxes bucket with the key unstripped", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signedURL: "/object/sign/taxes/taxes/e1/d1.pdf?token=x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await getDocumentFileSignedUrl("taxes/e1/d1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    const decoded = decodeURIComponent(url);
    // Bucket segment is "taxes"; the "taxes/" prefix from the stored fileKey
    // must NOT be stripped from the object key, since uploadTaxDocumentCore
    // (actions/tax-planning.ts) writes the object with this fileKey
    // unstripped via uploadTaxFile — the physical object really does live at
    // the nested "taxes/e1/d1.pdf" path inside the "taxes" bucket. Stripping
    // it here (the pre-fix behavior) requested a path that never existed and
    // 404'd on every real tax-document view/download.
    expect(decoded).toContain("/object/sign/taxes/taxes/e1/d1.pdf");
  });

  it("signs a documents/-prefixed (and any other unrecognized) fileKey against the receipts bucket", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signedURL: "/object/sign/receipts/documents/e1/d1.pdf?token=x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await getDocumentFileSignedUrl("documents/e1/d1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/sign/receipts/");
    expect(url).not.toContain("/object/sign/taxes/");
  });
});

describe("downloadDocumentFile", () => {
  it("downloads a statements/-prefixed fileKey from the taxes bucket with the key unstripped", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal("fetch", fetchMock);

    await downloadDocumentFile("statements/e1/s1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/taxes/");
    expect(decodeURIComponent(url)).toContain("statements/e1/s1.pdf");
  });

  it("downloads a taxes/-prefixed fileKey from the taxes bucket with the key unstripped", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal("fetch", fetchMock);

    await downloadDocumentFile("taxes/e1/d1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    const decoded = decodeURIComponent(url);
    // Bucket segment is "taxes"; the key itself must still carry its stored
    // "taxes/" prefix (nested "taxes/taxes/e1/d1.pdf" object path) to match
    // how actions/tax-planning.ts actually wrote the object via
    // uploadTaxFile(buffer, fileKey, ...) with an unstripped fileKey.
    expect(decoded).toContain("/object/taxes/taxes/e1/d1.pdf");
  });

  it("downloads a documents/-prefixed fileKey from the receipts bucket", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal("fetch", fetchMock);

    await downloadDocumentFile("documents/e1/d1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/receipts/");
  });
});
