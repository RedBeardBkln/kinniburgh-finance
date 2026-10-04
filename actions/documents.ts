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
import {
  extractDocumentOrThrow,
  classifyDocType,
  type ExtractedDocument,
  type TransactionRow,
} from "@/lib/doc-extract";
import {
  STALE_PROCESSING_MS,
  computeLedgerPresence,
  planImport,
  rowDateBounds,
} from "@/lib/statement-import";
import {
  ALREADY_UP_TO_DATE_ERROR,
  NOT_EXTRACTED_TYPE_ERROR,
  VERIFIED_REEXTRACT_ERROR,
  isExtractableDocType,
  isUsableExtraction,
  meetsExtractionExpectation,
  sanitizeExtractionError,
  type ExtractionExpectation,
} from "@/lib/document-extraction-state";
import { appendExtractionEvent, countCorrections } from "@/lib/extraction-corrections";
import { loadLedgerIndexes } from "@/lib/statement-ledger";
import { Prisma } from "@prisma/client";
import {
  MAX_SIZE_BYTES,
  buildDocumentFileKey,
  mimeTypeForFileKey,
  validateDocumentFile,
} from "@/lib/document-upload";
import { getEntityBySlug } from "@/lib/entity";
import { normalizePayee } from "@/lib/tags";
import { isTaxDocType, validateAttribution } from "@/lib/document-attribution";
import { deriveEffectiveDocumentTaxYear, planYearFill } from "@/lib/document-year";
import { resolveEffectiveExtraction } from "@/lib/extraction-effective";
import { generateDocumentName } from "@/lib/doc-naming";
import { RETYPE_TARGETS, isPlaceholderName, retypeBlockReason } from "@/lib/document-retype";
import { DOCUMENT_NAME_MAX } from "@/lib/document-rename";

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
  "donation_receipt",
  "retirement_contribution",
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
  // Optional attribution (who it pertains to + issuer). Validated by
  // validateAttribution below; omitted = Unassigned / no issuer (unchanged).
  subjectType: z.string().nullish(),
  subjectUserId: z.string().nullish(),
  issuerName: z.string().nullish(),
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

  // Reject bad attribution before any storage read or DB write.
  const attribution = validateAttribution({
    subjectType: parsed.data.subjectType,
    subjectUserId: parsed.data.subjectUserId,
    issuerName: parsed.data.issuerName,
  });
  if (!attribution.ok) return { ok: false, error: attribution.error };

  // A well-formed but non-existent person id would otherwise surface as an FK
  // throw at document.create, after the file is already in storage.
  if (attribution.value.subjectType === "person" && attribution.value.subjectUserId) {
    const user = await db.user.findUnique({
      where: { id: attribution.value.subjectUserId },
      select: { id: true },
    });
    if (!user) return { ok: false, error: "That person was not found" };
  }

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
      subjectType: attribution.value.subjectType,
      subjectUserId: attribution.value.subjectUserId,
      issuerName: attribution.value.issuerName,
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
    include: { entity: true, subjectUser: { select: { id: true, name: true } } },
    orderBy: [{ taxYear: "desc" }, { createdAt: "desc" }],
  });
}

// ── Attribution (who a document pertains to + its issuer/payer) ─────────────

const updateAttributionSchema = z.object({
  documentId: z.string().uuid(),
  subjectType: z.string().nullish(),
  subjectUserId: z.string().nullish(),
  issuerName: z.string().nullish(),
});

export type UpdateDocumentAttributionInput = z.input<typeof updateAttributionSchema>;

/**
 * Full-replacement update of a document's attribution: the caller sends all
 * three fields. Writes ONLY subjectType/subjectUserId/issuerName — never
 * archivedAt, fileKey, or extraction data.
 */
