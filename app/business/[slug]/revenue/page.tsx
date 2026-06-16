import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell, BUCKET_ENTITY_NAMES, type BucketSlug } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RevenueBarChart } from "@/components/business/revenue-bar-chart";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
}

const LABEL_MAP: Partial<Record<BucketSlug, string>> = {
  "sudden-valley": "Sudden Valley PM",
  "ek-consulting": "EK Consulting",
  mezzo: "Mezzo",
};

function fmtUSD(dollars: number): string {
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function RevenuePage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const { slug } = await params;
  const entityLabel = LABEL_MAP[slug as BucketSlug] ?? slug;
  const entityName = BUCKET_ENTITY_NAMES[slug as BucketSlug];

  if (!entityName) redirect("/business" as Route);

  const entity = await db.entity.findFirst({ where: { name: entityName } });
  if (!entity) redirect("/business" as Route);

  const twelveMonthsAgo = new Date(
    Date.UTC(new Date().getUTCFullYear() - 1, new Date().getUTCMonth(), 1)
  );

  const rows = await db.$queryRaw<{ month: string; total: string }[]>`
    SELECT to_char(t."postedAt", 'YYYY-MM') AS month, SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "GlCode" g ON g.id = t."glCodeId"
    WHERE t."entityId" = ${entity.id}
      AND t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND g.type = 'income'
      AND t."postedAt" >= ${twelveMonthsAgo}
    GROUP BY month
    ORDER BY month ASC
  `;

  const monthlyData = rows.map((r) => ({
    month: r.month,
    revenueDollars: Math.abs(parseFloat(r.total)),
  }));

  const totalRevenue = monthlyData.reduce((s, r) => s + r.revenueDollars, 0);

  // Compute MoM delta for table
  const tableRows = monthlyData.map((row, i) => {
    const prev = monthlyData[i - 1];
    const delta =
      prev && prev.revenueDollars > 0
        ? Math.round(((row.revenueDollars - prev.revenueDollars) / prev.revenueDollars) * 100)
        : null;
    return { ...row, delta };
  });

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{entityLabel} — Revenue by Month</h1>
          <p className="text-sm text-muted-foreground">Last 12 months of income GL-coded transactions.</p>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Monthly revenue</CardTitle>
              {monthlyData.length > 0 && (
                <span className="text-sm font-medium text-muted-foreground">
                  Total: {fmtUSD(totalRevenue)}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {monthlyData.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No income GL-coded transactions found for the last 12 months.
              </p>
            ) : (
              <RevenueBarChart data={monthlyData} />
            )}
          </CardContent>
        </Card>

        {tableRows.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Month-by-month</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Month</th>
                    <th className="px-4 py-2 font-medium text-right">Revenue</th>
                    <th className="px-4 py-2 font-medium text-right">vs. prior month</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2 font-medium">{row.month}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtUSD(row.revenueDollars)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {row.delta != null ? (
                          <span className={row.delta >= 0 ? "text-green-600" : "text-destructive"}>
                            {row.delta >= 0 ? "+" : ""}{row.delta}%
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/30">
                    <td className="px-4 py-2 font-semibold">Total</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{fmtUSD(totalRevenue)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          Income is recognized when transactions are tagged with an income GL code.
          Airbnb deposits must be imported to appear here.
        </p>
      </div>
    </AppShell>
  );
}
