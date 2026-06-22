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

function InputRow({ label, value, set, placeholder }: { label: string; value: string; set: (v: string) => void; placeholder: string }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
    </div>
  );
}

export function MortgageClient() {
  const [principal, setPrincipal] = useState("300000");
  const [rate, setRate] = useState("6.75");
  const [term, setTerm] = useState("360");
  const [piPayment, setPiPayment] = useState("1946");
  const [propertyTaxes, setPropertyTaxes] = useState("");
  const [pmi, setPmi] = useState("");
  const [propertyInsurance, setPropertyInsurance] = useState("");

  const principalCents = Math.round(parseFloat(principal || "0") * 100);
  const annualRate = parseFloat(rate || "0") / 100;
  const termMonths = parseInt(term || "0", 10);
  const piCents = Math.round(parseFloat(piPayment || "0") * 100);
  const taxesCents = Math.round(parseFloat(propertyTaxes || "0") * 100);
  const pmiCents = Math.round(parseFloat(pmi || "0") * 100);
  const insuranceCents = Math.round(parseFloat(propertyInsurance || "0") * 100);
  const escrowCents = taxesCents + pmiCents + insuranceCents;
  const totalMonthlyCents = piCents + escrowCents;

  // Payoff scenarios: extra above total obligation goes to principal only
  const scenarios =
    principalCents > 0 && annualRate > 0 && termMonths > 0 && piCents > 0
      ? computePayoffScenarios(principalCents, annualRate, termMonths, piCents)
      : null;

  const baselineMonths = scenarios?.[0]?.monthsRemaining ?? 0;
  const goalMonths = 12 * 12;
  const goalPaymentCents = scenarios
    ? (() => {
        const r = annualRate / 12;
        const n = goalMonths;
        const needed = Math.ceil(principalCents * r / (1 - Math.pow(1 + r, -n)));
        return needed + escrowCents;
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

      {/* Loan details */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Loan details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <InputRow label="Current principal balance ($)" value={principal} set={setPrincipal} placeholder="300000" />
            <InputRow label="Annual interest rate (%)" value={rate} set={setRate} placeholder="6.75" />
            <InputRow label="Remaining term (months)" value={term} set={setTerm} placeholder="360" />
            <InputRow label="P&I payment ($/mo)" value={piPayment} set={setPiPayment} placeholder="1946" />
          </div>
        </CardContent>
      </Card>

      {/* Escrow / monthly additions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Monthly escrow &amp; fees</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <InputRow label="Property taxes ($/mo)" value={propertyTaxes} set={setPropertyTaxes} placeholder="0.00" />
            <InputRow label="PMI ($/mo)" value={pmi} set={setPmi} placeholder="0.00" />
            <InputRow label="Homeowner's insurance ($/mo)" value={propertyInsurance} set={setPropertyInsurance} placeholder="0.00" />
          </div>

          {/* Payment breakdown summary */}
          {totalMonthlyCents > 0 && (
            <div className="rounded-md border bg-muted/30 p-4 text-sm">
              <p className="mb-2 font-medium">Monthly payment breakdown</p>
              <div className="space-y-1 text-muted-foreground">
                <div className="flex justify-between">
                  <span>Principal &amp; Interest</span>
                  <span className="tabular-nums">{formatMoney(piCents)}</span>
                </div>
                {taxesCents > 0 && (
                  <div className="flex justify-between">
                    <span>Property taxes</span>
                    <span className="tabular-nums">{formatMoney(taxesCents)}</span>
                  </div>
                )}
                {pmiCents > 0 && (
                  <div className="flex justify-between">
                    <span>PMI</span>
                    <span className="tabular-nums">{formatMoney(pmiCents)}</span>
                  </div>
                )}
                {insuranceCents > 0 && (
                  <div className="flex justify-between">
                    <span>Homeowner's insurance</span>
                    <span className="tabular-nums">{formatMoney(insuranceCents)}</span>
                  </div>
                )}
                <div className="flex justify-between border-t pt-1 font-semibold text-foreground">
                  <span>Total monthly due</span>
                  <span className="tabular-nums">{formatMoney(totalMonthlyCents)}</span>
                </div>
              </div>
              {escrowCents > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Any payment above {formatMoney(totalMonthlyCents)} is applied entirely to the principal balance.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {scenarios && (
        <>
          {goalPaymentCents > totalMonthlyCents && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              12-year payoff goal requires a total monthly payment of{" "}
              <strong>{formatMoney(goalPaymentCents)}</strong>
              {escrowCents > 0 && (
                <> (P&amp;I: {formatMoney(goalPaymentCents - escrowCents)} + escrow: {formatMoney(escrowCents)})</>
              )}
              {" "}(+{formatMoney(goalPaymentCents - totalMonthlyCents)}/mo extra above current total).
            </div>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Extra payment scenarios</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">
                Extra amounts are above total monthly due ({formatMoney(totalMonthlyCents > 0 ? totalMonthlyCents : piCents)}) and applied entirely to principal.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Extra</th>
                      <th className="pb-2 pr-4 font-medium">Total monthly</th>
                      <th className="pb-2 pr-4 font-medium">Time to payoff</th>
                      <th className="pb-2 pr-4 font-medium">Months saved</th>
                      <th className="pb-2 font-medium">Interest saved</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {scenarios.map((s, i) => (
                      <tr key={i} className={i === 0 ? "text-muted-foreground" : ""}>
                        <td className="py-2 pr-4 font-medium">{EXTRA_LABELS[i]}</td>
                        <td className="py-2 pr-4">{formatMoney(piCents + s.extraMonthlyPaymentCents + escrowCents)}</td>
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
