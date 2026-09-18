"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { normalizePayee } from "@/lib/tags";
import { updateTransactionTags } from "@/actions/transactions";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { needsReceiptWhere, receiptDismissalKey, serializeReceiptDismissal } from "@/lib/receipt-flagging";

function requireAuth() {
  return auth().then((session) => {
    if (!session?.user?.id) throw new Error("Unauthorized");
    return session.user;
  });
}

// ── Confirm receipt ───────────────────────────────────────────────────────────

const confirmSchema = z.object({
  receiptId: z.string().uuid(),
  vendor: z.string().min(1).max(255),
  receiptDate: z.string().min(1),
  total: z.string().regex(/^\d+(\.\d{1,2})?$/),
  description: z.string().max(500).optional(),
  glCode: z.string().max(100).optional(),
  memo: z.string().max(500).optional(),
  accountId: z.string().uuid().optional(),
  taxCategory: z.string().max(100).optional(),
  projectId: z.string().uuid().optional(),
  transactionId: z.string().uuid().optional(),
  tagIds: z.array(z.string().uuid()).default([]),
});

export async function confirmReceipt(
  input: z.input<typeof confirmSchema>
): Promise<void> {
  const user = await requireAuth();
  const data = confirmSchema.parse(input);

  const receipt = await db.receipt.findUnique({ where: { id: data.receiptId } });
  if (!receipt) throw new Error("Receipt not found");

  await db.receipt.update({
    where: { id: data.receiptId },
    data: {
      vendor: data.vendor,
      receiptDate: new Date(`${data.receiptDate}T00:00:00Z`),
      total: new Prisma.Decimal(data.total),
      description: data.description ?? null,
      glCode: data.glCode ?? null,
      memo: data.memo ?? null,
      accountId: data.accountId ?? null,
      taxCategory: data.taxCategory ?? null,
      projectId: data.projectId ?? null,
      confirmedAt: new Date(),
      confirmedById: user.id!,
    },
  });

  if (data.transactionId) {
    await db.transaction.update({
      where: { id: data.transactionId },
      data: { receiptId: data.receiptId },
    });

    if (data.tagIds.length > 0) {
      await updateTransactionTags(data.transactionId, data.tagIds);
    }
  }

  // Upsert one TagRule per tag for this vendor
  if (data.tagIds.length > 0 && data.vendor) {
    const pattern = normalizePayee(data.vendor);
    for (const tagId of data.tagIds) {
      const existing = await db.tagRule.findFirst({
        where: { payeePattern: pattern, tagId },
      });
      if (!existing) {
        await db.tagRule.create({
          data: { payeePattern: pattern, tagId, confidence: 0.8 },
        });
      }
    }
  }

  revalidatePath("/receipts");
  revalidatePath("/transactions");
}

// ── Find matching transactions ────────────────────────────────────────────────

export interface MatchCandidate {
  id: string;
  postedAt: Date;
  amount: string;
  payeeRaw: string | null;
  accountNickname: string;
}

export async function findMatchingTransactions(
  receiptId: string,
  accountId?: string
): Promise<MatchCandidate[]> {
  await requireAuth();

  const receipt = await db.receipt.findUnique({ where: { id: receiptId } });
  if (!receipt || !receipt.total || !receipt.receiptDate) return [];

  const total = new Prisma.Decimal(receipt.total);
  const absMax = total.times("1.02");
  const absMin = total.times("0.98");

  const dateFrom = new Date(receipt.receiptDate);
  dateFrom.setUTCDate(dateFrom.getUTCDate() - 7);
  const dateTo = new Date(receipt.receiptDate);
  dateTo.setUTCDate(dateTo.getUTCDate() + 7);

  const rows = await db.transaction.findMany({
    where: {
      entityId: receipt.entityId,
      receiptId: null,
      archivedAt: null,
      transferPairId: null,
      postedAt: { gte: dateFrom, lte: dateTo },
      ...(accountId && { accountId }),
      OR: [
        // Outflow: amount is between -absMax and -absMin
        {
          amount: {
            gte: absMax.negated(),
            lte: absMin.negated(),
          },
        },
        // Income: amount is between absMin and absMax
        {
          amount: {
            gte: absMin,
            lte: absMax,
          },
        },
      ],
    },
    include: { account: true },
    orderBy: [{ postedAt: "desc" }, { id: "asc" }],
    take: 5,
  });

  return rows.map((tx) => ({
    id: tx.id,
    postedAt: tx.postedAt,
    amount: tx.amount.toString(),
    payeeRaw: tx.payeeRaw,
    accountNickname: tx.account.nickname,
  }));
}

