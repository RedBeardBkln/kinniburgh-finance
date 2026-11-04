// The printable Personal reports: a one-page weekly check-in (where the current month stands, drawn as charts) and a
// one-page month-end summary (every budget line, budgeted against spent). Pure and client-safe: integer cents, no
// Decimal, no database, no clock (the caller passes today's New York calendar day). Both are built from the SAME
// DrillData payload as the dashboard, so Spent, Total Budgeted and every line agree with the dashboard and /budgets.
// Wording is observational ("on pace for"), never advice.
import type { DrillData, DrillLine } from "@/lib/dashboard-drill";
import type { Overview, WatchRow } from "@/lib/dashboard-overview";

/** From this share of the month on, a straight-line month-end figure is shown (earlier it mostly reflects when bills land). */
export const MIN_ELAPSED_FOR_PROJECTION = 0.25;
const CATEGORY_BARS = 10;
const BIGGEST_ROWS = 5;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The New York calendar day (YYYY-MM-DD) of an instant. */
export function nyCalendarDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Weekday (0 = Sunday) of the 1st of a period. */
export function firstWeekdayOf(period: string): number {
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1)).getUTCDay();
}

/** The period `delta` months from `period`. */
export function shiftPeriod(period: string, delta: number): string {
  const d = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "November 2026". */
export function periodLabel(period: string): string {
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[Number(period.slice(5, 7)) - 1] ?? ""} ${period.slice(0, 4)}`;
}

export function daysInPeriod(period: string): number {
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();
}

function dayOf(day: string): number {
  return Number(day.slice(8, 10));
}

function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

/** Positive = money spent, negative = a refund; 0 for anything that is not part of Spent. */
function spendCents(cls: string, cents: number): number {
  return cls === "spending" || cls === "refund" ? -cents : 0;
}

// ── Weekly check-in ──────────────────────────────────────────────────────────

export interface WeekBucket {
  /** "Nov 1-7" */
  label: string;
  fromDay: number;
  toDay: number;
  spentCents: number;
  /** Contains today. */
  current: boolean;
  /** Starts after today: nothing has happened yet. */
  future: boolean;
}

export interface CategoryBar {
  key: string;
  name: string;
  budgetCents: number;
  spentCents: number;
  /** Spent above budget (a line with no budget and some spending counts as over). */
  over: boolean;
  /** Folded "all other lines" bar. */
  folded: boolean;
}

export interface BigPurchase {
  id: string;
  day: string;
  payee: string;
  category: string;
  cents: number;
  pending: boolean;
}

export interface WeeklyReport {
  periodLabel: string;
  /** YYYY-MM-DD, New York calendar day the report is for. */
  today: string;
  /** A past month: shown as the whole month, with no pace projection. */
  complete: boolean;
  dayOfMonth: number;
  daysInMonth: number;
  daysLeft: number;
  /** Share of the month gone, 0-100 (today counts as in progress). */
  elapsedPct: number;
  spentCents: number;
  budgetCents: number;
  /** Budget minus spent (negative = over). */
  leftCents: number;
  /** Spent / budget, 0-100+ (null when nothing is budgeted). */
  usedPct: number | null;
  /** Straight-line month-end spend at the current pace; null before a quarter of the month is gone. */
  projectedCents: number | null;
  /** What is left per remaining day to stay inside the budget (null when over budget or on the last day). */
  perDayLeftCents: number | null;
  /** The last 7 days through today (clipped to this month). */
  lastSeven: { fromDay: string; toDay: string; spentCents: number; count: number };
  weeks: WeekBucket[];
  categories: CategoryBar[];
  overspentCount: number;
  lineCount: number;
  fixed: { budgetCents: number; actualCents: number } | null;
  variable: { budgetCents: number; actualCents: number } | null;
  /** False when the fixed / variable split is a default (history unreadable). */
  splitFromHistory: boolean;
  watch: WatchRow[];
  biggest: BigPurchase[];
  incomeCents: number;
  pendingCount: number;
  /** The weekly bars add up to Spent. */
  reconciles: boolean;
}

function shortDay(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1] ?? ""} ${dayOf(day)}`;
}

