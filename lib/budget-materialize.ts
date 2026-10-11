// Budget materialization planner (copy-on-first-edit). PURE: no database, no clock, no Next, no Prisma client.
//
// Owner decision (2026-10-10): /budgets shows the effective (carried-forward) lines for a month that has no row of its
// own, with no copy button. The first time the owner changes anything in such a month, the carried set is saved as real
// rows in the same step, so the entity's latest month ("frontier", lib/budget-carry-forward.ts) is always complete and
// a single new line can never make every other line look ended.
//
// This file only decides WHICH rows to create (and, for an ended line, which to delete); lib/budget-materialize-build.ts
// runs the writes in one transaction. The planner reuses the resolver (`resolveEffectiveRows`, the same entry point the
// loader uses), so what is saved is exactly what the screens already show:
//   - copied: budgeted (null stays null), account, pay day, frequency, weekday, anchor date, pay month, annual amount
//     due, rolloverEnabled;
//   - NOT copied: rolloverAmount (-> null) and the one-off additional amount (-> 0), exactly like a carried row.
//
// Invariants (tests/budget-materialize*.test.ts, with an independent oracle):
//   I1 saving the plan never changes any month's effective view, for any entity or line;
//   I2 it only creates rows (never updates or overwrites one) and creating twice creates nothing the second time;
//   I3 after "end line L from M": L is absent in every month >= M, every other line and every month before M is
//      unchanged, and no ended line comes back;
//   I4 rolloverAmount and additionalAmountCents are never copied;
//   I5 the plan for one entity reads only that entity's rows.

import type { Decimal } from "@prisma/client/runtime/library";
import { resolveEffectiveRows, type CarryRowBase } from "@/lib/budget-carry-forward";
import { firstEditSaveSentence, firstEditSaveSentenceFor } from "@/lib/budget-first-edit-note";

export interface MaterializableRow extends CarryRowBase {
  accountId: string;
  budgeted: Decimal | null;
  payDay: number | null;
  frequency: string;
  payDayOfWeek: number | null;
  biweeklyAnchorDate: Date | null;
  payMonth: number | null;
  annualAmountDue: Decimal | null;
  rolloverEnabled: boolean;
}

/** How a Budget action names a line. Never a Budget id: a carried row has no real id. */
export interface BudgetLocator {
  entityId: string;
  tagId: string;
  /** YYYY-MM */
  period: string;
}

/** The data of one row to create. No id, no timestamps; rollover and the additional amount are reset. */
export interface BudgetCreateRow {
  entityId: string;
  tagId: string;
  period: string;
  accountId: string;
  budgeted: Decimal | null;
  additionalAmountCents: 0;
  payDay: number | null;
  frequency: string;
  payDayOfWeek: number | null;
  biweeklyAnchorDate: Date | null;
  payMonth: number | null;
  annualAmountDue: Decimal | null;
  rolloverEnabled: boolean;
  rolloverAmount: null;
}

export interface MaterializationPlan {
  creates: BudgetCreateRow[];
  /** The months that get at least one new row, ascending. */
  months: string[];
}

export type EndLinePlan =
  | { ok: false; reason: "not_in_view" }
  | { ok: false; reason: "only_line_left"; frontier: string }
  | {
      ok: true;
      creates: BudgetCreateRow[];
      months: string[];
      /** Own rows of the line at or after the target month, deleted by the caller. */
      deleteCount: number;
      /** True when the line had a real row in the target month (false = it was only carried there). */
      hadOwnRowAtTarget: boolean;
    };

// ── Period helpers (pure string math, no Date) ────────────────────────────────

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPeriod(s: unknown): s is string {
  return typeof s === "string" && PERIOD_RE.test(s);
}

