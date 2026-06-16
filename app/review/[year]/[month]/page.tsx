import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Route } from "next";
import { GenerateButton } from "@/components/monthly-review/generate-button";

interface PageProps {
  params: Promise<{ year: string; month: string }>;
}

interface ReviewData {
  period: string;
  generatedAt: string;
  budgetHealth: Array<{
    tagName: string;
    entityName: string;
    budgetedCents: number;
    actualCents: number;
    percentUsed: number;
    status: "ok" | "warning" | "over";
  }>;
  accountSnapshot: Array<{
    nickname: string;
    balanceCents: number;
    minimumCents: number | null;
    marginCents: number | null;
  }>;
  upcomingBills: Array<{
    payee: string;
    amountCents: number | null;
    autopayDay: number | null;
    entityName: string;
  }>;
  accrualStatus: Array<{
    name: string;
    currentCents: number;
    targetCents: number;
    proRataCents: number;
    pct: number;
    status: "on_track" | "watch" | "behind";
  }>;
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0 })}`;
}

const STATUS_COLORS = {
  ok: "text-green-600",
  warning: "text-amber-600",
  over: "text-destructive",
  on_track: "text-green-600",
  watch: "text-amber-600",
  behind: "text-destructive",
};

const STATUS_BG = {
  ok: "bg-green-50 border-green-200",
  warning: "bg-amber-50 border-amber-200",
  over: "bg-red-50 border-red-200",
};

export default async function MonthlyReviewPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const { year, month } = await params;
  const period = `${year}-${month.padStart(2, "0")}`;

  const review = await db.monthlyReview.findUnique({ where: { period } });

  if (!review) {
    return (
      <AppShell userName={session.user.name ?? undefined}>
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold">Monthly Review — {period}</h1>
          <p className="text-sm text-muted-foreground">
            No review has been generated for this period yet.
          </p>
          <GenerateButton period={period} />
        </div>
      </AppShell>
    );
  }

  const data = review.data as unknown as ReviewData;

  const overCount = data.budgetHealth.filter((b) => b.status === "over").length;
  const warningCount = data.budgetHealth.filter((b) => b.status === "warning").length;
  const behindCount = data.accrualStatus.filter((a) => a.status === "behind").length;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Monthly Review — {period}</h1>
            <p className="text-sm text-muted-foreground">
              Generated {new Date(data.generatedAt).toLocaleString("en-US", { timeZone: "America/New_York" })}
            </p>
          </div>
          <GenerateButton period={period} label="Regenerate" />
        </div>

        {/* Health summary chips */}
        <div className="flex flex-wrap gap-2 text-sm">
          {overCount > 0 && (
            <span className="rounded-full border bg-red-50 px-3 py-1 text-xs font-medium text-red-700 border-red-200">
              {overCount} overspent
            </span>
          )}
          {warningCount > 0 && (
            <span className="rounded-full border bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 border-amber-200">
              {warningCount} approaching limit
            </span>
          )}
          {behindCount > 0 && (
            <span className="rounded-full border bg-red-50 px-3 py-1 text-xs font-medium text-red-700 border-red-200">
              {behindCount} accruals behind
            </span>
          )}
          {overCount === 0 && warningCount === 0 && behindCount === 0 && (
            <span className="rounded-full border bg-green-50 px-3 py-1 text-xs font-medium text-green-700 border-green-200">
              All budgets on track
            </span>
          )}
        </div>

        {/* Budget health */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Budget health</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Entity</th>
                  <th className="px-4 py-3 font-medium text-right">Budgeted</th>
                  <th className="px-4 py-3 font-medium text-right">Actual</th>
                  <th className="px-4 py-3 font-medium text-right">Used</th>
                </tr>
              </thead>
              <tbody>
                {data.budgetHealth
                  .sort((a, b) => b.percentUsed - a.percentUsed)
                  .map((b, i) => (
                    <tr key={i} className={cn("border-b last:border-0", STATUS_BG[b.status] ?? "")}>
                      <td className="px-4 py-2 font-medium">{b.tagName}</td>
                      <td className="px-4 py-2 text-muted-foreground text-xs">{b.entityName}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(b.budgetedCents)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(b.actualCents)}</td>
                      <td className={cn("px-4 py-2 text-right font-semibold tabular-nums", STATUS_COLORS[b.status])}>
                        {b.percentUsed}%
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Account snapshot */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Account snapshot</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {data.accountSnapshot.map((a, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{a.nickname}</p>
                      {a.marginCents !== null && (
                        <p className={cn("text-xs", a.marginCents < 5000 ? "text-destructive" : "text-muted-foreground")}>
                          {fmtMoney(a.marginCents)} above minimum
                        </p>
                      )}
                    </div>
                    <p className="text-sm font-semibold tabular-nums">{fmtMoney(a.balanceCents)}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Accrual pacing */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Accrual envelopes</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {data.accrualStatus.map((a, i) => (
                  <div key={i}>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-medium">{a.name}</p>
                      <p className={cn("text-xs font-semibold", STATUS_COLORS[a.status])}>
                        {a.pct}% of pace
                      </p>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", a.status === "on_track" ? "bg-green-500" : a.status === "watch" ? "bg-amber-500" : "bg-red-500")}
                        style={{ width: `${Math.min(100, a.pct)}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {fmtMoney(a.currentCents)} saved · {fmtMoney(a.proRataCents)} pro-rata target
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Upcoming bills */}
        {data.upcomingBills.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Scheduled bills</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Payee</th>
                    <th className="px-4 py-3 font-medium">Entity</th>
                    <th className="px-4 py-3 font-medium">Day</th>
                    <th className="px-4 py-3 font-medium text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.upcomingBills.map((b, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-4 py-2">{b.payee}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{b.entityName}</td>
                      <td className="px-4 py-2 text-muted-foreground">{b.autopayDay ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {b.amountCents ? fmtMoney(b.amountCents) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
