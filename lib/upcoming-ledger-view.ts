// Pure presentation helpers for the upcoming ledger: turns the builder's Decimal / Date result into
// plain strings (the repo convention is that components never receive Decimal or Date instances),
// plus grouping, truncation and link helpers. No DB, no Prisma client, no clock.
//
// Wording is observational only: "due", "expected", "~$X". Never "will", never advice.

import type {
  AmountStatus,
  ConfidenceTier,
  Discrepancy,
  ItemKind,
  LedgerTotals,
  LinkTarget,
  UpcomingItem,
  UpcomingLedger,
  UpcomingSource,
  LearnedCadence,
} from "@/lib/upcoming-ledger";
import type { Cadence, Confidence, DetectionBundle, Series } from "@/lib/recurring-detect";
import { suggestedTagId } from "@/lib/recurring-add-step";

// ── Money (integer cents on strings; never floats) ───────────────────────────

function toCents(s: string): number {
  const neg = s.startsWith("-");
  const [whole = "0", frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
}

function fromCents(c: number): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** "1234.5" -> "1,234.50" (magnitude only). */
export function formatMoney(amount: string): string {
  const [whole = "0", frac = ""] = amount.replace("-", "").split(".");
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withCommas}.${(frac + "00").slice(0, 2)}`;
}

/** "~$1,234.56": an approximate figure from a scheduled or estimated record. */
export function approx(amount: string): string {
  return `~$${formatMoney(amount)}`;
}

// ── Dates (stored UTC midnight calendar dates, formatted as UTC so Oct 12 stays Oct 12) ──

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function parseIso(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** "2026-10-08" -> "Thu, Oct 8" (with the year when `withYear`). */
export function formatDay(iso: string, withYear = false): string {
  const d = parseIso(iso);
  const base = `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return withYear ? `${base}, ${d.getUTCFullYear()}` : base;
}

/** "2026-10-08" -> "Oct 8". */
export function formatShort(iso: string): string {
  const d = parseIso(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Monday on or before the given date (week starts Monday). */
export function mondayOf(iso: string): string {
  const d = parseIso(iso);
  const delta = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - delta * 86_400_000).toISOString().slice(0, 10);
}

// ── Labels ───────────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<UpcomingSource, string> = {
  scheduled_bill: "Scheduled bill",
  budget_line: "Budget line",
  recurring_expense: "Recurring expense",
  accrual_draw: "Accrual draw",
  card_statement: "Card statement",
  scheduled_transfer: "Envelope transfer",
  income_source: "Paycheck",
  rental_payout: "Rental payout",
  projected_revenue: "Projected revenue",
  tax_deadline: "Tax deadline",
  policy_expiry: "Policy expiry",
  learned_history: "Learned from history",
};

export function sourceLabel(source: UpcomingSource): string {
  return SOURCE_LABELS[source];
}

/** How a record is named inside a "records disagree" note. */
const RECORD_NAMES: Record<UpcomingSource, string> = {
  scheduled_bill: "bill record",
  budget_line: "budget",
  recurring_expense: "recurring expense",
  accrual_draw: "accrual draw",
  card_statement: "card statement",
  scheduled_transfer: "transfer",
  income_source: "paycheck record",
  rental_payout: "rental booking",
  projected_revenue: "projected revenue",
  tax_deadline: "tax deadline",
  policy_expiry: "policy",
  learned_history: "learned pattern",
};

export function tierLabel(tier: ConfidenceTier): string {
  return tier === "scheduled" ? "scheduled" : tier === "estimated" ? "estimate" : "learned";
}

// ── Links ────────────────────────────────────────────────────────────────────

/** Where a row's label should lead. `bucketSlug` is the slug of the row's own entity (or the active bucket). */
export function hrefFor(link: LinkTarget, bucketSlug: string): string {
  const hash = link.anchor ? `#${link.anchor}` : "";
  switch (link.page) {
    case "budgets":
      return `/budgets?bucket=${bucketSlug}${link.period ? `&period=${link.period}` : ""}${hash}`;
    case "forecast":
      return `/forecast?bucket=${bucketSlug}${hash}`;
    case "revenue":
      return `/business/${bucketSlug}/revenue${hash}`;
    case "envelope":
      return `/envelope${hash}`;
    case "accounts":
      return `/accounts${hash}`;
    case "tax":
      return `/tax${hash}`;
    case "vault":
      return `/vault${hash}`;
  }
}

