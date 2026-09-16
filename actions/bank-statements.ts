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

  if (accountId) {
    const account = await db.account.findFirst({
      where: { id: accountId, entityId: entity.id, archivedAt: null },
    });
    if (!account) return { ok: false, error: "Account not found for this entity" };
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
          openingBalance: singleAccount?.openingBalanceCents != null
            ? centsToDecimal(singleAccount.openingBalanceCents)
            : null,
          closingBalance: singleAccount?.closingBalanceCents != null
            ? centsToDecimal(singleAccount.closingBalanceCents)
            : null,
          extractStatus: "complete",
          extractionData: extraction as unknown as Prisma.InputJsonValue,
          extractModel: "claude-sonnet-4-6",
        },
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

// ── List / fetch ───────────────────────────────────────────────────────────────

export interface BankStatementRow {
  id: string;
  accountId: string | null;
  accountNickname: string | null;
  periodStart: Date;
  periodEnd: Date;
  institutionName: string | null;
  accountMask: string | null;
  openingBalance: string | null;
  closingBalance: string | null;
  extractStatus: string;
  confirmedAt: Date | null;
  notes: string | null;
  createdAt: Date;
}

export async function listBankStatements(entityId: string): Promise<BankStatementRow[]> {
  await requireAuth();

  const statements = await db.bankStatement.findMany({
    where: { entityId, archivedAt: null },
    include: { account: { select: { nickname: true } } },
    orderBy: { periodEnd: "desc" },
  });

  return statements.map((s) => ({
    id: s.id,
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
  }));
}

export async function listEntityAccounts(entityId: string) {
  await requireAuth();
  return db.account.findMany({
    where: { entityId, archivedAt: null },
    orderBy: { nickname: "asc" },
    select: { id: true, nickname: true, mask: true, accountType: true },
  });
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

  if (data.accountId) {
    const account = await db.account.findFirst({
      where: { id: data.accountId, entityId: statement.entityId, archivedAt: null },
    });
    if (!account) return { error: "Account not found for this entity" };
  }

  await db.bankStatement.update({
    where: { id: data.statementId },
    data: {
      periodStart,
      periodEnd,
      accountId: data.accountId || null,
      institutionName: data.institutionName || null,
      accountMask: data.accountMask || null,
      openingBalance: data.openingBalanceCents !== null ? centsToDecimal(data.openingBalanceCents) : null,
      closingBalance: data.closingBalanceCents !== null ? centsToDecimal(data.closingBalanceCents) : null,
      notes: data.notes ?? statement.notes,
      extractStatus: "complete",
      confirmedAt: new Date(),
      confirmedById: user.id,
    },
  });

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

    await db.bankStatement.update({
      where: { id: statementId },
      data: {
        periodStart,
        periodEnd,
        institutionName: singleAccount?.institutionName ?? null,
        accountMask: singleAccount?.accountMask ?? null,
        openingBalance: singleAccount?.openingBalanceCents != null
          ? centsToDecimal(singleAccount.openingBalanceCents)
          : null,
        closingBalance: singleAccount?.closingBalanceCents != null
          ? centsToDecimal(singleAccount.closingBalanceCents)
          : null,
        extractStatus: "complete",
        extractionData: extraction as unknown as Prisma.InputJsonValue,
        extractModel: "claude-sonnet-4-6",
      },
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