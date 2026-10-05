"use client";

import { useEffect, useMemo, useState } from "react";
import { DispositionDialog } from "@/components/tax/review/disposition-dialog";
import { FindingDetail } from "@/components/tax/review/finding-detail";
import { LinkList } from "@/components/tax/review/finding-links";
import type { FindingDto } from "@/lib/tax-review/state";
import { EMPTY_LINK_CONTEXT, findingLinks, REVIEW_FILTER_EVENT, type LinkContext } from "@/lib/tax-review/links";
import { REVIEW_ANCHORS } from "@/lib/tax-anchors";
import { areasPresent, DEFAULT_FILTERS, filterFindings, filtersFromHash, SEVERITIES, SEVERITY_LABELS, severityCountsOf, toggleSeverity, type FindingFilters, type StatusFilter } from "@/lib/tax-review/ui";
import type { Severity } from "@/lib/tax-review/types";

// The findings list with filters (severity, area, status, text), a detail panel per finding and the accept / reopen dialog. Plain JSON in;
// the filtering and every button's state come from lib/tax-review/ui.ts (unit-tested). It decides nothing about the gate.

const SEVERITY_TONE: Record<Severity, string> = {
  blocker: "border-red-400 bg-red-50 text-red-900",
  high: "border-orange-400 bg-orange-50 text-orange-900",
  medium: "border-amber-400 bg-amber-50 text-amber-900",
  low: "border-slate-300 bg-slate-50 text-slate-800",
  info: "border-sky-300 bg-sky-50 text-sky-900",
};

const STATUS_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Every status" },
  { value: "open", label: "Open" },
  { value: "gating", label: "Open and blocking approval" },
  { value: "accepted", label: "Accepted" },
];

const AREA_LABELS: Record<string, string> = {
  income: "Income",
  adjustments: "Adjustments",
  deductions: "Deductions",
  credits: "Credits",
  payments: "Payments",
  tax: "Tax",
  state: "Connecticut",
  forms: "Forms",
  process: "Process",
  packaging: "Package",
  privacy: "Privacy",
};

