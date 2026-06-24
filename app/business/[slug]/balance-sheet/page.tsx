import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { computeBalanceSheet } from "@/lib/reports";
import { exportBalanceSheetCsv } from "@/actions/reports";
import { ExportCsvButton } from "@/components/export-csv-button";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
}


function fmtUSD(cents: number): string {
  const abs = Math.abs(cents);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(abs / 100);
  return cents < 0 ? `(${formatted})` : formatted;
}

export default async function BalanceSheetPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { slug } = await params;
  const entity = await getEntityBySlug(slug);
  const entityLabel = entity?.navLabel ?? entity?.name ?? slug;

  if (!entity) redirect("/business" as Route);

  const bs = await computeBalanceSheet(entity.id);
  const asOfDate = bs.asOfDate;

  const asOfLabel = asOfDate.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6 max-w-2xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Link href={"/business" as Route} className="hover:underline">Business</Link>
              <span>/</span>
              <span>{entityLabel}</span>
            </div>
            <h1 className="text-2xl font-semibold">Balance Sheet</h1>
            <p className="text-sm text-muted-foreground">As of {asOfLabel}</p>
          </div>
          <ExportCsvButton
            filename={`balance-sheet-${slug}-${asOfDate.toISOString().slice(0, 10)}.csv`}
            action={exportBalanceSheetCsv.bind(null, entity.id)}
          />
        </div>

        {/* Assets */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-green-700">Assets</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {bs.assets.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-6 text-center text-muted-foreground">
                      No asset accounts linked to this entity
                    </td>
                  </tr>
                ) : (
                  bs.assets.map((a) => (
                    <tr key={a.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        {a.label}
                        {a.mask && <span className="ml-1.5 text-xs text-muted-foreground">···{a.mask}</span>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-green-600">
                        {fmtUSD(a.amountCents)}
                      </td>
                    </tr>
                  ))
                )}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-4 py-2">Total Assets</td>
                  <td className="px-4 py-2 text-right tabular-nums text-green-600">
                    {fmtUSD(bs.totalAssetsCents)}
                  </td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Liabilities */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-destructive">Liabilities</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Account</th>
                  <th className="px-4 py-2 font-medium text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {bs.liabilities.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-6 text-center text-muted-foreground">
                      No liability accounts linked to this entity
                    </td>
                  </tr>
                ) : (
                  bs.liabilities.map((l) => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        {l.label}
                        {l.mask && <span className="ml-1.5 text-xs text-muted-foreground">···{l.mask}</span>}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-destructive">
                        {fmtUSD(l.amountCents)}
                      </td>
                    </tr>
                  ))
                )}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-4 py-2">Total Liabilities</td>
                  <td className="px-4 py-2 text-right tabular-nums text-destructive">
                    {fmtUSD(bs.totalLiabilitiesCents)}
                  </td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Equity */}
        <Card className={bs.equityCents >= 0 ? "border-green-200 bg-green-50/50" : "border-destructive/30 bg-destructive/5"}>
          <CardContent className="flex items-center justify-between py-4 px-4">
            <p className="font-semibold text-base">Equity (Assets − Liabilities)</p>
            <p className={`text-xl font-bold ${bs.equityCents >= 0 ? "text-green-600" : "text-destructive"}`}>
              {fmtUSD(bs.equityCents)}
            </p>
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          Balances reflect the most recent account sync. Business-owned fixed assets not yet linked to accounts are excluded.
          Confirm all figures with your CPA — this is not financial advice.
        </p>
      </div>
    </AppShell>
  );
}