// ── Plain (UI-bound) shapes ──────────────────────────────────────────────────

export interface UiItem {
  id: string;
  dateIso: string | null;
  dateLabel: string | null;
  label: string;
  sourceLabel: string;
  kind: ItemKind;
  tier: ConfidenceTier;
  /** True for tier "estimated": the row carries an "estimate" badge. */
  estimate: boolean;
  tierNote: string | null;
  amountStatus: AmountStatus;
  /** Signed 2-decimal string, null when not known. */
  amount: string | null;
  /** "~$1,234.56", "amount not set", or "" for items without an amount (deadlines). */
  amountText: string;
  direction: "out" | "in" | "none";
  entityId: string;
  entityName: string;
  href: string;
  accountName: string | null;
  disagreements: string[];
  notes: string[];
}

export interface UiTotals {
  outflow: string;
  outflowEstimated: string;
  inflow: string;
  inflowEstimated: string;
  unknownAmountCount: number;
  transferCount: number;
  transferTotal: string;
}

export interface UiLedger {
  fromIso: string;
  /** Last day inside the window (inclusive). */
  lastDayIso: string;
  days: number;
  isAggregate: boolean;
  items: UiItem[];
  undated: UiItem[];
  pastDue: UiItem[];
  /**
   * True when every past-due row is a card statement whose paid-statement check ran and found no payment: the box then
   * says "no payment found yet" instead of "may already be paid". Absent / false = the original wording.
   */
  pastDueChecked?: boolean;
  /** Card statements found paid (a muted line, never counted). Absent = none. */
  paidCards?: UiItem[];
  heldBack: UiItem[];
  totals: UiTotals;
  /** One entry per entity, sorted by name. The aggregate view shows these, never a blended total. */
  entityTotals: { entityId: string; entityName: string; totals: UiTotals }[];
  biggest: UiItem | null;
  transferSummary: { count: number; total: string };
  /** History-learned recurring bills: shown in their own block, NEVER part of any total above. */
  learned: UiItem[];
  /** Positive 2-decimal magnitude of the learned items (its own subtotal). */
  learnedTotal: string;
  /** The same learned items collapsed to ONE row per series (what the agenda shows). */
  learnedSeries: UiLearnedSeries[];
  /**
   * Sum of the series' monthly-equivalent amounts, positive 2-decimal. A pattern figure ("about this much a month"),
   * never a counted or due total.
   */
  learnedMonthly: string;
  /** Series per entity (sorted by name): the all-entities view shows counts, never blended money. */
  learnedEntityCounts: { entityName: string; count: number }[];
}

/** One history-learned recurring series, collapsed from its dated occurrences in the window. */
export interface UiLearnedSeries {
  /** Series key (the dated items carry it as their source id). */
  key: string;
  label: string;
  entityId: string;
  entityName: string;
  href: string;
  cadence: LearnedCadence;
  /** First expected date inside the window. */
  nextDateIso: string;
  /** Positive 2-decimal amount of ONE payment. */
  amount: string;
  /** Positive 2-decimal monthly equivalent of that payment. */
  monthly: string;
  /** How many dates the series has inside the window (information only). */
  datesInWindow: number;
  /** "monthly, ~$21.26, next Nov 6". */
  phrase: string;
  /** The facts behind the pattern. */
  why: string | null;
  notes: string[];
}

export interface UiContext {
  days: number;
  bucketSlug: string;
  isAggregate: boolean;
  entityNameById: Record<string, string>;
  entitySlugById: Record<string, string | null>;
  accountNameById: Record<string, string>;
  /** Transfers are listed only when asked for (they are never counted either way). */
  includeTransfers: boolean;
}

function totalsToUi(t: LedgerTotals): UiTotals {
  return {
    outflow: t.outflow.toFixed(2),
    outflowEstimated: t.outflowEstimated.toFixed(2),
    inflow: t.inflow.toFixed(2),
    inflowEstimated: t.inflowEstimated.toFixed(2),
    unknownAmountCount: t.unknownAmountCount,
    transferCount: t.transferCount,
    transferTotal: t.transferTotal.toFixed(2),
  };
}

