"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BudgetEditModal } from "./budget-edit-modal";
import { deleteBudget } from "@/actions/budgets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BudgetLineEditor } from "./budget-line-editor";
import { formatUSD } from "@/lib/utils";

export interface SerializedBudgetLine {
  id: string;
  tagId: string;
  tagName: string;
  accountId: string;
  accountName: string;
  budgeted: number;
  payDay: number | null;
  rolloverAmount: number;
  effectiveBudget: number;
  actualSpend: number;
  remaining: number;
  percentUsed: number;
  isOverspent: boolean;
}

export interface SerializedAccount {
  id: string;
  nickname: string;
  mask: string | null;
}

export interface SerializedTag {
  id: string;
  name: string;
  shortName: string;
}

interface BudgetPageClientProps {
  budgets: SerializedBudgetLine[];
  accounts: SerializedAccount[];
  tags: SerializedTag[];
  entityId: string;
  period: string;
  totalBudgeted: number;
  totalActual: number;
  totalRemaining: number;
  periodLabel: string;
  entityName: string;
}

interface BudgetRowForEdit {
  id: string;
  tagId: string;
  tagName: string;
  accountId: string;
  budgeted: string;
  payDay: number | null;
}

export function BudgetPageClient({
  budgets,
  accounts,
  tags,
  entityId,
  period,
  totalBudgeted,
  totalActual,
  totalRemaining,
  periodLabel,
  entityName,
}: BudgetPageClientProps) {
  const router = useRouter();
  const [modal, setModal] = useState<
    | { type: "add" }
    | { type: "edit"; row: BudgetRowForEdit }
    | null
  >(null);
  const [sortBy, setSortBy] = useState<"alpha" | "due-date">("alpha");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function onEdit(b: SerializedBudgetLine) {
    setModal({
      type: "edit",
      row: {
        id: b.id,
        tagId: b.tagId,
        tagName: b.tagName,
        accountId: b.accountId,
        budgeted: b.budgeted.toFixed(2),
        payDay: b.payDay,
      },
    });
  }

  function onDelete(id: string) {
    if (!confirm("Delete this budget line? The linked scheduled bill will also be deactivated.")) return;
    setDeletingId(id);
    startTransition(async () => {
      await deleteBudget(id);
      setDeletingId(null);
      router.refresh();
    });
  }

  // Group by account name, then sort within each group
  const byAccount = new Map<string, SerializedBudgetLine[]>();
  for (const b of budgets) {
    if (!byAccount.has(b.accountName)) byAccount.set(b.accountName, []);
    byAccount.get(b.accountName)!.push(b);
  }
  const sortFn = sortBy === "alpha"
    ? (a: SerializedBudgetLine, b: SerializedBudgetLine) => a.tagName.localeCompare(b.tagName)
    : (a: SerializedBudgetLine, b: SerializedBudgetLine) => (a.payDay ?? 99) - (b.payDay ?? 99);
  for (const [key, lines] of byAccount) {
    byAccount.set(key, [...lines].sort(sortFn));
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Budget Report</h1>
            <p className="text-sm text-muted-foreground">
              {entityName} · {periodLabel}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border text-xs font-medium overflow-hidden">
              <button
                onClick={() => setSortBy("alpha")}
                className={`px-3 py-1.5 transition-colors ${sortBy === "alpha" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                A–Z
              </button>
              <button
                onClick={() => setSortBy("due-date")}
                className={`px-3 py-1.5 border-l transition-colors ${sortBy === "due-date" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                By Due Date
              </button>
            </div>
            <button
              onClick={() => setModal({ type: "add" })}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              + Add Budget Line
            </button>
          </div>
        </div>

        {/* Summary totals */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Budgeted</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{formatUSD(totalBudgeted)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Spent</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-destructive">
                {formatUSD(Math.abs(totalActual))}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Remaining</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${totalRemaining < 0 ? "text-destructive" : "text-green-600"}`}>
                {formatUSD(totalRemaining)}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Per-account budget sections */}
        {[...byAccount.entries()].map(([accountName, lines]) => {
          const accountTotal = lines.reduce((s, b) => s + b.budgeted, 0);
          return (
            <Card key={accountName}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>{accountName}</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {formatUSD(accountTotal)} budgeted
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Category</th>
                      <th className="px-4 py-2 font-medium">Due Date</th>
                      <th className="px-4 py-2 font-medium text-right">Budgeted</th>
                      <th className="px-4 py-2 font-medium text-right">Rollover</th>
                      <th className="px-4 py-2 font-medium text-right">Effective</th>
                      <th className="px-4 py-2 font-medium text-right">Spent</th>
                      <th className="px-4 py-2 font-medium text-right">Remaining</th>
                      <th className="px-4 py-2 font-medium">%</th>
                      <th className="px-4 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((b) => (
                      <tr
                        key={b.id}
                        className={`border-b last:border-0 hover:bg-muted/30 ${deletingId === b.id ? "opacity-50" : ""}`}
                      >
                        <td className="px-4 py-2 font-medium">{b.tagName}</td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {b.payDay ? (
                            <span className="text-foreground">{ordinal(b.payDay)}</span>
                          ) : (
                            <span className="text-xs">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <BudgetLineEditor
                            budgetId={b.id}
                            currentBudgeted={b.budgeted}
                          />
                        </td>
                        <td className={`px-4 py-2 text-right text-xs ${b.rolloverAmount < 0 ? "text-destructive" : b.rolloverAmount === 0 ? "text-muted-foreground" : "text-green-600"}`}>
                          {b.rolloverAmount === 0 ? "—" : formatUSD(b.rolloverAmount)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {formatUSD(b.effectiveBudget)}
                        </td>
                        <td className="px-4 py-2 text-right text-destructive">
                          {formatUSD(Math.abs(b.actualSpend))}
                        </td>
                        <td className={`px-4 py-2 text-right font-medium ${b.isOverspent ? "text-destructive" : ""}`}>
                          {formatUSD(b.remaining)}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5">
                            <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                              <div
                                className={`h-full rounded-full ${b.isOverspent ? "bg-destructive" : "bg-primary"}`}
                                style={{ width: `${Math.min(b.percentUsed, 100)}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {Math.round(b.percentUsed)}%
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => onEdit(b)}
                              className="text-xs text-primary hover:underline"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => onDelete(b.id)}
                              disabled={deletingId === b.id}
                              className="text-xs text-destructive hover:underline disabled:opacity-50"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          );
        })}

        {budgets.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No budget lines found for {periodLabel}.{" "}
              <button
                onClick={() => setModal({ type: "add" })}
                className="text-primary hover:underline"
              >
                Add one now.
              </button>
            </CardContent>
          </Card>
        )}
      </div>

      {modal?.type === "add" && (
        <BudgetEditModal
          mode="add"
          accounts={accounts}
          tags={tags}
          entityId={entityId}
          period={period}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.type === "edit" && (
        <BudgetEditModal
          mode="edit"
          budget={modal.row}
          accounts={accounts}
          entityId={entityId}
          period={period}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
