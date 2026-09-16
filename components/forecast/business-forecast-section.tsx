import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUSD } from "@/lib/utils";

// ── Business-bucket forecast section (Sudden Valley / EK Consulting) ─────────
// Plain, non-"use client" presentational component — app/forecast/page.tsx
// computes all the plain numbers server-side (Decimal/Date math never crosses
// into this component); this just renders them. See lib/business-forecast.ts
// for the horizon-capping/proration math this data is built from.
//
// Ground rule 8: every projected figure is prefixed "~" and described as
// "projected" — never phrased as a certainty.

export interface RevenueItem {
  date: Date;
  description: string;
  amount: number; // dollars
}

export interface ExpenseItem {
  tagName: string;
  amount: number; // dollars, prorated across the horizon
}

export interface ForecastHorizon {
  requestedDays: number; // 30 | 60 | 90
  days: number; // possibly capped
  wasCapped: boolean;
  latestConfirmedRevenueDate: Date | null;
  startingBalance: number;
  revenue: number;
  transfersOut: number;
  expenses: number;
  endingBalance: number;
  revenueItems: RevenueItem[];
  expenseItems: ExpenseItem[];
}

export interface ForecastAccount {
  id: string;
  name: string;
  mask: string | null;
  currentBalance: number | null;
  currentBalanceAt: Date | null;
  horizons: ForecastHorizon[];
}

interface Props {
  entityName: string;
  accounts: ForecastAccount[];
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function WaterfallLine({
  label,
  amount,
  sign,
}: {
  label: string;
  amount: number;
  sign: "+" | "-" | "=" | "start";
}) {
  const color =
    sign === "+" ? "text-green-600" : sign === "-" ? "text-destructive" : "text-foreground";
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-muted-foreground">
        {sign === "start" ? "Starting balance" : sign === "=" ? label : `${sign === "+" ? "+ " : "− "}${label}`}
      </span>
      <span className={`tabular-nums font-medium ${color}`}>{formatUSD(amount)}</span>
    </div>
  );
}

function HorizonCard({ horizon }: { horizon: ForecastHorizon }) {
  return (
    <div className="rounded-md border p-3 space-y-2">
      <p className="text-sm font-semibold">
        {horizon.days}-day projection
        {horizon.wasCapped && (
          <span className="ml-1.5 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 align-middle">
            Capped
          </span>
        )}
      </p>
      <div className="space-y-1">
        <WaterfallLine label="Starting balance" amount={horizon.startingBalance} sign="start" />
        <WaterfallLine label="projected revenue" amount={horizon.revenue} sign="+" />
        <WaterfallLine label="scheduled transfers out" amount={horizon.transfersOut} sign="-" />
        <WaterfallLine label="projected expenses" amount={horizon.expenses} sign="-" />
        <div className="flex items-baseline justify-between border-t pt-1 text-sm">
          <span className="font-medium">Projected ending balance</span>
          <span className="tabular-nums font-semibold">~{formatUSD(horizon.endingBalance)}</span>
        </div>
      </div>

      {horizon.wasCapped && (
        <p className="text-xs text-amber-700">
          Revenue confirmed only through{" "}
          {horizon.latestConfirmedRevenueDate ? fmtDate(horizon.latestConfirmedRevenueDate) : "—"}; showing a{" "}
          {horizon.days}-day projection instead of {horizon.requestedDays}.
        </p>
      )}

      {(horizon.revenueItems.length > 0 || horizon.expenseItems.length > 0) && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Itemized breakdown
          </summary>
          <div className="mt-2 space-y-3">
            {horizon.revenueItems.length > 0 && (
              <div>
                <p className="font-medium text-muted-foreground">Revenue</p>
                <ul className="mt-1 space-y-0.5">
                  {horizon.revenueItems.map((item, i) => (
                    <li key={i} className="flex justify-between">
                      <span>
                        {fmtDate(item.date)} — {item.description}
                      </span>
                      <span className="tabular-nums text-green-600">{formatUSD(item.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {horizon.expenseItems.length > 0 && (
              <div>
                <p className="font-medium text-muted-foreground">Expenses (prorated)</p>
                <ul className="mt-1 space-y-0.5">
                  {horizon.expenseItems.map((item, i) => (
                    <li key={i} className="flex justify-between">
                      <span>{item.tagName}</span>
                      <span className="tabular-nums text-destructive">{formatUSD(item.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

export function BusinessForecastSection({ entityName, accounts }: Props) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Financial Forecast — {entityName}</CardTitle>
        <p className="text-xs text-muted-foreground">
          Projected, not guaranteed: current balance plus projected revenue, less scheduled
          transfers out, less projected expenses from current Budget lines. Not tax or financial
          advice.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {accounts.map((acct) => {
          const displayName = acct.mask ? `${acct.name} ···${acct.mask}` : acct.name;
          const asOf = acct.currentBalanceAt
            ? acct.currentBalanceAt.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : null;

          return (
            <div key={acct.id} className="space-y-3">
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-medium">{displayName}</p>
                {acct.currentBalance !== null ? (
                  <p className="text-sm tabular-nums">
                    {formatUSD(acct.currentBalance)}
                    {asOf && <span className="ml-1.5 text-xs text-muted-foreground">as of {asOf}</span>}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Set current balance on the Accounts page</p>
                )}
              </div>

              {acct.currentBalance !== null ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  {acct.horizons.map((h) => (
                    <HorizonCard key={h.requestedDays} horizon={h} />
                  ))}
                </div>
              ) : (
                <p className="py-2 text-center text-sm text-muted-foreground">
                  Set current balance above to see a projection
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
