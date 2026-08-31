import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import type { Route } from "next";

interface IncomeSourceRow {
  id: string;
  description: string;
  cadence: string;
  amount: number;
  accountNickname: string;
  accountMask: string | null;
}

interface Props {
  sources: IncomeSourceRow[];
}

const CADENCE_LABELS: Record<string, string> = {
  semi_monthly: "Semi-monthly",
  biweekly: "Bi-weekly",
  monthly: "Monthly",
  weekly: "Weekly",
};

function fmtUSD(dollars: number): string {
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function IncomeSourcesCard({ sources }: Props) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Income Sources (forecast)</CardTitle>
          <Link
            href="/settings/income-sources"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Manage →
          </Link>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {sources.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No income sources configured. Confirm a paystub and sync it, or add one on the
            Forecast page — the forecast uses these for predictive banking.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Cadence</th>
                <th className="px-4 py-2 font-medium text-right">Per paycheck</th>
                <th className="px-4 py-2 font-medium">Deposits into</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2 font-medium">{s.description}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {CADENCE_LABELS[s.cadence] ?? s.cadence}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-green-600 font-medium">
                    +{fmtUSD(s.amount)}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {s.accountNickname}
                    {s.accountMask ? ` ···${s.accountMask}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}