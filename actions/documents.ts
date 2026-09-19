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
  hasUsableExtraction,
  planImport,
  rowDateBounds,
} from "@/lib/statement-import";
import { loadLedgerIndexes } from "@/lib/statement-ledger";
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

interface ExtractionRun {
  result: ExtractedDocument | null;
  /** Human-readable reason when result is null. Never contains document text. */
  error?: string;
}

async function runExtraction(
  documentId: string,
  options?: { force?: boolean }
): Promise<ExtractionRun> {
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    include: { bankStatement: { include: { account: { select: { accountType: true } } } } },
  });

  // Cheap early exit using this call's own read: avoids even attempting the
  // claim below when we can already see good data. Not sufficient on its
  // own — see the claim's WHERE clause for why.
  const existingData = doc.extractionData as unknown as ExtractedDocument | null;
  if (!options?.force && hasUsableExtraction(existingData)) {
    return { result: existingData };
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
        return hasUsableExtraction(data)
          ? { result: data }
          : { result: null, error: "Extraction did not complete" };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { result: null, error: "Another extraction is still running for this document" };
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
    // OrThrow: an API error, truncated output, or unparseable response must be
    // recorded as a failure. The lenient extractDocument() returned a stub for
    // those, which this function then saved as a *successful* extraction.
    const result = await extractDocumentOrThrow(buffer, mimeType, docType);

    await db.document.update({
      where: { id: documentId },
      data: {
        extractionStatus: "complete",
        extractionData: result as unknown as Prisma.InputJsonValue,
        extractionModel: "claude-sonnet-4-6",
        extractedAt: new Date(),
      },
    });

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
    await db.document.update({
      where: { id: documentId },
      data: { extractionStatus: "failed" },
    });
    return { result: null, error: err instanceof Error ? err.message : "Extraction failed" };
  }
}

export async function triggerExtraction(
  documentId: string,
  options?: { force?: boolean }
): Promise<ExtractedDocument | null> {
  await requireAuth();
  return (await runExtraction(documentId, options)).result;
}

/**
 * Client-facing wrapper for the review page's extraction runner. Unlike
 * triggerExtraction it reports WHY a run failed so the page can show it.
 * Runs as a real server action (not during a page render), so a slow
 * extraction no longer blocks — or gets killed with — the page navigation.
 */
export async function runDocumentExtraction(
  documentId: string,
  options?: { force?: boolean }
): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireAuth();
  const run = await runExtraction(documentId, options);
  return run.result ? { ok: true } : { ok: false, error: run.error ?? "Extraction failed" };
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
      bankStatement: {
        select: { accountId: true, confirmedAt: true, account: { select: { accountType: true } } },
      },
    },
  });
}
