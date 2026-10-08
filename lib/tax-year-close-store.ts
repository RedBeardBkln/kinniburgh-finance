// DB-aware store for the household tax year close events (tax-carry-screen-and-year-close, Phase B).
//
// INSERT-ONLY: the only writes are one `create` of a close event and one `create` of an AuditLog row, in one transaction. There is
// no update, upsert or delete here or anywhere else (a source-reading test pins it). The read side has no auth of its own, so
// callers (pages, actions) check the session first. This file is not read by the TY2025 engine, the return fingerprint, the PDF
// routes or the approval readers, and it imports none of them.
//
// Two readers with opposite failure modes, on purpose:
//  - `loadYearCloseStates` is for DISPLAY and is fail-soft: a missing table, no Personal entity or any error becomes a state, never a
//    throw, so an unapplied migration can never break a TY2025 page.
//  - `readLatestClosedYear` is for GUARDS and is fail-closed: a missing table / no entity means "nothing can be closed yet", but
//    any other error is `ok: false` and the guarded write is refused.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isMissingTable, resolvePersonalEntityId } from "@/lib/tax-facts-store";
import { planYearCloseEvent, type YearCloseRequest } from "@/lib/tax-year-close/plan";
import { foldAllYears, latestClosedYear, type YearState } from "@/lib/tax-year-close/state";
import { YEAR_CLOSE_KINDS, type YearCloseEventRow } from "@/lib/tax-year-close/types";

type StoredEvent = Prisma.TaxYearCloseEventGetPayload<object>;

export type YearCloseLoad =
  | { state: "ok"; entityId: string; events: YearCloseEventRow[]; byYear: Map<number, YearState> }
  | { state: "no_entity" }
  | { state: "table_missing" }
  | { state: "error" };

/** A stored row as the typed row the pure code uses; null when the kind is not in its closed vocabulary. */
export function convertStoredEvent(r: StoredEvent): YearCloseEventRow | null {
  const kind = (YEAR_CLOSE_KINDS as readonly string[]).includes(r.kind) ? (r.kind as YearCloseEventRow["kind"]) : null;
  if (kind === null) return null;
  return { id: r.id, taxYear: r.taxYear, seq: r.seq, kind, filedOn: r.filedOn, note: r.note, byName: r.byName, at: r.at };
}

/** Every close event of the household, oldest first, folded per year. Never throws. */
export async function loadYearCloseStates(): Promise<YearCloseLoad> {
  try {
    const entityId = await resolvePersonalEntityId();
    if (!entityId) return { state: "no_entity" };
    const stored = await db.taxYearCloseEvent.findMany({ where: { entityId }, orderBy: [{ taxYear: "asc" }, { seq: "asc" }] });
    const events: YearCloseEventRow[] = [];
    for (const s of stored) {
      const e = convertStoredEvent(s);
      // An event with an unrecognised kind makes the state of that year unknowable: fail soft as an error, never guess.
      if (e === null) return { state: "error" };
      events.push(e);
    }
    return { state: "ok", entityId, events, byYear: foldAllYears(events) };
  } catch (e) {
    if (isMissingTable(e)) return { state: "table_missing" };
    // Never echo the error text (it may carry row data); the name is enough to find it in the logs.
    console.error("tax year close states could not be loaded:", e instanceof Error ? e.name : "unknown error");
    return { state: "error" };
  }
}

export type LatestClosedYearRead = { ok: true; year: number | null } | { ok: false };

/** For guards: the latest year whose current state is "closed". Fail-closed except for a table that does not exist yet. */
export async function readLatestClosedYear(): Promise<LatestClosedYearRead> {
  const load = await loadYearCloseStates();
  if (load.state === "ok") return { ok: true, year: latestClosedYear(load.byYear.values()) };
  if (load.state === "table_missing" || load.state === "no_entity") return { ok: true, year: null };
  return { ok: false };
}

export type InsertCloseResult =
  | { ok: true; id: string; seq: number; kind: "closed" | "reopened" }
  | { ok: false; error: string; code?: "conflict" | "migration_missing" };

export const CLOSE_MIGRATION_MISSING_ERROR =
  "The tax year close table has not been created yet: the migration has not been applied. Nothing was changed.";

/**
 * One transaction: read the year's events, plan the next one, insert it, audit it. A second tab racing for the same seq hits the
 * unique index (P2002) and gets a `conflict` result, not a duplicate row. The audit row holds ids, the year, the seq and the kind
 * only: never the note, the reason, the filing date or a name.
 */
export async function insertCloseEvent(
  entityId: string,
  author: { id: string; name: string },
  req: YearCloseRequest,
  now: Date
): Promise<InsertCloseResult> {
  try {
    return await db.$transaction(async (tx): Promise<InsertCloseResult> => {
      const stored = await tx.taxYearCloseEvent.findMany({ where: { entityId, taxYear: req.taxYear }, orderBy: { seq: "asc" } });
      const history: YearCloseEventRow[] = [];
      for (const s of stored) {
        const e = convertStoredEvent(s);
        if (e === null) return { ok: false, error: "A stored event for this year is not recognised; nothing was changed." };
        history.push(e);
      }
      const plan = planYearCloseEvent(history, req, now);
      if (!plan.ok) return { ok: false, error: plan.error };
      const row = await tx.taxYearCloseEvent.create({
        data: {
          entityId,
          taxYear: plan.row.taxYear,
          seq: plan.row.seq,
          kind: plan.row.kind,
          filedOn: plan.row.filedOn,
          note: plan.row.note,
          byId: author.id,
          byName: author.name,
        },
      });
      await tx.auditLog.create({
        data: {
          changedBy: author.id,
          changeType: row.kind === "closed" ? "tax_year_close" : "tax_year_reopen",
          before: Prisma.JsonNull,
          after: { id: row.id, taxYear: row.taxYear, seq: row.seq, kind: row.kind } satisfies Prisma.InputJsonValue,
        },
      });
      return { ok: true, id: row.id, seq: row.seq, kind: plan.row.kind };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, code: "conflict", error: "Someone changed this year just now. Reload the page and try again." };
    }
    if (isMissingTable(e)) return { ok: false, code: "migration_missing", error: CLOSE_MIGRATION_MISSING_ERROR };
    throw e;
  }
}
