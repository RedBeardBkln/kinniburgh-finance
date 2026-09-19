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
import { getEntityBySlug } from "@/lib/entity";
import { normalizePayee } from "@/lib/tags";

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

export async function triggerExtraction(
  documentId: string,
  options?: { force?: boolean }
): Promise<ExtractedDocument | null> {
  await requireAuth();

  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    include: { bankStatement: { include: { account: { select: { accountType: true } } } } },
  });

  // Cheap early exit using this call's own read: avoids even attempting the
  // claim below when we can already see good data. Not sufficient on its
  // own — see the claim's WHERE clause for why.
  const existingData = doc.extractionData as unknown as ExtractedDocument | null;
  const hasUsableData = !!(
    existingData &&
    ((existingData.transactionRows?.length ?? 0) > 0 || Object.keys(existingData.data ?? {}).length > 0)
  );
  if (!options?.force && hasUsableData) {
    return existingData;
  }

  // Atomic claim: only proceed if THIS call is the one that transitions
  // status into "processing". A genuine duplicate call for the same
  // document — confirmed live: the review page synchronously awaits this
  // for a slow extraction, and an impatient re-click (or a retried
  // navigation) before that resolves fires a second concurrent call — would
  // otherwise race two independent extraction attempts against each other.
  // Whichever one's final update landed last would win the extractionStatus
  // field while the OTHER's write to extractionData/extractedAt could still
  // be the one left standing (the failure path only ever touches
  // extractionStatus), producing exactly the corrupted state found live: a
  // real 12-row successful result sitting under extractionStatus="failed".
  // The loser here waits for the winner's real result instead of starting
  // a second, independently-racing attempt.
  //
  // For a non-forced (automatic) call, "complete" is excluded from the
  // claimable set too, not just "processing" — otherwise a call whose own
  // `doc` read above raced ahead of another call's success (read happened
  // while status was still null, but by the time THIS claim runs the winner
  // has already finished and written "complete") would still match a bare
  // `not: "processing"` guard and re-claim an already-good row, re-running
  // extraction from scratch. Confirmed live twice: a document ended up with
  // real, good extractionData (extractedAt set, real transaction rows)
  // sitting under extractionStatus="failed" because a second, redundant
  // auto-triggered attempt landed *after* the first had already succeeded —
  // the failure path only ever touches extractionStatus, never
  // extractionData, so the good rows survived but the status lied about it.
  // A forced retry (the "Try again" button) is allowed to reclaim
  // "complete" or "failed" — that is the point of an explicit retry — but
  // never "processing", so it can't interrupt a real extraction in flight.
  //
  // OR + null (rather than a bare `not`/`notIn`) because Prisma's negation
  // operators on a nullable column don't match NULL rows in the generated
  // SQL (`NULL <> 'x'` / `NULL NOT IN (...)` are both UNKNOWN, not TRUE) —
  // omitting the explicit null branch makes the claim silently fail to
  // match, and therefore never actually claim, every never-yet-attempted
  // document (status genuinely null). Caught this live too: it made
  // triggerExtraction a permanent no-op for any first-time extraction,
  // worse than the bug it was meant to fix.
  const excludedStatuses = options?.force ? ["processing"] : ["processing", "complete"];
  const claim = await db.document.updateMany({
    where: {
      id: documentId,
      OR: [{ extractionStatus: { notIn: excludedStatuses } }, { extractionStatus: null }],
    },
    data: { extractionStatus: "processing" },
  });
  if (claim.count === 0) {
    // count === 0 can mean "another call is actively processing" (wait for
    // it) or "another call already finished — complete or failed — between
    // our initial read and this claim attempt" (that's already the final
    // result, return it immediately, no need to sleep first).
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const current = await db.document.findUnique({
        where: { id: documentId },
        select: { extractionStatus: true, extractionData: true },
      });
      if (current?.extractionStatus !== "processing") {
        return current?.extractionData as unknown as ExtractedDocument | null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // Gave up waiting — fall through to the existing data rather than
    // leaving the caller hanging forever on a stuck "processing" row.
    return doc.extractionData as unknown as ExtractedDocument | null;
  }

  try {
    const buffer = await downloadDocumentFile(doc.fileKey);
    const mimeType = doc.fileKey.endsWith(".pdf") ? "application/pdf" : "image/jpeg";
    // Document.docType stays the literal "bank_statement" for every
    // BankStatement-linked document regardless of the account's real type
    // (deliberate — avoids adding a new docType value). Derive the actual
    // extraction shape from the *current* linked account instead, so a
    // credit-card account gets the credit_card_statement prompt (charge vs.
    // payment classification) even though Document.docType never changes.
    const docType =
      doc.bankStatement?.account?.accountType === "credit_card"
        ? "credit_card_statement"
        : classifyDocType(doc.docType, doc.fileKey);
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
  accountId: string,
  businessExpenseIndices: number[] = []
): Promise<{ imported: number; skipped: number }> {
  await requireAuth();

  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
  const extraction = doc.extractionData as unknown as ExtractedDocument | null;
  if (!extraction?.transactionRows) return { imported: 0, skipped: 0 };

  const account = await db.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { entity: { select: { id: true, type: true } } },
  });

  // Fail closed: the business-expense override is only meaningful (and only
  // rendered in the review UI) for a Personal-entity account's statement.
  // The server never trusts the client on this — reject any non-empty
  // businessExpenseIndices against a non-Personal account outright.
  if (businessExpenseIndices.length > 0 && account.entity.type !== "personal") {
    throw new Error(
      "businessExpenseIndices can only be used when importing into a Personal-entity account"
    );
  }

  // Resolved once, only when actually needed — never trust a client-supplied
  // entityId for the override target.
  let ekConsultingEntityId: string | null = null;
  if (businessExpenseIndices.length > 0) {
    const ekEntity = await getEntityBySlug("ek-consulting");
    if (!ekEntity) {
      throw new Error("EK Consulting entity not found — cannot apply business-expense override");
    }
    ekConsultingEntityId = ekEntity.id;
  }
  const businessExpenseSet = new Set(businessExpenseIndices);

  let imported = 0;
  let skipped = 0;

  for (const i of selectedIndices) {
    const row = extraction.transactionRows[i];
    if (!row) continue;

    const postedAt = new Date(row.date + "T12:00:00Z");
    const amountDecimal = new Prisma.Decimal(row.amountCents).div(100);
    const entityId = businessExpenseSet.has(i) && ekConsultingEntityId ? ekConsultingEntityId : account.entityId;

    // normalizePayee(), not a raw slice — matches the convention documented
    // in CLAUDE.md and used by Plaid sync. A raw copy here (mixed case,
    // punctuation intact) silently broke tag-rule matching downstream:
    // matchTagRule/alnum() expect an already-lowercased, punctuation-free
    // payee, so an un-normalized value doesn't match text a human sees as
    // identical.
    const payeeNormalized = normalizePayee(row.description).slice(0, 100);

    const existing = await db.transaction.findFirst({
      where: {
        accountId,
        postedAt,
        amount: amountDecimal,
        payeeNormalized,
        archivedAt: null,
      },
    });

    if (existing) {
      skipped++;
      continue;
    }

    await db.transaction.create({
      data: {
        accountId,
        entityId,
        postedAt,
        amount: amountDecimal,
        payeeRaw: row.description,
        payeeNormalized,
        source: "import",
        pending: false,
      },
    });
    imported++;
  }

  revalidatePath("/transactions");
  return { imported, skipped };
}

export async function getDocumentWithExtraction(documentId: string) {
  await requireAuth();
  return db.document.findUniqueOrThrow({
    where: { id: documentId },
    include: {
      entity: true,
      bankStatement: {
        select: { accountId: true, confirmedAt: true, account: { select: { accountType: true } } },
      },
    },
  });
}
