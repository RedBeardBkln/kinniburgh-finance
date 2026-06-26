import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSignedUploadUrl } from "@/lib/supabase-storage";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const EXT_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    mimeType: string;
    capturedAt: string;
    entityId: string;
    fileSize: number;
  };

  if (!ALLOWED_TYPES.has(body.mimeType)) {
    return NextResponse.json({ error: "Unsupported file type. Upload JPEG, PNG, WebP, or PDF." }, { status: 400 });
  }
  if (typeof body.fileSize === "number" && body.fileSize > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }
  if (!body.entityId || !body.capturedAt) {
    return NextResponse.json({ error: "entityId and capturedAt are required" }, { status: 400 });
  }

  const receiptId = crypto.randomUUID();
  const ext = EXT_MAP[body.mimeType] ?? "bin";
  const fileKey = `${receiptId}.${ext}`;

  let uploadUrl: string;
  try {
    uploadUrl = await getSignedUploadUrl(fileKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not get upload URL";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await db.receipt.create({
    data: {
      id: receiptId,
      uploadedBy: session.user.id,
      fileKey,
      capturedAt: new Date(body.capturedAt),
      ocrStatus: "pending",
      entityId: body.entityId,
    },
  });

  return NextResponse.json({ receiptId, uploadUrl });
}
