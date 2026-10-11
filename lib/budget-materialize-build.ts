// DB-aware helpers for the Budget WRITE path (copy-on-first-edit). Everything here runs on the `tx` handed in by the
// caller's interactive `db.$transaction(async (tx) => ...)`, never on `db`, so the lock, the saved carried rows, the
// edit and the audit row commit or roll back together. No auth here: the caller (actions/budgets.ts) has already run
// `requireAuth()`.
//
// Concurrency and idempotency:
//   - `lockBudgetWrites` takes ONE global transaction-scoped advisory lock first. It is released on commit/rollback, so
//     it works behind the Supabase transaction pooler (the same pattern as lockAssignPair in lib/review-queue-server.ts).
//     Two tabs, a double click, a delete racing a materialization and the cross-entity tag check all serialize on it;
//   - the carried rows are saved with createMany({ skipDuplicates: true }) = INSERT .. ON CONFLICT DO NOTHING on the
//     unique (tagId, entityId, period) index: an existing row is never overwritten and a second call creates nothing;
//   - the audit row (ids and counts only, never a dollar amount) is written only when rows were really created.

import type { Prisma } from "@prisma/client";
import {
  effectiveLineAt,
  planEndLine,
  planMaterialization,
  tagHoldersAt,
  type BudgetCreateRow,
  type BudgetLocator,
  type MaterializableRow,
} from "@/lib/budget-materialize";

export const BUDGET_WRITE_LOCK_KEY = "budget-write";
/** Interactive-transaction limits over the pooled connection (a far-ahead month can create a few hundred rows). */
export const BUDGET_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;
const MAX_ROWS = 5000;

/** Every column the planner copies, plus the id/amounts the actions read. Explicit select: no notes, no account data. */
const WRITE_SELECT = {
  id: true,
  entityId: true,
  tagId: true,
  accountId: true,
  period: true,
  budgeted: true,
  additionalAmountCents: true,
  payDay: true,
  frequency: true,
  payDayOfWeek: true,
  biweeklyAnchorDate: true,
  payMonth: true,
  annualAmountDue: true,
  rolloverEnabled: true,
  rolloverAmount: true,
} satisfies Prisma.BudgetSelect;

export type BudgetWriteRow = Prisma.BudgetGetPayload<{ select: typeof WRITE_SELECT }> & MaterializableRow;

/** Thrown inside the transaction to roll everything back and answer the caller with a plain message. */
export class BudgetRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetRefusal";
  }
}

export const STALE_LINE_MESSAGE = "That line is no longer on this month's budget. Refresh the page.";
export const TOO_FAR_AHEAD_MESSAGE = "That month is too far ahead to edit yet.";

