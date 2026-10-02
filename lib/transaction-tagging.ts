// Shared tag-write / create-tag / rule-screening logic.
//
// These are plain (non "use server") functions so that BOTH gates can call the
// same implementation:
//   - actions/transactions.ts, actions/tags.ts, actions/tag-rules.ts
//     (NextAuth session, requireAuth() first), and
//   - actions/review-queue.ts (Eva's magic-link token, requireReviewAccess()
//     first), which has no NextAuth session and so cannot call the above.
//
// Nothing here authenticates. Every caller MUST have authenticated (session or
// token) and must pass the acting user's real User.id explicitly; audit rows are
// attributed to that id. Do not export any of this from a "use server" file.

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { normalizePattern } from "@/lib/tags";
import { autoAssignGlCodes } from "@/lib/gl-code-resolver";
import {
  findRuleConflicts,
  introducedConflicts,
  type RuleConflict,
  type RuleConflictView,
  type RuleShape,
} from "@/lib/tag-rule-conflicts";

// ── Tag a transaction ─────────────────────────────────────────────────────────

export interface SetTransactionTagsOptions {
  /** The acting user's real User.id (audit attribution). */
  userId: string;
  /** Recorded as `source` inside the audit row's `after` JSON (e.g. "review_queue"). */
  source?: string;
  /**
   * When true, never overwrite existing tags: if the transaction already has any
   * tag the call is a no-op returning "already_tagged", and when it has none the
   * new tags are only ever ADDED (no delete step), so a tag written by someone
   * else in the instant between the check and the write is not destroyed.
   */
  onlyIfUntagged?: boolean;
}

export type SetTransactionTagsResult = { status: "tagged" } | { status: "already_tagged" };

/**
 * Replace (or, with onlyIfUntagged, initially set) a transaction's tags, write a
 * `tag_change` audit row in the same DB transaction, and auto-assign a GL code
 * where the entity's tag->GL mapping resolves one.
 *
 * Throws "Transaction not found" for a missing or archived transaction.
 */
