// Entity profit-and-loss reads for the assistant. DB-aware, explicit select only. The totals come from the existing computePL
// (lib/reports.ts, the same function the business P&L page uses), so the assistant and the page cannot disagree; this file adds the entity
// lookup and the count of transactions that have no GL code yet.

import { db } from "@/lib/db";
import { computePL } from "@/lib/reports";

export interface PnlEntity {
  id: string;
  name: string;
  slug: string | null;
  type: string;
}

/** A decimal-like value (Prisma Decimal in production, a plain object in tests). */
type Dec = { toString(): string };

export interface PnlLineFacts {
  code: string;
  name: string;
  total: Dec;
}

export interface PnlExcludedLineFacts {
  code: string;
  name: string;
  type: string;
  transactionCount: number;
  total: Dec;
}

/** The part of computePL's report the shaper reads (structurally satisfied by PLReport). */
export interface PnlFacts {
  incomeLines: readonly PnlLineFacts[];
  expenseLines: readonly PnlLineFacts[];
  totalIncome: Dec;
  totalExpenses: Dec;
  netIncome: Dec;
  excludedFromPL: { lines: readonly PnlExcludedLineFacts[]; transactionCount: number; netAmount: Dec };
}

export async function findEntityByNameOrSlug(entity: string): Promise<PnlEntity | null> {
  return db.entity.findFirst({
    where: {
      archivedAt: null,
      OR: [{ name: { equals: entity, mode: "insensitive" as const } }, { slug: { equals: entity, mode: "insensitive" as const } }],
    },
    select: { id: true, name: true, slug: true, type: true },
  });
}

export async function loadPnl(entityId: string, from: Date, to: Date): Promise<{ pl: PnlFacts; uncodedCount: number }> {
  const [pl, uncodedCount] = await Promise.all([
    computePL(entityId, from, to),
    db.transaction.count({ where: { entityId, archivedAt: null, transferPairId: null, glCodeId: null, postedAt: { gte: from, lte: to } } }),
  ]);
  return { pl, uncodedCount };
}
