const BUCKET = "receipts";

function getStorageConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set");
  return { url, key };
}

export async function uploadReceiptFile(
  buffer: Buffer,
  fileKey: string,
  mimeType: string
): Promise<void> {
  const { url, key } = getStorageConfig();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${fileKey}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": mimeType,
      "x-upsert": "false",
    },
    body: new Uint8Array(buffer),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`Storage upload failed: ${(body as { message?: string }).message ?? res.statusText}`);
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
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`Signed URL failed: ${(body as { message?: string }).message ?? res.statusText}`);
  }
  const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const path = data.signedURL ?? data.signedUrl ?? "";
  // path is either a full URL or a relative path like /object/sign/...
  return path.startsWith("http") ? path : `${url}/storage/v1${path}`;
}

export async function downloadReceiptFile(fileKey: string): Promise<Buffer> {
  const { url, key } = getStorageConfig();
  const res = await fetch(
    `${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(fileKey)}`,
    {
      headers: { Authorization: `Bearer ${key}` },
    }
  );
  if (!res.ok) {
    throw new Error(`Storage download failed: ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