export async function setTransactionTags(
  transactionId: string,
  tagIds: string[],
  opts: SetTransactionTagsOptions
): Promise<SetTransactionTagsResult> {
  const tx = await db.transaction.findUnique({
    where: { id: transactionId, archivedAt: null },
    include: { tags: true },
  });
  if (!tx) throw new Error("Transaction not found");

  if (opts.onlyIfUntagged && tx.tags.length > 0) return { status: "already_tagged" };

  const before = tx.tags.map((t) => t.tagId);
  const auditRow = db.auditLog.create({
    data: {
      transactionId,
      changedBy: opts.userId,
      changeType: "tag_change",
      before: { tagIds: before },
      after: opts.source ? { tagIds, source: opts.source } : { tagIds },
    },
  });

  if (opts.onlyIfUntagged) {
    await db.$transaction([
      auditRow,
      ...(tagIds.length > 0
        ? [
            db.transactionTag.createMany({
              data: tagIds.map((tagId) => ({ transactionId, tagId })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);
  } else {
    await db.$transaction([
      auditRow,
      db.transactionTag.deleteMany({ where: { transactionId } }),
      ...(tagIds.length > 0
        ? [
            db.transactionTag.createMany({
              data: tagIds.map((tagId) => ({ transactionId, tagId })),
            }),
          ]
        : []),
    ]);
  }

  await autoAssignGlCodes([{ transactionId, entityId: tx.entityId, tagIds }], opts.userId);

  return { status: "tagged" };
}

// ── Create a tag ──────────────────────────────────────────────────────────────

export const createTagInputSchema = z.object({
  shortName: z.string().min(1).max(100).trim(),
  parentId: z.string().uuid().optional(),
});

/** Create a tag (optionally under a parent). Throws on a duplicate full name. */
export async function createTagCore(
  input: z.input<typeof createTagInputSchema>
): Promise<{ id: string }> {
  const { shortName, parentId } = createTagInputSchema.parse(input);

  let name = shortName;
  if (parentId) {
    const parent = await db.tag.findUnique({ where: { id: parentId } });
    if (!parent) throw new Error("Parent tag not found");
    name = `${parent.name} / ${shortName}`;
  }

  const existing = await db.tag.findUnique({ where: { name } });
  if (existing) {
    throw new Error(`A tag named "${name}" already exists.`);
  }

  const tag = await db.tag.create({
    data: { name, shortName, parentId: parentId ?? null },
  });
  return { id: tag.id };
}

// ── Tag rules: conflict screening + create ────────────────────────────────────

export type SaveRuleResult =
  | { status: "saved"; id: string }
  | { status: "needs_approval"; conflicts: RuleConflictView[] };

// Accepts values like "1", "40.00", ".01", "0.01"
export const AMOUNT_REGEX = /^(\d+\.?\d{0,2}|\.\d{1,2})$/;

export const createTagRuleSchema = z.object({
  payeePattern: z.string().min(1).max(255),
  tagId: z.string().uuid(),
  amountMin: z.string().regex(AMOUNT_REGEX).optional(),
  amountMax: z.string().regex(AMOUNT_REGEX).optional(),
  accountId: z.string().uuid().optional(),
  accountIds: z.array(z.string().uuid()).optional(),
  /** Set true once the user has explicitly approved saving despite conflicts. */
  approveConflicts: z.boolean().optional(),
});

export async function loadExistingRuleShapes(): Promise<RuleShape[]> {
  const rules = await db.tagRule.findMany({
    select: {
      id: true,
      payeePattern: true,
      tagId: true,
      amountMin: true,
      amountMax: true,
      accountId: true,
      accountIds: true,
    },
  });
  return rules.map((r) => ({
    id: r.id,
    payeePattern: r.payeePattern,
    tagId: r.tagId,
    amountMin: r.amountMin ? r.amountMin.toNumber() : null,
    amountMax: r.amountMax ? r.amountMax.toNumber() : null,
    accountId: r.accountId,
    accountIds: r.accountIds ? (JSON.parse(r.accountIds) as string[]) : null,
  }));
}

/**
 * Screen a candidate rule against all saved rules. Used by every save path
 * (new-rule form, transaction dialogs, edit, receipt-generated rules, and the
 * review queue).
 */
export async function screenTagRuleCore(
  candidate: RuleShape,
  excludeId?: string,
  baseline?: RuleShape
): Promise<RuleConflictView[]> {
  const existing = await loadExistingRuleShapes();
  let conflicts: RuleConflict[] = findRuleConflicts(candidate, existing, { excludeId });
  // When editing, only conflicts the edit introduces count — see introducedConflicts().
  if (baseline) {
    conflicts = introducedConflicts(findRuleConflicts(baseline, existing, { excludeId }), conflicts);
  }
  if (conflicts.length === 0) return [];
  const tags = await db.tag.findMany({
    where: { id: { in: [...new Set(conflicts.map((c) => c.tagId))] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(tags.map((t) => [t.id, t.name]));
  return conflicts.map((c) => ({ ...c, tagName: nameById.get(c.tagId) ?? "(unknown tag)" }));
}

/**
 * Create a tag rule, screening for duplicate/competing/overlapping rules first
 * unless `approveConflicts` is set. Callers that must never override a conflict
 * (the review queue) simply never pass `approveConflicts`.
 */
export async function createTagRuleWithScreening(
  input: z.input<typeof createTagRuleSchema>
): Promise<SaveRuleResult> {
  let data: z.infer<typeof createTagRuleSchema>;
  try {
    data = createTagRuleSchema.parse(input);
  } catch (e) {
    if (e instanceof z.ZodError) throw new Error(e.errors[0]?.message ?? "Invalid input");
    throw e;
  }
  const payeePattern = normalizePattern(data.payeePattern);

  if (!data.approveConflicts) {
    const conflicts = await screenTagRuleCore({
      payeePattern,
      tagId: data.tagId,
      amountMin: data.amountMin != null ? Number(data.amountMin) : null,
      amountMax: data.amountMax != null ? Number(data.amountMax) : null,
      accountId: data.accountId ?? null,
      accountIds: data.accountIds ?? null,
    });
    if (conflicts.length > 0) return { status: "needs_approval", conflicts };
  }

  const rule = await db.tagRule.create({
    data: {
      payeePattern,
      tagId: data.tagId,
      amountMin: data.amountMin != null ? new Prisma.Decimal(data.amountMin) : null,
      amountMax: data.amountMax != null ? new Prisma.Decimal(data.amountMax) : null,
      accountId: data.accountId ?? null,
      accountIds:
        data.accountIds && data.accountIds.length > 0
          ? JSON.stringify(data.accountIds)
          : null,
    },
  });
  return { status: "saved", id: rule.id };
}
