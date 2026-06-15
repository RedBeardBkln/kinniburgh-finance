"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { z } from "zod";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

function escapeCsv(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsvRow(values: unknown[]): string {
  return values.map(escapeCsv).join(",");
}

// ── Transaction CSV export ─────────────────────────────────────────────────────

export async function exportTransactionsCsv(filters: {
  entityId?: string;
  accountId?: string;
  startDate?: string;
  endDate?: string;
  tagId?: string;
}): Promise<string> {
  await requireAuth();

  const transactions = await db.transaction.findMany({
    where: {
      archivedAt: null,
      ...(filters.entityId && { entityId: filters.entityId }),
      ...(filters.accountId && { accountId: filters.accountId }),
      ...(filters.startDate && { postedAt: { gte: new Date(filters.startDate) } }),
      ...(filters.endDate && { postedAt: { lte: new Date(filters.endDate) } }),
      ...(filters.tagId && { tags: { some: { tagId: filters.tagId } } }),
    },
    include: {
      account: { select: { nickname: true } },
      entity: { select: { name: true } },
      tags: { include: { tag: { select: { shortName: true } } } },
    },
    orderBy: { postedAt: "desc" },
  });

  const header = toCsvRow(["Date", "Account", "Entity", "Payee", "Amount", "Tags", "Source"]);
  const rows = transactions.map((t) =>
    toCsvRow([
      t.postedAt.toISOString().slice(0, 10),
      t.account.nickname,
      t.entity.name,
      t.payeeRaw ?? t.payeeNormalized ?? "",
      t.amount.toFixed(2),
      t.tags.map((tt) => tt.tag.shortName).join("; "),
      t.source,
    ])
  );

  return [header, ...rows].join("\n");
}

// ── Budget vs. actual CSV export ──────────────────────────────────────────────

export async function exportBudgetCsv(period: string): Promise<string> {
  await requireAuth();
  z.string().regex(/^\d{4}-\d{2}$/).parse(period);

  const budgets = await db.budget.findMany({
    where: { period },
    include: { tag: true, entity: true },
    orderBy: [{ entity: { name: "asc" } }, { tag: { name: "asc" } }],
  });

  const [year, month] = period.split("-") as [string, string];
  const start = new Date(`${year}-${month}-01T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);

  const spendRows = await db.$queryRaw<Array<{ tagId: string; entityId: string; total: string }>>`
    SELECT tt."tagId", t."entityId", SUM(t."amount") as total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."postedAt" >= ${start} AND t."postedAt" < ${end} AND t."archivedAt" IS NULL
    GROUP BY tt."tagId", t."entityId"
  `;

  const spendMap = new Map(spendRows.map((r) => [`${r.tagId}:${r.entityId}`, parseFloat(r.total)]));

  const header = toCsvRow(["Period", "Entity", "Tag", "Budgeted", "Actual", "% Used", "Remaining"]);
  const rows = budgets.map((b) => {
    const actual = Math.abs(spendMap.get(`${b.tagId}:${b.entityId}`) ?? 0);
    const budgeted = b.budgeted.toNumber();
    const pct = budgeted > 0 ? Math.round((actual / budgeted) * 100) : 0;
    return toCsvRow([
      period,
      b.entity.name.split(",")[0],
      b.tag.shortName,
      budgeted.toFixed(2),
      actual.toFixed(2),
      `${pct}%`,
      (budgeted - actual).toFixed(2),
    ]);
  });

  return [header, ...rows].join("\n");
}

// ── P&L CSV export ────────────────────────────────────────────────────────────

export async function exportPlCsv(entityId: string, startDate: string, endDate: string): Promise<string> {
  await requireAuth();

  const transactions = await db.transaction.findMany({
    where: {
      entityId,
      archivedAt: null,
      postedAt: { gte: new Date(startDate), lte: new Date(endDate) },
    },
    include: { tags: { include: { tag: true } }, glCode: true },
    orderBy: { postedAt: "asc" },
  });

  const header = toCsvRow(["Date", "Payee", "Amount", "Type", "GL Code", "Tags"]);
  const rows = transactions.map((t) => {
    const amount = t.amount.toNumber();
    return toCsvRow([
      t.postedAt.toISOString().slice(0, 10),
      t.payeeRaw ?? t.payeeNormalized ?? "",
      amount.toFixed(2),
      amount >= 0 ? "Income" : "Expense",
      t.glCode ? `${t.glCode.code} ${t.glCode.name}` : "",
      t.tags.map((tt) => tt.tag.shortName).join("; "),
    ]);
  });

  return [header, ...rows].join("\n");
}

// ── Balance Sheet CSV export ──────────────────────────────────────────────────

export async function exportBalanceSheetCsv(entityId: string): Promise<string> {
  await requireAuth();

  const { computeBalanceSheet } = await import("@/lib/reports");
  const bs = await computeBalanceSheet(entityId, new Date());

  function fmtDollars(cents: number) {
    return (cents / 100).toFixed(2);
  }

  const header = toCsvRow(["Section", "Account", "Mask", "Amount"]);
  const assetRows = bs.assets.map((a) =>
    toCsvRow(["Asset", a.label, a.mask ?? "", fmtDollars(a.amountCents)])
  );
  const liabilityRows = bs.liabilities.map((l) =>
    toCsvRow(["Liability", l.label, l.mask ?? "", fmtDollars(l.amountCents)])
  );
  const totals = [
    toCsvRow(["", "Total Assets", "", fmtDollars(bs.totalAssetsCents)]),
    toCsvRow(["", "Total Liabilities", "", fmtDollars(bs.totalLiabilitiesCents)]),
    toCsvRow(["", "Equity", "", fmtDollars(bs.equityCents)]),
  ];

  return [header, ...assetRows, ...liabilityRows, ...totals].join("\n");
}

// ── CPA bundle manifest ────────────────────────────────────────────────────────

export async function exportCpaBundle(
  entityId: string,
  taxYear: number
): Promise<Array<{ name: string; type: string; notes: string | null; docId: string }>> {
  await requireAuth();

  const docs = await db.document.findMany({
    where: { entityId, taxYear, archivedAt: null },
    orderBy: { docType: "asc" },
    select: { id: true, docType: true, notes: true, createdAt: true },
  });

  return docs.map((d) => ({
    name: `${d.docType}_${d.createdAt.toISOString().slice(0, 10)}`,
    type: d.docType,
    notes: d.notes,
    docId: d.id,
  }));
}
