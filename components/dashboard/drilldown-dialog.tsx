"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { updateBudgetLine } from "@/actions/budgets";
import { InlineTagCell } from "@/components/transactions/inline-tag-cell";
import {
  buildDrillView,
  centsText,
  formatDay,
  sumCountedRows,
  sumRowCents,
  type DrillData,
  type DrillRow,
  type DrillSection,
  type DrillTarget,
  type DrillView,
} from "@/lib/dashboard-drill";

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface Props {
  data: DrillData;
  target: DrillTarget;
  allTags: Tag[];
  /** Element to return focus to when the dialog closes. */
  returnFocusTo: HTMLElement | null;
  onClose: () => void;
}

function signedText(cents: number): string {
  return cents > 0 ? `+${centsText(cents)}` : centsText(cents);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function DrilldownDialog({ data, target, allTags, returnFocusTo, onClose }: Props) {
  const view = useMemo(() => buildDrillView(data, target), [data, target]);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = "drilldown-title";

  // Move focus into the dialog on open; give it back to the trigger on close.
  useEffect(() => {
    const panel = panelRef.current;
    panel?.focus();
    return () => {
      if (returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus();
    };
  }, [returnFocusTo]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (items.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const unit = view.expected?.unit ?? "money";
  const counted = view.expected ? sumCountedRows(view) : sumRowCents(view);
  const matches = view.expected ? counted === view.expected.cents : true;
  const fmtHeadline = view.headline.unit === "count" ? String(view.headline.cents) : centsText(view.headline.cents);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-[90vh] w-full flex-col rounded-t-xl bg-background shadow-xl outline-none sm:max-h-[85vh] sm:max-w-2xl sm:rounded-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b p-4">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 id={titleId} className="text-lg font-semibold">
              {view.title}
            </h2>
            {view.subtitle && <p className="text-xs text-muted-foreground">{view.subtitle}</p>}
            {view.headline.label && (
              <p className="text-sm text-muted-foreground">
                {view.headline.label}: <span className="text-base font-semibold text-foreground tabular-nums">{fmtHeadline}</span>
              </p>
            )}
            {view.lineEdit && <LineBudgetEditor edit={view.lineEdit} />}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="mt-0.5 shrink-0 rounded px-2 text-xl leading-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {view.infoRows.length > 0 && (
            <dl className="space-y-1 border-b px-4 py-3 text-sm">
              {view.infoRows.map((r) => (
                <div key={r.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{r.label}</dt>
                  <dd className="shrink-0 font-medium tabular-nums">{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {view.notes.length > 0 && (
            <ul className="space-y-1 border-b px-4 py-3 text-xs text-muted-foreground">
              {view.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}

          {view.sections.map((s) => (
            <Section key={s.key} section={s} allTags={allTags} />
          ))}

          {view.excludedSections.length > 0 && (
            <div className="border-t bg-muted/20">
              <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Not counted in Spent, and why
              </p>
              {view.excludedSections.map((s) => (
                <details key={s.key} className="border-b last:border-0">
                  <summary className="flex cursor-pointer items-baseline justify-between gap-3 px-4 py-2 text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                    <span className="font-medium">
                      {s.title} <span className="font-normal text-muted-foreground">({s.rows.length})</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{s.subtotalCents !== null ? signedText(s.subtotalCents) : ""}</span>
                  </summary>
                  {s.subtitle && <p className="px-4 pb-1 text-xs text-muted-foreground">{s.subtitle}</p>}
                  <RowList rows={s.rows} allTags={allTags} signed />
                </details>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2 border-t p-3 text-sm">
          {view.expected ? (
            <p className={matches ? "text-muted-foreground" : "font-medium text-destructive"} role="status">
              {matches
                ? unit === "count"
                  ? `${counted} ${counted === 1 ? "line" : "lines"} listed = the number you clicked.`
                  : `Rows add up to ${centsText(counted)} = the number you clicked.`
                : unit === "count"
                  ? `Warning: ${counted} lines are listed but the number you clicked is ${view.expected.cents}.`
                  : `Warning: rows add up to ${centsText(counted)} but the number you clicked is ${centsText(view.expected.cents)}.`}
            </p>
          ) : view.footerLabel ? (
            <p className="text-muted-foreground" role="status">
              {view.footerLabel}: <span className="font-medium tabular-nums text-foreground">{signedText(counted)}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-3">
              {view.links.map((l) => (
                <Link key={l.href} href={l.href as Route} className="text-primary underline-offset-4 hover:underline">
                  {l.label}
                </Link>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ section, allTags }: { section: DrillSection; allTags: Tag[] }) {
  return (
    <div>
      {section.heading && (
        <p className="border-b bg-muted/40 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {section.heading}
        </p>
      )}
      <div className="border-b last:border-0">
        <div
          className="flex items-baseline justify-between gap-3 bg-muted/20 px-4 py-2"
          style={section.depth > 0 ? { paddingLeft: `${16 + section.depth * 16}px` } : undefined}
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {section.depth > 0 && <span className="mr-1 text-muted-foreground">└</span>}
              {section.title}
            </p>
            {section.subtitle && <p className="text-xs text-muted-foreground">{section.subtitle}</p>}
          </div>
          {section.subtotalCents !== null && (
            <p className="shrink-0 text-sm font-medium tabular-nums">
              {centsText(section.subtotalCents)}
              {section.subtotalNote && <span className="ml-1 text-xs font-normal text-muted-foreground">{section.subtotalNote}</span>}
            </p>
          )}
        </div>
        {section.rows.length === 0 && section.emptyNote && (
          <p className="px-4 py-2 text-xs text-muted-foreground" style={section.depth > 0 ? { paddingLeft: `${16 + section.depth * 16}px` } : undefined}>
            {section.emptyNote}
          </p>
        )}
        <RowList rows={section.rows} allTags={allTags} depth={section.depth} />
      </div>
    </div>
  );
}

function RowList({ rows, allTags, depth = 0, signed = false }: { rows: DrillRow[]; allTags: Tag[]; depth?: number; signed?: boolean }) {
  if (rows.length === 0) return null;
  return (
    <ul className="divide-y">
      {rows.map((row) => (
        <li
          key={row.key}
          className={`flex items-start justify-between gap-3 px-4 py-2 text-sm ${row.tone === "muted" ? "text-muted-foreground" : ""}`}
          style={depth > 0 ? { paddingLeft: `${16 + depth * 16}px` } : undefined}
        >
          <div className="min-w-0 flex-1">
            <p className="break-words">
              {row.label}
              {row.chips.map((c) => (
                <span key={c} className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {c}
                </span>
              ))}
            </p>
            <p className="text-xs text-muted-foreground">
              {[row.day ? formatDay(row.day) : null, row.account, row.sub].filter((p): p is string => !!p).join(" · ")}
            </p>
            {row.tagIds ? (
              row.txId && (
                <div className="mt-0.5">
                  <InlineTagCell transactionId={row.txId} allTags={allTags} initialTagIds={row.tagIds} />
                </div>
              )
            ) : row.tags ? (
              <p className="break-words text-xs text-muted-foreground">{row.tags}</p>
            ) : null}
          </div>
          <p
            className={`shrink-0 font-mono text-sm font-medium tabular-nums ${row.tone === "credit" ? "text-green-600" : ""}`}
          >
            {signed ? signedText(row.cents) : centsText(row.cents)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function LineBudgetEditor({ edit }: { edit: NonNullable<DrillView["lineEdit"]> }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  // Prefill from the RAW stored value (blank when auto-sum), not the resolved amount, so an unmodified Save never
  // freezes an auto-summed number in as an explicit override.
  const [input, setInput] = useState(edit.rawCents !== null ? (edit.rawCents / 100).toFixed(2) : "");
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    startSave(async () => {
      const result = await updateBudgetLine(edit.budgetId, input);
      if ("error" in result) setError(result.error);
      else {
        setEditing(false);
        router.refresh();
      }
    });
  }

  return (
    <div className="text-sm text-muted-foreground">
      Budget:{" "}
      {editing ? (
        <span className="inline-flex items-center gap-1">
          $
          <input
            autoFocus
            aria-label="Budget amount"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              }
            }}
            className="w-24 rounded border border-input bg-background px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button type="button" onClick={save} disabled={saving} className="text-xs text-primary hover:underline disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => setEditing(false)} className="text-xs text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={`underline-offset-2 hover:text-primary hover:underline ${edit.rawCents === null ? "italic" : "font-medium text-foreground"}`}
          title={edit.rawCents === null ? "Auto-calculated from nested budget lines: click to set an amount" : "Click to edit the budget"}
        >
          {edit.rawCents === null ? `Auto (${centsText(edit.resolvedCents)})` : centsText(edit.resolvedCents)}
        </button>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
