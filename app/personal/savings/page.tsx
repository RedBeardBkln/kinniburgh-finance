import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Route } from "next";

function formatMoney(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0 })}`;
}

export default async function SavingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  // Find x3950 savings account (savings autopilot target per spec)
  const savingsAccount = await db.account.findFirst({
    where: { mask: "3950", archivedAt: null },
    select: {
      id: true,
      nickname: true,
      currentBalance: true,
      scheduledTransfersTo: {
        where: { active: true },
        select: { id: true, amount: true, cadence: true, purpose: true, fromAccount: { select: { nickname: true } } },
      },
    },
  });

  const balanceCents = savingsAccount?.currentBalance
    ? Math.round(savingsAccount.currentBalance.toNumber() * 100)
    : null;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Savings Autopilot</h1>
          <p className="text-sm text-muted-foreground">
            Track your savings progress and scheduled contributions.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {savingsAccount?.nickname ?? "Savings account (x3950)"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tabular-nums">
                {formatMoney(balanceCents)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Current balance</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Scheduled contributions</CardTitle>
            </CardHeader>
            <CardContent>
              {savingsAccount?.scheduledTransfersTo.length ? (
                <ul className="space-y-2">
                  {savingsAccount.scheduledTransfersTo.map((t) => (
                    <li key={t.id} className="text-sm">
                      <span className="font-medium">${t.amount.toFixed(2)}</span>{" "}
                      <span className="text-muted-foreground">{t.cadence}</span>
                      {t.purpose && <span className="text-muted-foreground"> · {t.purpose}</span>}
                      <span className="text-muted-foreground text-xs block">from {t.fromAccount.nickname}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No scheduled transfers yet.{" "}
                  <a href={"/personal/accounts" as Route} className="text-primary hover:underline">
                    Set up a transfer →
                  </a>
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {savingsAccount && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Goal tracker</CardTitle>
            </CardHeader>
            <CardContent>
              <SavingsGoalTracker
                accountId={savingsAccount.id}
                currentBalanceCents={balanceCents ?? 0}
              />
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

function SavingsGoalTracker({
  currentBalanceCents,
}: {
  accountId: string;
  currentBalanceCents: number;
}) {
  const goalCents = 1200000; // $12,000 default starter goal — user sets their own
  const pct = Math.min(100, Math.round((currentBalanceCents / goalCents) * 100));

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{pct}%</p>
          <p className="text-xs text-muted-foreground">
            {formatMoney(currentBalanceCents)} of {formatMoney(goalCents)} starter goal
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          {formatMoney(goalCents - currentBalanceCents)} remaining
        </p>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Set your savings goal in account settings. Automated transfers are managed under Scheduled Transfers.
      </p>
    </div>
  );
}
