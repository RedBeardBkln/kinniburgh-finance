// Budget carry-forward. Pure: no database, no clock, no Prisma client.
//
// Owner rule (2026-10-09): every budgeted bill and expense carries forward, as budgeted, month to month and across
// years. Budget rows only exist for months the owner has curated (2026-01 .. 2026-12 today), so for any month with
// no row for an entity + tag, the EFFECTIVE budget line is the latest EARLIER row of that same entity + tag.
//
// This is a READ-TIME view. Nothing is written, no Budget row is created, and /budgets, the dashboard, the monthly
// review and the CSV export do not use it. A carried row is a synthetic copy:
//   - copied: budgeted (null stays null = auto-sum from children), accountId, payDay, frequency, payDayOfWeek,
//     biweeklyAnchorDate, payMonth, annualAmountDue, rolloverEnabled (flag only, for display);
//   - NOT carried: rolloverAmount (a computed carry-in from the prior month, becomes null), additionalAmountCents
//     (a one-off extra for that month, becomes 0), and the id (synthetic `carried:<sourceId>:<period>`; a carried row
//     is never handed to an action).
//
// Ended-line guard (owner answer 1): a line carries forward only if it also exists in the entity's frontier, i.e.
// the entity's latest period that has any rows. A line the owner dropped from the latest month has ended and does not
// come back. Without this rule, deleting a finished bill from the last month would resurrect it for ever.
//
// Variable lines (Electric (Eversource), Oil, Firewood, per entity; the set is an owner-editable AppSetting,
// `seasonal_budget_lines`) are EXCLUDED from flat carry-forward until the seasonal model ships: they keep the
// behaviour they had before this feature (own rows only, "No budget line for <period>" elsewhere).

import { Decimal } from "@prisma/client/runtime/library";

/** The minimum a row needs to be resolved. Everything else rides along untouched (and is copied on a carry). */
export interface CarryRowBase {
  id: string;
  entityId: string;
  tagId: string;
  /** YYYY-MM */
  period: string;
  /** Reset to null on a carry when present. */
  rolloverAmount?: Decimal | null;
  /** Reset to 0 on a carry when present. */
  additionalAmountCents?: Decimal | number | null;
}

export type CarrySource = "own" | "carried";

export type ResolvedBudgetRow<T extends CarryRowBase> = T & {
  source: CarrySource;
  /** The period the figures were copied from; null for an own row. */
  carriedFrom: string | null;
  /** True when the line is in the variable (seasonal) set. A variable line never carries. */
  variable: boolean;
};

export interface ResolveOptions {
  /** `${entityId}|${tagId}` keys of the variable lines. Default: none. */
  variableKeys?: ReadonlySet<string>;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isBudgetPeriod(s: unknown): s is string {
  return typeof s === "string" && PERIOD_RE.test(s);
}

export function budgetLineKey(entityId: string, tagId: string): string {
  return `${entityId}|${tagId}`;
}

export function syntheticCarriedId(sourceId: string, period: string): string {
  return `carried:${sourceId}:${period}`;
}

export function isCarriedId(id: string): boolean {
  return id.startsWith("carried:");
}

/**
 * The effective Budget rows for the requested periods.
 *
 * `allRows` must hold every row of the entities involved that could matter: any row at or before the latest requested
 * period to carry from, and ALL later rows too, so the entity's frontier (its latest period with rows) is the real
 * one. Rows with an invalid period are ignored. For each requested period and each line known to the entity:
 *   own row for the period            -> returned as `own`
 *   else latest earlier row, if the line is in the entity's frontier and is not variable -> `carried`
 *   else                              -> nothing (a variable line, an ended line, or a line that starts later)
 * Output is ordered by period, then entity, then tag, so it is deterministic.
 */
export function resolveBudgetRows<T extends CarryRowBase>(
  allRows: readonly T[],
  periods: readonly string[],
  opts: ResolveOptions = {}
): Array<ResolvedBudgetRow<T>> {
  const variableKeys = opts.variableKeys ?? new Set<string>();
  const wanted = [...new Set(periods.filter(isBudgetPeriod))].sort();
  if (wanted.length === 0) return [];

  const byLine = new Map<string, T[]>();
  const frontierByEntity = new Map<string, string>();
  for (const r of allRows) {
    if (!isBudgetPeriod(r.period)) continue;
    const key = budgetLineKey(r.entityId, r.tagId);
    const list = byLine.get(key);
    if (list) list.push(r);
    else byLine.set(key, [r]);
    const f = frontierByEntity.get(r.entityId);
    if (f === undefined || r.period > f) frontierByEntity.set(r.entityId, r.period);
  }
  for (const list of byLine.values()) list.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));

  const lineKeys = [...byLine.keys()].sort();
  const out: Array<ResolvedBudgetRow<T>> = [];
  for (const period of wanted) {
    for (const key of lineKeys) {
      const list = byLine.get(key) as T[];
      const variable = variableKeys.has(key);
      // The latest row at or before `period`.
      let hit: T | undefined;
      for (let i = list.length - 1; i >= 0; i--) {
        const row = list[i] as T;
        if (row.period <= period) {
          hit = row;
          break;
        }
      }
      if (!hit) continue; // the line starts later: never carried backwards
      if (hit.period === period) {
        out.push({ ...hit, source: "own", carriedFrom: null, variable });
        continue;
      }
      if (variable) continue; // variable lines keep their pre-existing behaviour until the seasonal model ships
      const frontier = frontierByEntity.get(hit.entityId);
      const last = list[list.length - 1] as T;
      if (frontier === undefined || last.period !== frontier) continue; // ended line: not in the entity's latest month
      out.push(carryRow(hit, period, variable));
    }
  }
  return out;
}

