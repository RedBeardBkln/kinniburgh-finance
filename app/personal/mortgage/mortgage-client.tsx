"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { computePayoffScenarios } from "@/lib/payoff-math";

const EXTRA_INCREMENTS = [0, 10000, 20000, 50000, 100000]; // cents above your current extra
const STORAGE_KEY = "mortgage-calc-v1";

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

function formatPayoffDate(isoDate: string): string {
  const [year, month] = isoDate.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[(parseInt(month ?? "1", 10) - 1)] ?? ""} ${year}`;
}

function InputRow({ label, value, set, placeholder, hint }: { label: string; value: string; set: (v: string) => void; placeholder: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        min="0"
        className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function MortgageClient() {
  const [principal, setPrincipal] = useState("300000");
  const [rate, setRate] = useState("6.75");
  const [term, setTerm] = useState("360");
  const [piPayment, setPiPayment] = useState("1946");
  const [extraPrincipal, setExtraPrincipal] = useState("");
  const [propertyTaxes, setPropertyTaxes] = useState("");
  const [pmi, setPmi] = useState("");
  const [propertyInsurance, setPropertyInsurance] = useState("");

  // Load saved values on mount (runs only client-side after hydration)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const d = JSON.parse(saved) as Record<string, string>;
      if (d.principal != null) setPrincipal(d.principal);
      if (d.rate != null) setRate(d.rate);
      if (d.term != null) setTerm(d.term);
      if (d.piPayment != null) setPiPayment(d.piPayment);
      if (d.extraPrincipal != null) setExtraPrincipal(d.extraPrincipal);
      if (d.propertyTaxes != null) setPropertyTaxes(d.propertyTaxes);
      if (d.pmi != null) setPmi(d.pmi);
      if (d.propertyInsurance != null) setPropertyInsurance(d.propertyInsurance);
    } catch {}
  }, []);

  // Auto-save on every field change, skipping the initial render to avoid
  // overwriting saved values before the load effect has applied them.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ principal, rate, term, piPayment, extraPrincipal, propertyTaxes, pmi, propertyInsurance })
      );
    } catch {}
  }, [principal, rate, term, piPayment, extraPrincipal, propertyTaxes, pmi, propertyInsurance]);

  const principalCents = Math.round(parseFloat(principal || "0") * 100);
  const annualRate = parseFloat(rate || "0") / 100;
  const termMonths = parseInt(term || "0", 10);
  const piCents = Math.round(parseFloat(piPayment || "0") * 100);
  const extraPrincipalCents = Math.round(parseFloat(extraPrincipal || "0") * 100);
  const taxesCents = Math.round(parseFloat(propertyTaxes || "0") * 100);
  const pmiCents = Math.round(parseFloat(pmi || "0") * 100);
  const insuranceCents = Math.round(parseFloat(propertyInsurance || "0") * 100);
  const escrowCents = taxesCents + pmiCents + insuranceCents;
  const totalMonthlyCents = piCents + extraPrincipalCents + escrowCents;

  // Base for amortization = required P&I + any extra the user already pays
  const effectivePiBase = piCents + extraPrincipalCents;

  const scenarios =
    principalCents > 0 && annualRate > 0 && termMonths > 0 && piCents > 0
      ? computePayoffScenarios(principalCents, annualRate, termMonths, effectivePiBase)
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

  // Labels: row 0 is the user's actual current payment; rows 1-4 are increments above that
  function extraLabel(i: number): string {
    if (i === 0) {
      return extraPrincipalCents > 0
        ? `Your payment (+${formatMoney(extraPrincipalCents)}/mo extra)`
        : "Current payment";
    }
    const totalExtra = extraPrincipalCents + EXTRA_INCREMENTS[i]!;
    return `+${formatMoney(EXTRA_INCREMENTS[i]!)}/mo${extraPrincipalCents > 0 ? ` more` : ""}`;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold">Mortgage Payoff Simulator</h1>
        <p className="text-sm text-muted-foreground">
          Values are auto-saved and restored each visit. Edit as needed.
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
            <InputRow
              label="Extra principal payment ($/mo)"
              value={extraPrincipal}
              set={setExtraPrincipal}
              placeholder="0"
              hint="Amount you pay above the required P&I each month"
            />
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

          {totalMonthlyCents > 0 && (
            <div className="rounded-md border bg-muted/30 p-4 text-sm">
              <p className="mb-2 font-medium">Monthly payment breakdown</p>
              <div className="space-y-1 text-muted-foreground">
                <div className="flex justify-between">
                  <span>Principal &amp; Interest (required)</span>
                  <span className="tabular-nums">{formatMoney(piCents)}</span>
                </div>
                {extraPrincipalCents > 0 && (
                  <div className="flex justify-between text-blue-700">
                    <span>Extra to principal</span>
                    <span className="tabular-nums">+{formatMoney(extraPrincipalCents)}</span>
                  </div>
                )}
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
                  <span>Total monthly</span>
                  <span className="tabular-nums">{formatMoney(totalMonthlyCents)}</span>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {scenarios && (
        <div className="rounded-lg border bg-card px-5 py-4 shadow-sm">
          <div className="flex flex-wrap gap-8">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Estimated payoff date</p>
              <p className="mt-1 text-3xl font-bold tabular-nums">{formatPayoffDate(scenarios[0]!.payoffDate)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatMonths(scenarios[0]!.monthsRemaining)} from now
                {extraPrincipalCents > 0 && ` · includes +${formatMoney(extraPrincipalCents)}/mo extra`}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total interest remaining</p>
              <p className="mt-1 text-3xl font-bold tabular-nums">{formatMoney(scenarios[0]!.totalInterestCents)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">at current payment</p>
            </div>
          </div>
        </div>
      )}

      {scenarios && (
        <>
          {goalPaymentCents > totalMonthlyCents && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              12-year payoff goal requires a total monthly payment of{" "}
              <strong>{formatMoney(goalPaymentCents)}</strong>
              {escrowCents > 0 && (
                <> (P&amp;I: {formatMoney(goalPaymentCents - escrowCents)} + escrow: {formatMoney(escrowCents)})</>
              )}
              {" "}(+{formatMoney(goalPaymentCents - totalMonthlyCents)}/mo extra above your current total).
            </div>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Extra payment scenarios</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">
                {extraPrincipalCents > 0
                  ? `Row 1 reflects your current payment including the +${formatMoney(extraPrincipalCents)}/mo extra. Rows below show what happens if you pay even more.`
                  : `Amounts above current payment are applied entirely to principal.`}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 pr-4 font-medium">Scenario</th>
                      <th className="pb-2 pr-4 font-medium">Total monthly</th>
                      <th className="pb-2 pr-4 font-medium">Time to payoff</th>
                      <th className="pb-2 pr-4 font-medium">Months saved</th>
                      <th className="pb-2 font-medium">Interest saved</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {scenarios.map((s, i) => (
                      <tr key={i} className={i === 0 ? "text-muted-foreground" : ""}>
                        <td className="py-2 pr-4 font-medium">{extraLabel(i)}</td>
                        <td className="py-2 pr-4">{formatMoney(effectivePiBase + s.extraMonthlyPaymentCents + escrowCents)}</td>
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
                Payoff dates: {scenarios.map((s, i) => `${i === 0 ? (extraPrincipalCents > 0 ? "Your payment" : "Current") : `+${formatMoney(EXTRA_INCREMENTS[i]!)}${extraPrincipalCents > 0 ? " more" : ""}`}: ${formatPayoffDate(s.payoffDate)}`).join(" · ")}
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
