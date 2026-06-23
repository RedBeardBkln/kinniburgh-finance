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
): Promise<{ id: string }> {
  await requireAuth();
  const data = createSchema.parse(input);
  const rule = await db.tagRule.create({
    data: {
      payeePattern: normalizePayee(data.payeePattern),
      tagId: data.tagId,
      amountMin: data.amountMin != null ? new Prisma.Decimal(data.amountMin) : null,
      amountMax: data.amountMax != null ? new Prisma.Decimal(data.amountMax) : null,
      accountId: data.accountId ?? null,
    },
  });
  revalidatePath("/tag-rules");
  return { id: rule.id };
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

  const normalizedPayee = tx.payeeNormalized || normalizePayee(tx.payeeRaw ?? "");
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

// ── Dry run: preview rule matches without writing ─────────────────────────────

export async function dryRunTagRules(entityId?: string): Promise<{
  total: number;
  willTag: number;
  previews: Array<{ payeeRaw: string; tagShortName: string }>;
  unmatched: number;
}> {
  await requireAuth();

  const transactions = await db.transaction.findMany({
    where: {
      archivedAt: null,
      pending: false,
      transferPairId: null,
      tags: { none: {} },
      ...(entityId ? { entityId } : {}),
    },
    select: {
      id: true,
      payeeRaw: true,
      payeeNormalized: true,
      amount: true,
      accountId: true,
    },
    take: 500,
  });

  const rules = await db.tagRule.findMany({ include: { tag: true } });
  const tagById = new Map(rules.map((r) => [r.tagId, r.tag.shortName]));
  const candidates = rules.map((r) => ({
    tagId: r.tagId,
    payeePattern: r.payeePattern,
    amountMin: r.amountMin ? r.amountMin.toNumber() : null,
    amountMax: r.amountMax ? r.amountMax.toNumber() : null,
    accountId: r.accountId,
  }));

  const previews: Array<{ payeeRaw: string; tagShortName: string }> = [];
  let willTag = 0;

  for (const tx of transactions) {
    const normalizedPayee = tx.payeeNormalized || normalizePayee(tx.payeeRaw ?? "");
    const amount = tx.amount.abs().toNumber();
    const matched = matchTagRule(candidates, { normalizedPayee, amount, accountId: tx.accountId });
    if (matched) {
      willTag++;
      previews.push({
        payeeRaw: tx.payeeRaw ?? tx.payeeNormalized ?? "",
        tagShortName: tagById.get(matched) ?? matched,
      });
    }
  }

  return {
    total: transactions.length,
    willTag,
    previews: previews.slice(0, 10),
    unmatched: transactions.length - willTag,
  };
}

// ── Retroactive rule preview ──────────────────────────────────────────────────

export interface RetroactiveMatch {
  id: string;
  postedAt: string;
  payeeRaw: string;
  amount: string;
  existingTags: string[];
  isExactMatch: boolean;
}

export async function previewRetroactiveRule(
  ruleId: string,
  since: string
): Promise<{ tagId: string; tagName: string; matches: RetroactiveMatch[] }> {
  await requireAuth();

  const rule = await db.tagRule.findUnique({
    where: { id: ruleId },
    include: { tag: true },
  });
  if (!rule) throw new Error("Rule not found");

  const sinceDate = new Date(since);

  const transactions = await db.transaction.findMany({
    where: {
      archivedAt: null,
      pending: false,
      transferPairId: null,
      postedAt: { gte: sinceDate },
    },
    select: {
      id: true,
      postedAt: true,
      payeeRaw: true,
      payeeNormalized: true,
      amount: true,
      accountId: true,
      tags: { select: { tag: { select: { name: true } } } },
    },
    orderBy: { postedAt: "desc" },
    take: 500,
  });

  const candidate = {
    tagId: rule.tagId,
    payeePattern: rule.payeePattern,
    amountMin: rule.amountMin ? rule.amountMin.toNumber() : null,
    amountMax: rule.amountMax ? rule.amountMax.toNumber() : null,
    accountId: rule.accountId,
  };

  const matches: RetroactiveMatch[] = [];

  for (const tx of transactions) {
    const normalizedPayee = tx.payeeNormalized || normalizePayee(tx.payeeRaw ?? "");
    const amount = new Prisma.Decimal(tx.amount).abs().toNumber();

    // Score against only this single rule
    let score = 0;
    if (candidate.payeePattern) {
      const pattern = candidate.payeePattern.toLowerCase();
      if (normalizedPayee === pattern) {
        score += 100;
      } else if (normalizedPayee.startsWith(pattern)) {
        score += 50;
      } else if (normalizedPayee.includes(pattern)) {
        score += 25; // handles bank-prefixed payees like "POS TARGET 00123"
      } else {
        continue;
      }
    }
    if (candidate.amountMin !== null || candidate.amountMax !== null) {
      const min = candidate.amountMin ?? -Infinity;
      const max = candidate.amountMax ?? Infinity;
      if (amount < min || amount > max) continue;
      score += 20;
    }
    if (candidate.accountId) {
      if (candidate.accountId !== tx.accountId) continue;
      score += 10;
    }
    if (score === 0) continue;

    matches.push({
      id: tx.id,
      postedAt: tx.postedAt.toISOString(),
      payeeRaw: tx.payeeRaw ?? tx.payeeNormalized ?? "",
      amount: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(new Prisma.Decimal(tx.amount).toNumber()),
      existingTags: tx.tags.map((t) => t.tag.name),
      isExactMatch: score >= 100,
    });
  }

  return { tagId: rule.tagId, tagName: rule.tag.name, matches };
}

// ── Retroactive rule application ──────────────────────────────────────────────

export async function applyRetroactiveTag(
  transactionIds: string[],
  tagId: string
): Promise<{ applied: number }> {
  const user = await requireAuth();

  let applied = 0;
  for (const txId of transactionIds) {
    const tx = await db.transaction.findUnique({
      where: { id: txId },
      include: { tags: true },
    });
    if (!tx) continue;

    const before = tx.tags.map((t) => t.tagId);
    await db.auditLog.create({
      data: {
        transactionId: txId,
        changedBy: user.id!,
        changeType: "tag_change",
        before: { tagIds: before },
        after: { tagIds: [tagId], source: "retroactive_rule" },
      },
    });

    await db.transactionTag.deleteMany({ where: { transactionId: txId } });
    await db.transactionTag.create({ data: { transactionId: txId, tagId } });
    applied++;
  }

  revalidatePath("/transactions");
  return { applied };
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