function carryRow<T extends CarryRowBase>(src: T, period: string, variable: boolean): ResolvedBudgetRow<T> {
  const copy: T = { ...src, id: syntheticCarriedId(src.id, period), period };
  const fields: CarryRowBase = copy;
  if ("rolloverAmount" in copy) fields.rolloverAmount = null;
  if ("additionalAmountCents" in copy) {
    fields.additionalAmountCents = typeof src.additionalAmountCents === "number" ? 0 : new Decimal(0);
  }
  return { ...copy, source: "carried", carriedFrom: src.period, variable };
}

// ── Variable (seasonal) line setting ─────────────────────────────────────────

/** AppSetting key. Value: JSON `[{ "entityId": "...", "tagId": "..." }]`, at most SEASONAL_LINES_CAP entries. */
export const SEASONAL_LINES_KEY = "seasonal_budget_lines";
export const SEASONAL_LINES_CAP = 20;

/**
 * Default set when the setting is absent, by full tag path. They apply to whichever entity holds a Budget row for the
 * tag. Personal: Electric (Eversource), Oil, Firewood. Sudden Valley represents the same supplies as
 * `Arbor Retreat / Electricity` and `Arbor Retreat / Oil` (owner answer 5: same feature, per entity).
 */
export const DEFAULT_SEASONAL_TAG_PATHS: readonly string[] = [
  "Utilities / Electric (Eversource)",
  "Utilities / Oil",
  "Utilities / Firewood",
  "Arbor Retreat / Electricity",
  "Arbor Retreat / Oil",
];

export interface SeasonalLine {
  entityId: string;
  tagId: string;
}

/**
 * Parses the setting. null = absent or unreadable (the caller then uses the default); an empty array is a valid
 * "the owner has no variable lines". Entries that are not two non-empty strings are dropped; more than the cap are
 * cut. Garbage JSON is null, never a throw.
 */
export function parseSeasonalLinesSetting(raw: string | null | undefined): SeasonalLine[] | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: SeasonalLine[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const e = (item as Record<string, unknown>)["entityId"];
    const t = (item as Record<string, unknown>)["tagId"];
    if (typeof e !== "string" || typeof t !== "string" || e === "" || t === "") continue;
    const key = budgetLineKey(e, t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entityId: e, tagId: t });
    if (out.length >= SEASONAL_LINES_CAP) break;
  }
  return out;
}

/**
 * The variable line keys: the owner's setting when it parses, else every row whose tag path is in the default list.
 * `rows` only need a tag path for the default case.
 */
export function variableLineKeys(
  rows: ReadonlyArray<{ entityId: string; tagId: string; tag?: { name?: string } | null }>,
  setting: readonly SeasonalLine[] | null
): Set<string> {
  if (setting !== null) return new Set(setting.map((s) => budgetLineKey(s.entityId, s.tagId)));
  const defaults = new Set(DEFAULT_SEASONAL_TAG_PATHS);
  const keys = new Set<string>();
  for (const r of rows) {
    const name = r.tag?.name;
    if (typeof name === "string" && defaults.has(name)) keys.add(budgetLineKey(r.entityId, r.tagId));
  }
  return keys;
}

/** Quiet note for a carried figure, e.g. "Budget figure carried forward from 2026-12". */
export function carriedNote(carriedFrom: string): string {
  return `Budget figure carried forward from ${carriedFrom}`;
}
