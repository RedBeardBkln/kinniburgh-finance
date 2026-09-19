"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import {
  extractBankStatement,
  type ExtractedStatement,
  type StatementAccountRow,
} from "@/lib/bank-statement-extract";
import { downloadTaxFile, getTaxSignedUploadUrl } from "@/lib/supabase-storage";
import {
  MAX_SIZE_BYTES,
  buildStatementFileKey,
  validateStatementFile,
} from "@/lib/bank-statement-upload";
import { runWithConcurrencyLimit } from "@/lib/concurrency";
import { triggerExtraction, importStatementTransactions } from "@/actions/documents";
import type { ImportStatementResult } from "@/actions/documents";
import { needsCreditCardReclassification, normalizeBalanceCents } from "@/lib/statement-review";
import type { ExtractedDocument } from "@/lib/doc-extract";
import {
  computeLedgerPresence,
  deriveStatementStage,
  effectiveDocumentStatus,
  hasUsableExtraction,
  importableRowIndices,
  rowDateBounds,
  type StatementStage,
} from "@/lib/statement-import";
import { loadLedgerIndexes } from "@/lib/statement-ledger";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user as { id: string; name?: string | null; email: string };
}

// ── Upload (two-phase direct-to-storage) ────────────────────────────────────────
//
// Raw file bytes never travel through a Server Action's request body — Vercel
// enforces a hard, non-configurable 4.5MB cap on Serverless Function request
// bodies, which broke folder/batch uploads (and any single statement over
// ~4.4MB) when this used to send FormData with the file attached directly.
// Instead: (1) requestStatementUploadSlot mints a signed Supabase Storage
// upload URL, (2) the client PUTs the file bytes straight to storage,
// bypassing the Next.js server entirely, (3) finalizeStatementUpload creates
// the Document/BankStatement rows and (single mode only) runs extraction.

const requestSlotSchema = z.object({
  entityId: z.string().uuid(),
  fileType: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
});

export type RequestStatementUploadSlotInput = z.input<typeof requestSlotSchema>;

export async function requestStatementUploadSlot(
  input: RequestStatementUploadSlotInput
): Promise<
  | { ok: true; statementId: string; fileKey: string; uploadUrl: string }
  | { ok: false; error: string }
