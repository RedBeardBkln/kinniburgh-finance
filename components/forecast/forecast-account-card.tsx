"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { BalanceChart } from "./balance-chart";

export interface ChartPoint {
  label: string;
  balance: number;
  isBreachDay: boolean;
}

interface ForecastAccountCardProps {
  accountName: string;
  mask: string | null;
  minimumBalance: number | null;
  currentBalance: number | null;
  chartData90: ChartPoint[];
}

export function ForecastAccountCard({
  accountName,
  mask,
  minimumBalance,
  currentBalance,
  chartData90,
}: ForecastAccountCardProps) {
  const [days, setDays] = useState<30 | 60 | 90>(30);

  const displayName = mask ? `${accountName} ···${mask}` : accountName;
  const sliced = chartData90.slice(0, days);
  const hasBreaches =
    minimumBalance !== null && sliced.some((d) => d.balance < minimumBalance);

  return (
    <Card className={hasBreaches ? "border-destructive/50" : ""}>
      <CardContent className="pt-4">
        {currentBalance ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{displayName}</p>
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
            </div>
            <BalanceChart
              data={sliced}
              minimumBalance={minimumBalance}
              accountName={displayName}
              days={days}
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
