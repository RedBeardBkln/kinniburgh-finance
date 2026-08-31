"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { confirmPaystub, syncPaystubToIncomeSource, archivePaystub } from "@/actions/paystubs";
import { verifyPaystubMath, type LabeledAmount } from "@/lib/paystub-math";

interface AccountOption {
  id: string;
  nickname: string;
  mask: string | null;
}

interface Props {
  paystubId: string;
  initialEmployeeName: string;
  initialEmployerName: string;
  initialPayPeriodStart: string;
  initialPayPeriodEnd: string;
  initialPayDate: string;
  initialPayFrequency: string;
  initialGrossPayCents: number | null;
  initialPretaxDeductions: LabeledAmount[];
  initialTaxesCents: number | null;
  initialTaxBreakdown: LabeledAmount[];
  initialNetPayCents: number | null;
  initialNotes: string;
  extractStatus: string;
  confirmedAt: string | null;
  accounts: AccountOption[];
}

function fmtUSD(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function centsFromInput(value: string): number {
  const n = parseFloat(value);
  if (isNaN(n) || n < 0) return 0;
  return Math.round(n * 100);
}

export function PaystubConfirmForm(props: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [employeeName, setEmployeeName] = useState(props.initialEmployeeName);
  const [employerName, setEmployerName] = useState(props.initialEmployerName);
  const [payPeriodStart, setPayPeriodStart] = useState(props.initialPayPeriodStart);
  const [payPeriodEnd, setPayPeriodEnd] = useState(props.initialPayPeriodEnd);
  const [payDate, setPayDate] = useState(props.initialPayDate);
  const [payFrequency, setPayFrequency] = useState(props.initialPayFrequency);
  const [grossStr, setGrossStr] = useState(
    props.initialGrossPayCents !== null ? (props.initialGrossPayCents / 100).toFixed(2) : ""
  );
  const [pretax, setPretax] = useState<LabeledAmount[]>(props.initialPretaxDeductions);
  const [taxesStr, setTaxesStr] = useState(
    props.initialTaxesCents !== null ? (props.initialTaxesCents / 100).toFixed(2) : ""
  );
  const [taxBreakdown, setTaxBreakdown] = useState<LabeledAmount[]>(props.initialTaxBreakdown);
  const [netStr, setNetStr] = useState(
    props.initialNetPayCents !== null ? (props.initialNetPayCents / 100).toFixed(2) : ""
  );
  const [notes, setNotes] = useState(props.initialNotes);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const grossCents = grossStr ? centsFromInput(grossStr) : null;
  const taxesCents = taxesStr ? centsFromInput(taxesStr) : null;
  const netCents = netStr ? centsFromInput(netStr) : null;

  const math = useMemo(
    () =>
      verifyPaystubMath({
        grossPayCents: grossCents,
        pretaxDeductions: pretax,
        taxesCents: taxesCents,
        taxBreakdown: taxBreakdown,
        netPayCents: netCents,
      }),
    [grossCents, pretax, taxesCents, taxBreakdown, netCents]
  );

  function setPretaxAmount(index: number, value: string) {
    setPretax((prev) =>
      prev.map((d, i) => (i === index ? { ...d, amountCents: centsFromInput(value) } : d))
    );
  }
  function setPretaxLabel(index: number, label: string) {
    setPretax((prev) => prev.map((d, i) => (i === index ? { ...d, label } : d)));
  }
  function setTaxAmount(index: number, value: string) {
    setTaxBreakdown((prev) =>
      prev.map((t, i) => (i === index ? { ...t, amountCents: centsFromInput(value) } : t))
    );
  }
  function setTaxLabel(index: number, label: string) {
    setTaxBreakdown((prev) => prev.map((t, i) => (i === index ? { ...t, label } : t)));
  }

  async function handleConfirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (!payDate || grossCents === null || taxesCents === null || netCents === null) {
      setError("Pay date, gross, taxes, and net are required.");
      return;
    }

    const result = await confirmPaystub({
      paystubId: props.paystubId,
      employeeName: employeeName || undefined,
      employerName: employerName || undefined,
      payPeriodStart: payPeriodStart || "",
      payPeriodEnd: payPeriodEnd || "",
      payDate,
      payFrequency: payFrequency as "semi_monthly" | "biweekly" | "weekly" | "monthly",
      grossPayCents: grossCents!,
      pretaxDeductions: pretax,
      taxesCents: taxesCents!,
      taxBreakdown,
      netPayCents: netCents!,
      notes: notes || undefined,
    });

    if ("error" in result) {
      setError(result.error);
      return;
    }

    if (result.balanceDiffCents !== 0) {
      setSuccessMsg(
        `Saved — note: math is off by ${fmtUSD(Math.abs(result.balanceDiffCents))}.`
      );
    } else {
      setSuccessMsg("Saved and verified — the stub balances exactly.");
    }
    startTransition(() => router.refresh());
  }

  async function handleSyncToForecast() {
    setError(null);
    setSuccessMsg(null);
    const accountId = props.accounts[0]?.id;
    if (!accountId) {
      setError("No accounts available for this entity.");
      return;
    }
    const result = await syncPaystubToIncomeSource(props.paystubId, accountId);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setSuccessMsg("Income source updated — the forecast now uses this cadence and amount.");
    startTransition(() => router.refresh());
  }

  async function handleArchive() {
    if (!confirm("Archive this paystub? It will be hidden from the income page.")) return;
    await archivePaystub(props.paystubId);
    router.push("/personal/income");
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Extracted data</CardTitle>
          <div className="flex items-center gap-2">
            {props.extractStatus === "failed" && (
              <Badge variant="destructive" className="text-xs">
                Extraction failed — enter manually
              </Badge>
            )}
            {props.confirmedAt && (
              <Badge variant="outline" className="text-xs">
                Confirmed
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleConfirm} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium">Employee</label>
              <input
                value={employeeName}
                onChange={(e) => setEmployeeName(e.target.value)}
                className="w-full rounded border px-2 py-1.5 text-sm"
                placeholder="Employee name"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Employer</label>
              <input
                value={employerName}
                onChange={(e) => setEmployerName(e.target.value)}
                className="w-full rounded border px-2 py-1.5 text-sm"
                placeholder="Employer name"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Pay period start</label>
              <input
                type="date"
                value={payPeriodStart}
                onChange={(e) => setPayPeriodStart(e.target.value)}
                className="w-full rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Pay period end</label>
              <input
                type="date"
                value={payPeriodEnd}
                onChange={(e) => setPayPeriodEnd(e.target.value)}
                className="w-full rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Pay date *</label>
              <input
                type="date"
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
                required
                className="w-full rounded border px-2 py-1.5 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Pay frequency *</label>
              <select
                value={payFrequency}
                onChange={(e) => setPayFrequency(e.target.value)}
                className="w-full rounded border px-2 py-1.5 text-sm"
                required
              >
                <option value="biweekly">Bi-weekly (26/yr)</option>
                <option value="semi_monthly">Semi-monthly (24/yr)</option>
                <option value="weekly">Weekly (52/yr)</option>
                <option value="monthly">Monthly (12/yr)</option>
              </select>
            </div>
          </div>

          {/* Amounts */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Gross pay *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={grossStr}
                onChange={(e) => setGrossStr(e.target.value)}
                required
                className="w-full rounded border px-2 py-1.5 text-sm tabular-nums"
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Taxes withheld *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={taxesStr}
                onChange={(e) => setTaxesStr(e.target.value)}
                required
                className="w-full rounded border px-2 py-1.5 text-sm tabular-nums"
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Net pay *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={netStr}
                onChange={(e) => setNetStr(e.target.value)}
                required
                className="w-full rounded border px-2 py-1.5 text-sm tabular-nums"
                placeholder="0.00"
              />
            </div>
          </div>

          {/* Pre-tax deductions */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Pre-tax deductions (where gross money goes before taxes)
              </label>
              <button
                type="button"
                onClick={() => setPretax((prev) => [...prev, { label: "", amountCents: 0 }])}
                className="text-xs text-primary hover:underline"
              >
                + Add
              </button>
            </div>
            {pretax.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No pre-tax deductions listed on this stub.
              </p>
            )}
            {pretax.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={d.label}
                  onChange={(e) => setPretaxLabel(i, e.target.value)}
                  className="flex-1 rounded border px-2 py-1 text-sm"
                  placeholder="e.g. 401(k) employee"
                />
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={(d.amountCents / 100).toFixed(2)}
                  onChange={(e) => setPretaxAmount(i, e.target.value)}
                  className="w-28 rounded border px-2 py-1 text-sm tabular-nums text-right"
                />
                <button
                  type="button"
                  onClick={() => setPretax((prev) => prev.filter((_, j) => j !== i))}
                  className="text-xs text-muted-foreground hover:text-destructive"
                >
                  Remove
                </button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Pre-tax total: <span className="font-medium text-foreground">{fmtUSD(math.pretaxTotalCents)}</span>
            </p>
          </div>

          {/* Tax breakdown */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Tax breakdown
              </label>
              <button
                type="button"
                onClick={() => setTaxBreakdown((prev) => [...prev, { label: "", amountCents: 0 }])}
                className="text-xs text-primary hover:underline"
              >
                + Add
              </button>
            </div>
            {taxBreakdown.length === 0 && (
              <p className="text-xs text-muted-foreground">No breakdown — enter totals only.</p>
            )}
            {taxBreakdown.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={t.label}
                  onChange={(e) => setTaxLabel(i, e.target.value)}
                  className="flex-1 rounded border px-2 py-1 text-sm"
                  placeholder="e.g. Federal income tax"
                />
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={(t.amountCents / 100).toFixed(2)}
                  onChange={(e) => setTaxAmount(i, e.target.value)}
                  className="w-28 rounded border px-2 py-1 text-sm tabular-nums text-right"
                />
                <button
                  type="button"
                  onClick={() => setTaxBreakdown((prev) => prev.filter((_, j) => j !== i))}
                  className="text-xs text-muted-foreground hover:text-destructive"
                >
                  Remove
                </button>
              </div>
            ))}
            {math.taxesBreakdownBalanced !== null && (
              <p className={`text-xs ${math.taxesBreakdownBalanced ? "text-green-600" : "text-amber-600"}`}>
                {math.taxesBreakdownBalanced
                  ? "Breakdown sums to the stated taxes total ✓"
                  : "Breakdown does NOT sum to the stated taxes total — check the stub."}
              </p>
            )}
          </div>

          {/* Verification box */}
          <div className="rounded-md border bg-muted/30 px-3 py-3 space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Calculation check: gross − pre-tax − taxes vs. net
            </p>
            {math.computedNetCents !== null ? (
              <>
                <p className="text-sm">
                  <span className="text-muted-foreground">Computed net:</span>{" "}
                  <span className="font-medium tabular-nums">{fmtUSD(math.computedNetCents)}</span>
                  {"  ·  "}
                  <span className="text-muted-foreground">Stated net:</span>{" "}
                  <span className="font-medium tabular-nums">{fmtUSD(netCents ?? 0)}</span>
                </p>
                <p
                  className={`text-sm font-medium ${
                    math.isBalanced ? "text-green-600" : "text-destructive"
                  }`}
                >
                  {math.isBalanced
                    ? "✓ Balanced — the math checks out exactly."
                    : `✗ Off by ${fmtUSD(Math.abs(math.balanceDiffCents ?? 0))} — re-check the stub's numbers.`}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Enter gross, taxes, and net to verify the math.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded border px-2 py-1.5 text-sm"
              rows={2}
              placeholder="Optional notes (e.g. bonus included, retro pay)"
            />
          </div>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          {successMsg && (
            <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
              {successMsg}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={isPending}
              className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {isPending ? "Saving…" : props.confirmedAt ? "Update" : "Confirm Paystub"}
            </button>
            <button
              type="button"
              onClick={handleSyncToForecast}
              disabled={isPending}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-60"
              title="Update the income source used by the cash-flow forecast with this cadence and amount"
            >
              Sync to Forecast
            </button>
            <button
              type="button"
              onClick={handleArchive}
              disabled={isPending}
              className="text-sm text-muted-foreground hover:text-destructive"
            >
              Archive
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Sync to Forecast updates the payroll income source (gross per paycheck, {payFrequency.replace("_", " ")}{" "}
            cadence{props.accounts[0] ? `, deposited into ${props.accounts[0].nickname}` : ""}) so the
            predictive balance forecast reflects real take-home.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}