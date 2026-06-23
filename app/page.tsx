import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell, BUCKET_ENTITY_NAMES, type BucketSlug } from "@/components/app-shell";
import { BUCKET_DISPLAY_LABELS } from "@/lib/buckets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { computeBudgetSummary } from "@/lib/budget";
import { formatUSD, decimalToNumber } from "@/lib/utils";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { DashboardClient, type SerializedBudget } from "@/components/dashboard/dashboard-client";

interface PageProps {
  searchParams: Promise<{ bucket?: string }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = (params.bucket ?? "personal") as BucketSlug;
  const entityName = BUCKET_ENTITY_NAMES[bucket]; // null = all entities (Taxes tab)
  const bucketLabel = BUCKET_DISPLAY_LABELS[bucket];

  const entity = entityName
    ? await db.entity.findFirst({ where: { name: entityName } })
    : null;

  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const monthStart = new Date(`${period}-01T00:00:00Z`);
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  // Budget lines for this entity + period
  const budgets = await db.budget.findMany({
    where: { ...(entity && { entityId: entity.id }), period },
    include: { tag: true, account: { include: { institution: true } } },
    orderBy: [{ account: { nickname: "asc" } }, { tag: { name: "asc" } }],
  });

  // Actual spend per tag this month via raw query
  const tagSpend = entity
    ? await db.$queryRaw<{ tagId: string; total: string }[]>`
        SELECT tt."tagId", SUM(t.amount)::text AS total
        FROM "Transaction" t
        JOIN "TransactionTag" tt ON tt."transactionId" = t.id
        WHERE t."entityId" = ${entity.id}
          AND t."archivedAt" IS NULL
          AND t."transferPairId" IS NULL
          AND t."postedAt" >= ${monthStart}
          AND t."postedAt" < ${monthEnd}
        GROUP BY tt."tagId"
      `
    : await db.$queryRaw<{ tagId: string; total: string }[]>`
        SELECT tt."tagId", SUM(t.amount)::text AS total
        FROM "Transaction" t
        JOIN "TransactionTag" tt ON tt."transactionId" = t.id
        WHERE t."archivedAt" IS NULL
          AND t."transferPairId" IS NULL
          AND t."postedAt" >= ${monthStart}
          AND t."postedAt" < ${monthEnd}
        GROUP BY tt."tagId"
      `;

  const spendByTagId = new Map<string, Prisma.Decimal>(
    tagSpend.map((r) => [r.tagId, new Prisma.Decimal(r.total)])
  );

  // Total spend this month (all transactions)
  const spendAgg = await db.transaction.aggregate({
    where: {
      ...(entity && { entityId: entity.id }),
      archivedAt: null,
      transferPairId: null,
      postedAt: { gte: monthStart, lt: monthEnd },
    },
    _sum: { amount: true },
  });
  const totalSpend = new Prisma.Decimal(spendAgg._sum.amount ?? 0);

  // Accounts for this entity (or all when null)
  const accounts = await db.account.findMany({
    where: { ...(entity && { entityId: entity.id }), archivedAt: null },
    include: { institution: true },
    orderBy: { nickname: "asc" },
  });

  // Scheduled transfers
  const scheduledTransfers = await db.scheduledTransfer.findMany({
    where: { active: true },
    include: { fromAccount: true, toAccount: true },
    take: 10,
  });

  const totalBudgeted = budgets.reduce(
    (sum, b) => sum.plus(b.budgeted),
    new Prisma.Decimal(0)
  );

  const overspentCount = budgets.filter((b) => {
    const actual = spendByTagId.get(b.tagId) ?? new Prisma.Decimal(0);
    return computeBudgetSummary({
      budgeted: new Prisma.Decimal(b.budgeted),
      rolloverAmount: new Prisma.Decimal(b.rolloverAmount ?? 0),
      actualSpend: actual,
    }).isOverspent;
  }).length;

  const chartData = budgets
    .map((b) => {
      const actual = decimalToNumber(
        (spendByTagId.get(b.tagId) ?? new Prisma.Decimal(0)).abs()
      );
      return {
        tagId: b.tagId,
        name: b.tag.shortName,
        budget: decimalToNumber(new Prisma.Decimal(b.budgeted)),
        actual,
      };
    })
    .filter((d) => d.budget > 0 || d.actual > 0)
    .sort((a, b) => b.actual - a.actual)
    .slice(0, 10);

