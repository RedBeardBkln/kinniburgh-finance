// Fixed vs variable expenses for the dashboard chart. Pure and client-safe: no database, no clock, no Prisma.
//
// A budget line is FIXED when it costs about the same every month (mortgage, car payment, insurance) and VARIABLE when
// the amount moves with spending habits (groceries, clothes, restaurants). The app stores no such flag, so each line is
// sorted from its own spending in the months before the one shown, and the owner can override any line (saved by tag in
// an AppSetting, see lib/expense-kind-build.ts). An override always wins over the automatic call.

export type ExpenseKind = "fixed" | "variable";
export type KindSource = "you" | "history" | "default";

export interface KindOverrides {
  [tagId: string]: ExpenseKind;
}

export interface ResolvedKind {
  kind: ExpenseKind;
  source: KindSource;
  /** One plain sentence saying why, shown beside the line in the "how lines are sorted" list. */
  basis: string;
}

/** How many full months before the month shown are read. */
export const HISTORY_MONTHS = 6;
/** Fewer months than this with any spending is "not enough history" and the line stays variable. */
export const MIN_MONTHS_WITH_SPEND = 4;
/** A month's spend may differ from the median by this share (or the dollar floor) and still count as "the same". */
const FIXED_TOLERANCE = 0.1;
const FIXED_FLOOR_CENTS = 300;

export const OVERRIDES_SETTING_KEY = "expense_kind_overrides";
const MAX_OVERRIDES = 400;

function whole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Sort one line from its monthly spend. `history` is the spend (integer cents, positive = spent) in each of the months
 * before the one shown, oldest first. Months with no spend count as "no spend". Needs spending in at least
 * MIN_MONTHS_WITH_SPEND months; every one of those months must sit within 10% (or $3) of the median to be fixed.
 */
export function classifyFromHistory(history: readonly number[]): ResolvedKind {
  const spent = history.filter((c) => c > 0);
  if (history.length === 0) {
    return { kind: "variable", source: "default", basis: "No earlier months to compare yet, so this is counted as variable." };
  }
  if (spent.length < MIN_MONTHS_WITH_SPEND) {
    return {
      kind: "variable",
      source: "default",
      basis: `Not enough history yet: spending in ${spent.length} of the last ${history.length} months (needs ${MIN_MONTHS_WITH_SPEND}).`,
    };
  }
  const mid = median(spent);
  const tolerance = Math.max(Math.round(mid * FIXED_TOLERANCE), FIXED_FLOOR_CENTS);
  const steady = spent.every((c) => Math.abs(c - mid) <= tolerance);
  if (steady) {
    return {
      kind: "fixed",
      source: "history",
      basis: `About ${whole(mid)} in ${spent.length} of the last ${history.length} months.`,
    };
  }
  return {
    kind: "variable",
    source: "history",
    basis: `Ranged from ${whole(Math.min(...spent))} to ${whole(Math.max(...spent))} over the last ${history.length} months.`,
  };
}

/** The owner's choice if there is one, else the automatic call. `history` null = it could not be read. */
export function resolveKind(
  tagId: string,
  history: readonly number[] | null,
  overrides: KindOverrides
): ResolvedKind {
  const chosen = overrides[tagId];
  if (chosen) return { kind: chosen, source: "you", basis: "Set by you." };
  if (!history) {
    return { kind: "variable", source: "default", basis: "Recent months could not be read, so this is counted as variable." };
  }
  return classifyFromHistory(history);
}

/** Read the saved overrides; anything unreadable is an empty set (a corrupt setting never breaks the page). */
export function parseOverrides(raw: string | null): KindOverrides {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const kinds = (parsed as { kinds?: unknown }).kinds;
    if (!kinds || typeof kinds !== "object") return {};
    const out: KindOverrides = {};
    for (const [tagId, kind] of Object.entries(kinds as Record<string, unknown>)) {
      if (kind === "fixed" || kind === "variable") out[tagId] = kind;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeOverrides(overrides: KindOverrides): string {
  return JSON.stringify({ v: 1, kinds: overrides });
}

/** Set (kind) or clear (null) one tag's override. Returns null when the 400-entry cap would be exceeded. */
export function withOverride(overrides: KindOverrides, tagId: string, kind: ExpenseKind | null): KindOverrides | null {
  const next = { ...overrides };
  if (kind === null) {
    delete next[tagId];
    return next;
  }
  if (!(tagId in next) && Object.keys(next).length >= MAX_OVERRIDES) return null;
  next[tagId] = kind;
  return next;
}
