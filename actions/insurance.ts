"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { getSignedUploadUrl, downloadDocumentFile } from "@/lib/supabase-storage";
import { extractDocument, type ExtractedDocument } from "@/lib/doc-extract";
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

const policySchema = z.object({
  entityId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  policyType: z.enum(["term", "whole", "ul", "property", "auto", "motorcycle", "other"]),
  insurer: z.string().min(1).max(200),
  policyNumber: z.string().max(100).optional(),
  faceAmountCents: z.number().int().positive().optional(),
  monthlyPremiumCents: z.number().int().positive().optional(),
  effectiveDate: z.string().optional(),
  expiryDate: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

export async function listPolicies(entityId?: string) {
  await requireAuth();
  return db.insurancePolicy.findMany({
    where: {
      archivedAt: null,
      ...(entityId && { entityId }),
    },
    include: {
      cashValueEntries: { orderBy: { asOf: "asc" } },
      document: { select: { id: true, extractionStatus: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function createPolicy(input: z.infer<typeof policySchema>) {
  await requireAuth();
  const data = policySchema.parse(input);
  const policy = await db.insurancePolicy.create({
    data: {
      ...data,
      effectiveDate: data.effectiveDate ? new Date(data.effectiveDate) : null,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
    },
  });
  revalidatePath("/personal/insurance");
  return policy;
}

export async function updatePolicy(
  id: string,
  input: Partial<z.infer<typeof policySchema>>
) {
  await requireAuth();
  const policy = await db.insurancePolicy.update({
    where: { id },
    data: {
      ...input,
      effectiveDate: input.effectiveDate ? new Date(input.effectiveDate) : undefined,
      expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined,
    },
  });
  revalidatePath("/personal/insurance");
  return policy;
}

export async function archivePolicy(id: string) {
  await requireAuth();
  await db.insurancePolicy.update({
    where: { id },
    data: { archivedAt: new Date() },
  });
  revalidatePath("/personal/insurance");
}

export async function addCashValueEntry(
  policyId: string,
  input: { asOf: string; cashValueCents: number; notes?: string }
) {
  await requireAuth();
  const entry = await db.policyCashValue.create({
    data: {
      policyId,
      asOf: new Date(input.asOf),
      cashValueCents: input.cashValueCents,
      notes: input.notes,
    },
  });
  revalidatePath("/personal/insurance");
  return entry;
}

// ── Document upload (two-phase direct-to-storage) ────────────────────────────
//
// Raw file bytes never travel through a Route Handler/Server Action request
// body — Vercel enforces a hard, non-configurable 4.5MB cap on Serverless
// Function request bodies, which broke uploads over ~4.4MB when this used to
// POST FormData with the file attached directly to
// app/api/insurance/[policyId]/upload/route.ts (now deleted, fully replaced
// by the two exports below). Instead: (1) requestInsuranceUploadSlot mints a
// signed Supabase Storage upload URL, (2) the client PUTs the file bytes
// straight to storage, bypassing the Next.js server entirely, (3)
// finalizeInsuranceUpload creates the Document row, links it onto the
// policy, and runs extraction — in that exact order, matching the original
// route's documented ordering, since later steps depend on earlier ones.
//
// Converted from a Route Handler to Server Actions for consistency with
// every other upload site in the app post-fix (bank statements, documents,
// tax documents all use this same three-step Server Action pattern) — there
// is no functional upload-size reason to keep this one site a Route Handler,
// since a Route Handler's body is subject to the identical Vercel cap.

const requestSlotSchema = z.object({
  policyId: z.string().uuid(),
  fileType: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
});

export type RequestInsuranceUploadSlotInput = z.input<typeof requestSlotSchema>;

export async function requestInsuranceUploadSlot(
  input: RequestInsuranceUploadSlotInput
): Promise<
  | { ok: true; documentId: string; fileKey: string; uploadUrl: string }
  | { ok: false; error: string }
> {
  await requireAuth();

  const parsed = requestSlotSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { policyId, fileType, fileSize } = parsed.data;

  const policy = await db.insurancePolicy.findUnique({ where: { id: policyId } });
  if (!policy) return { ok: false, error: "Policy not found" };

  const validation = validateDocumentFile(fileType, fileSize);
  if (!validation.ok) return { ok: false, error: validation.error };

  const documentId = randomUUID();
  const fileKey = buildDocumentFileKey(policy.entityId, documentId, fileType);
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
  policyId: z.string().uuid(),
  documentId: z.string().uuid(),
  fileKey: z.string().min(1),
  fileType: z.string().min(1),
});

export type FinalizeInsuranceUploadInput = z.input<typeof finalizeSchema>;

export async function finalizeInsuranceUpload(
  input: FinalizeInsuranceUploadInput
): Promise<
  | { ok: true; documentId: string; extraction: ExtractedDocument | null }
  | { ok: false; error: string }
> {
  await requireAuth();

  const parsed = finalizeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { policyId, documentId, fileKey, fileType } = parsed.data;

  // Re-fetch the policy fresh (needed both to re-derive entityId for the
  // fileKey-mismatch check, and because the auto-populate step below must
  // read the *current* policy field values, not values captured at
  // slot-request time).
  const policy = await db.insurancePolicy.findUnique({ where: { id: policyId } });
  if (!policy) return { ok: false, error: "Policy not found" };

  // Defense-in-depth: reject if the client-supplied fileKey doesn't match
  // what the server would have generated for this documentId/entityId/type.
  const expectedFileKey = buildDocumentFileKey(policy.entityId, documentId, fileType);
  if (expectedFileKey !== fileKey) {
    return { ok: false, error: "Upload reference mismatch" };
  }

  // downloadDocumentFile does double duty here: it's both the source bytes
  // for extraction AND the authoritative proof the client's direct PUT
  // actually landed in storage before we write any DB rows.
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

  // 1. Create the Document row.
  await db.document.create({
    data: {
      id: documentId,
      entityId: policy.entityId,
      docType: "insurance_policy",
      fileKey,
      extractionStatus: "processing",
    },
  });

  // 2. Link document to policy immediately so Q&A works even if extraction
  // is slow (original code's own comment, preserved).
  await db.insurancePolicy.update({ where: { id: policyId }, data: { documentId } });

  // 3. Run extraction, then (on success only) auto-populate blank policy
  // fields.
  let extraction: ExtractedDocument | null = null;
  try {
    extraction = await extractDocument(buffer, fileType, "insurance_policy");
    await db.document.update({
      where: { id: documentId },
      data: {
        extractionStatus: "complete",
        extractionData: extraction as unknown as Prisma.InputJsonValue,
        extractionModel: "claude-sonnet-4-6",
        extractedAt: new Date(),
      },
    });

    // Auto-populate blank policy fields from extraction — only fills fields
    // that are currently null, never overwrites a manually-entered value.
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
    console.error("[insurance-upload] extraction failed", { policyId, documentId, err });
    await db.document.update({ where: { id: documentId }, data: { extractionStatus: "failed" } });
  }

  // 4. Deliberate, non-required addition for consistency with every other
  // exported action in this file — the client's existing router.refresh()
  // call means this is functionally redundant either way (the original
  // Route Handler never called revalidatePath).
  revalidatePath("/personal/insurance");

  return { ok: true, documentId, extraction };
}
