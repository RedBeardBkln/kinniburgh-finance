"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { normalizePayee, normalizePattern, matchTagRule, alnum } from "@/lib/tags";
import { autoAssignGlCodes } from "@/lib/gl-code-resolver";
import type { RuleConflictView, RuleShape } from "@/lib/tag-rule-conflicts";
import {
  AMOUNT_REGEX,
  createTagRuleSchema,
  createTagRuleWithScreening,
  screenTagRuleCore,
  type SaveRuleResult as CoreSaveRuleResult,
} from "@/lib/transaction-tagging";
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

// ── Conflict screening ────────────────────────────────────────────────────────

export type SaveRuleResult = CoreSaveRuleResult;

/**
 * Screen a candidate rule against all saved rules. Used by every save path
 * (new-rule form, transaction dialogs, edit) and by receipt-generated rules.
 * The screening itself lives in lib/transaction-tagging.ts (shared with the
 * token-gated review queue).
 */
export async function screenTagRule(
  candidate: RuleShape,
  excludeId?: string,
  baseline?: RuleShape
): Promise<RuleConflictView[]> {
  await requireAuth();
  return screenTagRuleCore(candidate, excludeId, baseline);
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createTagRule(
  input: z.input<typeof createTagRuleSchema>
): Promise<SaveRuleResult> {
  await requireAuth();
  const result = await createTagRuleWithScreening(input);
  if (result.status === "saved") revalidatePath("/tag-rules");
  return result;
}

// ── Update ────────────────────────────────────────────────────────────────────

const updateSchema = z.object({
  payeePattern: z.string().min(1).max(255).optional(),
  tagId: z.string().uuid().optional(),
  amountMin: z.string().regex(AMOUNT_REGEX).nullable().optional(),
  amountMax: z.string().regex(AMOUNT_REGEX).nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  accountIds: z.array(z.string().uuid()).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  approveConflicts: z.boolean().optional(),
});

export async function updateTagRule(
  id: string,
  patch: z.input<typeof updateSchema>
): Promise<SaveRuleResult> {
  await requireAuth();
  let data: z.infer<typeof updateSchema>;
  try {
    data = updateSchema.parse(patch);
  } catch (e) {
    if (e instanceof z.ZodError) throw new Error(e.errors[0]?.message ?? "Invalid input");
    throw e;
  }
  if (!data.approveConflicts) {
    // Screen the rule as it will look after the patch, not just the patch.
    const current = await db.tagRule.findUnique({ where: { id } });
    if (!current) throw new Error("Rule not found");
    const baseline: RuleShape = {
      payeePattern: current.payeePattern,
      tagId: current.tagId,
      amountMin: current.amountMin?.toNumber() ?? null,
      amountMax: current.amountMax?.toNumber() ?? null,
      accountId: current.accountId,
      accountIds: current.accountIds ? (JSON.parse(current.accountIds) as string[]) : null,
    };
    const merged: RuleShape = {
      payeePattern:
        data.payeePattern != null ? normalizePattern(data.payeePattern) : current.payeePattern,
      tagId: data.tagId ?? current.tagId,
      amountMin:
        data.amountMin !== undefined
          ? data.amountMin != null ? Number(data.amountMin) : null
          : current.amountMin?.toNumber() ?? null,
      amountMax:
        data.amountMax !== undefined
          ? data.amountMax != null ? Number(data.amountMax) : null
          : current.amountMax?.toNumber() ?? null,
      accountId: data.accountId !== undefined ? data.accountId : current.accountId,
      accountIds:
        data.accountIds !== undefined
          ? data.accountIds
          : current.accountIds
          ? (JSON.parse(current.accountIds) as string[])
          : null,
    };
    const conflicts = await screenTagRule(merged, id, baseline);
    if (conflicts.length > 0) return { status: "needs_approval", conflicts };
  }

  await db.tagRule.update({
    where: { id },
    data: {
      ...(data.payeePattern != null && {
        payeePattern: normalizePattern(data.payeePattern),
      }),
      ...(data.tagId != null && { tagId: data.tagId }),
      ...(data.amountMin !== undefined && {
        amountMin: data.amountMin != null ? new Prisma.Decimal(data.amountMin) : null,
      }),
      ...(data.amountMax !== undefined && {
        amountMax: data.amountMax != null ? new Prisma.Decimal(data.amountMax) : null,
      }),
      ...(data.accountId !== undefined && { accountId: data.accountId }),
      ...(data.accountIds !== undefined && {
        accountIds:
          data.accountIds && data.accountIds.length > 0
            ? JSON.stringify(data.accountIds)
            : null,
      }),
      ...(data.confidence != null && { confidence: data.confidence }),
    },
  });
  revalidatePath("/tag-rules");
  return { status: "saved", id };
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
      accountIds: true,
    },
  });

  const candidates = rules.map((r) => ({
    tagId: r.tagId,
    payeePattern: r.payeePattern,
    amountMin: r.amountMin ? r.amountMin.toNumber() : null,
    amountMax: r.amountMax ? r.amountMax.toNumber() : null,
    accountId: r.accountId,
    accountIds: r.accountIds ? (JSON.parse(r.accountIds) as string[]) : null,
  }));

  // Always re-derive from payeeRaw rather than trusting the stored
  // payeeNormalized: that field is a cache, and a wrong cached value
  // (e.g. bank-statement imports before their fix in actions/documents.ts)
  // would otherwise make matching silently fail forever for that row, with
  // no way to notice short of re-deriving live like this.
  const normalizedPayee = normalizePayee(tx.payeeRaw ?? tx.payeeNormalized ?? "");
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
    accountIds: r.accountIds ? (JSON.parse(r.accountIds) as string[]) : null,
  }));

  const previews: Array<{ payeeRaw: string; tagShortName: string }> = [];
  let willTag = 0;

  for (const tx of transactions) {
    // Always re-derive from payeeRaw rather than trusting the stored
  // payeeNormalized: that field is a cache, and a wrong cached value
  // (e.g. bank-statement imports before their fix in actions/documents.ts)
  // would otherwise make matching silently fail forever for that row, with
  // no way to notice short of re-deriving live like this.
  const normalizedPayee = normalizePayee(tx.payeeRaw ?? tx.payeeNormalized ?? "");
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
  accountNickname: string;
  accountMask: string | null;
}

