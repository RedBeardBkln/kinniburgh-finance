"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { normalizePayee, matchTagRule } from "@/lib/tags";
import { updateTransactionTags } from "@/actions/transactions";
import { revalidatePath } from "next/cache";
import { z } from "zod";

function requireAuth() {
  return auth().then((session) => {
    if (!session?.user?.id) throw new Error("Unauthorized");
    return session.user;
  });
}

export type TagRuleWithTag = Prisma.TagRuleGetPayload<{
  include: { tag: true; account: true };
}>;

// ── List ──────────────────────────────────────────────────────────────────────

export async function listTagRules(): Promise<TagRuleWithTag[]> {
  await requireAuth();
  return db.tagRule.findMany({
    include: { tag: true, account: true },
    orderBy: { createdAt: "desc" },
  });
}

// ── Create ────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  payeePattern: z.string().min(1).max(255),
  tagId: z.string().uuid(),
  amountMin: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  amountMax: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  accountId: z.string().uuid().optional(),
});

export async function createTagRule(
  input: z.input<typeof createSchema>
): Promise<void> {
  await requireAuth();
  const data = createSchema.parse(input);
  await db.tagRule.create({
    data: {
      payeePattern: normalizePayee(data.payeePattern),
      tagId: data.tagId,
      amountMin: data.amountMin != null ? new Prisma.Decimal(data.amountMin) : null,
      amountMax: data.amountMax != null ? new Prisma.Decimal(data.amountMax) : null,
      accountId: data.accountId ?? null,
    },
  });
  revalidatePath("/tag-rules");
}

// ── Update ────────────────────────────────────────────────────────────────────

const updateSchema = z.object({
  payeePattern: z.string().min(1).max(255).optional(),
  tagId: z.string().uuid().optional(),
  amountMin: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  amountMax: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export async function updateTagRule(
  id: string,
  patch: z.input<typeof updateSchema>
): Promise<void> {
  await requireAuth();
  const data = updateSchema.parse(patch);
  await db.tagRule.update({
    where: { id },
    data: {
      ...(data.payeePattern != null && {
        payeePattern: normalizePayee(data.payeePattern),
      }),
      ...(data.tagId != null && { tagId: data.tagId }),
      ...(data.amountMin !== undefined && {
        amountMin: data.amountMin != null ? new Prisma.Decimal(data.amountMin) : null,
      }),
      ...(data.amountMax !== undefined && {
        amountMax: data.amountMax != null ? new Prisma.Decimal(data.amountMax) : null,
      }),
      ...(data.accountId !== undefined && { accountId: data.accountId }),
      ...(data.confidence != null && { confidence: data.confidence }),
    },
  });
  revalidatePath("/tag-rules");
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteTagRule(id: string): Promise<void> {
  await requireAuth();
  await db.tagRule.delete({ where: { id } });
  revalidatePath("/tag-rules");
}

// ── Apply rules to a transaction ──────────────────────────────────────────────

export async function applyRulesToTransaction(
  transactionId: string
): Promise<string[]> {
  const user = await requireAuth();

  const tx = await db.transaction.findUnique({
    where: { id: transactionId },
    include: { account: true },
  });
  if (!tx) throw new Error("Transaction not found");

  const rules = await db.tagRule.findMany({
    select: {
      tagId: true,
      payeePattern: true,
      amountMin: true,
      amountMax: true,
      accountId: true,
    },
  });

  const candidates = rules.map((r) => ({
    tagId: r.tagId,
    payeePattern: r.payeePattern,
    amountMin: r.amountMin ? r.amountMin.toNumber() : null,
    amountMax: r.amountMax ? r.amountMax.toNumber() : null,
    accountId: r.accountId,
  }));

  const normalizedPayee = tx.payeeNormalized ?? normalizePayee(tx.payeeRaw ?? "");
  const amount = new Prisma.Decimal(tx.amount).abs().toNumber();
  const matched = matchTagRule(candidates, {
    normalizedPayee,
    amount,
    accountId: tx.accountId,
  });

  if (!matched) return [];

  await updateTransactionTags(transactionId, [matched]);

  await db.auditLog.create({
    data: {
      transactionId,
      changedBy: user.id!,
      changeType: "tag_change",
      before: { tagIds: [] },
      after: { tagIds: [matched], source: "rule" },
    },
  });

  return [matched];
}

// ── Bulk apply rules ──────────────────────────────────────────────────────────

export async function applyAllRules(
  entityId?: string
): Promise<{ processed: number; tagged: number }> {
  await requireAuth();

  const transactions = await db.transaction.findMany({
    where: {
      archivedAt: null,
      pending: false,
      transferPairId: null,
      tags: { none: {} },
      ...(entityId ? { entityId } : {}),
    },
    select: { id: true },
    take: 500,
  });

  let tagged = 0;
  for (const tx of transactions) {
    const applied = await applyRulesToTransaction(tx.id);
    if (applied.length > 0) tagged++;
  }

  return { processed: transactions.length, tagged };
}
