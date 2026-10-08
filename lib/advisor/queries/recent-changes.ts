// "What changed" reads for the assistant: METADATA ONLY. Every select below lists the few columns the timeline template uses (a key, a kind, a
// year, a first-name snapshot and a timestamp). It never selects a value, a free-text reason or note, a fingerprint, a hash, a verdict
// snapshot, a message or a before / after snapshot. Each area is read separately and fail-soft: a table that does not exist yet (or any read
// error) is `null` for that area, which the shaper reports as unavailable.
// Owner approvals are deliberately NOT read here: a repo-wide test (tax-review-tester-final) pins that only the approval facts reader touches
// that table. The AI review runs and the tax-year filed / reopened events below are the closest signals.

import { db } from "@/lib/db";

export interface TaxFactChange {
  factKey: string;
  changeKind: string;
  setByName: string;
  setAt: Date;
}

export interface OverrideChange {
  targetKind: string;
  targetKey: string;
  version: number;
  authority: string;
  setByName: string;
  setAt: Date;
}

export interface ReviewRunChange {
  taxYear: number;
  startedByName: string;
  startedAt: Date;
}

export interface DocumentAdded {
  docType: string;
  taxYear: number | null;
  createdAt: Date;
}

export interface AuditCount {
  changeType: string;
  count: number;
}

export interface TransactionsAdded {
  entity: string;
  count: number;
}

/** null = this area could not be read (table missing or read error). */
export interface RecentChangeRows {
  taxFacts: TaxFactChange[] | null;
  overrides: OverrideChange[] | null;
  reviewRuns: ReviewRunChange[] | null;
  documents: DocumentAdded[] | null;
  auditCounts: AuditCount[] | null;
  transactionsAdded: TransactionsAdded[] | null;
}

export const RECENT_PER_AREA = 40;

async function soft<T>(area: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    // Name only: never the error text, which can carry row data.
    console.error("advisor recent changes read failed:", area, e instanceof Error ? e.name : "unknown error");
    return null;
  }
}

export async function loadRecentChanges(since: Date): Promise<RecentChangeRows> {
  const [taxFacts, overrides, reviewRuns, documents, auditCounts, transactionsAdded] = await Promise.all([
    soft("tax_facts", () =>
      db.taxFact.findMany({
        where: { setAt: { gte: since } },
        orderBy: { setAt: "desc" },
        take: RECENT_PER_AREA,
        select: { factKey: true, changeKind: true, setByName: true, setAt: true },
      }),
    ),
    soft("overrides", () =>
      db.taxReturnOverride.findMany({
        where: { setAt: { gte: since } },
        orderBy: { setAt: "desc" },
        take: RECENT_PER_AREA,
        select: { targetKind: true, targetKey: true, version: true, authority: true, setByName: true, setAt: true },
      }),
    ),
    soft("review_runs", () =>
      db.taxReviewRun.findMany({
        where: { startedAt: { gte: since } },
        orderBy: { startedAt: "desc" },
        take: RECENT_PER_AREA,
        select: { taxYear: true, startedByName: true, startedAt: true },
      }),
    ),
    soft("documents", () =>
      db.document.findMany({
        where: { archivedAt: null, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: RECENT_PER_AREA,
        select: { docType: true, taxYear: true, createdAt: true },
      }),
    ),
    soft("audit", async () => {
      const groups = await db.auditLog.groupBy({ by: ["changeType"], where: { createdAt: { gte: since } }, _count: { _all: true } });
      return groups.map((g) => ({ changeType: g.changeType, count: g._count._all }));
    }),
    soft("transactions", async () => {
      const groups = await db.transaction.groupBy({ by: ["entityId"], where: { archivedAt: null, createdAt: { gte: since } }, _count: { _all: true } });
      if (groups.length === 0) return [];
      const entities = await db.entity.findMany({ where: { id: { in: groups.map((g) => g.entityId) } }, select: { id: true, name: true } });
      const names = new Map(entities.map((e) => [e.id, e.name]));
      return groups.map((g) => ({ entity: names.get(g.entityId) ?? "Unknown entity", count: g._count._all }));
    }),
  ]);
  return { taxFacts, overrides, reviewRuns, documents, auditCounts, transactionsAdded };
}
