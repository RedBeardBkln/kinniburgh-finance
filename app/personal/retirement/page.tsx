import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RetirementBalanceForm } from "@/components/retirement/retirement-balance-form";
import type { Route } from "next";

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export default async function RetirementPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const [investmentAccounts, policies] = await Promise.all([
    db.account.findMany({
      where: { accountType: "investment", archivedAt: null },
      orderBy: { nickname: "asc" },
    }),
    db.insurancePolicy.findMany({
      where: { archivedAt: null, policyType: { in: ["whole", "ul"] } },
      include: { cashValueEntries: { orderBy: { asOf: "desc" }, take: 1 } },
    }),
  ]);

  const investmentTotalCents = investmentAccounts.reduce((sum, a) => {
    return sum + (a.currentBalance ? Math.round(a.currentBalance.toNumber() * 100) : 0);
  }, 0);

  const cashValueTotalCents = policies.reduce((sum, p) => {
    const latest = p.cashValueEntries[0];
    return sum + (latest ? latest.cashValueCents : 0);
  }, 0);

  const totalCents = investmentTotalCents + cashValueTotalCents;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Retirement Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Informational snapshot of retirement assets. Not investment advice.
          </p>
        </div>

        {/* Total */}
        <Card>
          <CardContent className="pt-5">
            <p className="text-3xl font-bold">{fmtMoney(totalCents)}</p>
            <p className="text-sm text-muted-foreground">Estimated retirement assets</p>
            <p className="text-xs text-muted-foreground mt-2 italic">
              These figures are informational snapshots based on balances you've entered. This app does not provide investment or retirement advice.
            </p>
          </CardContent>
        </Card>

        {/* Investment accounts */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Investment accounts</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {investmentAccounts.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                No investment accounts on record. Add one in{" "}
                <a href="/accounts" className="text-primary hover:underline">Accounts</a>.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Account</th>
                    <th className="px-4 py-3 font-medium text-right">Balance</th>
                    <th className="px-4 py-3 font-medium">Last updated</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {investmentAccounts.map((a) => (
                    <tr key={a.id} className="border-b last:border-0">
                      <td className="px-4 py-2">{a.nickname}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        {a.currentBalance ? fmtMoney(Math.round(a.currentBalance.toNumber() * 100)) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {a.currentBalanceAt
                          ? new Date(a.currentBalanceAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                          : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <RetirementBalanceForm accountId={a.id} accountName={a.nickname} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* Insurance cash values */}
        {policies.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Life insurance cash value</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Policy</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium text-right">Cash value</th>
                    <th className="px-4 py-3 font-medium">As of</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => {
                    const latest = p.cashValueEntries[0];
                    return (
                      <tr key={p.id} className="border-b last:border-0">
                        <td className="px-4 py-2">{p.insurer}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground capitalize">{p.policyType}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {latest ? fmtMoney(latest.cashValueCents) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {latest
                            ? new Date(latest.asOf).toLocaleDateString("en-US", { month: "short", year: "numeric" })
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="px-4 py-2 text-xs text-muted-foreground border-t">
                Manage cash value entries in{" "}
                <a href="/personal/insurance" className="text-primary hover:underline">Insurance →</a>
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
