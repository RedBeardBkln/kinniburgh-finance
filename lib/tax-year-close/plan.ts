// Plan the next close event for a year (tax-carry-screen-and-year-close, Phase B).
//
// Rules: a year can be marked filed only when it is open or reopened (a closed year cannot be closed again); it can be
// reopened only when it is closed, and a reopen needs a reason. The new row always has seq = highest seq + 1, so two tabs
// racing for the same seq collide on the unique index instead of writing two rows with the same number. The planner never
// edits an existing event. PURE: no DB, no network; the caller supplies `now`.

import { foldYearState } from "@/lib/tax-year-close/state";
import { MAX_CLOSE_TAX_YEAR, MIN_CLOSE_TAX_YEAR, type YearCloseEventRow, type YearCloseKind } from "@/lib/tax-year-close/types";
import { parseFiledOn, validateCloseNote, validateReopenReason } from "@/lib/tax-year-close/validate";

export type YearCloseRequest =
  | { kind: "closed"; taxYear: number; filedOn: string; note?: string | null }
  | { kind: "reopened"; taxYear: number; reason: string | null | undefined };

export interface NewYearCloseEvent {
  taxYear: number;
  seq: number;
  kind: YearCloseKind;
  filedOn: Date | null;
  note: string | null;
}

export type YearClosePlan = { ok: true; row: NewYearCloseEvent } | { ok: false; error: string };

export function planYearCloseEvent(history: readonly YearCloseEventRow[], req: YearCloseRequest, now: Date): YearClosePlan {
  if (!Number.isInteger(req.taxYear) || req.taxYear < MIN_CLOSE_TAX_YEAR || req.taxYear > MAX_CLOSE_TAX_YEAR) {
    return { ok: false, error: "The tax year is not valid." };
  }
  const events = history.filter((e) => e.taxYear === req.taxYear);
  const state = foldYearState(req.taxYear, events);
  const seq = events.reduce((max, e) => Math.max(max, e.seq), 0) + 1;

  if (req.kind === "closed") {
    if (state.status === "closed") {
      return { ok: false, error: `TY${req.taxYear} is already marked filed. Reopen it first if you need to revise it.` };
    }
    const filedOn = parseFiledOn(req.filedOn, req.taxYear, now);
    if (!filedOn.ok) return { ok: false, error: filedOn.error };
    const note = validateCloseNote(req.note);
    if (!note.ok) return { ok: false, error: note.error };
    return { ok: true, row: { taxYear: req.taxYear, seq, kind: "closed", filedOn: filedOn.value, note: note.value } };
  }

  if (state.status !== "closed") {
    return { ok: false, error: `TY${req.taxYear} is not marked filed, so there is nothing to reopen.` };
  }
  const reason = validateReopenReason(req.reason);
  if (!reason.ok) return { ok: false, error: reason.error };
  return { ok: true, row: { taxYear: req.taxYear, seq, kind: "reopened", filedOn: null, note: reason.value } };
}