  const serializedBudgets: SerializedBudget[] = budgets.map((b) => {
    const actual = spendByTagId.get(b.tagId) ?? new Prisma.Decimal(0);
    const budgetedDec = new Prisma.Decimal(b.budgeted);
    const rolloverDec = new Prisma.Decimal(b.rolloverAmount ?? 0);
    const effectiveBudget = budgetedDec.plus(rolloverDec);
    const remaining = effectiveBudget.plus(actual);
    const percentUsed = effectiveBudget.isZero()
      ? 0
      : actual.abs().div(effectiveBudget).times(100).toNumber();
    return {
      id: b.id,
      tagId: b.tagId,
      tagShortName: b.tag.shortName,
      budgeted: decimalToNumber(budgetedDec),
      spent: decimalToNumber(actual),
      percentUsed: Math.min(percentUsed, 999),
      isOverspent: remaining.isNegative(),
    };
  });

  const allTags = await db.tag.findMany({ orderBy: { name: "asc" } });

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <DashboardClient
        chartData={chartData}
        budgets={serializedBudgets}
        allTags={allTags}
        entityId={entity?.id}
        period={period}
      >
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">
            {bucketLabel} — {formatPeriod(period)}
          </h1>
          <p className="text-sm text-muted-foreground">Monthly budget overview</p>
        </div>

        {/* Summary cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Budgeted
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{formatUSD(decimalToNumber(totalBudgeted))}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Spent This Month
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-destructive">
                {formatUSD(decimalToNumber(totalSpend.abs()))}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Overspent Lines
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${overspentCount > 0 ? "text-destructive" : "text-green-600"}`}>
                {overspentCount}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Budget lines table */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Budget Lines
              <Link
                href={`/budgets?bucket=${bucket}`}
                className="text-sm font-normal text-muted-foreground underline-offset-4 hover:underline"
              >
                Full report →
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Category</th>
                    <th className="px-4 py-2 font-medium text-right">Budget</th>
                    <th className="px-4 py-2 font-medium text-right">Spent</th>
                    <th className="px-4 py-2 font-medium text-right">Remaining</th>
                    <th className="px-4 py-2 font-medium">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {budgets.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                        No budget lines for {formatPeriod(period)}
                      </td>
                    </tr>
                  )}
                  {budgets.map((b) => {
                    const actual = spendByTagId.get(b.tagId) ?? new Prisma.Decimal(0);
                    const summary = computeBudgetSummary({
                      budgeted: new Prisma.Decimal(b.budgeted),
                      rolloverAmount: new Prisma.Decimal(b.rolloverAmount ?? 0),
                      actualSpend: actual,
                    });
                    return (
                      <tr key={b.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-4 py-2">
                          <span className="font-medium">{b.tag.shortName}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {b.account.nickname}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right">
                          {formatUSD(decimalToNumber(summary.effectiveBudget))}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {formatUSD(decimalToNumber(summary.actualSpend.abs()))}
                        </td>
                        <td className={`px-4 py-2 text-right font-medium ${summary.isOverspent ? "text-destructive" : ""}`}>
                          {formatUSD(decimalToNumber(summary.remaining))}
                        </td>
                        <td className="px-4 py-2">
                          <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full ${summary.isOverspent ? "bg-destructive" : "bg-primary"}`}
                              style={{ width: `${Math.min(summary.percentUsed, 100)}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Accounts + Scheduled Transfers */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Accounts</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <tbody>
                  {accounts.map((acct) => (
                    <tr key={acct.id} className="border-b last:border-0">
                      <td className="px-4 py-2 font-medium">
                        {acct.nickname}
                        <span className="ml-1 font-mono text-xs text-muted-foreground">···{acct.mask}</span>
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                        {acct.institution.name}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Scheduled Transfers</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <tbody>
                  {scheduledTransfers.length === 0 && (
                    <tr>
                      <td className="px-4 py-3 text-muted-foreground">None configured</td>
                    </tr>
                  )}
                  {scheduledTransfers.map((st) => (
                    <tr key={st.id} className="border-b last:border-0">
                      <td className="px-4 py-2 text-xs">
                        {st.fromAccount.nickname} → {st.toAccount.nickname}
                      </td>
                      <td className="px-4 py-2 text-right font-medium">
                        {formatUSD(decimalToNumber(new Prisma.Decimal(st.amount)))}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-xs">
                          {st.cadence}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      </div>
      </DashboardClient>
    </AppShell>
  );
}

function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}