function disagreementText(item: UpcomingItem, d: Discrepancy): string {
  const mine = RECORD_NAMES[item.source];
  const theirs = RECORD_NAMES[d.otherSource];
  if (d.kind === "monthly_amount") {
    return `Records disagree: ${theirs} says ${approx(d.otherAmount.toFixed(2))} a month, ${mine} says ${approx(d.thisAmount.toFixed(2))}`;
  }
  return `Records disagree: ${theirs} says day ${d.otherDay}, ${mine} says day ${d.thisDay}`;
}

function itemToUi(item: UpcomingItem, ctx: UiContext): UiItem {
  const iso = item.date ? item.date.toISOString().slice(0, 10) : null;
  const slug = ctx.entitySlugById[item.entityId] ?? ctx.bucketSlug;
  const amount = item.amount ? item.amount.toFixed(2) : null;
  let amountText = "";
  if (item.amountStatus === "known" && amount !== null) amountText = approx(amount);
  else if (item.amountStatus === "unknown") amountText = "amount not set";
  const direction: UiItem["direction"] =
    item.amountStatus !== "known" || !item.amount ? "none" : item.amount.isNegative() ? "out" : "in";
  return {
    id: item.id,
    dateIso: iso,
    dateLabel: iso ? formatDay(iso) : null,
    label: item.label,
    sourceLabel: sourceLabel(item.source),
    kind: item.kind,
    tier: item.tier,
    estimate: item.tier === "estimated",
    tierNote: item.tierNote ?? null,
    amountStatus: item.amountStatus,
    amount,
    amountText,
    direction,
    entityId: item.entityId,
    entityName: ctx.entityNameById[item.entityId] ?? "Unknown entity",
    href: hrefFor(item.link, slug),
    accountName: item.accountId ? (ctx.accountNameById[item.accountId] ?? null) : null,
    disagreements: item.discrepancies.map((d) => disagreementText(item, d)),
    notes: item.notes,
  };
}

export function toUiLedger(ledger: UpcomingLedger, ctx: UiContext): UiLedger {
  const keep = (i: UpcomingItem) => ctx.includeTransfers || i.kind !== "transfer";
  const entityTotals = Object.entries(ledger.totalsByEntity)
    .map(([entityId, totals]) => ({
      entityId,
      entityName: ctx.entityNameById[entityId] ?? "Unknown entity",
      totals: totalsToUi(totals),
    }))
    .sort((a, b) => (a.entityName < b.entityName ? -1 : a.entityName > b.entityName ? 1 : 0));
  return {
    fromIso: ledger.from.toISOString().slice(0, 10),
    lastDayIso: new Date(ledger.to.getTime() - 86_400_000).toISOString().slice(0, 10),
    days: ctx.days,
    isAggregate: ctx.isAggregate,
    items: ledger.items.filter(keep).map((i) => itemToUi(i, ctx)),
    undated: ledger.undated.map((i) => itemToUi(i, ctx)),
    pastDue: ledger.pastDue.map((i) => itemToUi(i, ctx)),
    pastDueChecked: ledger.pastDue.length > 0 && ledger.pastDue.every((i) => i.paymentCheck === "none_found"),
    paidCards: ledger.paidCards.map((i) => itemToUi(i, ctx)),
    heldBack: ledger.heldBack.map((i) => itemToUi(i, ctx)),
    totals: totalsToUi(ledger.totals),
    entityTotals,
    biggest: ledger.biggest ? itemToUi(ledger.biggest, ctx) : null,
    transferSummary: { count: ledger.totals.transferCount, total: ledger.totals.transferTotal.toFixed(2) },
    learned: ledger.learned.map((i) => itemToUi(i, ctx)),
    learnedTotal: ledger.learnedTotals.outflow.toFixed(2),
    ...collapseLearned(ledger.learned, ctx),
  };
}

// ── Learned items, one row per series ────────────────────────────────────────

const CADENCE_WORD: Record<LearnedCadence, string> = {
  weekly: "weekly",
  biweekly: "every two weeks",
  monthly: "monthly",
  quarterly: "quarterly",
  annual: "yearly",
};

