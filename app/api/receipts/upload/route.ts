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
  const transactionIdRaw = formData.get("transactionId");
  const transactionId = typeof transactionIdRaw === "string" && transactionIdRaw ? transactionIdRaw : null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (typeof capturedAt !== "string") {
    return NextResponse.json({ error: "capturedAt required" }, { status: 400 });
  }

  let tx: Prisma.TransactionGetPayload<{ include: { entity: true } }> | null = null;
  if (transactionId) {
    tx = await db.transaction.findUnique({
      where: { id: transactionId, archivedAt: null },
      include: { entity: true },
    });
    if (!tx) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    if (tx.entity.type !== "business") {
      // Defense in depth — matches actions/receipts.ts#dismissReceiptRequirement's
      // fail-closed guard. Receipt flagging only ever applies to business transactions.
      return NextResponse.json(
        { error: "Receipt flagging only applies to business transactions" },
        { status: 400 }
      );
    }
  }

  // entityId is required UNLESS a valid transactionId was supplied (server derives
  // entityId from tx.entityId then — never trust a client-supplied entityId in that mode).
  if (!tx && typeof entityId !== "string") {
    return NextResponse.json({ error: "entityId required" }, { status: 400 });
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
      entityId: tx ? tx.entityId : (entityId as string),
      accountId: tx?.accountId ?? null,
      // Pre-fill from the pinned transaction, before OCR runs — these are
      // already-known facts, not a guess, and must not be overwritten by OCR below.
      vendor: tx?.payeeRaw ?? null,
      receiptDate: tx ? tx.postedAt : null,
      total: tx ? new Prisma.Decimal(tx.amount).abs() : null,
    },
  });

  let extracted;
  try {
    extracted = await extractReceiptData(buffer, mimeType);
  } catch {
    // Whenever tx is set, vendor/date/total are already known from the
    // transaction, so a failed Claude call doesn't block the receipt from
    // being usable — only description/glCode would have come from OCR.
    await db.receipt.update({
      where: { id: receiptId },
      data: { ocrStatus: tx ? "complete" : "failed" },
    });
    revalidatePath("/receipts");
    return NextResponse.json({ receiptId, transactionId: tx?.id ?? null });
  }

  const totalDecimal =
    extracted.totalDollars != null ? new Prisma.Decimal(extracted.totalDollars) : null;
  const receiptDate =
    extracted.receiptDate != null ? new Date(`${extracted.receiptDate}T00:00:00Z`) : null;

  await db.receipt.update({
    where: { id: receiptId },
    data: {
      ocrStatus: tx ? "complete" : extracted.vendor != null ? "complete" : "failed",
      // When tx is set, vendor/receiptDate/total are already known from the
      // transaction and must not be overwritten by OCR's own (possibly
      // conflicting) guess — only description/glCode/ocrRaw come from OCR then.
      ...(tx
        ? {}
        : {
            vendor: extracted.vendor,
            receiptDate,
            total: totalDecimal,
          }),
      description: extracted.description,
      glCode: extracted.glCode,
      ocrRaw: extracted.raw as unknown as Prisma.InputJsonValue,
    },
  });

  revalidatePath("/receipts");
  return NextResponse.json({ receiptId, transactionId: tx?.id ?? null });
}
