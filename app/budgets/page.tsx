import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell, BUCKET_ENTITY_NAMES, type BucketSlug } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { computeBudgetSummary } from "@/lib/budget";
import { formatUSD, decimalToNumber } from "@/lib/utils";
import { Prisma } from "@prisma/client";
import { PeriodPicker } from "@/components/period-picker";

interface PageProps {
  searchParams: Promise<{ bucket?: string; period?: string }>;
}

export default async function BudgetsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = (params.bucket ?? "personal") as BucketSlug;
  const entityName = BUCKET_ENTITY_NAMES[bucket] ?? "Personal";

  const now = new Date();
  const defaultPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const period = params.period ?? defaultPeriod;

  const [year, mon] = period.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year!, mon! - 1, 1));
  const monthEnd = new Date(Date.UTC(year!, mon!, 1));

  const entity = await db.entity.findFirst({ where: { name: entityName } });
  if (!entity) {
    return (
      <AppShell userName={session.user.name ?? undefined}>
        <p className="text-muted-foreground">Entity not found: {entityName}</p>
      </AppShell>
    );
  }

  const budgets = await db.budget.findMany({
    where: { entityId: entity.id, period },
    include: { tag: true, account: { include: { institution: true } } },
    orderBy: [{ account: { nickname: "asc" } }, { tag: { name: "asc" } }],
  });

  // Per-tag actual spend this month
  const tagSpend = await db.$queryRaw<{ tagId: string; total: string }[]>`
    SELECT tt."tagId", SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."entityId" = ${entity.id}
      AND t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${monthStart}
      AND t."postedAt" < ${monthEnd}
    GROUP BY tt."tagId"
  `;

  const spendByTagId = new Map<string, Prisma.Decimal>(
    tagSpend.map((r) => [r.tagId, new Prisma.Decimal(r.total)])
  );

  // Group budgets by account
  const byAccount = new Map<string, typeof budgets>();
  for (const b of budgets) {
    const key = b.account.nickname;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key)!.push(b);
  }

  // Totals
  const totalBudgeted = budgets.reduce(
    (s, b) => s.plus(b.budgeted),
    new Prisma.Decimal(0)
  );
  const totalActual = [...spendByTagId.values()].reduce(
    (s, v) => s.plus(v),
    new Prisma.Decimal(0)
  );
  const totalRemaining = totalBudgeted.plus(totalActual); // actual is negative

  // Build period options (Jan–Dec of current year)
  const periodOptions = Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, "0");
    const p = `${now.getUTCFullYear()}-${m}`;
    return { value: p, label: formatPeriod(p) };
  });

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Budget Report</h1>
            <p className="text-sm text-muted-foreground">
              {entityName} · {formatPeriod(period)}
            </p>
          </div>
          <PeriodPicker period={period} bucket={bucket} options={periodOptions} />
        </div>

        {/* Summary totals */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Budgeted</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{formatUSD(decimalToNumber(totalBudgeted))}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Spent</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-destructive">
                {formatUSD(decimalToNumber(totalActual.abs()))}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Remaining</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${totalRemaining.isNegative() ? "text-destructive" : "text-green-600"}`}>
                {formatUSD(decimalToNumber(totalRemaining))}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Per-account budget sections */}
        {[...byAccount.entries()].map(([accountName, lines]) => {
          const accountTotal = lines.reduce(
            (s, b) => s.plus(b.budgeted),
            new Prisma.Decimal(0)
          );
          return (
            <Card key={accountName}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>{accountName}</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {formatUSD(decimalToNumber(accountTotal))} budgeted
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Category</th>
                      <th className="px-4 py-2 font-medium text-right">Budgeted</th>
                      <th className="px-4 py-2 font-medium text-right">Rollover</th>
                      <th className="px-4 py-2 font-medium text-right">Effective</th>
                      <th className="px-4 py-2 font-medium text-right">Spent</th>
                      <th className="px-4 py-2 font-medium text-right">Remaining</th>
                      <th className="px-4 py-2 font-medium">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((b) => {
                      const actual = spendByTagId.get(b.tagId) ?? new Prisma.Decimal(0);
                      const summary = computeBudgetSummary({
                        budgeted: new Prisma.Decimal(b.budgeted),
                        rolloverAmount: new Prisma.Decimal(b.rolloverAmount ?? 0),
                        actualSpend: actual,
                      });
                      return (
                        <tr key={b.id} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-4 py-2 font-medium">{b.tag.shortName}</td>
                          <td className="px-4 py-2 text-right">
                            {formatUSD(decimalToNumber(summary.budgeted))}
                          </td>
                          <td className={`px-4 py-2 text-right text-xs ${summary.rolloverAmount.isNegative() ? "text-destructive" : summary.rolloverAmount.isZero() ? "text-muted-foreground" : "text-green-600"}`}>
                            {summary.rolloverAmount.isZero()
                              ? "—"
                              : formatUSD(decimalToNumber(summary.rolloverAmount))}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {formatUSD(decimalToNumber(summary.effectiveBudget))}
                          </td>
                          <td className="px-4 py-2 text-right text-destructive">
                            {formatUSD(decimalToNumber(summary.actualSpend.abs()))}
                          </td>
                          <td className={`px-4 py-2 text-right font-medium ${summary.isOverspent ? "text-destructive" : ""}`}>
                            {formatUSD(decimalToNumber(summary.remaining))}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-1.5">
                              <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                                <div
                                  className={`h-full rounded-full ${summary.isOverspent ? "bg-destructive" : "bg-primary"}`}
                                  style={{ width: `${Math.min(summary.percentUsed, 100)}%` }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {Math.round(summary.percentUsed)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          );
        })}

        {budgets.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No budget lines found for {formatPeriod(period)}
            </CardContent>
          </Card>
        )}
      </div>
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
