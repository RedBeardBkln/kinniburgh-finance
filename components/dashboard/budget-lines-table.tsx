"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDrill } from "./drill-context";
import { centsText, type DrillLine } from "@/lib/dashboard-drill";

/**
 * The dashboard's Budget Lines table: grouped by account, a parent line above its indented children (the same nesting
 * and order as /budgets), parent totals include their nested lines, and each parent can be collapsed. Every line opens
 * its own drill-down. Reads the month's numbers from the drill payload so the table, the cards and the dialogs share
 * one set of figures.
 */
export function BudgetLinesTable({ budgetsHref }: { budgetsHref: string }) {
  const { data, open } = useDrill();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const lineById = useMemo(() => new Map((data?.lines ?? []).map((l) => [l.id, l])), [data]);
  const parentIds = useMemo(() => (data?.lines ?? []).filter((l) => l.hasChildren).map((l) => l.id), [data]);

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          Budget Lines
          <span className="flex items-center gap-3 text-sm font-normal">
            {parentIds.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setCollapsed(new Set())}
                  className="text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Expand all
                </button>
                <button
                  type="button"
                  onClick={() => setCollapsed(new Set(parentIds))}
                  className="text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Collapse all
                </button>
              </>
            )}
            <Link href={budgetsHref as Route} className="text-muted-foreground underline-offset-4 hover:underline">
              Full report →
            </Link>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!data ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Budget lines are unavailable right now. The rest of the page is unaffected.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Category</th>
                  <th className="px-4 py-2 font-medium text-right">Budget</th>
                  <th className="px-4 py-2 font-medium text-right">Spent</th>
                  <th className="px-4 py-2 font-medium text-right">Remaining</th>
                  <th className="px-4 py-2 font-medium">Progress</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                      No budget lines for {data.periodLabel}
                    </td>
                  </tr>
                )}
                {data.groups.map((group) => {
                  const lines = group.lineIds
                    .map((id) => lineById.get(id))
                    .filter((l): l is DrillLine => l !== undefined)
                    .filter((l) => !l.ancestorIds.some((a) => collapsed.has(a)));
                  return (
                    <Fragment key={group.accountId}>
                      <tr className="border-b bg-muted/40">
                        <th scope="colgroup" colSpan={2} className="px-4 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {group.accountName}
                        </th>
                        <td colSpan={3} className="px-4 py-1.5 text-right text-xs text-muted-foreground">
                          {centsText(group.budgetCents)} budgeted · {centsText(group.spentCents)} spent (top-level lines)
                        </td>
                      </tr>
                      {lines.map((line) => (
                        <LineRow
                          key={line.id}
                          line={line}
                          isCollapsed={collapsed.has(line.id)}
                          onToggle={() => toggle(line.id)}
                          onOpen={(el) => open({ kind: "line", lineId: line.id }, el)}
                        />
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LineRow({
  line,
  isCollapsed,
  onToggle,
  onOpen,
}: {
  line: DrillLine;
  isCollapsed: boolean;
  onToggle: () => void;
  onOpen: (el: HTMLElement | null) => void;
}) {
  const name = line.depth > 0 ? line.shortName : line.label;
  const over = line.overspent;
  return (
    <tr
      className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
      onClick={(e) => onOpen(e.currentTarget.querySelector<HTMLElement>("[data-line-open]"))}
    >
      <td className="px-4 py-2" style={line.depth > 0 ? { paddingLeft: `${16 + line.depth * 20}px` } : undefined}>
        <span className="inline-flex items-center gap-1">
          {line.depth > 0 && <span className="text-muted-foreground">└</span>}
          {line.hasChildren ? (
            <button
              type="button"
              aria-expanded={!isCollapsed}
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${line.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="w-4 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {isCollapsed ? "▸" : "▾"}
            </button>
          ) : (
            <span className="w-4" />
          )}
          <button
            type="button"
            data-line-open
            aria-haspopup="dialog"
            aria-label={`Show what makes up ${line.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(e.currentTarget);
            }}
            className="text-left font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {name}
          </button>
          {line.hasChildren && isCollapsed && <span className="text-xs text-muted-foreground">({line.childIds.length} nested)</span>}
        </span>
      </td>
      <td className="px-4 py-2 text-right tabular-nums">{centsText(line.effectiveCents)}</td>
      <td className="px-4 py-2 text-right tabular-nums">{centsText(line.rolledCents)}</td>
      <td className={`px-4 py-2 text-right font-medium tabular-nums ${over ? "text-destructive" : ""}`}>{centsText(line.remainingCents)}</td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="h-2.5 w-28 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all ${over ? "bg-destructive" : "bg-primary"}`}
              style={{ width: `${Math.min(line.percentUsed, 100)}%` }}
            />
          </div>
          <span className={`text-xs tabular-nums ${over ? "font-medium text-destructive" : "text-muted-foreground"}`}>
            {Math.round(line.percentUsed)}%
          </span>
        </div>
      </td>
    </tr>
  );
}
