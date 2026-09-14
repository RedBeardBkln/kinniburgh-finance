import { request as httpsRequest } from "node:https";

const BUCKET = "receipts";
const PAYSTUB_BUCKET = "paystubs";
const TAX_BUCKET = "taxes";

function getStorageConfig() {
  const url = process.env.SUPABASE_URL?.trim();
  const raw = process.env.SUPABASE_SERVICE_KEY ?? "";
  // Supabase service keys are JWTs: base64url segments separated by dots.
  // Strip anything that is not a valid JWT character (letters, digits, - _ . =).
  // This silently removes copy-paste whitespace (spaces, line breaks) without
  // corrupting the token. If anything other than whitespace is removed, the key
  // is corrupted and we throw a clear diagnostic error below.
  const key = raw.replace(/[^A-Za-z0-9\-_.=]/g, "");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set");
  if (raw.replace(/\s/g, "") !== key) {
    throw new Error(
      "SUPABASE_SERVICE_KEY contains unexpected characters and is likely corrupted. " +
        "Please delete and re-paste the service_role key from Supabase Dashboard " +
        "(Project Settings > API) into Vercel environment variables."
    );
  }
  return { url, key };
}

// Encodes a multi-segment storage key (e.g. "taxes/{entityId}/{docId}.pdf")
// for use in a Supabase Storage REST request path. `encodeURIComponent()` on
// the whole key also encodes the "/" separators as "%2F", which breaks
// Supabase Storage's signature verification on the follow-up GET against the
// resulting signed URL — confirmed against production 2026-09-13: the sign
// request itself returns 200 either way, but the GET on the signed URL
// returns 400 InvalidSignature when the slashes were percent-encoded.
// `fileKey` segments (prefix, entityId, docId.ext) never legitimately
// contain "/" themselves, so encoding each segment individually and
// rejoining with a literal "/" is always correct.
function encodeStoragePath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

