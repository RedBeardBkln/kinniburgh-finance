// Pure logic for the "Assign to Eva" review queue (Phase 1: eligibility +
// draft assignment). No DB access and no Prisma value imports, so this module
// is safe to import from both server actions and "use client" components.
//
// Eligibility is enforced SERVER-SIDE in actions/review-assignments.ts via
// checkAssignable(); the UI uses the same function only to disable controls.

import { alnum, matchTagRule, normalizePayee, type TagRuleCandidate } from "@/lib/tags";

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

// ── Queue item classification (Eva's page) ─────────────────────────────────────

export type QueueItemClass =
  | "show"
  | "not_pending"
  | "archived"
  | "transfer_leg"
  | "already_tagged"
  | "wrong_entity";

export interface QueueItemCandidate {
  assignmentStatus: string;
  archivedAt: Date | null;
  transferPairId: string | null;
  /** Number of tags currently on the transaction. */
  tagCount: number;
  entityId: string | null | undefined;
}

/**
 * Whether an assignment still belongs on Eva's list. A pending assignment drops
 * off silently if the transaction has since been tagged (by Eric, the auto-tag
 * cron, or a newly saved rule), archived, turned out to be a transfer leg, or is
 * (somehow) outside the assignable entities. Anything but "show" counts as
 * resolved for batch-completion purposes. Same entity allow-list as eligibility
 * (defense in depth: a hand-inserted assignment for another entity is never
 * visible or writable through a token).
 */
export function classifyQueueItem(
  item: QueueItemCandidate,
  allowedEntityIds: ReadonlySet<string>
): QueueItemClass {
  if (item.assignmentStatus !== "pending") return "not_pending";
  if (!item.entityId || !allowedEntityIds.has(item.entityId)) return "wrong_entity";
  if (item.archivedAt !== null) return "archived";
  if (item.transferPairId !== null) return "transfer_leg";
  if (item.tagCount > 0) return "already_tagged";
  return "show";
}

/** A batch is complete when no item is still "show" (empty counts as complete). */
export function isBatchComplete(classes: readonly QueueItemClass[]): boolean {
  return classes.every((c) => c !== "show");
}

export function batchProgress(statuses: readonly string[]): {
  total: number;
  resolved: number;
  returned: number;
  pending: number;
} {
  let resolved = 0;
  let returned = 0;
  let pending = 0;
  for (const s of statuses) {
    if (s === "resolved") resolved++;
    else if (s === "returned") returned++;
    else if (s === "pending") pending++;
  }
  return { total: resolved + returned + pending, resolved, returned, pending };
}

// ── "Always tag this payee" similar-item matching (in-queue only) ──────────────

export interface SimilarityItem {
  id: string;
  /** payeeRaw ?? payeeNormalized, un-normalized. */
  payee: string;
  /** Absolute amount. */
  amount: number;
  accountId: string;
}

/**
 * Ids of OTHER items a payee-only rule with `pattern` would match, using the
 * exact semantics of matchTagRule (alnum-stripped contains-matching, so case and
 * punctuation don't matter). An empty/blank pattern matches nothing here: the
 * queue never saves a rule with no payee pattern.
 */
export function findSimilarItems(
  pattern: string,
  items: readonly SimilarityItem[],
  excludeId: string
): string[] {
  if (!isUsableRulePattern(pattern)) return [];
  const rule: TagRuleCandidate = {
    tagId: "candidate",
    payeePattern: pattern,
    amountMin: null,
    amountMax: null,
    accountId: null,
  };
  return items
    .filter((i) => i.id !== excludeId)
    .filter(
      (i) =>
        matchTagRule([rule], {
          normalizedPayee: normalizePayee(i.payee),
          amount: i.amount,
          accountId: i.accountId,
        }) !== null
    )
    .map((i) => i.id);
}

// ── Eva-side save contract ──────────────────────────────────────────────────────

export const MAX_QUEUE_SAVE_ITEMS = 200;

export type QueueItemSaveStatus = "saved" | "already_tagged" | "not_in_queue" | "failed";
export type QueueRuleStatus = "none" | "saved" | "skipped_conflict" | "failed";

export interface QueueItemSaveResult {
  transactionId: string;
  status: QueueItemSaveStatus;
  rule: QueueRuleStatus;
  /** Plain-language note shown when the rule was not saved. */
  ruleNote?: string;
}

/**
 * Minimum alphanumeric characters in an "always tag this payee" pattern. matchTagRule
 * uses alnum-stripped contains-matching, so an empty/punctuation-only pattern would
 * match EVERY payee and a 1-2 character one nearly so; such a rule is never saved
 * from the queue (enforced server-side, mirrored in the UI).
 */
export const MIN_RULE_PATTERN_ALNUM = 3;

export function isUsableRulePattern(pattern: string): boolean {
  return alnum(pattern).length >= MIN_RULE_PATTERN_ALNUM;
}

/** Plain-language explanation of why a requested rule was not saved. */
export function ruleSkippedNote(kinds: readonly string[]): string {
  if (kinds.length > 0 && kinds.every((k) => k === "duplicate")) {
    return "A rule like this already exists, so none was added.";
  }
  return "Rule not saved: it overlaps an existing rule. Eric can add it later.";
}

/** True when this assignment blocks the transaction from being assigned again. */
export function isActiveAssignment(batchStatus: string, assignmentStatus: string): boolean {
  return (
    assignmentStatus === "pending" &&
    (ACTIVE_BATCH_STATUSES as readonly string[]).includes(batchStatus)
  );
}
