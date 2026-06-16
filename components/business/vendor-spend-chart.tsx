"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface VendorRow {
  vendor: string;
  totalDollars: number;
  txCount: number;
}

interface Props {
  data: VendorRow[];
}

function fmtK(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

function fmtDollar(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function VendorSpendChart({ data }: Props) {
  if (data.length === 0) return null;

  const top10 = data.slice(0, 10);
  const height = Math.max(180, top10.length * 38);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={top10}
        layout="vertical"
        margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tickFormatter={fmtK} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis
          type="category"
          dataKey="vendor"
          width={140}
          tick={{ fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: string) => v.length > 18 ? v.slice(0, 16) + "…" : v}
        />
        <Tooltip
          formatter={(v: number) => [fmtDollar(v), "Spend"]}
          cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
        />
        <Bar dataKey="totalDollars" name="Spend" fill="hsl(var(--primary))" radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