function lineCategoryName(data: DrillData, tagIds: string[], tagPaths: string[]): string {
  const line = data.lines.find((l) => tagIds.includes(l.tagId));
  if (line) return line.shortName;
  const path = tagPaths[0];
  if (!path) return "Untagged";
  const parts = path.split(" / ");
  return parts[parts.length - 1] ?? path;
}

export function buildWeeklyReport(data: DrillData, overview: Overview | null, today: string): WeeklyReport {
  const period = data.period;
  const daysInMonth = daysInPeriod(period);
  const inMonth = today.slice(0, 7) === period;
  // A past month is shown as complete; a current month up to today.
  const dayOfMonth = inMonth ? dayOf(today) : daysInMonth;
  const elapsed = dayOfMonth / daysInMonth;

  const spending = data.txs
    .map((t) => ({ t, spend: spendCents(t.cls, t.cents) }))
    .filter((r) => r.spend !== 0);

  // Weeks of the month: 1-7, 8-14, 15-21, 22-28, 29-end.
  const weeks: WeekBucket[] = [];
  const monthName = MONTHS[Number(period.slice(5, 7)) - 1] ?? "";
  for (let from = 1; from <= daysInMonth; from += 7) {
    const to = Math.min(from + 6, daysInMonth);
    const spentCents = spending.filter((r) => dayOf(r.t.day) >= from && dayOf(r.t.day) <= to).reduce((s, r) => s + r.spend, 0);
    weeks.push({
      label: from === to ? `${monthName} ${from}` : `${monthName} ${from}-${to}`,
      fromDay: from,
      toDay: to,
      spentCents,
      current: dayOfMonth >= from && dayOfMonth <= to,
      future: from > dayOfMonth,
    });
  }
  const reconciles = weeks.reduce((s, w) => s + w.spentCents, 0) === data.spentCents;

  const fromDayNum = Math.max(1, dayOfMonth - 6);
  const lastSevenRows = spending.filter((r) => dayOf(r.t.day) >= fromDayNum && dayOf(r.t.day) <= dayOfMonth);
  const dayStr = (d: number) => `${period}-${String(d).padStart(2, "0")}`;
  const lastSeven = {
    fromDay: shortDay(dayStr(fromDayNum)),
    toDay: shortDay(dayStr(dayOfMonth)),
    spentCents: lastSevenRows.reduce((s, r) => s + r.spend, 0),
    count: lastSevenRows.filter((r) => r.spend > 0).length,
  };

  const biggest: BigPurchase[] = lastSevenRows
    .filter((r) => r.spend > 0)
    .sort((a, b) => b.spend - a.spend || b.t.day.localeCompare(a.t.day))
    .slice(0, BIGGEST_ROWS)
    .map((r) => ({
      id: r.t.id,
      day: shortDay(r.t.day),
      payee: r.t.payee,
      category: lineCategoryName(data, r.t.tagIds, r.t.tagPaths),
      cents: r.spend,
      pending: r.t.pending,
    }));

  // Category bars: the top-level budget lines, biggest first; the rest folded into one bar so the chart stays one page.
  const roots = data.lines.filter((l) => l.parentId === null && (l.effectiveCents !== 0 || l.rolledCents !== 0));
  const sized = [...roots].sort(
    (a, b) => Math.max(b.effectiveCents, b.rolledCents) - Math.max(a.effectiveCents, a.rolledCents) || a.label.localeCompare(b.label)
  );
  const toBar = (l: DrillLine): CategoryBar => ({
    key: l.id,
    name: l.shortName,
    budgetCents: l.effectiveCents,
    spentCents: l.rolledCents,
    over: l.rolledCents > l.effectiveCents && l.rolledCents > 0,
    folded: false,
  });
  const notInLineCents = data.notInLine.reduce((s, n) => s + n.cents, 0) + data.untagged.cents - data.duplicateCents;
  const reserve = notInLineCents !== 0 ? 1 : 0;
  const shown = sized.length > CATEGORY_BARS - reserve ? sized.slice(0, CATEGORY_BARS - reserve - 1) : sized;
  const rest = sized.slice(shown.length);
  const categories = shown.map(toBar);
  if (rest.length > 0) {
    const budgetCents = rest.reduce((s, l) => s + l.effectiveCents, 0);
    const spentCents = rest.reduce((s, l) => s + l.rolledCents, 0);
    categories.push({
      key: "rest",
      name: `${rest.length} other line${rest.length === 1 ? "" : "s"}`,
      budgetCents,
      spentCents,
      over: spentCents > budgetCents && spentCents > 0,
      folded: true,
    });
  }
  if (notInLineCents !== 0) {
    categories.push({
      key: "outside",
      name: "Not in a budget line",
      budgetCents: 0,
      spentCents: notInLineCents,
      over: false,
      folded: true,
    });
  }

  const leftCents = data.totalBudgetedCents - data.spentCents;
  const daysLeft = daysInMonth - dayOfMonth;
  const projectedCents = inMonth && elapsed >= MIN_ELAPSED_FOR_PROJECTION && elapsed < 1 ? Math.round(data.spentCents / elapsed) : null;

  return {
    periodLabel: data.periodLabel,
    today,
    complete: !inMonth,
    dayOfMonth,
    daysInMonth,
    daysLeft,
    elapsedPct: Math.round(elapsed * 100),
    spentCents: data.spentCents,
    budgetCents: data.totalBudgetedCents,
    leftCents,
    usedPct: pct(data.spentCents, data.totalBudgetedCents),
    projectedCents,
    // whole days still to come after today
    perDayLeftCents: leftCents > 0 && daysLeft > 0 ? Math.floor(leftCents / daysLeft) : null,
    lastSeven,
    weeks,
    categories,
    overspentCount: data.overspentCount,
    lineCount: data.lines.length,
    fixed: overview ? { budgetCents: overview.fixed.budgetCents, actualCents: overview.fixed.actualCents } : null,
    variable: overview ? { budgetCents: overview.variable.budgetCents, actualCents: overview.variable.actualCents } : null,
    splitFromHistory: overview?.historyAvailable ?? false,
    watch: overview?.watch ?? [],
    biggest,
    incomeCents: data.incomeCents,
    pendingCount: data.pendingCount,
    reconciles,
  };
}