/** Monthly equivalent of one payment, in whole cents (integer math only). */
function monthlyCents(cents: number, cadence: LearnedCadence): number {
  switch (cadence) {
    case "weekly":
      return Math.round((cents * 52) / 12);
    case "biweekly":
      return Math.round((cents * 26) / 12);
    case "monthly":
      return cents;
    case "quarterly":
      return Math.round(cents / 3);
    case "annual":
      return Math.round(cents / 12);
  }
}

/**
 * Collapses the learned ledger items (one per occurrence in the window) into ONE row per series: the next expected
 * date, the amount of one payment and a short cadence phrase ("monthly, ~$21.26, next Nov 6"). Order follows the
 * first date of each series. The monthly figure is each series' monthly equivalent summed once; it is a pattern
 * figure and never a counted total. `ledger.learned` itself is left exactly as the builder made it.
 */
export function collapseLearned(
  learned: UpcomingItem[],
  ctx: Pick<UiContext, "bucketSlug" | "entityNameById" | "entitySlugById">
): { learnedSeries: UiLearnedSeries[]; learnedMonthly: string; learnedEntityCounts: { entityName: string; count: number }[] } {
  const bySeries = new Map<string, { first: UpcomingItem; amount: string; count: number }>();
  for (const item of learned) {
    if (!item.date || !item.learnedCadence || !item.amount) continue;
    const prior = bySeries.get(item.sourceId);
    if (prior) prior.count += 1;
    else bySeries.set(item.sourceId, { first: item, amount: item.amount.abs().toFixed(2), count: 1 });
  }
  const series: UiLearnedSeries[] = [];
  let monthlySum = 0;
  const perEntity = new Map<string, number>();
  for (const [key, { first, amount, count }] of bySeries) {
    const cadence = first.learnedCadence as LearnedCadence;
    const monthly = monthlyCents(toCents(amount), cadence);
    monthlySum += monthly;
    const nextDateIso = (first.date as Date).toISOString().slice(0, 10);
    const entityName = ctx.entityNameById[first.entityId] ?? "Unknown entity";
    perEntity.set(entityName, (perEntity.get(entityName) ?? 0) + 1);
    const slug = ctx.entitySlugById[first.entityId] ?? ctx.bucketSlug;
    series.push({
      key,
      label: first.label,
      entityId: first.entityId,
      entityName,
      href: hrefFor(first.link, slug),
      cadence,
      nextDateIso,
      amount,
      monthly: fromCents(monthly),
      datesInWindow: count,
      phrase: `${CADENCE_WORD[cadence]}, ${approx(amount)}, next ${formatShort(nextDateIso)}`,
      why: first.tierNote ?? null,
      // The block heading already says "looks recurring"; keep only the per-series note (amount varies).
      notes: first.notes.filter((n) => !n.startsWith("Looks recurring from your history")),
    });
  }
  return {
    learnedSeries: series,
    learnedMonthly: fromCents(monthlySum),
    learnedEntityCounts: [...perEntity.entries()]
      .map(([entityName, count]) => ({ entityName, count }))
      .sort((a, b) => (a.entityName < b.entityName ? -1 : a.entityName > b.entityName ? 1 : 0)),
  };
}

// ── Recurring-pattern detection (lib/recurring-detect.ts) ─────────────────────

export const RECURRING_UNAVAILABLE = "Recurring-pattern checks are unavailable right now.";
export const RECURRING_FOOTER =
  "Based on your last 18 months of transactions. These are patterns, not bills, and are not included in the totals above.";

export interface UiSuggestion {
  key: string;
  entityId: string;
  entityName: string;
  payee: string;
  kind: "outflow" | "inflow";
  cadence: Cadence;
  /** "~$28.70 monthly, usually around the 5th". */
  summary: string;
  confidence: Confidence;
  /** "Strong pattern" / "Likely" / "Weak pattern, 3 times". */
  confidenceLabel: string;
  /** The facts behind the pattern, one sentence. */
  why: string;
  /** "Next expected around Oct 14", or null when the pattern is too weak to date. */
  nextLabel: string | null;
  /** True when the owner may turn it into a recurring expense (an outflow). */
  canAdd: boolean;
  /** Budget tag the Add step pre-selects (one tag covers at least 60% of the series' rows), or null/absent = none. */
  suggestedTagId?: string | null;
  /** The amount of ONE payment in cents and its recurring-expense frequency: display only (the pre-confirm Budgets notice). The server re-derives them on Add. */
  amountCents?: number;
  recurringFrequency?: string;
}