> {
  await requireAuth();

  const parsed = requestSlotSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { entityId, fileType, fileSize } = parsed.data;

  const entity = await db.entity.findUnique({ where: { id: entityId } });
  if (!entity) return { ok: false, error: "Entity not found" };

  const validation = validateStatementFile(fileType, fileSize);
  if (!validation.ok) return { ok: false, error: validation.error };

  const statementId = randomUUID();
  const fileKey = buildStatementFileKey(entityId, statementId, fileType);
  if (!fileKey) {
    // Should be unreachable given validateStatementFile above, but keep this
    // typed-safe rather than asserting non-null.
    return { ok: false, error: "Unsupported file type" };
  }

  try {
    const uploadUrl = await getTaxSignedUploadUrl(fileKey);
    return { ok: true, statementId, fileKey, uploadUrl };
  } catch (e) {
    return {
      ok: false,
      error: `Could not prepare upload: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }
}

const finalizeSchema = z.object({
  statementId: z.string().uuid(),
  fileKey: z.string().min(1),
  entityId: z.string().uuid(),
  fileType: z.string().min(1),
  mode: z.enum(["single", "batch"]),
  accountId: z.string().uuid().optional(),
  notes: z.string().max(500).optional(),
});

export type FinalizeStatementUploadInput = z.input<typeof finalizeSchema>;

export async function finalizeStatementUpload(
  input: FinalizeStatementUploadInput
): Promise<
  | { ok: true; statementId: string; extraction: ExtractedStatement | null }
  | { ok: false; error: string }
> {
  const user = await requireAuth();

  const parsed = finalizeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { statementId, fileKey, entityId, fileType, mode, accountId, notes } = parsed.data;

  // Defense-in-depth: reject if the client-supplied fileKey doesn't match
  // what the server would have generated for this statementId/entityId/type.
  const expectedFileKey = buildStatementFileKey(entityId, statementId, fileType);
  if (expectedFileKey !== fileKey) {
    return { ok: false, error: "Upload reference mismatch" };
  }

  const entity = await db.entity.findUnique({ where: { id: entityId } });
  if (!entity) return { ok: false, error: "Entity not found" };

  let linkedAccountType: string | null = null;
  if (accountId) {
    const account = await db.account.findFirst({
      where: { id: accountId, entityId: entity.id, archivedAt: null },
    });
    if (!account) return { ok: false, error: "Account not found for this entity" };
    linkedAccountType = account.accountType;
  }

  // downloadTaxFile does double duty here: it's both the source bytes for
  // single-mode extraction AND the authoritative proof the client's direct
  // PUT actually landed in storage before we write any DB rows.
  let buffer: Buffer;
  try {
    buffer = await downloadTaxFile(fileKey);
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

  const docId = randomUUID();

  // Statement is tax-relevant bookkeeping evidence → Document vault too.
  await db.document.create({
    data: {
      id: docId,
      entityId: entity.id,
      docType: "bank_statement",
      fileKey,
      notes: notes ?? null,
      documentName: `Bank statement — ${entity.name}`,
    },
  });

  await db.bankStatement.create({
    data: {
      id: statementId,
      entityId: entity.id,
      documentId: docId,
      accountId: accountId ?? null,
      // Placeholder period until extraction fills it in; required NOT NULL fields
      periodStart: new Date(),
      periodEnd: new Date(),
      extractStatus: mode === "single" ? "processing" : "pending",
      notes: notes ?? null,
      uploadedBy: user.id,
    },
  });

  if (mode === "batch") {
    // Deliberately skip extraction in batch mode (speed/cost for large
    // folders) — the row lands as "pending" for manual confirmation via the
    // existing statements table UI.
    revalidatePath("/business");
    return { ok: true, statementId, extraction: null };
  }

  let extraction: ExtractedStatement | null = null;
  try {
    extraction = await extractBankStatement(buffer, fileType);

    const periodStart = extraction.periodStart
      ? new Date(`${extraction.periodStart}T00:00:00Z`)
      : null;
    const periodEnd = extraction.periodEnd
      ? new Date(`${extraction.periodEnd}T00:00:00Z`)
      : null;

    if (periodStart && periodEnd && periodEnd >= periodStart) {
      const singleAccount = extraction.accounts.length === 1 ? extraction.accounts[0] : null;

      await db.bankStatement.update({
        where: { id: statementId },
        data: {
          periodStart,
          periodEnd,
          institutionName: singleAccount?.institutionName ?? null,
          accountMask: singleAccount?.accountMask ?? null,
          openingBalance: balanceToDecimal(singleAccount?.openingBalanceCents, linkedAccountType),
          closingBalance: balanceToDecimal(singleAccount?.closingBalanceCents, linkedAccountType),
          extractStatus: "complete",
          extractionData: extraction as unknown as Prisma.InputJsonValue,
          extractModel: "claude-sonnet-4-6",
        },
      });

      // Bank-statement Documents never got a taxYear at creation (the period
      // isn't known until extraction runs) — set it now, using periodEnd's
      // calendar year as the pragmatic choice for a statement whose period
      // spans a year boundary (e.g. Dec 28 -> Jan 27).
      await db.document.update({
        where: { id: docId },
        data: { taxYear: periodEnd.getUTCFullYear() },
      });
    } else {
      await db.bankStatement.update({
        where: { id: statementId },
        data: {
          extractStatus: "failed",
          extractionData: extraction as unknown as Prisma.InputJsonValue,
        },
      });
    }
  } catch {
    await db.bankStatement.update({
      where: { id: statementId },
      data: { extractStatus: "failed" },
    });
  }

  revalidatePath("/business");
  return { ok: true, statementId, extraction };
}

export interface BatchUploadItemResult {
  fileName: string;
  ok: boolean;
  statementId?: string;
  error?: string;
}

function centsToDecimal(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).div(100);
}

// A statement balance as a stored Decimal, sign-normalized for the linked
// account type (liabilities are stored as the positive amount owed — see
// normalizeBalanceCents). Null/undefined stay null.
function balanceToDecimal(
  cents: number | null | undefined,
  accountType: string | null | undefined
): Prisma.Decimal | null {
  const normalized = normalizeBalanceCents(cents ?? null, accountType);
  return normalized === null ? null : centsToDecimal(normalized);
}

// ── List / fetch ───────────────────────────────────────────────────────────────

export interface BankStatementRow {
  id: string;
  documentId: string | null;
  accountId: string | null;
  accountNickname: string | null;
  periodStart: Date;
  periodEnd: Date;
  institutionName: string | null;
  accountMask: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  /** Period/balance extraction status only (BankStatement.extractStatus). */
  extractStatus: string;
  confirmedAt: Date | null;
  notes: string | null;
  createdAt: Date;
  /**
   * Where the statement's TRANSACTIONS stand, derived from the document's
   * extracted rows and the actual ledger (see lib/statement-import.ts).
   * Independent of extractStatus, which only says whether the period and
   * balances were read.
   */
  stage: StatementStage;
  importableRows: number;
  rowsInLedger: number;
}

export async function listBankStatements(entityId: string): Promise<BankStatementRow[]> {
  await requireAuth();

  const statements = await db.bankStatement.findMany({
    where: { entityId, archivedAt: null },
    include: {
      account: { select: { nickname: true } },
      document: { select: { extractionStatus: true, extractionData: true, updatedAt: true } },
    },
    orderBy: { periodEnd: "desc" },
  });

  const rowsOf = (s: (typeof statements)[number]): unknown[] =>
    (s.document?.extractionData as unknown as ExtractedDocument | null)?.transactionRows ?? [];

  // One ledger read for the whole list, bounded to the span the extracted
  // rows actually cover.
  const accountIds = Array.from(
    new Set(statements.map((s) => s.accountId).filter((id): id is string => id !== null))
  );
  const bounds = rowDateBounds(statements.flatMap(rowsOf));
  const ledgerIndexes = bounds
    ? await loadLedgerIndexes(accountIds, bounds.from, bounds.to)
    : new Map<string, Map<string, number>>();

  return statements.map((s) => {
    const extraction = s.document?.extractionData as unknown as ExtractedDocument | null;
    const rows = rowsOf(s);
    const importable = importableRowIndices(rows);
    const presence = computeLedgerPresence(
      rows,
      (s.accountId ? ledgerIndexes.get(s.accountId) : undefined) ?? new Map()
    );
    const rowsInLedger = importable.filter((i) => presence[i]).length;
    const usable = hasUsableExtraction(extraction);

    return {
      id: s.id,
      documentId: s.documentId,
      accountId: s.accountId,
      accountNickname: s.account?.nickname ?? null,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      institutionName: s.institutionName,
      accountMask: s.accountMask,
      openingBalance: s.openingBalance?.toFixed(2) ?? null,
      closingBalance: s.closingBalance?.toFixed(2) ?? null,
      extractStatus: s.extractStatus,
      confirmedAt: s.confirmedAt,
      notes: s.notes,
      createdAt: s.createdAt,
      stage: deriveStatementStage({
        documentStatus: s.document
          ? effectiveDocumentStatus(s.document.extractionStatus, s.document.updatedAt)
          : null,
        hasUsableData: usable,
        importableRows: importable.length,
        rowsInLedger,
        confirmed: s.confirmedAt !== null,
      }),
      importableRows: importable.length,
      rowsInLedger,
    };
  });
}

export interface EntityAccountOption {
  id: string;
  nickname: string;
  mask: string | null;
  accountType: string;
  plaidCoverageStart: string | null; // ISO date, or null if never Plaid-synced
}

export async function listEntityAccounts(entityId: string): Promise<EntityAccountOption[]> {
  await requireAuth();
  const accounts = await db.account.findMany({
    where: { entityId, archivedAt: null },
    orderBy: { nickname: "asc" },
    select: { id: true, nickname: true, mask: true, accountType: true },
  });
  if (accounts.length === 0) return [];

  // One extra query for the earliest Plaid-synced transaction per account —
  // used to warn the statement-review UI that a row's date might already be
  // covered by the live Plaid sync (see lib/statement-review.ts). Generic,
  // account-type-agnostic: fires for any Plaid-connected account, not just
  // credit cards.
  const coverage = await db.transaction.groupBy({
    by: ["accountId"],
    where: { accountId: { in: accounts.map((a) => a.id) }, source: "plaid" },
    _min: { postedAt: true },
  });
  const coverageByAccount = new Map(
    coverage.map((c) => [c.accountId, c._min.postedAt?.toISOString().slice(0, 10) ?? null])
  );

  return accounts.map((a) => ({
    ...a,
    plaidCoverageStart: coverageByAccount.get(a.id) ?? null,
  }));
}

// ── Confirm from the document-review page ──────────────────────────────────────
//
// The one action behind "Confirm extraction & import" on /documents/{id}/review.
// Ordering matters and is the point of doing it server-side in one call: the
// rows are imported FIRST, and the statement is only marked confirmed once
// that succeeded. The old client-side sequence (confirm document, import,
// then confirm statement — three separate calls with no error handling) let a
// failed or skipped import leave the UI looking finished with nothing in the
// ledger.
//
// Confirming trusts the displayed period/balances as correct (the same meaning
// "Save & confirm" on the manual edit form has, minus the re-typing). A
// statement can still be confirmed with rows deliberately left out — the list
// shows how many rows are not in the ledger, so that stays visible.
export async function confirmStatementImport(input: {
  documentId: string;
  selectedIndices: number[];
  accountId: string;
  businessExpenseIndices?: number[];
}): Promise<ImportStatementResult> {
  const user = await requireAuth();
  const { documentId, selectedIndices, accountId, businessExpenseIndices } = input;

  const result = await importStatementTransactions(
    documentId,
    selectedIndices,
    accountId,
    businessExpenseIndices ?? []
  );
  if (!result.ok) return result;

  // The import succeeded, so the transaction extraction is settled. Only the
  // status label is touched — extractionData is left exactly as extracted.
  await db.document.update({
    where: { id: documentId },
    data: { extractionStatus: "complete" },
  });

  const statement = await db.bankStatement.findFirst({ where: { documentId, archivedAt: null } });
  if (statement) {
    await db.bankStatement.update({
      where: { id: statement.id },
      data: {
        // Keep the original confirmation stamp on a re-import.
        confirmedAt: statement.confirmedAt ?? new Date(),
        confirmedById: statement.confirmedById ?? user.id,
        // The account the rows were imported into is, by definition, this
        // statement's account. importStatementTransactions already verified it
        // belongs to the statement's entity. A statement with no rows to import
        // carries no account (accountId is "") and keeps whatever it had.
        ...(accountId ? { accountId } : {}),
      },
    });
  }

  revalidatePath("/business");
  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}/review`);
  return result;
}

// ── Confirm / correct extraction ───────────────────────────────────────────────

const confirmSchema = z.object({
  statementId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountId: z.string().uuid().optional().or(z.literal("")),
  institutionName: z.string().max(255).optional(),
  accountMask: z
    .string()
    .regex(/^\d{1,4}$/)
    .optional()
    .or(z.literal("")),
  openingBalanceCents: z.number().int().nullable(),
  closingBalanceCents: z.number().int().nullable(),
  notes: z.string().max(500).optional(),
});

export type ConfirmStatementInput = z.input<typeof confirmSchema>;

export async function confirmBankStatement(
  input: ConfirmStatementInput
): Promise<{ success: true } | { error: string }> {
  const user = await requireAuth();

  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const statement = await db.bankStatement.findUnique({
    where: { id: data.statementId },
  });
  if (!statement || statement.archivedAt) return { error: "Statement not found" };

  const periodStart = new Date(`${data.periodStart}T00:00:00Z`);
  const periodEnd = new Date(`${data.periodEnd}T00:00:00Z`);
  if (periodEnd < periodStart) return { error: "Period end is before period start" };

  let accountType: string | null = null;
  if (data.accountId) {
    const account = await db.account.findFirst({
      where: { id: data.accountId, entityId: statement.entityId, archivedAt: null },
    });
    if (!account) return { error: "Account not found for this entity" };
    accountType = account.accountType;
  }

  await db.bankStatement.update({
    where: { id: data.statementId },
    data: {
      periodStart,
      periodEnd,
      accountId: data.accountId || null,
      institutionName: data.institutionName || null,
      accountMask: data.accountMask || null,
      openingBalance: balanceToDecimal(data.openingBalanceCents, accountType),
      closingBalance: balanceToDecimal(data.closingBalanceCents, accountType),
      notes: data.notes ?? statement.notes,
      extractStatus: "complete",
      confirmedAt: new Date(),
      confirmedById: user.id,
    },
  });

  // Same taxYear backfill as the single-upload/retry extraction paths below —
  // this is the one that actually fixes already-uploaded statements, since
  // confirming is the action every unconfirmed statement still needs anyway.
  if (statement.documentId) {
    await db.document.update({
      where: { id: statement.documentId },
      data: { taxYear: periodEnd.getUTCFullYear() },
    });
  }

  revalidatePath("/business");
  return { success: true };
}

// ── Retry extraction ──────────────────────────────────────────────────────────

export async function retryStatementExtraction(
  statementId: string
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const statement = await db.bankStatement.findUnique({
    where: { id: statementId },
  });
  if (!statement || statement.archivedAt) return { error: "Statement not found" };

  const doc = statement.documentId
    ? await db.document.findUnique({ where: { id: statement.documentId } })
    : null;
  if (!doc) return { error: "Linked document not found" };

  await db.bankStatement.update({
    where: { id: statementId },
    data: { extractStatus: "processing" },
  });

  try {
    const buffer = await downloadTaxFile(doc.fileKey);
    const mimeType = doc.fileKey.endsWith(".pdf") ? "application/pdf" : "image/jpeg";
    const extraction = await extractBankStatement(buffer, mimeType);

    const periodStart = extraction.periodStart
      ? new Date(`${extraction.periodStart}T00:00:00Z`)
      : null;
    const periodEnd = extraction.periodEnd
      ? new Date(`${extraction.periodEnd}T00:00:00Z`)
      : null;

    if (!periodStart || !periodEnd || periodEnd < periodStart) {
      await db.bankStatement.update({
        where: { id: statementId },
        data: {
          extractStatus: "failed",
          extractionData: extraction as unknown as Prisma.InputJsonValue,
        },
      });
      return { error: "Extraction could not read the statement period" };
    }

    const singleAccount = extraction.accounts.length >= 1 ? extraction.accounts[0] : null;
    const linkedAccount = statement.accountId
      ? await db.account.findFirst({
          where: { id: statement.accountId, archivedAt: null },
          select: { accountType: true },
        })
      : null;

    await db.bankStatement.update({
      where: { id: statementId },
      data: {
        periodStart,
        periodEnd,
        institutionName: singleAccount?.institutionName ?? null,
        accountMask: singleAccount?.accountMask ?? null,
        openingBalance: balanceToDecimal(singleAccount?.openingBalanceCents, linkedAccount?.accountType),
        closingBalance: balanceToDecimal(singleAccount?.closingBalanceCents, linkedAccount?.accountType),
        extractStatus: "complete",
        extractionData: extraction as unknown as Prisma.InputJsonValue,
        extractModel: "claude-sonnet-4-6",
      },
    });

    // Same taxYear backfill as finalizeStatementUpload/confirmBankStatement.
    await db.document.update({
      where: { id: doc.id },
      data: { taxYear: periodEnd.getUTCFullYear() },
    });

    revalidatePath("/business");
    return { success: true };
  } catch {
    await db.bankStatement.update({
      where: { id: statementId },
      data: { extractStatus: "failed" },
    });
    return { error: "Extraction failed" };
  }
}

export interface RetryAllPendingResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

/**
 * Runs extraction for every currently-pending statement in an entity —
 * i.e. every statement uploaded via batch/folder mode, which deliberately
 * skips extraction at upload time (see finalizeStatementUpload). Reuses
 * retryStatementExtraction per statement (it doesn't care what the prior
 * status was) with bounded concurrency, matching the batch upload's own
 * concurrency limit.
 */
export async function retryAllPendingStatementExtractions(
  entityId: string
): Promise<RetryAllPendingResult> {
  await requireAuth();

  const pending = await db.bankStatement.findMany({
    where: { entityId, archivedAt: null, extractStatus: "pending" },
    select: { id: true },
  });

  const results = await runWithConcurrencyLimit(pending, 4, (s) =>
    retryStatementExtraction(s.id)
  );

  const succeeded = results.filter((r) => "success" in r).length;
  revalidatePath("/business");
  return { attempted: pending.length, succeeded, failed: pending.length - succeeded };
}

/**
 * Runs transaction-row extraction (lib/doc-extract.ts's generic "bank_statement"
 * docType path, via actions/documents.ts#triggerExtraction) for every
 * statement in an entity whose linked Document has never had this kind of
 * extraction attempted (or whose last attempt failed). Deliberately distinct
 * from retryAllPendingStatementExtractions above, which re-runs the
 * *balance* extraction (lib/bank-statement-extract.ts) — this one is
 * transaction-row extraction only and never creates any Transaction rows
 * itself; importing still requires the per-statement review/select step.
 */
export async function extractAllStatementTransactions(
  entityId: string
): Promise<RetryAllPendingResult> {
  await requireAuth();

  const statements = await db.bankStatement.findMany({
    where: { entityId, archivedAt: null, documentId: { not: null } },
    include: {
      document: { select: { id: true, extractionStatus: true, extractionData: true } },
      account: { select: { accountType: true } },
    },
  });

  // Judged by whether real data exists, not by the status label: the label can
  // read "failed" on a document that holds a complete, good extraction, and
  // "complete" on one that holds nothing usable. A document the owner chose
  // to skip is left alone.
  const staleCardExtraction = (s: (typeof statements)[number]) =>
    needsCreditCardReclassification(
      s.account?.accountType,
      s.document?.extractionData as unknown as ExtractedDocument | null
    );
  const toExtract = statements.filter((s) => {
    if (!s.document) return false;
    const data = s.document.extractionData as unknown as ExtractedDocument | null;
    if (!hasUsableExtraction(data)) return s.document.extractionStatus !== "skipped";
    return staleCardExtraction(s);
  });

  // force only for the reclassification case: triggerExtraction's own
  // usable-data short-circuit would otherwise skip the re-run entirely.
  const results = await runWithConcurrencyLimit(toExtract, 4, (s) =>
    triggerExtraction(s.documentId!, { force: staleCardExtraction(s) })
  );

  const succeeded = results.filter((r) => r !== null).length;
  revalidatePath("/business");
  return { attempted: toExtract.length, succeeded, failed: toExtract.length - succeeded };
}

// ── Archive (never hard-delete — tax bookkeeping evidence) ─────────────────────

export async function archiveBankStatement(statementId: string): Promise<void> {
  await requireAuth();
  await db.bankStatement.update({
    where: { id: statementId },
    data: { archivedAt: new Date() },
  });
  revalidatePath("/business");
}

// ── Period balance sheet query ─────────────────────────────────────────────────

/**
 * Fetches confirmed statements for a period and builds the balance sheet via
 * lib/period-balance-sheet.ts. Exported for use by the balance-sheet page.
 */
export async function getPeriodBalanceSheet(
  entityId: string,
  periodStartIso: string,
  periodEndIso: string
) {
  await requireAuth();

  const periodStart = new Date(`${periodStartIso}T00:00:00Z`);
  const periodEnd = new Date(`${periodEndIso}T23:59:59.999Z`);

  const [statements, accounts] = await Promise.all([
    db.bankStatement.findMany({
      where: {
        entityId,
        archivedAt: null,
        closingBalance: { not: null },
        periodEnd: { gte: periodStart, lte: periodEnd },
      },
      select: {
        accountId: true,
        accountMask: true,
        institutionName: true,
        closingBalance: true,
        periodEnd: true,
      },
    }),
    db.account.findMany({
      where: { entityId, archivedAt: null },
      select: { id: true, nickname: true, accountType: true },
    }),
  ]);

  const snapshots = statements.map((s) => ({
    accountId: s.accountId,
    accountMask: s.accountMask,
    institutionName: s.institutionName,
    closingBalanceCents: s.closingBalance !== null
      ? Math.round(s.closingBalance.toNumber() * 100)
      : null,
    periodEnd: s.periodEnd.toISOString().slice(0, 10),
  }));

  return { snapshots, accounts };
}

export type { StatementAccountRow };