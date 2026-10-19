// TD Bank internal-transfer matching engine — server-side, no auth (cron calls
// it). Detects both legs of a real internal transfer, links them via
// Transaction.transferPairId (reusing the same mechanism the manual "Add
// Transfer" flow already sets), and ties the pair to a matching
// ScheduledTransfer via Transaction.scheduledTransferId when one exists.
//
// One-sided own transfers: a valid leg (label names exactly one OTHER active household TD account, direction agrees with
// the sign) whose other side is not in the records gets the marker Transaction.ownTransferAccountId (the other account's
// id) and the Transfer Out / Transfer In tag (skipDuplicates; a tag is never removed). This file is the ONLY writer of
// that column (a guard test pins it). The marking is gated by the AppSetting ONE_SIDED_SETTING_KEY, which only the
// owner's "Detect Transfers Now" click turns on; a failed read of it counts as off. No logging here (counts are returned).

import { db } from "@/lib/db";
import { matchTransferLegs, type TransferLegCandidate } from "@/lib/transfer-match";
import { buildTdMaskMap } from "@/lib/td-account-masks";

/** AppSetting key that turns the one-sided marking on (value "1"). Set only by runTransferMatchingNow. */
export const ONE_SIDED_SETTING_KEY = "transfer_one_sided_enabled";

export interface OneSidedSummary {
  /** false = the gate was off (or unreadable): nothing was marked or tagged by the one-sided pass. */
  ran: boolean;
  /** NEW markers written this run. */
  marked: number;
  /** Transfer tags added to newly marked rows (0 when the row already had it). */
  tagsAdded: number;
  /** One-sided legs that already carried the marker (no write). */
  alreadyMarked: number;
  /** Newly marked rows that already carried some other tag (the transfer tag is added beside it). */
  alreadyHadOtherTag: number;
  /** Newly marked rows whose Transfer Out / Transfer In tag does not exist (marked, no tag created). */
  tagMissing: number;
}

export interface TransferMatchSummary {
  matchedPairs: number;
  tiedToSchedule: number;
  leftUnmatched: number;
  unmatchedByReason: { unresolvable_mask: number; sign_mismatch: number; no_counterpart: number };
  retroactivelyLinked: number;
  oneSided: OneSidedSummary;
}

export interface TransferMatchOptions {
  /** "run" = mark one-sided legs now; "if_enabled" (default) = only when the owner has switched it on. */
  oneSided?: "run" | "if_enabled";
}

function emptyOneSided(ran: boolean): OneSidedSummary {
  return { ran, marked: 0, tagsAdded: 0, alreadyMarked: 0, alreadyHadOtherTag: 0, tagMissing: 0 };
}

async function oneSidedEnabled(mode: "run" | "if_enabled"): Promise<boolean> {
  if (mode === "run") return true;
  try {
    const row = await db.appSetting.findUnique({ where: { key: ONE_SIDED_SETTING_KEY } });
    return row?.value === "1";
  } catch {
    return false; // fail closed: pairing still runs, nothing is marked
  }
}

function scheduleKey(fromAccountId: string, toAccountId: string): string {
  return `${fromAccountId}|${toAccountId}`;
}