/** A budget category the Add step offers: id plus the full hierarchy path the Budgets / Forecast pages show. */
export interface UiTagOption {
  id: string;
  label: string;
}

/** Tag rows (all tags, name order) as plain options. Tags are household-wide: there is no archived or per-entity tag. */
export function toTagOptions(tags: { id: string; name: string }[]): UiTagOption[] {
  return tags.map((t) => ({ id: t.id, label: t.name }));
}

export interface UiFlag {
  type: "late" | "amount_change" | "history_differs";
  text: string;
  entityId: string;
  entityName: string;
}

export interface UiDetection {
  /** Outflow suggestions, strongest first. */
  suggestions: UiSuggestion[];
  /** Regular deposits (review list only; never on the calendar, no buttons). */
  deposits: UiSuggestion[];
  dismissed: UiSuggestion[];
  flags: UiFlag[];
  lateCount: number;
  suppressedCount: number;
}

function confidenceLabel(s: Series): string {
  if (s.confidence === "high") return "Strong pattern";
  if (s.confidence === "medium") return "Likely";
  return `Weak pattern, ${s.occurrences} times`;
}

/**
 * "Next expected around Oct 14", or - when that date has already passed and the existing late rule has not flagged
 * the series - the observational "Expected around Oct 6, not posted yet". Once the late rule flags it, the Heads up
 * line carries the message and this label stays as it was.
 */
function nextLabelFor(s: Series, todayIso: string | undefined, flaggedLate: boolean): string {
  const iso = s.nextExpected.toISOString().slice(0, 10);
  if (todayIso && iso < todayIso && !flaggedLate) return `Expected around ${formatShort(iso)}, not posted yet`;
  return `Next expected around ${formatShort(iso)}`;
}

function suggestionToUi(
  s: Series,
  entityNameById: Record<string, string>,
  todayIso?: string,
  lateKeys: Set<string> = new Set()
): UiSuggestion {
  let summary = `${approx(s.typicalAmount.toFixed(2))} ${CADENCE_WORD[s.cadence]}`;
  if (s.amountMode === "varies") {
    summary += `, amount varies (${approx(s.minAmount.toFixed(2))} to ${approx(s.maxAmount.toFixed(2))})`;
  }
  if (s.cadence !== "weekly" && s.cadence !== "biweekly") summary += `, ${s.dayRule}`;
  const why = s.why.join(", ");
  const dated = s.confidence !== "low" && s.cadence !== "annual";
  return {
    key: s.key,
    entityId: s.entityId,
    entityName: entityNameById[s.entityId] ?? "Unknown entity",
    payee: s.payee,
    kind: s.kind,
    cadence: s.cadence,
    summary,
    confidence: s.confidence,
    confidenceLabel: confidenceLabel(s),
    why: `${why}.`,
    nextLabel: dated ? nextLabelFor(s, todayIso, lateKeys.has(s.key)) : null,
    canAdd: s.kind === "outflow",
    suggestedTagId: suggestedTagId(s),
    amountCents: s.typicalAmount.times(100).toDecimalPlaces(0).toNumber(),
    recurringFrequency: s.cadence === "annual" ? "annually" : s.cadence,
  };
}

/**
 * Plain strings only: no Decimal / Date reaches a component. `todayIso` (the ledger's first day, YYYY-MM-DD) lets a
 * date that has passed read "Expected around ..., not posted yet"; without it every date reads "Next expected".
 */
export function toUiDetection(bundle: DetectionBundle, entityNameById: Record<string, string>, todayIso?: string): UiDetection {
  const lateKeys = new Set<string>();
  for (const f of bundle.flags) if (f.type === "late" && f.seriesKey) lateKeys.add(f.seriesKey);
  const flags: UiFlag[] = bundle.flags.map((f) => ({
    type: f.type,
    text: f.text,
    entityId: f.entityId,
    entityName: entityNameById[f.entityId] ?? "Unknown entity",
  }));
  const all = bundle.suggestions.map((s) => suggestionToUi(s, entityNameById, todayIso, lateKeys));
  return {
    suggestions: all.filter((s) => s.kind === "outflow"),
    // A weak deposit pattern is not worth the owner's attention.
    deposits: all.filter((s) => s.kind === "inflow" && s.confidence !== "low"),
    dismissed: bundle.dismissed.map((s) => suggestionToUi(s, entityNameById, todayIso, lateKeys)),
    flags,
    lateCount: flags.filter((f) => f.type === "late").length,
    suppressedCount: bundle.suppressedCount,
  };
}

