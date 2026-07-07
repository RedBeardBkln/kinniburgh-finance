import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { uploadLogoFile } from "@/lib/supabase-storage";
import { setLogoMeta } from "@/lib/settings";

const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: "Unsupported type. Upload PNG, JPEG, WebP, or SVG." },
      { status: 400 }
    );
  }
  if (file.size > 2 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 2MB)" }, { status: 400 });
  }

  const fileKey = `logo.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    await uploadLogoFile(buffer, fileKey, file.type);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Storage error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await setLogoMeta(fileKey, file.type);
  return NextResponse.json({ success: true });
}
