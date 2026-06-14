"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

interface BalanceChartPoint {
  label: string; // "Jun 12"
  balance: number;
  isBreachDay: boolean;
}

interface BalanceChartProps {
  data: BalanceChartPoint[];
  minimumBalance: number | null;
  accountName: string;
}

export function BalanceChart({ data, minimumBalance, accountName }: BalanceChartProps) {
  const hasBreaches = data.some((d) => d.isBreachDay);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{accountName} — 30-day projection</p>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--muted))" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10 }}
            tickLine={false}
            interval={4}
          />
          <YAxis
            tick={{ fontSize: 10 }}
            tickLine={false}
            tickFormatter={(v: number) => `$${Math.round(v / 100) * 100}`}
            width={60}
          />
          <Tooltip
            formatter={(value: number) =>
              [
                new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                }).format(value),
                "Balance",
              ]
            }
          />
          {minimumBalance !== null && (
            <ReferenceLine
              y={minimumBalance}
              stroke="hsl(var(--destructive))"
              strokeDasharray="4 2"
              label={{ value: `$${minimumBalance} min`, position: "insideTopRight", fontSize: 10 }}
            />
          )}
          <Area
            type="monotone"
            dataKey="balance"
            stroke={hasBreaches ? "hsl(var(--destructive))" : "hsl(var(--primary))"}
            fill={hasBreaches ? "hsl(var(--destructive) / 0.1)" : "hsl(var(--primary) / 0.1)"}
            strokeWidth={2}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
