"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { addSolarEntry } from "@/actions/solar";

interface SolarEntryRow {
  id: string;
  period: string;
  billAmountCents: number;
  usageKwh: number | null;
  gridCreditCents: number | null;
}

interface Props {
  entries: SolarEntryRow[];
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function SolarTracker({ entries: initialEntries }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showAdd, setShowAdd] = useState(false);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [billAmount, setBillAmount] = useState("");
  const [usageKwh, setUsageKwh] = useState("");
  const [gridCredit, setGridCredit] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Pre-solar baseline: user sets this; we default to $200/mo as a placeholder
  const baselineCents = 20000;

  const chartData = initialEntries.map((e) => ({
    period: e.period,
    bill: e.billAmountCents / 100,
    gridCredit: (e.gridCreditCents ?? 0) / 100,
    baseline: baselineCents / 100,
    net: (e.billAmountCents - (e.gridCreditCents ?? 0)) / 100,
    kWh: e.usageKwh ?? 0,
  }));

  const totalSaved = initialEntries.reduce(
    (acc, e) => acc + (baselineCents - e.billAmountCents + (e.gridCreditCents ?? 0)),
    0
  );
  const totalGridCredits = initialEntries.reduce((acc, e) => acc + (e.gridCreditCents ?? 0), 0);

  function handleAdd() {
    if (!billAmount) { setError("Bill amount is required"); return; }
    setError(null);
    startTransition(async () => {
      try {
        await addSolarEntry({
          period,
          billAmountCents: Math.round(parseFloat(billAmount) * 100),
          usageKwh: usageKwh ? parseFloat(usageKwh) : undefined,
          gridCreditCents: gridCredit ? Math.round(parseFloat(gridCredit) * 100) : undefined,
        });
        setShowAdd(false);
        setBillAmount(""); setUsageKwh(""); setGridCredit("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to add entry");
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-5">
            <p className="text-2xl font-semibold text-green-600">{fmtMoney(Math.max(0, totalSaved))}</p>
            <p className="text-xs text-muted-foreground">Cumulative savings vs. ${(baselineCents / 100).toFixed(0)}/mo baseline</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-2xl font-semibold">{fmtMoney(totalGridCredits)}</p>
            <p className="text-xs text-muted-foreground">Total grid credits earned</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-2xl font-semibold">{initialEntries.length}</p>
            <p className="text-xs text-muted-foreground">Months tracked</p>
          </CardContent>
        </Card>
      </div>

      {/* Bill chart */}
      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Monthly bill vs. pre-solar baseline</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(v: number) => `$${v.toFixed(2)}`} />
                <Legend />
                <Bar dataKey="net" name="Net bill" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                <Bar dataKey="gridCredit" name="Grid credits" fill="hsl(var(--chart-2, 120 60% 50%))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* kWh chart */}
      {chartData.some((d) => d.kWh > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Energy usage (kWh)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData}>
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="kWh" dot={false} strokeWidth={2} stroke="hsl(var(--primary))" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Add entry */}
      {showAdd ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Add monthly entry</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">Period (YYYY-MM)</label>
                <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Bill amount ($) <span className="text-xs text-muted-foreground font-normal">required</span></label>
                <input type="number" step="0.01" value={billAmount} onChange={(e) => setBillAmount(e.target.value)} placeholder="127.40"
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Usage (kWh) <span className="text-xs text-muted-foreground font-normal">optional</span></label>
                <input type="number" step="0.1" value={usageKwh} onChange={(e) => setUsageKwh(e.target.value)} placeholder="842"
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Grid credit ($) <span className="text-xs text-muted-foreground font-normal">optional</span></label>
                <input type="number" step="0.01" value={gridCredit} onChange={(e) => setGridCredit(e.target.value)} placeholder="15.00"
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <button onClick={handleAdd} disabled={isPending}
                className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {isPending ? "Adding…" : "Add entry"}
              </button>
              <button onClick={() => setShowAdd(false)} className="text-sm text-muted-foreground hover:underline">Cancel</button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <button onClick={() => setShowAdd(true)}
          className="inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent">
          + Add monthly entry
        </button>
      )}

      {/* History table */}
      {initialEntries.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">History</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Period</th>
                  <th className="px-4 py-3 font-medium">Bill</th>
                  <th className="px-4 py-3 font-medium">Grid credit</th>
                  <th className="px-4 py-3 font-medium">Net</th>
                  <th className="px-4 py-3 font-medium">kWh</th>
                  <th className="px-4 py-3 font-medium text-green-600">Saved</th>
                </tr>
              </thead>
              <tbody>
                {[...initialEntries].reverse().map((e) => {
                  const net = e.billAmountCents - (e.gridCreditCents ?? 0);
                  const saved = baselineCents - net;
                  return (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="px-4 py-2">{e.period}</td>
                      <td className="px-4 py-2">{fmtMoney(e.billAmountCents)}</td>
                      <td className="px-4 py-2 text-green-600">{e.gridCreditCents ? fmtMoney(e.gridCreditCents) : "—"}</td>
                      <td className="px-4 py-2">{fmtMoney(net)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{e.usageKwh ?? "—"}</td>
                      <td className={`px-4 py-2 ${saved > 0 ? "text-green-600" : "text-destructive"}`}>
                        {saved > 0 ? "+" : ""}{fmtMoney(saved)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
