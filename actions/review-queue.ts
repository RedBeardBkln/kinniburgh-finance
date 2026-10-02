"use server";

// Eva's token-gated actions for the "Assign to Eva" review queue.
//
// SANCTIONED EXCEPTION to the repo rule "every server action starts with
// requireAuth()": the caller here has no NextAuth session, only a magic-link
// token. EVERY export in this file MUST start with
// `await requireReviewAccess(token)`, which validates the token against the DB
// on that very request (hash lookup; unknown / expired / revoked / completed ->
// throws). Server actions are addressable by id regardless of which page
// renders them, so this check - not the middleware exemption for /queue - is the
// security boundary. A test asserts this file has no export that skips it.
//
// The acting user is ALWAYS derived server-side from the validated token
// (batch.assigneeUserId); nothing about identity is ever taken from client
// input. Tokens are never logged here.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  closeBatchIfDone,
  getAssignableEntityIds,
  markBatchOpened,
  resolveReviewAccess,
} from "@/lib/review-queue-server";
import {
  MAX_QUEUE_SAVE_ITEMS,
  classifyQueueItem,
  isUsableRulePattern,
  ruleSkippedNote,
  type QueueItemSaveResult,
} from "@/lib/review-queue";
import {
  createTagCore,
  createTagInputSchema,
  createTagRuleWithScreening,
  setTransactionTags,
} from "@/lib/transaction-tagging";
import { normalizePattern } from "@/lib/tags";

async function requireReviewAccess(token: string) {
  const access = await resolveReviewAccess(token);
  if (!access.ok) throw new Error("This link is no longer valid.");
  return access;
}

// ── Opened tracking ───────────────────────────────────────────────────────────

/** Called from the client after mount (never during server render, so link-preview bots don't count). */
export async function markOpened(token: string): Promise<{ ok: true }> {
  const access = await requireReviewAccess(token);
  await markBatchOpened(access.batchId);
  return { ok: true };
}

// ── Create a tag (from the picker's "Create new tag" row) ─────────────────────

export interface QueueTag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

export type CreateTagForQueueResult =
  | { ok: true; tag: QueueTag }
  | { ok: false; error: string };

export async function createTagForQueue(
  token: string,
  input: { shortName: string; parentId?: string }
): Promise<CreateTagForQueueResult> {
  await requireReviewAccess(token);

  const parsed = createTagInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Enter a tag name (up to 100 characters)." };
  }

  try {
    const { id } = await createTagCore(parsed.data);
    const tag = await db.tag.findUnique({
      where: { id },
      select: { id: true, name: true, shortName: true, parentId: true },
    });
    if (!tag) return { ok: false, error: "Couldn't create that tag." };
    revalidatePath("/tags");
    revalidatePath("/tag-rules");
    return { ok: true, tag };
  } catch (e) {
    // The duplicate-name / missing-parent messages are safe, user-facing text.
    if (
      e instanceof Error &&
      (e.message.startsWith("A tag named") || e.message === "Parent tag not found")
    ) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: "Couldn't create that tag." };
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

const saveSchema = z.object({
  items: z
    .array(
      z.object({
        transactionId: z.string().uuid(),
        tagId: z.string().uuid(),
        /** "Always tag this payee": a payee-only rule. Conflicts are never overridable here. */
        // Lenient on purpose: an unusable pattern must skip only the RULE (see
        // isUsableRulePattern below), never reject the whole Save.
        rule: z.object({ payeePattern: z.string().max(255) }).optional(),
      })
    )
    .min(1)
    .max(MAX_QUEUE_SAVE_ITEMS),
});

export type SaveQueueResult =
  | { ok: true; results: QueueItemSaveResult[]; completed: boolean }
  | { ok: false; error: string };

