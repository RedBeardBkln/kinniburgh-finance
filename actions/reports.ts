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
  const bs = await computeBalanceSheet(entityId);

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

// ── CPA export bundle (multi-section CSV) ─────────────────────────────────────

export async function exportCpaBundle(
  entityId: string,
  year: number
): Promise<string> {
  await requireAuth();

  const { computePL } = await import("@/lib/reports");

  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

  const [entity, transactions, mileageEntries, taxDeadlines, pl] = await Promise.all([
    db.entity.findUnique({ where: { id: entityId } }),
    db.transaction.findMany({
      where: {
        entityId,
        archivedAt: null,
        transferPairId: null,
        glCodeId: { not: null },
        postedAt: { gte: yearStart, lte: yearEnd },
      },
      include: {
        glCode: true,
        tags: { include: { tag: { select: { shortName: true } } } },
      },
      orderBy: { postedAt: "asc" },
    }),
    db.mileageEntry.findMany({
      where: {
        entityId,
        archivedAt: null,
        date: { gte: yearStart, lte: yearEnd },
      },
      orderBy: { date: "asc" },
    }),
    db.taxDeadline.findMany({
      where: { entityId, archivedAt: null },
      orderBy: { dueDate: "asc" },
    }),
    computePL(entityId, yearStart, yearEnd),
  ]);

  const sections: string[] = [];

  // Section 1: Entity Info
  sections.push(
    "## ENTITY INFO",
    toCsvRow(["Field", "Value"]),
    toCsvRow(["Entity Name", entity?.name ?? entityId]),
    toCsvRow(["Entity ID", entityId]),
    toCsvRow(["Tax Year", year]),
    toCsvRow(["Export Date", new Date().toISOString().slice(0, 10)]),
    ""
  );

  // Section 2: GL-Coded Transactions
  sections.push(
    "## GL-CODED TRANSACTIONS",
    toCsvRow(["Date", "Payee", "Amount", "GL Code", "GL Name", "Type", "Tags"]),
    ...transactions.map((t) =>
      toCsvRow([
        t.postedAt.toISOString().slice(0, 10),
        t.payeeRaw ?? t.payeeNormalized ?? "",
        t.amount.toFixed(2),
        t.glCode?.code ?? "",
        t.glCode?.name ?? "",
        t.glCode?.type ?? "",
        t.tags.map((tt) => tt.tag.shortName).join("; "),
      ])
    ),
    ""
  );

  // Section 3: P&L Summary
  sections.push(
    "## P&L SUMMARY",
    toCsvRow(["Section", "GL Code", "Name", "Amount"])
  );
  for (const line of pl.incomeLines) {
    sections.push(toCsvRow(["Income", line.code, line.name, line.total.toFixed(2)]));
  }
  sections.push(toCsvRow(["Income Total", "", "", pl.totalIncome.toFixed(2)]));
  for (const line of pl.expenseLines) {
    sections.push(toCsvRow(["Expense", line.code, line.name, line.total.abs().toFixed(2)]));
  }
  sections.push(
    toCsvRow(["Expense Total", "", "", pl.totalExpenses.abs().toFixed(2)]),
    toCsvRow(["Net Income", "", "", pl.netIncome.toFixed(2)]),
    ""
  );

  // Section 4: Mileage Log
  sections.push(
    "## MILEAGE LOG",
    toCsvRow(["Date", "Purpose", "Miles", "Rate/Mile", "Deduction", "Billable"])
  );
  for (const m of mileageEntries) {
    const deduction = (m.miles * m.ratePerMile.toNumber()).toFixed(2);
    sections.push(
      toCsvRow([
        m.date.toISOString().slice(0, 10),
        m.purpose,
        m.miles,
        m.ratePerMile.toFixed(3),
        deduction,
        m.billable ? "Yes" : "No",
      ])
    );
  }
  if (mileageEntries.length === 0) sections.push("(no entries)");
  sections.push("");

  // Section 5: Tax Deadlines
  sections.push(
    "## TAX DEADLINES",
    toCsvRow(["Label", "Due Date", "Type", "Status"])
  );
  for (const d of taxDeadlines) {
    sections.push(
      toCsvRow([d.label, d.dueDate.toISOString().slice(0, 10), d.type, d.status])
    );
  }
  if (taxDeadlines.length === 0) sections.push("(no deadlines)");

  return sections.join("\n");
}
