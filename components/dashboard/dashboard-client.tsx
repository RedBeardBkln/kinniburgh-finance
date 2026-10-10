"use client";

import { useCallback, useMemo, useState } from "react";
import { SpendingChart, type SpendingRow } from "./spending-chart";
import { SpendCategoryCards, type CategoryCard } from "./spend-category-cards";
import { DrilldownDialog } from "./drilldown-dialog";
import { DrillContext } from "./drill-context";
import type { DrillData, DrillTarget } from "@/lib/dashboard-drill";

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface Props {
  /** The month's numbers and the transactions behind them; null when they could not be loaded. */
  data: DrillData | null;
  allTags: Tag[];
  children: React.ReactNode;
}

/**
 * Owns the drill-down: the server page hands over one payload, any card, bar, row or table line below this component
 * can open a dialog for its own number through the context (see DrillButton), and every dialog is built from that
 * same payload, so the rows always add up to the number clicked.
 */
export function DashboardClient({ data, allTags, children }: Props) {
  const [active, setActive] = useState<{ target: DrillTarget; trigger: HTMLElement | null } | null>(null);

  const open = useCallback((target: DrillTarget, trigger?: HTMLElement | null) => {
    setActive({ target, trigger: trigger ?? null });
  }, []);
  const close = useCallback(() => setActive(null), []);

  // Top-level lines only (a parent already includes its nested lines), biggest spend first.
  const roots = useMemo(
    () => (data ? data.lines.filter((l) => l.parentId === null).sort((a, b) => b.rolledCents - a.rolledCents) : []),
    [data]
  );

  const topCards: CategoryCard[] = roots
    .filter((l) => l.rolledCents > 0 || l.budgetCents > 0)
    .slice(0, 6)
    .map((l) => ({
      lineId: l.id,
      name: l.shortName,
      budgeted: l.effectiveCents / 100,
      spent: Math.max(l.rolledCents, 0) / 100,
      percentUsed: l.percentUsed,
      isOverspent: l.overspent,
    }));

  const chartData: SpendingRow[] = roots
    .filter((l) => l.budgetCents > 0 || l.rolledCents > 0)
    .slice(0, 10)
    .map((l) => ({
      lineId: l.id,
      name: l.shortName,
      budget: l.effectiveCents / 100,
      actual: Math.max(l.rolledCents, 0) / 100,
    }));

  return (
    <DrillContext.Provider value={{ data, open }}>
      <div className="space-y-6">
        {/* Spend category cards: top 6 top-level lines */}
        {topCards.length > 0 && <SpendCategoryCards cards={topCards} onSelect={(id, el) => open({ kind: "line", lineId: id }, el)} />}

        {/* Spending chart: every bar opens its line */}
        {data && <SpendingChart data={chartData} onBarClick={(id, el) => open({ kind: "line", lineId: id }, el)} />}

        {/* Summary cards, budget lines table and accounts grid are passed as children from the server */}
        {children}
      </div>

      {data && active && (
        <DrilldownDialog
          key={JSON.stringify(active.target)}
          data={data}
          target={active.target}
          allTags={allTags}
          returnFocusTo={active.trigger}
          onClose={close}
        />
      )}
    </DrillContext.Provider>
  );
}
