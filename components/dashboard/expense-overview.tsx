"use client";

import { useState } from "react";
import { SpendingChart, type SpendingRow } from "./spending-chart";
import { KindSorter, type SetExpenseKind } from "./kind-sorter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DrillTarget } from "@/lib/dashboard-drill";
import type { ExpenseKind } from "@/lib/expense-kind";
import type { Overview, OverviewItem } from "@/lib/dashboard-overview";

const MAX_BARS = 12;

function whole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function targetOf(item: OverviewItem): DrillTarget {
  return item.lineId ? { kind: "line", lineId: item.lineId } : { kind: "spent" };
}

/** The spending chart with a Fixed / Variable switch. Every bar opens the same drill-down as before. */
export function ExpenseChart({
  overview,
  periodLabel,
  onOpen,
  setKind,
}: {
  overview: Overview;
  periodLabel: string;
  onOpen: (target: DrillTarget, trigger: HTMLElement | null) => void;
  setKind: SetExpenseKind;
}) {
  const [view, setView] = useState<ExpenseKind>("variable");
  const totals = view === "fixed" ? overview.fixed : overview.variable;

  const mine = overview.items
    .filter((i) => i.kind === view && (i.actualCents > 0 || i.budgetCents > 0))
    .sort((a, b) => b.actualCents - a.actualCents || a.name.localeCompare(b.name));
  const shown = mine.slice(0, MAX_BARS);
  const itemByKey = new Map(shown.map((i) => [i.key, i]));
  const rows: SpendingRow[] = shown.map((i) => ({
    lineId: i.key,
    name: i.name,
    budget: i.budgetCents / 100,
    actual: Math.max(i.actualCents, 0) / 100,
  }));
  const hidden = mine.length - shown.length;

  const switcher = (
    <div className="space-y-2">
      <div role="group" aria-label="Which expenses to show" className="inline-flex rounded-md border p-0.5 text-sm">
        {(["variable", "fixed"] as const).map((k) => {
          const t = k === "fixed" ? overview.fixed : overview.variable;
          const on = view === k;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => setView(k)}
              className={`rounded px-3 py-1.5 transition-colors ${on ? "bg-primary text-primary-foreground" : "hover:bg-accent/50"}`}
            >
              {k === "fixed" ? "Fixed" : "Variable"}
              <span className="ml-2 text-xs tabular-nums opacity-80">{whole(t.actualCents)}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {view === "fixed"
          ? "Bills that cost about the same every month, like the mortgage, car payment and insurance."
          : "Spending that moves with habits, like groceries, restaurants and clothes. This is where changes make a difference."}{" "}
        <span className="tabular-nums">
          {whole(totals.actualCents)} spent{totals.budgetCents > 0 ? ` of ${whole(totals.budgetCents)} budgeted` : ""} in {periodLabel}.
        </span>
      </p>
    </div>
  );

  return (
    <div className="space-y-3">
      <SpendingChart
        data={rows}
        title={view === "fixed" ? "Fixed expenses" : "Variable expenses"}
        headerExtra={switcher}
        emptyText={view === "fixed" ? "No fixed expenses this month." : "No variable expenses this month."}
        onBarClick={(key, trigger) => {
          const item = itemByKey.get(key);
          if (item) onOpen(targetOf(item), trigger);
        }}
      />
      {hidden > 0 && <p className="text-xs text-muted-foreground">Showing the {MAX_BARS} biggest; {hidden} smaller not shown.</p>}
      {!overview.historyAvailable && (
        <p className="text-xs text-amber-700">Recent months could not be read, so lines you have not sorted yourself are shown as variable.</p>
      )}
      <KindSorter items={overview.items} setKind={setKind} />
    </div>
  );
}

/** The few variable lines most worth a look this month: an observation about the numbers, not advice. */
export function WatchCard({
  overview,
  isCurrentPeriod,
  onOpen,
}: {
  overview: Overview;
  isCurrentPeriod: boolean;
  onOpen: (target: DrillTarget, trigger: HTMLElement | null) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Worth a look</CardTitle>
        <p className="text-xs text-muted-foreground">
          {isCurrentPeriod
            ? "Variable lines over budget, or on pace to pass it at this point in the month."
            : "Variable lines that finished over budget or above their usual month."}
        </p>
      </CardHeader>
      <CardContent>
        {overview.watch.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {overview.variable.count === 0
              ? "No variable spending to review yet."
              : "Every variable line is within budget and its usual range."}
          </p>
        ) : (
          <ul className="divide-y">
            {overview.watch.map((row) => (
              <li key={row.key}>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  onClick={(e) => onOpen(row.lineId ? { kind: "line", lineId: row.lineId } : { kind: "spent" }, e.currentTarget)}
                  className="block w-full py-2 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="block text-sm font-medium">{row.name}</span>
                  <span className="block text-xs text-muted-foreground">{row.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {overview.watch.length > 0 && overview.variableOnTrack > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {overview.variableOnTrack} other variable {overview.variableOnTrack === 1 ? "line is" : "lines are"} on track.
          </p>
        )}
        {isCurrentPeriod && overview.elapsed !== null && (
          <p className="mt-1 text-xs text-muted-foreground">
            Pace assumes spending is even through the month ({Math.round(overview.elapsed * 100)}% of the month is gone).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
