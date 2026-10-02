"use client";

import { useState, useRef, useCallback, useEffect, useTransition } from "react";
import Link from "next/link";
import { Prisma } from "@prisma/client";
import { deleteTransaction } from "@/actions/transactions";
import { assignTransactions, markAssigneeTagReviewed, unassignTransaction } from "@/actions/review-assignments";
import {
  assignmentChipLabel,
  assigneeFirstName,
  visibleChipKind,
  type AssignmentChipKind,
} from "@/lib/review-queue";
import { InlineTagCell } from "./inline-tag-cell";
import { InlineProjectCell } from "./inline-project-cell";
import { Card, CardContent } from "@/components/ui/card";
import type { Route } from "next";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TxRow {
  id: string;
  postedAt: string;
  payeeRaw: string | null;
  payeeNormalized: string | null;
  description: string | null;
  amount: string;
  accountId: string;
  accountNickname: string;
  accountMask: string | null;
  tagIds: string[];
  projectId: string | null;
  transferPairId: string | null;
  /** Assignment chip to show under the payee (assign-to-review feature); null = none. */
  assignKind?: AssignmentChipKind | null;
  /** Why this row can't be selected for assignment; null/undefined = selectable. Only meaningful when `assign` is set. */
  assignDisabledReason?: string | null;
}

/** Present only on buckets where assignment is allowed (Personal, Sudden Valley). */
export interface AssignConfig {
  assigneeName: string;
}

export interface TagOption {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

export interface ProjectOption {
  id: string;
  name: string;
}

interface Props {
  transactions: TxRow[];
  allTags: TagOption[];
  allProjects: ProjectOption[];
  assign?: AssignConfig | null;
}

// ── Column definitions ────────────────────────────────────────────────────────

const COLS = [
  { key: "date",    label: "Date",    defaultWidth: 100, alignRight: false },
  { key: "payee",   label: "Payee",   defaultWidth: 280, alignRight: false },
  { key: "amount",  label: "Amount",  defaultWidth: 96,  alignRight: true  },
  { key: "account", label: "Account", defaultWidth: 130, alignRight: false },
  { key: "tags",    label: "Tags",    defaultWidth: 110, alignRight: false },
  { key: "project", label: "Project", defaultWidth: 110, alignRight: false },
] as const;

type ColKey = typeof COLS[number]["key"];

const ACTIONS_WIDTH = 60;
// Fixed leading checkbox column (assignment). Deliberately outside COLS and the
// persisted width map so resize logic and the saved widths key are untouched.
const CHECK_WIDTH = 36;
const MIN_WIDTH = 40;
const STORAGE_KEY = "txn-col-widths-v1";

function loadWidths(): Record<ColKey, number> {
  const defaults = Object.fromEntries(COLS.map((c) => [c.key, c.defaultWidth])) as Record<ColKey, number>;
  if (typeof window === "undefined") return defaults;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Record<ColKey, number>>;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

// ── Formatting ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(new Date(iso));
}

function formatAmount(amountStr: string) {
  const d = new Prisma.Decimal(amountStr);
  const isOutflow = d.isNegative();
  const display = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(d.abs().toNumber());
  return { display, isOutflow };
}

// ── Component ──────────────────────────────────────────────────────────────────

export function TransactionsTable({ transactions, allTags, allProjects, assign = null }: Props) {
  const hasProjects = allProjects.length > 0;
  const visibleCols = COLS.filter((c) => c.key !== "project" || hasProjects);
  const canAssign = assign !== null;

  const [widths, setWidths] = useState<Record<ColKey, number>>(loadWidths);

  // ── Assignment (Eric-side) ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignError, setAssignError] = useState<string | null>(null);
  const [isAssigning, startAssign] = useTransition();
  const [isUnassigning, startUnassign] = useTransition();

  const selectableIds = transactions
    .filter((t) => !t.assignDisabledReason)
    .map((t) => t.id);
  const selectedOnPage = selectableIds.filter((id) => selected.has(id));
  const allSelected = selectableIds.length > 0 && selectedOnPage.length === selectableIds.length;
  const someSelected = selectedOnPage.length > 0 && !allSelected;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  }