// ── Receipt form data ─────────────────────────────────────────────────────────

export async function getReceiptFormData(entityId: string) {
  await requireAuth();
  const [accounts, projects, glCodes] = await Promise.all([
    db.account.findMany({
      where: { entityId, archivedAt: null },
      select: { id: true, nickname: true, mask: true, entityId: true },
      orderBy: { nickname: "asc" },
    }),
    db.project.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.glCode.findMany({
      where: { archivedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);
  return { accounts, projects, glCodes };
}

// ── Delete receipt ────────────────────────────────────────────────────────────

export async function deleteReceipt(receiptId: string): Promise<void> {
  await requireAuth();
  await db.receipt.update({
    where: { id: receiptId },
    data: { archivedAt: new Date() },
  });
  revalidatePath("/receipts");
}

// ── Flagged transactions (no receipt, over threshold) ──────────────────────────

export interface FlaggedTransactionRow {
  id: string;
  payeeRaw: string | null;
  amount: string;       // Decimal-as-string, negative
  postedAt: Date;
  entityId: string;
  entityName: string;
  entitySlug: string | null;
}

export async function listFlaggedTransactions(entityId?: string): Promise<FlaggedTransactionRow[]> {
  await requireAuth();
  const rows = await db.transaction.findMany({
    where: needsReceiptWhere(entityId),
    select: {
      id: true, payeeRaw: true, amount: true, postedAt: true,
      entity: { select: { id: true, name: true, navLabel: true, slug: true } },
    },
    orderBy: { postedAt: "desc" },
  });
  if (rows.length === 0) return [];
  const keys = rows.map((r) => receiptDismissalKey(r.id));
  const dismissed = await db.appSetting.findMany({ where: { key: { in: keys } }, select: { key: true } });
  const dismissedKeys = new Set(dismissed.map((d) => d.key));
  return rows
    .filter((r) => !dismissedKeys.has(receiptDismissalKey(r.id)))
    .map((r) => ({
      id: r.id,
      payeeRaw: r.payeeRaw,
      amount: r.amount.toString(),
      postedAt: r.postedAt,
      entityId: r.entity.id,
      entityName: r.entity.navLabel ?? r.entity.name,
      entitySlug: r.entity.slug,
    }));
}

export async function dismissReceiptRequirement(transactionId: string, reason?: string): Promise<void> {
  const user = await requireAuth();
  const tx = await db.transaction.findUnique({
    where: { id: transactionId, archivedAt: null },
    include: { entity: true },
  });
  if (!tx) throw new Error("Transaction not found");
  if (tx.entity.type !== "business") {
    // Defense in depth — the UI never renders this control outside a flagged
    // (already business-scoped) row, but the server must not trust the client.
    throw new Error("Receipt flagging only applies to business transactions");
  }

  const value = serializeReceiptDismissal({
    dismissedById: user.id!,
    dismissedAt: new Date().toISOString(),
    reason: reason ?? null,
  });

  await db.appSetting.upsert({
    where: { key: receiptDismissalKey(transactionId) },
    update: { value },
    create: { key: receiptDismissalKey(transactionId), value },
  });

  await db.auditLog.create({
    data: {
      transactionId,
      changedBy: user.id!,
      changeType: "receipt_flag_dismissed",
      before: {},
      after: JSON.parse(value),
    },
  });

  revalidatePath("/receipts");
}

// ── List receipts ─────────────────────────────────────────────────────────────

export async function listReceipts(filters: {
  entityId?: string;
  tab?: "review" | "confirmed" | "all";
  page?: number;
}) {
  await requireAuth();

  const { entityId, tab = "all", page = 1 } = filters;
  const pageSize = 25;

  const where: Prisma.ReceiptWhereInput = {
    archivedAt: null,
    ...(entityId && { entityId }),
    ...(tab === "review" && { ocrStatus: "complete", confirmedAt: null }),
    ...(tab === "confirmed" && { confirmedAt: { not: null } }),
  };

  const [receipts, total] = await Promise.all([
    db.receipt.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.receipt.count({ where }),
  ]);

  return { receipts, total, pageSize };
}
