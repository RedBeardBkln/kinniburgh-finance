"use server";

// Eric-side "Assign to Eva" actions (Phase 1: draft assignment only; no
// sending, no token minting, no Eva-facing surface yet).
//
// Every export starts with requireAuth(). Eligibility is enforced HERE, not in
// the UI: only Personal and Sudden Valley transactions can be assigned, even
// if a caller bypasses the UI and passes arbitrary transaction ids.

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  ACTIVE_BATCH_STATUSES,
  checkAssignable,
  notAssignableMessage,
  type NotAssignableReason,
} from "@/lib/review-queue";
import { getAssignableEntityIds, resolveAssigneeFor } from "@/lib/review-queue-server";

function requireAuth(): Promise<{ id: string }> {
  return auth().then((session) => {
    const id = session?.user?.id;
    if (!id) throw new Error("Unauthorized");
    return { id };
  });
}

const MAX_ASSIGN_PER_CALL = 200;

const assignSchema = z.object({
  transactionIds: z.array(z.string().uuid()).min(1).max(MAX_ASSIGN_PER_CALL),
});

export type AssignRejectionReason = NotAssignableReason | "not_found";

export interface AssignRejection {
  transactionId: string;
  reason: AssignRejectionReason;
  message: string;
}

export type AssignTransactionsResult =
  | { ok: true; assigned: string[]; rejected: AssignRejection[] }
  | { ok: false; error: string };

// ── Assign (add to the caller's draft batch) ──────────────────────────────────

export async function assignTransactions(
  transactionIds: string[]
): Promise<AssignTransactionsResult> {
  const user = await requireAuth();

  const parsed = assignSchema.safeParse({ transactionIds });
  if (!parsed.success) {
    return { ok: false, error: "Select between 1 and 200 transactions to assign." };
  }
  const ids = [...new Set(parsed.data.transactionIds)];

  const assigneeResult = await resolveAssigneeFor(user.id);
  if (!assigneeResult.ok) {
    return {
      ok: false,
      error:
        assigneeResult.reason === "none"
          ? "No other household user found to assign to."
          : "More than one other household user found; can't determine who to assign to.",
    };
  }
  const assignee = assigneeResult.assignee;

  const allowedEntityIds = await getAssignableEntityIds();

  // archivedAt: null guard — an archived transaction is treated as not found.
  const txs = await db.transaction.findMany({
    where: { id: { in: ids }, archivedAt: null },
    select: {
      id: true,
      entityId: true,
      archivedAt: true,
      transferPairId: true,
      pending: true,
    },
  });
  const txById = new Map(txs.map((t) => [t.id, t]));

  const activeAssignments = await db.transactionAssignment.findMany({
    where: {
      transactionId: { in: ids },
      status: "pending",
      batch: { status: { in: [...ACTIVE_BATCH_STATUSES] } },
    },
    select: { transactionId: true },
  });
  const activeIds = new Set(activeAssignments.map((a) => a.transactionId));

  const eligible: string[] = [];
  const rejected: AssignRejection[] = [];
  for (const id of ids) {
    const tx = txById.get(id);
    if (!tx) {
      rejected.push({ transactionId: id, reason: "not_found", message: "Transaction not found" });
      continue;
    }
    const verdict = checkAssignable(
      {
        entityId: tx.entityId,
        archivedAt: tx.archivedAt,
        transferPairId: tx.transferPairId,
        pending: tx.pending,
        hasActiveAssignment: activeIds.has(id),
      },
      allowedEntityIds
    );
    if (verdict.ok) {
      eligible.push(id);
    } else {
      rejected.push({
        transactionId: id,
        reason: verdict.reason,
        message: notAssignableMessage(verdict.reason),
      });
    }
  }

  if (eligible.length === 0) {
    return { ok: true, assigned: [], rejected };
  }

  await db.$transaction(async (tx) => {
    // One open draft per (creator, assignee); create it on first assignment.
    const existingDraft = await tx.reviewBatch.findFirst({
      where: { createdByUserId: user.id, assigneeUserId: assignee.id, status: "draft" },
      select: { id: true },
    });
    const batchId =
      existingDraft?.id ??
      (
        await tx.reviewBatch.create({
          data: { createdByUserId: user.id, assigneeUserId: assignee.id, status: "draft" },
          select: { id: true },
        })
      ).id;

    for (const transactionId of eligible) {
      // (transactionId, batchId) is unique; a previously `removed` row for this
      // draft is revived rather than violating the constraint.
      await tx.transactionAssignment.upsert({
        where: { transactionId_batchId: { transactionId, batchId } },
        create: { transactionId, batchId, status: "pending" },
        update: { status: "pending", resolvedAt: null },
      });
    }
  });

  revalidatePath("/transactions");
  return { ok: true, assigned: eligible, rejected };
}

// ── Unassign (remove from the caller's draft) ─────────────────────────────────

export type UnassignResult = { ok: true } | { ok: false; error: string };

export async function unassignTransaction(transactionId: string): Promise<UnassignResult> {
  const user = await requireAuth();

  const parsed = z.string().uuid().safeParse(transactionId);
  if (!parsed.success) return { ok: false, error: "Invalid transaction." };

  // Scoped to the caller's own DRAFT batch: another user's batch, or a batch
  // that has already been submitted, is never matched (and so never modified).
  const assignment = await db.transactionAssignment.findFirst({
    where: {
      transactionId: parsed.data,
      status: "pending",
      batch: { createdByUserId: user.id, status: "draft" },
    },
    select: { id: true },
  });
  if (!assignment) return { ok: false, error: "No draft assignment found for this transaction." };

  const { count } = await db.transactionAssignment.updateMany({
    where: { id: assignment.id, status: "pending" },
    data: { status: "removed" },
  });
  if (count !== 1) return { ok: false, error: "This assignment was already changed." };

  revalidatePath("/transactions");
  return { ok: true };
}

// ── Draft summary (for the Eric-side UI) ──────────────────────────────────────

export interface DraftBatchSummary {
  /** null when the single other household user couldn't be determined. */
  assignee: { id: string; name: string } | null;
  /** Human-readable explanation shown (and the control disabled) when assignee is null. */
  assigneeProblem: string | null;
  draftCount: number;
}

export async function getDraftBatchSummary(): Promise<DraftBatchSummary> {
  const user = await requireAuth();

  const assigneeResult = await resolveAssigneeFor(user.id);
  if (!assigneeResult.ok) {
    return {
      assignee: null,
      assigneeProblem:
        assigneeResult.reason === "none"
          ? "No other household user found to assign to."
          : "More than one other household user found; can't determine who to assign to.",
      draftCount: 0,
    };
  }
  const assignee = assigneeResult.assignee;

  const draftCount = await db.transactionAssignment.count({
    where: {
      status: "pending",
      batch: { createdByUserId: user.id, assigneeUserId: assignee.id, status: "draft" },
    },
  });

  return { assignee: { id: assignee.id, name: assignee.name }, assigneeProblem: null, draftCount };
}
