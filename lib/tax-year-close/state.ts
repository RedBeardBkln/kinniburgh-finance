// Fold close events into the state of a tax year (tax-carry-screen-and-year-close, Phase B).
//
// Current state = the event with the highest `seq` (array order never matters). `latestClosedYear` only counts a year whose
// CURRENT state is "closed": a reopened year no longer blocks anything. PURE: no DB, no network, no clock.

import { formatFactDate } from "@/lib/tax-facts/format";
import type { YearCloseEventRow, YearStatus } from "@/lib/tax-year-close/types";

export interface YearState {
  status: YearStatus;
  taxYear: number;
  /** The date the owner said the return was filed (from the latest close event; kept while the year is reopened). */
  filedOn: Date | null;
  closedAt: Date | null;
  closedByName: string | null;
  /** The note on the latest close event. */
  note: string | null;
  reopenedAt: Date | null;
  reopenedByName: string | null;
  /** The reason on the latest reopen event (status "reopened" only). */
  reopenReason: string | null;
  /** Every event, oldest first. */
  history: YearCloseEventRow[];
}

function bySeq(a: YearCloseEventRow, b: YearCloseEventRow): number {
  return a.seq - b.seq;
}

/** The state of one year from its events (events of other years are ignored). */
export function foldYearState(taxYear: number, events: readonly YearCloseEventRow[]): YearState {
  const history = events.filter((e) => e.taxYear === taxYear).sort(bySeq);
  const latest = history[history.length - 1];
  const lastClose = [...history].reverse().find((e) => e.kind === "closed") ?? null;
  const base = {
    taxYear,
    filedOn: lastClose?.filedOn ?? null,
    closedAt: lastClose?.at ?? null,
    closedByName: lastClose?.byName ?? null,
    note: lastClose?.note ?? null,
    history,
  };
  if (latest === undefined) {
    return { ...base, status: "open", reopenedAt: null, reopenedByName: null, reopenReason: null };
  }
  if (latest.kind === "closed") {
    return { ...base, status: "closed", reopenedAt: null, reopenedByName: null, reopenReason: null };
  }
  return { ...base, status: "reopened", reopenedAt: latest.at, reopenedByName: latest.byName, reopenReason: latest.note };
}

/** The state of every year that has at least one event. */
export function foldAllYears(events: readonly YearCloseEventRow[]): Map<number, YearState> {
  const years = new Set(events.map((e) => e.taxYear));
  const out = new Map<number, YearState>();
  for (const y of [...years].sort((a, b) => a - b)) out.set(y, foldYearState(y, events));
  return out;
}

/** The latest tax year whose current state is "closed" (a reopened year does not count); null when none. */
export function latestClosedYear(states: Iterable<YearState>): number | null {
  let best: number | null = null;
  for (const s of states) {
    if (s.status === "closed" && (best === null || s.taxYear > best)) best = s.taxYear;
  }
  return best;
}

/**
 * The badge the Personal widget on /tax shows for a year. The household return is the Personal entity's, so its badge follows
 * the close state when the year has close events (closed -> "filed", reopened -> "reopened"); with no close events, and for every
 * business entity, it keeps the workspace's own status. Nothing is written.
 */
export function widgetStatus(entityType: string, workspaceStatus: string | null, year: YearState | null | undefined): string | null {
  if (entityType !== "personal" || !year) return workspaceStatus;
  if (year.status === "closed") return "filed";
  if (year.status === "reopened") return "reopened";
  return workspaceStatus;
}

/** A plain, serializable view of one year for a client component (dates as New York calendar dates). */
export interface YearCloseView {
  taxYear: number;
  status: YearStatus;
  filedOn: string | null;
  closedByName: string | null;
  note: string | null;
  reopenedByName: string | null;
  reopenedOn: string | null;
  reopenReason: string | null;
  history: Array<{ seq: number; kind: string; on: string; filedOn: string | null; byName: string; note: string | null }>;
}

export function toYearCloseView(state: YearState): YearCloseView {
  return {
    taxYear: state.taxYear,
    status: state.status,
    filedOn: state.filedOn ? formatFactDate(state.filedOn) : null,
    closedByName: state.closedByName,
    note: state.note,
    reopenedByName: state.reopenedByName,
    reopenedOn: state.reopenedAt ? formatFactDate(state.reopenedAt) : null,
    reopenReason: state.reopenReason,
    history: state.history.map((e) => ({
      seq: e.seq,
      kind: e.kind,
      on: formatFactDate(e.at),
      filedOn: e.filedOn ? formatFactDate(e.filedOn) : null,
      byName: e.byName,
      note: e.note,
    })),
  };
}