// ── Month-end summary ────────────────────────────────────────────────────────

export interface MonthlyRow {
  key: string;
  label: string;
  depth: number;
  /** null for money outside any budget line. */
  budgetCents: number | null;
  spentCents: number;
  remainingCents: number | null;
  usedPct: number | null;
  /** Counted in Overspent Lines (the dashboard's definition). */
  over: boolean;
  /** A parent line: its spent already includes the nested lines below it. */
  parent: boolean;
}

export interface MonthlySection {
  key: string;
  title: string;
  budgetCents: number;
  spentCents: number;
  rows: MonthlyRow[];
}

export interface MonthlyReport {
  periodLabel: string;
  /** The month is still in progress (the report then says it is a partial month). */
  partial: boolean;
  spentCents: number;
  budgetCents: number;
  remainingCents: number;
  usedPct: number | null;
  overspentCount: number;
  lineCount: number;
  underCount: number;
  sections: MonthlySection[];
  /** Spending tagged outside every budget line, untagged spending and the multi-tag correction. */
  outside: MonthlyRow[];
  outsideCents: number;
  topOver: { key: string; label: string; overCents: number; budgetCents: number; spentCents: number }[];
  incomeCents: number;
  refundsCents: number;
  refundCount: number;
  outflowCents: number;
  pendingCount: number;
  /** Sections + outside = Spent. */
  reconciles: boolean;
}