export async function runTransferMatchingEngine(
  detectedBy: "cron" | "manual",
  opts: TransferMatchOptions = {}
): Promise<TransferMatchSummary> {
  // TD Bank accounts only — matching is explicitly scoped to "transfers
  // within TD Bank" per the request, not other institutions.
  const tdAccounts = await db.account.findMany({
    where: { institution: { name: "TD Bank" }, archivedAt: null },
    select: { id: true, mask: true },
  });

  // Shared resolution with the dashboard: an ambiguous mask fails closed, the owner-stated former mask resolves.
  const maskToAccountId = buildTdMaskMap(tdAccounts);
  const validAccountIds = tdAccounts.map((a) => a.id);

  if (validAccountIds.length === 0) {
    return {
      matchedPairs: 0,
      tiedToSchedule: 0,
      leftUnmatched: 0,
      unmatchedByReason: { unresolvable_mask: 0, sign_mismatch: 0, no_counterpart: 0 },
      retroactivelyLinked: 0,
      oneSided: emptyOneSided(false),
    };
  }

  // transferPairId: null makes this idempotent — already-linked rows never
  // re-enter the candidate pool on a re-run. Rows already marked one-sided stay
  // candidates, so a counterpart that arrives later still pairs. The payee
  // filter is a coarse prefilter (historical rows have a double space and a
  // description); the pure parse in lib/transfer-match.ts is the real gate.
  const candidateRows = await db.transaction.findMany({
    where: {
      archivedAt: null,
      transferPairId: null,
      pending: false,
      AND: [{ payeeRaw: { startsWith: "Online" } }, { payeeRaw: { contains: "Transfer" } }],
      accountId: { in: validAccountIds },
    },
    select: {
      id: true,
      accountId: true,
      postedAt: true,
      amount: true,
      payeeRaw: true,
      ownTransferAccountId: true,
      tags: { select: { tagId: true } },
    },
  });
  const rowById = new Map(candidateRows.map((r) => [r.id, r]));

  const candidates: TransferLegCandidate[] = candidateRows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    postedAt: r.postedAt,
    amount: r.amount.toString(),
    payeeRaw: r.payeeRaw ?? "",
  }));

  const { pairs, unmatched, oneSided } = matchTransferLegs(candidates, maskToAccountId);

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
          ownTransferAccountId: null, // a pair supersedes a one-sided marker
          ...(scheduledTransferId ? { scheduledTransferId } : {}),
        },
      }),
      db.transaction.update({
        where: { id: pair.incomingTxId },
        data: {
          transferPairId: newPairId,
          ownTransferAccountId: null,
          ...(scheduledTransferId ? { scheduledTransferId } : {}),
        },
      }),
      ...(tagAssignments.length > 0
        ? [db.transactionTag.createMany({ data: tagAssignments, skipDuplicates: true })]
        : []),
    ]);
  }

  // One-sided pass (gated). Never a delete and never a tag removal; the
  // transaction facts are never changed (the marker is metadata).
  const oneSidedSummary = emptyOneSided(await oneSidedEnabled(opts.oneSided ?? "if_enabled"));
  if (oneSidedSummary.ran) {
    for (const leg of oneSided) {
      const row = rowById.get(leg.txId);
      if (!row) continue;
      if (row.ownTransferAccountId !== null) {
        oneSidedSummary.alreadyMarked++;
        continue;
      }
      const tag = leg.direction === "to" ? outTag : inTag;
      const hadOtherTag = row.tags.some((t) => t.tagId !== tag?.id);
      const result = await db.$transaction(async (tx) => {
        const upd = await tx.transaction.updateMany({
          where: { id: leg.txId, transferPairId: null, ownTransferAccountId: null, archivedAt: null },
          data: { ownTransferAccountId: leg.counterpartAccountId },
        });
        if (upd.count === 0) return { marked: 0, tagsAdded: 0 };
        const tagged = tag
          ? await tx.transactionTag.createMany({
              data: [{ transactionId: leg.txId, tagId: tag.id }],
              skipDuplicates: true,
            })
          : { count: 0 };
        return { marked: upd.count, tagsAdded: tagged.count };
      });
      if (result.marked === 0) continue; // changed meanwhile (paired or marked by a concurrent run)
      oneSidedSummary.marked += result.marked;
      oneSidedSummary.tagsAdded += result.tagsAdded;
      if (!tag) oneSidedSummary.tagMissing++;
      if (hadOtherTag) oneSidedSummary.alreadyHadOtherTag++;
    }
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
    sign_mismatch: unmatched.filter((u) => u.reason === "sign_mismatch").length,
    no_counterpart: unmatched.filter((u) => u.reason === "no_counterpart").length,
  };

  return {
    matchedPairs: pairs.length,
    tiedToSchedule,
    leftUnmatched: unmatched.length,
    unmatchedByReason,
    retroactivelyLinked,
    oneSided: oneSidedSummary,
  };
}
