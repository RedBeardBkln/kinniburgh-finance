"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { isTaxDocType } from "@/lib/document-attribution";
import { STALE_READING_ERROR, isUsableExtraction } from "@/lib/document-extraction-state";
import { appendExtractionEvent, applyCorrectionSet } from "@/lib/extraction-corrections";
import { getTaxSchema, schemaTypeForDocType, validateCorrections } from "@/lib/tax-extraction-schema";

// Owner review of AI-extracted tax values (document-extraction-status-and-review,
// pass 2).
//
// These actions write ONLY the verification columns
// (extractionCorrections / extractionConfirmedAt / extractionConfirmedById).
// They never touch extractionData, fileKey or archivedAt: the AI output stays
// exactly as the model returned it, and the owner's edits live in an overlay.
// Nothing is ever deleted.

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

export type VerificationResult = { ok: true } | { ok: false; error: string };

const NOT_REVIEWABLE_ERROR = "This document type is not reviewed here";
const NOTHING_TO_REVIEW_ERROR = "There is no extraction to review - run extraction first";

const reviewSchema = z.object({
  documentId: z.string().uuid(),
  // The `extractedAt` (ISO) the reviewer loaded; null when the document had none.
  expectedExtractedAt: z.string().datetime().nullable(),
  // The COMPLETE set of values the owner wants to override (data key -> value;
  // null = "blank on the form"). A key left out is not overridden.
  fields: z.record(z.string(), z.unknown()),
});

export type ReviewDocumentInput = z.input<typeof reviewSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revalidateViews(documentId: string) {
  // Best-effort and outside any success/failure decision: the write already
  // happened, so a revalidation failure must never turn it into an error.
  try {
    revalidatePath("/documents");
    revalidatePath("/tax");
    revalidatePath("/tax/forms");
    revalidatePath(`/documents/${documentId}/review`);
  } catch {
    // ignore
  }
}

async function applyReview(
  userId: string,
  input: ReviewDocumentInput,
  mode: "save" | "confirm"
): Promise<VerificationResult> {
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const { documentId, expectedExtractedAt, fields } = parsed.data;

  const doc = await db.document.findFirst({
    where: { id: documentId, archivedAt: null },
    select: {
      id: true,
      docType: true,
      extractionStatus: true,
      extractionData: true,
      extractionCorrections: true,
      extractedAt: true,
      extractionConfirmedAt: true,
    },
  });
  if (!doc) return { ok: false, error: "Document not found" };

  const schemaType = schemaTypeForDocType(doc.docType);
  if (!schemaType || !isTaxDocType(doc.docType)) return { ok: false, error: NOT_REVIEWABLE_ERROR };

  if (doc.extractionStatus !== "complete" || !isUsableExtraction(doc.docType, doc.extractionData)) {
    return { ok: false, error: NOTHING_TO_REVIEW_ERROR };
  }

  // Optimistic concurrency: the reviewer must be looking at the extraction that
  // is stored now (a re-extract may have landed since the page loaded). The same
  // condition is repeated in the write's WHERE below so a race cannot slip through.
  const currentExtractedAt = doc.extractedAt ? doc.extractedAt.toISOString() : null;
  if (expectedExtractedAt !== currentExtractedAt) return { ok: false, error: STALE_READING_ERROR };

  const validated = validateCorrections(schemaType, fields);
  if (!validated.ok) return { ok: false, error: validated.error };

  const aiData = isRecord(doc.extractionData) && isRecord(doc.extractionData.data) ? doc.extractionData.data : {};
  const knownKeys = new Set(getTaxSchema(schemaType).fields.map((f) => f.key));
  const now = new Date();
  const nowIso = now.toISOString();
  const applied = applyCorrectionSet(doc.extractionCorrections, validated.fields, aiData, knownKeys, nowIso, userId);

  const alreadyVerified = doc.extractionConfirmedAt !== null;
  // Nothing changed: a Save is a no-op (it must not silently drop a verification),
  // and re-confirming an already-verified document changes nothing either.
  if (!applied.changed && (mode === "save" || alreadyVerified)) {
    return { ok: true };
  }

  const overlay =
    mode === "confirm"
      ? appendExtractionEvent(applied.overlay, { type: "confirmed", at: nowIso, by: userId })
      : applied.overlay;

  const write = await db.document.updateMany({
    where: {
      id: doc.id,
      archivedAt: null,
      extractionStatus: "complete",
      extractedAt: doc.extractedAt,
    },
    data: {
      extractionCorrections: overlay as unknown as Prisma.InputJsonValue,
      // ANY edit un-verifies; Confirm is the only thing that (re)verifies.
      extractionConfirmedAt: mode === "confirm" ? now : null,
      extractionConfirmedById: mode === "confirm" ? userId : null,
    },
  });
  if (write.count === 0) return { ok: false, error: STALE_READING_ERROR };

  revalidateViews(doc.id);
  return { ok: true };
}

/** Saves the owner's corrections. The document stays (or becomes) unverified. */
export async function saveDocumentCorrections(input: ReviewDocumentInput): Promise<VerificationResult> {
  const user = await requireAuth();
  return applyReview(user.id, input, "save");
}

/** Saves the owner's corrections AND marks the document verified ("marked verified by you"). */
export async function confirmDocumentExtraction(input: ReviewDocumentInput): Promise<VerificationResult> {
  const user = await requireAuth();
  return applyReview(user.id, input, "confirm");
}

const unverifySchema = z.object({ documentId: z.string().uuid() });

/** Clears the verification. Corrections are kept. */
export async function unverifyDocumentExtraction(documentId: string): Promise<VerificationResult> {
  const user = await requireAuth();

  const parsed = unverifySchema.safeParse({ documentId });
  if (!parsed.success) return { ok: false, error: "Invalid document" };

  const doc = await db.document.findFirst({
    where: { id: parsed.data.documentId, archivedAt: null },
    select: { id: true, extractionConfirmedAt: true, extractionCorrections: true },
  });
  if (!doc) return { ok: false, error: "Document not found" };
  if (doc.extractionConfirmedAt === null) return { ok: false, error: "This document is not verified" };

  const overlay = appendExtractionEvent(doc.extractionCorrections, {
    type: "unverified",
    at: new Date().toISOString(),
    by: user.id,
  });
  const write = await db.document.updateMany({
    where: { id: doc.id, archivedAt: null, extractionConfirmedAt: { not: null } },
    data: {
      extractionConfirmedAt: null,
      extractionConfirmedById: null,
      extractionCorrections: overlay as unknown as Prisma.InputJsonValue,
    },
  });
  if (write.count === 0) return { ok: false, error: "This document is not verified" };

  revalidateViews(doc.id);
  return { ok: true };
}