export function buildMonthlyReport(data: DrillData): MonthlyReport {
  const lineById = new Map(data.lines.map((l) => [l.id, l]));
  const sections: MonthlySection[] = data.groups.map((g) => ({
    key: g.accountId,
    title: g.accountName,
    budgetCents: g.budgetCents,
    spentCents: g.spentCents,
    rows: g.lineIds
      .map((id) => lineById.get(id))
      .filter((l): l is DrillLine => l !== undefined)
      .map((l) => ({
        key: l.id,
        label: l.shortName,
        depth: l.depth,
        budgetCents: l.effectiveCents,
        spentCents: l.rolledCents,
        remainingCents: l.remainingCents,
        usedPct: pct(l.rolledCents, l.effectiveCents),
        over: l.countsAsOverspent,
        parent: l.hasChildren,
      })),
  }));

  const outside: MonthlyRow[] = [];
  const outsideRow = (key: string, label: string, cents: number): MonthlyRow => ({
    key,
    label,
    depth: 0,
    budgetCents: null,
    spentCents: cents,
    remainingCents: null,
    usedPct: null,
    over: false,
    parent: false,
  });
  for (const n of [...data.notInLine].sort((a, b) => b.cents - a.cents || a.label.localeCompare(b.label))) {
    if (n.cents !== 0) outside.push(outsideRow(n.key, n.label, n.cents));
  }
  if (data.untagged.cents !== 0) outside.push(outsideRow("untagged", "Untagged", data.untagged.cents));
  if (data.duplicateCents !== 0) outside.push(outsideRow("duplicate", "Counted under two lines (correction)", -data.duplicateCents));
  const outsideCents = outside.reduce((s, r) => s + r.spentCents, 0);

  const sectionSpent = sections.reduce((s, sec) => s + sec.spentCents, 0);
  const topOver = data.lines
    .filter((l) => l.countsAsOverspent)
    .map((l) => ({ key: l.id, label: l.shortName, overCents: l.overByCents, budgetCents: l.effectiveCents, spentCents: l.rolledCents }))
    .sort((a, b) => b.overCents - a.overCents || a.label.localeCompare(b.label))
    .slice(0, 5);

  return {
    periodLabel: data.periodLabel,
    partial: data.isCurrentPeriod,
    spentCents: data.spentCents,
    budgetCents: data.totalBudgetedCents,
    remainingCents: data.totalBudgetedCents - data.spentCents,
    usedPct: pct(data.spentCents, data.totalBudgetedCents),
    overspentCount: data.overspentCount,
    lineCount: data.lines.length,
    underCount: data.lines.filter((l) => !l.hasChildren && l.effectiveCents > 0 && l.rolledCents <= l.effectiveCents).length,
    sections,
    outside,
    outsideCents,
    topOver,
    incomeCents: data.incomeCents,
    refundsCents: data.refundsCents,
    refundCount: data.refundCount,
    outflowCents: data.outflowCents,
    pendingCount: data.pendingCount,
    reconciles: sectionSpent + outsideCents === data.spentCents,
  };
}

/** Page 1 holds the Primary Checking account's lines (the household's main budget account; the section with the most
 *  lines when no account has that name), page 2 every other account in their original order. */
export function splitPages(sections: MonthlySection[]): { first: MonthlySection | null; rest: MonthlySection[] } {
  if (sections.length === 0) return { first: null, rest: [] };
  const named = sections.find((s) => /\bprimary\s+checking\b/i.test(s.title));
  const first = named ?? sections.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  return { first, rest: sections.filter((s) => s !== first) };
}

/** Split one section's rows over two columns near the middle, only before a top-level line so a parent stays with
 *  the lines nested under it. */
export function splitRows(rows: MonthlyRow[]): [MonthlyRow[], MonthlyRow[]] {
  if (rows.length < 2) return [rows, []];
  const half = rows.length / 2;
  let best = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i]?.depth !== 0) continue;
    if (best === 0 || Math.abs(i - half) < Math.abs(best - half)) best = i;
  }
  return best === 0 ? [rows, []] : [rows.slice(0, best), rows.slice(best)];
}

/** Balance the sections over two print columns by row count (keeps each section whole, original order). */
export function splitColumns(sections: MonthlySection[], extraRowsAtEnd: number): [MonthlySection[], MonthlySection[]] {
  const weight = (s: MonthlySection) => s.rows.length + 2;
  const total = sections.reduce((s, sec) => s + weight(sec), 0) + extraRowsAtEnd;
  const left: MonthlySection[] = [];
  let acc = 0;
  let i = 0;
  for (; i < sections.length; i += 1) {
    const sec = sections[i];
    if (!sec) break;
    if (left.length > 0 && acc + weight(sec) / 2 > total / 2) break;
    left.push(sec);
    acc += weight(sec);
  }
  return [left, sections.slice(i)];
}