/** Must be the FIRST statement inside the transaction. */
export async function lockBudgetWrites(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BUDGET_WRITE_LOCK_KEY}))`;
}

/**
 * All Budget rows (about 700 today): the frontier of each entity and the household-wide tag check need every row.
 * Fails closed when the cap is hit, because a truncated read would misjudge a frontier.
 */
export async function readBudgetRowsForWrite(tx: Prisma.TransactionClient): Promise<BudgetWriteRow[]> {
  const rows = await tx.budget.findMany({ orderBy: [{ period: "desc" }], take: MAX_ROWS + 1, select: WRITE_SELECT });
  if (rows.length > MAX_ROWS) throw new Error("Too many budget rows to plan a safe write");
  return rows;
}

export interface SavedRows {
  created: number;
  skipped: number;
}

/**
 * Saves planned rows. Never overwrites (skipDuplicates). One AuditLog row, only when something was created:
 * `{ entityId, periods, created, skipped }`.
 */
export async function saveCreates(
  tx: Prisma.TransactionClient,
  userId: string,
  entityId: string,
  plan: { creates: readonly BudgetCreateRow[]; months: readonly string[] }
): Promise<SavedRows> {
  if (plan.creates.length === 0) return { created: 0, skipped: 0 };
  const result = await tx.budget.createMany({ data: [...plan.creates], skipDuplicates: true });
  const created = result.count;
  const skipped = plan.creates.length - created;
  if (created > 0) {
    await tx.auditLog.create({
      data: {
        changedBy: userId,
        changeType: "budget_materialize",
        after: { entityId, periods: [...plan.months], created, skipped },
      },
    });
  }
  return { created, skipped };
}

/**
 * "Also add to later saved months": creates the added line in the later months the planner chose. Create-only
 * (skipDuplicates, an existing row is never touched). One AuditLog row, only when something was created:
 * `{ entityId, tagId, fromPeriod, periods, created, skipped }` (ids, periods and counts only).
 */
export async function saveLaterAdds(
  tx: Prisma.TransactionClient,
  userId: string,
  loc: BudgetLocator,
  rows: readonly BudgetCreateRow[]
): Promise<SavedRows> {
  if (rows.length === 0) return { created: 0, skipped: 0 };
  const result = await tx.budget.createMany({ data: [...rows], skipDuplicates: true });
  const created = result.count;
  const skipped = rows.length - created;
  if (created > 0) {
    await tx.auditLog.create({
      data: {
        changedBy: userId,
        changeType: "budget_add_later_months",
        after: {
          entityId: loc.entityId,
          tagId: loc.tagId,
          fromPeriod: loc.period,
          periods: rows.map((r) => r.period),
          created,
          skipped,
        },
      },
    });
  }
  return { created, skipped };
}

/**
 * Copy-on-first-edit: the carried lines of the target month (and of every empty month up to it) become real rows.
 * Returns what was created. The edit itself is the caller's, in the same transaction.
 */
export async function materializeForEdit(
  tx: Prisma.TransactionClient,
  userId: string,
  rows: readonly BudgetWriteRow[],
  entityId: string,
  period: string
): Promise<SavedRows> {
  const plan = planMaterialization(rows, entityId, period);
  return saveCreates(tx, userId, entityId, plan);
}

/** True when the line is on the month's effective budget (a real row or a carried one). */
export function lineIsInView(rows: readonly BudgetWriteRow[], loc: BudgetLocator): boolean {
  return effectiveLineAt(rows, loc) !== null;
}

/** Entity ids whose effective budget holds the tag in the month (own or carried), for the household-wide tag rule. */
export function entitiesHoldingTag(rows: readonly BudgetWriteRow[], tagId: string, period: string): string[] {
  return tagHoldersAt(rows, tagId, period);
}

export type EndLineResult =
  | { ok: true; created: number; deletedRows: number; removedMonths: number }
  | { ok: false; reason: "not_in_view" }
  | { ok: false; reason: "only_line_left"; frontier: string };

/**
 * Ends a line from `loc.period` onward: saves the carried set without the line, deletes the line's own rows from that
 * month on, and writes one audit row `{ entityId, tagId, fromPeriod, deletedRows }` (ids and counts only).
 */
export async function endLine(
  tx: Prisma.TransactionClient,
  userId: string,
  rows: readonly BudgetWriteRow[],
  loc: BudgetLocator
): Promise<EndLineResult> {
  const plan = planEndLine(rows, loc);
  if (!plan.ok) return plan;

  const saved = await saveCreates(tx, userId, loc.entityId, plan);
  const deleted = await tx.budget.deleteMany({
    where: { entityId: loc.entityId, tagId: loc.tagId, period: { gte: loc.period } },
  });
  await tx.auditLog.create({
    data: {
      changedBy: userId,
      changeType: "budget_end_line",
      after: { entityId: loc.entityId, tagId: loc.tagId, fromPeriod: loc.period, deletedRows: deleted.count },
    },
  });
  return {
    ok: true,
    created: saved.created,
    deletedRows: deleted.count,
    removedMonths: deleted.count + (plan.hadOwnRowAtTarget ? 0 : 1),
  };
}
