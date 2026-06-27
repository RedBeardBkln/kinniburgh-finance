import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { uploadReceiptFile } from "@/lib/supabase-storage";
import { extractReceiptData } from "@/lib/receipt-extract";
import { revalidatePath } from "next/cache";

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

  const formData = await req.formData();
  const file = formData.get("file");
  const entityId = formData.get("entityId");
  const capturedAt = formData.get("capturedAt");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (typeof entityId !== "string") {
    return NextResponse.json({ error: "entityId required" }, { status: 400 });
  }
  if (typeof capturedAt !== "string") {
    return NextResponse.json({ error: "capturedAt required" }, { status: 400 });
  }

  const mimeType = file.type;
  if (!ALLOWED_TYPES.has(mimeType)) {
    return NextResponse.json(
      { error: "Unsupported file type. Upload JPEG, PNG, WebP, or PDF." },
      { status: 400 }
    );
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }

  const receiptId = crypto.randomUUID();
  const ext = EXT_MAP[mimeType] ?? "bin";
  const fileKey = `${receiptId}.${ext}`;

  // uploadReceiptFile uses node:https (not the global fetch) so the binary
  // body never passes through Next.js's instrumented fetch and its OTel btoa.
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    await uploadReceiptFile(buffer, fileKey, mimeType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Storage error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await db.receipt.create({
    data: {
      id: receiptId,
      uploadedBy: session.user.id,
      fileKey,
      capturedAt: new Date(capturedAt),
      ocrStatus: "pending",
      entityId,
    },
  });

  let extracted;
  try {
    extracted = await extractReceiptData(buffer, mimeType);
  } catch {
    await db.receipt.update({ where: { id: receiptId }, data: { ocrStatus: "failed" } });
    revalidatePath("/receipts");
    return NextResponse.json({ receiptId });
  }

  const totalDecimal =
    extracted.totalDollars != null ? new Prisma.Decimal(extracted.totalDollars) : null;
  const receiptDate =
    extracted.receiptDate != null ? new Date(`${extracted.receiptDate}T00:00:00Z`) : null;

  await db.receipt.update({
    where: { id: receiptId },
    data: {
      ocrStatus: extracted.vendor != null ? "complete" : "failed",
      vendor: extracted.vendor,
      receiptDate,
      total: totalDecimal,
      description: extracted.description,
      glCode: extracted.glCode,
      ocrRaw: extracted.raw as unknown as Prisma.InputJsonValue,
    },
  });

  revalidatePath("/receipts");
  return NextResponse.json({ receiptId });
}