/** `period` moved by `delta` months (negative = earlier). Throws on an invalid period. */
export function shiftPeriod(period: string, delta: number): string {
  if (!isPeriod(period)) throw new Error("shiftPeriod: invalid period");
  const index = Number(period.slice(0, 4)) * 12 + (Number(period.slice(5, 7)) - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** Every period from `from` to `to`, inclusive; empty when `from` is after `to`. */
export function periodRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let p = from; p <= to; p = shiftPeriod(p, 1)) out.push(p);
  return out;
}

/** "December 2026" for a YYYY-MM period (calendar math in UTC, so the server's time zone never shifts the month). */
export function formatPeriodLabel(period: string): string {
  if (!isPeriod(period)) return period;
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The one quiet notice above the totals on /budgets when some of the month's lines are carried (null = nothing to say).
 * `rows` are the month's effective rows of the bucket in view. `saveMonths` (entity id -> the months a first change
 * would save, from the loader) lets the notice say HOW MANY months the first change saves before the owner makes it;
 * without it the notice says only that earlier empty months may be saved too.
 */
export function carriedMonthNotice(
  rows: ReadonlyArray<{ source: "own" | "carried"; carriedFrom: string | null; entityId?: string; entityName?: string }>,
  saveMonths?: Readonly<Record<string, readonly string[]>> | null
): string | null {
  const carried = rows.filter((r) => r.source === "carried");
  if (carried.length === 0) return null;
  const from = [...new Set(carried.map((r) => r.carriedFrom).filter((p): p is string => p !== null))]
    .sort()
    .map(formatPeriodLabel)
    .join(", ");
  const entities = new Map<string, string>();
  for (const r of carried) entities.set(r.entityId ?? "", r.entityName ?? "");
  const known = saveMonths != null && [...entities.keys()].every((id) => saveMonths[id] !== undefined);
  const save = !known
    ? firstEditSaveSentence(null)
    : entities.size === 1
      ? firstEditSaveSentence(saveMonths[[...entities.keys()][0] as string] as readonly string[])
      : firstEditSaveSentenceFor([...entities].map(([id, name]) => ({ name, months: saveMonths[id] as readonly string[] })));
  if (carried.length === rows.length) {
    return `This month has no saved budget of its own yet. The lines below are copied from ${from} and are what the forecast uses. ${save}`;
  }
  return `${carried.length} of the lines below have no saved row for this month yet. They are copied from ${from} and are what the forecast uses. ${save}`;
}

/** Writes are refused for a month more than this many months after the current New York month. */
export const MAX_EDIT_MONTHS_AHEAD = 24;

export function isTooFarAhead(period: string, currentPeriod: string): boolean {
  return period > shiftPeriod(currentPeriod, MAX_EDIT_MONTHS_AHEAD);
}

// ── Planning ──────────────────────────────────────────────────────────────────

function toCreateRow(src: MaterializableRow, period: string): BudgetCreateRow {
  return {
    entityId: src.entityId,
    tagId: src.tagId,
    period,
    accountId: src.accountId,
    budgeted: src.budgeted,
    additionalAmountCents: 0,
    payDay: src.payDay,
    frequency: src.frequency,
    payDayOfWeek: src.payDayOfWeek,
    biweeklyAnchorDate: src.biweeklyAnchorDate,
    payMonth: src.payMonth,
    annualAmountDue: src.annualAmountDue,
    rolloverEnabled: src.rolloverEnabled,
    rolloverAmount: null,
  };
}

/** The entity's first and latest period with any row, and the set of periods that have rows. */
function entityShape(rows: readonly MaterializableRow[]): { first: string; frontier: string; has: Set<string> } | null {
  const has = new Set<string>();
  let first: string | null = null;
  let frontier: string | null = null;
  for (const r of rows) {
    if (!isPeriod(r.period)) continue;
    has.add(r.period);
    if (first === null || r.period < first) first = r.period;
    if (frontier === null || r.period > frontier) frontier = r.period;
  }
  return first === null || frontier === null ? null : { first, frontier, has };
}

