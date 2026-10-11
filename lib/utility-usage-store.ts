// The WRITE side of the uploaded utility usage rows (table UtilityUsage). No auth here: the caller (actions/utility-usage.ts)
// owns it and has already validated the entity and the rows. INSERT-ONLY plus archive: a row is never updated except to set
// archivedAt / archivedById and clear liveKey, and is never deleted (there is no delete, deleteMany or upsert in this file;
// a guard test pins it). `liveKey` is unique while a row is live and NULL once archived, so two racing tabs cannot both insert
// the same month: the loser gets a friendly "changed in another tab" answer and nothing is written.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isoToDate, type EnergyKind } from "@/lib/seasonal-energy";
import { liveKeyOf, rowKeyOf, type LiveUsage, type ParsedRow } from "@/lib/utility-usage-parse";
import { MAX_USAGE_ROWS } from "@/lib/utility-usage-build";

export const CHANGED_IN_ANOTHER_TAB = "The saved history changed in another tab or window. Preview again, then save.";

/** The live (not archived) rows of one entity and kind, as the classification needs them. */
export async function findLiveRows(entityId: string, kind: EnergyKind): Promise<LiveUsage[]> {
  const rows = await db.utilityUsage.findMany({
    where: { entityId, kind, archivedAt: null },
    orderBy: [{ period: "asc" }, { occurredOn: "asc" }],
    take: MAX_USAGE_ROWS,
    select: { id: true, period: true, occurredOn: true, quantity: true, costCents: true },
  });
  return rows.map((r) => {
    const occurredOn = r.occurredOn.toISOString().slice(0, 10);
    const quantity = new Prisma.Decimal(r.quantity.toString()).toFixed(3);
    return { id: r.id, key: rowKeyOf(kind, r.period, occurredOn, quantity), occurredOn, quantity, costCents: r.costCents };
  });
}

export interface InsertInput {
  entityId: string;
  kind: EnergyKind;
  userId: string;
  batchId: string;
  source: "manual" | "upload";
  rows: readonly ParsedRow[];
  /** Live row ids to archive in the same transaction (a ticked conflict or a cost fill). */
  archiveIds: readonly string[];
}

export type InsertResult = { ok: true; inserted: number; archived: number } | { ok: false; error: string };

/** Archives the replaced rows, then inserts the new ones, in ONE transaction. A unique-key race rolls everything back. */
export async function insertRows(input: InsertInput): Promise<InsertResult> {
  const { entityId, kind, rows } = input;
  if (rows.length === 0 && input.archiveIds.length === 0) return { ok: true, inserted: 0, archived: 0 };
  try {
    return await db.$transaction(
      async (tx) => {
        let archived = 0;
        if (input.archiveIds.length > 0) {
          const res = await tx.utilityUsage.updateMany({
            where: { id: { in: [...input.archiveIds] }, entityId, kind, archivedAt: null },
            data: { archivedAt: new Date(), archivedById: input.userId, liveKey: null },
          });
          if (res.count !== input.archiveIds.length) throw new RaceError();
          archived = res.count;
        }
        const data = rows.flatMap((r) =>
          r.key === null || r.period === null || r.occurredOn === null || r.quantity === null || r.unit === null
            ? []
            : [
                {
                  entityId,
                  kind,
                  period: r.period,
                  occurredOn: isoToDate(r.occurredOn),
                  quantity: r.quantity,
                  unit: r.unit,
                  costCents: r.costCents,
                  note: r.note,
                  source: input.source,
                  importBatchId: input.batchId,
                  liveKey: liveKeyOf(entityId, r.key),
                  createdById: input.userId,
                },
              ]
        );
        const created = data.length > 0 ? await tx.utilityUsage.createMany({ data }) : { count: 0 };
        return { ok: true as const, inserted: created.count, archived };
      },
      { timeout: 20_000, maxWait: 10_000 }
    );
  } catch (err) {
    if (err instanceof RaceError || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      return { ok: false, error: CHANGED_IN_ANOTHER_TAB };
    }
    throw err;
  }
}

class RaceError extends Error {
  constructor() {
    super("UtilityUsageRace");
    this.name = "RaceError";
  }
}

/** Archives one live row of the given entity (archivedAt set, liveKey cleared). false when it is not a live row of that entity. */
export async function archiveRow(input: { entityId: string; id: string; userId: string }): Promise<{ ok: true; kind: string } | { ok: false }> {
  const found = await db.utilityUsage.findFirst({ where: { id: input.id, entityId: input.entityId, archivedAt: null }, select: { id: true, kind: true } });
  if (!found) return { ok: false };
  const res = await db.utilityUsage.updateMany({
    where: { id: input.id, entityId: input.entityId, archivedAt: null },
    data: { archivedAt: new Date(), archivedById: input.userId, liveKey: null },
  });
  return res.count === 1 ? { ok: true, kind: found.kind } : { ok: false };
}
