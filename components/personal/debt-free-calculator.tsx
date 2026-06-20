"use client";

import { useState, useMemo } from "react";
import { computeCCPayoff } from "@/lib/payoff-math";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface AccountOption {
  id: string;
  nickname: string;
  mask: string | null;
  currentBalanceStr: string | null;
}

interface DebtFreeCalculatorProps {
  accounts: AccountOption[];
}

const EXTRA_LABELS = ["$0 extra", "+$50/mo", "+$100/mo", "+$250/mo", "+$500/mo"];

export function DebtFreeCalculator({ accounts }: DebtFreeCalculatorProps) {
  const [selectedId, setSelectedId] = useState(accounts[0]?.id ?? "");
  const [balanceStr, setBalanceStr] = useState(accounts[0]?.currentBalanceStr ?? "");
  const [aprStr, setAprStr] = useState("24.99");
  const [paymentStr, setPaymentStr] = useState("");

  const selectedAccount = accounts.find((a) => a.id === selectedId);

  function onAccountChange(id: string) {
    setSelectedId(id);
    const acct = accounts.find((a) => a.id === id);
    setBalanceStr(acct?.currentBalanceStr ?? "");
  }

  const scenarios = useMemo(() => {
    const balance = Math.round(parseFloat(balanceStr || "0") * 100);
    const apr = parseFloat(aprStr || "0") / 100;
    const payment = Math.round(parseFloat(paymentStr || "0") * 100);

    if (balance <= 0 || apr <= 0 || payment <= 0) return null;
    return computeCCPayoff(balance, apr, payment);
  }, [balanceStr, aprStr, paymentStr]);

  const monthlyInterestCents = useMemo(() => {
    const balance = Math.round(parseFloat(balanceStr || "0") * 100);
    const apr = parseFloat(aprStr || "0") / 100;
    return balance > 0 && apr > 0 ? Math.round(balance * (apr / 12)) : 0;
  }, [balanceStr, aprStr]);

  function fmtUSD(cents: number) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }

  const baseScenario = scenarios?.[0];

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Debt-Free Calculator</h1>
        <p className="text-sm text-muted-foreground">
          See how extra payments accelerate your credit card payoff.
        </p>
      </div>

      {/* Inputs */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your card details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {accounts.length > 0 ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Credit card</label>
              <select
                value={selectedId}
                onChange={(e) => onAccountChange(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nickname}{a.mask ? ` ···${a.mask}` : ""}
                  </option>
                ))}
                <option value="">Manual entry</option>
              </select>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Current balance ($)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={balanceStr}
                onChange={(e) => setBalanceStr(e.target.value)}
                placeholder="3200.00"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">APR (%)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={aprStr}
                onChange={(e) => setAprStr(e.target.value)}
                placeholder="24.99"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Monthly payment ($)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={paymentStr}
                onChange={(e) => setPaymentStr(e.target.value)}
                placeholder="100.00"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {monthlyInterestCents > 0 && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              At this balance and APR, you&apos;re paying approximately <strong>{fmtUSD(monthlyInterestCents)}/month</strong> in interest.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Scenarios table */}
      {scenarios && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Payoff scenarios</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Scenario</th>
                  <th className="px-4 py-2 font-medium text-right">Monthly Payment</th>
                  <th className="px-4 py-2 font-medium text-right">Payoff Date</th>
                  <th className="px-4 py-2 font-medium text-right">Months</th>
                  <th className="px-4 py-2 font-medium text-right">Interest Saved</th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map((s, i) => {
                  const monthlyPayment = (Math.round(parseFloat(paymentStr) * 100) + s.extraMonthlyPaymentCents) / 100;
                  const interestSaved = (baseScenario?.totalInterestCents ?? 0) - s.totalInterestCents;
                  const isPastPayoff = s.monthsRemaining >= 600;

                  return (
                    <tr key={i} className={`border-b last:border-0 ${i === 0 ? "" : "bg-green-50/30"}`}>
                      <td className="px-4 py-2 font-medium">{EXTRA_LABELS[i]}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(monthlyPayment)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {isPastPayoff ? "Never" : fmtDate(s.payoffDate)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {isPastPayoff ? "∞" : s.monthsRemaining}
                      </td>
                      <td className={`px-4 py-2 text-right tabular-nums font-medium ${i > 0 ? "text-green-600" : "text-muted-foreground"}`}>
                        {i === 0 ? "—" : `+${fmtUSD(interestSaved)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        This is a projection based on the inputs above, not financial advice. Actual payoff will vary based
        on statement dates, fees, and rate changes. Confirm your APR on your credit card statement.
        {selectedAccount && " Balance pre-filled from the most recent account sync."}
      </p>
    </div>
  );
}
