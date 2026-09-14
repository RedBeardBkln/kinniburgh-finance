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
import { uploadTaxFile, downloadTaxFile } from "@/lib/supabase-storage";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user as { id: string; name?: string | null; email: string };
}

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// ── Upload ─────────────────────────────────────────────────────────────────────

interface UploadCoreResult {
  statementId: string;
  extraction: ExtractedStatement | null;
}

/**
 * Shared core: validates + stores one statement file, creates the Document
 * (tax vault — archive only, never hard-deleted) and BankStatement rows, then
 * runs Claude extraction to pull the statement period and per-account balances.
 */
async function uploadStatementCore(
  user: { id: string },
  entity: { id: string; name: string },
  file: Blob,
  options: { accountId?: string; notes?: string }
): Promise<UploadCoreResult> {
  if (file.size > MAX_SIZE_BYTES) throw new Error("File exceeds 20MB limit");
  if (!ALLOWED_MIME_TYPES.includes(file.type as (typeof ALLOWED_MIME_TYPES)[number])) {
    throw new Error("Unsupported file type. Upload PDF, JPEG, PNG, or WebP.");
  }

  const { accountId, notes } = options;

  if (accountId) {
    const account = await db.account.findFirst({
      where: { id: accountId, entityId: entity.id, archivedAt: null },
    });
    if (!account) throw new Error("Account not found for this entity");
  }

  const ext = file.type === "application/pdf" ? "pdf" : file.type.split("/")[1];
  const docId = randomUUID();
  const statementId = randomUUID();
  const fileKey = `statements/${entity.id}/${statementId}.${ext}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadTaxFile(buffer, fileKey, file.type);

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
      extractStatus: "processing",
      notes: notes ?? null,
      uploadedBy: user.id,
    },
  });

  let extraction: ExtractedStatement | null = null;
  try {
    extraction = await extractBankStatement(buffer, file.type);

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

  return { statementId, extraction };
}

/**
 * Uploads a single bank statement file. See uploadStatementCore for details.
 */
export async function uploadBankStatement(formData: FormData): Promise<UploadCoreResult> {
  const user = await requireAuth();

  const file = formData.get("file");
  if (!(file instanceof Blob)) throw new Error("No file provided");

  const entityId = z.string().uuid().parse(formData.get("entityId"));
  const accountId = formData.get("accountId")?.toString() || undefined;
  const notes = formData.get("notes")?.toString() || undefined;

  const entity = await db.entity.findUnique({ where: { id: entityId } });
  if (!entity) throw new Error("Entity not found");

  const result = await uploadStatementCore(user, entity, file, { accountId, notes });

  revalidatePath(`/business`);
  return result;
}

export interface BatchUploadItemResult {
  fileName: string;
  ok: boolean;
  statementId?: string;
  error?: string;
}

/**
 * Uploads multiple bank statement files at once (e.g. a folder of prior-year
 * statements via a directory picker). Each file is processed independently —
 * one failure never blocks the others. Returns a per-file result list.
 * NOTE: no AI extraction in batch mode (a 40-file folder would be slow/costly);
 * period + balances can be confirmed on the statements page afterwards.
 */
export async function uploadBankStatementsBatch(
  formData: FormData
): Promise<BatchUploadItemResult[]> {
  const user = await requireAuth();

  const entityId = z.string().uuid().parse(formData.get("entityId"));
  const accountId = formData.get("accountId")?.toString() || undefined;
  const notes = formData.get("notes")?.toString() || undefined;

  const entity = await db.entity.findUnique({ where: { id: entityId } });
  if (!entity) throw new Error("Entity not found");

  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) throw new Error("No files provided");
  if (files.length > 100) throw new Error("Maximum 100 files per batch");

  const results: BatchUploadItemResult[] = [];

  for (const file of files) {
    const fileName =
      file instanceof File && file.name ? file.name : "statement";
    try {
      const result = await uploadStatementCore(user, entity, file, {
        accountId,
        notes,
      });
      results.push({ fileName, ok: true, statementId: result.statementId });
    } catch (e) {
      results.push({
        fileName,
        ok: false,
        error: e instanceof Error ? e.message : "Upload failed",
      });
    }
  }

  revalidatePath(`/business`);
  return results;
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