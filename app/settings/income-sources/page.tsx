import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AddIncomeSourceForm } from "@/components/settings/add-income-source-form";
import {
  ToggleIncomeSourceButton,
  DeleteIncomeSourceButton,
} from "@/components/settings/income-source-actions";
import type { Route } from "next";

const CADENCE_LABELS: Record<string, string> = {
  semi_monthly: "Semi-monthly",
  biweekly: "Bi-weekly",
  monthly: "Monthly",
  weekly: "Weekly",
};

export default async function IncomeSourcesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const [sources, entities, accounts] = await Promise.all([
    db.incomeSource.findMany({
      orderBy: { description: "asc" },
      include: { entity: true, account: true },
    }),
    db.entity.findMany({ orderBy: { name: "asc" } }),
    db.account.findMany({
      where: { archivedAt: null },
      select: { id: true, entityId: true, nickname: true, mask: true },
      orderBy: { nickname: "asc" },
    }),
  ]);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Income Sources</h1>
          <p className="text-sm text-muted-foreground">
            Recurring income events used by the 30-day forecast and low-balance alerts.
          </p>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Configured sources</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {sources.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No income sources yet. Add one below to enable balance forecasting.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium">Entity</th>
                    <th className="px-4 py-2 font-medium">Account</th>
                    <th className="px-4 py-2 font-medium">Cadence</th>
                    <th className="px-4 py-2 font-medium text-right">Amount</th>
                    <th className="px-4 py-2 font-medium text-center">Active</th>
                    <th className="px-4 py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2 font-medium">{s.description}</td>
                      <td className="px-4 py-2 text-muted-foreground">{s.entity.name}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {s.account.nickname}
                        {s.account.mask ? ` (x${s.account.mask})` : ""}
                      </td>
                      <td className="px-4 py-2">{CADENCE_LABELS[s.cadence] ?? s.cadence}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        ${Number(s.amount).toLocaleString("en-US", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Badge variant={s.active ? "outline" : "secondary"}>
                          {s.active ? "Active" : "Disabled"}
                        </Badge>
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-3">
                          <ToggleIncomeSourceButton id={s.id} active={s.active} />
                          <DeleteIncomeSourceButton id={s.id} description={s.description} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <AddIncomeSourceForm entities={entities} accounts={accounts} />
      </div>
    </AppShell>
  );
}
