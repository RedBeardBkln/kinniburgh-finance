// Duplicate-transaction detection engine — server-side, no auth (cron calls it).
// Archives exact duplicates and writes a reversible log entry for each.

import { db } from "@/lib/db";
import { findDuplicateGroups, type DedupeTxRow } from "@/lib/dedupe";

/**
 * Finds and archives exact duplicates (same account, posted date, amount,
 * normalized payee; transfer legs excluded). Every archived duplicate is
 * logged to DedupAction so the removal can be undone from Settings.
 * Transactions restored via undo are protected from re-archival.
 */
export async function runDuplicateDetectionEngine(
  detectedBy: "cron" | "manual"
): Promise<{ archived: number; groups: number }> {
  // Active, non-transfer transactions
  const rows = await db.transaction.findMany({
    where: { archivedAt: null, transferPairId: null },
    select: {
      id: true,
      accountId: true,
      entityId: true,
      postedAt: true,
      amount: true,
      payeeNormalized: true,
      transferPairId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // Undo-restored transactions are intentional — never re-archive them
  const protectedIds = new Set(
    (
      await db.dedupAction.findMany({
        where: { undoneAt: { not: null } },
        select: { duplicateTxId: true, keptTxId: true },
      })
    ).flatMap((a) => [a.duplicateTxId, a.keptTxId])
  );

  const dedupeRows: DedupeTxRow[] = rows
    .filter((r) => !protectedIds.has(r.id))
    .map((r) => ({
      id: r.id,
      accountId: r.accountId,
      entityId: r.entityId,
      postedAt: r.postedAt,
      amount: r.amount.toString(),
      payeeNormalized: r.payeeNormalized,
      transferPairId: r.transferPairId,
    }));

  const groups = findDuplicateGroups(dedupeRows);

  let archived = 0;
  const now = new Date();

  for (const group of groups) {
    for (const dup of group.duplicates) {
      const dupEntityId = dup.entityId;
      const dupPostedAt =
        dup.postedAt instanceof Date ? dup.postedAt : new Date(dup.postedAt);

      // Archive + log atomically; if either fails the transaction stays intact
      await db.$transaction([
        db.transaction.update({
          where: { id: dup.id, archivedAt: null },
          data: { archivedAt: now },
        }),
        db.dedupAction.create({
          data: {
            duplicateTxId: dup.id,
            keptTxId: group.keep.id,
            accountId: dup.accountId,
            entityId: dupEntityId,
            postedAt: dupPostedAt,
            amount: dup.amount,
            payeeNormalized: dup.payeeNormalized,
            reason: "exact_match",
            detectedBy,
          },
        }),
      ]);
      archived++;
    }
  }

  return { archived, groups: groups.length };
}