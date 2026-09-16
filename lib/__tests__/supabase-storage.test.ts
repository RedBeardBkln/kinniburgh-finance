import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getDocumentFileSignedUrl,
  downloadDocumentFile,
  getReceiptSignedUrl,
  getPaystubSignedUrl,
  getTaxSignedUrl,
  getSignedUploadUrl,
  getTaxSignedUploadUrl,
  downloadReceiptFile,
} from "@/lib/supabase-storage";

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

// Regression coverage for the InvalidSignature bug fixed in this task:
// `encodeURIComponent(fileKey)` on the whole multi-segment key percent-encodes
// the "/" separators as "%2F" too, which Supabase Storage signs successfully
// but then rejects on the follow-up GET against the signed URL with 400
// InvalidSignature (confirmed against production 2026-09-13). The fix encodes
// each path segment individually and rejoins with a literal "/". These tests
// assert on the RAW (non-decoded) request URL — `decodeURIComponent(url)`
// would round-trip "%2F" back to "/" and mask this exact bug, which is why
// the pre-existing tests above didn't catch it.
describe("per-segment path encoding (fileKey slashes must stay literal)", () => {
  function mockSignFetch(signedURL: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ signedURL }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("getReceiptSignedUrl keeps '/' separators literal in the request path", async () => {
    const fetchMock = mockSignFetch("/object/sign/receipts/documents/e1/d1.pdf?token=x");

    await getReceiptSignedUrl("documents/e1/d1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/sign/receipts/documents/e1/d1.pdf");
    expect(url).not.toContain("%2F");
  });

  it("getPaystubSignedUrl keeps '/' separators literal in the request path", async () => {
    const fetchMock = mockSignFetch("/object/sign/paystubs/p1/stub1.pdf?token=x");

    await getPaystubSignedUrl("p1/stub1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/sign/paystubs/p1/stub1.pdf");
    expect(url).not.toContain("%2F");
  });

  it("getTaxSignedUrl keeps '/' separators literal in the request path", async () => {
    const fetchMock = mockSignFetch("/object/sign/taxes/taxes/e1/d1.pdf?token=x");

    await getTaxSignedUrl("taxes/e1/d1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/sign/taxes/taxes/e1/d1.pdf");
    expect(url).not.toContain("%2F");
  });

  it("getSignedUploadUrl keeps '/' separators literal in the request path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "/object/upload/sign/receipts/documents/e1/d1.pdf?token=x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await getSignedUploadUrl("documents/e1/d1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/upload/sign/receipts/documents/e1/d1.pdf");
    expect(url).not.toContain("%2F");
  });

  it("downloadReceiptFile (GET download path) keeps '/' separators literal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal("fetch", fetchMock);

    await downloadReceiptFile("documents/e1/d1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/receipts/documents/e1/d1.pdf");
    expect(url).not.toContain("%2F");
  });

  it("getDocumentFileSignedUrl (taxes/ prefix) keeps all '/' separators literal end-to-end", async () => {
    const fetchMock = mockSignFetch("/object/sign/taxes/taxes/e1/d1.pdf?token=x");

    await getDocumentFileSignedUrl("taxes/e1/d1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/sign/taxes/taxes/e1/d1.pdf");
    expect(url).not.toContain("%2F");
  });

  it("downloadDocumentFile (statements/ prefix) keeps all '/' separators literal end-to-end", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal("fetch", fetchMock);

    await downloadDocumentFile("statements/e1/s1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/object/taxes/statements/e1/s1.pdf");
    expect(url).not.toContain("%2F");
  });

  it("still percent-encodes non-slash special characters within a segment", async () => {
    const fetchMock = mockSignFetch("/object/sign/receipts/documents/e 1/d1.pdf?token=x");

    await getReceiptSignedUrl("documents/e 1/d1.pdf");

    const [url] = fetchMock.mock.calls[0] as [string];
    // The space inside the "e 1" segment must still be escaped (%20), even
    // though the "/" separators around it are preserved literally.
    expect(url).toContain("/object/sign/receipts/documents/e%201/d1.pdf");
  });
});

// Coverage for the two-phase direct-to-storage upload flow introduced by the
// fix-bank-statement-folder-upload task.
describe("getTaxSignedUploadUrl", () => {
  it("signs an upload URL against the taxes bucket (not receipts)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "/object/upload/sign/taxes/statements/e1/s1.pdf?token=x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await getTaxSignedUploadUrl("statements/e1/s1.pdf");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/storage/v1/object/upload/sign/taxes/statements/e1/s1.pdf");
    expect(url).not.toContain("/object/upload/sign/receipts/");
  });
});

// Regression coverage for the missing "/storage/v1" prefix bug fixed in this
// task: the pre-fix getSignedUploadUrl resolved a relative response path as
// `${url}${path}` instead of `${url}/storage/v1${path}`, unlike every other
// signed-URL function in this file. Asserting on the function's raw RETURNED
// value (not just the request URL) is what would have caught this — the sign
// *request* URL was never wrong, only the resolved upload URL returned to
// the caller was. Per this repo's own documented testing pitfall (see
// .claude/agent-memory/coder/storage-path-segment-encoding.md), assert on
// the raw/undecoded string rather than round-tripping through
// decodeURIComponent.
describe("getSignedUploadUrl /storage/v1 prefix regression", () => {
  it("resolves a relative signed-upload response path with the /storage/v1 prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "/object/upload/sign/receipts/documents/e1/d1.pdf?token=x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getSignedUploadUrl("documents/e1/d1.pdf");

    expect(result).toContain("/storage/v1/object/upload/sign/receipts/documents/e1/d1.pdf");
    expect(result.startsWith("https://example.supabase.co/storage/v1/object/upload/sign/")).toBe(true);
  });

  it("resolves getTaxSignedUploadUrl's relative response path with the /storage/v1 prefix too", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "/object/upload/sign/taxes/statements/e1/s1.pdf?token=x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getTaxSignedUploadUrl("statements/e1/s1.pdf");

    expect(result).toContain("/storage/v1/object/upload/sign/taxes/statements/e1/s1.pdf");
  });
});
