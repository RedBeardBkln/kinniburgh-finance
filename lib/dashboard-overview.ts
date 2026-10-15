// The dashboard's "where do we stand" model: every dollar of the month's Spent split into FIXED and VARIABLE expenses,
// plus the few variable lines most worth a look. Pure and client-safe (integer cents, no Decimal, no database, no
// clock: the caller passes how far through the month we are). Built from the SAME DrillData payload as every other
// dashboard number, so the items add up to Spent exactly: the budget lines' own spend + money tagged outside any line
// + untagged spend = Spent (before the multi-tag adjustment `duplicateCents`, which the headline already carries).
import type { DrillData } from "@/lib/dashboard-drill";
import { resolveKind, type ExpenseKind, type KindOverrides, type KindSource } from "@/lib/expense-kind";

export interface OverviewItem {
  key: string;
  /** The budget line this item opens; null = not in a budget line (opens the Spent breakdown). */
  lineId: string | null;
  /** The category the owner's Fixed/Variable choice is saved under; null = cannot be re-sorted. */
  tagId: string | null;
  name: string;
  fullName: string;
  kind: ExpenseKind;
  source: KindSource;
  basis: string;
  budgetCents: number;
  actualCents: number;
  /** The usual month for this item (mean of the months before this one that had spending); null = too little history. */
  usualCents: number | null;
}

export interface KindTotals {
  budgetCents: number;
  actualCents: number;
  count: number;
}

export interface WatchRow {
  key: string;
  lineId: string | null;
  name: string;
  /** One plain, observational sentence ("On pace for $412 against a $300 budget"). */
  text: string;
  /** How far past budget (or past usual) the item is, in cents; the list is sorted by this. */
  overCents: number;
}

export interface Overview {
  items: OverviewItem[];
  fixed: KindTotals;
  variable: KindTotals;
  /** Share of the month gone (0 to 1) for the current month; null for a past month. */
  elapsed: number | null;
  watch: WatchRow[];
  /** Variable items at or under budget and not on a pace to pass it. */
  variableOnTrack: number;
  /** False when the recent months could not be read: every line was counted as variable. */
  historyAvailable: boolean;
}

/** From this share of the month on, a straight-line pace is meaningful (earlier it just reflects when bills land). */
const MIN_ELAPSED_FOR_PACE = 0.25;
const PACE_MARGIN = 1.05;
const USUAL_MARGIN = 1.25;
const USUAL_MIN_DIFF_CENTS = 2500;
const MAX_WATCH = 5;

const MONTH_DAYS = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** How far through the New York month `now` is (day / days in month; the day counts as in progress). */
export function elapsedFractionNY(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const days = MONTH_DAYS(get("year"), get("month"));
  return Math.min(Math.max(get("day") / days, 0), 1);
}

function whole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function usualOf(history: readonly number[] | undefined): number | null {
  if (!history) return null;
  const spent = history.filter((c) => c > 0);
  if (spent.length < 3) return null;
  return Math.round(spent.reduce((a, b) => a + b, 0) / spent.length);
}

export interface OverviewInput {
  data: DrillData;
  /** Spend per budget line (id) in each of the months before the one shown, oldest first, cents, positive = spent. null = unreadable. */
  history: Record<string, number[]> | null;
  overrides: KindOverrides;
  /** Current month only: share of the month gone. null for a past month (everything has happened). */
  elapsed: number | null;
}

