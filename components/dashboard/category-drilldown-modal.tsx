"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getTagTransactions, type DashboardTransaction } from "@/actions/dashboard";
import { updateBudgetLine } from "@/actions/budgets";
import { InlineTagCell } from "@/components/transactions/inline-tag-cell";

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface Props {
  tagId: string;
  tagShortName: string;
  budgetId: string | null;
  budgeted: number;
  spent: number;
  period: string;
  entityId: string | undefined;
  allTags: Tag[];
  onClose: () => void;
}

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

export function CategoryDrilldownModal({
  tagId,
  tagShortName,
  budgetId,
  budgeted,
  spent,
  period,
  entityId,
  allTags,
  onClose,
}: Props) {
  const router = useRouter();
  const [transactions, setTransactions] = useState<DashboardTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState(budgeted > 0 ? budgeted.toFixed(2) : "");
  const [budgetSaving, startBudgetSave] = useTransition();
  const [budgetError, setBudgetError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getTagTransactions(tagId, period, entityId)
      .then(setTransactions)
      .finally(() => setLoading(false));
  }, [tagId, period, entityId]);

  function saveBudget() {
    if (!budgetId) return;
    setBudgetError(null);
    startBudgetSave(async () => {
      const result = await updateBudgetLine(budgetId, budgetInput);
      if ("error" in result) {
        setBudgetError(result.error);
      } else {
        setEditingBudget(false);
        router.refresh();
      }
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full sm:max-w-2xl bg-background rounded-t-xl sm:rounded-xl shadow-xl flex flex-col max-h-[85vh] sm:max-h-[80vh]">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b gap-4">
          <div className="space-y-1 flex-1 min-w-0">
            <h2 className="font-semibold text-lg">{tagShortName}</h2>
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
              <span>
                Spent: <span className={`font-medium ${spent > budgeted && budgeted > 0 ? "text-destructive" : "text-foreground"}`}>{fmt(Math.abs(spent))}</span>
              </span>
              {budgetId ? (
                <span className="flex items-center gap-1">
                  Budget:{" "}
                  {editingBudget ? (
                    <span className="flex items-center gap-1">
                      $
                      <input
                        autoFocus
                        value={budgetInput}
                        onChange={(e) => setBudgetInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveBudget(); if (e.key === "Escape") setEditingBudget(false); }}
                        className="w-24 rounded border border-input bg-background px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <button
                        type="button"
                        onClick={saveBudget}
                        disabled={budgetSaving}
                        className="text-xs text-primary hover:underline disabled:opacity-50"
                      >
                        {budgetSaving ? "Saving…" : "Save"}
                      </button>
                      <button type="button" onClick={() => setEditingBudget(false)} className="text-xs text-muted-foreground hover:text-foreground">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingBudget(true)}
                      className="font-medium text-foreground hover:text-primary underline-offset-2 hover:underline"
                      title="Click to edit budget"
                    >
                      {fmt(budgeted)}
                    </button>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground italic">No budget set</span>
              )}
            </div>
            {budgetError && <p className="text-xs text-destructive">{budgetError}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-xl leading-none shrink-0 mt-0.5"
          >
            ×
          </button>
        </div>

        {/* Transaction list */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
          )}
          {!loading && transactions.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No transactions tagged {tagShortName} this month.
            </div>
          )}
          {!loading && transactions.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Payee</th>
                  <th className="px-4 py-2 font-medium">Tags</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{fmtDate(tx.postedAt)}</td>
                    <td className="px-4 py-2 max-w-[200px] truncate">{tx.payeeRaw}</td>
                    <td className="px-4 py-2">
                      <InlineTagCell
                        transactionId={tx.id}
                        allTags={allTags}
                        initialTagIds={tx.tagIds}
                      />
                    </td>
                    <td className={`px-4 py-2 text-right font-mono font-medium whitespace-nowrap ${tx.amountNum < 0 ? "text-destructive" : "text-green-600"}`}>
                      {tx.amount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="border-t p-3 text-right">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 h-9 text-sm hover:bg-accent"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
