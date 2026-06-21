"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { computePayoffScenarios } from "@/lib/payoff-math";

const EXTRA_LABELS = ["Current payment", "+$100/mo", "+$200/mo", "+$500/mo", "+$1,000/mo"];

function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatMonths(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}mo`;
  if (m === 0) return `${y}yr`;
  return `${y}yr ${m}mo`;
}

export function MortgageClient() {
  const [principal, setPrincipal] = useState("300000");
  const [rate, setRate] = useState("6.75");
  const [term, setTerm] = useState("360");
  const [payment, setPayment] = useState("1946");

  const principalCents = Math.round(parseFloat(principal || "0") * 100);
  const annualRate = parseFloat(rate || "0") / 100;
  const termMonths = parseInt(term || "0", 10);
  const paymentCents = Math.round(parseFloat(payment || "0") * 100);

  const scenarios =
    principalCents > 0 && annualRate > 0 && termMonths > 0 && paymentCents > 0
      ? computePayoffScenarios(principalCents, annualRate, termMonths, paymentCents)
      : null;

  const baselineMonths = scenarios?.[0]?.monthsRemaining ?? 0;
  const goalMonths = 12 * 12; // 12-year goal per spec
  const goalPaymentCents = scenarios
    ? (() => {
        // Approximate required extra payment for 12-year payoff via binary search
        const r = annualRate / 12;
        const n = goalMonths;
        const needed = Math.ceil(principalCents * r / (1 - Math.pow(1 + r, -n)));
        return needed;
      })()
    : 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold">Mortgage Payoff Simulator</h1>
        <p className="text-sm text-muted-foreground">
          Model extra payment scenarios. Values pre-filled from your latest mortgage statement if parsed; edit as needed.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Loan details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { label: "Current principal balance ($)", value: principal, set: setPrincipal, placeholder: "300000" },
              { label: "Annual interest rate (%)", value: rate, set: setRate, placeholder: "6.75" },
              { label: "Remaining term (months)", value: term, set: setTerm, placeholder: "360" },
              { label: "Current monthly payment ($)", value: payment, set: setPayment, placeholder: "1946" },
            ].map(({ label, value, set, placeholder }) => (
              <div key={label} className="space-y-1">
                <label className="text-sm font-medium">{label}</label>
                <input
                  type="number"
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  placeholder={placeholder}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {scenarios && (
        <>
          {goalPaymentCents > paymentCents && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              12-year payoff goal requires a monthly payment of{" "}
              <strong>{formatMoney(goalPaymentCents)}</strong>{" "}
              (+{formatMoney(goalPaymentCents - paymentCents)}/mo extra).
            </div>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Extra payment scenarios</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Scenario</th>
                      <th className="pb-2 pr-4 font-medium">Monthly payment</th>
                      <th className="pb-2 pr-4 font-medium">Time to payoff</th>
                      <th className="pb-2 pr-4 font-medium">Months saved</th>
                      <th className="pb-2 font-medium">Interest saved</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {scenarios.map((s, i) => (
                      <tr key={i} className={i === 0 ? "text-muted-foreground" : ""}>
                        <td className="py-2 pr-4 font-medium">{EXTRA_LABELS[i]}</td>
                        <td className="py-2 pr-4">{formatMoney(paymentCents + s.extraMonthlyPaymentCents)}</td>
                        <td className="py-2 pr-4">{formatMonths(s.monthsRemaining)}</td>
                        <td className="py-2 pr-4">
                          {i === 0 ? "—" : (
                            <span className="text-green-600">
                              -{formatMonths(baselineMonths - s.monthsRemaining)}
                            </span>
                          )}
                        </td>
                        <td className="py-2">
                          {i === 0 ? (
                            formatMoney(s.totalInterestCents)
                          ) : (
                            <span className="text-green-600">
                              -{formatMoney((scenarios[0]?.totalInterestCents ?? 0) - s.totalInterestCents)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Payoff dates: {scenarios.map((s, i) => `${EXTRA_LABELS[i]}: ${s.payoffDate}`).join(" · ")}
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
