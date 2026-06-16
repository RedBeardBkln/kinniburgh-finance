import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell, BUCKET_ENTITY_NAMES, type BucketSlug } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CashFlowChart } from "@/components/business/cash-flow-chart";
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
  return `$${Math.abs(dollars).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function CashFlowPage({ params }: PageProps) {
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

  const rows = await db.$queryRaw<{ month: string; inflow: string; outflow: string }[]>`
    SELECT
      to_char(t."postedAt", 'YYYY-MM') AS month,
      SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)::text AS inflow,
      SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END)::text AS outflow
    FROM "Transaction" t
    WHERE t."entityId" = ${entity.id}
      AND t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${twelveMonthsAgo}
    GROUP BY month
    ORDER BY month ASC
  `;

  const monthlyData = rows.map((r) => {
    const inflowDollars = parseFloat(r.inflow);
    const outflowDollars = parseFloat(r.outflow);
    return {
      month: r.month,
      inflowDollars,
      outflowDollars,
      netDollars: inflowDollars - outflowDollars,
    };
  });

  const totalInflow = monthlyData.reduce((s, r) => s + r.inflowDollars, 0);
  const totalOutflow = monthlyData.reduce((s, r) => s + r.outflowDollars, 0);
  const totalNet = totalInflow - totalOutflow;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{entityLabel} — Cash Flow</h1>
          <p className="text-sm text-muted-foreground">Last 12 months of all non-transfer transactions.</p>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Monthly cash flow</CardTitle>
          </CardHeader>
          <CardContent>
            {monthlyData.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No transactions yet.</p>
            ) : (
              <CashFlowChart data={monthlyData} />
            )}
          </CardContent>
        </Card>

        {monthlyData.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Month-by-month</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Month</th>
                    <th className="px-4 py-2 font-medium text-right">Inflows</th>
                    <th className="px-4 py-2 font-medium text-right">Outflows</th>
                    <th className="px-4 py-2 font-medium text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyData.map((row, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2 font-medium">{row.month}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-green-600">
                        +{fmtUSD(row.inflowDollars)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-destructive">
                        −{fmtUSD(row.outflowDollars)}
                      </td>
                      <td className={`px-4 py-2 text-right tabular-nums font-medium ${row.netDollars >= 0 ? "text-green-600" : "text-destructive"}`}>
                        {row.netDollars >= 0 ? "+" : "−"}{fmtUSD(row.netDollars)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/30">
                    <td className="px-4 py-2 font-semibold">Total</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums text-green-600">
                      +{fmtUSD(totalInflow)}
                    </td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums text-destructive">
                      −{fmtUSD(totalOutflow)}
                    </td>
                    <td className={`px-4 py-2 text-right font-semibold tabular-nums ${totalNet >= 0 ? "text-green-600" : "text-destructive"}`}>
                      {totalNet >= 0 ? "+" : "−"}{fmtUSD(totalNet)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          All non-transfer transactions are included regardless of GL code. Transfer pairs are excluded.
        </p>
      </div>
    </AppShell>
  );
}
