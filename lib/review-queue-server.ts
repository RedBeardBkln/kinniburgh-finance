// DB-aware helpers for the "Assign to Eva" review queue. Deliberately NOT a
// "use server" module: these are plain functions called by actions/*.ts (which
// perform requireAuth() first) and by server components that have already
// verified the session. Pure rules live in lib/review-queue.ts.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  ASSIGNABLE_ENTITY_SLUGS,
  assignmentChipKind,
  batchProgress,
  classifyQueueItem,
  resolveAssignee,
  type AssigneeResolution,
  type AssignmentChipKind,
} from "@/lib/review-queue";
import {
  evaluateReviewToken,
  generateReviewToken,
  hashReviewToken,
  isPlausibleReviewToken,
  reviewTokenExpiry,
  type ReviewTokenInvalidReason,
} from "@/lib/review-token";

/** Entity ids for the assignable buckets (Personal, Sudden Valley), resolved by slug. Fail-closed: empty if none found. */
export async function getAssignableEntityIds(): Promise<Set<string>> {
  const entities = await db.entity.findMany({
    where: { slug: { in: [...ASSIGNABLE_ENTITY_SLUGS] }, archivedAt: null },
    select: { id: true },
  });
  return new Set(entities.map((e) => e.id));
}

/** The single other household user, or a reason one couldn't be determined. */
export async function resolveAssigneeFor(currentUserId: string): Promise<AssigneeResolution> {
  const users = await db.user.findMany({ select: { id: true, name: true } });
  return resolveAssignee(users, currentUserId);
}

export interface RowAssignmentState {
  assignmentId: string;
  batchId: string;
  kind: AssignmentChipKind;
}

/**
 * For a page of transactions, the assignment (if any) that should display as a
 * chip. Only `pending` (draft/submitted batch) and `returned` assignments are
 * visible; at most one per transaction (a transaction can only have one
 * pending assignment, and a newer row wins over an older `returned` one).
 */
export async function loadAssignmentStates(
  transactionIds: readonly string[]
): Promise<Map<string, RowAssignmentState>> {
  const result = new Map<string, RowAssignmentState>();
  if (transactionIds.length === 0) return result;

  const rows = await db.transactionAssignment.findMany({
    where: {
      transactionId: { in: [...transactionIds] },
      status: { in: ["pending", "returned"] },
      batch: { status: { in: ["draft", "submitted", "completed"] } },
    },
    select: {
      id: true,
      transactionId: true,
      batchId: true,
      status: true,
      createdAt: true,
      batch: { select: { status: true } },
    },
    orderBy: { createdAt: "asc" }, // later rows overwrite earlier ones in the map
  });

  for (const row of rows) {
    const kind = assignmentChipKind(row.batch.status, row.status);
    if (kind === null) continue;
    result.set(row.transactionId, { assignmentId: row.id, batchId: row.batchId, kind });
  }
  return result;
}

// ── Advisory lock for the (creator, assignee) pair ──────────────────────────────

/** Interactive-transaction limits: batches can hold up to ~200 rows over a pooled connection. */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Serializes assign/submit for one (creator, assignee) pair for the life of the
 * surrounding interactive transaction (pg_advisory_xact_lock is released
 * automatically on commit/rollback). Closes the "two tabs both create a draft"
 * and "same transaction pending in two drafts" races from the Phase 1 review.
 * Must be the FIRST statement inside the $transaction callback.
 */
