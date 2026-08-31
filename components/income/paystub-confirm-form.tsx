"use client";

import { useMemo, useState, useTransition, useEffect } from "react";
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
  initialAdditionalWithholding: LabeledAmount[];
  initialNetPayCents: number | null;
  initialNotes: string;
  extractStatus: string;
  confirmedAt: string | null;
  accounts: AccountOption[];
  depositAccountId: string | null;
}

// Line items keep raw text so typing works naturally (decimal points,
// intermediate states like "123." survive until the user finishes).
interface LineItem {
  label: string;
  amountStr: string;
}

function toLineItems(items: LabeledAmount[]): LineItem[] {
  return items.map((d) => ({
    label: d.label,
    amountStr: d.amountCents !== 0 ? (d.amountCents / 100).toFixed(2) : "",
  }));
}

function toLabeledAmounts(items: LineItem[]): LabeledAmount[] {
  return items
    .filter((d) => d.label.trim().length > 0)
    .map((d) => ({
      label: d.label.trim(),
      amountCents: centsFromInput(d.amountStr),
    }));
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

// Common set of federal/state withholding line names for quick-add buttons
const WITHHOLDING_PRESETS = [
  "Federal income tax (extra)",
  "State income tax — CT (extra)",
  "Federal — additional $ per pay period",
  "State — additional $ per pay period",
];

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
  const [pretax, setPretax] = useState<LineItem[]>(toLineItems(props.initialPretaxDeductions));
  const [taxesStr, setTaxesStr] = useState(
    props.initialTaxesCents !== null ? (props.initialTaxesCents / 100).toFixed(2) : ""
  );
  const [taxBreakdown, setTaxBreakdown] = useState<LineItem[]>(toLineItems(props.initialTaxBreakdown));
  const [additionalWithholding, setAdditionalWithholding] = useState<LineItem[]>(
    toLineItems(props.initialAdditionalWithholding)
  );
  const [netStr, setNetStr] = useState(
    props.initialNetPayCents !== null ? (props.initialNetPayCents / 100).toFixed(2) : ""
  );
  const [notes, setNotes] = useState(props.initialNotes);
  const [depositAccountId, setDepositAccountId] = useState(
    props.depositAccountId ?? props.accounts[0]?.id ?? ""
  );
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const grossCents = grossStr ? centsFromInput(grossStr) : null;
  const taxesCents = taxesStr ? centsFromInput(taxesStr) : null;
  const netCents = netStr ? centsFromInput(netStr) : null;

  const pretaxLabeled = useMemo(() => toLabeledAmounts(pretax), [pretax]);
  const taxBreakdownLabeled = useMemo(() => toLabeledAmounts(taxBreakdown), [taxBreakdown]);
  const additionalWithholdingLabeled = useMemo(
    () => toLabeledAmounts(additionalWithholding),
    [additionalWithholding]
  );
  const additionalWithholdingTotal = additionalWithholdingLabeled.reduce(
    (s, d) => s + d.amountCents,
    0
  );

  const math = useMemo(
    () =>
      verifyPaystubMath({
        grossPayCents: grossCents,
        pretaxDeductions: pretaxLabeled,
        taxesCents: taxesCents,
        taxBreakdown: taxBreakdownLabeled,
        netPayCents: netCents,
      }),
    [grossCents, pretaxLabeled, taxesCents, taxBreakdownLabeled, netCents]
  );

  function updateLineItem(
    setter: React.Dispatch<React.SetStateAction<LineItem[]>>,
    index: number,
    field: "label" | "amountStr",
    value: string
  ) {
    setter((prev) => prev.map((d, i) => (i === index ? { ...d, [field]: value } : d)));
  }

  function addWithholdingPreset(preset: string) {
    if (additionalWithholding.some((w) => w.label === preset)) return;
    setAdditionalWithholding((prev) => [...prev, { label: preset, amountStr: "" }]);
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
      grossPayCents: grossCents,
      pretaxDeductions: pretaxLabeled,
      taxesCents: taxesCents,
      taxBreakdown: taxBreakdownLabeled,
      additionalWithholding: additionalWithholdingLabeled,
      netPayCents: netCents,
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
    if (!depositAccountId) {
      setError("Select the direct deposit account first.");
      return;
    }
    const result = await syncPaystubToIncomeSource(props.paystubId, depositAccountId);
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

          {/* Direct deposit account */}
          <div className="space-y-1">
            <label className="text-xs font-medium">Direct deposit account</label>
            {props.accounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No accounts configured for this entity.
              </p>
            ) : (
              <select
                value={depositAccountId}
                onChange={(e) => setDepositAccountId(e.target.value)}
                className="w-full rounded border px-2 py-1.5 text-sm"
              >
                {props.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nickname}
                    {a.mask ? ` (x${a.mask})` : ""}
                  </option>
                ))}
              </select>
            )}
            <p className="text-xs text-muted-foreground">
              Where this paycheck lands. Used by &quot;Sync to Forecast&quot; — change it here if
              the deposit account differs from what was selected at upload.
            </p>
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
              <label className="text-xs font-medium">Taxes withheld (stub line) *</label>
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
                onClick={() => setPretax((prev) => [...prev, { label: "", amountStr: "" }])}
                className="text-xs text-primary hover:underline"
              >
                + Add line
              </button>
            </div>
            {pretax.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No pre-tax deductions listed on this stub. Use &quot;+ Add line&quot; for any the
                extraction missed.
              </p>
            )}
            {pretax.map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={d.label}
                  onChange={(e) => updateLineItem(setPretax, i, "label", e.target.value)}
                  className="flex-1 rounded border px-2 py-1 text-sm"
                  placeholder="e.g. 401(k) employee"
                />
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={d.amountStr}
                  onChange={(e) => updateLineItem(setPretax, i, "amountStr", e.target.value)}
                  className="w-28 rounded border px-2 py-1 text-sm tabular-nums text-right"
                  placeholder="0.00"
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
                Tax breakdown (Federal / Social Security / Medicare / State / Local)
              </label>
              <button
                type="button"
                onClick={() => setTaxBreakdown((prev) => [...prev, { label: "", amountStr: "" }])}
                className="text-xs text-primary hover:underline"
              >
                + Add line
              </button>
            </div>
            {taxBreakdown.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No breakdown — enter the totals only, or add each tax line.
              </p>
            )}
            {taxBreakdown.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={t.label}
                  onChange={(e) => updateLineItem(setTaxBreakdown, i, "label", e.target.value)}
                  className="flex-1 rounded border px-2 py-1 text-sm"
                  placeholder="e.g. Federal income tax"
                />
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={t.amountStr}
                  onChange={(e) => updateLineItem(setTaxBreakdown, i, "amountStr", e.target.value)}
                  className="w-28 rounded border px-2 py-1 text-sm tabular-nums text-right"
                  placeholder="0.00"
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

          {/* Additional tax withholding (beyond the stub's tax lines) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Additional tax withholding (extra federal / state contributions)
              </label>
              <button
                type="button"
                onClick={() =>
                  setAdditionalWithholding((prev) => [...prev, { label: "", amountStr: "" }])
                }
                className="text-xs text-primary hover:underline"
              >
                + Add line
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Extra money withheld each paycheck toward federal or state taxes — e.g. a flat
              additional amount you elected on your W-4, or estimated-tax money routed through
              payroll. These flow into your tax workspaces as payments already made, so your
              refund/balance-due math counts them.
            </p>
            {additionalWithholding.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {WITHHOLDING_PRESETS.filter(
                  (p) => !additionalWithholding.some((w) => w.label === p)
                ).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => addWithholdingPreset(preset)}
                    className="rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  >
                    + {preset}
                  </button>
                ))}
              </div>
            )}
            {additionalWithholding.length === 0 && (
              <p className="text-xs text-muted-foreground">
                None recorded. Add a line if you elect extra withholding on your W-4 — every extra
                dollar withheld is a dollar counted toward your year-end tax bill.
              </p>
            )}
            {additionalWithholding.map((w, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={w.label}
                  onChange={(e) =>
                    updateLineItem(setAdditionalWithholding, i, "label", e.target.value)
                  }
                  className="flex-1 rounded border px-2 py-1 text-sm"
                  placeholder="e.g. Federal — additional withholding (W-4 line 4c)"
                />
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={w.amountStr}
                  onChange={(e) =>
                    updateLineItem(setAdditionalWithholding, i, "amountStr", e.target.value)
                  }
                  className="w-28 rounded border px-2 py-1 text-sm tabular-nums text-right"
                  placeholder="0.00"
                />
                <button
                  type="button"
                  onClick={() =>
                    setAdditionalWithholding((prev) => prev.filter((_, j) => j !== i))
                  }
                  className="text-xs text-muted-foreground hover:text-destructive"
                >
                  Remove
                </button>
              </div>
            ))}
            {additionalWithholdingTotal > 0 && (
              <p className="text-xs text-muted-foreground">
                Extra withholding this stub:{" "}
                <span className="font-medium text-foreground">
                  {fmtUSD(additionalWithholdingTotal)}
                </span>
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
                    : `✗ Off by ${fmtUSD(Math.abs(math.balanceDiffCents ?? 0))} — re-check the stub's numbers. If the stub includes post-tax deductions (e.g. Roth 401(k)), they legitimately cause part of this difference.`}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Enter gross, taxes, and net to verify the math.
              </p>
            )}
            {additionalWithholdingTotal > 0 && (
              <p className="text-xs text-muted-foreground border-t pt-1.5 mt-1.5">
                Note: additional withholding of {fmtUSD(additionalWithholdingTotal)} is extra tax
                PAID (it reduces your net deposit), not an extra deduction — the balance check above
                treats it as part of what explains gross → net.
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
            cadence{depositAccountId ? `, deposited into ${props.accounts.find((a) => a.id === depositAccountId)?.nickname ?? "the selected account"}` : ""}) so the
            predictive balance forecast reflects real take-home.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}