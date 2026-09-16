"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  getDocumentFileSignedUrl,
  downloadDocumentFile,
  getSignedUploadUrl,
} from "@/lib/supabase-storage";
import { randomUUID } from "crypto";
import { extractDocument, classifyDocType, type ExtractedDocument } from "@/lib/doc-extract";
import { Prisma } from "@prisma/client";
import {
  MAX_SIZE_BYTES,
  buildDocumentFileKey,
  validateDocumentFile,
} from "@/lib/document-upload";

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

// ── Upload (two-phase direct-to-storage) ────────────────────────────────────────
//
// Raw file bytes never travel through a Server Action's request body — Vercel
// enforces a hard, non-configurable 4.5MB cap on Serverless Function request
// bodies, which broke uploads over ~4.4MB when this used to send FormData
// with the file attached directly. Instead: (1) requestDocumentUploadSlot
// mints a signed Supabase Storage upload URL, (2) the client PUTs the file
// bytes straight to storage, bypassing the Next.js server entirely, (3)
// finalizeDocumentUpload creates the Document row. No extraction runs here —
// extraction for this site is a separate, user-triggered action
// (triggerExtraction, below), unchanged from before this fix.

const requestSlotSchema = z.object({
  entityId: z.string().uuid(),
  fileType: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
});

export type RequestDocumentUploadSlotInput = z.input<typeof requestSlotSchema>;

export async function requestDocumentUploadSlot(
  input: RequestDocumentUploadSlotInput
): Promise<
  | { ok: true; documentId: string; fileKey: string; uploadUrl: string }
  | { ok: false; error: string }
> {
  await requireAuth();

  const parsed = requestSlotSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { entityId, fileType, fileSize } = parsed.data;

  const validation = validateDocumentFile(fileType, fileSize);
  if (!validation.ok) return { ok: false, error: validation.error };

  const documentId = randomUUID();
  const fileKey = buildDocumentFileKey(entityId, documentId, fileType);
  if (!fileKey) {
    // Should be unreachable given validateDocumentFile above, but keep this
    // typed-safe rather than asserting non-null.
    return { ok: false, error: "Unsupported file type" };
  }

  try {
    const uploadUrl = await getSignedUploadUrl(fileKey);
    return { ok: true, documentId, fileKey, uploadUrl };
  } catch (e) {
    return {
      ok: false,
      error: `Could not prepare upload: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }
}

const finalizeSchema = z.object({
  documentId: z.string().uuid(),
  fileKey: z.string().min(1),
  entityId: z.string().uuid(),
  fileType: z.string().min(1),
  docType: z.enum(DOC_TYPES),
  taxYear: z.number().int().optional(),
  notes: z.string().optional(),
});

export type FinalizeDocumentUploadInput = z.input<typeof finalizeSchema>;

export async function finalizeDocumentUpload(
  input: FinalizeDocumentUploadInput
): Promise<{ ok: true; documentId: string } | { ok: false; error: string }> {
  await requireAuth();

  const parsed = finalizeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { documentId, fileKey, entityId, fileType, docType, taxYear, notes } = parsed.data;

  // Defense-in-depth: reject if the client-supplied fileKey doesn't match
  // what the server would have generated for this documentId/entityId/type.
  const expectedFileKey = buildDocumentFileKey(entityId, documentId, fileType);
  if (expectedFileKey !== fileKey) {
    return { ok: false, error: "Upload reference mismatch" };
  }

  // downloadDocumentFile does double duty here: it's both proof the client's
  // direct PUT actually landed in storage AND the source for the
  // authoritative size re-check below. The buffer itself is discarded — this
  // site never runs extraction inline.
  let buffer: Buffer;
  try {
    buffer = await downloadDocumentFile(fileKey);
  } catch {
    return {
      ok: false,
      error: "Upload did not complete — file not found in storage. Please try again.",
    };
  }

  // Authoritative size check — the client-reported fileSize at slot-request
  // time is trust-but-verify only; this inspects the real uploaded bytes.
  if (buffer.length > MAX_SIZE_BYTES) {
    return { ok: false, error: "File exceeds 20MB limit" };
  }

  // No taxYear bounds-checking here — matches the original uploadDocument's
  // behavior, which never validated the year range even though the sibling
  // tax-planning.ts site does (see that file's finalizeTaxDocumentUpload).
  await db.document.create({
    data: {
      id: documentId,
      entityId,
      taxYear,
      docType,
      fileKey,
      notes,
    },
  });

  revalidatePath("/documents");
  return { ok: true, documentId };
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
  return getDocumentFileSignedUrl(doc.fileKey);
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
    const buffer = await downloadDocumentFile(doc.fileKey);
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
