// Upcoming ledger: ONE dated, de-duplicated, entity-scoped list of every expected
// outflow / inflow in the next N days, merged from scheduled bills, budget schedules,
// recurring expenses, accrual draws, card statements, envelope transfers, paychecks,
// rental payouts, projected revenue, tax deadlines and policy expiries.
//
// PURE: no DB, no Prisma client, no clock, no "use server". Callers (lib/upcoming-ledger-build.ts)
// hand in plain rows. All date math is delegated to lib/forecast.ts's generators; this file only
// decides precedence, gating (unknown amount / unknown day are NEVER guessed) and totals.
//
// Month-length: lib/forecast.ts `allMonthDays` clamps a listed day 29-31 to the last day of a short
// month (and collapses duplicates such as [30, 31]), so month-end bills and paychecks are never skipped.

import { Decimal } from "@prisma/client/runtime/library";
import {
  generateCardStatementPayment,
  generateIncomeOccurrences,
  generateTransferOccurrences,
  type AccrualDrawLike,
} from "@/lib/forecast";
import { cycleMonthsFor, isLumpSumFrequency } from "@/lib/annual-bill";
import {
  budgetKeyOfBill,
  buildBudgetScheduleIndex,
  effectiveSchedule,
  generateBillOccurrencesBudgetDated,
  periodsBetween,
  type BudgetScheduleIndex,
} from "@/lib/bill-dates";
import { monthlyEquivalentCents } from "@/lib/recurring-expenses";
import { seriesKeyFromNotes } from "@/lib/recurring-series-marker";

// ── Public types ─────────────────────────────────────────────────────────────

export type UpcomingSource =
  | "scheduled_bill"
  | "budget_line"
  | "recurring_expense"
  | "accrual_draw"
  | "card_statement"
  | "scheduled_transfer"
  | "income_source"
  | "rental_payout"
  | "projected_revenue"
  | "tax_deadline"
  | "policy_expiry"
  | "learned_history";

/**
 * "learned" items come from lib/recurring-detect.ts (patterns found in past transactions). They are
 * placed ONLY in `UpcomingLedger.learned`, never in `items`, `undated`, `pastDue` or any total.
 */
export type ConfidenceTier = "scheduled" | "estimated" | "learned";
export type ItemKind = "bill" | "card" | "transfer" | "income" | "deadline";
export type AmountStatus = "known" | "unknown" | "not_applicable";

export interface LinkTarget {
  page: "budgets" | "forecast" | "envelope" | "accounts" | "revenue" | "tax" | "vault";
  period?: string; // "YYYY-MM" for /budgets
  anchor?: string; // e.g. "rental-bookings"
}

/** A lower-precedence record of the SAME obligation. */
export interface AlternateRecord {
  source: UpcomingSource;
  sourceId: string;
  monthlyAmount: Decimal | null; // monthly-equivalent, for comparison only
  day: number | null; // day of month if it has one
}

export type Discrepancy =
  | { kind: "monthly_amount"; otherSource: UpcomingSource; thisAmount: Decimal; otherAmount: Decimal }
  | { kind: "day"; otherSource: UpcomingSource; thisDay: number; otherDay: number };

export interface UpcomingItem {
  /** `${source}:${sourceId}:${yyyy-mm-dd | "undated"}`, unique within a result. */
  id: string;
  /** UTC midnight; null ONLY for items in `undated` (or a held-back record without a date). */
  date: Date | null;
  /** Signed, negative = outflow; null when amountStatus !== "known". */
  amount: Decimal | null;
  amountStatus: AmountStatus;
  label: string;
  source: UpcomingSource;
  kind: ItemKind;
  tier: ConfidenceTier;
  /** Plain reason shown next to "estimate" ("monthly set-aside, no due date on file"). */
  tierNote?: string;
  entityId: string;
  accountId?: string;
  sourceId: string;
  link: LinkTarget;
  alsoRecordedAs: AlternateRecord[];
  discrepancies: Discrepancy[];
  notes: string[];
  /** Set only on `UpcomingLedger.learned` items: the cadence of the learned series (one row per series in the UI). */
  learnedCadence?: LearnedCadence;
  /** Set only on a past-due card statement whose paid-statement check ran and found no payment. */
  paymentCheck?: "none_found";
  /**
   * Informational line about the DATE of a bill: it is dated by its Budget row (the money has to be in the account
   * then), the bill record says another day, and the bank may clear it a few days later. Not a discrepancy.
   */
  dateNote?: string;
}

export interface LedgerTotals {
  /** Positive magnitude, counted kinds only: bill, card. */
  outflow: Decimal;
  /** The part of outflow that came from tier "estimated". */
  outflowEstimated: Decimal;
  /** Counted kind: income. */
  inflow: Decimal;
  inflowEstimated: Decimal;
  /** Items in `items` whose amountStatus is "unknown". */
  unknownAmountCount: number;
  /** Shown separately, never in outflow. */
  transferCount: number;
  transferTotal: Decimal;
}

export interface UpcomingLedger {
  from: Date;
  to: Date; // [from, to), UTC midnight
  /** Dated, inside the window, sorted (date, kind, label, id). */
  items: UpcomingItem[];
  /** Real obligations whose day is not recorded. */
  undated: UpcomingItem[];
  /** Card statements past due within the lookback + overdue unrealized ProjectedRevenue. */
  pastDue: UpcomingItem[];
  /** Suspected untagged duplicates, NOT counted (reason in notes). */
  heldBack: UpcomingItem[];
  /**
   * Card statements on file that the paid-statement check found PAID (the item notes say when and how). Shown as a
   * muted line, never part of items / pastDue / totals. Empty unless the input carried `paid` evidence.
   */
  paidCards: UpcomingItem[];
  totals: LedgerTotals;
  totalsByEntity: Record<string, LedgerTotals>;
  /** Largest counted outflow; ties go to the earlier date. */
  biggest: UpcomingItem | null;
  /**
   * History-learned recurring bills (tier "learned", source "learned_history"), dated, inside the window.
   * NEVER part of items / totals / totalsByEntity / biggest: a guess must not double count a bill the
   * owner has under another name. Empty when the input carries no `learned` rows.
   */
  learned: UpcomingItem[];
  /** Positive magnitude of the learned outflows and how many learned items there are. Shown separately. */
  learnedTotals: { outflow: Decimal; count: number };
  /** Learned rows dropped because they looked like an obligation the ledger already keeps. */
  learnedDropped: number;
}

// ── Input row types (structural, not Prisma types) ───────────────────────────

type Num = Decimal | string | number;

export interface UpcomingBillRow {
  id: string;
  accountId: string;
  entityId: string;
  payee: string;
  amountType: string;
  expectedAmount: Num | null;
  autopayDay: number | null;
  annualBudget: Num | null;
  frequency?: string;
  payDayOfWeek?: number | null;
  biweeklyAnchorDate?: Date | string | null;
  payMonth?: number | null;
  active: boolean;
  budgetTagId: string | null;
  budgetEntityId: string | null;
  /** Draws of the linked AccrualEnvelope, if any. */
  draws?: AccrualDrawLike[];
}

export interface UpcomingBudgetRow {
  id: string;
  tagId: string;
  tagName: string;
  entityId: string;
  accountId: string;
  period: string; // YYYY-MM
  budgeted: Num | null;
  payDay: number | null;
  frequency: string;
  payDayOfWeek: number | null;
  biweeklyAnchorDate: Date | string | null;
  payMonth: number | null;
  annualAmountDue: Num | null;
}

export interface UpcomingRecurringRow {
  id: string;
  entityId: string;
  name: string;
  amountCents: number;
  frequency: string; // monthly | weekly | biweekly | quarterly | annually
  dueDay: number | null;
  nextDueDate: Date | string | null;
  tagId: string | null;
  /** Only read for the "[pattern:...]" marker a recurring expense added from a detected pattern carries. */
  notes?: string | null;
}

export interface UpcomingEnvelopeRow {
  id: string;
  name: string;
  accountId: string;
  entityId: string;
  draws: AccrualDrawLike[];
}

/** Evidence that a card's statement on file was paid (lib/card-next-statement.ts `detectStatementPaid`). */
export interface UpcomingCardPaid {
  /** Date of the payment on the card. */
  date: Date;
  amount: Decimal;
  /** Plain words: "a payment received on the card". */
  via: string;
}

export interface UpcomingCardRow {
  id: string;
  nickname: string;
  entityId: string;
  ccDueDate: Date | string;
  ccStatementBalance: Num | null;
  /**
   * Result of the paid-statement check. undefined = no check ran (the row behaves exactly as before); null = the
   * check ran and found no payment; an object = paid, with the evidence.
   */
  paid?: UpcomingCardPaid | null;
}

