"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createBudget, updateBudget } from "@/actions/budgets";

interface Account {
  id: string;
  nickname: string;
  mask: string | null;
}

interface Tag {
  id: string;
  name: string;
  shortName: string;
}

const FREQUENCY_OPTIONS: { value: "monthly" | "weekly" | "biweekly"; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
];

// Matches the default used elsewhere in this app (actions/envelope.ts's
// approveSlushSchema for the Slush Funds weekly transfer approval UI).
const DAY_OF_WEEK_OPTIONS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

interface BudgetEditModalProps {
  mode: "edit" | "add";
  budget?: {
    id: string;
    tagId: string;
    tagName: string;
    accountId: string;
    budgeted: string;
    payDay: number | null;
    frequency: string;
    payDayOfWeek: number | null;
    biweeklyAnchorDate: string | null;
  };
  accounts: Account[];
  tags?: Tag[];
  entityId: string;
  period: string;
  onClose: () => void;
}

export function BudgetEditModal({
  mode,
  budget,
  accounts,
  tags,
  entityId,
  period,
  onClose,
}: BudgetEditModalProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [tagId, setTagId] = useState(budget?.tagId ?? "");
  const [budgeted, setBudgeted] = useState(budget?.budgeted ?? "");
  const [payDayStr, setPayDayStr] = useState(budget?.payDay?.toString() ?? "");
  const [accountId, setAccountId] = useState(budget?.accountId ?? accounts[0]?.id ?? "");
  const [frequency, setFrequency] = useState<"monthly" | "weekly" | "biweekly">(
    (budget?.frequency as "monthly" | "weekly" | "biweekly" | undefined) ?? "monthly"
  );
  const [payDayOfWeekStr, setPayDayOfWeekStr] = useState(
    budget?.payDayOfWeek !== null && budget?.payDayOfWeek !== undefined ? budget.payDayOfWeek.toString() : "1"
  );
  const [biweeklyAnchorDate, setBiweeklyAnchorDate] = useState(
    budget?.biweeklyAnchorDate ? budget.biweeklyAnchorDate.slice(0, 10) : ""
  );
  const [applyToFuture, setApplyToFuture] = useState(false);

  const originalPayDay = budget?.payDay ?? null;
  const originalAccountId = budget?.accountId ?? null;
  const originalFrequency = budget?.frequency ?? "monthly";
  const originalPayDayOfWeek = budget?.payDayOfWeek ?? null;
  const originalBiweeklyAnchorDate = budget?.biweeklyAnchorDate ? budget.biweeklyAnchorDate.slice(0, 10) : "";

  const payDayChanged = payDayStr !== (originalPayDay?.toString() ?? "");
  const accountChanged = accountId !== originalAccountId;
  const frequencyChanged = frequency !== originalFrequency;
  const payDayOfWeekChanged =
    frequency !== "monthly" && payDayOfWeekStr !== (originalPayDayOfWeek?.toString() ?? "");
  const biweeklyAnchorChanged = frequency === "biweekly" && biweeklyAnchorDate !== originalBiweeklyAnchorDate;
  const showApplyTo =
    mode === "edit" &&
    (payDayChanged || accountChanged || frequencyChanged || payDayOfWeekChanged || biweeklyAnchorChanged);

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const payDay = frequency === "monthly" && payDayStr ? parseInt(payDayStr, 10) : undefined;
      const payDayOfWeek = frequency !== "monthly" ? parseInt(payDayOfWeekStr, 10) : null;
      const anchorDate = frequency === "biweekly" ? biweeklyAnchorDate || null : null;

      let result: { success: true } | { error: string };

      if (mode === "add") {
        if (!tagId) {
          setError("Please select a category");
          return;
        }
        result = await createBudget({
          tagId,
          entityId,
          accountId,
          period,
          budgeted,
          payDay,
          frequency,
          payDayOfWeek,
          biweeklyAnchorDate: anchorDate,
        });
      } else {
        result = await updateBudget(budget!.id, {
          budgeted,
          payDay: frequency === "monthly" ? (payDayStr ? parseInt(payDayStr, 10) : null) : null,
          accountId,
          applyToFuture,
          frequency,
          payDayOfWeek,
          biweeklyAnchorDate: anchorDate,
        });
      }

      if ("error" in result) {
        setError(result.error);
        return;
      }

      router.refresh();
      onClose();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">
          {mode === "add" ? "Add Budget Line" : "Edit Budget Line"}
        </h2>

        <div className="space-y-4">
          {/* Category */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Category</label>
            {mode === "edit" ? (
              <p className="rounded border bg-muted px-3 py-2 text-sm">{budget?.tagName}</p>
            ) : (
              <select
                value={tagId}
                onChange={(e) => setTagId(e.target.value)}
                className="w-full rounded border px-3 py-2 text-sm"
                required
              >
                <option value="">Select a category…</option>
                {tags?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Budgeted amount */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Monthly Budget</label>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={budgeted}
                onChange={(e) => setBudgeted(e.target.value)}
                placeholder="0.00"
                className="w-full rounded border px-3 py-2 text-sm"
              />
            </div>
            <p className="text-xs text-muted-foreground">Leave blank to auto-sum nested budget lines</p>
          </div>

          {/* Frequency */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Frequency</label>
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as "monthly" | "weekly" | "biweekly")}
              className="w-full rounded border px-3 py-2 text-sm"
            >
              {FREQUENCY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Due date */}
          {frequency === "monthly" ? (
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Due Date <span className="text-muted-foreground font-normal">(day of month, optional)</span>
              </label>
              <input
                type="number"
                min="1"
                max="31"
                value={payDayStr}
                onChange={(e) => setPayDayStr(e.target.value)}
                placeholder="e.g. 15"
                className="w-full rounded border px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank if this is not a recurring monthly bill
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-sm font-medium">Day of Week</label>
                <select
                  value={payDayOfWeekStr}
                  onChange={(e) => setPayDayOfWeekStr(e.target.value)}
                  className="w-full rounded border px-3 py-2 text-sm"
                >
                  {DAY_OF_WEEK_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              {frequency === "biweekly" && (
                <div className="space-y-1">
                  <label className="text-sm font-medium">Anchor Date</label>
                  <input
                    type="date"
                    value={biweeklyAnchorDate}
                    onChange={(e) => setBiweeklyAnchorDate(e.target.value)}
                    className="w-full rounded border px-3 py-2 text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    The most recent or an upcoming payment date — anchors the 14-day cycle.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Account */}
          <div className="space-y-1">
            <label className="text-sm font-medium">Pay from Account</label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full rounded border px-3 py-2 text-sm"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nickname}{a.mask ? ` ···${a.mask}` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Apply to (edit mode only, when payDay or account changed) */}
          {showApplyTo && (
            <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-medium">Apply changes to:</p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="applyTo"
                  checked={!applyToFuture}
                  onChange={() => setApplyToFuture(false)}
                />
                This month only
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="applyTo"
                  checked={applyToFuture}
                  onChange={() => setApplyToFuture(true)}
                />
                This month and all future months
              </label>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={isPending}
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