export interface AccountOption {
  id: string;
  nickname: string;
  mask: string | null;
  institutionName: string;
}

export async function getAccountsForSearch(): Promise<AccountOption[]> {
  await requireAuth();
  const accounts = await db.account.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      nickname: true,
      mask: true,
      institution: { select: { name: true } },
    },
    orderBy: [{ institution: { name: "asc" } }, { nickname: "asc" }],
  });
  return accounts.map((a) => ({
    id: a.id,
    nickname: a.nickname,
    mask: a.mask,
    institutionName: a.institution.name,
  }));
}

export async function previewRetroactiveRule(
  ruleId: string,
  since: string,
  accountIds?: string[]
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
      ...(accountIds && accountIds.length > 0
        ? { accountId: { in: accountIds } }
        : {}),
    },
    select: {
      id: true,
      postedAt: true,
      payeeRaw: true,
      payeeNormalized: true,
      amount: true,
      accountId: true,
      account: { select: { nickname: true, mask: true } },
      tags: { select: { tag: { select: { name: true } } } },
    },
    orderBy: [{ postedAt: "desc" }, { id: "asc" }],
    // No take limit — scan the full date range
  });

  const pattern = rule.payeePattern?.toLowerCase() ?? null;
  const amountMin = rule.amountMin ? rule.amountMin.toNumber() : null;
  const amountMax = rule.amountMax ? rule.amountMax.toNumber() : null;

  const matches: RetroactiveMatch[] = [];

  for (const tx of transactions) {
    // Payee match — contains (not just exact), alnum-stripped so apostrophes/hyphens
    // don't affect matching. Uses the same alnum() as matchTagRule() in lib/tags.ts
    // (shared, not re-duplicated here — a prior local copy diverged from a fix made
    // there) so a rule for "Lowe's" also matches "Lowe's Home Goods LLC".
    let isExactMatch = true;
    if (pattern) {
      // Always re-derive from payeeRaw rather than trusting the stored
  // payeeNormalized: that field is a cache, and a wrong cached value
  // (e.g. bank-statement imports before their fix in actions/documents.ts)
  // would otherwise make matching silently fail forever for that row, with
  // no way to notice short of re-deriving live like this.
  const normalizedPayee = normalizePayee(tx.payeeRaw ?? tx.payeeNormalized ?? "");
      const sp = alnum(normalizedPayee);
      const sPattern = alnum(pattern);
      if (sp === sPattern) {
        isExactMatch = true;
      } else if (sp.includes(sPattern)) {
        isExactMatch = false;
      } else {
        continue;
      }
    }

    // Amount range
    if (amountMin !== null || amountMax !== null) {
      const amount = new Prisma.Decimal(tx.amount).abs().toNumber();
      if (amountMin !== null && amount < amountMin) continue;
      if (amountMax !== null && amount > amountMax) continue;
    }

    // Account restriction — check rule-level accountIds first, then legacy accountId
    const ruleAcctIds = rule.accountIds
      ? (JSON.parse(rule.accountIds) as string[])
      : rule.accountId
      ? [rule.accountId]
      : null;
    if (ruleAcctIds && !ruleAcctIds.includes(tx.accountId)) continue;

    matches.push({
      id: tx.id,
      postedAt: tx.postedAt.toISOString(),
      payeeRaw: tx.payeeRaw ?? tx.payeeNormalized ?? "",
      amount: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(new Prisma.Decimal(tx.amount).toNumber()),
      existingTags: tx.tags.map((t) => t.tag.name),
      isExactMatch,
      accountNickname: tx.account?.nickname ?? "",
      accountMask: tx.account?.mask ?? null,
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
    await autoAssignGlCodes(
      [{ transactionId: txId, entityId: tx.entityId, tagIds: [tagId] }],
      user.id!
    );
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
