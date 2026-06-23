"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface SpendingRow {
  tagId: string;
  name: string;
  budget: number;
  actual: number;
}

interface Props {
  data: SpendingRow[];
  onBarClick?: (tagId: string) => void;
}

function fmtDollar(v: number): string {
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function SpendingChart({ data, onBarClick }: Props) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Spending this month — top categories</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-4 text-center text-sm text-muted-foreground">No budget data for this period.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            Spending this month — top categories
            {onBarClick && <span className="ml-2 text-xs font-normal text-muted-foreground">(click a bar to drill in)</span>}
          </CardTitle>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-3 rounded-sm bg-slate-300" /> Budget
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-3 rounded-sm bg-primary" /> Actual
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={Math.max(180, data.length * 36)}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
            barGap={2}
            barCategoryGap="30%"
            onClick={onBarClick ? (e) => {
              if (e?.activePayload?.[0]) {
                const row = e.activePayload[0].payload as SpendingRow;
                onBarClick(row.tagId);
              }
            } : undefined}
            style={onBarClick ? { cursor: "pointer" } : undefined}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11 }}
              tickFormatter={fmtDollar}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 11 }}
              width={110}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number, name: string) => [fmtDollar(value), name === "budget" ? "Budget" : "Actual"]}
              cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
            />
            <Bar dataKey="budget" name="budget" fill="hsl(var(--muted-foreground))" opacity={0.35} radius={[0, 2, 2, 0]} />
            <Bar dataKey="actual" name="actual" radius={[0, 2, 2, 0]}>
              {data.map((row, i) => (
                <Cell
                  key={i}
                  fill={row.actual > row.budget ? "hsl(var(--destructive))" : "hsl(var(--primary))"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
