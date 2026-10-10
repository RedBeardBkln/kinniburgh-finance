// Aggregated spend for the assistant: the ONLY advisor file that uses raw SQL, and only as tagged templates (values are bound
// parameters, never concatenated). It reads Transaction / TransactionTag / Tag / Entity / Account columns that carry amounts, dates, names
// and nicknames; nothing else. Archived rows and internal transfers (transferPairId) are always excluded.
// NOTE: this is the older per-tag signed sum. It is NOT the dashboard's Spent (lib/month-spend.ts), which also leaves out card payments,
// loan-account entries and income, nets refunds and rolls nested sub-tags into the nearest budget line; the two can differ.
// Moving the advisor, the monthly review and the budget CSV export onto lib/month-spend is a named follow-up.

import { db } from "@/lib/db";

export type SpendGroupBy = "tag" | "month" | "entity" | "account" | "payee";
export type SpendDirection = "outflow" | "inflow" | "any";

export interface SpendGroupRow {
  label: string | null;
  outflow: string;
  inflow: string;
  txCount: number;
}

export interface SpendTotals {
  outflow: string;
  inflow: string;
  txCount: number;
}

export interface SpendQuery {
  groupBy: SpendGroupBy;
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
  entity: string | null;
  direction: SpendDirection;
  limit: number;
}

export async function loadSpendTotals(q: Pick<SpendQuery, "from" | "to" | "entity" | "direction">): Promise<SpendTotals> {
  const rows = await db.$queryRaw<SpendTotals[]>`
    SELECT COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount END), 0)::text AS outflow,
           COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0)::text AS inflow,
           COUNT(*)::int AS "txCount"
    FROM "Transaction" t
    JOIN "Entity" e ON e.id = t."entityId"
    WHERE t."archivedAt" IS NULL AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${q.from} AND t."postedAt" < ${q.to}
      AND (${q.entity}::text IS NULL OR LOWER(e."name") = LOWER(${q.entity}::text) OR LOWER(COALESCE(e."slug", '')) = LOWER(${q.entity}::text))
      AND (${q.direction}::text <> 'outflow' OR t.amount < 0)
      AND (${q.direction}::text <> 'inflow' OR t.amount > 0)
  `;
  return rows[0] ?? { outflow: "0", inflow: "0", txCount: 0 };
}

