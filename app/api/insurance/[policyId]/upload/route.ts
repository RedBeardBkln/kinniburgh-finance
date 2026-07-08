import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { uploadReceiptFile } from "@/lib/supabase-storage";
import { extractDocument } from "@/lib/doc-extract";
import { randomUUID } from "crypto";

const MAX_SIZE = 20 * 1024 * 1024;
const ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ policyId: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { policyId } = await params;
  const policy = await db.insurancePolicy.findUnique({ where: { id: policyId } });
  if (!policy) return NextResponse.json({ error: "Policy not found" }, { status: 404 });

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!ALLOWED.includes(file.type))
    return NextResponse.json({ error: "Unsupported type. Upload PDF, JPEG, PNG, or WebP." }, { status: 400 });
  if (file.size > MAX_SIZE)
    return NextResponse.json({ error: "File too large (max 20MB)" }, { status: 400 });

  const ext = file.type === "application/pdf" ? "pdf" : file.type.split("/")[1];
  const docId = randomUUID();
  const fileKey = `documents/${policy.entityId}/${docId}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  await uploadReceiptFile(buffer, fileKey, file.type);

  await db.document.create({
    data: { id: docId, entityId: policy.entityId, docType: "insurance_policy", fileKey, extractionStatus: "processing" },
  });

  // Link document to policy immediately so Q&A works even if extraction is slow
  await db.insurancePolicy.update({ where: { id: policyId }, data: { documentId: docId } });

  let extraction = null;
  try {
    extraction = await extractDocument(buffer, file.type, "insurance_policy");
    await db.document.update({
      where: { id: docId },
      data: {
        extractionStatus: "complete",
        extractionData: extraction as never,
        extractionModel: "claude-sonnet-4-6",
        extractedAt: new Date(),
      },
    });

    // Auto-populate blank policy fields from extraction
    const d = extraction.data as Record<string, unknown>;
    await db.insurancePolicy.update({
      where: { id: policyId },
      data: {
        ...(policy.policyNumber == null && d.policyNumber
          ? { policyNumber: String(d.policyNumber) } : {}),
        ...(policy.faceAmountCents == null && d.faceAmountCents
          ? { faceAmountCents: Number(d.faceAmountCents) } : {}),
        ...(policy.monthlyPremiumCents == null && d.monthlyPremiumCents
          ? { monthlyPremiumCents: Number(d.monthlyPremiumCents) } : {}),
        ...(policy.effectiveDate == null && d.effectiveDate
          ? { effectiveDate: new Date(String(d.effectiveDate)) } : {}),
        ...(policy.expiryDate == null && d.expiryDate
          ? { expiryDate: new Date(String(d.expiryDate)) } : {}),
      },
    });
  } catch (err) {
    console.error("[insurance-upload] extraction failed", { policyId, docId, err });
    await db.document.update({ where: { id: docId }, data: { extractionStatus: "failed" } });
  }

  return NextResponse.json({ documentId: docId, extraction });
}
