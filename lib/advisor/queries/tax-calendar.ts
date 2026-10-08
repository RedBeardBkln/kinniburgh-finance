// Tax deadline reads and the household tax-year state for the assistant. DB-aware, explicit select only.
//
// Deadlines: label, due date, type, status and entity name. The deadline `notes` are never selected.
// Year state: read through loadYearCloseStates() (lib/tax-year-close-store.ts, the fail-soft DISPLAY reader). This is the ONLY advisor file that
// imports that store (get_recent_changes goes through loadYearCloseSummary below), and it narrows the rows to status / dates / first names:
// the close note and the reopen reason are tax records and are dropped here, before anything reaches a shaper.

import { db } from "@/lib/db";
import { loadYearCloseStates } from "@/lib/tax-year-close-store";

export interface DeadlineRow {
  label: string;
  dueDate: Date;
  type: string;
  status: string;
  entity: { name: string };
}

export const DEADLINE_CAP = 40;

export async function loadDeadlines(opts: { from: Date; to: Date | null }): Promise<DeadlineRow[]> {
  return db.taxDeadline.findMany({
    where: { archivedAt: null, dueDate: { gte: opts.from, ...(opts.to !== null ? { lt: opts.to } : {}) } },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    take: DEADLINE_CAP,
    select: { label: true, dueDate: true, type: true, status: true, entity: { select: { name: true } } },
  });
}

export interface YearStateRow {
  taxYear: number;
  status: "open" | "closed" | "reopened";
  filedOn: Date | null;
  closedByName: string | null;
  reopenedAt: Date | null;
}

export interface YearCloseEventFacts {
  taxYear: number;
  kind: string;
  at: Date;
  byName: string;
}

export type YearCloseSummary = { available: false } | { available: true; years: YearStateRow[]; events: YearCloseEventFacts[] };

/** Fail-soft: a missing table, no Personal entity or any read error is `{ available: false }`, never a throw and never a guess. */
export async function loadYearCloseSummary(): Promise<YearCloseSummary> {
  const load = await loadYearCloseStates();
  if (load.state !== "ok") return { available: false };
  const years: YearStateRow[] = [...load.byYear.values()].map((y) => ({
    taxYear: y.taxYear,
    status: y.status,
    filedOn: y.filedOn,
    closedByName: y.closedByName,
    reopenedAt: y.reopenedAt,
  }));
  const events: YearCloseEventFacts[] = load.events.map((e) => ({ taxYear: e.taxYear, kind: e.kind, at: e.at, byName: e.byName }));
  return { available: true, years, events };
}