export async function saveQueue(
  token: string,
  input: z.input<typeof saveSchema>
): Promise<SaveQueueResult> {
  const access = await requireReviewAccess(token);

  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Pick a tag for at least one item before saving." };
  }

  // First occurrence of a transaction id wins.
  const byTx = new Map<string, (typeof parsed.data.items)[number]>();
  for (const item of parsed.data.items) {
    if (!byTx.has(item.transactionId)) byTx.set(item.transactionId, item);
  }
  const requested = [...byTx.values()];

  // Never trust a client-supplied transaction id beyond: it must be a PENDING
  // assignment in THIS batch (and still show-able, per classifyQueueItem).
  const allowedEntityIds = await getAssignableEntityIds();
  const assignments = await db.transactionAssignment.findMany({
    where: {
      batchId: access.batchId,
      status: "pending",
      transactionId: { in: requested.map((r) => r.transactionId) },
    },
    select: {
      id: true,
      status: true,
      transactionId: true,
      transaction: {
        select: {
          entityId: true,
          archivedAt: true,
          transferPairId: true,
          _count: { select: { tags: true } },
        },
      },
    },
  });
  const assignmentByTx = new Map(assignments.map((a) => [a.transactionId, a]));

  const tagIds = [...new Set(requested.map((r) => r.tagId))];
  const existingTags = await db.tag.findMany({
    where: { id: { in: tagIds } },
    select: { id: true },
  });
  const validTagIds = new Set(existingTags.map((t) => t.id));

  const ruleCache = new Map<string, Pick<QueueItemSaveResult, "rule" | "ruleNote">>();
  const results: QueueItemSaveResult[] = [];

  for (const item of requested) {
    const assignment = assignmentByTx.get(item.transactionId);
    if (!assignment) {
      results.push({ transactionId: item.transactionId, status: "not_in_queue", rule: "none" });
      continue;
    }

    const cls = classifyQueueItem(
      {
        assignmentStatus: assignment.status,
        archivedAt: assignment.transaction.archivedAt,
        transferPairId: assignment.transaction.transferPairId,
        tagCount: assignment.transaction._count.tags,
        entityId: assignment.transaction.entityId,
      },
      allowedEntityIds
    );
    if (cls === "already_tagged") {
      results.push({ transactionId: item.transactionId, status: "already_tagged", rule: "none" });
      continue;
    }
    if (cls !== "show") {
      results.push({ transactionId: item.transactionId, status: "not_in_queue", rule: "none" });
      continue;
    }
    if (!validTagIds.has(item.tagId)) {
      results.push({ transactionId: item.transactionId, status: "failed", rule: "none" });
      continue;
    }

    // One item's failure must not abort the rest.
    try {
      const written = await setTransactionTags(item.transactionId, [item.tagId], {
        userId: access.assigneeUserId, // Eva's real User.id, from the token's batch
        source: "review_queue",
        onlyIfUntagged: true,
      });
      if (written.status === "already_tagged") {
        results.push({ transactionId: item.transactionId, status: "already_tagged", rule: "none" });
        continue;
      }
      await db.transactionAssignment.updateMany({
        where: { id: assignment.id, status: "pending" },
        data: { status: "resolved", resolvedAt: new Date() },
      });
    } catch {
      console.error("[review-queue] saving an item failed");
      results.push({ transactionId: item.transactionId, status: "failed", rule: "none" });
      continue;
    }

    // Optional rule, only after the tag itself is safely saved. Screened by the
    // same conflict check as every other rule-save path; approveConflicts is
    // never passed, so Eva can never override or replace an existing rule.
    let ruleOutcome: Pick<QueueItemSaveResult, "rule" | "ruleNote"> = { rule: "none" };
    if (item.rule && !isUsableRulePattern(item.rule.payeePattern)) {
      ruleOutcome = {
        rule: "failed",
        ruleNote: "Rule not saved: the payee text is too short to match safely.",
      };
    } else if (item.rule) {
      const key =`${normalizePattern(item.rule.payeePattern)}|${item.tagId}`;
      const cached = ruleCache.get(key);
      if (cached) {
        ruleOutcome = cached;
      } else {
        try {
          const saved = await createTagRuleWithScreening({
            payeePattern: item.rule.payeePattern,
            tagId: item.tagId,
          });
          ruleOutcome =
            saved.status === "saved"
              ? { rule: "saved" }
              : {
                  rule: "skipped_conflict",
                  ruleNote: ruleSkippedNote(saved.conflicts.map((c) => c.kind)),
                };
        } catch {
          console.error("[review-queue] saving a rule failed");
          ruleOutcome = { rule: "failed", ruleNote: "Rule not saved." };
        }
        ruleCache.set(key, ruleOutcome);
      }
    }
    results.push({ transactionId: item.transactionId, status: "saved", ...ruleOutcome });
  }

  const { completed } = await closeBatchIfDone(access.batchId);

  revalidatePath("/transactions");
  if (results.some((r) => r.rule === "saved")) revalidatePath("/tag-rules");
  return { ok: true, results, completed };
}

// ── "Not sure - send back to Eric" ────────────────────────────────────────────

export type ReturnToEricResult =
  | { ok: true; completed: boolean }
  | { ok: false; error: string };

export async function returnToEric(
  token: string,
  transactionId: string
): Promise<ReturnToEricResult> {
  const access = await requireReviewAccess(token);

  const parsed = z.string().uuid().safeParse(transactionId);
  if (!parsed.success) return { ok: false, error: "Invalid item." };

  const { count } = await db.transactionAssignment.updateMany({
    where: { batchId: access.batchId, transactionId: parsed.data, status: "pending" },
    data: { status: "returned", resolvedAt: new Date() },
  });
  if (count !== 1) return { ok: false, error: "That item is no longer in your list." };

  const { completed } = await closeBatchIfDone(access.batchId);
  revalidatePath("/transactions");
  return { ok: true, completed };
}
