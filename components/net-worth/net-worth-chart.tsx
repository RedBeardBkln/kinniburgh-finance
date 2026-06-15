"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { snapshotNetWorth } from "@/actions/net-worth";

interface Snapshot {
  date: Date;
  netWorthCents: number;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
}

interface Props {
  snapshots: Snapshot[];
  currentNetWorthCents: number;
}

function fmtK(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (Math.abs(dollars) >= 1_000) return `$${(dollars / 1_000).toFixed(0)}k`;
  return `$${dollars.toFixed(0)}`;
}

export function NetWorthChart({ snapshots, currentNetWorthCents }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const chartData = snapshots.map((s) => ({
    date: new Date(s.date).toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
    netWorth: s.netWorthCents / 100,
    assets: s.totalAssetsCents / 100,
    liabilities: s.totalLiabilitiesCents / 100,
  }));

  function handleSnapshot() {
    startTransition(async () => {
      try {
        await snapshotNetWorth();
        setResult("Snapshot saved.");
        router.refresh();
      } catch (e) {
        setResult(e instanceof Error ? e.message : "Failed to save snapshot");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Net worth over time</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Current: <span className={`font-semibold ${currentNetWorthCents >= 0 ? "text-green-600" : "text-destructive"}`}>
                {fmtK(currentNetWorthCents)}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {result && <span className="text-xs text-muted-foreground">{result}</span>}
            <button
              onClick={handleSnapshot}
              disabled={isPending}
              className="inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Take snapshot"}
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No snapshots yet. Click "Take snapshot" to record today's net worth.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtK} width={60} />
              <Tooltip formatter={(v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
              <Area
                type="monotone"
                dataKey="netWorth"
                name="Net worth"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#nwGrad)"
                dot={{ r: 3 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
