"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { normalizePayee, matchTagRule } from "@/lib/tags";
import { revalidatePath } from "next/cache";
import { z } from "zod";

function requireAuth() {
  return auth().then((session) => {
    if (!session?.user?.id) throw new Error("Unauthorized");
    return session.user;
  });
}

// ── Create transaction ────────────────────────────────────────────────────────

const createSchema = z.object({
  accountId: z.string().uuid(),
  entityId: z.string().uuid(),
  postedAt: z.string().min(1),
  amount: z.string().regex(/^-?\d+(\.\d{1,2})?$/, "Invalid amount"),
  payeeRaw: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  tagIds: z.array(z.string().uuid()).default([]),
  isTransferOut: z.boolean().optional(),
  transferToAccountId: z.string().uuid().optional(),
});

export type CreateTransactionInput = z.infer<typeof createSchema>;

export async function createTransaction(input: CreateTransactionInput) {
  await requireAuth();
  const parsed = createSchema.parse(input);

  const amount = new Prisma.Decimal(parsed.amount);
  const payeeNormalized = normalizePayee(parsed.payeeRaw);

  // Auto-assign tags from rules if none provided
  let tagIds = parsed.tagIds;
  if (tagIds.length === 0) {
    const rules = await db.tagRule.findMany();
    const ruleInput = rules.map((r) => ({
      tagId: r.tagId,
      payeePattern: r.payeePattern,
      amountMin: r.amountMin ? Number(r.amountMin) : null,
      amountMax: r.amountMax ? Number(r.amountMax) : null,
      accountId: r.accountId,
    }));
    const matched = matchTagRule(ruleInput, {
      normalizedPayee: payeeNormalized,
      amount: amount.abs().toNumber(),
      accountId: parsed.accountId,
    });
    if (matched) tagIds = [matched];
  }

  // Handle paired transfer: create two linked transaction legs
  if (parsed.isTransferOut && parsed.transferToAccountId) {
    return createTransferPair({
      fromAccountId: parsed.accountId,
      toAccountId: parsed.transferToAccountId,
      entityId: parsed.entityId,
      postedAt: new Date(parsed.postedAt),
      amount: amount.abs(),
      payeeRaw: parsed.payeeRaw,
      description: parsed.description,
    });
  }

  const tx = await db.transaction.create({
    data: {
      accountId: parsed.accountId,
      entityId: parsed.entityId,
      postedAt: new Date(parsed.postedAt),
      amount,
      payeeRaw: parsed.payeeRaw,
      payeeNormalized,
      description: parsed.description,
      source: "manual",
    },
  });

  if (tagIds.length > 0) {
    await db.transactionTag.createMany({
      data: tagIds.map((tagId) => ({ transactionId: tx.id, tagId })),
      skipDuplicates: true,
    });
  }

  revalidatePath("/transactions");
  revalidatePath("/");
  return { success: true, transactionId: tx.id };
}

// ── Create transfer pair ──────────────────────────────────────────────────────

async function createTransferPair(opts: {
  fromAccountId: string;
  toAccountId: string;
  entityId: string;
  postedAt: Date;
  amount: Prisma.Decimal; // absolute value
  payeeRaw: string;
  description?: string;
}) {
  const { fromAccountId, toAccountId, entityId, postedAt, amount, payeeRaw, description } = opts;

  // Find Transfer Out / Transfer In tags
  const [outTag, inTag] = await Promise.all([
    db.tag.findFirst({ where: { name: "Transfer Out" } }),
    db.tag.findFirst({ where: { name: "Transfer In" } }),
  ]);

  const pairId = crypto.randomUUID();

  const [outTx, inTx] = await db.$transaction([
    db.transaction.create({
      data: {
        accountId: fromAccountId,
        entityId,
        postedAt,
        amount: amount.negated(),
        payeeRaw,
        payeeNormalized: normalizePayee(payeeRaw),
        description,
        source: "manual",
        transferPairId: pairId,
      },
    }),
    db.transaction.create({
      data: {
        accountId: toAccountId,
        entityId,
        postedAt,
        amount,
        payeeRaw,
        payeeNormalized: normalizePayee(payeeRaw),
        description,
        source: "manual",
        transferPairId: pairId,
      },
    }),
  ]);

  const tagAssignments: { transactionId: string; tagId: string }[] = [];
  if (outTag) tagAssignments.push({ transactionId: outTx.id, tagId: outTag.id });
  if (inTag) tagAssignments.push({ transactionId: inTx.id, tagId: inTag.id });
  if (tagAssignments.length > 0) {
    await db.transactionTag.createMany({ data: tagAssignments, skipDuplicates: true });
  }

  revalidatePath("/transactions");
  revalidatePath("/");
  return { success: true, outTransactionId: outTx.id, inTransactionId: inTx.id };
}

// ── Update transaction tags ───────────────────────────────────────────────────

export async function updateTransactionTags(
  transactionId: string,
  tagIds: string[]
) {
  const user = await requireAuth();

  const tx = await db.transaction.findUnique({
    where: { id: transactionId, archivedAt: null },
    include: { tags: true },
  });
  if (!tx) throw new Error("Transaction not found");

  // Audit log
  const before = tx.tags.map((t) => t.tagId);
  await db.auditLog.create({
    data: {
      transactionId,
      changedBy: user.id!,
      changeType: "tag_change",
      before: { tagIds: before },
      after: { tagIds },
    },
  });

  await db.transactionTag.deleteMany({ where: { transactionId } });
  if (tagIds.length > 0) {
    await db.transactionTag.createMany({
      data: tagIds.map((tagId) => ({ transactionId, tagId })),
    });
  }

  revalidatePath("/transactions");
  return { success: true };
}

// ── Delete transaction ────────────────────────────────────────────────────────

export async function deleteTransaction(transactionId: string) {
  await requireAuth();

  const tx = await db.transaction.findUnique({ where: { id: transactionId, archivedAt: null } });
  if (!tx) throw new Error("Transaction not found");

  // If part of a transfer pair, archive both legs
  if (tx.transferPairId) {
    await db.transaction.updateMany({
      where: { transferPairId: tx.transferPairId },
      data: { archivedAt: new Date() },
    });
  } else {
    await db.transaction.update({
      where: { id: transactionId },
      data: { archivedAt: new Date() },
    });
  }

  revalidatePath("/transactions");
  return { success: true };
}

// ── List transactions (server-side query helper) ──────────────────────────────

export interface TransactionFilters {
  entityId?: string;
  accountId?: string;
  tagId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export async function listTransactions(filters: TransactionFilters = {}) {
  await requireAuth();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;

  const where: Prisma.TransactionWhereInput = {
    archivedAt: null,
    ...(filters.entityId && { entityId: filters.entityId }),
    ...(filters.accountId && { accountId: filters.accountId }),
    ...(filters.tagId && { tags: { some: { tagId: filters.tagId } } }),
    ...(filters.dateFrom && { postedAt: { gte: new Date(filters.dateFrom) } }),
    ...(filters.dateTo && { postedAt: { lte: new Date(filters.dateTo) } }),
    ...(filters.search && {
      OR: [
        { payeeRaw: { contains: filters.search, mode: "insensitive" } },
        { payeeNormalized: { contains: filters.search, mode: "insensitive" } },
        { description: { contains: filters.search, mode: "insensitive" } },
      ],
    }),
  };

  const [transactions, total] = await Promise.all([
    db.transaction.findMany({
      where,
      include: {
        account: { include: { institution: true } },
        entity: true,
        tags: { include: { tag: true } },
      },
      orderBy: { postedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.transaction.count({ where }),
  ]);

  return { transactions, total, page, pageSize };
}