// ── Grouping / truncation ────────────────────────────────────────────────────

export interface DateGroup {
  dateIso: string;
  label: string;
  items: UiItem[];
}

/** Groups already-sorted dated items by calendar date. */
export function groupByDate(items: UiItem[]): DateGroup[] {
  const groups: DateGroup[] = [];
  for (const item of items) {
    if (!item.dateIso) continue;
    const last = groups[groups.length - 1];
    if (last && last.dateIso === item.dateIso) last.items.push(item);
    else groups.push({ dateIso: item.dateIso, label: formatDay(item.dateIso), items: [item] });
  }
  return groups;
}

export interface WeekGroup {
  weekStartIso: string;
  label: string;
  items: UiItem[];
  /** Counted outflow / inflow of this week as 2-decimal strings (bills and cards out, paychecks in). */
  outflow: string;
  inflow: string;
  /** Items in this week whose amount is not set (listed, but in neither subtotal). */
  unknownCount: number;
}

/**
 * The week heading's subtotal text. A segment is shown only when it is above zero (a zero would read
 * as a claim), unknown-amount items are reported as "N without an amount", and a week with nothing to
 * report gets an empty string (render nothing, never "~$0.00"). `withMoney` is false in the
 * all-entities view, where no cross-entity money subtotal is ever shown.
 */
export function weekSubtotalText(week: WeekGroup, withMoney: boolean): string {
  const parts: string[] = [];
  if (withMoney) {
    if (toCents(week.outflow) > 0) parts.push(`${approx(week.outflow)} due`);
    if (toCents(week.inflow) > 0) parts.push(`${approx(week.inflow)} expected in`);
  }
  if (week.unknownCount > 0) parts.push(`${week.unknownCount} without an amount`);
  return parts.join(", ");
}

/** Groups already-sorted dated items into Monday-start weeks with counted subtotals. */
export function groupByWeek(items: UiItem[]): WeekGroup[] {
  const groups: { weekStartIso: string; items: UiItem[]; out: number; inn: number; unknown: number }[] = [];
  for (const item of items) {
    if (!item.dateIso) continue;
    const weekStartIso = mondayOf(item.dateIso);
    let g = groups[groups.length - 1];
    if (!g || g.weekStartIso !== weekStartIso) {
      g = { weekStartIso, items: [], out: 0, inn: 0, unknown: 0 };
      groups.push(g);
    }
    g.items.push(item);
    if (item.amountStatus === "unknown") g.unknown += 1;
    if (item.amountStatus === "known" && item.amount !== null) {
      const c = toCents(item.amount);
      if ((item.kind === "bill" || item.kind === "card") && c < 0) g.out += -c;
      else if (item.kind === "income" && c > 0) g.inn += c;
    }
  }
  return groups.map((g) => ({
    weekStartIso: g.weekStartIso,
    label: `Week of ${formatShort(g.weekStartIso)}`,
    items: g.items,
    outflow: fromCents(g.out),
    inflow: fromCents(g.inn),
    unknownCount: g.unknown,
  }));
}

/** First `max` rows plus how many were left out ("+N more"). */
export function truncateItems<T>(items: T[], max: number): { shown: T[]; hiddenCount: number } {
  if (items.length <= max) return { shown: items, hiddenCount: 0 };
  return { shown: items.slice(0, max), hiddenCount: items.length - max };
}

// ── Horizon / query-string helpers ───────────────────────────────────────────

export const HORIZONS = [30, 60, 90] as const;
export type Horizon = (typeof HORIZONS)[number];

/** Invalid or missing values fall back to the default (90). */
export function parseHorizon(raw: string | undefined): Horizon {
  const n = Number(raw);
  return (HORIZONS as readonly number[]).includes(n) ? (n as Horizon) : 90;
}

export function parseTransfersFlag(raw: string | undefined): boolean {
  return raw === "1";
}
