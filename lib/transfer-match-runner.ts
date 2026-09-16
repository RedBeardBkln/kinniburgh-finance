// TD Bank internal-transfer matching engine — server-side, no auth (cron calls
// it). Detects both legs of a real internal transfer, links them via
// Transaction.transferPairId (reusing the same mechanism the manual "Add
// Transfer" flow already sets), and ties the pair to a matching
// ScheduledTransfer via Transaction.scheduledTransferId when one exists.

import { db } from "@/lib/db";
import { matchTransferLegs, type TransferLegCandidate } from "@/lib/transfer-match";

export interface TransferMatchSummary {
  matchedPairs: number;
  tiedToSchedule: number;
  leftUnmatched: number;
  unmatchedByReason: { unresolvable_mask: number; no_counterpart: number };
  retroactivelyLinked: number;
}

function scheduleKey(fromAccountId: string, toAccountId: string): string {
  return `${fromAccountId}|${toAccountId}`;
}

export async function runTransferMatchingEngine(
  detectedBy: "cron" | "manual"
): Promise<TransferMatchSummary> {
  // TD Bank accounts only — matching is explicitly scoped to "transfers
  // within TD Bank" per the request, not other institutions.
  const tdAccounts = await db.account.findMany({
    where: { institution: { name: "TD Bank" }, archivedAt: null },
    select: { id: true, mask: true },
  });

  const maskToAccountId = new Map<string, string>();
  for (const acct of tdAccounts) {
    if (acct.mask) maskToAccountId.set(acct.mask, acct.id);
  }
  const validAccountIds = tdAccounts.map((a) => a.id);

  if (validAccountIds.length === 0) {
    return {
      matchedPairs: 0,
      tiedToSchedule: 0,
      leftUnmatched: 0,
      unmatchedByReason: { unresolvable_mask: 0, no_counterpart: 0 },
      retroactivelyLinked: 0,
    };
  }

  // transferPairId: null makes this idempotent — already-linked rows never
  // re-enter the candidate pool on a re-run.
  const candidateRows = await db.transaction.findMany({
    where: {
      archivedAt: null,
      transferPairId: null,
      pending: false,
      description: null,
      payeeRaw: { startsWith: "Online Xfer Transfer " },
      accountId: { in: validAccountIds },
    },
    select: { id: true, accountId: true, postedAt: true, amount: true, payeeRaw: true },
  });

  const candidates: TransferLegCandidate[] = candidateRows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    postedAt: r.postedAt,
    amount: r.amount.toString(),
    payeeRaw: r.payeeRaw ?? "",
  }));

  const { pairs, unmatched } = matchTransferLegs(candidates, maskToAccountId);

  // Every schedule, keyed by (fromAccountId, toAccountId). If more than one
  // schedule shares an account pair, the most-recently-created row wins
  // (defensive tie-break — no such duplicate exists in real data today).
  const schedules = await db.scheduledTransfer.findMany({
    select: { id: true, fromAccountId: true, toAccountId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const scheduleByAccountPair = new Map<string, string>();
  for (const s of schedules) {
    scheduleByAccountPair.set(scheduleKey(s.fromAccountId, s.toAccountId), s.id);
  }

  const [outTag, inTag] = await Promise.all([
    db.tag.findFirst({ where: { name: "Transfer Out" } }),
    db.tag.findFirst({ where: { name: "Transfer In" } }),
  ]);

  let tiedToSchedule = 0;

  for (const pair of pairs) {
    const newPairId = crypto.randomUUID();
    const scheduledTransferId = scheduleByAccountPair.get(
      scheduleKey(pair.fromAccountId, pair.toAccountId)
    );
    if (scheduledTransferId) tiedToSchedule++;

    const tagAssignments: { transactionId: string; tagId: string }[] = [];
    if (outTag) tagAssignments.push({ transactionId: pair.outgoingTxId, tagId: outTag.id });
    if (inTag) tagAssignments.push({ transactionId: pair.incomingTxId, tagId: inTag.id });

    await db.$transaction([
      db.transaction.update({
        where: { id: pair.outgoingTxId },
        data: {
          transferPairId: newPairId,
          ...(scheduledTransferId ? { scheduledTransferId } : {}),
        },
      }),
      db.transaction.update({
        where: { id: pair.incomingTxId },
        data: {
          transferPairId: newPairId,
          ...(scheduledTransferId ? { scheduledTransferId } : {}),
        },
      }),
      ...(tagAssignments.length > 0
        ? [db.transactionTag.createMany({ data: tagAssignments, skipDuplicates: true })]
        : []),
    ]);
  }

  // Retroactive linking pass: covers pairs just created above *and* any
  // pre-existing pairs (manual "Add Transfer" pairs included) whose account
  // pair now matches a ScheduledTransfer that didn't exist or wasn't matched
  // before. Deliberate small scope extension — see plan Risks.
  const unlinkedPairLegs = await db.transaction.findMany({
    where: { transferPairId: { not: null }, scheduledTransferId: null, archivedAt: null },
    select: { id: true, accountId: true, amount: true, transferPairId: true },
  });

  const legsByPairId = new Map<string, typeof unlinkedPairLegs>();
  for (const leg of unlinkedPairLegs) {
    const key = leg.transferPairId!;
    if (!legsByPairId.has(key)) legsByPairId.set(key, []);
    legsByPairId.get(key)!.push(leg);
  }

  let retroactivelyLinked = 0;
  for (const [, legs] of legsByPairId) {
    if (legs.length !== 2) continue; // only well-formed 2-leg pairs
    const outgoing = legs.find((l) => Number(l.amount) < 0);
    const incoming = legs.find((l) => Number(l.amount) >= 0);
    if (!outgoing || !incoming) continue;

    const scheduledTransferId = scheduleByAccountPair.get(
      scheduleKey(outgoing.accountId, incoming.accountId)
    );
    if (!scheduledTransferId) continue;

    await db.transaction.updateMany({
      where: { id: { in: [outgoing.id, incoming.id] } },
      data: { scheduledTransferId },
    });
    retroactivelyLinked++;
  }

  const unmatchedByReason = {
    unresolvable_mask: unmatched.filter((u) => u.reason === "unresolvable_mask").length,
    no_counterpart: unmatched.filter((u) => u.reason === "no_counterpart").length,
  };

  return {
    matchedPairs: pairs.length,
    tiedToSchedule,
    leftUnmatched: unmatched.length,
    unmatchedByReason,
    retroactivelyLinked,
  };
}