/**
 * The rows to save so that `target` (and every empty month before it, up to the entity's frontier or the target) holds
 * real rows. Months planned = the target month, plus every month with no row at all from the entity's first row through
 * max(target, frontier) (the in-between months are saved too so that a line added or re-added in the target month,
 * which joins the entity's latest month, does not start to be carried across them). Only carried lines are created: an own row is never touched, and a month before the entity's
 * first row gets nothing (a line is never carried backwards). `excludeTagId` / `excludeFrom` leave one line out of the
 * months at or after `excludeFrom` (used when ending a line).
 */
export function planMaterialization(
  allRows: readonly MaterializableRow[],
  entityId: string,
  target: string,
  opts: { excludeTagId?: string; excludeFrom?: string } = {}
): MaterializationPlan {
  const rows = allRows.filter((r) => r.entityId === entityId);
  const shape = entityShape(rows);
  if (!shape || !isPeriod(target) || target < shape.first) return { creates: [], months: [] };

  const upTo = target > shape.frontier ? target : shape.frontier;
  const months = new Set<string>([target]);
  for (const p of periodRange(shape.first, upTo)) if (!shape.has.has(p)) months.add(p);

  const resolved = resolveEffectiveRows(rows, [...months]);
  const creates: BudgetCreateRow[] = [];
  for (const r of resolved) {
    if (r.source !== "carried") continue;
    if (opts.excludeTagId && opts.excludeFrom && r.tagId === opts.excludeTagId && r.period >= opts.excludeFrom) continue;
    creates.push(toCreateRow(r, r.period));
  }
  creates.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.tagId < b.tagId ? -1 : a.tagId > b.tagId ? 1 : 0));
  return { creates, months: [...new Set(creates.map((c) => c.period))] };
}

/** The effective row of a line in a month (own or carried), or null when the line is not on that month's budget. */
export function effectiveLineAt<T extends MaterializableRow>(allRows: readonly T[], loc: BudgetLocator) {
  const rows = allRows.filter((r) => r.entityId === loc.entityId);
  return resolveEffectiveRows(rows, [loc.period]).find((r) => r.tagId === loc.tagId) ?? null;
}

/**
 * Every effective row of `tagId` in `period`, in ANY entity (own or carried): a tag can be budgeted by one entity per
 * period, household-wide. The entities are resolved one at a time (each has its own frontier).
 */
export function tagHoldersAt(allRows: readonly MaterializableRow[], tagId: string, period: string): string[] {
  const entityIds = [...new Set(allRows.map((r) => r.entityId))].sort();
  const holders: string[] = [];
  for (const entityId of entityIds) {
    const rows = allRows.filter((r) => r.entityId === entityId);
    if (resolveEffectiveRows(rows, [period]).some((r) => r.tagId === tagId)) holders.push(entityId);
  }
  return holders;
}

/** The rows `planMaterialization` would save for the target, as if they were already stored (synthetic ids). */
function withSimulatedSave(rows: readonly MaterializableRow[], entityId: string, period: string): MaterializableRow[] {
  const plan = planMaterialization(rows, entityId, period);
  return plan.creates.map((c, i) => ({ ...c, id: `saved-${i}`, additionalAmountCents: 0, rolloverAmount: null }));
}

/** Why a later month is left out of "also add to later saved months". */
export type LaterAddSkipReason = "already_has" | "other_entity" | "no_rows";

export interface LaterAddPlan {
  /** The entity's latest month with rows (L); null when there is nothing later than the added month. */
  through: string | null;
  /** The later months (M+1..L) that get the new line, ascending. */
  months: string[];
  skipped: Array<{ period: string; reason: LaterAddSkipReason }>;
}

/**
 * "Also add to later saved months": adding `loc.tagId` in `loc.period` (M) with M before the entity's latest month with
 * rows (L). Evaluated AFTER the copy-on-first-edit save (simulated), so the empty in-between months are counted as saved
 * months. Every month M+1..L gets the line unless: the entity already has a row for the tag there (`already_has`),
 * another entity holds the tag there, own row or carried (`other_entity`, the household one-entity-per-tag rule), or
 * the month has no rows at all even after the save (`no_rows`: no stored month is created from nothing). The
 * preview on /budgets and the write use this same function. Pure.
 */
