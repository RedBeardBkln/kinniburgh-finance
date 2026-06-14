import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatUSD, decimalToNumber } from "@/lib/utils";
import { Prisma } from "@prisma/client";

export default async function AccountsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const accounts = await db.account.findMany({
    where: { archivedAt: null },
    include: {
      institution: true,
      entity: true,
      plaidItem: true,
    },
    orderBy: [{ entity: { name: "asc" } }, { nickname: "asc" }],
  });

  // Group by entity
  const byEntity = new Map<string, typeof accounts>();
  for (const acct of accounts) {
    const key = acct.entity.name;
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key)!.push(acct);
  }

  function modeBadge(mode: string) {
    const styles: Record<string, string> = {
      plaid: "bg-green-100 text-green-800 border-green-200",
      manual_import: "bg-blue-100 text-blue-800 border-blue-200",
      manual_entry: "bg-gray-100 text-gray-700 border-gray-200",
    };
    const labels: Record<string, string> = {
      plaid: "Plaid",
      manual_import: "CSV Import",
      manual_entry: "Manual",
    };
    return (
      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${styles[mode] ?? styles.manual_entry}`}>
        {labels[mode] ?? mode}
      </span>
    );
  }

  function statusBadge(status: string) {
    if (status === "active") return null;
    return (
      <span className="inline-flex items-center rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
        {status === "requires_login" ? "Re-link required" : "Error"}
      </span>
    );
  }

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Accounts</h1>
            <p className="text-sm text-muted-foreground">
              Bank connections, integration modes, and live balances
            </p>
          </div>
          <Link
            href="/accounts/connect"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            + Connect Bank
          </Link>
        </div>

        {[...byEntity.entries()].map(([entityName, entityAccounts]) => (
          <Card key={entityName}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{entityName}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Account</th>
                    <th className="px-4 py-2 font-medium">Institution</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Mode</th>
                    <th className="px-4 py-2 font-medium text-right">Balance</th>
                    <th className="px-4 py-2 font-medium">Last synced</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {entityAccounts.map((acct) => (
                    <tr key={acct.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2">
                        <span className="font-medium">{acct.nickname}</span>
                        {acct.mask && (
                          <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                            ···{acct.mask}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {acct.institution.name}
                        {acct.institution.plaidCoverageNotes === "unsupported" && (
                          <span className="ml-1.5 text-xs text-amber-600">(Plaid unsupported)</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground capitalize">
                        {acct.accountType.replace("_", " ")}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          {modeBadge(acct.integrationMode)}
                          {acct.plaidItem && statusBadge(acct.plaidItem.status)}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right font-medium tabular-nums">
                        {acct.currentBalance != null
                          ? formatUSD(decimalToNumber(new Prisma.Decimal(acct.currentBalance)))
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {acct.plaidItem?.lastSyncedAt
                          ? new Intl.DateTimeFormat("en-US", {
                              month: "short", day: "numeric",
                              hour: "numeric", minute: "2-digit",
                            }).format(new Date(acct.plaidItem.lastSyncedAt))
                          : acct.currentBalanceAt
                          ? new Intl.DateTimeFormat("en-US", {
                              month: "short", day: "numeric",
                            }).format(new Date(acct.currentBalanceAt))
                          : "—"}
                      </td>
                      <td className="px-4 py-2">
                        {acct.integrationMode === "plaid" && acct.plaidItem ? (
                          <div className="flex items-center gap-2">
                            {acct.plaidItem.status === "requires_login" ? (
                              <Link
                                href={`/accounts/connect?itemId=${acct.plaidItem.itemId}`}
                                className="text-xs font-medium text-red-600 hover:underline"
                              >
                                Re-link
                              </Link>
                            ) : (
                              <form action={`/api/plaid/sync/${acct.plaidItem.itemId}`} method="POST">
                                <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">
                                  Sync now
                                </button>
                              </form>
                            )}
                          </div>
                        ) : acct.institution.plaidCoverageNotes !== "unsupported" ? (
                          <Link
                            href="/accounts/connect"
                            className="text-xs text-primary hover:underline"
                          >
                            Connect to Plaid
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">Import CSV</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))}
      </div>
    </AppShell>
  );
}
