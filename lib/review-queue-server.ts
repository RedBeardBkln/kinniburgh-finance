// DB-aware helpers for the "Assign to Eva" review queue. Deliberately NOT a
// "use server" module: these are plain functions called by actions/*.ts (which
// perform requireAuth() first) and by server components that have already
// verified the session. Pure rules live in lib/review-queue.ts.

import { db } from "@/lib/db";
import {
  ASSIGNABLE_ENTITY_SLUGS,
  assignmentChipKind,
  resolveAssignee,
  type AssigneeResolution,
  type AssignmentChipKind,
} from "@/lib/review-queue";

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