export function planAddToLaterMonths(allRows: readonly MaterializableRow[], loc: BudgetLocator): LaterAddPlan {
  const rows = allRows.filter((r) => r.entityId === loc.entityId);
  const shape = entityShape(rows);
  if (!shape || !isPeriod(loc.period) || loc.period >= shape.frontier) return { through: null, months: [], skipped: [] };

  const saved = withSimulatedSave(rows, loc.entityId, loc.period);
  const combined = [...rows, ...saved];
  const periodsWithRows = new Set(combined.map((r) => r.period));
  const ownTagPeriods = new Set(combined.filter((r) => r.tagId === loc.tagId).map((r) => r.period));

  const months: string[] = [];
  const skipped: LaterAddPlan["skipped"] = [];
  for (const p of periodRange(shiftPeriod(loc.period, 1), shape.frontier)) {
    if (ownTagPeriods.has(p)) skipped.push({ period: p, reason: "already_has" });
    else if (tagHoldersAt(allRows, loc.tagId, p).some((e) => e !== loc.entityId)) skipped.push({ period: p, reason: "other_entity" });
    else if (!periodsWithRows.has(p)) skipped.push({ period: p, reason: "no_rows" });
    else months.push(p);
  }
  // The line would sit on the entity's latest month and so be carried forward from it: into every month after it, and
  // into every month in between that still has no rows. If another entity holds the tag in any of those months (its own
  // rows, or carried from its own latest month), the two would show it in the same month: leave the latest month out so
  // the line ends before it and the household rule keeps holding.
  if (months[months.length - 1] === shape.frontier) {
    let last = shape.frontier;
    for (const r of allRows) if (isPeriod(r.period) && r.period > last) last = r.period;
    const carriedInto = [
      ...periodRange(shiftPeriod(loc.period, 1), shiftPeriod(shape.frontier, -1)).filter((p) => !periodsWithRows.has(p)),
      ...periodRange(shiftPeriod(shape.frontier, 1), shiftPeriod(last, 1)),
    ];
    if (carriedInto.some((p) => tagHoldersAt(allRows, loc.tagId, p).some((e) => e !== loc.entityId))) {
      months.pop();
      skipped.push({ period: shape.frontier, reason: "other_entity" });
    }
  }
  return { through: shape.frontier, months, skipped };
}

/** The schedule and amount of the line being added; copied to every later month. */
export type LineFields = Pick<
  BudgetCreateRow,
  "accountId" | "budgeted" | "payDay" | "frequency" | "payDayOfWeek" | "biweeklyAnchorDate" | "payMonth" | "annualAmountDue"
>;

/** The rows to create for the later months: the added line's fields, rollover and the additional amount reset. */
export function toLaterCreateRows(loc: BudgetLocator, months: readonly string[], fields: LineFields): BudgetCreateRow[] {
  return months.map((period) => ({
    entityId: loc.entityId,
    tagId: loc.tagId,
    period,
    accountId: fields.accountId,
    budgeted: fields.budgeted,
    additionalAmountCents: 0,
    payDay: fields.payDay,
    frequency: fields.frequency,
    payDayOfWeek: fields.payDayOfWeek,
    biweeklyAnchorDate: fields.biweeklyAnchorDate,
    payMonth: fields.payMonth,
    annualAmountDue: fields.annualAmountDue,
    rolloverEnabled: false,
    rolloverAmount: null,
  }));
}

/**
 * Adding (or re-adding) a line in `loc.period` must not change any EARLIER month. The planner already saves the entity's
 * empty months first, so a month that has rows stays authoritative; the only way left is an earlier month with no rows
 * at all in which nothing is carried today but the added line would be (it has older rows, and joins the latest month).
 * Returns the earliest such month, or null when the add touches nothing but its own month onward. Pure.
 */