export function FindingsTable({
  findings,
  year,
  canDecide,
  whyNotDecide,
  readOnly = false,
  links = EMPTY_LINK_CONTEXT,
  listenForJumps = false,
}: {
  findings: FindingDto[];
  year: 2025;
  /** The signed-in account is the owner's and the checks are for the current return. */
  canDecide: boolean;
  whyNotDecide: string | null;
  /** A past run: nothing can be accepted or reopened. */
  readOnly?: boolean;
  /** Where each finding's links go (built on the server from the current return). Without it every finding still links to its area's section. */
  links?: LinkContext;
  /** The gate checklist's "Jump to" links filter THIS list (only the main list on the page listens, not a past run's). */
  listenForJumps?: boolean;
}) {
  const [filters, setFilters] = useState<FindingFilters>(DEFAULT_FILTERS);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ key: string; mode: "accept" | "reopen" } | null>(null);

  const shown = useMemo(() => filterFindings(findings, filters), [findings, filters]);
  const counts = useMemo(() => severityCountsOf(findings), [findings]);
  const areas = useMemo(() => areasPresent(findings), [findings]);
  const linksOf = useMemo(() => new Map(findings.map((f) => [f.key, findingLinks(f, links)])), [findings, links]);
  const dialogFinding = dialog === null ? null : (findings.find((f) => f.key === dialog.key) ?? null);

  useEffect(() => {
    if (!listenForJumps) return;
    const apply = (hash: string): void => {
      const want = filtersFromHash(hash);
      if (want === null) return;
      setFilters({ ...DEFAULT_FILTERS, status: want.status, layer: want.layer });
      setOpenKey(null);
      document.getElementById(REVIEW_ANCHORS.findings)?.scrollIntoView({ block: "start" });
    };
    apply(window.location.hash);
    const onEvent = (e: Event): void => apply(String((e as CustomEvent<string>).detail ?? ""));
    const onHash = (): void => apply(window.location.hash);
    window.addEventListener(REVIEW_FILTER_EVENT, onEvent);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener(REVIEW_FILTER_EVENT, onEvent);
      window.removeEventListener("hashchange", onHash);
    };
  }, [listenForJumps]);

  if (findings.length === 0) {
    return (
      <p className="rounded-md border p-3 text-sm text-muted-foreground" data-testid="findings-empty">
        No findings. Run the checks to see what they found.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="findings-table">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by severity">
        {SEVERITIES.map((s) => {
          const on = filters.severities.includes(s);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              onClick={() => setFilters((f) => ({ ...f, severities: toggleSeverity(f.severities, s) }))}
              className={`min-h-[44px] rounded-full border px-3 text-xs sm:min-h-0 sm:py-1 ${on ? "ring-2 ring-primary" : ""} ${SEVERITY_TONE[s]}`}
              data-testid={`filter-severity-${s}`}
            >
              {SEVERITY_LABELS[s]} ({counts[s]})
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs">
          <span className="mr-1 font-medium">Area</span>
          <select value={filters.area} onChange={(e) => setFilters((f) => ({ ...f, area: e.target.value as FindingFilters["area"] }))} className="rounded-md border bg-background px-2 py-1 text-xs" data-testid="filter-area">
            <option value="all">Every area</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {AREA_LABELS[a] ?? a}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mr-1 font-medium">Status</span>
          <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as StatusFilter }))} className="rounded-md border bg-background px-2 py-1 text-xs" data-testid="filter-status">
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mr-1 font-medium">Search</span>
          <input type="search" value={filters.text} onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))} className="rounded-md border bg-background px-2 py-1 text-xs" placeholder="a word or a line" data-testid="filter-text" />
        </label>
        {filters.layer !== undefined && filters.layer !== "all" ? (
          <span className="rounded-full border px-2 py-0.5 text-xs" data-testid="filter-layer">
            Layer {filters.layer} only
          </span>
        ) : null}
        <button type="button" className="text-xs underline" onClick={() => setFilters(DEFAULT_FILTERS)}>
          Clear filters
        </button>
        <span className="ml-auto text-xs text-muted-foreground" data-testid="findings-count">
          Showing {shown.length} of {findings.length}
        </span>
      </div>

      {shown.length === 0 ? <p className="text-sm text-muted-foreground">Nothing matches those filters.</p> : null}
      <ul className="space-y-2">
        {shown.map((f) => {
          const open = openKey === f.key;
          return (
            <li key={f.key} className="rounded-md border" data-testid="finding-row" data-severity={f.severity} data-status={f.status}>
              <button type="button" className="flex w-full items-start gap-2 p-3 text-left hover:bg-muted/40" aria-expanded={open} onClick={() => setOpenKey(open ? null : f.key)}>
                <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${SEVERITY_TONE[f.severity]}`}>{SEVERITY_LABELS[f.severity]}</span>
                <span className="min-w-0 flex-1 text-sm">{f.message.length > 220 ? `${f.message.slice(0, 217)}...` : f.message}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {AREA_LABELS[f.area] ?? f.area}
                  {f.status === "accepted" ? " - accepted" : f.gating ? " - blocks approval" : ""}
                </span>
              </button>
              {!open ? (
                <div className="px-3 pb-2" data-testid="finding-row-links">
                  <LinkList links={(linksOf.get(f.key) ?? []).slice(0, 2)} />
                </div>
              ) : null}
              {open ? (
                <div className="border-t p-3">
                  <FindingDetail
                    finding={f}
                    links={linksOf.get(f.key) ?? []}
                    canDecide={!readOnly && canDecide}
                    whyNotDecide={readOnly ? "This is an earlier run; open the current checks to decide." : whyNotDecide}
                    onAccept={() => setDialog({ key: f.key, mode: "accept" })}
                    onReopen={() => setDialog({ key: f.key, mode: "reopen" })}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {dialog !== null && dialogFinding !== null ? <DispositionDialog finding={dialogFinding} mode={dialog.mode} year={year} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
