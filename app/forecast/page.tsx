import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  generateTransferOccurrences,
  generateIncomeOccurrences,
  generateBillOccurrences,
  buildAccountForecast,
  findBreachDays,
} from "@/lib/forecast";
import { formatUSD, decimalToNumber } from "@/lib/utils";
import { Prisma } from "@prisma/client";
import { setAccountBalance, upsertIncomeSource } from "@/actions/envelope";
import { ForecastAccountCard, type ChartPoint } from "@/components/forecast/forecast-account-card";
import { listRecurringExpenses } from "@/actions/recurring-expenses";
import { listRentalBookings } from "@/actions/rental-bookings";
import { RecurringExpensesSection } from "@/components/forecast/recurring-expenses-section";
import { RentalBookingsSection } from "@/components/forecast/rental-bookings-section";

interface PageProps {
  searchParams: Promise<{ bucket?: string }>;
}

export default async function ForecastPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = params.bucket ?? "personal";
  const entity = await getEntityBySlug(bucket);

  const now = new Date();
  const forecastStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const forecastEnd90 = new Date(forecastStart.getTime() + 90 * 86400000);
  const forecastEnd14 = new Date(forecastStart.getTime() + 14 * 86400000);

  // Load checking accounts with a minimum balance rule, filtered to the active bucket's entity
  const tdAccounts = await db.account.findMany({
    where: {
      archivedAt: null,
      accountType: "checking",
      minimumBalance: { not: null },
      ...(entity && { entityId: entity.id }),
    },
    include: { institution: true },
    orderBy: { nickname: "asc" },
  });

  // Load all active scheduled transfers, income sources, and bills
  const [transfers, incomeSources, scheduledBills] = await Promise.all([
    db.scheduledTransfer.findMany({
      where: { active: true },
      include: { fromAccount: true, toAccount: true },
    }),
    db.incomeSource.findMany({
      where: { active: true },
      include: { account: true, entity: true },
    }),
    db.scheduledBill.findMany({ where: { active: true, budgetTagId: { not: null } } }),
  ]);

  // Load entities for the income source form
  const entities = await db.entity.findMany({
    where: { archivedAt: null },
    orderBy: { name: "asc" },
  });

  // Load recurring expenses and rental bookings (filtered to entity if selected)
  const [recurringExpenses, allTags, rentalBookings] = await Promise.all([
    listRecurringExpenses(entity?.id),
    db.tag.findMany({ orderBy: { name: "asc" } }),
    entity ? listRentalBookings(entity.id) : Promise.resolve([]),
  ]);

  // Build 90-day forecast for each TD checking account
  const accountForecasts = tdAccounts.map((acct) => {
    const startBal = acct.currentBalance
      ? new Prisma.Decimal(acct.currentBalance)
      : new Prisma.Decimal(0);
    const minBal = acct.minimumBalance
      ? new Prisma.Decimal(acct.minimumBalance)
      : null;

    // Gather events for this account over 90 days
    const transferEvents = transfers.flatMap((t) =>
      generateTransferOccurrences(t, forecastStart, forecastEnd90)
    ).filter((e) => e.accountId === acct.id);

    const incomeEvents = incomeSources.flatMap((s) =>
      generateIncomeOccurrences(s, forecastStart, forecastEnd90)
    ).filter((e) => e.accountId === acct.id);

    const billEvents = scheduledBills.flatMap((b) =>
      generateBillOccurrences(b, forecastStart, forecastEnd90)
    ).filter((e) => e.accountId === acct.id);

    const allEvents = [...transferEvents, ...incomeEvents, ...billEvents];
    const forecast = buildAccountForecast(startBal, allEvents, minBal, forecastStart, forecastEnd90);
    const breaches = findBreachDays(forecast);

    // Full 90-day chart data (client component slices to 30/60/90)
    const chartData90: ChartPoint[] = forecast.map((day) => ({
      label: day.date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      balance: day.balanceAfter.toNumber(),
      isBreachDay: day.isBreachDay,
    }));

    return { acct, forecast, breaches, chartData90, startBal, minBal };
  });

  // 14-day schedule for Primary Checking
  const primaryAcct = tdAccounts.find((a) => a.nickname === "Primary Checking");
  const schedule14: { date: string; description: string; amount: number; type: string }[] = [];

  if (primaryAcct) {
    const xferEvents = transfers.flatMap((t) =>
      generateTransferOccurrences(t, forecastStart, forecastEnd14)
    ).filter((e) => e.accountId === primaryAcct.id);

    const incEvents = incomeSources.flatMap((s) =>
      generateIncomeOccurrences(s, forecastStart, forecastEnd14)
    ).filter((e) => e.accountId === primaryAcct.id);

    const billEventsForSchedule = scheduledBills.flatMap((b) =>
      generateBillOccurrences(b, forecastStart, forecastEnd14)
    ).filter((e) => e.accountId === primaryAcct.id);

    for (const ev of [...xferEvents, ...incEvents, ...billEventsForSchedule].sort((a, b) => a.date.getTime() - b.date.getTime())) {
      schedule14.push({
        date: ev.date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }),
        description: ev.description,
        amount: ev.amount.toNumber(),
        type: ev.type,
      });
    }
  }

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Cash Flow Forecast</h1>
          <p className="text-sm text-muted-foreground">
            30-day projection based on scheduled transfers, bills, and income
          </p>
        </div>

        {/* ── Balance panel ────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Current Balances</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {tdAccounts.map((acct) => {
                const isPlaid = acct.integrationMode === "plaid";
                const balanceNum = acct.currentBalance
                  ? decimalToNumber(new Prisma.Decimal(acct.currentBalance))
                  : null;
                const asOf = acct.currentBalanceAt
                  ? new Date(acct.currentBalanceAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                  : null;

                return isPlaid ? (
                  <div key={acct.id} className="space-y-1">
                    <p className="text-xs font-medium">
                      {acct.nickname}{acct.mask ? ` ···${acct.mask}` : ""}
                    </p>
                    <p className="text-base font-semibold tabular-nums">
                      {balanceNum !== null ? formatUSD(balanceNum) : <span className="text-muted-foreground">—</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {asOf ? `Synced ${asOf}` : "Not yet synced"}
                      {" · "}
                      <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">Auto</span>
                    </p>
                  </div>
                ) : (
                  <form
                    key={acct.id}
                    action={async (formData: FormData) => {
                      "use server";
                      await setAccountBalance(acct.id, formData.get("balance") as string);
                    }}
                    className="space-y-1"
                  >
                    <label className="text-xs font-medium">
                      {acct.nickname}{acct.mask ? ` ···${acct.mask}` : ""}
                    </label>
                    <div className="flex gap-1">
                      <input
                        name="balance"
                        type="number"
                        step="0.01"
                        defaultValue={balanceNum !== null ? balanceNum.toFixed(2) : ""}
                        placeholder="0.00"
                        className="w-28 rounded border px-2 py-1 text-sm"
                      />
                      <button type="submit" className="text-xs text-primary hover:underline">
                        Set
                      </button>
                    </div>
                    {asOf && <p className="text-xs text-muted-foreground">As of {asOf}</p>}
                  </form>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* ── Breach warnings ──────────────────────────────────────────── */}
        {accountForecasts.some((af) => af.breaches.length > 0) && (
          <div className="space-y-2">
            <h2 className="text-base font-semibold text-destructive">⚠ Projected Minimum Balance Breaches</h2>
            <p className="text-xs text-muted-foreground">
              TD Bank accounts must stay ≥ $250 at all times. A dip below triggers a $15 service fee.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {accountForecasts
                .filter((af) => af.breaches.length > 0)
                .map(({ acct, breaches, minBal }) => (
                  <Card key={acct.id} className="border-destructive/50 bg-destructive/5">
                    <CardContent className="pt-4">
                      <p className="font-medium text-destructive">
                        {acct.nickname} ···{acct.mask}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {breaches.length} day{breaches.length !== 1 ? "s" : ""} projected below ${minBal?.toNumber() ?? 250}
                      </p>
                      <p className="text-sm">
                        First breach:{" "}
                        <span className="font-medium text-destructive">
                          {breaches[0]!.date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                        </span>
                        {" "}— projected balance{" "}
                        <span className="font-medium text-destructive">
                          {formatUSD(breaches[0]!.balanceAfter.toNumber())}
                        </span>
                      </p>
                    </CardContent>
                  </Card>
                ))}
            </div>
          </div>
        )}

        {/* ── Per-account balance charts (30/60/90 day selectable) ───── */}
        <div className="grid gap-6 lg:grid-cols-2">
          {accountForecasts.map(({ acct, chartData90, minBal }) => (
            <ForecastAccountCard
              key={acct.id}
              accountName={acct.nickname}
              mask={acct.mask}
              minimumBalance={minBal?.toNumber() ?? null}
              currentBalance={acct.currentBalance ? Number(acct.currentBalance) : null}
              chartData90={chartData90}
            />
          ))}
        </div>

        {/* ── 14-day schedule for Primary Checking ────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Next 14 Days — Primary Checking</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {schedule14.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                No scheduled events in the next 14 days
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium text-right">Amount</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule14.map((ev, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2 text-muted-foreground">{ev.date}</td>
                      <td className="px-4 py-2">{ev.description}</td>
                      <td className={`px-4 py-2 text-right font-mono font-medium ${ev.amount < 0 ? "text-destructive" : "text-green-600"}`}>
                        {ev.amount < 0 ? "-" : "+"}
                        {formatUSD(Math.abs(ev.amount))}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-xs">
                          {ev.type.replace("_", " ")}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* ── Recurring expenses ───────────────────────────────────────── */}
        <RecurringExpensesSection
          expenses={recurringExpenses.map((e) => ({
            ...e,
            nextDueDate: e.nextDueDate ? new Date(e.nextDueDate) : null,
            tag: e.tag ?? null,
          }))}
          entities={entities.map((e) => ({ id: e.id, name: e.name }))}
          tags={allTags.map((t) => ({ id: t.id, name: t.name, shortName: t.shortName }))}
          defaultEntityId={entity?.id ?? entities[0]?.id ?? ""}
        />

        {/* ── Rental bookings ──────────────────────────────────────────── */}
        {entity && (
          <RentalBookingsSection
            entityId={entity.id}
            entityName={entity.name}
            bookings={rentalBookings.map((b) => ({
              ...b,
              startDate: new Date(b.startDate),
              endDate: new Date(b.endDate),
              payoutDate: new Date(b.payoutDate),
            }))}
          />
        )}

        {/* ── Income sources ────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Income Sources</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {incomeSources.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-0 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium">Cadence</th>
                    <th className="px-4 py-2 font-medium text-right">Amount</th>
                    <th className="px-4 py-2 font-medium">Account</th>
                  </tr>
                </thead>
                <tbody>
                  {incomeSources.map((s) => {
                    const rules = s.dayRules as Record<string, unknown>;
                    let cadenceLabel = s.cadence;
                    if (s.cadence === "semi_monthly") {
                      const days = rules["daysOfMonth"] as number[] | undefined;
                      cadenceLabel = `Semi-monthly (${days?.join(" & ")})`;
                    } else if (s.cadence === "biweekly") {
                      cadenceLabel = "Biweekly";
                    }
                    return (
                      <tr key={s.id} className="border-b last:border-0">
                        <td className="px-0 py-2 font-medium">{s.description}</td>
                        <td className="px-4 py-2 text-muted-foreground">{cadenceLabel}</td>
                        <td className="px-4 py-2 text-right text-green-600 font-medium">
                          +{formatUSD(decimalToNumber(new Prisma.Decimal(s.amount)))}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {s.account.nickname} ···{s.account.mask}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* Add income source form */}
            <div className="border-t pt-4">
              <p className="mb-3 text-sm font-medium">Add income source</p>
              <form
                action={async (formData: FormData) => {
                  "use server";
                  const cadence = formData.get("cadence") as string;
                  let dayRules: Record<string, unknown>;
                  if (cadence === "semi_monthly") {
                    dayRules = { daysOfMonth: [15, 30] };
                  } else if (cadence === "biweekly") {
                    const anchor = formData.get("anchorDate") as string;
                    dayRules = { intervalDays: 14, anchorDate: anchor };
                  } else {
                    dayRules = { daysOfMonth: [1] };
                  }
                  await upsertIncomeSource({
                    entityId: formData.get("entityId") as string,
                    accountId: formData.get("accountId") as string,
                    description: formData.get("description") as string,
                    cadence: cadence as "semi_monthly" | "biweekly" | "monthly" | "weekly",
                    dayRules,
                    amount: formData.get("amount") as string,
                    active: true,
                  });
                }}
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              >
                <div className="space-y-1">
                  <label className="text-xs font-medium">Description</label>
                  <input
                    name="description"
                    placeholder="e.g. Eric payroll"
                    className="w-full rounded border px-2 py-1.5 text-sm"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Cadence</label>
                  <select name="cadence" className="w-full rounded border px-2 py-1.5 text-sm" required>
                    <option value="semi_monthly">Semi-monthly (15th & 30th)</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Amount</label>
                  <input
                    name="amount"
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    className="w-full rounded border px-2 py-1.5 text-sm"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">First paycheck date (biweekly only)</label>
                  <input
                    name="anchorDate"
                    type="date"
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Entity</label>
                  <select name="entityId" className="w-full rounded border px-2 py-1.5 text-sm" required>
                    {entities.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Deposits into</label>
                  <select name="accountId" className="w-full rounded border px-2 py-1.5 text-sm" required>
                    {tdAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.nickname} ···{a.mask}</option>
                    ))}
                  </select>
                </div>
                <div className="lg:col-span-3">
                  <button
                    type="submit"
                    className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Add Income Source
                  </button>
                </div>
              </form>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
