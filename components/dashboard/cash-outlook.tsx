import Link from "next/link";
import type { Route } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface CashOutlookData {
  days: number;
  /** Checking and savings balances in view (integer cents). */
  cashCents: number;
  inCents: number;
  outCents: number;
  /** Part of the money out that is an estimate. */
  outEstimatedCents: number;
  /** Items listed without an amount (not counted). */
  unknownAmountCount: number;
}

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;
}

/** Forecast snapshot: today's cash, what is scheduled in and out over the window, and what is left after those items. */
export function CashOutlook({ outlook, forecastHref }: { outlook: CashOutlookData; forecastHref: string }) {
  const left = outlook.cashCents + outlook.inCents - outlook.outCents;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline justify-between gap-2 text-base">
          <span>Cash outlook, next {outlook.days} days</span>
          <Link href={forecastHref as Route} className="text-sm font-normal text-muted-foreground underline-offset-4 hover:underline">
            Forecast →
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Cash now</dt>
            <dd className="font-semibold tabular-nums">{money(outlook.cashCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Money coming in</dt>
            <dd className="font-semibold tabular-nums text-green-700">+{money(outlook.inCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Bills and card payments due</dt>
            <dd className="font-semibold tabular-nums text-destructive">-{money(outlook.outCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Left after those</dt>
            <dd className={`font-semibold tabular-nums ${left < 0 ? "text-destructive" : ""}`}>{money(left)}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          Counts only scheduled bills, card payments and expected paychecks. Everyday spending like groceries is not in it.
          {outlook.outEstimatedCents > 0 ? ` Includes ${money(outlook.outEstimatedCents)} of estimates.` : ""}
          {outlook.unknownAmountCount > 0
            ? ` ${outlook.unknownAmountCount} item${outlook.unknownAmountCount === 1 ? " has" : "s have"} no amount set and ${outlook.unknownAmountCount === 1 ? "is" : "are"} left out.`
            : ""}
        </p>
      </CardContent>
    </Card>
  );
}
