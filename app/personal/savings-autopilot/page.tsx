import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getSavingsAutopilot } from "@/actions/savings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SaveTransferForm } from "@/components/personal/save-transfer-form";
import type { Route } from "next";

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export default async function SavingsAutopilotPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const { recommendation, savingsAccountFound, existingTransfer } =
    await getSavingsAutopilot();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Savings autopilot</h1>
          <p className="text-sm text-muted-foreground">
            Data-driven recommendation for your monthly transfer to savings (x3950).
          </p>
        </div>

        {!recommendation.hasEnoughData ? (
          <Card>
            <CardContent className="pt-5">
              <p className="text-sm text-muted-foreground">
                {recommendation.monthsOfData === 0
                  ? "No transaction data found. Connect accounts and import transactions to unlock this feature."
                  : `Only ${recommendation.monthsOfData} month of data found. Import at least 2 months of transactions to generate a recommendation.`}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Stat cards */}
            <div className="grid gap-4 sm:grid-cols-3">
              <Card>
                <CardContent className="pt-5">
                  <p className="text-2xl font-bold text-green-600">
                    {fmtMoney(recommendation.avgMonthlyIncomeCents)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Avg monthly income ({recommendation.monthsOfData} mo)
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <p className="text-2xl font-bold text-destructive">
                    {fmtMoney(recommendation.avgMonthlyExpensesCents)}
                  </p>
                  <p className="text-xs text-muted-foreground">Avg monthly expenses</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <p className={`text-2xl font-bold ${recommendation.avgMonthlySurplusCents >= 0 ? "text-green-600" : "text-destructive"}`}>
                    {fmtMoney(Math.abs(recommendation.avgMonthlySurplusCents))}
                    {recommendation.avgMonthlySurplusCents < 0 && " deficit"}
                  </p>
                  <p className="text-xs text-muted-foreground">Avg monthly surplus</p>
                </CardContent>
              </Card>
            </div>

            {recommendation.avgMonthlySurplusCents <= 0 ? (
              <Card className="border-amber-200 bg-amber-50">
                <CardContent className="pt-5">
                  <p className="text-sm font-medium text-amber-800">
                    Expenses currently exceed income — no savings transfer recommended until surplus turns positive.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Recommendation card */}
                <Card className="border-primary/30 bg-primary/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-primary">Recommendation</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm">
                      Based on your last {recommendation.monthsOfData} months, we suggest saving{" "}
                      <span className="text-xl font-bold text-primary">
                        {fmtMoney(recommendation.recommendedMonthlyCents)}/mo
                      </span>{" "}
                      — 20% of your avg surplus of {fmtMoney(recommendation.avgMonthlySurplusCents)}/mo.
                    </p>

                    {existingTransfer && (
                      <p className="text-xs text-muted-foreground">
                        Current transfer: {fmtMoney(existingTransfer.amountCents)}/mo from{" "}
                        {existingTransfer.fromNickname} → Savings
                      </p>
                    )}

                    {savingsAccountFound ? (
                      <SaveTransferForm
                        defaultAmountCents={recommendation.recommendedMonthlyCents}
                        existingAmountCents={existingTransfer?.amountCents ?? null}
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Savings account (x3950) not found — add it in{" "}
                        <a href="/accounts" className="text-primary hover:underline">Accounts</a>.
                      </p>
                    )}
                  </CardContent>
                </Card>

                <p className="text-xs text-muted-foreground">
                  This is a data-driven suggestion, not financial advice. Review and adjust before confirming.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