// Used by documents.ts for server-side uploads that cannot go through the
// signed-URL flow. Uses node:https to bypass Next.js's instrumented global
// fetch, which tries to btoa() binary bodies for OTel tracing.
function httpsPost(
  urlStr: string,
  headers: Record<string, string>,
  body: Buffer
): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : 443,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { ...headers, "Content-Length": String(body.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
            status: res.statusCode ?? 500,
            text: () => Promise.resolve(data),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function uploadFile(
  buffer: Buffer,
  bucket: string,
  fileKey: string,
  mimeType: string,
  upsert = false
): Promise<void> {
  const { url, key } = getStorageConfig();
  const res = await httpsPost(
    `${url}/storage/v1/object/${bucket}/${encodeStoragePath(fileKey)}`,
    {
      Authorization: `Bearer ${key}`,
      "Content-Type": mimeType,
      "x-upsert": upsert ? "true" : "false",
    },
    buffer
  );
  if (!res.ok) {
    const body = await res.text().catch(() => res.status.toString());
    let msg = res.status.toString();
    try { msg = (JSON.parse(body) as { message?: string }).message ?? body; } catch { msg = body; }
    throw new Error(`Storage upload failed: ${msg}`);
  }
}

async function downloadFile(bucket: string, fileKey: string): Promise<Buffer> {
  const { url, key } = getStorageConfig();
  const res = await fetch(
    `${url}/storage/v1/object/${bucket}/${encodeStoragePath(fileKey)}`,
    { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" }
  );
  if (!res.ok) throw new Error(`Storage download failed: ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function uploadReceiptFile(
  buffer: Buffer,
  fileKey: string,
  mimeType: string
): Promise<void> {
  return uploadFile(buffer, BUCKET, fileKey, mimeType, false);
}

// Returns a signed upload URL the browser can PUT the binary file to directly,
// bypassing the Next.js server entirely for the binary upload step.
export async function getSignedUploadUrl(fileKey: string): Promise<string> {
  const { url, key } = getStorageConfig();
  const res = await fetch(
    `${url}/storage/v1/object/upload/sign/${BUCKET}/${encodeStoragePath(fileKey)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      `Upload sign failed: ${(data as { message?: string }).message ?? res.statusText}`
    );
  }
  const data = (await res.json()) as { url?: string; signedUrl?: string };
  const path = data.url ?? data.signedUrl ?? "";
  if (!path) throw new Error("No signed upload URL returned");
  return path.startsWith("http") ? path : `${url}${path}`;
}

export async function getReceiptSignedUrl(fileKey: string): Promise<string> {
  const { url, key } = getStorageConfig();
  const res = await fetch(
    `${url}/storage/v1/object/sign/${BUCKET}/${encodeStoragePath(fileKey)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600 }),
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(
      `Signed URL failed: ${(body as { message?: string }).message ?? res.statusText}`
    );
  }
  const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const path = data.signedURL ?? data.signedUrl ?? "";
  return path.startsWith("http") ? path : `${url}/storage/v1${path}`;
}

export async function downloadReceiptFile(fileKey: string): Promise<Buffer> {
  return downloadFile(BUCKET, fileKey);
}

export async function uploadPaystubFile(
  buffer: Buffer,
  fileKey: string,
  mimeType: string
): Promise<void> {
  return uploadFile(buffer, PAYSTUB_BUCKET, fileKey, mimeType, false);
}

export async function getPaystubSignedUrl(fileKey: string): Promise<string> {
  const { url, key } = getStorageConfig();
  const res = await fetch(
    `${url}/storage/v1/object/sign/${PAYSTUB_BUCKET}/${encodeStoragePath(fileKey)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600 }),
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(
      `Signed URL failed: ${(body as { message?: string }).message ?? res.statusText}`
    );
  }
  const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const path = data.signedURL ?? data.signedUrl ?? "";
  return path.startsWith("http") ? path : `${url}/storage/v1${path}`;
}

export async function uploadLogoFile(
  buffer: Buffer,
  fileKey: string,
  mimeType: string
): Promise<void> {
  return uploadFile(buffer, "logos", fileKey, mimeType, true);
}

export async function downloadLogoFile(fileKey: string): Promise<Buffer> {
  return downloadFile("logos", fileKey);
}

export async function uploadTaxFile(
  buffer: Buffer,
  fileKey: string,
  mimeType: string
): Promise<void> {
  return uploadFile(buffer, TAX_BUCKET, fileKey, mimeType, false);
}

export async function downloadTaxFile(fileKey: string): Promise<Buffer> {
  return downloadFile(TAX_BUCKET, fileKey);
}

export async function getTaxSignedUrl(fileKey: string): Promise<string> {
  const { url, key } = getStorageConfig();
  const res = await fetch(
    `${url}/storage/v1/object/sign/${TAX_BUCKET}/${encodeStoragePath(fileKey)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600 }),
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(
      `Signed URL failed: ${(body as { message?: string }).message ?? res.statusText}`
    );
  }
  const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const path = data.signedURL ?? data.signedUrl ?? "";
  return path.startsWith("http") ? path : `${url}/storage/v1${path}`;
}

// ── Document.fileKey bucket routing ──────────────────────────────────────────
//
// `Document.fileKey` (prisma/schema.prisma) carries a routing prefix telling
// us which bucket — and, for the "taxes/" prefix, which physical sub-path —
// the underlying object actually lives in. Every reader of a Document's
// fileKey (signed URL, download-for-extraction, etc.) must agree with
// whichever uploader actually wrote the bytes, or the read 404s / throws.
// Centralizing that decision here means a new prefix only needs to be taught
// to these two functions, not to every call site.
//
// Prefixes currently in use (grep `fileKey = \`` under actions/** and
// app/api/**):
//   - "documents/{entityId}/..."   (actions/documents.ts, insurance policy
//     upload route) -> receipts bucket, key used exactly as stored.
//   - "taxes/{entityId}/..."       (actions/tax-planning.ts) -> taxes bucket;
//     `uploadTaxDocumentCore` calls `uploadTaxFile(buffer, fileKey, ...)` with
//     this fileKey UNSTRIPPED, so the physical object lives at the nested
//     path "taxes/{entityId}/..." *inside* the already-taxes-named bucket
//     (a redundant folder segment, but that's what was actually written —
//     confirmed against production storage on 2026-09-13). The key must be
//     used exactly as stored on read too, or the request 404s. Do NOT strip
//     this prefix — a prior version of this helper did, which broke every
//     real tax-document upload (see tax-document-bucket-path-fix task).
//   - "statements/{entityId}/..."  (actions/bank-statements.ts) -> taxes
//     bucket, key used exactly as stored (that module uploads and downloads
//     with the same unstripped key already).
// Anything else (legacy/unrecognized keys) falls back to the receipts bucket
// with the key used as-is, matching this app's original single-bucket
// behavior before the taxes/statements buckets existed.
export async function getDocumentFileSignedUrl(fileKey: string): Promise<string> {
  if (fileKey.startsWith("taxes/")) return getTaxSignedUrl(fileKey);
  if (fileKey.startsWith("statements/")) return getTaxSignedUrl(fileKey);
  return getReceiptSignedUrl(fileKey);
}

export async function downloadDocumentFile(fileKey: string): Promise<Buffer> {
  if (fileKey.startsWith("taxes/")) return downloadTaxFile(fileKey);
  if (fileKey.startsWith("statements/")) return downloadTaxFile(fileKey);
  return downloadReceiptFile(fileKey);
}