export async function updateDocumentAttribution(
  input: UpdateDocumentAttributionInput
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = updateAttributionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const attribution = validateAttribution({
    subjectType: parsed.data.subjectType,
    subjectUserId: parsed.data.subjectUserId,
    issuerName: parsed.data.issuerName,
  });
  if (!attribution.ok) return { error: attribution.error };

  const doc = await db.document.findFirst({
    where: { id: parsed.data.documentId, archivedAt: null },
    select: { id: true },
  });
  if (!doc) return { error: "Document not found" };

  // Clean error instead of an FK violation for a stale/forged user id.
  if (attribution.value.subjectType === "person" && attribution.value.subjectUserId) {
    const user = await db.user.findUnique({
      where: { id: attribution.value.subjectUserId },
      select: { id: true },
    });
    if (!user) return { error: "That person was not found" };
  }

  await db.document.update({
    where: { id: doc.id },
    data: {
      subjectType: attribution.value.subjectType,
      subjectUserId: attribution.value.subjectUserId,
      issuerName: attribution.value.issuerName,
    },
  });

  revalidatePath("/documents");
  revalidatePath("/tax");
  return { success: true };
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

interface ExtractionRun {
  result: ExtractedDocument | null;
  /** Human-readable reason when result is null. Never contains document text. */
  error?: string;
}

/**
 * Options for a run. `force` re-runs even when usable data exists.
 * `discardVerification` is the explicit opt-in required to re-extract a
 * VERIFIED document (it clears the verification on success; corrections are
 * never touched). `expect` re-checks, against the freshly read row, that the
 * caller's view (a list / a bulk run) is still true, so a stale tab cannot
 * double-spend an API call.
 */
export interface RunExtractionOptions {
  force?: boolean;
  discardVerification?: boolean;
  expect?: ExtractionExpectation;
}

async function runExtraction(
  documentId: string,
  options?: RunExtractionOptions,
  actingUserId?: string
): Promise<ExtractionRun> {
  // archivedAt guard: an archived document is never extracted (and findFirst,
  // not findUniqueOrThrow, so a missing/archived id is a clean error).
  const doc = await db.document.findFirst({
    where: { id: documentId, archivedAt: null },
    include: { bankStatement: { include: { account: { select: { accountType: true } } } } },
  });
  if (!doc) return { result: null, error: "Document not found" };

  // Gate 1: only types with an extraction schema. Rejected BEFORE any storage
  // download or API call, for every entry point (list, review page, tax tab,
  // bulk, cron).
  if (!isExtractableDocType(doc.docType)) {
    return { result: null, error: NOT_EXTRACTED_TYPE_ERROR };
  }

  // Cheap early exit using this call's own read: avoids even attempting the
  // claim below when we can already see good data. Not sufficient on its
  // own — see the claim's WHERE clause for why.
  const existingData = doc.extractionData as unknown as ExtractedDocument | null;
  const existingUsable = isUsableExtraction(doc.docType, existingData);

  // Gate 2: the caller's expectation, re-checked against THIS read.
  if (options?.expect) {
    const stillWanted = meetsExtractionExpectation(options.expect, {
      docType: doc.docType,
      extractionStatus: doc.extractionStatus,
      updatedAt: doc.updatedAt,
      extractionData: doc.extractionData,
      extractionConfirmedAt: doc.extractionConfirmedAt,
      correctionCount: countCorrections(doc.extractionCorrections),
      extractionError: doc.extractionError,
    });
    if (!stillWanted) return { result: null, error: ALREADY_UP_TO_DATE_ERROR };
  }

  if (!options?.force && existingUsable) {
    return { result: existingData };
  }

  // Gate 3: a verified document is never silently overwritten. Re-extracting
  // marks it unverified, so it needs the caller's explicit opt-in.
  if (
    options?.force &&
    existingUsable &&
    doc.extractionConfirmedAt !== null &&
    !options.discardVerification
  ) {
    return { result: null, error: VERIFIED_REEXTRACT_ERROR };
  }

  // Atomic claim: only proceed if THIS call is the one that transitions
  // status into "processing". A genuine duplicate call for the same
  // document would otherwise race two independent extraction attempts
  // against each other; whichever one's final update landed last would win
  // the extractionStatus field while the other's write to extractionData
  // could still be the one left standing. The loser waits for the winner's
  // real result instead of starting a second, independently-racing attempt.
  //
  // For a non-forced (automatic) call, "complete" is excluded from the
  // claimable set too, not just "processing" — otherwise a call whose own
  // `doc` read above raced ahead of another call's success would still
  // re-claim an already-good row and re-run extraction from scratch. A
  // forced retry (the "Try again" button) may reclaim "complete" or
  // "failed" — that is the point of an explicit retry.
  //
  // A "processing" row whose lock is older than STALE_PROCESSING_MS is a dead
  // extraction (the serverless function was killed mid-call) and is
  // reclaimable by anyone; without this a killed extraction left the row on
  // "Extraction in progress…" forever with no way out.
  //
  // OR + null (rather than a bare `not`/`notIn`) because Prisma's negation
  // operators on a nullable column don't match NULL rows in the generated
  // SQL (`NULL NOT IN (...)` is UNKNOWN, not TRUE) — omitting the explicit
  // null branch makes the claim silently fail to match every
  // never-yet-attempted document.
  const excludedStatuses = options?.force ? ["processing"] : ["processing", "complete"];
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const claim = await db.document.updateMany({
    where: {
      id: documentId,
      archivedAt: null,
      OR: [
        { extractionStatus: { notIn: excludedStatuses } },
        { extractionStatus: null },
        { extractionStatus: "processing", updatedAt: { lt: staleBefore } },
      ],
    },
    data: { extractionStatus: "processing" },
  });
  if (claim.count === 0) {
    // count === 0 can mean "another call is actively processing" (wait for
    // it) or "another call already finished between our initial read and
    // this claim attempt" (that's already the final result, return it).
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const current = await db.document.findUnique({
        where: { id: documentId },
        select: { extractionStatus: true, extractionData: true },
      });
      if (current?.extractionStatus !== "processing") {
        const data = current?.extractionData as unknown as ExtractedDocument | null;
        return isUsableExtraction(doc.docType, data)
          ? { result: data }
          : { result: null, error: "Extraction did not complete" };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { result: null, error: "Another extraction is still running for this document" };
  }

  try {
    const buffer = await downloadDocumentFile(doc.fileKey);
    // pdf / jpeg / png / webp from the fileKey extension; anything else keeps the
    // previous image/jpeg default (a PNG/WebP used to be sent mislabelled).
    const mimeType = mimeTypeForFileKey(doc.fileKey);
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
    // OrThrow: an API error, truncated output, or unparseable response must be
    // recorded as a failure. The lenient extractDocument() returned a stub for
    // those, which this function then saved as a *successful* extraction.
    const result = await extractDocumentOrThrow(buffer, mimeType, docType);

    // A tax form where the model read nothing (every money box null) must not
    // replace good data nor be saved as "complete": treat it as a failure, so a
    // re-extract of a good document keeps the old values.
    if (isTaxDocType(doc.docType) && !isUsableExtraction(doc.docType, result)) {
      throw new Error("The AI read no usable values from this document");
    }

    // Re-extracting a verified document: the SAME write that stores the new AI
    // output also clears the verification and logs who did it. Corrections
    // (the owner's overlay) are never touched.
    const discarding = !!options?.discardVerification && doc.extractionConfirmedAt !== null;
    await db.document.update({
      where: { id: documentId },
      data: {
        extractionStatus: "complete",
        extractionData: result as unknown as Prisma.InputJsonValue,
        extractionModel: "claude-sonnet-4-6",
        extractedAt: new Date(),
        extractionError: null,
        ...(discarding
          ? {
              extractionConfirmedAt: null,
              extractionConfirmedById: null,
              extractionCorrections: appendExtractionEvent(doc.extractionCorrections, {
                type: "re-extracted",
                at: new Date().toISOString(),
                by: actingUserId ?? "unknown",
              }) as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
    });

    // Fill a MISSING year from what was just read (never overrides a year that
    // is already set). Deliberately a SEPARATE guarded updateMany, not part of
    // the write above: an extraction takes 20-60 s, so `doc.taxYear` (read at
    // the top) can be stale by now. `update` cannot carry a `taxYear IS NULL`
    // condition without throwing on a mismatch (which would fail the whole
    // extraction write), whereas `updateMany` with the null guard is race-safe
    // and silently no-ops if the owner set a year in the meantime. Best-effort
    // and in its own try/catch for the same reason as the revalidation below:
    // the extraction already succeeded, so a failure here must never reach the
    // outer catch and flip a good "complete" to "failed". The Documents-page
    // "fill in missing years" button is the safety net for any miss.
    try {
      if (doc.taxYear == null) {
        const year = deriveEffectiveDocumentTaxYear({
          docType: doc.docType,
          extractionData: result,
          extractionCorrections: doc.extractionCorrections,
          extractionConfirmedAt: discarding ? null : doc.extractionConfirmedAt,
        });
        if (year !== null) {
          await db.document.updateMany({
            where: { id: documentId, archivedAt: null, taxYear: null },
            data: { taxYear: year },
          });
        }
      }
    } catch {
      // best effort — see comment above.
    }

    // Donation receipts and retirement statements only: refresh a PLACEHOLDER name
    // ("Donation Receipt" / "Retirement Contributions" or empty, e.g. right after a
    // retype from "Other") from what was just read (charity or trustee + year).
    // A name the owner typed is never touched. Same best-effort rules as the year
    // fill above: its own try/catch (must never
    // flip a good "complete" to "failed"), and a guarded updateMany that
    // silently no-ops if the name changed while the 20-60 s extraction ran.
    if (doc.docType === "donation_receipt" || doc.docType === "retirement_contribution") {
      try {
        if (isPlaceholderName(doc.documentName, doc.docType, doc.taxYear)) {
          const effectiveInput = {
            docType: doc.docType,
            extractionData: result,
            extractionCorrections: doc.extractionCorrections,
            extractionConfirmedAt: discarding ? null : doc.extractionConfirmedAt,
          };
          const effective = resolveEffectiveExtraction(effectiveInput);
          const year = doc.taxYear ?? deriveEffectiveDocumentTaxYear(effectiveInput);
          const newName = generateDocumentName(
            doc.docType,
            year,
            effective.extractionData as Pick<ExtractedDocument, "docType" | "data">
          );
          if (newName !== doc.documentName) {
            await db.document.updateMany({
              where: { id: documentId, archivedAt: null, documentName: doc.documentName },
              data: { documentName: newName },
            });
          }
        }
      } catch {
        // best effort — see comment above.
      }
    }

    // Best-effort only, deliberately outside the try/catch that decides
    // success vs failure: the extraction already succeeded and was persisted
    // above, so a revalidation failure must never flip it to "failed".
    // (Historically this was called during a page render, where Next.js
    // throws on revalidatePath — that throw used to land in the catch below
    // and overwrite a just-written "complete" with "failed".)
    try {
      revalidatePath("/documents");
      revalidatePath(`/documents/${documentId}/review`);
    } catch {
      // ignore — see comment above.
    }
    return { result };
  } catch (err) {
    const message = sanitizeExtractionError(err);
    // A failed re-run of a document that ALREADY has usable data must not
    // turn it into a "failed" document: the old data is intact, so restore
    // "complete" and record the reason (shown as "last re-extract failed").
    await db.document.update({
      where: { id: documentId },
      data: {
        extractionStatus: existingUsable ? "complete" : "failed",
        extractionError: message,
      },
    });
    return { result: null, error: message };
  }
}

export async function triggerExtraction(
  documentId: string,
  options?: RunExtractionOptions
): Promise<ExtractedDocument | null> {
  const user = await requireAuth();
  return (await runExtraction(documentId, options, user.id)).result;
}

/**
 * Client-facing wrapper for the review page's extraction runner and the
 * Documents list. Unlike triggerExtraction it reports WHY a run failed so the
 * UI can show it. Runs as a real server action (not during a page render), so
 * a slow extraction no longer blocks — or gets killed with — the page
 * navigation. Options come from the browser, so they are re-narrowed here.
 */
export async function runDocumentExtraction(
  documentId: string,
  options?: RunExtractionOptions
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireAuth();
  const safeOptions: RunExtractionOptions = {
    force: options?.force === true,
    discardVerification: options?.discardVerification === true,
    expect: options?.expect === "unextracted" || options?.expect === "outdated" ? options.expect : undefined,
  };
  const run = await runExtraction(documentId, safeOptions, user.id);
  return run.result ? { ok: true } : { ok: false, error: run.error ?? "Extraction failed" };
}

// ── Change a document's type (the /documents "Change type" control) ──────────

const changeDocumentTypeSchema = z.object({
  documentId: z.string().uuid(),
  docType: z.string().refine((value) => RETYPE_TARGETS.includes(value), "That document type cannot be chosen here."),
});

/**
 * Switches a document among the retypable (tax-ish) types. It does NOT call the
 * AI: it reports `extract: true` when the new type has an extraction schema and
 * the client then runs `runDocumentExtraction(id, { force: true })` (the same
 * two-step pattern as the tax workspace's "Rename / retype"). A VERIFIED
 * document is refused ("un-verify first", the same rule updateTaxDocument
 * enforces) and the write itself is guarded against a verification landing
 * between the read and the write. Stale extraction data/corrections from the
 * old type are left in place (never deleted): they are inert for the new
 * schema and the row reads "not usable / retry" until it is re-read.
 */
export async function changeDocumentType(input: {
  documentId: string;
  docType: string;
}): Promise<{ ok: true; changed: boolean; extract: boolean } | { ok: false; error: string }> {
  await requireAuth();

  const parsed = changeDocumentTypeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { documentId, docType: nextDocType } = parsed.data;

  const doc = await db.document.findFirst({
    where: { id: documentId, archivedAt: null },
    select: { docType: true, extractionConfirmedAt: true, documentName: true, taxYear: true },
  });
  if (!doc) return { ok: false, error: "Document not found" };

  const blocked = retypeBlockReason({
    currentDocType: doc.docType,
    nextDocType,
    verified: doc.extractionConfirmedAt !== null,
  });
  if (blocked) return { ok: false, error: blocked };
  if (doc.docType === nextDocType) return { ok: true, changed: false, extract: false };

  // A placeholder name follows the type; a name the owner typed is kept.
  const refreshName = isPlaceholderName(doc.documentName, doc.docType, doc.taxYear);
  const written = await db.document.updateMany({
    where: { id: documentId, archivedAt: null, docType: doc.docType, extractionConfirmedAt: null },
    data: {
      docType: nextDocType,
      ...(refreshName ? { documentName: generateDocumentName(nextDocType, doc.taxYear, null) } : {}),
    },
  });
  if (written.count === 0) {
    return { ok: false, error: "The document changed while you were editing - reload and try again." };
  }

  // Best-effort, outside the success/failure decision (revalidatePath can throw
  // outside a request context).
  try {
    revalidatePath("/documents");
    revalidatePath("/tax");
    revalidatePath(`/documents/${documentId}/review`);
  } catch {
    // ignore
  }
  return { ok: true, changed: true, extract: isExtractableDocType(nextDocType) };
}

// ── Rename a document (the /documents "Rename" control) ──────────────────────

const renameDocumentSchema = z.object({
  documentId: z.string().uuid(),
  documentName: z
    .string()
    .trim()
    .min(1, "Enter a name for the document.")
    .max(DOCUMENT_NAME_MAX, `The name can be at most ${DOCUMENT_NAME_MAX} characters.`),
});

export type RenameDocumentInput = z.input<typeof renameDocumentSchema>;

/**
 * Sets a document's display name. It writes ONLY `documentName`: the file, the
 * type, the extraction and its verification are untouched, so renaming is allowed
 * even for a verified document (unlike a retype). The audit entry carries ids and
 * the field name only, never the name text.
 */
export async function renameDocument(
  input: RenameDocumentInput
): Promise<{ ok: true; changed: boolean; documentName: string } | { ok: false; error: string }> {
  const user = await requireAuth();
  const userId = user.id;
  if (!userId) return { ok: false, error: "Unauthorized" };

  const parsed = renameDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { documentId, documentName } = parsed.data;

  const doc = await db.document.findFirst({
    where: { id: documentId, archivedAt: null },
    select: { id: true, documentName: true },
  });
  if (!doc) return { ok: false, error: "Document not found" };
  if (doc.documentName === documentName) return { ok: true, changed: false, documentName };

  const written = await db.document.updateMany({
    where: { id: documentId, archivedAt: null },
    data: { documentName },
  });
  if (written.count === 0) return { ok: false, error: "Document not found" };

  await db.auditLog.create({
    data: {
      changedBy: userId,
      changeType: "document_rename",
      before: { documentId, field: "documentName" },
      after: { documentId, field: "documentName", length: documentName.length },
    },
  });

  // Best-effort, outside the success/failure decision.
  try {
    revalidatePath("/documents");
    revalidatePath("/tax");
    revalidatePath(`/documents/${documentId}/review`);
  } catch {
    // ignore
  }
  return { ok: true, changed: true, documentName };
}

/**
 * User-initiated backfill for the "No year" documents: sets Document.taxYear
 * from the year each document's already-stored extraction says it covers
 * (planYearFill, the same plan the /documents page counts from). It reads and
 * writes only the database: no storage, no Anthropic, no extraction. Only
 * non-archived rows whose taxYear is NULL are read, and every write carries the
 * same `taxYear: null` + `archivedAt: null` guards, so a year that is already
 * set (including one set concurrently) is never changed. `updated` is what the
 * database reports it changed, not what was planned.
 */
export async function fillMissingDocumentYears(): Promise<{ updated: number; skippedNoYear: number }> {
  await requireAuth();
  const rows = await db.document.findMany({
    where: { archivedAt: null, taxYear: null },
    select: { id: true, docType: true, extractionData: true, extractionCorrections: true, extractionConfirmedAt: true },
  });
  const plan = planYearFill(rows);

  const idsByYear = new Map<number, string[]>();
  for (const fill of plan.fills) {
    const ids = idsByYear.get(fill.year);
    if (ids) ids.push(fill.id);
    else idsByYear.set(fill.year, [fill.id]);
  }

  let updated = 0;
  for (const [year, ids] of idsByYear) {
    const res = await db.document.updateMany({
      where: { id: { in: ids }, archivedAt: null, taxYear: null },
      data: { taxYear: year },
    });
    updated += res.count;
  }

  // Non-fatal: the writes above already succeeded.
  try {
    revalidatePath("/documents");
    revalidatePath("/tax");
  } catch {
    // ignore
  }
  return { updated, skippedNoYear: plan.skippedNoYear };
}

/**
 * Owner confirmation for NON-tax extracted documents (insurance policy, utility
 * bill, mortgage statement, ...). It records WHO verified it and WHEN; it no
 * longer rewrites extractionData (the browser used to post the object back,
 * and a client-supplied blob must never replace the AI original). Tax
 * documents are verified through their own review flow, never here.
 */
export async function confirmDocExtraction(
  documentId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireAuth();
  const doc = await db.document.findFirst({
    where: { id: documentId, archivedAt: null },
    select: { id: true, docType: true },
  });
  if (!doc) return { ok: false, error: "Document not found" };
  if (isTaxDocType(doc.docType)) {
    return {
      ok: false,
      error: "Tax documents are reviewed and verified on their own review screen (Review link).",
    };
  }
  await db.document.update({
    where: { id: doc.id },
    data: {
      extractionConfirmedAt: new Date(),
      extractionConfirmedById: user.id,
    },
  });
  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}/review`);
  return { ok: true };
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

export type ImportStatementResult =
  | { ok: true; imported: number; skipped: number; invalid: number }
  | { ok: false; error: string };

export async function importStatementTransactions(
  documentId: string,
  selectedIndices: number[],
  accountId: string,
  businessExpenseIndices: number[] = []
): Promise<ImportStatementResult> {
  await requireAuth();

  const doc = await db.document.findFirst({ where: { id: documentId, archivedAt: null } });
  if (!doc) return { ok: false, error: "Document not found" };

  const extraction = doc.extractionData as unknown as ExtractedDocument | null;
  const rows: unknown[] = extraction?.transactionRows ?? [];
  if (rows.length === 0) return { ok: true, imported: 0, skipped: 0, invalid: 0 };

  const account = await db.account.findFirst({
    where: { id: accountId, archivedAt: null },
    include: { entity: { select: { id: true, type: true } } },
  });
  if (!account) return { ok: false, error: "Target account not found" };

  // Personal-vs-business separation is a core invariant: never let a
  // statement's rows land in another entity's account, whatever the client
  // sent. (The review page's picker is already entity-scoped; this is the
  // server-side enforcement.)
  if (account.entityId !== doc.entityId) {
    return { ok: false, error: "That account belongs to a different entity than this statement" };
  }

  // Fail closed: the business-expense override is only meaningful (and only
  // rendered in the review UI) for a Personal-entity account's statement.
  // The server never trusts the client on this — reject any non-empty
  // businessExpenseIndices against a non-Personal account outright.
  if (businessExpenseIndices.length > 0 && account.entity.type !== "personal") {
    return {
      ok: false,
      error: "The business-expense override can only be used when importing into a Personal-entity account",
    };
  }

  // Resolved once, only when actually needed — never trust a client-supplied
  // entityId for the override target.
  let ekConsultingEntityId: string | null = null;
  if (businessExpenseIndices.length > 0) {
    const ekEntity = await getEntityBySlug("ek-consulting");
    if (!ekEntity) {
      return { ok: false, error: "EK Consulting entity not found — cannot apply business-expense override" };
    }
    ekConsultingEntityId = ekEntity.id;
  }
  const businessExpenseSet = new Set(businessExpenseIndices);

  // Duplicate check against the ledger as it stands now. Multiplicity-aware
  // (see planImport): only as many identical rows are skipped as already
  // exist, so two genuine identical same-day charges both import.
  const bounds = rowDateBounds(rows);
  const ledgerIndexes = bounds
    ? await loadLedgerIndexes([accountId], bounds.from, bounds.to)
    : new Map<string, Map<string, number>>();
  const plan = planImport(rows, selectedIndices, ledgerIndexes.get(accountId) ?? new Map());

  if (plan.toCreate.length > 0) {
    // One INSERT, so the import is all-or-nothing — the old per-row loop could
    // fail halfway and leave a partial import behind.
    await db.transaction.createMany({
      data: plan.toCreate.map((i) => {
        const row = rows[i] as TransactionRow; // validated by planImport
        return {
          accountId,
          entityId:
            businessExpenseSet.has(i) && ekConsultingEntityId ? ekConsultingEntityId : account.entityId,
          postedAt: new Date(`${row.date}T12:00:00Z`),
          amount: new Prisma.Decimal(row.amountCents).div(100),
          payeeRaw: row.description,
          // normalizePayee(), not a raw slice — matches the convention
          // documented in CLAUDE.md and used by Plaid sync.
          payeeNormalized: normalizePayee(row.description).slice(0, 100),
          source: "import",
          pending: false,
        };
      }),
    });
  }

  revalidatePath("/transactions");
  return { ok: true, imported: plan.toCreate.length, skipped: plan.duplicates, invalid: plan.invalid };
}

/**
 * For each entity account, which of this document's extracted rows are
 * already in that account's ledger (index-aligned with transactionRows).
 * Lets the review page pre-uncheck rows that would only be skipped as
 * duplicates and show an "already in ledger" badge.
 */
export async function getLedgerPresenceByAccount(
  documentId: string,
  accountIds: string[]
): Promise<Record<string, boolean[]>> {
  await requireAuth();
  const doc = await db.document.findFirst({
    where: { id: documentId, archivedAt: null },
    select: { entityId: true, extractionData: true },
  });
  const rows: unknown[] = (doc?.extractionData as unknown as ExtractedDocument | null)?.transactionRows ?? [];
  const bounds = rowDateBounds(rows);
  if (!doc || !bounds || accountIds.length === 0) return {};

  // Scoped to the document's own entity so this can't be used to probe
  // another entity's ledger.
  const owned = await db.account.findMany({
    where: { id: { in: accountIds }, entityId: doc.entityId, archivedAt: null },
    select: { id: true },
  });
  const indexes = await loadLedgerIndexes(owned.map((a) => a.id), bounds.from, bounds.to);
  const out: Record<string, boolean[]> = {};
  for (const [id, index] of indexes) out[id] = computeLedgerPresence(rows, index);
  return out;
}

export async function getDocumentWithExtraction(documentId: string) {
  await requireAuth();
  return db.document.findUniqueOrThrow({
    where: { id: documentId },
    include: {
      entity: true,
      extractionConfirmedBy: { select: { id: true, name: true } },
      bankStatement: {
        select: { accountId: true, confirmedAt: true, account: { select: { accountType: true } } },
      },
    },
  });
}
