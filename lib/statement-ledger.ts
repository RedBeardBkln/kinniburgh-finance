import { db } from "@/lib/db";
import { buildLedgerIndex, type LedgerEntry } from "@/lib/statement-import";

/**
 * Ledger multiset per account for a date window — the read side of "is this
 * statement row already imported?". Every requested account gets an entry,
 * even when it has no transactions in the window. Archived transactions are
 * excluded (soft-delete guard), so an archived row counts as not imported.
 */
export async function loadLedgerIndexes(
  accountIds: string[],
  from: Date,
  to: Date
): Promise<Map<string, Map<string, number>>> {
  const byAccount = new Map<string, LedgerEntry[]>(accountIds.map((id) => [id, []]));
  if (accountIds.length === 0) return new Map();

  const txs = await db.transaction.findMany({
    where: { accountId: { in: accountIds }, archivedAt: null, postedAt: { gte: from, lte: to } },
    select: { accountId: true, postedAt: true, amount: true, payeeRaw: true, payeeNormalized: true },
  });
  for (const t of txs) byAccount.get(t.accountId)?.push(t);

  return new Map(Array.from(byAccount, ([id, entries]) => [id, buildLedgerIndex(entries)]));
}
