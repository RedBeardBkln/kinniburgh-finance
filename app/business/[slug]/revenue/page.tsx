import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RevenueBarChart } from "@/components/business/revenue-bar-chart";
import { ProjectedRevenueCard } from "@/components/business/projected-revenue-card";
import Link from "next/link";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
}

function fmtUSD(dollars: number): string {
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default async function RevenuePage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { slug } = await params;
  const entity = await getEntityBySlug(slug);
  if (!entity) notFound();
  const entityLabel = entity.navLabel ?? entity.name;

  const now = new Date();
  const twelveMonthsAgo = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));

  // Captured revenue: deposits into this entity's bank accounts.
  // Sudden Valley → JCSB x0626; EK Consulting → QuickBooks Checking; Mezzo → any.
  const [entityAccounts, monthlyRows, deposits] = await Promise.all([
    db.account.findMany({
      where: { entityId: entity.id, archivedAt: null },
      select: { id: true, nickname: true, mask: true },
      orderBy: { nickname: "asc" },
    }),
    db.$queryRaw<{ month: string; total: string }[]>`
      SELECT to_char(t."postedAt", 'YYYY-MM') AS month, SUM(t.amount)::text AS total
      FROM "Transaction" t
      WHERE t."entityId" = ${entity.id}
        AND t."archivedAt" IS NULL
        AND t."transferPairId" IS NULL
        AND t.amount > 0
        AND t."postedAt" >= ${twelveMonthsAgo}
      GROUP BY month
      ORDER BY month ASC
    `,
    db.transaction.findMany({
      where: {
        entityId: entity.id,
        archivedAt: null,
        transferPairId: null,
        amount: { gt: 0 },
        postedAt: { gte: twelveMonthsAgo },
      },
      include: { account: { select: { nickname: true, mask: true } } },
      orderBy: [{ postedAt: "desc" }, { id: "asc" }],
      take: 25,
    }),
  ]);

  const monthlyData = monthlyRows.map((r) => ({
    month: r.month,
    revenueDollars: Math.abs(parseFloat(r.total)),
  }));

  const totalRevenue = monthlyData.reduce((s, r) => s + r.revenueDollars, 0);

  // Table rows with MoM delta
  const tableRows = monthlyData.map((row, i) => {
    const prev = monthlyData[i - 1];
    const delta =
      prev && prev.revenueDollars > 0
        ? Math.round(((row.revenueDollars - prev.revenueDollars) / prev.revenueDollars) * 100)
        : null;
    return { ...row, delta };
  });

  const isSuddenValley = slug === "sudden-valley";

  const [rentalBookings, projectedRevenue] = await Promise.all([
    isSuddenValley
      ? db.rentalBooking.findMany({ where: { entityId: entity.id } })
      : Promise.resolve([]),
    db.projectedRevenue.findMany({
      where: { entityId: entity.id, archivedAt: null },
      orderBy: [{ expectedDate: "asc" }, { createdAt: "desc" }],
    }),
  ]);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">{entityLabel} — Revenue</h1>
          <p className="text-sm text-muted-foreground">
            Captured revenue from bank deposits (last 12 months)
            {isSuddenValley && " plus tentative reservation forecasts"}.
          </p>
        </div>

        {/* Captured monthly revenue chart */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Monthly captured revenue</CardTitle>
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
                No deposit transactions found for the last 12 months. Revenue appears here
                once bank deposits post
                {isSuddenValley
                  ? " to the JCSB account."
                  : entityAccounts.length > 0
                    ? ` to ${entityAccounts.map((a) => a.nickname).join(", ")}.`
                    : "."}
              </p>
            ) : (
              <RevenueBarChart data={monthlyData} />
            )}
          </CardContent>
        </Card>

        {/* Month table */}
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

        {/* Recent deposits (captured revenue detail) */}
        {deposits.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Recent deposits</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Date</th>
                      <th className="px-4 py-2 font-medium">Payee / source</th>
                      <th className="px-4 py-2 font-medium">Account</th>
                      <th className="px-4 py-2 font-medium text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deposits.map((t) => (
                      <tr key={t.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-4 py-2 text-muted-foreground">
                          {t.postedAt.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                            timeZone: "UTC",
                          })}
                        </td>
                        <td className="px-4 py-2 font-medium">
                          {t.payeeRaw ?? t.payeeNormalized ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {t.account.nickname}
                          {t.account.mask ? ` ···${t.account.mask}` : ""}
                        </td>
                        <td className="px-4 py-2 text-right font-medium text-green-600 tabular-nums">
                          +{fmtUSD(Math.abs(Number(t.amount)))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Sudden Valley: future reservations (tentative) */}
        {isSuddenValley && (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle className="text-base">Future reservations — forecasted revenue</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Tentative Airbnb reservations for {entityLabel}. Bookings can be modified or
                    cancelled — used for predictive purposes only. Captured revenue appears in
                    the transaction list once deposits post to the bank account.
                  </p>
                </div>
                <Link
                  href="/forecast?bucket=sudden-valley#rental-bookings"
                  className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Upload / manage CSV →
                </Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {rentalBookings.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No reservation bookings uploaded yet. Upload the Airbnb reservations CSV from
                  the Forecast page — the button above takes you straight to it.
                </p>
              ) : (
                <>
                  {(() => {
                    const today = new Date();
                    today.setUTCHours(0, 0, 0, 0);
                    const upcoming = rentalBookings.filter((b) => b.endDate >= today);
                    const byMonth = new Map<string, number>();
                    for (const b of upcoming) {
                      const key = b.payoutDate.toLocaleDateString("en-US", {
                        month: "long",
                        year: "numeric",
                        timeZone: "UTC",
                      });
                      byMonth.set(key, (byMonth.get(key) ?? 0) + Number(b.grossEarnings));
                    }
                    const totalUpcoming = upcoming.reduce(
                      (s, b) => s + Number(b.grossEarnings),
                      0
                    );
                    if (byMonth.size === 0) return null;
                    return (
                      <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Forecasted payout revenue by month
                        </p>
                        <div className="grid gap-1">
                          {Array.from(byMonth.entries()).map(([month, total]) => (
                            <div key={month} className="flex justify-between text-sm">
                              <span>{month}</span>
                              <span className="font-medium text-green-600">{fmtUSD(total)}</span>
                            </div>
                          ))}
                          <div className="flex justify-between text-sm font-semibold border-t pt-1.5 mt-0.5">
                            <span>Total upcoming (tentative)</span>
                            <span className="text-green-600">{fmtUSD(totalUpcoming)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="pb-2 font-medium">Guest</th>
                          <th className="pb-2 px-3 font-medium">Check-in</th>
                          <th className="pb-2 px-3 font-medium">Check-out</th>
                          <th className="pb-2 px-3 font-medium text-center">Nights</th>
                          <th className="pb-2 px-3 font-medium text-right">Gross earnings</th>
                          <th className="pb-2 px-3 font-medium text-right">Payout</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rentalBookings.slice(0, 10).map((b) => {
                          const isPast = b.endDate < new Date();
                          return (
                            <tr
                              key={b.id}
                              className={`border-b last:border-0 hover:bg-muted/30 ${isPast ? "opacity-50" : ""}`}
                            >
                              <td className="py-2 font-medium">{b.guest}</td>
                              <td className="py-2 px-3 text-muted-foreground">
                                {b.startDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                              </td>
                              <td className="py-2 px-3 text-muted-foreground">
                                {b.endDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                              </td>
                              <td className="py-2 px-3 text-center text-muted-foreground">{b.nights}</td>
                              <td className="py-2 px-3 text-right font-medium text-green-600">
                                {fmtUSD(Number(b.grossEarnings))}
                              </td>
                              <td className="py-2 px-3 text-right text-xs text-muted-foreground">
                                {b.payoutDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {rentalBookings.length > 10 && (
                    <p className="text-xs text-muted-foreground">
                      Showing 10 of {rentalBookings.length} reservations —{" "}
                      <Link href="/forecast?bucket=sudden-valley#rental-bookings" className="text-primary hover:underline">
                        view all on the Forecast page
                      </Link>
                      .
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Projected revenue (manual, forecast-only) */}
        <ProjectedRevenueCard
          entityId={entity.id}
          entityLabel={entityLabel}
          rows={projectedRevenue.map((r) => ({
            id: r.id,
            description: r.description,
            expectedDate: r.expectedDate.toISOString(),
            amountCents: r.amountCents,
            notes: r.notes,
            realizedAt: r.realizedAt?.toISOString() ?? null,
          }))}
        />

        <p className="text-xs text-muted-foreground">
          Captured revenue is read from deposit transactions on{" "}
          {entityAccounts.length > 0
            ? entityAccounts.map((a) => a.nickname).join(", ")
            : "this entity's bank accounts"}
          {isSuddenValley
            ? ". Future reservations are tentative — Airbnb bookings can be modified or cancelled, so treat forecast figures as estimates, not income."
            : ". Projected entries are forecasts only; nothing is booked until the deposit posts."}
        </p>
      </div>
    </AppShell>
  );
}