import { request as httpsRequest } from "node:https";

const BUCKET = "receipts";

function getStorageConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set");
  return { url, key };
}

// Use node:https directly to bypass Next.js's instrumented fetch, which
// attempts to btoa() the binary request body for OTel tracing and fails on
// non-Latin-1 bytes decoded as UTF-8.
function httpsPost(urlStr: string, headers: Record<string, string>, body: Buffer): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname, search } = new URL(urlStr);
    const req = httpsRequest(
      {
        hostname,
        port: port ? parseInt(port, 10) : 443,
        path: pathname + search,
        method: "POST",
        headers: { ...headers, "Content-Length": body.length },
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

export async function uploadReceiptFile(
  buffer: Buffer,
  fileKey: string,
  mimeType: string
): Promise<void> {
  const { url, key } = getStorageConfig();
  const res = await httpsPost(
    `${url}/storage/v1/object/${BUCKET}/${fileKey}`,
    {
      Authorization: `Bearer ${key}`,
      "Content-Type": mimeType,
      "x-upsert": "false",
    },
    buffer
  );
  if (!res.ok) {
    const body = await res.text().catch(() => res.status.toString());
    let msg = res.status.toString();
    try {
      msg = (JSON.parse(body) as { message?: string }).message ?? body;
    } catch {
      msg = body;
    }
    throw new Error(`Storage upload failed: ${msg}`);
  }
}

export async function getReceiptSignedUrl(fileKey: string): Promise<string> {
  const { url, key } = getStorageConfig();
  const res = await fetch(
    `${url}/storage/v1/object/sign/${BUCKET}/${encodeURIComponent(fileKey)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 3600 }),
      cache: "no-store",
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`Signed URL failed: ${(body as { message?: string }).message ?? res.statusText}`);
  }
  const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const path = data.signedURL ?? data.signedUrl ?? "";
  return path.startsWith("http") ? path : `${url}/storage/v1${path}`;
}

export async function downloadReceiptFile(fileKey: string): Promise<Buffer> {
  const { url, key } = getStorageConfig();
  const res = await fetch(
    `${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(fileKey)}`,
    {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    }
  );
  if (!res.ok) {
    throw new Error(`Storage download failed: ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
