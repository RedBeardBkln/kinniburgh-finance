"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { BalanceChart } from "./balance-chart";

export interface ChartPoint {
  label: string;
  balance: number;
  isBreachDay: boolean;
}

type Granularity = "daily" | "weekly" | "monthly" | "quarterly";

interface ForecastAccountCardProps {
  accountName: string;
  mask: string | null;
  minimumBalance: number | null;
  currentBalance: number | null;
  chartData90: ChartPoint[];
  chartDataWeekly: ChartPoint[];
  chartDataMonthly: ChartPoint[];
  chartDataQuarterly: ChartPoint[];
}

export function ForecastAccountCard({
  accountName,
  mask,
  minimumBalance,
  currentBalance,
  chartData90,
  chartDataWeekly,
  chartDataMonthly,
  chartDataQuarterly,
}: ForecastAccountCardProps) {
  const [days, setDays] = useState<30 | 60 | 90>(30);
  const [granularity, setGranularity] = useState<Granularity>("daily");

  const displayName = mask ? `${accountName} ···${mask}` : accountName;

  const sliced =
    granularity === "daily"
      ? chartData90.slice(0, days)
      : granularity === "weekly"
      ? chartDataWeekly
      : granularity === "monthly"
      ? chartDataMonthly
      : chartDataQuarterly;

  const hasBreaches =
    granularity === "daily"
      ? minimumBalance !== null && sliced.some((d) => d.balance < minimumBalance)
      : sliced.some((d) => d.isBreachDay);

  const subtitleOverride =
    granularity === "daily"
      ? undefined
      : `${granularity[0]!.toUpperCase()}${granularity.slice(1)} rollup`;

  return (
    <Card className={hasBreaches ? "border-destructive/50" : ""}>
      <CardContent className="pt-4">
        {currentBalance ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{displayName}</p>
              {granularity === "daily" && (
                <div className="flex rounded-md border text-xs overflow-hidden">
                  {([30, 60, 90] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDays(d)}
                      className={`px-2 py-1 transition-colors border-l first:border-l-0 ${
                        days === d
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-muted"
                      }`}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex rounded-md border text-xs overflow-hidden w-fit">
              {(["daily", "weekly", "monthly", "quarterly"] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => setGranularity(g)}
                  className={`px-2 py-1 transition-colors border-l first:border-l-0 ${
                    granularity === g
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted"
                  }`}
                >
                  {g[0]!.toUpperCase()}
                  {g.slice(1)}
                </button>
              ))}
            </div>
            <BalanceChart
              data={sliced}
              minimumBalance={minimumBalance}
              accountName={displayName}
              days={days}
              subtitleOverride={subtitleOverride}
            />
          </div>
        ) : (
          <div className="py-4 text-center text-sm text-muted-foreground">
            <p className="font-medium">{displayName}</p>
            <p className="mt-1">Set current balance above to see projection</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
