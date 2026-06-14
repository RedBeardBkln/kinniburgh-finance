"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { uploadReceiptFile, getReceiptSignedUrl } from "@/lib/supabase-storage";
import { randomUUID } from "crypto";

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
