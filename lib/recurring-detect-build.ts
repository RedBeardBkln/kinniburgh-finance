// DB-aware, READ-ONLY loader for the recurring-pattern detector. No writes, no auth: like
// lib/upcoming-ledger-build.ts the CALLER (a page or action that has already run auth()) owns access control.
// One transaction query with an explicit select, plus the dismissal setting. The pure detector is
// lib/recurring-detect.ts.

import { Decimal } from "@prisma/client/runtime/library";
import { db } from "@/lib/db";
import { getAllDismissedSuggestions, getDismissedSuggestions } from "@/lib/settings";
import {
  applyDismissals,
  detectRecurring,
  type DetectionBundle,
  type DetectResult,
  type DismissedEntry,
  type TxRow,
} from "@/lib/recurring-detect";
import type { ModelledRef } from "@/lib/upcoming-ledger";

/** How much history the detector reads. Primary Checking has about 17 months; annual needs 12+. */
export const DETECT_HISTORY_MONTHS = 18;

export interface LoadedDetection {
  /** Raw detector output (nothing dismissed yet). */
  result: DetectResult;
  /** The same, split by the owner's dismissals. */
  bundle: DetectionBundle;
}

/** Start of the history window: `today` minus 18 calendar months, UTC midnight. */
export function historyStart(today: Date): Date {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - DETECT_HISTORY_MONTHS, today.getUTCDate()));
}

export interface DetectionData {
  rows: TxRow[];
  dismissed: DismissedEntry[];
}

/**
 * Phase 1: the reads (history rows + the dismissal setting). They do not depend on the recorded items, so a
 * caller can start this alongside its own reads and run the pure detection later with `runDetection`.
 */
export async function fetchDetectionData(args: {
  /** null = every entity (series stay per entity / account). */
  entityId: string | null;
  /** UTC midnight of the America/New_York date. */
  today: Date;
}): Promise<DetectionData> {
  const { entityId, today } = args;
  const [txs, dismissed] = await Promise.all([
    db.transaction.findMany({
      where: {
        archivedAt: null,
        transferPairId: null,
        pending: false,
        postedAt: { gte: historyStart(today) },
        ...(entityId ? { entityId } : {}),
      },
      select: {
        entityId: true,
        accountId: true,
        payeeNormalized: true,
        amount: true,
        postedAt: true,
        // The nickname (never the number) only tells apart one payee seen on two accounts.
        account: { select: { accountType: true, nickname: true } },
        tags: { select: { tagId: true } },
      },
    }),
    entityId ? getDismissedSuggestions(entityId) : getAllDismissedSuggestions(),
  ]);

  const rows: TxRow[] = txs.map((t) => ({
    entityId: t.entityId,
    accountId: t.accountId,
    accountType: t.account.accountType,
    accountName: t.account.nickname ?? null,
    payee: t.payeeNormalized,
    amount: new Decimal(t.amount.toString()),
    postedAt: t.postedAt,
    tagIds: t.tags.map((x) => x.tagId),
  }));
  return { rows, dismissed };
}

/** Phase 2 (pure): detect against what the owner has already recorded, then split by dismissals. */
export function runDetection(data: DetectionData, modelled: ModelledRef[], today: Date): LoadedDetection {
  const result = detectRecurring({ rows: data.rows, modelled, today });
  return { result, bundle: applyDismissals(result, data.dismissed) };
}

export async function loadRecurringDetection(args: {
  entityId: string | null;
  today: Date;
  modelled: ModelledRef[];
}): Promise<LoadedDetection> {
  const data = await fetchDetectionData({ entityId: args.entityId, today: args.today });
  return runDetection(data, args.modelled, args.today);
}
