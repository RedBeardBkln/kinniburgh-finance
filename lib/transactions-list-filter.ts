// Pure rules for which transactions the /transactions list shows. No DB (Prisma types only).
//
// Own-account transfers are hidden from the list (All and Needs Review): a paired leg (transferPairId) and a one-sided
// leg (ownTransferAccountId, set only by lib/transfer-match-runner.ts when the other side is not in the records). The ONE
// exception is the per-account view (an account filter is set): its All tab lists that account's transfers too, marked.
// Needs Review always hides transfers: it is the "to tag" queue and transfer legs are not things to review.
import type { Prisma } from "@prisma/client";
import { parseOwnTransferLabel } from "@/lib/own-transfer-label";
import { decimalSign } from "@/lib/transfer-match";

export function transferVisibilityWhere(accountFilterSet: boolean): Prisma.TransactionWhereInput {
  return accountFilterSet ? {} : { transferPairId: null, ownTransferAccountId: null };
}

/** Needs Review: untagged, not a transfer leg (paired or one-sided), posted. */
export const NEEDS_REVIEW_WHERE: Prisma.TransactionWhereInput = {
  tags: { none: {} },
  transferPairId: null,
  ownTransferAccountId: null,
  pending: false,
};

/** Rows that will join Needs Review once they post (before the own-transfer label check in countPendingForReview). */
export const PENDING_NOTE_WHERE: Prisma.TransactionWhereInput = {
  tags: { none: {} },
  transferPairId: null,
  ownTransferAccountId: null,
  pending: true,
};

export type TransferKind = "paired" | "one_sided";

export function transferKindOf(row: {
  transferPairId: string | null;
  ownTransferAccountId: string | null;
}): TransferKind | null {
  if (row.transferPairId) return "paired";
  if (row.ownTransferAccountId) return "one_sided";
  return null;
}

/**
 * How many pending rows will really appear in Needs Review once they post. A pending row whose label validates to
 * ANOTHER household TD account (mask map incl. the owner-stated alias) with a direction that agrees with its sign is left
 * out: it will be paired or marked one-sided (and hidden) when it posts. Known limit: a row a tag rule will auto-tag
 * on posting is still counted.
 */
export function countPendingForReview(
  rows: readonly { id: string; accountId: string; payeeRaw: string | null; amount: string }[],
  maskMap: ReadonlyMap<string, string>
): number {
  let n = 0;
  for (const r of rows) {
    const parsed = r.payeeRaw ? parseOwnTransferLabel(r.payeeRaw) : null;
    const counterpart = parsed ? maskMap.get(parsed.mask) : undefined;
    const sign = decimalSign(r.amount);
    const agrees = parsed ? (parsed.direction === "to" ? sign === -1 : sign === 1) : false;
    if (counterpart && counterpart !== r.accountId && agrees) continue;
    n++;
  }
  return n;
}

export function pendingNoteText(n: number): string | null {
  if (n <= 0) return null;
  if (n === 1) return "1 pending transaction will appear here once it posts";
  return `${n} pending transactions will appear here once they post`;
}
