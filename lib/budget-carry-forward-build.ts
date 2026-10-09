// DB-aware, READ-ONLY loader for the effective (carried-forward) Budget rows. No writes of any kind, no auth: the
// CALLER owns access control (a page, or a server action / route that has already authenticated). One explicit-select
// read of the Budget rows plus one read of the `seasonal_budget_lines` AppSetting; the pure resolver in
// lib/budget-carry-forward.ts does the rest in memory.
//
// The read has NO upper period bound on purpose: the entity's frontier (its latest period with rows) decides whether a
// line has ended, so rows later than the requested months are needed even though they are never returned. About 650
// rows today; capped at MAX_ROWS, newest first, so a cap could only ever cut the oldest history.
//
// Consumers failed differently before this feature existed, so the failure mode is the caller's choice:
//   - loadEffectiveBudgetRows     throws on a read error (consumers that already propagated a Budget read error: the
//                                 ledger input, the Forecast page, the advisor, notifications);
//   - loadEffectiveBudgetRowsSafe never rejects: { rows: [], failed: true }, logs err.name only;
//   - loadEffectiveScheduleRows   the schedule-only read for the date index (lib/bill-dates-build.ts), which wraps it
//                                 in its own fail-soft catch.
// An unreadable or missing seasonal-lines setting is not an error: the default set applies.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  isBudgetPeriod,
  parseSeasonalLinesSetting,
  resolveBudgetRows,
  SEASONAL_LINES_KEY,
  variableLineKeys,
  type CarryRowBase,
  type ResolvedBudgetRow,
  type SeasonalLine,
} from "@/lib/budget-carry-forward";

const MAX_ROWS = 5000;

/** Every Budget field any forward-month consumer reads, selected explicitly (never account data or notes). */
const EFFECTIVE_BUDGET_SELECT = {
  id: true,
  entityId: true,
  tagId: true,
  accountId: true,
  period: true,
  budgeted: true,
  additionalAmountCents: true,
  payDay: true,
  frequency: true,
  payDayOfWeek: true,
  biweeklyAnchorDate: true,
  payMonth: true,
  annualAmountDue: true,
  rolloverEnabled: true,
  rolloverAmount: true,
  tag: { select: { id: true, name: true, shortName: true, parentId: true } },
  entity: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.BudgetSelect;

export type LoadedBudgetRow = Prisma.BudgetGetPayload<{ select: typeof EFFECTIVE_BUDGET_SELECT }>;
export type EffectiveBudgetRow = ResolvedBudgetRow<LoadedBudgetRow>;

/**
 * The narrower read for the date index (lib/bill-dates-build.ts): schedule columns only, no amounts other than
 * annualAmountDue, no account data. The tag path is selected only to recognise the default variable lines.
 */
const SCHEDULE_SELECT = {
  id: true,
  entityId: true,
  tagId: true,
  period: true,
  payDay: true,
  frequency: true,
  payDayOfWeek: true,
  biweeklyAnchorDate: true,
  payMonth: true,
  annualAmountDue: true,
  tag: { select: { name: true } },
} satisfies Prisma.BudgetSelect;

export type LoadedScheduleRow = Prisma.BudgetGetPayload<{ select: typeof SCHEDULE_SELECT }>;
export type EffectiveScheduleRow = ResolvedBudgetRow<LoadedScheduleRow>;

export interface LoadedEffectiveBudgets {
  rows: EffectiveBudgetRow[];
  failed: boolean;
}

async function readSeasonalLines(): Promise<SeasonalLine[] | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SEASONAL_LINES_KEY }, select: { value: true } });
    return parseSeasonalLinesSetting(row?.value);
  } catch (err) {
    console.error("Seasonal budget lines setting unreadable, default set applies", err instanceof Error ? err.name : "UnknownError");
    return null; // unreadable setting: the default set applies
  }
}

async function resolveLoaded<T extends CarryRowBase & { tag?: { name?: string } | null }>(
  rows: T[],
  periods: readonly string[]
): Promise<Array<ResolvedBudgetRow<T>>> {
  const variableKeys = variableLineKeys(rows, await readSeasonalLines());
  return resolveBudgetRows(rows, periods, { variableKeys });
}

/**
 * Effective Budget rows for `periods` (YYYY-MM): own rows, plus carried rows for lines with no row that month.
 * `entityId` limits the read to one entity (the frontier is per entity, so this does not change the answer).
 * Throws when the Budget read fails.
 */
export async function loadEffectiveBudgetRows(opts: {
  periods: readonly string[];
  entityId?: string | null;
}): Promise<EffectiveBudgetRow[]> {
  const periods = opts.periods.filter(isBudgetPeriod);
  if (periods.length === 0) return [];
  const rows = await db.budget.findMany({
    where: opts.entityId ? { entityId: opts.entityId } : {},
    orderBy: [{ period: "desc" }],
    take: MAX_ROWS,
    select: EFFECTIVE_BUDGET_SELECT,
  });
  return resolveLoaded(rows, periods);
}

/** Same as loadEffectiveBudgetRows but never rejects. */
export async function loadEffectiveBudgetRowsSafe(opts: {
  periods: readonly string[];
  entityId?: string | null;
}): Promise<LoadedEffectiveBudgets> {
  try {
    return { rows: await loadEffectiveBudgetRows(opts), failed: false };
  } catch (err) {
    console.error("Budget carry-forward unavailable", err instanceof Error ? err.name : "UnknownError");
    return { rows: [], failed: true };
  }
}

/** Schedule-only effective rows for the date index. Throws when the Budget read fails (the caller is fail-soft). */
export async function loadEffectiveScheduleRows(opts: { periods: readonly string[] }): Promise<EffectiveScheduleRow[]> {
  const periods = opts.periods.filter(isBudgetPeriod);
  if (periods.length === 0) return [];
  const rows = await db.budget.findMany({
    orderBy: [{ period: "desc" }],
    take: MAX_ROWS,
    select: SCHEDULE_SELECT,
  });
  return resolveLoaded(rows, periods);
}