  function handleAssign() {
    const ids = selectedOnPage;
    if (ids.length === 0) return;
    setAssignError(null);
    startAssign(async () => {
      const result = await assignTransactions(ids);
      if (!result.ok) {
        setAssignError(result.error);
        return;
      }
      if (result.rejected.length > 0) {
        const first = result.rejected[0]!;
        setAssignError(
          `${result.rejected.length} not assigned: ${first.message}` +
            (result.rejected.length > 1 ? " (and others)" : "")
        );
      }
      setSelected(new Set());
    });
  }

  function handleReviewed(id: string) {
    setAssignError(null);
    startUnassign(async () => {
      const result = await markAssigneeTagReviewed(id);
      if (!result.ok) setAssignError(result.error);
    });
  }

  function handleUnassign(id: string) {
    setAssignError(null);
    startUnassign(async () => {
      const result = await unassignTransaction(id);
      if (!result.ok) setAssignError(result.error);
    });
  }

  const tableRef = useRef<HTMLTableElement>(null);
  const dragRef = useRef<{
    key: ColKey;
    colIndex: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  // Persist to localStorage whenever widths change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {}
  }, [widths]);

  const startResize = useCallback(
    (key: ColKey, colIndex: number, e: React.MouseEvent) => {
      e.preventDefault();
      const startWidth = widths[key];
      dragRef.current = { key, colIndex, startX: e.clientX, startWidth };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      function onMove(ev: MouseEvent) {
        if (!dragRef.current) return;
        const newW = Math.max(MIN_WIDTH, startWidth + ev.clientX - dragRef.current.startX);
        const col = tableRef.current?.querySelectorAll("col")[colIndex];
        if (col) (col as HTMLElement).style.width = `${newW}px`;
      }

      function onUp(ev: MouseEvent) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (!dragRef.current) return;
        const newW = Math.max(MIN_WIDTH, startWidth + ev.clientX - dragRef.current.startX);
        setWidths((prev) => ({ ...prev, [key]: newW }));
        dragRef.current = null;
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [widths]
  );

  const resetWidth = useCallback((key: ColKey) => {
    const def = COLS.find((c) => c.key === key)?.defaultWidth ?? 100;
    setWidths((prev) => ({ ...prev, [key]: def }));
  }, []);

  return (
    <Card>
      <CardContent className="p-0">
        <table ref={tableRef} className="w-full text-sm table-fixed">
          <colgroup>
            {canAssign && <col style={{ width: `${CHECK_WIDTH}px` }} />}
            {visibleCols.map((c) => (
              <col key={c.key} style={{ width: `${widths[c.key]}px` }} />
            ))}
            <col style={{ width: `${ACTIONS_WIDTH}px` }} />
          </colgroup>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {canAssign && (
                <th className="px-2 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all assignable transactions on this page"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    disabled={selectableIds.length === 0}
                    onChange={toggleAll}
                  />
                </th>
              )}
              {visibleCols.map((c, i) => (
                <th
                  key={c.key}
                  className={`relative px-2 py-3 font-medium select-none ${c.alignRight ? "text-right" : ""}`}
                >
                  {c.label}
                  {/* Resize handle */}
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-border active:bg-primary/30 z-10"
                    onMouseDown={(e) => startResize(c.key, i, e)}
                    onDoubleClick={() => resetWidth(c.key)}
                  />
                </th>
              ))}
              <th className="px-2 py-3" />
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 && (
              <tr>
                <td
                  colSpan={visibleCols.length + 1 + (canAssign ? 1 : 0)}
                  className="px-2 py-8 text-center text-muted-foreground"
                >
                  No transactions found
                </td>
              </tr>
            )}
            {transactions.map((tx) => {
              const { display, isOutflow } = formatAmount(tx.amount);
              const isTransfer = tx.transferPairId !== null;
              // A row that already has tags is no longer "with Eva" in any useful
              // sense (Eric or a rule tagged it since): hide a stale chip.
              const chipKind = visibleChipKind(tx.assignKind ?? null, tx.tagIds.length);
              return (
                <tr
                  key={tx.id}
                  className={`border-b last:border-0 hover:bg-muted/30 ${isTransfer ? "opacity-70" : ""}`}
                >
                  {canAssign && (
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${tx.payeeRaw ?? tx.payeeNormalized ?? "transaction"} for assignment`}
                        checked={selected.has(tx.id)}
                        disabled={!!tx.assignDisabledReason}
                        title={tx.assignDisabledReason ?? undefined}
                        onChange={() => toggleOne(tx.id)}
                      />
                    </td>
                  )}
                  <td className="px-2 py-2 text-muted-foreground whitespace-nowrap text-xs">
                    {formatDate(tx.postedAt)}
                  </td>
                  <td className="px-2 py-2 min-w-0">
                    <Link
                      href={`/transactions/${tx.id}` as Route}
                      className="font-medium hover:underline block truncate"
                    >
                      {tx.payeeRaw ?? tx.payeeNormalized ?? "—"}
                    </Link>
                    {tx.description && (
                      <p className="text-xs text-muted-foreground truncate">{tx.description}</p>
                    )}
                    {canAssign && chipKind && (
                      <span
                        className={`mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          chipKind === "returned"
                            ? "bg-amber-100 text-amber-800"
                            : chipKind === "tagged_by_assignee"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-primary/10 text-primary"
                        }`}
                      >
                        {assignmentChipLabel(chipKind, assign.assigneeName)}
                        {chipKind === "draft" && (
                          <button
                            type="button"
                            aria-label="Remove from draft"
                            title="Remove from draft"
                            disabled={isUnassigning}
                            onClick={() => handleUnassign(tx.id)}
                            className="hover:text-destructive disabled:opacity-50"
                          >
                            ×
                          </button>
                        )}
                        {chipKind === "tagged_by_assignee" && (
                          <button
                            type="button"
                            aria-label="Mark as reviewed"
                            title="Mark as reviewed (removes this badge)"
                            disabled={isUnassigning}
                            onClick={() => handleReviewed(tx.id)}
                            className="hover:text-destructive disabled:opacity-50"
                          >
                            ×
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td
                    className={`px-2 py-2 text-right font-mono font-medium whitespace-nowrap text-xs ${
                      isOutflow ? "text-destructive" : "text-green-600"
                    }`}
                  >
                    {isOutflow ? "-" : "+"}
                    {display}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground text-xs min-w-0">
                    <span className="block truncate">{tx.accountNickname}</span>
                    <span className="text-muted-foreground/70">···{tx.accountMask}</span>
                  </td>
                  <td className="px-2 py-2">
                    <InlineTagCell
                      transactionId={tx.id}
                      allTags={allTags}
                      initialTagIds={tx.tagIds}
                      payeeNormalized={tx.payeeNormalized ?? tx.payeeRaw ?? undefined}
                      defaultAmount={Math.abs(Number(tx.amount)).toFixed(2)}
                      accountId={tx.accountId}
                      accountNickname={tx.accountNickname}
                      accountMask={tx.accountMask}
                    />
                  </td>
                  {hasProjects && (
                    <td className="px-2 py-2">
                      <InlineProjectCell
                        transactionId={tx.id}
                        projects={allProjects}
                        initialProjectId={tx.projectId}
                      />
                    </td>
                  )}
                  <td className="px-2 py-2">
                    <form action={async () => { await deleteTransaction(tx.id); }}>
                      <button
                        type="submit"
                        className="text-xs text-muted-foreground hover:text-destructive"
                      >
                        Delete
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
      {canAssign && (selectedOnPage.length > 0 || assignError) && (
        <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg">
          {selectedOnPage.length > 0 && (
            <>
              <span className="text-sm">{selectedOnPage.length} selected</span>
              <button
                type="button"
                onClick={handleAssign}
                disabled={isAssigning}
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {isAssigning
                  ? "Assigning…"
                  : `Assign ${selectedOnPage.length} to ${assigneeFirstName(assign.assigneeName)}`}
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            </>
          )}
          {assignError && (
            <span role="alert" className="max-w-xs text-xs text-destructive">
              {assignError}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
