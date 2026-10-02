"use server";

// Eric-side "Assign to Eva" actions: draft assignment, Submit (mints the magic
// link and texts it), Resend text, and Get link.
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
import {
  TX_OPTIONS,
  getAssignableEntityIds,
  lockAssignPair,
  mintShareToken,
  resolveAssigneeFor,
  submitDraftBatch,
} from "@/lib/review-queue-server";
import { sendBatchText } from "@/lib/review-sms-server";

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

  // Pass 1 (outside the lock): everything except "already assigned".
  const rejectedById = new Map<string, AssignRejection>();
  const candidates: string[] = [];
  for (const id of ids) {
    const tx = txById.get(id);
    if (!tx) {
      rejectedById.set(id, { transactionId: id, reason: "not_found", message: "Transaction not found" });
      continue;
    }
    const verdict = checkAssignable(
      {
        entityId: tx.entityId,
        archivedAt: tx.archivedAt,
        transferPairId: tx.transferPairId,
        pending: tx.pending,
        hasActiveAssignment: false,
      },
      allowedEntityIds
    );
    if (verdict.ok) {
      candidates.push(id);
    } else {
      rejectedById.set(id, {
        transactionId: id,
        reason: verdict.reason,
        message: notAssignableMessage(verdict.reason),
      });
    }
  }

  const orderedRejections = (): AssignRejection[] =>
    ids.filter((id) => rejectedById.has(id)).map((id) => rejectedById.get(id)!);

  if (candidates.length === 0) {
    return { ok: true, assigned: [], rejected: orderedRejections() };
  }

  // Pass 2 (inside the pair lock): the "already assigned" check and the writes
  // happen under pg_advisory_xact_lock for (creator, assignee), so two
  // concurrent calls can neither create two drafts nor put one transaction
  // into two pending assignments.
  const assigned = await db.$transaction(async (tx) => {
    await lockAssignPair(tx, user.id, assignee.id);

    const activeAssignments = await tx.transactionAssignment.findMany({
      where: {
        transactionId: { in: candidates },
        status: "pending",
        batch: { status: { in: [...ACTIVE_BATCH_STATUSES] } },
      },
      select: { transactionId: true },
    });
    const activeIds = new Set(activeAssignments.map((a) => a.transactionId));

    const eligible: string[] = [];
    for (const id of candidates) {
      if (activeIds.has(id)) {
        const reason: NotAssignableReason = "already_assigned";
        rejectedById.set(id, { transactionId: id, reason, message: notAssignableMessage(reason) });
      } else {
        eligible.push(id);
      }
    }
    if (eligible.length === 0) return eligible;

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
    return eligible;
  }, TX_OPTIONS);

  revalidatePath("/transactions");
  return { ok: true, assigned, rejected: orderedRejections() };
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

// ── Mark an assignee-tagged row as reviewed (clears the "Tag assigned by" badge) ──

/**
 * Eric has looked at a tag the assignee saved: retire the badge. Scoped to the
 * caller's own batches and only to `resolved` assignments, so it can never touch
 * a pending/returned one or another user's batch. The tag itself is untouched.
 */
export async function markAssigneeTagReviewed(transactionId: string): Promise<UnassignResult> {
  const user = await requireAuth();

  const parsed = z.string().uuid().safeParse(transactionId);
  if (!parsed.success) return { ok: false, error: "Invalid transaction." };

  const { count } = await db.transactionAssignment.updateMany({
    where: {
      transactionId: parsed.data,
      status: "resolved",
      batch: { createdByUserId: user.id },
    },
    data: { status: "removed" },
  });
  if (count === 0) return { ok: false, error: "Nothing to mark as reviewed for this transaction." };

  revalidatePath("/transactions");
  return { ok: true };
}

// ── Submit (hand the draft to the assignee) ───────────────────────────────────
//
// Submit mints a magic-link token, texts it to the assignee (SMS gateway via
// lib/review-sms-server.ts) and returns its path to Eric so he always has a
// manual fallback. Only a SHA-256 hash is stored, so the raw token cannot be
// shown again; "Get link" mints a fresh one. A failed text NEVER rolls back the
// submit: it is recorded on the batch and surfaced to Eric.

export type ShareLinkResult =
  | { ok: true; path: string; expiresAt: string }
  | { ok: false; error: string };

/** Outcome of the text for the action that just ran; the durable copy is on the batch. */
export type TextOutcome = { sent: true } | { sent: false; error: string };

export type SubmitToAssigneeResult =
  | {
      ok: true;
      batchId: string;
      /** App-relative path containing the raw token; the client prefixes its own origin. */
      path: string;
      /** True when the items were appended to an already-open batch. */
      appended: boolean;
      itemCount: number;
      expiresAt: string;
      text: TextOutcome;
    }
  | { ok: false; error: string };

export type ResendTextResult =
  | { ok: true; path: string; expiresAt: string; text: TextOutcome }
  | { ok: false; error: string };

export async function submitToEva(): Promise<SubmitToAssigneeResult> {
  const user = await requireAuth();

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

  const result = await submitDraftBatch(user.id, assigneeResult.assignee.id);
  if (!result.ok) return result;

  // The submit has committed (batch + token exist). Texting happens AFTER and
  // can never undo it; sendBatchText never throws and records the outcome.
  // An append to an open batch is a "resend" (new token, fresh text).
  const sms = await sendBatchText(result.batchId, result.token, result.appended ? "resend" : "initial");

  revalidatePath("/transactions");
  return {
    ok: true,
    batchId: result.batchId,
    path: `/queue/${result.token}`,
    appended: result.appended,
    itemCount: result.itemCount,
    expiresAt: result.expiresAt.toISOString(),
    text: sms.ok ? { sent: true } : { sent: false, error: sms.error },
  };
}

/**
 * Mints a new link for an open batch and texts it again (the old raw token can
 * never be re-sent: only its hash is stored). Updates the batch's text status;
 * does not touch or consume the single 24h reminder. The new path is returned
 * too, so Eric can still share it by hand if the gateway fails again.
 */
export async function resendText(batchId: string): Promise<ResendTextResult> {
  await requireAuth();

  const parsed = z.string().uuid().safeParse(batchId);
  if (!parsed.success) return { ok: false, error: "Invalid batch." };

  const minted = await mintShareToken(parsed.data);
  if (!minted) return { ok: false, error: "This batch is no longer open." };

  const sms = await sendBatchText(parsed.data, minted.token, "resend");

  revalidatePath("/transactions");
  return {
    ok: true,
    path: `/queue/${minted.token}`,
    expiresAt: minted.expiresAt.toISOString(),
    text: sms.ok ? { sent: true } : { sent: false, error: sms.error },
  };
}

/** Mints a fresh link for an open (submitted) batch. The raw token is returned once and never stored. */
export async function getShareLink(batchId: string): Promise<ShareLinkResult> {
  await requireAuth();

  const parsed = z.string().uuid().safeParse(batchId);
  if (!parsed.success) return { ok: false, error: "Invalid batch." };

  const minted = await mintShareToken(parsed.data);
  if (!minted) return { ok: false, error: "This batch is no longer open." };

  revalidatePath("/transactions");
  return { ok: true, path: `/queue/${minted.token}`, expiresAt: minted.expiresAt.toISOString() };
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
