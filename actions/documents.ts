"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { uploadReceiptFile, getReceiptSignedUrl, downloadReceiptFile } from "@/lib/supabase-storage";
import { randomUUID } from "crypto";
import { extractDocument, classifyDocType, type ExtractedDocument } from "@/lib/doc-extract";
import { Prisma } from "@prisma/client";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const DOC_TYPES = [
  "w2",
  "1099",
  "k1",
  "extension",
  "property_tax",
  "mortgage_interest",
  "policy",
  "statement",
  "bank_statement",
  "mortgage_statement",
  "insurance_policy",
  "utility_bill",
  "tax_return",
  "other",
] as const;

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

export async function uploadDocument(formData: FormData): Promise<{ documentId: string }> {
  await requireAuth();

  const file = formData.get("file");
  if (!(file instanceof Blob)) throw new Error("No file provided");
  if (file.size > MAX_SIZE_BYTES) throw new Error("File exceeds 20MB limit");
  if (!ALLOWED_MIME_TYPES.includes(file.type as (typeof ALLOWED_MIME_TYPES)[number])) {
    throw new Error("Unsupported file type. Upload PDF, JPEG, PNG, or WebP.");
  }

  const entityId = z.string().uuid().parse(formData.get("entityId"));
  const taxYear = formData.get("taxYear") ? Number(formData.get("taxYear")) : undefined;
  const docType = z.enum(DOC_TYPES).parse(formData.get("docType"));
  const notes = formData.get("notes")?.toString() ?? undefined;

  const ext = file.type === "application/pdf" ? "pdf" : file.type.split("/")[1];
  const docId = randomUUID();
  const fileKey = `documents/${entityId}/${docId}.${ext}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadReceiptFile(buffer, fileKey, file.type);

  await db.document.create({
    data: {
      id: docId,
      entityId,
      taxYear,
      docType,
      fileKey,
      notes,
    },
  });

  revalidatePath("/documents");
  return { documentId: docId };
}

export async function listDocuments(filters: { entityId?: string; taxYear?: number; docType?: string } = {}) {
  await requireAuth();
  return db.document.findMany({
    where: {
      archivedAt: null,
      ...(filters.entityId && { entityId: filters.entityId }),
      ...(filters.taxYear && { taxYear: filters.taxYear }),
      ...(filters.docType && { docType: filters.docType }),
    },
    include: { entity: true },
    orderBy: [{ taxYear: "desc" }, { createdAt: "desc" }],
  });
}

export async function getDocumentSignedUrl(documentId: string): Promise<string> {
  await requireAuth();
  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
  return getReceiptSignedUrl(doc.fileKey);
}

export async function archiveDocument(documentId: string): Promise<void> {
  await requireAuth();
  // Hard delete is forbidden — archive only
  await db.document.update({
    where: { id: documentId },
    data: { archivedAt: new Date() },
  });
  revalidatePath("/documents");
}

// ── Document intelligence ─────────────────────────────────────────────────────

export async function triggerExtraction(documentId: string): Promise<ExtractedDocument | null> {
  await requireAuth();

  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });

  await db.document.update({
    where: { id: documentId },
    data: { extractionStatus: "processing" },
  });

  try {
    const buffer = await downloadReceiptFile(doc.fileKey);
    const mimeType = doc.fileKey.endsWith(".pdf") ? "application/pdf" : "image/jpeg";
    const docType = classifyDocType(doc.docType, doc.fileKey);
    const result = await extractDocument(buffer, mimeType, docType);

    await db.document.update({
      where: { id: documentId },
      data: {
        extractionStatus: "complete",
        extractionData: result as unknown as Prisma.InputJsonValue,
        extractionModel: "claude-sonnet-4-6",
        extractedAt: new Date(),
      },
    });

    revalidatePath("/documents");
    revalidatePath(`/documents/${documentId}/review`);
    return result;
  } catch {
    await db.document.update({
      where: { id: documentId },
      data: { extractionStatus: "failed" },
    });
    return null;
  }
}

export async function confirmDocExtraction(
  documentId: string,
  correctedData: Record<string, unknown>
): Promise<void> {
  await requireAuth();
  await db.document.update({
    where: { id: documentId },
    data: {
      extractionData: correctedData as unknown as Prisma.InputJsonValue,
      extractionStatus: "complete",
      extractedAt: new Date(),
    },
  });
  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}/review`);
}

export async function skipExtraction(documentId: string): Promise<void> {
  await requireAuth();
  await db.document.update({
    where: { id: documentId },
    data: { extractionStatus: "skipped" },
  });
  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}/review`);
}

export async function importStatementTransactions(
  documentId: string,
  selectedIndices: number[],
  accountId: string
): Promise<{ imported: number; skipped: number }> {
  await requireAuth();

  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
  const extraction = doc.extractionData as unknown as ExtractedDocument | null;
  if (!extraction?.transactionRows) return { imported: 0, skipped: 0 };

  const account = await db.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { id: true, entityId: true },
  });

  const selectedRows = selectedIndices.map((i) => extraction.transactionRows![i]).filter(Boolean);

  let imported = 0;
  let skipped = 0;

  for (const row of selectedRows) {
    const postedAt = new Date(row!.date + "T12:00:00Z");
    const amountDecimal = new Prisma.Decimal(row!.amountCents).div(100);

    const existing = await db.transaction.findFirst({
      where: {
        accountId,
        postedAt,
        amount: amountDecimal,
        payeeNormalized: row!.description.slice(0, 100),
      },
    });

    if (existing) {
      skipped++;
      continue;
    }

    await db.transaction.create({
      data: {
        accountId,
        entityId: account.entityId,
        postedAt,
        amount: amountDecimal,
        payeeRaw: row!.description,
        payeeNormalized: row!.description.slice(0, 100),
        source: "import",
        pending: false,
      },
    });
    imported++;
  }

  revalidatePath("/personal/transactions");
  return { imported, skipped };
}

export async function getDocumentWithExtraction(documentId: string) {
  await requireAuth();
  return db.document.findUniqueOrThrow({
    where: { id: documentId },
    include: { entity: true },
  });
}
