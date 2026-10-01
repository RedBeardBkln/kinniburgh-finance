// Pure logic for the "Assign to Eva" review queue (Phase 1: eligibility +
// draft assignment). No DB access and no Prisma value imports, so this module
// is safe to import from both server actions and "use client" components.
//
// Eligibility is enforced SERVER-SIDE in actions/review-assignments.ts via
// checkAssignable(); the UI uses the same function only to disable controls.

/** Entity slugs whose transactions may be assigned for review. EK Consulting and Mezzo are intentionally excluded. */
export const ASSIGNABLE_ENTITY_SLUGS = ["personal", "sudden-valley"] as const;

export function isAssignableEntitySlug(slug: string | null | undefined): boolean {
  return slug != null && (ASSIGNABLE_ENTITY_SLUGS as readonly string[]).includes(slug);
}

// ── Statuses (plain strings in the DB; validated here) ─────────────────────────

export const BATCH_STATUSES = ["draft", "submitted", "completed", "cancelled"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const ASSIGNMENT_STATUSES = ["pending", "resolved", "returned", "removed"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** Batch statuses in which a pending assignment still "holds" its transaction. */
export const ACTIVE_BATCH_STATUSES: readonly BatchStatus[] = ["draft", "submitted"];

// ── Eligibility ─────────────────────────────────────────────────────────────────

export type NotAssignableReason =
  | "wrong_entity"
  | "archived"
  | "transfer_leg"
  | "pending"
  | "already_assigned";

export type AssignableResult =
  | { ok: true }
  | { ok: false; reason: NotAssignableReason };

export interface AssignableCandidate {
  entityId: string | null | undefined;
  archivedAt: Date | null;
  transferPairId: string | null;
  /** Bank-pending (not yet posted) transaction. */
  pending: boolean;
  /** True when a `pending` assignment already exists on a draft/submitted batch. */
  hasActiveAssignment: boolean;
}

/**
 * Decides whether a transaction can be assigned for review. Checks run in a
 * fixed order so the reported reason is deterministic: entity first (the
 * security-relevant rule), then archived, transfer leg, bank-pending, already
 * assigned.
 *
 * `allowedEntityIds` must be resolved server-side from ASSIGNABLE_ENTITY_SLUGS;
 * an empty set rejects everything (fail closed).
 */
export function checkAssignable(
  tx: AssignableCandidate,
  allowedEntityIds: ReadonlySet<string>
): AssignableResult {
  if (!tx.entityId || !allowedEntityIds.has(tx.entityId)) {
    return { ok: false, reason: "wrong_entity" };
  }
  if (tx.archivedAt !== null) return { ok: false, reason: "archived" };
  if (tx.transferPairId !== null) return { ok: false, reason: "transfer_leg" };
  if (tx.pending) return { ok: false, reason: "pending" };
  if (tx.hasActiveAssignment) return { ok: false, reason: "already_assigned" };
  return { ok: true };
}

export function notAssignableMessage(reason: NotAssignableReason): string {
  switch (reason) {
    case "wrong_entity":
      return "Only Personal and Sudden Valley transactions can be assigned";
    case "archived":
      return "Archived transactions can't be assigned";
    case "transfer_leg":
      return "Transfers can't be assigned";
    case "pending":
      return "Pending (not yet posted) transactions can't be assigned";
    case "already_assigned":
      return "Already assigned";
  }
}

// ── Assignee resolution ─────────────────────────────────────────────────────────

export interface HouseholdUser {
  id: string;
  name: string;
}

export type AssigneeResolution =
  | { ok: true; assignee: HouseholdUser }
  | { ok: false; reason: "none" | "ambiguous" };

/**
 * The assignee is the single other household user. If there is not exactly one
 * other user we refuse to guess (the UI disables the control with a note).
 */
export function resolveAssignee(
  users: readonly HouseholdUser[],
  currentUserId: string
): AssigneeResolution {
  const others = users.filter((u) => u.id !== currentUserId);
  if (others.length === 0) return { ok: false, reason: "none" };
  if (others.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, assignee: others[0]! };
}

/** First name for button/chip labels: "Eva-Laura Ramirez-Wisiackas" -> "Eva". */
export function assigneeFirstName(name: string): string {
  const first = name.trim().split(/[\s-]+/)[0];
  return first && first.length > 0 ? first : "assignee";
}

// ── Row chip (Eric-side UI) ─────────────────────────────────────────────────────

export type AssignmentChipKind = "draft" | "with_assignee" | "returned";

/**
 * Maps a (batch status, assignment status) pair to the chip shown under the
 * payee, or null when nothing should be shown (resolved/removed/cancelled).
 */
export function assignmentChipKind(
  batchStatus: string,
  assignmentStatus: string
): AssignmentChipKind | null {
  if (assignmentStatus === "returned") {
    return batchStatus === "cancelled" ? null : "returned";
  }
  if (assignmentStatus !== "pending") return null;
  if (batchStatus === "draft") return "draft";
  if (batchStatus === "submitted") return "with_assignee";
  return null;
}

export function assignmentChipLabel(kind: AssignmentChipKind, assigneeName: string): string {
  const who = assigneeFirstName(assigneeName);
  switch (kind) {
    case "draft":
      return `Draft for ${who}`;
    case "with_assignee":
      return `With ${who}`;
    case "returned":
      return `Returned by ${who}`;
  }
}

/** True when this assignment blocks the transaction from being assigned again. */
export function isActiveAssignment(batchStatus: string, assignmentStatus: string): boolean {
  return (
    assignmentStatus === "pending" &&
    (ACTIVE_BATCH_STATUSES as readonly string[]).includes(batchStatus)
  );
}