export async function loadSpendGroups(q: SpendQuery): Promise<SpendGroupRow[]> {
  switch (q.groupBy) {
    case "tag":
      return db.$queryRaw<SpendGroupRow[]>`
        SELECT tg."name" AS label,
               COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount END), 0)::text AS outflow,
               COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0)::text AS inflow,
               COUNT(*)::int AS "txCount"
        FROM "Transaction" t
        JOIN "Entity" e ON e.id = t."entityId"
        JOIN "TransactionTag" tt ON tt."transactionId" = t.id
        JOIN "Tag" tg ON tg.id = tt."tagId"
        WHERE t."archivedAt" IS NULL AND t."transferPairId" IS NULL
          AND t."postedAt" >= ${q.from} AND t."postedAt" < ${q.to}
          AND (${q.entity}::text IS NULL OR LOWER(e."name") = LOWER(${q.entity}::text) OR LOWER(COALESCE(e."slug", '')) = LOWER(${q.entity}::text))
          AND (${q.direction}::text <> 'outflow' OR t.amount < 0)
          AND (${q.direction}::text <> 'inflow' OR t.amount > 0)
        GROUP BY tg."name"
        ORDER BY CASE WHEN ${q.direction}::text = 'inflow' THEN SUM(CASE WHEN t.amount > 0 THEN t.amount END) ELSE SUM(CASE WHEN t.amount < 0 THEN -t.amount END) END DESC NULLS LAST, tg."name" ASC
        LIMIT ${q.limit}
      `;
    case "month":
      return db.$queryRaw<SpendGroupRow[]>`
        SELECT to_char(t."postedAt", 'YYYY-MM') AS label,
               COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount END), 0)::text AS outflow,
               COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0)::text AS inflow,
               COUNT(*)::int AS "txCount"
        FROM "Transaction" t
        JOIN "Entity" e ON e.id = t."entityId"
        WHERE t."archivedAt" IS NULL AND t."transferPairId" IS NULL
          AND t."postedAt" >= ${q.from} AND t."postedAt" < ${q.to}
          AND (${q.entity}::text IS NULL OR LOWER(e."name") = LOWER(${q.entity}::text) OR LOWER(COALESCE(e."slug", '')) = LOWER(${q.entity}::text))
          AND (${q.direction}::text <> 'outflow' OR t.amount < 0)
          AND (${q.direction}::text <> 'inflow' OR t.amount > 0)
        GROUP BY label
        ORDER BY label ASC
        LIMIT ${q.limit}
      `;
    case "entity":
      return db.$queryRaw<SpendGroupRow[]>`
        SELECT e."name" AS label,
               COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount END), 0)::text AS outflow,
               COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0)::text AS inflow,
               COUNT(*)::int AS "txCount"
        FROM "Transaction" t
        JOIN "Entity" e ON e.id = t."entityId"
        WHERE t."archivedAt" IS NULL AND t."transferPairId" IS NULL
          AND t."postedAt" >= ${q.from} AND t."postedAt" < ${q.to}
          AND (${q.entity}::text IS NULL OR LOWER(e."name") = LOWER(${q.entity}::text) OR LOWER(COALESCE(e."slug", '')) = LOWER(${q.entity}::text))
          AND (${q.direction}::text <> 'outflow' OR t.amount < 0)
          AND (${q.direction}::text <> 'inflow' OR t.amount > 0)
        GROUP BY e."name"
        ORDER BY CASE WHEN ${q.direction}::text = 'inflow' THEN SUM(CASE WHEN t.amount > 0 THEN t.amount END) ELSE SUM(CASE WHEN t.amount < 0 THEN -t.amount END) END DESC NULLS LAST, e."name" ASC
        LIMIT ${q.limit}
      `;
    case "account":
      return db.$queryRaw<SpendGroupRow[]>`
        SELECT a."nickname" AS label,
               COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount END), 0)::text AS outflow,
               COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0)::text AS inflow,
               COUNT(*)::int AS "txCount"
        FROM "Transaction" t
        JOIN "Entity" e ON e.id = t."entityId"
        JOIN "Account" a ON a.id = t."accountId"
        WHERE t."archivedAt" IS NULL AND t."transferPairId" IS NULL
          AND t."postedAt" >= ${q.from} AND t."postedAt" < ${q.to}
          AND (${q.entity}::text IS NULL OR LOWER(e."name") = LOWER(${q.entity}::text) OR LOWER(COALESCE(e."slug", '')) = LOWER(${q.entity}::text))
          AND (${q.direction}::text <> 'outflow' OR t.amount < 0)
          AND (${q.direction}::text <> 'inflow' OR t.amount > 0)
        GROUP BY a."nickname"
        ORDER BY CASE WHEN ${q.direction}::text = 'inflow' THEN SUM(CASE WHEN t.amount > 0 THEN t.amount END) ELSE SUM(CASE WHEN t.amount < 0 THEN -t.amount END) END DESC NULLS LAST, a."nickname" ASC
        LIMIT ${q.limit}
      `;
    case "payee":
      return db.$queryRaw<SpendGroupRow[]>`
        SELECT COALESCE(NULLIF(t."payeeNormalized", ''), t."payeeRaw", '(no payee)') AS label,
               COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount END), 0)::text AS outflow,
               COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0)::text AS inflow,
               COUNT(*)::int AS "txCount"
        FROM "Transaction" t
        JOIN "Entity" e ON e.id = t."entityId"
        WHERE t."archivedAt" IS NULL AND t."transferPairId" IS NULL
          AND t."postedAt" >= ${q.from} AND t."postedAt" < ${q.to}
          AND (${q.entity}::text IS NULL OR LOWER(e."name") = LOWER(${q.entity}::text) OR LOWER(COALESCE(e."slug", '')) = LOWER(${q.entity}::text))
          AND (${q.direction}::text <> 'outflow' OR t.amount < 0)
          AND (${q.direction}::text <> 'inflow' OR t.amount > 0)
        GROUP BY label
        ORDER BY CASE WHEN ${q.direction}::text = 'inflow' THEN SUM(CASE WHEN t.amount > 0 THEN t.amount END) ELSE SUM(CASE WHEN t.amount < 0 THEN -t.amount END) END DESC NULLS LAST, label ASC
        LIMIT ${q.limit}
      `;
  }
}

export interface TagSpendRow {
  entityId: string;
  tagId: string;
  /** Signed total (negative = outflow), as stored. */
  total: string;
}

/** Spend per (entity, tag) in [start, end): the net signed amount on the exact tag (not the dashboard's Spent, see the header). */
export async function loadTagSpendForPeriod(start: Date, end: Date): Promise<TagSpendRow[]> {
  return db.$queryRaw<TagSpendRow[]>`
    SELECT t."entityId", tt."tagId", SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."archivedAt" IS NULL AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${start} AND t."postedAt" < ${end}
    GROUP BY t."entityId", tt."tagId"
  `;
}