export async function lockAssignPair(
  tx: Prisma.TransactionClient,
  creatorUserId: string,
  assigneeUserId: string
): Promise<void> {
  const key = `review-assign:${creatorUserId}:${assigneeUserId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

// ── Token validation (Eva's link) ───────────────────────────────────────────────

export type ReviewAccess =
  | { ok: true; batchId: string; assigneeUserId: string }
  | { ok: false; reason: ReviewTokenInvalidReason };

/**
 * Validates a raw token against the DB. Called on EVERY page render and EVERY
 * token-gated server action (there is no cookie session). Fails closed: an
 * implausible token never touches the DB. Never logs or echoes the token.
 */
export async function resolveReviewAccess(
  token: unknown,
  now: Date = new Date()
): Promise<ReviewAccess> {
  if (!isPlausibleReviewToken(token)) return { ok: false, reason: "not_found" };

  const row = await db.reviewLinkToken.findUnique({
    where: { tokenHash: hashReviewToken(token) },
    select: {
      expiresAt: true,
      revokedAt: true,
      batch: { select: { id: true, status: true, expiresAt: true, assigneeUserId: true } },
    },
  });

  const verdict = evaluateReviewToken({
    tokenRow: row ? { expiresAt: row.expiresAt, revokedAt: row.revokedAt } : null,
    batch: row ? { status: row.batch.status, expiresAt: row.batch.expiresAt } : null,
    now,
  });
  if (!verdict.valid) return { ok: false, reason: verdict.reason };
  if (!row) return { ok: false, reason: "not_found" };
  return { ok: true, batchId: row.batch.id, assigneeUserId: row.batch.assigneeUserId };
}

// ── Eva's queue ─────────────────────────────────────────────────────────────────

export interface QueueItem {
  transactionId: string;
  postedAt: string; // ISO
  /** payeeRaw ?? payeeNormalized; empty string when the transaction has no payee text. */
  payee: string;
  /** Signed Decimal string; negative = outflow. */
  amount: string;
  accountId: string;
  accountNickname: string;
  accountMask: string | null;
  bucketLabel: string;
}

interface PendingAssignmentState {
  assignmentId: string;
  transactionId: string;
  item: QueueItem;
  show: boolean;
}

async function loadPendingAssignments(batchId: string): Promise<PendingAssignmentState[]> {
  const allowed = await getAssignableEntityIds();
  const rows = await db.transactionAssignment.findMany({
    where: { batchId, status: "pending" },
    select: {
      id: true,
      status: true,
      transaction: {
        select: {
          id: true,
          postedAt: true,
          payeeRaw: true,
          payeeNormalized: true,
          amount: true,
          accountId: true,
          entityId: true,
          archivedAt: true,
          transferPairId: true,
          account: { select: { nickname: true, mask: true } },
          entity: { select: { navLabel: true, name: true } },
          _count: { select: { tags: true } },
        },
      },
    },
  });

  const states = rows.map((r) => {
    const t = r.transaction;
    const cls = classifyQueueItem(
      {
        assignmentStatus: r.status,
        archivedAt: t.archivedAt,
        transferPairId: t.transferPairId,
        tagCount: t._count.tags,
        entityId: t.entityId,
      },
      allowed
    );
    return {
      sortKey: t.postedAt.getTime(),
      state: {
        assignmentId: r.id,
        transactionId: t.id,
        show: cls === "show",
        item: {
          transactionId: t.id,
          postedAt: t.postedAt.toISOString(),
          payee: t.payeeRaw ?? t.payeeNormalized ?? "",
          amount: new Prisma.Decimal(t.amount).toString(),
          accountId: t.accountId,
          accountNickname: t.account.nickname,
          accountMask: t.account.mask,
          bucketLabel: t.entity.navLabel ?? t.entity.name,
        },
      } satisfies PendingAssignmentState,
    };
  });
  // Newest first, id as a stable tiebreak.
  states.sort(
    (a, b) => b.sortKey - a.sortKey || a.state.transactionId.localeCompare(b.state.transactionId)
  );
  return states.map((s) => s.state);
}

/** The items Eva should see right now for a validated batch. */
export async function loadQueueItems(batchId: string): Promise<QueueItem[]> {
  const states = await loadPendingAssignments(batchId);
  return states.filter((s) => s.show).map((s) => s.item);
}

/** Set once, from the client (never during server render): bots must not count as "opened". */
export async function markBatchOpened(batchId: string, now: Date = new Date()): Promise<void> {
  await db.reviewBatch.updateMany({
    where: { id: batchId, firstOpenedAt: null },
    data: { firstOpenedAt: now },
  });
}

/**
 * If nothing is left for Eva to do (every assignment resolved, returned, or no
 * longer applicable), complete the batch and revoke every token for it.
 * Pending assignments that dropped off her list (tagged elsewhere, archived,
 * ...) are marked resolved at the same time.
 */
export async function closeBatchIfDone(
  batchId: string,
  now: Date = new Date()
): Promise<{ completed: boolean }> {
  const states = await loadPendingAssignments(batchId);
  if (states.some((s) => s.show)) return { completed: false };

  const droppedIds = states.map((s) => s.assignmentId);
  await db.$transaction(async (tx) => {
    if (droppedIds.length > 0) {
      await tx.transactionAssignment.updateMany({
        where: { id: { in: droppedIds }, status: "pending" },
        data: { status: "resolved", resolvedAt: now },
      });
    }
    await tx.reviewBatch.updateMany({
      where: { id: batchId, status: "submitted" },
      data: { status: "completed", completedAt: now },
    });
    await tx.reviewLinkToken.updateMany({
      where: { batchId, revokedAt: null },
      data: { revokedAt: now },
    });
  });
  return { completed: true };
}

// ── Submit (Eric) ───────────────────────────────────────────────────────────────

export type SubmitBatchResult =
  | {
      ok: true;
      batchId: string;
      /** Raw token: returned to the caller exactly once and never stored. */
      token: string;
      appended: boolean;
      itemCount: number;
      expiresAt: Date;
    }
  | { ok: false; error: string };

/**
 * Submits the creator's draft for the assignee. If a submitted batch for the
 * assignee is still open, the draft's items are appended to it (one list for
 * Eva) instead of starting a second batch. Mints one fresh link token with a new
 * 7-day window. Atomic and serialized per (creator, assignee) pair, so a
 * double-click cannot submit twice.
 */
export async function submitDraftBatch(
  creatorUserId: string,
  assigneeUserId: string,
  now: Date = new Date()
): Promise<SubmitBatchResult> {
  const expiresAt = reviewTokenExpiry(now);
  return db.$transaction(async (tx): Promise<SubmitBatchResult> => {
    await lockAssignPair(tx, creatorUserId, assigneeUserId);

    const draft = await tx.reviewBatch.findFirst({
      where: { createdByUserId: creatorUserId, assigneeUserId, status: "draft" },
      select: { id: true },
    });
    if (!draft) return { ok: false, error: "Nothing to submit." };

    const draftItems = await tx.transactionAssignment.findMany({
      where: { batchId: draft.id, status: "pending" },
      select: { id: true, transactionId: true },
    });
    if (draftItems.length === 0) return { ok: false, error: "Nothing to submit." };

    const open = await tx.reviewBatch.findFirst({
      where: { assigneeUserId, status: "submitted" },
      orderBy: { submittedAt: "desc" },
      select: { id: true },
    });

    let batchId: string;
    if (open) {
      batchId = open.id;
      // Items whose transaction already has a row in the open batch (e.g. Eva
      // sent it back earlier and Eric re-assigned it) can't be re-pointed
      // without violating (transactionId, batchId) uniqueness: revive the
      // existing row and retire the draft row instead. Everything else moves in
      // one bulk update.
      const alreadyInOpen = await tx.transactionAssignment.findMany({
        where: { batchId, transactionId: { in: draftItems.map((i) => i.transactionId) } },
        select: { id: true, transactionId: true },
      });
      const openRowByTx = new Map(alreadyInOpen.map((r) => [r.transactionId, r.id]));
      const conflicting = draftItems.filter((i) => openRowByTx.has(i.transactionId));
      const movable = draftItems.filter((i) => !openRowByTx.has(i.transactionId));

      if (movable.length > 0) {
        await tx.transactionAssignment.updateMany({
          where: { id: { in: movable.map((i) => i.id) } },
          data: { batchId },
        });
      }
      for (const item of conflicting) {
        await tx.transactionAssignment.update({
          where: { id: openRowByTx.get(item.transactionId)! },
          data: { status: "pending", resolvedAt: null },
        });
        await tx.transactionAssignment.update({
          where: { id: item.id },
          data: { status: "removed" },
        });
      }
      await tx.reviewBatch.update({ where: { id: batchId }, data: { expiresAt } });
    } else {
      batchId = draft.id;
      const { count } = await tx.reviewBatch.updateMany({
        where: { id: draft.id, status: "draft" },
        data: { status: "submitted", submittedAt: now, expiresAt },
      });
      if (count !== 1) return { ok: false, error: "This batch was already submitted." };
    }

    const { token, tokenHash } = generateReviewToken();
    await tx.reviewLinkToken.create({
      data: { batchId, tokenHash, kind: open ? "resend" : "initial", expiresAt },
    });

    return {
      ok: true,
      batchId,
      token,
      appended: open !== null,
      itemCount: draftItems.length,
      expiresAt,
    };
  }, TX_OPTIONS);
}

/**
 * Mints a fresh link token for a submitted batch (the raw token can never be
 * recovered from its stored hash). Extends the batch expiry to the new 7-day
 * window. Returns null if the batch is not open.
 */
export async function mintShareToken(
  batchId: string,
  now: Date = new Date()
): Promise<{ token: string; expiresAt: Date } | null> {
  const expiresAt = reviewTokenExpiry(now);
  return db.$transaction(async (tx) => {
    const { count } = await tx.reviewBatch.updateMany({
      where: { id: batchId, status: "submitted" },
      data: { expiresAt },
    });
    if (count !== 1) return null;
    const { token, tokenHash } = generateReviewToken();
    await tx.reviewLinkToken.create({
      data: { batchId, tokenHash, kind: "resend", expiresAt },
    });
    return { token, expiresAt };
  });
}

/**
 * Mints a token for the one reminder text. Unlike mintShareToken this does NOT
 * extend the batch expiry (reminders never extend the window); the new token
 * expires with the batch, and the original link keeps working alongside it.
 */
export async function mintReminderToken(
  batchId: string,
  batchExpiresAt: Date
): Promise<{ token: string }> {
  const { token, tokenHash } = generateReviewToken();
  await db.reviewLinkToken.create({
    data: { batchId, tokenHash, kind: "reminder", expiresAt: batchExpiresAt },
  });
  return { token };
}

// ── Eric's batch-status panel ───────────────────────────────────────────────────

export interface BatchStatusRow {
  id: string;
  status: string;
  submittedAt: string | null; // ISO
  firstOpenedAt: string | null; // ISO
  expiresAt: string | null; // ISO
  /** Most recent text attempt: null (never texted) | "sent" | "failed". */
  smsStatus: string | null;
  smsSentAt: string | null; // ISO
  smsError: string | null;
  /** null | "sending" | "sent" | "failed" */
  reminderStatus: string | null;
  reminderSentAt: string | null; // ISO
  reminderError: string | null;
  total: number;
  resolved: number;
  returned: number;
  pending: number;
}

/** The creator's most recent submitted/completed batches (newest first). */
export async function loadBatchStatuses(
  creatorUserId: string,
  limit = 5
): Promise<BatchStatusRow[]> {
  const batches = await db.reviewBatch.findMany({
    where: { createdByUserId: creatorUserId, status: { in: ["submitted", "completed"] } },
    orderBy: { submittedAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      submittedAt: true,
      firstOpenedAt: true,
      expiresAt: true,
      smsStatus: true,
      smsSentAt: true,
      smsError: true,
      reminderStatus: true,
      reminderSentAt: true,
      reminderError: true,
      assignments: { select: { status: true } },
    },
  });
  return batches.map((b) => ({
    id: b.id,
    status: b.status,
    submittedAt: b.submittedAt?.toISOString() ?? null,
    firstOpenedAt: b.firstOpenedAt?.toISOString() ?? null,
    expiresAt: b.expiresAt?.toISOString() ?? null,
    smsStatus: b.smsStatus,
    smsSentAt: b.smsSentAt?.toISOString() ?? null,
    smsError: b.smsError,
    reminderStatus: b.reminderStatus,
    reminderSentAt: b.reminderSentAt?.toISOString() ?? null,
    reminderError: b.reminderError,
    ...batchProgress(b.assignments.map((a) => a.status)),
  }));
}
