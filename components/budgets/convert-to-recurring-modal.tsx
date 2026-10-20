"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MODAL_OVERLAY, modalPanelClass } from "@/components/ui/modal-frame";
import { cn, formatUSD } from "@/lib/utils";
import {
  convertPreview,
  describeRecurring,
  type ConvertParentLine,
  type ConvertRecurring,
  type ConvertTag,
} from "@/lib/budget-convert-recurring";
import { convertBudgetLineToRecurring, type BudgetLineLocator } from "@/actions/budgets";

interface Props {
  locator: BudgetLineLocator;
  lineName: string;
  lineShortName: string;
  lineBudgeted: number;
  periodLabel: string;
  /** Saved later months that also hold the line (they end too); null = unknown. */
  laterSavedMonths: number | null;
  /** The line's ancestors, nearest first. */
  parents: ConvertTag[];
  defaultParentId: string;
  parentLines: Record<string, ConvertParentLine>;
  recurring: ConvertRecurring[];
  onClose: () => void;
}

export function ConvertToRecurringModal({
  locator,
  lineName,
  lineShortName,
  lineBudgeted,
  periodLabel,
  laterSavedMonths,
  parents,
  defaultParentId,
  parentLines,
  recurring,
  onClose,
}: Props) {
  const router = useRouter();
  const [parentId, setParentId] = useState(defaultParentId);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const parent = parents.find((p) => p.id === parentId) ?? parents[0];
  if (!parent) return null;
  const preview = convertPreview({
    lineShortName,
    lineBudgeted,
    parent,
    parentLine: parentLines[parent.id] ?? null,
    recurring,
  });
  const laterNote =
    laterSavedMonths && laterSavedMonths > 0
      ? ` and the ${laterSavedMonths} later saved month${laterSavedMonths === 1 ? "" : "s"}`
      : "";

  function onConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await convertBudgetLineToRecurring(locator, { parentTagId: parent!.id });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <div className={MODAL_OVERLAY}>
      <div className={cn(modalPanelClass("md"), "bg-background p-6 shadow-xl")}>
        <h2 className="mb-4 text-lg font-semibold">Convert to recurring expense</h2>

        <div className="space-y-4 text-sm">
          <p>
            <span className="font-medium">{lineName}</span> ({formatUSD(lineBudgeted)} monthly) becomes a recurring
            expense under a parent category, and this line ends.
          </p>

          <div className="space-y-1">
            <label htmlFor="convert-parent" className="text-sm font-medium">Parent category</label>
            <select
              id="convert-parent"
              value={parent.id}
              onChange={(e) => setParentId(e.target.value)}
              disabled={pending}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {parents.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {preview.duplicate ? (
              <li>
                <span className="text-foreground">{preview.duplicate.name}</span> is already a recurring expense under{" "}
                {parent.shortName} ({describeRecurring(preview.duplicate)}). Nothing new is added; only the line ends.
              </li>
            ) : (
              <li>
                Adds the recurring expense <span className="text-foreground">{preview.name}</span>,{" "}
                {formatUSD(preview.amountCents / 100)} monthly, linked to {parent.shortName}.
              </li>
            )}
            {preview.parentEffect && <li>{preview.parentEffect}</li>}
            <li>
              The {lineShortName} line ends from {periodLabel}
              {laterNote} on. Earlier months keep it. Its transactions count toward {parent.shortName} when that has a
              budget line.
            </li>
          </ul>

          {error && <p className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} disabled={pending} className="rounded border px-3 py-1.5 text-sm hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={pending}
              className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? "Converting…" : "Convert"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