/** An ESTIMATED future statement payment for a card (lib/card-next-statement.ts). */
export interface UpcomingCardEstimateRow {
  cardId: string;
  entityId: string;
  nickname: string;
  /** UTC midnight. */
  dueDate: Date;
  /** Positive. */
  amount: Decimal;
  confidence: "high" | "medium" | "low";
  /** Plain, observational basis of the estimate. */
  why: string;
  kind: "cycle_to_date" | "typical_month";
}

export interface UpcomingTransferRow {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  fromEntityId: string;
  amount: Num;
  cadence: string;
  dayRules: unknown;
  purpose?: string | null;
  toNickname?: string | null;
  active: boolean;
}

export interface UpcomingIncomeRow {
  id: string;
  accountId: string;
  entityId: string;
  description: string;
  cadence: string;
  dayRules: unknown;
  /** The amount to use per paycheck: TAKE-HOME (lib/net-income.ts) when known, else gross (see amountBasis). */
  amount: Num;
  active: boolean;
  /** The stored gross amount (display only). Absent = `amount` is all that is known (older callers, tests). */
  grossAmount?: Num;
  /** How `amount` was resolved. "gross_unknown" = gross used because take-home is unknown (a flagged assumption). */
  amountBasis?: "deposits" | "paystub" | "gross_unknown";
  /** Plain-language basis, shown in the item notes ("take-home $6,064.86, from your last 6 deposits"). */
  netLabel?: string;
  /** True when the recent take-home values spread (shown as an estimate). */
  netVariable?: boolean;
}

export interface UpcomingRentalRow {
  id: string;
  entityId: string;
  payoutDate: Date | string;
  guest: string;
  grossEarnings: Num;
}

export interface UpcomingProjectedRevenueRow {
  id: string;
  entityId: string;
  accountId?: string | null;
  description: string;
  expectedDate: Date | string;
  amountCents: number;
  realizedAt?: Date | string | null;
  archivedAt?: Date | string | null;
}

export interface UpcomingTaxDeadlineRow {
  id: string;
  entityId: string;
  label: string;
  dueDate: Date | string;
  status: string;
  archivedAt?: Date | string | null;
}

export interface UpcomingPolicyRow {
  id: string;
  entityId: string;
  insurer: string;
  policyType: string;
  expiryDate: Date | string | null;
  archivedAt?: Date | string | null;
}

/** Cadences the detector can learn (mirrors lib/recurring-detect.ts; kept structural so this file never imports it). */
export type LearnedCadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";

/** A history-learned series, already expanded to the dates inside the window by the caller. */
export interface LearnedSeriesRow {
  key: string;
  entityId: string;
  accountId: string | null;
  payee: string;
  kind: "outflow" | "inflow";
  cadence: LearnedCadence;
  /** Typical (median) amount per occurrence, positive. */
  amount: Num;
  minAmount: Num;
  maxAmount: Num;
  amountMode: "fixed" | "varies";
  confidence: "low" | "medium" | "high";
  /** Plain-words facts behind the pattern. */
  why: string;
  /** Expected occurrence dates (any may fall outside the window; those are ignored). */
  dates: Date[];
}

export type ModelledCadence = LearnedCadence | "semiannual";

/** An obligation the owner has already recorded, in the shape the detector needs to suppress / compare. */
export interface ModelledRef {
  source: UpcomingSource;
  sourceId: string;
  entityId: string;
  accountId: string | null;
  label: string;
  direction: "outflow" | "inflow";
  /** `${entityId}|${tagId}` when the record is tied to a budget category. */
  tagKey: string | null;
  /** Monthly-equivalent amount, for comparison only. */
  monthly: Decimal | null;
  /** Day of month it is paid on, or null (weekly / biweekly / unset). */
  day: number | null;
  cadence: ModelledCadence | null;
  /** Amount of ONE payment when the record states it, else null. */
  expectedAmount: Decimal | null;
  /**
   * Set for a recurring expense created from a detected pattern: that pattern's series key (read from the notes
   * marker). Ties the record to ITS series however it was renamed or tagged.
   */
  seriesKey?: string | null;
  /**
   * A bill dated by its Budget row: the bill RECORD's own day when it differs from `day` (so a history match that
   * lands on either date still counts as this obligation).
   */
  altDay?: number | null;
}

export interface UpcomingLedgerInput {
  from: Date;
  days: number;
  entityId?: string | null;
  cardPastDueLookbackDays?: number;
  bills?: UpcomingBillRow[];
  budgets?: UpcomingBudgetRow[];
  recurring?: UpcomingRecurringRow[];
  orphanEnvelopes?: UpcomingEnvelopeRow[];
  cards?: UpcomingCardRow[];
  /**
   * Estimated future card statements, each counted (tier "estimated") on its due date inside the window. Optional:
   * without it the ledger is exactly as before.
   */
  cardEstimates?: UpcomingCardEstimateRow[];
  transfers?: UpcomingTransferRow[];
  incomeSources?: UpcomingIncomeRow[];
  rentalBookings?: UpcomingRentalRow[];
  projectedRevenue?: UpcomingProjectedRevenueRow[];
  taxDeadlines?: UpcomingTaxDeadlineRow[];
  policies?: UpcomingPolicyRow[];
  /** History-learned series (lib/recurring-detect.ts). Optional: without it the ledger is exactly as before. */
  learned?: LearnedSeriesRow[];
}

export const CARD_PAST_DUE_LOOKBACK_DAYS = 14;

// ── Small helpers ────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const NO_BUDGET_INDEX: BudgetScheduleIndex = new Map();

export function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function periodOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** "Oct 4": a calendar date stored as UTC midnight, formatted in UTC (never shifted a day by New York time). */
function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function toDate(v: Date | string): Date | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dec(v: Num | null | undefined): Decimal | null {
  if (v === null || v === undefined) return null;
  const d = new Decimal(String(v));
  return d.isNaN() ? null : d;
}

/** A usable amount: present and greater than zero; otherwise null (= unknown). */
function positive(v: Num | null | undefined): Decimal | null {
  const d = dec(v);
  return d && d.gt(ZERO) ? d : null;
}

function cents(d: Decimal): Decimal {
  return d.toDecimalPlaces(2);
}

/**
 * The America/New_York calendar date of `now`, as a UTC-midnight Date (so a 9 pm ET bill still
 * shows as "today"). The only clock-adjacent helper here; it takes `now` as an argument.
 */
