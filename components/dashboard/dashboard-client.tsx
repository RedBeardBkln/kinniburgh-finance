"use client";

import { useState } from "react";
import { SpendingChart, type SpendingRow } from "./spending-chart";
import { SpendCategoryCards } from "./spend-category-cards";
import { CategoryDrilldownModal } from "./category-drilldown-modal";

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

export interface SerializedBudget {
  id: string;
  tagId: string;
  tagShortName: string;
  budgeted: number;
  spent: number;
  percentUsed: number;
  isOverspent: boolean;
}

interface Props {
  chartData: SpendingRow[];
  budgets: SerializedBudget[];
  allTags: Tag[];
  entityId: string | undefined;
  period: string;
  children: React.ReactNode;
}

export function DashboardClient({
  chartData,
  budgets,
  allTags,
  entityId,
  period,
  children,
}: Props) {
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);

  const selectedBudget = selectedTagId
    ? budgets.find((b) => b.tagId === selectedTagId) ?? null
    : null;

  // Top 6 by spend for the cards
  const topCards = [...budgets]
    .sort((a, b) => Math.abs(b.spent) - Math.abs(a.spent))
    .slice(0, 6)
    .map((b) => ({
      tagId: b.tagId,
      tagShortName: b.tagShortName,
      budgeted: b.budgeted,
      spent: Math.abs(b.spent),
      percentUsed: b.percentUsed,
      isOverspent: b.isOverspent,
    }));

  return (
    <>
      <div className="space-y-6">
        {/* Spend category cards — top 6 */}
        {topCards.length > 0 && (
          <SpendCategoryCards cards={topCards} onSelect={setSelectedTagId} />
        )}

        {/* Spending chart — clickable */}
        <SpendingChart data={chartData} onBarClick={setSelectedTagId} />

        {/* Budget lines table + accounts grid passed as children from server */}
        {children}
      </div>

      {selectedTagId && selectedBudget && (
        <CategoryDrilldownModal
          tagId={selectedTagId}
          tagShortName={selectedBudget.tagShortName}
          budgetId={selectedBudget.id}
          budgeted={selectedBudget.budgeted}
          spent={selectedBudget.spent}
          period={period}
          entityId={entityId}
          allTags={allTags}
          onClose={() => setSelectedTagId(null)}
        />
      )}
    </>
  );
}
