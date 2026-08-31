import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { uploadPaystubFile } from "@/lib/supabase-storage";
import { extractPaystubData, verifyPaystubMath, inferPayFrequency } from "@/lib/paystub-extract";
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

  const paystubId = crypto.randomUUID();
  const ext = EXT_MAP[mimeType] ?? "bin";
  const fileKey = `${paystubId}.${ext}`;

  // uploadPaystubFile uses node:https (not global fetch) so the binary body
  // never passes through Next.js's instrumented fetch.
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    await uploadPaystubFile(buffer, fileKey, mimeType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Storage error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  await db.paystub.create({
    data: {
      id: paystubId,
      entityId,
      uploadedBy: session.user.id,
      fileKey,
      capturedAt: new Date(capturedAt),
      extractStatus: "pending",
    },
  });

  let extracted;
  try {
    extracted = await extractPaystubData(buffer, mimeType);
  } catch {
    await db.paystub.update({ where: { id: paystubId }, data: { extractStatus: "failed" } });
    revalidatePath("/personal/income");
    return NextResponse.json({ paystubId });
  }

  const hasAnyData =
    extracted.grossPayCents !== null ||
    extracted.netPayCents !== null ||
    extracted.payDate !== null;

  const math = verifyPaystubMath(extracted);
  const frequency =
    extracted.payFrequency ?? inferPayFrequency(
      extracted.payPeriodStart,
      extracted.payPeriodEnd,
      extracted.payDate
    );

  await db.paystub.update({
    where: { id: paystubId },
    data: {
      extractStatus: hasAnyData ? "complete" : "failed",
      employeeName: extracted.employeeName,
      employerName: extracted.employerName,
      payPeriodStart: extracted.payPeriodStart
        ? new Date(`${extracted.payPeriodStart}T00:00:00Z`)
        : null,
      payPeriodEnd: extracted.payPeriodEnd
        ? new Date(`${extracted.payPeriodEnd}T00:00:00Z`)
        : null,
      payDate: extracted.payDate ? new Date(`${extracted.payDate}T00:00:00Z`) : null,
      payFrequency: frequency,
      grossPayCents: extracted.grossPayCents,
      pretaxDeductions: extracted.pretaxDeductions as unknown as never,
      taxesCents: math.taxesTotalCents,
      taxBreakdown: extracted.taxBreakdown as unknown as never,
      additionalWithholding: extracted.additionalWithholding as unknown as never,
      netPayCents: extracted.netPayCents,
      balanceDiffCents: math.balanceDiffCents,
      extractionRaw: extracted.raw as unknown as never,
    },
  });

  revalidatePath("/personal/income");
  return NextResponse.json({ paystubId });
}