export function addChangesEarlierMonth(
  allRows: readonly MaterializableRow[],
  loc: BudgetLocator,
  /** Later months (from `planAddToLaterMonths`) that get the line too; the line then also lands on those rows. */
  laterPeriods: readonly string[] = []
): string | null {
  const rows = allRows.filter((r) => r.entityId === loc.entityId);
  const shape = entityShape(rows);
  if (!shape || shape.first >= loc.period) return null;
  const saved = withSimulatedSave(rows, loc.entityId, loc.period);
  const stubAt = (period: string): MaterializableRow => ({
    id: `new-line-${period}`,
    entityId: loc.entityId,
    tagId: loc.tagId,
    period,
    accountId: "",
    budgeted: null,
    payDay: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    rolloverEnabled: false,
    rolloverAmount: null,
    additionalAmountCents: 0,
  });
  const stubs = [loc.period, ...laterPeriods].map(stubAt);
  const earlier = periodRange(shape.first, shiftPeriod(loc.period, -1));
  const keys = (list: readonly MaterializableRow[]) => new Set(resolveEffectiveRows(list, earlier).map((r) => `${r.period}|${r.tagId}`));
  const before = keys(rows);
  const after = keys([...rows, ...saved, ...stubs]);
  const changed = [...new Set([...before, ...after])].filter((k) => before.has(k) !== after.has(k)).map((k) => k.slice(0, 7)).sort();
  return changed[0] ?? null;
}

/**
 * Ends a line from `loc.period` onward ("Delete" on /budgets; owner decision: there is no one-month skip, a month
 * that is only carried has no row to remove and would need a stored marker). The resolver and the screen agree on it.
 *   - month <= the entity's frontier: delete the line's rows from that month on;
 *   - month after the frontier (the line is only carried there): save the carried set for the months up to it WITHOUT
 *     the line in that month, so that month becomes the frontier and the line has ended.
 * Either way the entity's empty months before it are filled first with the line still in them. A month that has rows is
 * authoritative (lib/budget-carry-forward.ts), so no other month's view changes.
 * Refused when it would leave a month that has rows today with no line at all (for the latest month the frontier would
 * move back and bring older ended lines back to life; for a middle month it would start to show lines it does not show).
 */
export function planEndLine(allRows: readonly MaterializableRow[], loc: BudgetLocator): EndLinePlan {
  const rows = allRows.filter((r) => r.entityId === loc.entityId);
  const view = effectiveLineAt(rows, loc);
  if (!view) return { ok: false, reason: "not_in_view" };
  const shape = entityShape(rows);
  if (!shape) return { ok: false, reason: "not_in_view" };

  const plan = planMaterialization(rows, loc.entityId, loc.period, { excludeTagId: loc.tagId, excludeFrom: loc.period });
  const doomed = rows.filter((r) => r.tagId === loc.tagId && r.period >= loc.period);

  const creates = plan.creates;
  const createdMonths = plan.months;

  // A month that has rows is authoritative, and a month with none is filled by the carry. So ending the line must not
  // leave any month that holds rows today with none (the latest month would move back and bring older ended lines to
  // life; a middle month would start to show the other lines it does not show now), and the target month itself must
  // end up with rows when it is after the entity's latest month.
  const after = new Set<string>();
  for (const r of rows) if (!(r.tagId === loc.tagId && r.period >= loc.period)) after.add(r.period);
  for (const c of creates) after.add(c.period);
  const lost = [...shape.has].filter((p) => !after.has(p)).sort();
  if (lost.length > 0) return { ok: false, reason: "only_line_left", frontier: lost[0] as string };
  if (loc.period > shape.frontier && !after.has(loc.period)) return { ok: false, reason: "only_line_left", frontier: loc.period };

  return {
    ok: true,
    creates,
    months: createdMonths,
    deleteCount: doomed.length,
    hadOwnRowAtTarget: view.source === "own",
  };
}
