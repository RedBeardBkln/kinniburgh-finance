// DB-aware, READ-ONLY loader for the owner's uploaded utility usage rows (table UtilityUsage). No writes of any kind, no
// auth: the CALLER (the Forecast page after auth(), a server action after requireAuth()) owns access control. Explicit
// select, `archivedAt: null`, capped read. The ONLY reader of the table besides lib/utility-usage-store.ts (a guard test
// pins it).
//
// FAIL-SOFT: a missing table (the migration is not applied yet: Prisma P2021 / Postgres 42P01) is `not_set_up`; any other
// error is `failed` (err.name only is logged). Neither ever rejects, so the seasonal loader can keep every payments-based
// estimate and just show a notice.

import { db } from "@/lib/db";
import { Decimal } from "@prisma/client/runtime/library";
import type { EnergyKind } from "@/lib/seasonal-energy";
import type { UsageRow, UsageStatus } from "@/lib/seasonal-energy-usage";

/** Hard ceiling on rows read; reaching it counts as a failed (incomplete) read rather than a silent partial one. */
export const MAX_USAGE_ROWS = 2000;

export type LoadedUsageRow = UsageRow & { entityId: string };

export interface LoadedUtilityUsage {
  status: UsageStatus;
  rows: LoadedUsageRow[];
}

const KINDS: readonly string[] = ["electric", "oil", "firewood"];

/** True when the error says the UtilityUsage table (or the database object) does not exist yet. */
export function isMissingUsageTable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; meta?: { code?: unknown } };
  if (e.code === "P2021") return true;
  if (e.meta && e.meta.code === "42P01") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return /UtilityUsage/.test(msg) && /does not exist|42P01/.test(msg);
}

export async function loadUtilityUsage(entityIds: readonly string[]): Promise<LoadedUtilityUsage> {
  if (entityIds.length === 0) return { status: "ok", rows: [] };
  try {
    const found = await db.utilityUsage.findMany({
      where: { entityId: { in: [...entityIds] }, archivedAt: null },
      orderBy: [{ period: "asc" }, { occurredOn: "asc" }],
      take: MAX_USAGE_ROWS,
      select: { id: true, entityId: true, kind: true, period: true, occurredOn: true, quantity: true, unit: true, costCents: true, note: true },
    });
    if (found.length >= MAX_USAGE_ROWS) throw new Error("UtilityUsageTooLarge");
    const rows: LoadedUsageRow[] = found.flatMap((r) =>
      KINDS.includes(r.kind)
        ? [
            {
              id: r.id,
              entityId: r.entityId,
              kind: r.kind as EnergyKind,
              period: r.period,
              occurredOn: r.occurredOn.toISOString().slice(0, 10),
              quantity: new Decimal(r.quantity.toString()),
              unit: r.unit,
              cost: r.costCents === null ? null : new Decimal(r.costCents).div(100),
              note: r.note,
            },
          ]
        : []
    );
    return { status: "ok", rows };
  } catch (err) {
    if (isMissingUsageTable(err)) return { status: "not_set_up", rows: [] };
    console.error("Utility usage unavailable", err instanceof Error ? err.name : "UnknownError");
    return { status: "failed", rows: [] };
  }
}
