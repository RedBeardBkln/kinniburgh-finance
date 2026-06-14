import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getEnvelopeSummary, approveSlushFundsTransfer, updateScheduledTransfer, updateAccrualBalance } from "@/actions/envelope";
import { formatUSD, decimalToNumber } from "@/lib/utils";
import { Prisma } from "@prisma/client";

export default async function EnvelopePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const {
    transfers,
    bills,
    accruals,
    slushTransferExists,
  } = await getEnvelopeSummary();

  // Group bills by account
  const billsByAccount = new Map<string, typeof bills>();
  for (const bill of bills) {
    const key = bill.account.nickname;
    if (!billsByAccount.has(key)) billsByAccount.set(key, []);
    billsByAccount.get(key)!.push(bill);
  }

  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function cadenceLabel(cadence: string, dayRules: unknown): string {
    const rules = dayRules as Record<string, unknown>;
    if (cadence === "weekly") {
      const dow = typeof rules["dayOfWeek"] === "number" ? rules["dayOfWeek"] : 1;
      return `Weekly (${DAY_NAMES[dow]})`;
    }
    if (cadence === "semi_monthly") {
      const days = Array.isArray(rules["daysOfMonth"]) ? rules["daysOfMonth"] : [1, 15];
      return `Semi-monthly (${(days as number[]).join("th & ")}th)`;
    }
    if (cadence === "monthly") return "Monthly";
    return cadence;
  }

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Envelopes</h1>
          <p className="text-sm text-muted-foreground">
            Scheduled transfers, bills, and accrual envelopes
          </p>
        </div>

        {/* ── Confirmed scheduled transfers ───────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Scheduled Transfers</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">From</th>
                  <th className="px-4 py-2 font-medium">To</th>
                  <th className="px-4 py-2 font-medium">Amount</th>
                  <th className="px-4 py-2 font-medium">Cadence</th>
                  <th className="px-4 py-2 font-medium">Purpose</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.id} className={`border-b last:border-0 hover:bg-muted/30 ${!t.active ? "opacity-50" : ""}`}>
                    <td className="px-4 py-2">
                      <span className="font-medium">{t.fromAccount.nickname}</span>
                      <span className="ml-1 font-mono text-xs text-muted-foreground">···{t.fromAccount.mask}</span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="font-medium">{t.toAccount.nickname}</span>
                      <span className="ml-1 font-mono text-xs text-muted-foreground">···{t.toAccount.mask}</span>
                    </td>
                    <td className="px-4 py-2 font-medium">
                      {formatUSD(decimalToNumber(new Prisma.Decimal(t.amount)))}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {cadenceLabel(t.cadence, t.dayRules)}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {t.purpose ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={t.active ? "default" : "outline"}>
                        {t.active ? "Active" : "Paused"}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <form
                        action={async () => {
                          "use server";
                          await updateScheduledTransfer({ id: t.id, active: !t.active });
                        }}
                      >
                        <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">
                          {t.active ? "Pause" : "Resume"}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

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