export function todayForNewYork(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

// Words that carry no identity ("insurance", "financial", ...). Shared stop words must never make
// two different bills look like the same one (Toyota Financial vs Lexus Financial).
const STOP_WORDS = new Set([
  "insurance",
  "payment",
  "financial",
  "loan",
  "auto",
  "home",
  "bill",
  "service",
  "services",
  "company",
  "monthly",
  "annual",
  "utilities",
  "the",
  "and",
  "for",
]);

/** Distinct identifying words of a name: lower-case, punctuation stripped, length >= 4, no stop words, no pure numbers. */
export function nameWords(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

const TRAILING_QUALIFIER_RE = /\s*\(([^()]{1,60})\)\s*$/;

function normalizeQualifier(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The trailing "(...)" of a record name, normalized ("Maintenance Fee (Credit Cards)" -> "credit cards"), or null.
 * It tells two same-named records apart ("... (Arbor Retreat)", or the account nickname the recurring-pattern
 * review adds when one payee charges on two accounts).
 */
export function trailingQualifier(label: string): string | null {
  const m = TRAILING_QUALIFIER_RE.exec(label);
  if (!m) return null;
  const q = normalizeQualifier(m[1] as string);
  return q === "" ? null : q;
}

/** The name without its trailing "(...)". */
export function stripTrailingQualifier(label: string): string {
  return label.replace(TRAILING_QUALIFIER_RE, "");
}

/** Two names that both end in a "(...)" and the two differ are different obligations ("Fee (A)" vs "Fee (B)"). */
export function qualifiersDiffer(a: string, b: string): boolean {
  const qa = trailingQualifier(a);
  const qb = trailingQualifier(b);
  return qa !== null && qb !== null && qa !== qb;
}

// ── Schedule shapes: one place that decides "can this be dated?" and "is the amount known?" ──

/** Input accepted by generateBillOccurrences. */
interface BillPayload {
  id: string;
  accountId: string;
  payee: string;
  amountType: string;
  expectedAmount: Num | null;
  autopayDay: number | null;
  annualBudget: Num | null;
  frequency: string;
  payDayOfWeek: number | null;
  biweeklyAnchorDate: Date | string | null;
  payMonth: number | null;
}

interface Shape {
  payloads: BillPayload[];
  draws: AccrualDrawLike[];
  accrued: boolean;
  /** True when the generator would need a number we do not have: use a placeholder for dates only. */
  unknownAmount: boolean;
  /** Non-null: the schedule is incomplete, so no date can be derived (never guessed). */
  undatedReason: string | null;
  /** Amount shown for an undated item, and what that figure is. */
  undatedAmount: Decimal | null;
  undatedAmountMeans: "monthly" | "payment";
  tier: ConfidenceTier;
  tierNote?: string;
}

function tierForBill(amountType: string, hasDraws: boolean): { tier: ConfidenceTier; tierNote?: string } {
  if (amountType === "accrued") {
    return hasDraws
      ? { tier: "estimated", tierNote: "estimated draw date and amount" }
      : { tier: "estimated", tierNote: "monthly set-aside, no due date on file" };
  }
  if (amountType === "fluctuating") return { tier: "estimated", tierNote: "amount varies from month to month" };
  return { tier: "scheduled" };
}

function billShape(payload: BillPayload, draws: AccrualDrawLike[]): Shape {
  const frequency = payload.frequency || "monthly";
  const accrued = payload.amountType === "accrued";
  const lump = !accrued && isLumpSumFrequency(frequency);
  const expected = positive(payload.expectedAmount);
  const annual = positive(payload.annualBudget);
  const { tier, tierNote } = tierForBill(payload.amountType, accrued && draws.length > 0);

  let undatedReason: string | null = null;
  let unknownAmount = false;
  let undatedAmount: Decimal | null = null;
  let undatedAmountMeans: "monthly" | "payment" = "monthly";

  if (accrued && draws.length > 0) {
    // Dated by the draws themselves; a zero-amount draw is handled per draw.
  } else if (accrued) {
    if (payload.autopayDay == null) undatedReason = "day not set";
    unknownAmount = annual === null;
    undatedAmount = annual ? annual.div(12) : null;
  } else if (lump) {
    if (payload.payMonth == null || payload.autopayDay == null) undatedReason = "day not set";
    unknownAmount = annual === null;
    undatedAmount = annual;
    undatedAmountMeans = "payment";
  } else {
    if (frequency === "weekly") {
      if (payload.payDayOfWeek == null) undatedReason = "day not set";
    } else if (frequency === "biweekly") {
      if (!payload.biweeklyAnchorDate) undatedReason = "day not set";
    } else if (payload.autopayDay == null) {
      undatedReason = "day not set";
    }
    unknownAmount = expected === null;
    undatedAmount = expected;
  }

  return {
    payloads: [{ ...payload, frequency }],
    draws,
    accrued,
    unknownAmount,
    undatedReason,
    undatedAmount,
    undatedAmountMeans,
    tier,
    tierNote,
  };
}

interface ExpandedEvent {
  date: Date;
  amount: Decimal | null; // positive magnitude, null = unknown
}

function expandShape(shape: Shape, from: Date, to: Date): ExpandedEvent[] {
  const out: ExpandedEvent[] = [];
  for (const base of shape.payloads) {
    const payload: BillPayload = { ...base };
    let draws = shape.draws;
    const unknownDrawDates = new Set<string>();

    if (shape.accrued && shape.draws.length > 0) {
      // A zero / negative draw would be silently skipped by the generator: swap in a placeholder so the
      // date survives, and flag that date's amount as unknown.
      draws = shape.draws.map((d) => {
        const amount = dec(d.estimatedAmount);
        if (amount && amount.gt(ZERO)) return d;
        const date = toDate(d.estimatedDate);
        if (date) unknownDrawDates.add(dateKey(startOfDayUTC(date)));
        return { estimatedDate: d.estimatedDate, estimatedAmount: ONE };
      });
    } else if (shape.unknownAmount) {
      // Placeholder purely to obtain the dates; the amount is reported as unknown.
      if (shape.accrued || isLumpSumFrequency(payload.frequency)) payload.annualBudget = ONE;
      else payload.expectedAmount = ONE;
    }

    // The payload already carries the schedule of its month (Budget row or bill record, see budgetDatedEvents), so no
    // Budget index is needed here: an empty index is exactly the plain generator.
    for (const ev of generateBillOccurrencesBudgetDated(payload, NO_BUDGET_INDEX, from, to, draws)) {
      const unknown = shape.unknownAmount || unknownDrawDates.has(dateKey(ev.date));
      out.push({ date: ev.date, amount: unknown ? null : cents(ev.amount.abs()) });
    }
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Monthly-equivalent of a bill-shaped record, for discrepancy / duplicate comparison only. */
function billMonthly(p: BillPayload): Decimal | null {
  const frequency = p.frequency || "monthly";
  if (p.amountType === "accrued") {
    const expected = positive(p.expectedAmount);
    if (expected) return cents(expected);
    const annual = positive(p.annualBudget);
    return annual ? cents(annual.div(12)) : null;
  }
  if (isLumpSumFrequency(frequency)) {
    const annual = positive(p.annualBudget);
    return annual ? cents(annual.div(cycleMonthsFor(frequency))) : null;
  }
  const expected = positive(p.expectedAmount);
  return expected ? cents(expected) : null;
}

/** Day of month a bill-shaped record is paid on, or null when it has none (weekly / biweekly / unset). */
function billDay(p: BillPayload): number | null {
  const frequency = p.frequency || "monthly";
  if (p.amountType !== "accrued" && (frequency === "weekly" || frequency === "biweekly")) return null;
  return p.autopayDay ?? null;
}

// ── Obligations (the things that can win or lose a de-duplication) ───────────

interface Obligation {
  source: UpcomingSource;
  sourceId: string;
  entityId: string;
  accountId: string | null;
  label: string;
  tagKey: string | null;
  shape: Shape;
  monthly: Decimal | null;
  day: number | null;
  /** Budget rows only: keep occurrences inside this YYYY-MM. */
  period?: string;
  /** Tagged winners: context for discrepancy detection. */
  budgetByPeriod?: Map<string, UpcomingBudgetRow>;
  recurringLosers?: UpcomingRecurringRow[];
  extraNotes?: string[];
  /** Bills only: the raw row, for month-by-month Budget dating. */
  bill?: UpcomingBillRow;
}

function budgetHasSchedule(b: UpcomingBudgetRow): boolean {
  return b.payDay != null || (b.frequency !== "monthly" && b.frequency !== "");
}

function budgetPayload(b: UpcomingBudgetRow): BillPayload {
  return {
    id: b.id,
    accountId: b.accountId,
    payee: b.tagName,
    amountType: "static",
    expectedAmount: b.budgeted,
    autopayDay: b.payDay,
    annualBudget: b.annualAmountDue,
    frequency: b.frequency || "monthly",
    payDayOfWeek: b.payDayOfWeek,
    biweeklyAnchorDate: b.biweeklyAnchorDate,
    payMonth: b.payMonth,
  };
}

function budgetMonthly(b: UpcomingBudgetRow): Decimal | null {
  const p = budgetPayload(b);
  return billMonthly(p);
}

function recurringMonthly(r: UpcomingRecurringRow): Decimal | null {
  if (r.amountCents <= 0) return null;
  return new Decimal(monthlyEquivalentCents(r.amountCents, r.frequency)).div(100);
}

function recurringDay(r: UpcomingRecurringRow): number | null {
  if (r.frequency === "weekly" || r.frequency === "biweekly") return null;
  if (r.frequency === "monthly") return r.dueDay ?? null;
  const next = r.nextDueDate ? toDate(r.nextDueDate) : null;
  return next ? next.getUTCDate() : null;
}

function recurringShape(r: UpcomingRecurringRow): Shape {
  const amount = r.amountCents > 0 ? new Decimal(r.amountCents).div(100) : null;
  const next = r.nextDueDate ? toDate(r.nextDueDate) : null;
  const base = {
    accountId: "",
    payee: r.name,
    amountType: "static",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
  };
  const none = { expectedAmount: null, annualBudget: null, autopayDay: null };

  let payloads: BillPayload[];
  let undatedReason: string | null = null;
  let undatedAmount: Decimal | null = amount;
  let undatedAmountMeans: "monthly" | "payment" = "payment";

  switch (r.frequency) {
    case "weekly":
    case "biweekly": {
      // Convert the per-occurrence amount to the generator's MONTHLY-total convention.
      const perYear = r.frequency === "weekly" ? 52 : 26;
      const monthly = amount ? amount.times(perYear).div(12) : null;
      payloads = [
        {
          ...base,
          ...none,
          id: r.id,
          frequency: r.frequency,
          expectedAmount: monthly,
          payDayOfWeek: next ? next.getUTCDay() : null,
          biweeklyAnchorDate: r.frequency === "biweekly" ? next : null,
        },
      ];
      if (!next) undatedReason = "day not set";
      undatedAmount = monthly;
      undatedAmountMeans = "monthly";
      break;
    }
    case "quarterly": {
      // Quarterly = two semiannual shapes three months apart (no new date math here).
      const m = next ? next.getUTCMonth() + 1 : null;
      const second = m === null ? null : ((m + 2) % 12) + 1; // m + 3, wrapped into 1..12
      const mk = (id: string, payMonth: number | null): BillPayload => ({
        ...base,
        ...none,
        id,
        frequency: "semiannual",
        annualBudget: amount,
        autopayDay: next ? next.getUTCDate() : null,
        payMonth,
      });
      payloads = [mk(r.id, m), mk(r.id, second)];
      if (!next) undatedReason = "day not set";
      break;
    }
    case "annually": {
      payloads = [
        {
          ...base,
          ...none,
          id: r.id,
          frequency: "annual",
          annualBudget: amount,
          autopayDay: next ? next.getUTCDate() : null,
          payMonth: next ? next.getUTCMonth() + 1 : null,
        },
      ];
      if (!next) undatedReason = "day not set";
      break;
    }
    default: {
      // monthly (and any unrecognised value, which the rest of the app also treats as monthly)
      payloads = [{ ...base, ...none, id: r.id, frequency: "monthly", expectedAmount: amount, autopayDay: r.dueDay }];
      if (r.dueDay == null) undatedReason = "day not set";
      undatedAmountMeans = "monthly";
    }
  }

  return {
    payloads,
    draws: [],
    accrued: false,
    unknownAmount: amount === null,
    undatedReason,
    undatedAmount,
    undatedAmountMeans,
    tier: "scheduled",
  };
}

// ── Duplicate detection helpers ──────────────────────────────────────────────

export function accountsCompatible(a: string | null, b: string | null): boolean {
  return !a || !b || a === b;
}

function sharesDistinctiveWord(a: string, b: string): boolean {
  const wa = nameWords(a);
  if (wa.length === 0) return false;
  const wb = new Set(nameWords(b));
  return wa.some((w) => wb.has(w));
}

export function amountsClose(a: Decimal, b: Decimal): boolean {
  const tol = Decimal.max(ONE, Decimal.max(a.abs(), b.abs()).times("0.05"));
  return a.minus(b).abs().lte(tol);
}

type ObligationIdentity = Pick<Obligation, "entityId" | "accountId" | "label" | "monthly" | "day">;

function likelySameObligation(a: ObligationIdentity, b: ObligationIdentity): boolean {
  if (a.entityId !== b.entityId) return false;
  if (!accountsCompatible(a.accountId, b.accountId)) return false;
  // "Maintenance Fee (Credit Cards)" and "Maintenance Fee (Slush Funds)" are two obligations, not one.
  if (qualifiersDiffer(a.label, b.label)) return false;
  if (sharesDistinctiveWord(a.label, b.label)) return true;
  if (a.monthly && b.monthly && a.day != null && a.day === b.day && amountsClose(a.monthly, b.monthly)) return true;
  return false;
}

// ── Builder ──────────────────────────────────────────────────────────────────

const KIND_ORDER: Record<ItemKind, number> = { bill: 0, card: 1, income: 2, deadline: 3, transfer: 4 };

function compareItems(a: UpcomingItem, b: UpcomingItem): number {
  const ta = a.date ? a.date.getTime() : Number.MAX_SAFE_INTEGER;
  const tb = b.date ? b.date.getTime() : Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function emptyTotals(): LedgerTotals {
  return {
    outflow: new Decimal(0),
    outflowEstimated: new Decimal(0),
    inflow: new Decimal(0),
    inflowEstimated: new Decimal(0),
    unknownAmountCount: 0,
    transferCount: 0,
    transferTotal: new Decimal(0),
  };
}

function addToTotals(t: LedgerTotals, item: UpcomingItem): void {
  if (item.amountStatus === "unknown") t.unknownAmountCount += 1;
  if (item.kind === "transfer") {
    t.transferCount += 1;
    if (item.amount) t.transferTotal = t.transferTotal.plus(item.amount.abs());
    return;
  }
  if (item.amountStatus !== "known" || !item.amount) return;
  const magnitude = item.amount.abs();
  if (item.kind === "bill" || item.kind === "card") {
    t.outflow = t.outflow.plus(magnitude);
    if (item.tier === "estimated") t.outflowEstimated = t.outflowEstimated.plus(magnitude);
  } else if (item.kind === "income") {
    t.inflow = t.inflow.plus(magnitude);
    if (item.tier === "estimated") t.inflowEstimated = t.inflowEstimated.plus(magnitude);
  }
}

function sumTotals(list: LedgerTotals[]): LedgerTotals {
  const t = emptyTotals();
  for (const x of list) {
    t.outflow = t.outflow.plus(x.outflow);
    t.outflowEstimated = t.outflowEstimated.plus(x.outflowEstimated);
    t.inflow = t.inflow.plus(x.inflow);
    t.inflowEstimated = t.inflowEstimated.plus(x.inflowEstimated);
    t.unknownAmountCount += x.unknownAmountCount;
    t.transferCount += x.transferCount;
    t.transferTotal = t.transferTotal.plus(x.transferTotal);
  }
  return t;
}

function uniquifyIds(items: UpcomingItem[]): void {
  const seen = new Map<string, number>();
  for (const item of items) {
    const n = (seen.get(item.id) ?? 0) + 1;
    seen.set(item.id, n);
    if (n > 1) item.id = `${item.id}#${n}`;
  }
}

export function buildUpcomingLedger(input: UpcomingLedgerInput): UpcomingLedger {
  const from = startOfDayUTC(input.from);
  const to = new Date(from.getTime() + input.days * DAY_MS);
  const lookbackDays = input.cardPastDueLookbackDays ?? CARD_PAST_DUE_LOOKBACK_DAYS;
  const lookbackStart = new Date(from.getTime() - lookbackDays * DAY_MS);
  const scope = input.entityId ?? null;
  const inScope = (entityId: string) => scope === null || entityId === scope;
  const fromPeriod = periodOf(from);

  const items: UpcomingItem[] = [];
  const undated: UpcomingItem[] = [];
  const pastDue: UpcomingItem[] = [];
  const heldBack: UpcomingItem[] = [];
  const paidCards: UpcomingItem[] = [];

  const inWindow = (d: Date) => d.getTime() >= from.getTime() && d.getTime() < to.getTime();

  function baseItem(
    o: Pick<Obligation, "source" | "sourceId" | "entityId" | "accountId" | "label">,
    init: {
      date: Date | null;
      amount: Decimal | null; // signed
      amountStatus: AmountStatus;
      kind: ItemKind;
      tier: ConfidenceTier;
      tierNote?: string;
      link: LinkTarget;
      notes?: string[];
    }
  ): UpcomingItem {
    return {
      id: `${o.source}:${o.sourceId}:${init.date ? dateKey(init.date) : "undated"}`,
      date: init.date,
      amount: init.amount,
      amountStatus: init.amountStatus,
      label: o.label,
      source: o.source,
      kind: init.kind,
      tier: init.tier,
      ...(init.tierNote ? { tierNote: init.tierNote } : {}),
      entityId: o.entityId,
      ...(o.accountId ? { accountId: o.accountId } : {}),
      sourceId: o.sourceId,
      link: init.link,
      alsoRecordedAs: [],
      discrepancies: [],
      notes: init.notes ? [...init.notes] : [],
    };
  }

  // ── 1. Bill-like obligations: bills, budget schedules, recurring expenses ──

  const activeBills = (input.bills ?? []).filter((b) => b.active && inScope(b.entityId));
  const budgets = (input.budgets ?? []).filter((b) => inScope(b.entityId));
  const recurring = (input.recurring ?? []).filter((r) => inScope(r.entityId));

  // Each month of a Budget-linked bill is dated by THAT month's Budget row when it carries a usable schedule
  // (lib/bill-dates.ts): the money has to be in the account on the Budget date. Amounts stay the bill's.
  const scheduleIndex = buildBudgetScheduleIndex(budgets);

  const billPayload = (b: UpcomingBillRow): BillPayload => ({
    id: b.id,
    accountId: b.accountId,
    payee: b.payee,
    amountType: b.amountType,
    expectedAmount: b.expectedAmount,
    autopayDay: b.autopayDay,
    annualBudget: b.annualBudget,
    frequency: b.frequency ?? "monthly",
    payDayOfWeek: b.payDayOfWeek ?? null,
    biweeklyAnchorDate: b.biweeklyAnchorDate ?? null,
    payMonth: b.payMonth ?? null,
  });

  /** The bill's payload for one period: the Budget row's schedule fields when usable, else the bill's own. */
  function billPayloadFor(b: UpcomingBillRow, period: string): BillPayload {
    const base = billPayload(b);
    const eff = effectiveSchedule(b, scheduleIndex, period);
    if (eff.basis !== "budget") return base;
    return {
      ...base,
      frequency: eff.fields.frequency,
      autopayDay: eff.fields.autopayDay,
      payDayOfWeek: eff.fields.payDayOfWeek,
      biweeklyAnchorDate: eff.fields.biweeklyAnchorDate,
      payMonth: eff.fields.payMonth,
    };
  }

  function billObligation(b: UpcomingBillRow, tagKey: string | null): Obligation {
    const payload = billPayload(b);
    const draws = b.draws ?? [];
    return {
      bill: b,
      source: "scheduled_bill",
      sourceId: b.id,
      entityId: b.entityId,
      accountId: b.accountId,
      label: b.payee,
      tagKey,
      shape: billShape(payload, draws),
      monthly: billMonthly(payload),
      // The CURRENT period's effective day (the Budget's when it has a usable one): used for duplicate matching.
      day: billDay(billPayloadFor(b, fromPeriod)),
    };
  }

  function budgetObligation(b: UpcomingBudgetRow): Obligation {
    const payload = budgetPayload(b);
    return {
      source: "budget_line",
      sourceId: b.id,
      entityId: b.entityId,
      accountId: b.accountId,
      label: b.tagName,
      tagKey: `${b.entityId}|${b.tagId}`,
      shape: billShape(payload, []),
      monthly: budgetMonthly(b),
      day: billDay(payload),
      period: b.period,
    };
  }

  function recurringObligation(r: UpcomingRecurringRow, tagKey: string | null): Obligation {
    const extraNotes: string[] = [];
    const next = r.nextDueDate ? toDate(r.nextDueDate) : null;
    if (next && startOfDayUTC(next).getTime() < from.getTime()) {
      extraNotes.push("Next due date on file is in the past");
    }
    return {
      source: "recurring_expense",
      sourceId: r.id,
      entityId: r.entityId,
      accountId: null,
      label: r.name,
      tagKey,
      shape: recurringShape(r),
      monthly: recurringMonthly(r),
      day: recurringDay(r),
      extraNotes,
    };
  }

  // Stage A: same budget category (entity + tag). Rank: bill > budget schedule > recurring expense.
  const billByKey = new Map<string, UpcomingBillRow>();
  const untaggedBills: UpcomingBillRow[] = [];
  for (const b of activeBills) {
    if (b.budgetTagId) billByKey.set(`${b.budgetEntityId ?? b.entityId}|${b.budgetTagId}`, b);
    else untaggedBills.push(b);
  }

  const budgetsByKey = new Map<string, Map<string, UpcomingBudgetRow>>();
  for (const b of budgets) {
    const key = `${b.entityId}|${b.tagId}`;
    const byPeriod = budgetsByKey.get(key) ?? new Map<string, UpcomingBudgetRow>();
    byPeriod.set(b.period, b);
    budgetsByKey.set(key, byPeriod);
  }

  const recurringByKey = new Map<string, UpcomingRecurringRow[]>();
  const untaggedRecurring: UpcomingRecurringRow[] = [];
  for (const r of recurring) {
    if (r.tagId) {
      const key = `${r.entityId}|${r.tagId}`;
      recurringByKey.set(key, [...(recurringByKey.get(key) ?? []), r]);
    } else {
      untaggedRecurring.push(r);
    }
  }

  const keys = new Set<string>(billByKey.keys());
  for (const [key, byPeriod] of budgetsByKey) {
    if ([...byPeriod.values()].some(budgetHasSchedule)) keys.add(key);
  }
  for (const key of recurringByKey.keys()) keys.add(key);

  const kept: Obligation[] = [];

  for (const key of [...keys].sort()) {
    const bill = billByKey.get(key);
    const byPeriod = budgetsByKey.get(key);
    const schedRows = byPeriod ? [...byPeriod.values()].filter(budgetHasSchedule).sort((a, b) => (a.period < b.period ? -1 : 1)) : [];
    const recs = recurringByKey.get(key) ?? [];

    if (bill) {
      const o = billObligation(bill, key);
      o.budgetByPeriod = byPeriod;
      o.recurringLosers = recs;
      kept.push(o);
    } else if (schedRows.length > 0) {
      for (const row of schedRows) {
        const o = budgetObligation(row);
        o.budgetByPeriod = byPeriod;
        o.recurringLosers = recs;
        kept.push(o);
      }
    } else {
      for (const r of recs) kept.push(recurringObligation(r, key));
    }
  }

  // Stage C: untagged records have no key to match on. Compare to already-kept obligations of the
  // SAME entity; a likely duplicate is held back (still visible, never counted).
  // Two untagged records of the SAME kind (bill vs bill, recurring vs recurring) are distinct rows
  // the owner entered separately, so they are never merged with each other (names like
  // "... (Arbor Retreat)" would otherwise collide).
  const heldBackObligations: { o: Obligation; winner: Obligation }[] = [];
  const untaggedKept: Obligation[] = [];

  const taggedKept = [...kept];
  function consider(o: Obligation): void {
    const hit =
      taggedKept.find((k) => likelySameObligation(o, k)) ??
      untaggedKept.find((k) => k.source !== o.source && likelySameObligation(o, k));
    if (hit) {
      heldBackObligations.push({ o, winner: hit });
    } else {
      kept.push(o);
      untaggedKept.push(o);
    }
  }

  for (const b of untaggedBills) consider(billObligation(b, null));
  for (const r of untaggedRecurring) consider(recurringObligation(r, null));
  for (const e of input.orphanEnvelopes ?? []) {
    if (!inScope(e.entityId) || e.draws.length === 0) continue;
    const payload: BillPayload = {
      id: e.id,
      accountId: e.accountId,
      payee: e.name,
      amountType: "accrued",
      expectedAmount: null,
      autopayDay: null,
      annualBudget: null,
      frequency: "monthly",
      payDayOfWeek: null,
      biweeklyAnchorDate: null,
      payMonth: null,
    };
    consider({
      source: "accrual_draw",
      sourceId: e.id,
      entityId: e.entityId,
      accountId: e.accountId,
      label: e.name,
      tagKey: null,
      shape: billShape(payload, e.draws),
      monthly: null,
      day: null,
    });
  }

  // Item creation for an obligation -----------------------------------------------------------

  function linkFor(o: Obligation, date: Date | null): LinkTarget {
    switch (o.source) {
      case "scheduled_bill":
        return o.tagKey ? { page: "budgets", period: periodOf(date ?? from) } : { page: "forecast" };
      case "budget_line":
        return { page: "budgets", period: o.period };
      case "accrual_draw":
        return { page: "envelope" };
      default:
        return { page: "forecast" };
    }
  }

  function alt(source: UpcomingSource, sourceId: string, monthly: Decimal | null, day: number | null): AlternateRecord {
    return { source, sourceId, monthlyAmount: monthly, day };
  }

  function compare(o: Obligation, other: AlternateRecord, item: UpcomingItem, ignoreDay = false): void {
    item.alsoRecordedAs.push(other);
    if (o.monthly && other.monthlyAmount && o.monthly.minus(other.monthlyAmount).abs().gt(ONE)) {
      item.discrepancies.push({
        kind: "monthly_amount",
        otherSource: other.source,
        thisAmount: o.monthly,
        otherAmount: other.monthlyAmount,
      });
    }
    if (!ignoreDay && o.day != null && other.day != null && o.day !== other.day) {
      item.discrepancies.push({ kind: "day", otherSource: other.source, thisDay: o.day, otherDay: other.day });
    }
  }

  function decorate(o: Obligation, item: UpcomingItem): void {
    const period = periodOf(item.date ?? from);
    if (o.source === "scheduled_bill" && o.budgetByPeriod) {
      const row = o.budgetByPeriod.get(period);
      if (row) {
        // A bill and its OWN Budget row can disagree on the day: the Budget's date wins (see dateNote below), so
        // only the amount can be a discrepancy between them.
        compare(o, alt("budget_line", row.id, budgetMonthly(row), billDay(budgetPayload(row))), item, true);
        if (o.bill) {
          const eff = effectiveSchedule(o.bill, scheduleIndex, period);
          const budgetDay = billDay(budgetPayload(row));
          const recordDay = billDay(billPayload(o.bill));
          if (eff.basis === "budget" && budgetDay != null && recordDay != null && budgetDay !== recordDay) {
            item.dateNote = `Dated by the budget (day ${budgetDay}) because the money has to be in the account then. The bill record says day ${recordDay}. The bank may take a few days to clear it.`;
          }
        }
      } else if (o.budgetByPeriod.size > 0) item.notes.push(`No budget line for ${period}`);
    }
    for (const r of o.recurringLosers ?? []) {
      compare(o, alt("recurring_expense", r.id, recurringMonthly(r), recurringDay(r)), item);
    }
    for (const n of o.extraNotes ?? []) item.notes.push(n);
  }

  /**
   * A Budget-linked bill's events month by month, each month from its effective schedule. null = not applicable
   * (not a bill, no Budget rows for its category, or real accrual draw dates), so the bill's own schedule applies.
   * datedMonths = months that could be dated (a month with no usable schedule at all contributes nothing).
   */
  function budgetDatedEvents(o: Obligation): { events: ExpandedEvent[]; datedMonths: number } | null {
    const b = o.bill;
    if (!b || (o.shape.accrued && o.shape.draws.length > 0)) return null;
    const key = budgetKeyOfBill(b);
    if (!key || !scheduleIndex.has(key)) return null;
    const events: ExpandedEvent[] = [];
    let datedMonths = 0;
    for (const period of periodsBetween(from, to)) {
      const [y, m] = period.split("-").map(Number) as [number, number];
      const monthStart = new Date(Date.UTC(y, m - 1, 1));
      const nextMonth = new Date(Date.UTC(y, m, 1));
      const shape = billShape(billPayloadFor(b, period), b.draws ?? []);
      if (shape.undatedReason) continue;
      datedMonths += 1;
      events.push(...expandShape(shape, from > monthStart ? from : monthStart, to < nextMonth ? to : nextMonth));
    }
    return { events: events.sort((a, c) => a.date.getTime() - c.date.getTime()), datedMonths };
  }

  function itemsFor(o: Obligation): { dated: UpcomingItem[]; undatedItem: UpcomingItem | null } {
    const shape = o.shape;
    const monthDated = budgetDatedEvents(o);
    if (shape.undatedReason && !(monthDated && monthDated.datedMonths > 0)) {
      // Budget rows: only the row for the current month reports "day not set" (not one per period).
      if (o.period && o.period !== fromPeriod) return { dated: [], undatedItem: null };
      const amount = shape.undatedAmount ? cents(shape.undatedAmount) : null;
      const item = baseItem(o, {
        date: null,
        amount: amount ? amount.negated() : null,
        amountStatus: amount ? "known" : "unknown",
        kind: "bill",
        tier: shape.tier,
        tierNote: shape.undatedReason,
        link: linkFor(o, null),
        notes: [
          amount
            ? shape.undatedAmountMeans === "monthly"
              ? "Amount shown is the monthly figure"
              : "Amount shown is the full payment"
            : "Amount not set",
        ],
      });
      decorate(o, item);
      return { dated: [], undatedItem: item };
    }

    let events = monthDated && monthDated.datedMonths > 0 ? monthDated.events : expandShape(shape, from, to);
    if (o.period) {
      const [y, m] = o.period.split("-").map(Number) as [number, number];
      const start = Date.UTC(y, m - 1, 1);
      const end = Date.UTC(y, m, 1);
      events = events.filter((e) => e.date.getTime() >= start && e.date.getTime() < end);
    }
    const dated = events.map((e) => {
      const item = baseItem(o, {
        date: e.date,
        amount: e.amount ? e.amount.negated() : null,
        amountStatus: e.amount ? "known" : "unknown",
        kind: "bill",
        tier: shape.tier,
        tierNote: shape.tierNote,
        link: linkFor(o, e.date),
        notes: e.amount ? [] : ["Amount not set"],
      });
      decorate(o, item);
      return item;
    });
    return { dated, undatedItem: null };
  }

  for (const o of kept) {
    const { dated, undatedItem } = itemsFor(o);
    items.push(...dated);
    if (undatedItem) undated.push(undatedItem);
  }

  for (const { o, winner } of heldBackObligations) {
    const { dated, undatedItem } = itemsFor(o);
    const rep = dated[0] ?? undatedItem;
    if (!rep) continue;
    rep.notes.push(`Possibly the same obligation as "${winner.label}", which is counted. Not counted here.`);
    heldBack.push(rep);
  }

  // ── 2. Card statements ──
  for (const c of input.cards ?? []) {
    if (!inScope(c.entityId)) continue;
    const due = toDate(c.ccDueDate);
    if (!due) continue;
    const day = startOfDayUTC(due);
    const o = {
      source: "card_statement" as const,
      sourceId: c.id,
      entityId: c.entityId,
      accountId: c.id,
      label: `${c.nickname} statement due`,
    };
    const balance = dec(c.ccStatementBalance);
    if (balance && !balance.gt(ZERO)) continue; // zero / negative balance: nothing to pay
    const unknown = balance === null;
    const inLookback = day.getTime() >= lookbackStart.getTime() && day.getTime() < from.getTime();

    // Paid-statement check ran and found evidence: a muted "paid" line, never an item, past-due row or total.
    if (c.paid && (inWindow(day) || inLookback)) {
      paidCards.push(
        baseItem(o, {
          date: day,
          amount: unknown ? null : cents((balance as Decimal).negated()),
          amountStatus: unknown ? "unknown" : "known",
          kind: "card",
          tier: "scheduled",
          link: { page: "accounts" },
          notes: [`Paid ${shortDate(c.paid.date)} (${c.paid.via}); not counted`],
        })
      );
      continue;
    }

    if (inWindow(day)) {
      const events = generateCardStatementPayment(
        {
          id: c.id,
          nickname: c.nickname,
          fundingAccountId: c.id,
          ccDueDate: c.ccDueDate,
          ccStatementBalance: unknown ? ONE : (balance as Decimal),
        },
        from,
        to
      );
      for (const ev of events) {
        items.push(
          baseItem(o, {
            date: ev.date,
            amount: unknown ? null : cents(ev.amount),
            amountStatus: unknown ? "unknown" : "known",
            kind: "card",
            tier: "scheduled",
            link: { page: "accounts" },
            notes: unknown ? ["Amount not set"] : [],
          })
        );
      }
    } else if (inLookback) {
      // c.paid === null: the check ran and found no payment, so say that instead of "may already be paid".
      const checked = c.paid === null;
      const item = baseItem(o, {
        date: day,
        amount: unknown ? null : cents((balance as Decimal).negated()),
        amountStatus: unknown ? "unknown" : "known",
        kind: "card",
        tier: "scheduled",
        link: { page: "accounts" },
        notes: [
          checked
            ? "Past its due date; no payment was found in your synced transactions yet (a sync may be behind)"
            : "Past its due date; it may already be paid",
        ],
      });
      if (checked) item.paymentCheck = "none_found";
      pastDue.push(item);
    }
  }

  // ── 2b. Estimated future card statements (the owner pays every card in full). Counted, tier "estimated". ──
  for (const e of input.cardEstimates ?? []) {
    if (!inScope(e.entityId)) continue;
    const day = startOfDayUTC(e.dueDate);
    if (!inWindow(day)) continue;
    const amount = positive(e.amount);
    if (!amount) continue;
    items.push(
      baseItem(
        {
          source: "card_statement",
          sourceId: `${e.cardId}:est:${periodOf(day)}`,
          entityId: e.entityId,
          accountId: e.cardId,
          label: `${e.nickname} statement due`,
        },
        {
          date: day,
          amount: cents(amount).negated(),
          amountStatus: "known",
          kind: "card",
          tier: "estimated",
          tierNote: e.why,
          link: { page: "accounts" },
          notes: ["Estimate: the statement has not been issued yet"],
        }
      )
    );
  }

  // ── 3. Outgoing envelope transfers (counted separately, never in outflow) ──
  for (const t of input.transfers ?? []) {
    if (!t.active || !inScope(t.fromEntityId)) continue;
    const rules = t.dayRules && typeof t.dayRules === "object" ? t.dayRules : {};
    const label = t.purpose ?? (t.toNickname ? `Transfer to ${t.toNickname}` : "Envelope transfer");
    // A zero / negative / missing amount is "amount not set", never a known $0.00: a placeholder is
    // used only to obtain the dates (same trick as bills), and the item carries no amount.
    const amount = positive(t.amount);
    const events = generateTransferOccurrences(
      { id: t.id, fromAccountId: t.fromAccountId, toAccountId: t.toAccountId, amount: amount ?? ONE, cadence: t.cadence, dayRules: rules, purpose: label, active: t.active },
      from,
      to
    ).filter((e) => e.type === "transfer_out");
    for (const ev of events) {
      items.push(
        baseItem(
          { source: "scheduled_transfer", sourceId: t.id, entityId: t.fromEntityId, accountId: t.fromAccountId, label },
          {
            date: ev.date,
            amount: amount ? cents(ev.amount) : null,
            amountStatus: amount ? "known" : "unknown",
            kind: "transfer",
            tier: "scheduled",
            link: { page: "envelope" },
            notes: amount ? [] : ["Amount not set"],
          }
        )
      );
    }
  }

  // ── 4. Paychecks ──
  for (const s of input.incomeSources ?? []) {
    if (!s.active || !inScope(s.entityId)) continue;
    const rules = s.dayRules && typeof s.dayRules === "object" ? s.dayRules : {};
    // Zero / negative / missing amount: dated but "amount not set" (placeholder only for the dates).
    const amount = positive(s.amount);
    // s.amount is TAKE-HOME when known (lib/net-income.ts). Variable take-home, or gross used because take-home is
    // unknown, is an ESTIMATE with the basis stated; an exact take-home stays "scheduled".
    const grossUnknown = s.amountBasis === "gross_unknown";
    const payTier: ConfidenceTier = grossUnknown || s.netVariable ? "estimated" : "scheduled";
    const payTierNote = grossUnknown
      ? "gross amount used, take-home unknown"
      : s.netVariable
        ? "take-home varies from paycheck to paycheck"
        : undefined;
    const payNotes = amount ? (s.netLabel ? [s.netLabel] : []) : ["Amount not set"];
    const events = generateIncomeOccurrences(
      { id: s.id, accountId: s.accountId, description: s.description, cadence: s.cadence, dayRules: rules, amount: amount ?? ONE, active: s.active },
      from,
      to
    );
    for (const ev of events) {
      items.push(
        baseItem(
          { source: "income_source", sourceId: s.id, entityId: s.entityId, accountId: s.accountId, label: s.description },
          {
            date: ev.date,
            amount: amount ? cents(ev.amount) : null,
            amountStatus: amount ? "known" : "unknown",
            kind: "income",
            tier: payTier,
            ...(payTierNote ? { tierNote: payTierNote } : {}),
            link: { page: "forecast" },
            notes: payNotes,
          }
        )
      );
    }
  }

  // ── 5. Rental payouts (gross: Airbnb host fees are not modelled, same as lib/business-forecast.ts) ──
  for (const r of input.rentalBookings ?? []) {
    if (!inScope(r.entityId)) continue;
    const payout = toDate(r.payoutDate);
    // Zero / negative / missing gross: the payout date is real, the amount is "not set" (never $0.00).
    const gross = positive(r.grossEarnings);
    if (!payout) continue;
    const day = startOfDayUTC(payout);
    if (!inWindow(day)) continue;
    items.push(
      baseItem(
        { source: "rental_payout", sourceId: r.id, entityId: r.entityId, accountId: null, label: `Airbnb payout (gross): ${r.guest}` },
        {
          date: day,
          amount: gross ? cents(gross) : null,
          amountStatus: gross ? "known" : "unknown",
          kind: "income",
          tier: "scheduled",
          link: { page: "forecast", anchor: "rental-bookings" },
          notes: gross ? [] : ["Amount not set"],
        }
      )
    );
  }

  // ── 6. Projected revenue (unrealized, unarchived) ──
  for (const p of input.projectedRevenue ?? []) {
    if (!inScope(p.entityId) || p.realizedAt || p.archivedAt) continue;
    const expected = toDate(p.expectedDate);
    if (!expected) continue;
    const day = startOfDayUTC(expected);
    const o = {
      source: "projected_revenue" as const,
      sourceId: p.id,
      entityId: p.entityId,
      accountId: p.accountId ?? null,
      label: p.description,
    };
    // Zero / negative / missing amount: dated but "amount not set" (never a known $0.00).
    const projected = positive(
      p.amountCents === null || p.amountCents === undefined ? null : new Decimal(p.amountCents).div(100)
    );
    const amount = projected ? cents(projected) : null;
    const amountStatus: AmountStatus = amount ? "known" : "unknown";
    const unsetNote = amount ? [] : ["Amount not set"];
    if (inWindow(day)) {
      items.push(
        baseItem(o, {
          date: day,
          amount,
          amountStatus,
          kind: "income",
          tier: "estimated",
          tierNote: "expected revenue, not yet received",
          link: { page: "revenue" },
          notes: unsetNote,
        })
      );
    } else if (day.getTime() < from.getTime()) {
      pastDue.push(
        baseItem(o, {
          date: day,
          amount,
          amountStatus,
          kind: "income",
          tier: "estimated",
          tierNote: "expected revenue, not yet received",
          link: { page: "revenue" },
          notes: [...unsetNote, "Expected date has passed and it is not marked received"],
        })
      );
    }
  }

  // ── 7. Tax deadlines (a past-dated row is ignored, never shown as overdue: statuses can be stale) ──
  for (const t of input.taxDeadlines ?? []) {
    if (!inScope(t.entityId) || t.status !== "upcoming" || t.archivedAt) continue;
    const due = toDate(t.dueDate);
    if (!due) continue;
    const day = startOfDayUTC(due);
    if (!inWindow(day)) continue;
    items.push(
      baseItem(
        { source: "tax_deadline", sourceId: t.id, entityId: t.entityId, accountId: null, label: t.label },
        {
          date: day,
          amount: null,
          amountStatus: "not_applicable",
          kind: "deadline",
          tier: "scheduled",
          link: { page: "tax" },
        }
      )
    );
  }

  // ── 8. Policy expiry (monthlyPremiumCents is deliberately NOT used as an outflow source) ──
  for (const p of input.policies ?? []) {
    if (!inScope(p.entityId) || p.archivedAt || !p.expiryDate) continue;
    const expiry = toDate(p.expiryDate);
    if (!expiry) continue;
    const day = startOfDayUTC(expiry);
    if (!inWindow(day)) continue;
    items.push(
      baseItem(
        { source: "policy_expiry", sourceId: p.id, entityId: p.entityId, accountId: null, label: `${p.insurer} ${p.policyType} policy expires` },
        {
          date: day,
          amount: null,
          amountStatus: "not_applicable",
          kind: "deadline",
          tier: "scheduled",
          link: { page: "vault" },
        }
      )
    );
  }

  // ── 9. Learned (history-detected) series. Shown OUTSIDE every total: a guessed series could double count a
  // bill the owner has under another name. Only high / medium outflow series that have a date inside the window
  // are placed; low confidence and annual series are review-list suggestions only and never get a date. Each
  // row is re-checked against the obligations this ledger keeps (belt and braces on top of the detector's own
  // suppression) and dropped when it looks like one of them. ──
  const learned: UpcomingItem[] = [];
  let learnedDropped = 0;
  for (const row of input.learned ?? []) {
    if (row.kind !== "outflow" || row.cadence === "annual" || row.confidence === "low") continue;
    if (!inScope(row.entityId)) continue;
    const typical = positive(row.amount);
    if (!typical) continue;
    const dates = row.dates.map(startOfDayUTC).filter(inWindow);
    if (dates.length === 0) continue;
    const perMonth =
      row.cadence === "weekly" ? typical.times(52).div(12) : row.cadence === "biweekly" ? typical.times(26).div(12) : row.cadence === "quarterly" ? typical.div(3) : typical;
    const identity: ObligationIdentity = {
      entityId: row.entityId,
      accountId: row.accountId,
      label: row.payee,
      monthly: cents(perMonth),
      day: row.cadence === "weekly" || row.cadence === "biweekly" ? null : (dates[0] as Date).getUTCDate(),
    };
    if (kept.some((k) => likelySameObligation(identity, k))) {
      learnedDropped += 1;
      continue;
    }
    const lo = positive(row.minAmount);
    const hi = positive(row.maxAmount);
    const notes = ["Looks recurring from your history, not in your budget"];
    if (row.amountMode === "varies" && lo && hi) notes.push(`Amount varies, about $${cents(lo).toFixed(2)} to $${cents(hi).toFixed(2)}`);
    for (const date of dates) {
      const item = baseItem(
        { source: "learned_history", sourceId: row.key, entityId: row.entityId, accountId: row.accountId, label: row.payee },
        {
          date,
          amount: cents(typical).negated(),
          amountStatus: "known",
          kind: "bill",
          tier: "learned",
          tierNote: row.why,
          link: { page: "forecast", anchor: "looks-recurring" },
          notes,
        }
      );
      item.learnedCadence = row.cadence;
      learned.push(item);
    }
  }

  // ── Finish: ids, order, totals ──
  items.sort(compareItems);
  undated.sort(compareItems);
  pastDue.sort(compareItems);
  heldBack.sort(compareItems);
  paidCards.sort(compareItems);
  learned.sort(compareItems);
  uniquifyIds(items);
  uniquifyIds(undated);
  uniquifyIds(pastDue);
  uniquifyIds(heldBack);
  uniquifyIds(paidCards);
  uniquifyIds(learned);

  const totalsByEntity: Record<string, LedgerTotals> = {};
  for (const item of [...items, ...undated]) {
    if (!totalsByEntity[item.entityId]) totalsByEntity[item.entityId] = emptyTotals();
  }
  for (const item of items) addToTotals(totalsByEntity[item.entityId] as LedgerTotals, item);
  const totals = sumTotals(Object.values(totalsByEntity));

  let biggest: UpcomingItem | null = null;
  for (const item of items) {
    if ((item.kind !== "bill" && item.kind !== "card") || item.amountStatus !== "known" || !item.amount) continue;
    if (!biggest || !biggest.amount || item.amount.abs().gt(biggest.amount.abs())) biggest = item;
  }

  let learnedOutflow = new Decimal(0);
  for (const item of learned) if (item.amount) learnedOutflow = learnedOutflow.plus(item.amount.abs());

  return {
    from,
    to,
    items,
    undated,
    pastDue,
    heldBack,
    paidCards,
    totals,
    totalsByEntity,
    biggest,
    learned,
    learnedTotals: { outflow: learnedOutflow, count: learned.length },
    learnedDropped,
  };
}

// ── Modelled references (for lib/recurring-detect.ts) ─────────────────────────

function refCadence(frequency: string | null | undefined): ModelledCadence {
  switch (frequency) {
    case "weekly":
    case "biweekly":
    case "quarterly":
    case "semiannual":
      return frequency;
    case "annual":
    case "annually":
      return "annual";
    default:
      return "monthly";
  }
}

/** One payment of a weekly / biweekly schedule whose stored amount is the MONTHLY total (the generators' convention). */
function perPayment(monthly: Decimal | null, cadence: ModelledCadence | null): Decimal | null {
  if (!monthly) return null;
  if (cadence === "weekly") return cents(monthly.times(12).div(52));
  if (cadence === "biweekly") return cents(monthly.times(12).div(26));
  return monthly;
}

/**
 * The obligations the owner has already recorded, in the shape the recurring-pattern detector needs. Applies
 * the SAME filters as buildUpcomingLedger (active bills, Budget rows that carry a schedule, recurring expenses,
 * accrual envelopes with draws, active paychecks; entity scope) and the same Stage A rule: one record per budget
 * category (bill beats budget schedule beats recurring expense). Pure: no clock, no DB.
 */
export function collectModelledRefs(input: UpcomingLedgerInput): ModelledRef[] {
  const scope = input.entityId ?? null;
  const inScope = (entityId: string) => scope === null || entityId === scope;
  const refs: ModelledRef[] = [];
  const taggedSeen = new Set<string>();
  const refIndex = buildBudgetScheduleIndex((input.budgets ?? []).filter((b) => inScope(b.entityId)));
  const refPeriod = periodOf(startOfDayUTC(input.from));

  for (const b of input.bills ?? []) {
    if (!b.active || !inScope(b.entityId)) continue;
    const frequency = b.frequency ?? "monthly";
    const accrued = b.amountType === "accrued";
    const payload: BillPayload = {
      id: b.id,
      accountId: b.accountId,
      payee: b.payee,
      amountType: b.amountType,
      expectedAmount: b.expectedAmount,
      autopayDay: b.autopayDay,
      annualBudget: b.annualBudget,
      frequency,
      payDayOfWeek: b.payDayOfWeek ?? null,
      biweeklyAnchorDate: b.biweeklyAnchorDate ?? null,
      payMonth: b.payMonth ?? null,
    };
    const tagKey = b.budgetTagId ? `${b.budgetEntityId ?? b.entityId}|${b.budgetTagId}` : null;
    if (tagKey) taggedSeen.add(tagKey);
    // The day this obligation is DATED on in the current period (the Budget's when usable), plus the record's own day.
    const eff = effectiveSchedule(b, refIndex, refPeriod);
    const effPayload: BillPayload =
      eff.basis === "budget"
        ? {
            ...payload,
            frequency: eff.fields.frequency,
            autopayDay: eff.fields.autopayDay,
            payDayOfWeek: eff.fields.payDayOfWeek,
            biweeklyAnchorDate: eff.fields.biweeklyAnchorDate,
            payMonth: eff.fields.payMonth,
          }
        : payload;
    const refDay = billDay(effPayload);
    const recordDay = billDay(payload);
    refs.push({
      source: "scheduled_bill",
      sourceId: b.id,
      entityId: b.entityId,
      accountId: b.accountId,
      label: b.payee,
      direction: "outflow",
      tagKey,
      monthly: billMonthly(payload),
      day: refDay,
      ...(eff.basis === "budget" && recordDay != null && recordDay !== refDay ? { altDay: recordDay } : {}),
      cadence: accrued ? null : refCadence(frequency),
      expectedAmount: accrued
        ? null
        : isLumpSumFrequency(frequency)
          ? positive(b.annualBudget)
          : perPayment(positive(b.expectedAmount), refCadence(frequency)),
    });
  }

  // Budget rows with a schedule: one ref per category (the latest loaded period), unless a bill already holds it.
  const latestByKey = new Map<string, UpcomingBudgetRow>();
  for (const b of input.budgets ?? []) {
    if (!inScope(b.entityId) || !budgetHasSchedule(b)) continue;
    const key = `${b.entityId}|${b.tagId}`;
    const prev = latestByKey.get(key);
    if (!prev || prev.period < b.period) latestByKey.set(key, b);
  }
  for (const key of [...latestByKey.keys()].sort()) {
    if (taggedSeen.has(key)) continue;
    const b = latestByKey.get(key) as UpcomingBudgetRow;
    taggedSeen.add(key);
    const frequency = b.frequency || "monthly";
    refs.push({
      source: "budget_line",
      sourceId: b.id,
      entityId: b.entityId,
      accountId: b.accountId,
      label: b.tagName,
      direction: "outflow",
      tagKey: key,
      monthly: budgetMonthly(b),
      day: billDay(budgetPayload(b)),
      cadence: refCadence(frequency),
      // A Budget amount is a MONTHLY total; weekly / biweekly schedules are divided per payment, lump sums are unknown.
      expectedAmount: isLumpSumFrequency(frequency) || frequency === "quarterly" ? null : perPayment(positive(b.budgeted), refCadence(frequency)),
    });
  }

  for (const r of input.recurring ?? []) {
    if (!inScope(r.entityId)) continue;
    const tagKey = r.tagId ? `${r.entityId}|${r.tagId}` : null;
    if (tagKey && taggedSeen.has(tagKey)) continue;
    refs.push({
      source: "recurring_expense",
      sourceId: r.id,
      entityId: r.entityId,
      accountId: null,
      label: r.name,
      direction: "outflow",
      tagKey,
      monthly: recurringMonthly(r),
      day: recurringDay(r),
      cadence: refCadence(r.frequency),
      expectedAmount: r.amountCents > 0 ? new Decimal(r.amountCents).div(100) : null,
      seriesKey: seriesKeyFromNotes(r.notes),
    });
  }

  for (const e of input.orphanEnvelopes ?? []) {
    if (!inScope(e.entityId) || e.draws.length === 0) continue;
    refs.push({
      source: "accrual_draw",
      sourceId: e.id,
      entityId: e.entityId,
      accountId: e.accountId,
      label: e.name,
      direction: "outflow",
      tagKey: null,
      monthly: null,
      day: null,
      cadence: null,
      expectedAmount: null,
    });
  }

  for (const s of input.incomeSources ?? []) {
    if (!s.active || !inScope(s.entityId)) continue;
    refs.push({
      source: "income_source",
      sourceId: s.id,
      entityId: s.entityId,
      accountId: s.accountId,
      label: s.description,
      direction: "inflow",
      tagKey: null,
      monthly: null,
      day: null,
      cadence: s.cadence === "weekly" || s.cadence === "biweekly" || s.cadence === "monthly" ? s.cadence : null,
      expectedAmount: positive(s.amount),
    });
  }

  return refs;
}
