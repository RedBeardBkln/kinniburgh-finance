import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUSD } from "@/lib/utils";

// ── Category Spend Pace section ─────────────────────────────────────────────
// Plain, non-"use client" presentational component — no hooks/interactivity,
// purely for organizing app/forecast/page.tsx's JSX (already ~700 lines).
// Personal bucket only — see .claude/pipeline/multi-horizon-forecast-view/
// 01-plan.md Design decision 2.

export interface TagPaceRow {
  tagId: string;
  tagName: string;
  budgeted: number;
  actualSpend: number;
  projectedTotal: number;
  percentUsed: number;
  projectedPercentOfBudget: number;
  confidence: "low" | "medium" | "high";
  method: "blended" | "pace_only";
  trailingMonthsUsed: number;
}

interface SpendPaceSectionProps {
  period: string;
  periodLabel: string;
  rows: TagPaceRow[];
}

function StatusBadge({ row }: { row: TagPaceRow }) {
  if (row.confidence === "low") {
    return (
      <span className="rounded-full border border-muted-foreground/30 bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground whitespace-nowrap">
        Not enough history yet
      </span>
    );
  }
  if (row.projectedPercentOfBudget >= 100) {
    return (
      <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700 whitespace-nowrap">
        Trending over
      </span>
    );
  }
  if (row.projectedPercentOfBudget >= 80) {
    return (
      <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 whitespace-nowrap">
        On pace
      </span>
    );
  }
  return (
    <span className="rounded-full border border-green-200 bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700 whitespace-nowrap">
      Under pace
    </span>
  );
}

export function SpendPaceSection({ periodLabel, rows }: SpendPaceSectionProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Category Spend Pace — {periodLabel}</CardTitle>
        <p className="text-xs text-muted-foreground">
          Projections are estimates based on spending pace and recent history — not a
          guarantee, and not tax or financial advice.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">Tag</th>
                <th className="px-4 py-2 font-medium text-right">Spent so far</th>
                <th className="px-4 py-2 font-medium text-right">Budget</th>
                <th className="px-4 py-2 font-medium text-right">Projected (month end)</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.tagId} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{row.tagName}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatUSD(row.actualSpend)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                    {formatUSD(row.budgeted)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    {row.confidence === "low" ? "~" : ""}
                    {formatUSD(row.projectedTotal)}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
