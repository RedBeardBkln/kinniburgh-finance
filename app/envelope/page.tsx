import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getEnvelopeSummary, getEnvelopeForecastData, approveSlushFundsTransfer, updateAccrualBalance } from "@/actions/envelope";
import { formatUSD, decimalToNumber } from "@/lib/utils";
import { Prisma } from "@prisma/client";
import { ScheduledTransfersClient, type SerializedTransfer } from "@/components/envelope/scheduled-transfers-client";
import { db } from "@/lib/db";
import { type BucketSlug } from "@/lib/buckets";

interface PageProps {
  searchParams: Promise<{ bucket?: string }>;
}

export default async function EnvelopePage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = (params.bucket ?? "personal") as BucketSlug;

  const [
    { transfers, bills, accruals, slushTransferExists },
    forecastData,
    allAccounts,
  ] = await Promise.all([
    getEnvelopeSummary(bucket),
    getEnvelopeForecastData(bucket),
    db.account.findMany({
      where: { archivedAt: null },
      select: { id: true, nickname: true, mask: true },
      orderBy: { nickname: "asc" },
    }),
  ]);

  const serializedTransfers: SerializedTransfer[] = transfers.map((t) => ({
    id: t.id,
    fromAccountId: t.fromAccountId,
    fromNickname: t.fromAccount.nickname,
    fromMask: t.fromAccount.mask,
    toAccountId: t.toAccountId,
    toNickname: t.toAccount.nickname,
    toMask: t.toAccount.mask,
    amount: t.amount.toString(),
    cadence: t.cadence,
    dayRules: t.dayRules as Record<string, unknown>,
    purpose: t.purpose,
    active: t.active,
  }));

  // Group bills by account
  const billsByAccount = new Map<string, typeof bills>();
  for (const bill of bills) {
    const key = bill.account.nickname;
    if (!billsByAccount.has(key)) billsByAccount.set(key, []);
    billsByAccount.get(key)!.push(bill);
  }

  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Envelopes</h1>
          <p className="text-sm text-muted-foreground">
            Scheduled transfers, bills, and accrual envelopes
          </p>
        </div>

        {/* ── Scheduled transfers (CRUD) ───────────────────────────────── */}
        <ScheduledTransfersClient transfers={serializedTransfers} accounts={allAccounts} />

        {/* ── Slush Funds proposal (shown only if transfer not yet created) ── */}
        {!slushTransferExists && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span>Proposed: Slush Funds Transfer</span>
                <Badge variant="outline" className="text-amber-700 border-amber-300">
                  Pending your approval
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Your Slush Funds account (x3612) has $1,200/mo of Home Improvements + Home Repair budget
                but no funding transfer. The app recommends a weekly transfer to cover this.
              </p>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">Proposed:</span>
                <span>$277/week from Primary Checking → Slush Funds (≈ $1,200/mo)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                This transfer will only be created after you approve it below. You can adjust the
                amount and day before approving.
              </p>
              <form
                action={async (formData: FormData) => {
                  "use server";
                  const amount = formData.get("amount") as string;
                  const dayOfWeek = parseInt(formData.get("dayOfWeek") as string, 10);
                  await approveSlushFundsTransfer({ amount, dayOfWeek });
                }}
                className="flex items-center gap-3 pt-1"
              >
                <label className="flex items-center gap-1.5 text-sm">
                  Amount $
                  <input
                    name="amount"
                    type="number"
                    step="0.01"
                    defaultValue="277.00"
                    className="w-24 rounded border px-2 py-1 text-sm"
                    required
                  />
                  /week
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  Day
                  <select name="dayOfWeek" defaultValue="1" className="rounded border px-2 py-1 text-sm">
                    {DAY_NAMES.map((name, i) => (
                      <option key={i} value={i}>{name}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Approve Transfer
                </button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* ── Savings recommendation placeholder ──────────────────────── */}
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-muted-foreground">Savings Transfer</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Available after 2–3 months of linked transaction data. The app will analyze
              your actual cash-flow surplus and propose an affordable "pay yourself first"
              recurring transfer to Savings (x3950) for your approval.
            </p>
          </CardContent>
        </Card>

        {/* ── Scheduled bills by account ──────────────────────────────── */}
        <div>
          <h2 className="mb-3 text-lg font-semibold">Scheduled Bills</h2>
          <div className="space-y-4">
            {[...billsByAccount.entries()].map(([accountName, accountBills]) => (
              <Card key={accountName}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{accountName}</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-4 py-2 font-medium">Payee</th>
                        <th className="px-4 py-2 font-medium">Type</th>
                        <th className="px-4 py-2 font-medium text-right">Expected</th>
                        <th className="px-4 py-2 font-medium">Autopay day</th>
                        <th className="px-4 py-2 font-medium">Annual budget</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accountBills.map((bill) => (
                        <tr key={bill.id} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-4 py-2 font-medium">{bill.payee}</td>
                          <td className="px-4 py-2">
                            <Badge
                              variant="outline"
                              className={`text-xs ${
                                bill.amountType === "accrued"
                                  ? "border-blue-300 text-blue-700"
                                  : bill.amountType === "fluctuating"
                                  ? "border-amber-300 text-amber-700"
                                  : ""
                              }`}
                            >
                              {bill.amountType}
                            </Badge>
                          </td>
                          <td className="px-4 py-2 text-right">
                            {bill.expectedAmount
                              ? formatUSD(decimalToNumber(new Prisma.Decimal(bill.expectedAmount)))
                              : "—"}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {bill.autopayDay ? `${bill.autopayDay}th` : "—"}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {bill.annualBudget
                              ? formatUSD(decimalToNumber(new Prisma.Decimal(bill.annualBudget)))
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* ── Envelope Solvency Forecast ──────────────────────────────── */}
        {forecastData.length > 0 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold">Envelope Solvency</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              30-day balance projection for each envelope account. Set balances on the Forecast page to enable.
            </p>
            <div className="space-y-4">
              {forecastData.map((env) => (
                <Card key={env.accountId} className={env.breachDays > 0 ? "border-amber-300" : ""}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-base">
                      <span>
                        {env.accountName}{" "}
                        <span className="font-mono text-sm text-muted-foreground">···{env.mask}</span>
                      </span>
                      {env.currentBalance !== null ? (
                        <Badge variant={env.breachDays > 0 ? "destructive" : "default"}>
                          {env.breachDays > 0 ? `⚠ ${env.breachDays} breach day${env.breachDays === 1 ? "" : "s"}` : "✓ Solvent"}
                        </Badge>
                      ) : (
                        <Badge variant="outline">Balance not set</Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {env.currentBalance !== null && (
                      <>
                        <div className="text-muted-foreground">
                          Current balance:{" "}
                          <strong className="text-foreground">{formatUSD(env.currentBalance)}</strong>
                        </div>

                        {env.breachDays > 0 && (
                          <div className="space-y-2">
                            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                              Lowest projected balance:{" "}
                              <strong>{formatUSD(env.worstBalance!)}</strong>
                              {env.firstBreachDate &&
                                ` on ${new Date(env.firstBreachDate + "T00:00:00Z").toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                  timeZone: "UTC",
                                })}`}
                            </div>
                            {env.suggestedIncrease !== null && (
                              <div className="text-muted-foreground">
                                Suggested fix: increase the{" "}
                                <strong>
                                  {env.incomingTransferCadence === "weekly"
                                    ? "weekly"
                                    : env.incomingTransferCadence === "semi_monthly"
                                    ? "semi-monthly"
                                    : env.incomingTransferCadence ?? "recurring"}{" "}
                                  transfer
                                </strong>{" "}
                                by{" "}
                                <strong className="text-foreground">
                                  +{formatUSD(env.suggestedIncrease)}
                                </strong>{" "}
                                per occurrence
                              </div>
                            )}
                            {env.feeAppliedThisPeriod ? (
                              <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-blue-800">
                                $15 TD Bank minimum balance fee has been recorded this period.
                              </div>
                            ) : (
                              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                                A <strong>$15 TD Bank fee</strong> will apply if the actual balance
                                dips below ${env.minimumBalance} this month.
                              </div>
                            )}
                          </div>
                        )}

                        {env.billsThisMonth.length > 0 && (
                          <table className="w-full text-xs text-muted-foreground">
                            <thead>
                              <tr className="border-b">
                                <th className="pb-1 text-left font-medium">Bill</th>
                                <th className="pb-1 text-left font-medium">Due</th>
                                <th className="pb-1 text-right font-medium">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {env.billsThisMonth.map((b, i) => (
                                <tr key={i} className="border-b last:border-0">
                                  <td className="py-1">{b.payee}</td>
                                  <td className="py-1">{b.dueDay ? `${b.dueDay}th` : "accrued"}</td>
                                  <td className="py-1 text-right">
                                    {b.expectedAmount ? formatUSD(b.expectedAmount) : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* ── Accrual envelopes ────────────────────────────────────────── */}
        <div>
          <h2 className="mb-3 text-lg font-semibold">Accrual Envelopes</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {accruals.map((env) => {
              const target = new Prisma.Decimal(env.targetAnnualAmount);
              const funded = new Prisma.Decimal(env.currentBalance);
              const monthlyRate = target.div(12);
              const pct = target.isZero()
                ? 0
                : Math.min(funded.div(target).times(100).toNumber(), 100);
              const drawMonths = env.expectedDrawMonths as number[];
              const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

              return (
                <Card key={env.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-base">
                      {env.name}
                      <span className="text-sm font-normal text-muted-foreground">
                        {env.account.nickname}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Funded</span>
                      <span className="font-medium">
                        {formatUSD(decimalToNumber(funded))} / {formatUSD(decimalToNumber(target))}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-blue-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{Math.round(pct)}% funded</span>
                      <span>{formatUSD(decimalToNumber(monthlyRate))}/mo accrual</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium">Draw months: </span>
                      {drawMonths.map((m) => MONTH_NAMES[m - 1]).join(", ")}
                    </div>
                    {/* Manual balance update form */}
                    <form
                      action={async (formData: FormData) => {
                        "use server";
                        const bal = formData.get("balance") as string;
                        await updateAccrualBalance(env.id, bal);
                      }}
                      className="flex items-center gap-2 pt-1"
                    >
                      <input
                        name="balance"
                        type="number"
                        step="0.01"
                        defaultValue={decimalToNumber(funded).toFixed(2)}
                        className="w-28 rounded border px-2 py-1 text-xs"
                        placeholder="Balance"
                      />
                      <button type="submit" className="text-xs text-primary hover:underline">
                        Update balance
                      </button>
                    </form>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
