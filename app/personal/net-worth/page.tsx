import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { computeNetWorth, listManualAssets } from "@/actions/net-worth";
import { db } from "@/lib/db";
import { NetWorthChart } from "@/components/net-worth/net-worth-chart";
import { ManualAssetForm } from "@/components/net-worth/manual-asset-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Route } from "next";

function fmtMoney(cents: number): string {
  const abs = Math.abs(cents / 100);
  return `${cents < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  investment: "Investment",
  insurance: "Insurance",
  credit_card: "Credit card",
  mortgage: "Mortgage",
  loan: "Loan",
};

export default async function NetWorthPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const [nw, manualAssets, snapshots] = await Promise.all([
    computeNetWorth(),
    listManualAssets(),
    db.netWorthSnapshot.findMany({
      orderBy: { date: "asc" },
      take: 12,
    }),
  ]);

  const assetAccounts = nw.accounts.filter((a) => !a.isLiability);
  const liabilityAccounts = nw.accounts.filter((a) => a.isLiability);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Net Worth</h1>
          <p className="text-sm text-muted-foreground">
            Assets minus liabilities. Property values are your estimates — never auto-generated.
          </p>
        </div>

        {/* Summary cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="pt-5">
              <p className="text-2xl font-bold text-green-600">{fmtMoney(nw.totalAssetsCents)}</p>
              <p className="text-xs text-muted-foreground">Total assets</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <p className="text-2xl font-bold text-destructive">{fmtMoney(nw.totalLiabilitiesCents)}</p>
              <p className="text-xs text-muted-foreground">Total liabilities</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <p className={cn("text-2xl font-bold", nw.netWorthCents >= 0 ? "text-green-600" : "text-destructive")}>
                {fmtMoney(nw.netWorthCents)}
              </p>
              <p className="text-xs text-muted-foreground">Net worth</p>
            </CardContent>
          </Card>
        </div>

        <NetWorthChart
          snapshots={snapshots.map((s) => ({
            date: s.date,
            netWorthCents: s.netWorthCents,
            totalAssetsCents: s.totalAssetsCents,
            totalLiabilitiesCents: s.totalLiabilitiesCents,
          }))}
          currentNetWorthCents={nw.netWorthCents}
        />

        {/* Breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {/* Asset accounts */}
                {assetAccounts.map((a, i) => (
                  <tr key={i} className="border-b">
                    <td className="px-4 py-2">{a.nickname}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{ACCOUNT_TYPE_LABELS[a.accountType] ?? a.accountType}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(a.balanceCents)}</td>
                  </tr>
                ))}

                {/* Manual assets */}
                {nw.manualAssets.map((a, i) => (
                  <tr key={`ma-${i}`} className="border-b">
                    <td className="px-4 py-2">{a.name}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {a.category === "real_estate" ? "Real estate" : a.category === "vehicle" ? "Vehicle" : "Other"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(a.valueCents)}</td>
                  </tr>
                ))}

                {/* Insurance cash values */}
                {nw.cashValues.map((c, i) => (
                  <tr key={`cv-${i}`} className="border-b">
                    <td className="px-4 py-2">{c.policyName}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">Insurance cash value</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(c.cashValueCents)}</td>
                  </tr>
                ))}

                {/* Total assets row */}
                <tr className="border-b bg-green-50/50">
                  <td className="px-4 py-2 font-semibold" colSpan={2}>Total assets</td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums text-green-700">{fmtMoney(nw.totalAssetsCents)}</td>
                </tr>

                {/* Liabilities */}
                {liabilityAccounts.map((a, i) => (
                  <tr key={`l-${i}`} className="border-b">
                    <td className="px-4 py-2">{a.nickname}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{ACCOUNT_TYPE_LABELS[a.accountType] ?? a.accountType}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-destructive">({fmtMoney(a.balanceCents)})</td>
                  </tr>
                ))}

                {/* Total liabilities row */}
                <tr className="border-b bg-red-50/50">
                  <td className="px-4 py-2 font-semibold" colSpan={2}>Total liabilities</td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums text-destructive">({fmtMoney(nw.totalLiabilitiesCents)})</td>
                </tr>

                {/* Net worth */}
                <tr className="bg-muted/30">
                  <td className="px-4 py-3 font-bold text-base" colSpan={2}>Net worth</td>
                  <td className={cn("px-4 py-3 text-right font-bold text-base tabular-nums", nw.netWorthCents >= 0 ? "text-green-700" : "text-destructive")}>
                    {fmtMoney(nw.netWorthCents)}
                  </td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Missing balances warning */}
        {nw.missingBalances.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Accounts excluded (no balance on record): {nw.missingBalances.join(", ")}.
            Update balances in{" "}
            <a href="/accounts" className="text-primary hover:underline">Accounts</a>.
          </p>
        )}

        <ManualAssetForm assets={manualAssets.map((a) => ({
          id: a.id,
          name: a.name,
          category: a.category,
          valueCents: a.valueCents,
          asOf: a.asOf,
          notes: a.notes,
        }))} />
      </div>
    </AppShell>
  );
}
