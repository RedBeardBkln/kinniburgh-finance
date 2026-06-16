import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell, BUCKET_ENTITY_NAMES, type BucketSlug } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VendorSpendChart } from "@/components/business/vendor-spend-chart";
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

export default async function VendorsPage({ params }: PageProps) {
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

  const rows = await db.$queryRaw<{ description: string; tx_count: string; total: string }[]>`
    SELECT t.description, COUNT(*)::text AS tx_count, ABS(SUM(t.amount))::text AS total
    FROM "Transaction" t
    JOIN "GlCode" g ON g.id = t."glCodeId"
    WHERE t."entityId" = ${entity.id}
      AND t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND g.type = 'expense'
      AND t."postedAt" >= ${twelveMonthsAgo}
    GROUP BY t.description
    ORDER BY total DESC
    LIMIT 50
  `;

  const vendors = rows.map((r) => ({
    vendor: r.description,
    totalDollars: parseFloat(r.total),
    txCount: parseInt(r.tx_count, 10),
  }));

  const totalSpend = vendors.reduce((s, v) => s + v.totalDollars, 0);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{entityLabel} — Vendor Spend</h1>
          <p className="text-sm text-muted-foreground">Last 12 months of expense GL-coded transactions.</p>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Top vendors by spend</CardTitle>
              {vendors.length > 0 && (
                <span className="text-sm font-medium text-muted-foreground">
                  Total: {fmtUSD(totalSpend)}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {vendors.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No expense GL-coded transactions found for the last 12 months.
              </p>
            ) : (
              <VendorSpendChart data={vendors.slice(0, 10)} />
            )}
          </CardContent>
        </Card>

        {vendors.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">All vendors</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Vendor / Payee</th>
                    <th className="px-4 py-2 font-medium text-right">Transactions</th>
                    <th className="px-4 py-2 font-medium text-right">Total Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((v, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2 font-medium">{v.vendor}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{v.txCount}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtUSD(v.totalDollars)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/30">
                    <td className="px-4 py-2 font-semibold">Total</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">
                      {vendors.reduce((s, v) => s + v.txCount, 0)}
                    </td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{fmtUSD(totalSpend)}</td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          Only transactions with an expense GL code appear here. Assign GL codes via the coding queue to improve coverage.
        </p>
      </div>
    </AppShell>
  );
}