export function buildOverview({ data, history, overrides, elapsed }: OverviewInput): Overview {
  const items: OverviewItem[] = [];
  const lineById = new Map(data.lines.map((l) => [l.id, l]));

  for (const line of data.lines) {
    const lineHistory = history?.[line.id];
    const resolved = resolveKind(line.tagId, history ? (lineHistory ?? []) : null, overrides);
    if (!line.hasChildren) {
      items.push({
        key: line.id,
        lineId: line.id,
        tagId: line.tagId,
        name: line.shortName,
        fullName: line.label,
        ...resolved,
        budgetCents: line.effectiveCents,
        actualCents: line.rolledCents,
        usualCents: usualOf(lineHistory),
      });
      continue;
    }
    // A parent: its nested lines are items of their own; only what is tagged directly on the parent (and any budget it
    // states beyond its nested lines) is the parent's "other" item, so nothing is counted twice.
    const childBudget = line.childIds.reduce((sum, id) => sum + (lineById.get(id)?.effectiveCents ?? 0), 0);
    const otherBudget = line.rawCents !== null ? Math.max(0, line.effectiveCents - childBudget) : 0;
    if (line.ownCents !== 0 || otherBudget > 0) {
      items.push({
        key: line.id,
        lineId: line.id,
        tagId: line.tagId,
        name: `${line.shortName} (other)`,
        fullName: line.label,
        ...resolved,
        budgetCents: otherBudget,
        actualCents: line.ownCents,
        usualCents: usualOf(lineHistory),
      });
    }
  }

  const unbudgeted = (key: string, name: string, cents: number): OverviewItem => ({
    key,
    lineId: null,
    tagId: null,
    name,
    fullName: name,
    kind: "variable",
    source: "default",
    basis: "Not in any budget line, so it is counted as variable.",
    budgetCents: 0,
    actualCents: cents,
    usualCents: null,
  });
  for (const n of data.notInLine) if (n.cents !== 0) items.push(unbudgeted(n.key, n.label, n.cents));
  if (data.untagged.cents !== 0) items.push(unbudgeted("untagged", "Untagged", data.untagged.cents));

  const total = (kind: ExpenseKind): KindTotals => {
    const mine = items.filter((i) => i.kind === kind);
    return {
      budgetCents: mine.reduce((s, i) => s + i.budgetCents, 0),
      actualCents: mine.reduce((s, i) => s + i.actualCents, 0),
      count: mine.length,
    };
  };

  // ---- the variable lines most worth a look (observation, never advice)
  const paceOk = elapsed !== null && elapsed >= MIN_ELAPSED_FOR_PACE;
  const watch: WatchRow[] = [];
  let variableOnTrack = 0;
  for (const item of items) {
    if (item.kind !== "variable" || item.actualCents <= 0) {
      if (item.kind === "variable") variableOnTrack += 1;
      continue;
    }
    const projected = paceOk && elapsed ? Math.round(item.actualCents / elapsed) : null;
    const base = { key: item.key, lineId: item.lineId, name: item.name };
    if (item.actualCents > item.budgetCents) {
      const over = item.actualCents - item.budgetCents;
      watch.push({
        ...base,
        overCents: over,
        text:
          item.budgetCents > 0
            ? `${whole(item.actualCents)} spent, ${whole(over)} over the ${whole(item.budgetCents)} budget`
            : `${whole(item.actualCents)} spent with no budget set`,
      });
    } else if (projected !== null && item.budgetCents > 0 && projected > item.budgetCents * PACE_MARGIN) {
      const over = projected - item.budgetCents;
      watch.push({
        ...base,
        overCents: over,
        text: `On pace for ${whole(projected)} against a ${whole(item.budgetCents)} budget (${whole(item.actualCents)} so far)`,
      });
    } else if (
      item.usualCents !== null &&
      (projected ?? item.actualCents) > item.usualCents * USUAL_MARGIN &&
      (projected ?? item.actualCents) - item.usualCents >= USUAL_MIN_DIFF_CENTS
    ) {
      const pace = projected ?? item.actualCents;
      watch.push({
        ...base,
        overCents: pace - item.usualCents,
        text: `${projected !== null ? `On pace for ${whole(pace)}` : `${whole(pace)} spent`}, above the usual ${whole(item.usualCents)} a month`,
      });
    } else {
      variableOnTrack += 1;
    }
  }
  watch.sort((a, b) => b.overCents - a.overCents || a.name.localeCompare(b.name));

  return {
    items,
    fixed: total("fixed"),
    variable: total("variable"),
    elapsed,
    watch: watch.slice(0, MAX_WATCH),
    variableOnTrack,
    historyAvailable: history !== null,
  };
}
