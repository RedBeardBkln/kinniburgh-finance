import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "receipts";

let _admin: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set");
  _admin = createClient(url, key, { auth: { persistSession: false } });
  return _admin;
}

export async function uploadReceiptFile(
  buffer: Buffer,
  fileKey: string,
  mimeType: string
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set");

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
  const { data, error } = await getSupabaseAdmin().storage
    .from(BUCKET)
    .createSignedUrl(fileKey, 3600);
  if (error || !data) throw new Error(`Signed URL failed: ${error?.message}`);
  return data.signedUrl;
}

export async function downloadReceiptFile(fileKey: string): Promise<Buffer> {
  const { data, error } = await getSupabaseAdmin().storage
    .from(BUCKET)
    .download(fileKey);
  if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}
