import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { downloadReceiptFile } from "@/lib/supabase-storage";
import { extractReceiptData } from "@/lib/receipt-extract";
import { revalidatePath } from "next/cache";

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { receiptId: string };
  if (!body.receiptId) return NextResponse.json({ error: "receiptId required" }, { status: 400 });

  const receipt = await db.receipt.findUnique({ where: { id: body.receiptId } });
  if (!receipt) return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
  if (receipt.uploadedBy !== session.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const ext = receipt.fileKey.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = EXT_MIME[ext] ?? "image/jpeg";

  let buffer: Buffer;
  try {
    buffer = await downloadReceiptFile(receipt.fileKey);
  } catch {
    await db.receipt.update({ where: { id: receipt.id }, data: { ocrStatus: "failed" } });
    revalidatePath("/receipts");
    return NextResponse.json({});
  }

  let extracted;
  try {
    extracted = await extractReceiptData(buffer, mimeType);
  } catch {
    await db.receipt.update({ where: { id: receipt.id }, data: { ocrStatus: "failed" } });
    revalidatePath("/receipts");
    return NextResponse.json({});
  }

  const totalDecimal =
    extracted.totalDollars != null ? new Prisma.Decimal(extracted.totalDollars) : null;
  const receiptDate =
    extracted.receiptDate != null ? new Date(`${extracted.receiptDate}T00:00:00Z`) : null;

  await db.receipt.update({
    where: { id: receipt.id },
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
  return NextResponse.json({});
}
