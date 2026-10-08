// Net worth snapshot reads. DB-aware, explicit select only; the `data` JSON blob (per-account detail) is never selected.

import { db } from "@/lib/db";

export interface SnapshotRow {
  date: Date;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  netWorthCents: number;
}

export async function loadSnapshots(since: Date, take: number): Promise<SnapshotRow[]> {
  return db.netWorthSnapshot.findMany({
    where: { date: { gte: since } },
    orderBy: { date: "desc" },
    take,
    select: { date: true, totalAssetsCents: true, totalLiabilitiesCents: true, netWorthCents: true },
  });
}
