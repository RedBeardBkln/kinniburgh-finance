"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";

interface CashFlowRow {
  month: string;
  inflowDollars: number;
  outflowDollars: number;
  netDollars: number;
}

interface Props {
  data: CashFlowRow[];
}

function fmtK(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

function fmtDollar(v: number): string {
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function CashFlowChart({ data }: Props) {
  if (data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtK} width={52} axisLine={false} tickLine={false} />
        <Tooltip
          formatter={(v: number, name: string) => [fmtDollar(v), name === "inflowDollars" ? "Inflows" : "Outflows"]}
          cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
        />
        <Legend formatter={(v) => v === "inflowDollars" ? "Inflows" : "Outflows"} />
        <Bar dataKey="inflowDollars" name="inflowDollars" fill="#16a34a" radius={[3, 3, 0, 0]} />
        <Bar dataKey="outflowDollars" name="outflowDollars" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
