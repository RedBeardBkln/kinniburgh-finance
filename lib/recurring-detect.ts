// Recurring-pattern detector (forecast step 2). Learns, from PAST transactions, which payees look like a
// recurring bill, then (a) suggests the ones the owner has not recorded, (b) flags an expected bill that has not
// posted, (c) flags a changed amount on a steady bill and (d) flags a recorded bill whose history disagrees with
// the record (for example a "monthly" bill that history shows weekly).
//
// PURE: no DB, no Prisma client, no clock, no "use server", no next/*. The caller (lib/recurring-detect-build.ts)
// hands in plain rows plus `today` (UTC midnight of the America/New_York date). Every date here is read with the
// getUTC* family only: stored postedAt values are UTC wall-clock calendar dates, so no local-time dependence.
//
// Wording is observational only ("looks recurring", "usually", "about $X"). Never advice, never certainty.
//
// Every threshold below is a named constant. The "live" notes cite the read-only calibration of 2026-10-08
// (.claude/pipeline/recurring-detection/01-plan.md section 3).

import { Decimal } from "@prisma/client/runtime/library";
import {
  accountsCompatible,
  amountsClose,
  nameWords,
  startOfDayUTC,
  type LearnedCadence,
  type ModelledRef,
  type UpcomingSource,
} from "@/lib/upcoming-ledger";

// ── Public types ─────────────────────────────────────────────────────────────

export type Cadence = LearnedCadence;
export type Confidence = "low" | "medium" | "high";

export interface TxRow {
  entityId: string;
  accountId: string;
  /** Account.accountType: checking | savings | credit_card | loan | mortgage | investment | insurance. */
  accountType: string;
  payee: string | null;
  /** Signed: negative = outflow. */
  amount: Decimal;
  postedAt: Date;
  tagIds: string[];
}

export interface Series {
  /** `${entityId}|${accountId}|${out|in}|${canonicalName}`: stable, carries no account number. */
  key: string;
  entityId: string;
  accountId: string;
  kind: "outflow" | "inflow";
  /** Display name (Title Case of the canonical payee). */
  payee: string;
  cadence: Cadence;
  /** Day of month (monthly / quarterly / annual); null for weekly / biweekly. */
  typicalDay: number | null;
  dayRule: string;
  /** Median amount per occurrence, positive. */
  typicalAmount: Decimal;
  minAmount: Decimal;
  maxAmount: Decimal;
  amountMode: "fixed" | "varies";
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
  nextExpected: Date;
  confidence: Confidence;
  why: string[];
  dominantTagId: string | null;
  /** Share (0..1) of the series' rows carrying `dominantTagId`. */
  tagShare: number;
  stale: boolean;
  suppressedBy: null | { kind: "tag" | "name" | "amount_day"; label: string; source: UpcomingSource };
}

export interface Flag {
  type: "late" | "amount_change" | "history_differs";
  entityId: string;
  /** Set for flags about a learned series; null for flags about a recorded item. */
  seriesKey: string | null;
  modelled: ModelledRef | null;
  /** Complete observational sentence, label included. */
  text: string;
  usualDay?: number;
  was?: Decimal;
  now?: Decimal;
}

export interface DetectResult {
  /** Active, unsuppressed series (both outflow and inflow), strongest first. */
  suggestions: Series[];
  /** Active series hidden because they look like something already recorded. */
  suppressed: Series[];
  suppressedCount: number;
  flags: Flag[];
  /** Series that passed every test but were last seen too long ago to still be running. */
  staleCount: number;
}

export interface DetectInput {
  rows: TxRow[];
  modelled: ModelledRef[];
  /** UTC midnight of the America/New_York calendar date. */
  today: Date;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const ZERO = new Decimal(0);

/** Interest pennies and a $0.95 invoice fee were the only sub-$2 "series" live. */
const MIN_ABS_AMOUNT = new Decimal(2);

/** Account types whose rows mirror other accounts (loan-side payments, escrow disbursements). Live: PennyMac loan rows. */
const EXCLUDED_ACCOUNT_TYPES = new Set(["mortgage", "loan", "investment", "insurance"]);
/** Inflows count only on these; a card's "payment received" is the mirror of a transfer. */
const DEPOSIT_ACCOUNT_TYPES = new Set(["checking", "savings"]);

/**
 * Unpaired transfer-looking rows are common on Primary Checking ("online xfer transfer to ...", betterment, atm fees).
 * Issuer-specific card-payment descriptors are listed one by one on purpose: plain "payment" / "paymt" would also drop
 * real bills ("enerbank usa acct paymt", "invoice cloud webpayment"). A card payment is the card account's own spending
 * counted twice if offered as a recurring expense.
 */
const SKIP_PAYEE_RE =
  /\b(?:xfer|transfer|zelle|venmo|paypal inst|betterment|provisional|acctverify|creditcard|card pay|interest|payroll|refund|reversal|return)|\batm\b|crcardpmt|\bepayment\b|\bmobile pmt\b|\bcard pmt\b|barclaycard|\bamex\b|american express/;

/** Rows per distinct day above which the group is "several charges, not one bill" (live: Google Workspace, 20 rows on 9 days). */
const SAME_DAY_ROW_RATIO = 1.5;

/** At least this share (in tenths) of intervals / amounts must fit. */
const FIT_TENTHS = 8;
const HIGH_FIT_TENTHS = 9;

const FIXED_PCT = new Decimal("0.10");
const FIXED_ABS = new Decimal(2);
const VARIES_PCT = new Decimal("0.5");
const VARIES_ABS = new Decimal(5);

/** A prefix-merge candidate must be at least this long ("toyota" absorbs "toyota ach rtl"; "a" absorbs nothing). */
const MIN_ROOT_NAME_LENGTH = 4;

interface CadenceSpec {
  /** Median interval band in whole days, inclusive. */
  lo: number;
  hi: number;
  minOccurrences: number;
  /** Nominal days in one cycle (stale threshold and weekly / biweekly stepping). */
  nominal: number;
  /** A generated date must be at least this many days after the last one seen (an early payment is the same cycle). */
  minGap: number;
  highMin: number;
  mediumMin: number;
}

const CADENCES: Record<Cadence, CadenceSpec> = {
  weekly: { lo: 6, hi: 8, minOccurrences: 5, nominal: 7, minGap: 4, highMin: 5, mediumMin: 5 },
  biweekly: { lo: 12, hi: 16, minOccurrences: 4, nominal: 14, minGap: 9, highMin: 5, mediumMin: 4 },
  monthly: { lo: 26, hi: 35, minOccurrences: 3, nominal: 30, minGap: 20, highMin: 6, mediumMin: 4 },
  quarterly: { lo: 84, hi: 98, minOccurrences: 3, nominal: 91, minGap: 60, highMin: 4, mediumMin: 3 },
  annual: { lo: 350, hi: 380, minOccurrences: 2, nominal: 365, minGap: 300, highMin: Infinity, mediumMin: Infinity },
};
const CADENCE_ORDER: Cadence[] = ["weekly", "biweekly", "monthly", "quarterly", "annual"];

/** Stale: last seen longer ago than 1.5 cycles + 7 days (monthly: 52 days). Live: OpenAI, an old QuickBooks Comcast. */
const STALE_CYCLES = 1.5;
const STALE_EXTRA_DAYS = 7;

/** Day-of-month spread (circular, 30-day wrap) limits. */
const STEADY_DAY_SPREAD = 3;
const LOOSE_DAY_SPREAD = 7;

/** Suppression. */
const TAG_SUPPRESS_SHARE_TENTHS = 5;
const AMOUNT_DAY_WINDOW = 3;

/** Late flag. Live: the Mortgage bill says day 1 but posts on the 2nd-5th, so grace counts from the OBSERVED day. */
const MIN_LATE_MATCHES = 3;
const LATE_GRACE_DAYS: Record<"monthly" | "weekly" | "biweekly", number> = { monthly: 5, weekly: 3, biweekly: 4 };
const LATE_LOOKBACK_DAYS = 10;
const LATE_STOP_DAYS = 25;
/** History older than this before the expected date means the bill probably stopped; never flag it. */
const LATE_MAX_HISTORY_AGE_DAYS = 75;
const LATE_STOP_CYCLES_SHORT = 3;

/** Amount change: both must hold. Live Eversource swings 41 to 665, so only FIXED series are ever flagged. */
const CHANGE_PCT = new Decimal("0.10");
const CHANGE_ABS = new Decimal(2);
const CHANGE_MIN_PRIOR = 4;
const CHANGE_PRIOR_WINDOW = 8;

/** History differs from the record. */
const DIFFERS_MIN_OCCURRENCES = 4;
const DIFFERS_AMOUNT_PCT = new Decimal("0.25");
const DIFFERS_AMOUNT_ABS = new Decimal(5);
const DIFFERS_RECENT_WINDOW = 10;

/** Safety cap on generated dates per series. */
const MAX_CYCLES = 400;

/** Dismissal list cap. */
export const DISMISSED_CAP = 200;

// ── Small helpers ────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function utcMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysBetween(aMs: number, bMs: number): number {
  return Math.round((bMs - aMs) / DAY_MS);
}

/** Date for `day` of the month `monthOffsetFrom0` (month index may overflow either way), clamped to the month's length. */
function monthDate(year: number, month0: number, day: number): Date {
  const first = new Date(Date.UTC(year, month0, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth();
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(Math.max(day, 1), dim)));
}

function medianNumber(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function medianDecimal(xs: Decimal[]): Decimal {
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as Decimal;
  return (s[mid - 1] as Decimal).plus(s[mid] as Decimal).div(2).toDecimalPlaces(2);
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function money(d: Decimal): string {
  const [whole = "0", frac = "00"] = d.abs().toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function titleCase(s: string): string {
  return s
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Monthly-equivalent of one payment at a cadence (comparison only). */
export function monthlyEquivalent(amount: Decimal, cadence: Cadence): Decimal {
  switch (cadence) {
    case "weekly":
      return amount.times(52).div(12);
    case "biweekly":
      return amount.times(26).div(12);
    case "monthly":
      return amount;
    case "quarterly":
      return amount.div(3);
    case "annual":
      return amount.div(12);
  }
}

export function seriesMonthly(s: Series): Decimal {
  return monthlyEquivalent(s.typicalAmount, s.cadence).toDecimalPlaces(2);
}

// ── Payee canonicalization ───────────────────────────────────────────────────

// payeeNormalized is NOT clean on Primary Checking (live: ~60% of rows are raw bank descriptions, the same merchant
// appears under 2-4 keys), so the detector canonicalizes by itself.
const US_STATES = new Set(
  "al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy".split(
    " "
  )
);
const POS_PREFIX_RE = /^(?:visa )?dda (?:purchase|purch|pur|ref)(?: w cb| ap| ref)?\s+/;

/**
 * Lower-case; strip a leading "dda purchase ap" style POS prefix; drop every token containing a digit; drop trailing
 * two-letter US state tokens; collapse spaces. Falls back to the cleaned original when nothing is left.
 */
export function canonicalPayee(raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  const stripped = base.replace(POS_PREFIX_RE, "");
  const tokens = stripped.split(" ").filter((t) => t.length > 0 && !/\d/.test(t));
  while (tokens.length > 1 && US_STATES.has(tokens[tokens.length - 1] as string)) tokens.pop();
  const out = tokens.join(" ");
  return out || base;
}

function isTokenPrefix(shorter: string, longer: string): boolean {
  const a = shorter.split(" ");
  const b = longer.split(" ");
  if (a.length >= b.length) return false;
  return a.every((t, i) => t === b[i]);
}

// ── Day-of-month statistics (circular on a 30-day wrap) ───────────────────────

/** Position on the 30-slot circle: day 31 shares slot 30 (both are "end of month"), day 1 follows it. */
function slot(day: number): number {
  return day >= 31 ? 29 : day - 1;
}

/**
 * Typical day and spread of a list of days-of-month, treating the month as a circle so 30, 31, 1 are neighbours.
 * Live: "google store" posts 1st..30th and showed a false spread of 28 without the wrap.
 */
export function circularDays(days: number[]): { day: number; spread: number } {
  const slots = days.map(slot).sort((a, b) => a - b);
  let maxGap = -1;
  let startIdx = 0;
  for (let i = 0; i < slots.length; i++) {
    const cur = slots[i] as number;
    const next = i + 1 < slots.length ? (slots[i + 1] as number) : (slots[0] as number) + 30;
    const gap = next - cur;
    if (gap > maxGap) {
      maxGap = gap;
      startIdx = (i + 1) % slots.length;
    }
  }
  const start = slots[startIdx] as number;
  const unrolled = slots.map((s) => (s - start + 30) % 30);
  const med = Math.floor(medianNumber(unrolled));
  return { day: ((med + start) % 30) + 1, spread: 30 - maxGap };
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(slot(a) - slot(b));
  return Math.min(d, 30 - d);
}

function dayRuleText(cadence: Cadence, day: number | null, spread: number): string {
  if (cadence === "weekly") return "about every 7 days";
  if (cadence === "biweekly") return "about every 14 days";
  if (day === null) return "day not steady";
  if (spread <= STEADY_DAY_SPREAD) return `usually around the ${ordinal(day)}`;
  if (spread <= LOOSE_DAY_SPREAD) return `around the ${ordinal(day)}, day varies`;
  return "day not steady";
}

// ── Date generation ──────────────────────────────────────────────────────────

/**
 * Expected dates after `lastSeen` (exclusive) and before `upTo`. Weekly / biweekly step from the last date; monthly,
 * quarterly and annual use `typicalDay` clamped to the month's length (day 30 in February is the 28th / 29th). A date
 * closer than the cadence's minimum gap to `lastSeen` is the cycle that already posted, so it is skipped.
 */
export function cycleDates(
  cadence: Cadence,
  typicalDay: number | null,
  lastSeen: Date,
  upTo: Date,
  maxResults = Number.POSITIVE_INFINITY
): Date[] {
  const out: Date[] = [];
  const last = utcMs(lastSeen);
  const limit = upTo.getTime();
  const spec = CADENCES[cadence];
  if (cadence === "weekly" || cadence === "biweekly") {
    for (let k = 1; k <= MAX_CYCLES && out.length < maxResults; k++) {
      const ms = last + k * spec.nominal * DAY_MS;
      if (ms >= limit) break;
      out.push(new Date(ms));
    }
    return out;
  }
  const stepMonths = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const day = typicalDay ?? lastSeen.getUTCDate();
  for (let i = 0; i < MAX_CYCLES && out.length < maxResults; i++) {
    const d = monthDate(lastSeen.getUTCFullYear(), lastSeen.getUTCMonth() + i * stepMonths, day);
    if (d.getTime() >= limit) break;
    if (daysBetween(last, d.getTime()) >= spec.minGap) out.push(d);
  }
  return out;
}

/** Dates of a series inside [from, to). Used by the loader to feed the ledger's learned block. */
export function expandSeriesDates(series: Series, from: Date, to: Date): Date[] {
  return cycleDates(series.cadence, series.typicalDay, series.lastSeen, to).filter(
    (d) => d.getTime() >= from.getTime() && d.getTime() < to.getTime()
  );
}

// ── Internal shapes ──────────────────────────────────────────────────────────

interface PRow {
  entityId: string;
  accountId: string;
  dir: "out" | "in";
  canon: string;
  root: string;
  abs: Decimal;
  ms: number;
  tagIds: string[];
}

interface Occ {
  ms: number;
  amount: Decimal;
}

interface Internal {
  series: Series;
  occ: Occ[];
}

/** Same-day rows are ONE occurrence (their amounts add up). */
function occurrencesOf(rows: PRow[]): { occ: Occ[] } {
  const byDay = new Map<number, Decimal>();
  for (const r of rows) byDay.set(r.ms, (byDay.get(r.ms) ?? ZERO).plus(r.abs));
  const keys = [...byDay.keys()].sort((a, b) => a - b);
  return { occ: keys.map((ms) => ({ ms, amount: byDay.get(ms) as Decimal })) };
}

// ── Amount classification ────────────────────────────────────────────────────

type AmountClass = { mode: "fixed" | "varies" | "reject"; median: Decimal };

function within(a: Decimal, center: Decimal, pct: Decimal, abs: Decimal): boolean {
  const tol = Decimal.max(center.times(pct), abs);
  return a.minus(center).abs().lte(tol);
}

function classifyAmounts(amts: Decimal[]): AmountClass {
  const median = medianDecimal(amts);
  const share = (pct: Decimal, abs: Decimal) => amts.filter((a) => within(a, median, pct, abs)).length;
  if (share(FIXED_PCT, FIXED_ABS) * 10 >= amts.length * FIT_TENTHS) return { mode: "fixed", median };
  if (share(VARIES_PCT, VARIES_ABS) * 10 >= amts.length * FIT_TENTHS) return { mode: "varies", median };
  return { mode: "reject", median };
}

/** A real change: at least 10% AND at least $2. */
function bigChange(was: Decimal, now: Decimal): boolean {
  const diff = now.minus(was).abs();
  return diff.gte(CHANGE_ABS) && was.gt(ZERO) && diff.div(was).gte(CHANGE_PCT);
}

function cadenceForInterval(median: number): Cadence | null {
  for (const c of CADENCE_ORDER) {
    const spec = CADENCES[c];
    if (median >= spec.lo && median <= spec.hi) return c;
  }
  return null;
}

function intervalFits(interval: number, spec: CadenceSpec): boolean {
  if (interval >= spec.lo - 1 && interval <= spec.hi + 1) return true;
  // One skipped cycle is tolerated (the band doubled).
  return interval >= 2 * spec.lo - 1 && interval <= 2 * spec.hi + 1;
}

// ── Evaluating one group ─────────────────────────────────────────────────────

function evaluateGroup(rows: PRow[], canon: string, today: Date): Internal | null {
  const first = rows[0];
  if (!first) return null;
  const { occ } = occurrencesOf(rows);
  const n = occ.length;
  if (n < 2) return null;
  // Several charges on the same few days are not one bill (live: Google Workspace on Capital One).
  if (rows.length > SAME_DAY_ROW_RATIO * n) return null;

  const intervals: number[] = [];
  for (let i = 1; i < n; i++) intervals.push(daysBetween((occ[i - 1] as Occ).ms, (occ[i] as Occ).ms));
  const cadence = cadenceForInterval(medianNumber(intervals));
  if (!cadence) return null;
  const spec = CADENCES[cadence];
  if (n < spec.minOccurrences) return null;

  const fitCount = intervals.filter((i) => intervalFits(i, spec)).length;
  if (fitCount * 10 < intervals.length * FIT_TENTHS) return null;
  const fitHigh = fitCount * 10 >= intervals.length * HIGH_FIT_TENTHS;

  const amts = occ.map((o) => o.amount);
  let cls = classifyAmounts(amts);
  if (cls.mode !== "fixed" && amts.length >= 6) {
    // A steady bill whose last two payments moved to a new price (a price rise) is still the same bill.
    const lastTwo = amts.slice(-2);
    const base = classifyAmounts(amts.slice(0, -2));
    const recent = medianDecimal(lastTwo);
    if (
      base.mode === "fixed" &&
      within(lastTwo[0] as Decimal, recent, FIXED_PCT, FIXED_ABS) &&
      within(lastTwo[1] as Decimal, recent, FIXED_PCT, FIXED_ABS) &&
      bigChange(base.median, recent)
    ) {
      cls = { mode: "fixed", median: recent };
    }
  }
  if (cls.mode === "reject") return null;
  // Weekly and biweekly bills must be a fixed amount (live: a Barclay lunch spot passed as "weekly, varies").
  if ((cadence === "weekly" || cadence === "biweekly") && cls.mode !== "fixed") return null;
  // A yearly bill whose amount also varies is a coincidence of two similar purchases (live: a convenience store).
  if (cadence === "annual" && cls.mode !== "fixed") return null;

  let typical = cls.median;
  if (cls.mode === "fixed" && amts.length >= 6) {
    const lastTwo = amts.slice(-2);
    const recent = medianDecimal(lastTwo);
    if (
      within(lastTwo[0] as Decimal, recent, FIXED_PCT, FIXED_ABS) &&
      within(lastTwo[1] as Decimal, recent, FIXED_PCT, FIXED_ABS) &&
      bigChange(typical, recent)
    ) {
      typical = recent;
    }
  }

  const days = occ.map((o) => new Date(o.ms).getUTCDate());
  let typicalDay: number | null = null;
  let spread = 0;
  if (cadence !== "weekly" && cadence !== "biweekly") {
    const c = circularDays(days);
    typicalDay = c.day;
    spread = c.spread;
  }
  const dayRule = dayRuleText(cadence, typicalDay, spread);

  let confidence: Confidence;
  if (cadence === "annual") confidence = "low";
  else if (cls.mode === "fixed" && fitHigh && (cadence !== "monthly" || spread <= STEADY_DAY_SPREAD) && n >= spec.highMin) {
    confidence = "high";
  } else if (cadence === "monthly" && spread > LOOSE_DAY_SPREAD) confidence = "low";
  else if (n >= spec.mediumMin) confidence = "medium";
  else confidence = "low";

  const lastOcc = occ[n - 1] as Occ;
  const firstOcc = occ[0] as Occ;
  const lastSeen = new Date(lastOcc.ms);
  const amounts = occ.map((o) => o.amount);
  const minAmount = amounts.reduce((a, b) => (b.lt(a) ? b : a));
  const maxAmount = amounts.reduce((a, b) => (b.gt(a) ? b : a));

  const nextList = cycleDates(cadence, typicalDay, lastSeen, new Date(lastOcc.ms + 800 * DAY_MS), 1);
  const nextExpected = nextList[0] ?? new Date(lastOcc.ms + spec.nominal * DAY_MS);

  const stale = daysBetween(lastOcc.ms, today.getTime()) > STALE_CYCLES * spec.nominal + STALE_EXTRA_DAYS;

  // Dominant tag (a hint, never a requirement: tagged share was only 40-50% before 2026-04).
  const tagCounts = new Map<string, number>();
  for (const r of rows) for (const t of new Set(r.tagIds)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  let dominantTagId: string | null = null;
  let dominantCount = 0;
  for (const t of [...tagCounts.keys()].sort()) {
    const c = tagCounts.get(t) as number;
    if (c > dominantCount) {
      dominantCount = c;
      dominantTagId = t;
    }
  }

  const spacing =
    cadence === "weekly"
      ? "about every 7 days"
      : cadence === "biweekly"
        ? "about every 14 days"
        : `${Math.min(...intervals)}-${Math.max(...intervals)} days apart`;
  const why: string[] = [
    `Seen ${n} times`,
    spacing,
    cls.mode === "fixed" ? `always about ${money(typical)}` : `amount varies, about ${money(minAmount)} to ${money(maxAmount)}`,
  ];
  // The weekly / biweekly day rule would only repeat the spacing phrase.
  if (cadence !== "weekly" && cadence !== "biweekly") why.push(dayRule);

  const series: Series = {
    key: `${first.entityId}|${first.accountId}|${first.dir}|${canon}`,
    entityId: first.entityId,
    accountId: first.accountId,
    kind: first.dir === "out" ? "outflow" : "inflow",
    payee: titleCase(canon),
    cadence,
    typicalDay,
    dayRule,
    typicalAmount: typical.toDecimalPlaces(2),
    minAmount,
    maxAmount,
    amountMode: cls.mode,
    occurrences: n,
    firstSeen: new Date(firstOcc.ms),
    lastSeen,
    nextExpected,
    confidence,
    why,
    dominantTagId,
    tagShare: dominantTagId === null ? 0 : dominantCount / rows.length,
    stale,
    suppressedBy: null,
  };
  return { series, occ };
}

// ── Suppression ──────────────────────────────────────────────────────────────

function suppressionFor(s: Series, rows: PRow[], modelled: ModelledRef[]): Series["suppressedBy"] {
  const dir = s.kind === "outflow" ? "outflow" : "inflow";
  const refs = modelled.filter((m) => m.direction === dir && m.entityId === s.entityId);
  if (refs.length === 0) return null;

  // 1. Tag: at least half of the series' rows carry a tag a modelled record is tied to.
  const refByTag = new Map<string, ModelledRef>();
  for (const m of refs) if (m.tagKey && !refByTag.has(m.tagKey)) refByTag.set(m.tagKey, m);
  if (refByTag.size > 0 && rows.length > 0) {
    const perTag = new Map<string, number>();
    for (const r of rows) {
      for (const t of new Set(r.tagIds)) {
        const key = `${r.entityId}|${t}`;
        if (refByTag.has(key)) perTag.set(key, (perTag.get(key) ?? 0) + 1);
      }
    }
    for (const key of [...perTag.keys()].sort()) {
      if ((perTag.get(key) as number) * 10 >= rows.length * TAG_SUPPRESS_SHARE_TENTHS) {
        const ref = refByTag.get(key) as ModelledRef;
        return { kind: "tag", label: ref.label, source: ref.source };
      }
    }
  }

  // 2. Name: a shared distinctive word with a record of the same entity.
  const words = nameWords(s.payee);
  if (words.length > 0) {
    for (const m of refs) {
      if (!accountsCompatible(m.accountId, s.accountId)) continue;
      const theirs = new Set(nameWords(m.label));
      if (words.some((w) => theirs.has(w))) return { kind: "name", label: m.label, source: m.source };
    }
  }

  // 3. Amount + day: the same money on about the same day, for a record without a distinctive name.
  const monthly = seriesMonthly(s);
  for (const m of refs) {
    if (!accountsCompatible(m.accountId, s.accountId)) continue;
    if (!m.monthly || !amountsClose(monthly, m.monthly)) continue;
    const dayOk =
      m.day === null || (s.typicalDay !== null && circularDistance(m.day, s.typicalDay) <= AMOUNT_DAY_WINDOW);
    if (dayOk) return { kind: "amount_day", label: m.label, source: m.source };
  }
  return null;
}

// ── History matching for recorded items ──────────────────────────────────────

/** The rows that look like payments of a recorded item, or null. Tag first (one dominant payee only), then name, then amount+day. */
function matchRows(ref: ModelledRef, rows: PRow[]): PRow[] | null {
  const dir = ref.direction === "outflow" ? "out" : "in";
  const pool = rows.filter((r) => r.entityId === ref.entityId && r.dir === dir && accountsCompatible(ref.accountId, r.accountId));
  if (pool.length === 0) return null;

  if (ref.tagKey) {
    const tagged = pool.filter((r) => r.tagIds.some((t) => `${r.entityId}|${t}` === ref.tagKey));
    if (tagged.length > 0) {
      // A budget category can hold several payees; only one dominant payee is "this bill".
      const counts = new Map<string, number>();
      for (const r of tagged) counts.set(r.root, (counts.get(r.root) ?? 0) + 1);
      let top = "";
      let topCount = 0;
      for (const k of [...counts.keys()].sort()) {
        const c = counts.get(k) as number;
        if (c > topCount) {
          top = k;
          topCount = c;
        }
      }
      if (topCount * 10 < tagged.length * 6) return null;
      return tagged.filter((r) => r.root === top);
    }
  }

  const refWords = nameWords(ref.label);
  if (refWords.length > 0) {
    const named = pool.filter((r) => nameWords(r.canon).some((w) => refWords.includes(w)));
    if (named.length > 0) return named;
  }

  const expected = ref.expectedAmount;
  const refDay = ref.day;
  if (expected && refDay !== null) {
    const byMoney = pool.filter(
      (r) => amountsClose(r.abs, expected) && circularDistance(new Date(r.ms).getUTCDate(), refDay) <= 4
    );
    if (byMoney.length > 0) return byMoney;
  }
  return null;
}

// ── Flags ────────────────────────────────────────────────────────────────────

type LateCadence = "monthly" | "weekly" | "biweekly";

function isLateCadence(c: string | null): c is LateCadence {
  return c === "monthly" || c === "weekly" || c === "biweekly";
}

/** The "expected, has not posted" sentence, or null. `label` leads the sentence. */
function lateText(label: string, cadence: LateCadence, occ: Occ[], today: Date): { text: string; day?: number } | null {
  if (occ.length < MIN_LATE_MATCHES) return null;
  const todayMs = today.getTime();
  const lastMs = (occ[occ.length - 1] as Occ).ms;

  if (cadence === "monthly") {
    const c = circularDays(occ.map((o) => new Date(o.ms).getUTCDate()));
    const thisE = monthDate(today.getUTCFullYear(), today.getUTCMonth(), c.day).getTime();
    const prevE = monthDate(today.getUTCFullYear(), today.getUTCMonth() - 1, c.day).getTime();
    const expected = thisE <= todayMs ? thisE : prevE;
    if (daysBetween(lastMs, expected) > LATE_MAX_HISTORY_AGE_DAYS) return null;
    if (todayMs < expected + LATE_GRACE_DAYS.monthly * DAY_MS) return null;
    if (todayMs >= expected + LATE_STOP_DAYS * DAY_MS) return null;
    if (occ.some((o) => o.ms >= expected - LATE_LOOKBACK_DAYS * DAY_MS)) return null;
    const sameMonth = expected === thisE;
    return {
      day: c.day,
      text: `${label} usually posts around the ${ordinal(c.day)}; none seen yet ${sameMonth ? "this month" : "for last month"}.`,
    };
  }

  const step = CADENCES[cadence].nominal;
  const expected = lastMs + step * DAY_MS;
  if (todayMs < expected + LATE_GRACE_DAYS[cadence] * DAY_MS) return null;
  if (todayMs >= expected + LATE_STOP_CYCLES_SHORT * step * DAY_MS) return null;
  return {
    text: `${label} usually posts ${cadence === "weekly" ? "every week" : "every two weeks"}; none seen since ${shortDate(lastMs)}.`,
  };
}

/** Latest amount against the prior ones. Returns null unless a real change was found. */
function priceChange(amts: Decimal[]): { was: Decimal; now: Decimal; inARow: number } | null {
  const n = amts.length;
  if (n < CHANGE_MIN_PRIOR + 1) return null;
  const latest = amts[n - 1] as Decimal;
  const prior = amts.slice(Math.max(0, n - 1 - CHANGE_PRIOR_WINDOW), n - 1);
  const was = medianDecimal(prior);
  if (!bigChange(was, latest)) return null;
  const prev = amts[n - 2] as Decimal;
  if (n - 2 >= CHANGE_MIN_PRIOR && bigChange(was, prev) && within(prev, latest, FIXED_PCT, FIXED_ABS)) {
    const earlier = amts.slice(Math.max(0, n - 2 - CHANGE_PRIOR_WINDOW), n - 2);
    const was2 = medianDecimal(earlier);
    if (bigChange(was2, latest)) return { was: was2, now: latest, inARow: 2 };
  }
  return { was, now: latest, inARow: 1 };
}

const CADENCE_PHRASE_HISTORY: Record<Cadence, string> = {
  weekly: "every week",
  biweekly: "every two weeks",
  monthly: "a month",
  quarterly: "every three months",
  annual: "a year",
};

function historyDiffers(ref: ModelledRef, occ: Occ[]): string | null {
  if (!isLateCadence(ref.cadence)) return null;
  if (occ.length < DIFFERS_MIN_OCCURRENCES) return null;
  const recent = occ.slice(-DIFFERS_RECENT_WINDOW);
  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i++) intervals.push(daysBetween((recent[i - 1] as Occ).ms, (recent[i] as Occ).ms));
  const histCadence = cadenceForInterval(medianNumber(intervals));
  if (!histCadence) return null;
  // The history must be steady at that cadence, or "history shows weekly" would be an accident of a mixed payee.
  const histSpec = CADENCES[histCadence];
  if (intervals.filter((i) => intervalFits(i, histSpec)).length * 10 < intervals.length * FIT_TENTHS) return null;
  const recentAmounts = recent.slice(-CHANGE_PRIOR_WINDOW).map((o) => o.amount);
  const histAmount = medianDecimal(recentAmounts);

  if (histCadence !== ref.cadence) {
    const recordAmount = ref.expectedAmount ?? ref.monthly;
    if (!recordAmount) return null;
    const refPhrase =
      ref.cadence === "monthly" ? "monthly" : ref.cadence === "weekly" ? "weekly" : "every two weeks";
    return `${ref.label}: your records say ${money(recordAmount)} ${refPhrase}; history shows about ${money(histAmount)} ${CADENCE_PHRASE_HISTORY[histCadence]}.`;
  }

  // Amount-only comparison needs a steady amount (a swinging utility has no "usual" figure to compare).
  if (!ref.monthly || classifyAmounts(recentAmounts).mode !== "fixed") return null;
  const histMonthly = monthlyEquivalent(histAmount, histCadence).toDecimalPlaces(2);
  const diff = histMonthly.minus(ref.monthly).abs();
  if (diff.gte(DIFFERS_AMOUNT_ABS) && ref.monthly.gt(ZERO) && diff.div(ref.monthly).gt(DIFFERS_AMOUNT_PCT)) {
    return `${ref.label}: your records say about ${money(ref.monthly)} a month; history shows about ${money(histMonthly)} a month.`;
  }
  return null;
}

// ── detectRecurring ──────────────────────────────────────────────────────────

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
const FLAG_ORDER: Record<Flag["type"], number> = { late: 0, amount_change: 1, history_differs: 2 };

function filterRows(rows: TxRow[]): Omit<PRow, "root">[] {
  const out: Omit<PRow, "root">[] = [];
  for (const r of rows) {
    if (!r.payee || r.payee.trim() === "") continue;
    if (EXCLUDED_ACCOUNT_TYPES.has(r.accountType)) continue;
    const isInflow = r.amount.gt(ZERO);
    if (r.amount.isZero() || r.amount.isNaN()) continue;
    if (isInflow && !DEPOSIT_ACCOUNT_TYPES.has(r.accountType)) continue;
    const abs = r.amount.abs();
    if (abs.lt(MIN_ABS_AMOUNT)) continue;
    const canon = canonicalPayee(r.payee);
    // Punctuation-only payees ("***") canonicalize to "": they would merge into one nameless series.
    if (canon === "") continue;
    if (SKIP_PAYEE_RE.test(canon)) continue;
    out.push({
      entityId: r.entityId,
      accountId: r.accountId,
      dir: isInflow ? "in" : "out",
      canon,
      abs,
      ms: utcMs(r.postedAt),
      tagIds: r.tagIds,
    });
  }
  return out;
}

export function detectRecurring(input: DetectInput): DetectResult {
  const today = startOfDayUTC(input.today);

  // 1. Filter and canonicalize.
  const filtered = filterRows(input.rows);
  filtered.sort(
    (a, b) =>
      a.ms - b.ms ||
      (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0) ||
      (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0) ||
      (a.canon < b.canon ? -1 : a.canon > b.canon ? 1 : 0) ||
      a.abs.comparedTo(b.abs)
  );

  // 2. Group by entity + account + sign, then by canonical name; prefix-merge into the shortest root.
  const buckets = new Map<string, Map<string, Omit<PRow, "root">[]>>();
  for (const r of filtered) {
    const bk = `${r.entityId}|${r.accountId}|${r.dir}`;
    const names = buckets.get(bk) ?? new Map<string, Omit<PRow, "root">[]>();
    const list = names.get(r.canon) ?? [];
    list.push(r);
    names.set(r.canon, list);
    buckets.set(bk, names);
  }

  const prows: PRow[] = [];
  const internals: Internal[] = [];
  const rowsOfSeries = new Map<string, PRow[]>();

  for (const bk of [...buckets.keys()].sort()) {
    const names = buckets.get(bk) as Map<string, Omit<PRow, "root">[]>;
    const nameList = [...names.keys()].sort();
    const rootOf = new Map<string, string>();
    for (const name of nameList) {
      let best: string | null = null;
      for (const cand of nameList) {
        if (cand === name || cand.length < MIN_ROOT_NAME_LENGTH || !isTokenPrefix(cand, name)) continue;
        if (best === null || cand.split(" ").length < best.split(" ").length) best = cand;
      }
      rootOf.set(name, best ?? name);
    }
    const members = new Map<string, string[]>();
    const rowsByName = new Map<string, PRow[]>();
    for (const name of nameList) {
      const root = rootOf.get(name) as string;
      members.set(root, [...(members.get(root) ?? []), name]);
      const withRoot = (names.get(name) as Omit<PRow, "root">[]).map((row): PRow => ({ ...row, root }));
      rowsByName.set(name, withRoot);
      prows.push(...withRoot);
    }
    const rowsFor = (list: string[]): PRow[] =>
      list
        .flatMap((n) => rowsByName.get(n) ?? [])
        .sort((a, b) => a.ms - b.ms || a.abs.comparedTo(b.abs));

    for (const root of [...members.keys()].sort()) {
      const memberNames = members.get(root) as string[];
      const merged = rowsFor(memberNames);
      let result = evaluateGroup(merged, root, today);
      if (result) {
        rowsOfSeries.set(result.series.key, merged);
        internals.push(result);
      } else if (memberNames.length > 1) {
        // The merged group failed: each pre-merge sub-group may still be a series (live: "soapy noble").
        for (const name of memberNames) {
          const sub = rowsFor([name]);
          result = evaluateGroup(sub, name, today);
          if (result) {
            rowsOfSeries.set(result.series.key, sub);
            internals.push(result);
          }
        }
      }
    }
  }

  const staleCount = internals.filter((i) => i.series.stale).length;
  const active = internals.filter((i) => !i.series.stale);

  // 3. Suppression against what the owner already recorded.
  for (const i of active) {
    i.series.suppressedBy = suppressionFor(i.series, rowsOfSeries.get(i.series.key) ?? [], input.modelled);
  }
  const byStrength = (a: Series, b: Series) =>
    CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const suggestions = active.filter((i) => !i.series.suppressedBy).map((i) => i.series).sort(byStrength);
  const suppressed = active.filter((i) => i.series.suppressedBy).map((i) => i.series).sort(byStrength);

  // 4. Flags.
  const flags: Flag[] = [];

  for (const ref of input.modelled) {
    if (ref.direction !== "outflow") continue;
    const rows = matchRows(ref, prows);
    if (!rows) continue;
    const { occ } = occurrencesOf(rows);
    if (isLateCadence(ref.cadence)) {
      const late = lateText(ref.label, ref.cadence, occ, today);
      if (late) {
        flags.push({ type: "late", entityId: ref.entityId, seriesKey: null, modelled: ref, text: late.text, usualDay: late.day });
      }
      const differs = historyDiffers(ref, occ);
      if (differs) flags.push({ type: "history_differs", entityId: ref.entityId, seriesKey: null, modelled: ref, text: differs });
    }
  }

  for (const i of active) {
    const s = i.series;
    const label = s.suppressedBy ? s.suppressedBy.label : s.payee;
    if (!s.suppressedBy && s.kind === "outflow" && s.confidence === "high" && isLateCadence(s.cadence)) {
      const late = lateText(label, s.cadence, i.occ, today);
      if (late) flags.push({ type: "late", entityId: s.entityId, seriesKey: s.key, modelled: null, text: late.text, usualDay: late.day });
    }
    if (s.amountMode === "fixed" && s.kind === "outflow") {
      const change = priceChange(i.occ.map((o) => o.amount));
      if (change) {
        const text =
          change.inARow >= 2
            ? `${label}: was about ${money(change.was)}, now about ${money(change.now)} (2 in a row).`
            : `${label}: was about ${money(change.was)}, latest was ${money(change.now)}.`;
        flags.push({ type: "amount_change", entityId: s.entityId, seriesKey: s.key, modelled: null, text, was: change.was, now: change.now });
      }
    }
  }

  const seen = new Set<string>();
  const uniqueFlags = flags
    .filter((f) => {
      const k = `${f.type}|${f.entityId}|${f.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => FLAG_ORDER[a.type] - FLAG_ORDER[b.type] || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

  return { suggestions, suppressed, suppressedCount: suppressed.length, flags: uniqueFlags, staleCount };
}

// ── Dismissals (pure parse / serialize / apply; persistence is lib/settings.ts) ──

export interface DismissedEntry {
  k: string;
  at: string;
}

/** Fails soft: anything unreadable is an empty list. */
export function parseDismissed(raw: string | null | undefined): DismissedEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const keys = (parsed as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) return [];
    const out: DismissedEntry[] = [];
    for (const e of keys) {
      if (e && typeof e === "object" && typeof (e as { k?: unknown }).k === "string") {
        const k = (e as { k: string }).k;
        const at = typeof (e as { at?: unknown }).at === "string" ? (e as { at: string }).at : "";
        if (k.length > 0 && k.length <= 300) out.push({ k, at });
      }
    }
    return out.slice(-DISMISSED_CAP);
  } catch {
    return [];
  }
}

export function serializeDismissed(entries: DismissedEntry[]): string {
  return JSON.stringify({ v: 1, keys: entries.slice(-DISMISSED_CAP) });
}

/** Two keys are the same series when equal or when one canonical name is a token-prefix of the other (same entity / account / sign). */
export function keysRelated(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = a.split("|");
  const pb = b.split("|");
  if (pa.length !== 4 || pb.length !== 4) return false;
  if (pa[0] !== pb[0] || pa[1] !== pb[1] || pa[2] !== pb[2]) return false;
  const na = pa[3] as string;
  const nb = pb[3] as string;
  return isTokenPrefix(na, nb) || isTokenPrefix(nb, na);
}

export function isDismissed(seriesKey: string, dismissed: DismissedEntry[]): boolean {
  return dismissed.some((d) => keysRelated(d.k, seriesKey));
}

export function addDismissed(entries: DismissedEntry[], key: string, at: string): DismissedEntry[] {
  if (isDismissed(key, entries)) return entries;
  return [...entries, { k: key, at }].slice(-DISMISSED_CAP);
}

export function removeDismissed(entries: DismissedEntry[], key: string): DismissedEntry[] {
  return entries.filter((d) => !keysRelated(d.k, key));
}

export interface DetectionBundle {
  /** Not dismissed. */
  suggestions: Series[];
  /** Detected and dismissed ("Not a bill"), restorable. */
  dismissed: Series[];
  flags: Flag[];
  /** Active series hidden because they look already recorded (the server action refuses these as "Already recorded"). */
  suppressed: Series[];
  suppressedCount: number;
  staleCount: number;
}

/** Splits the detector's suggestions by the owner's dismissals; flags about a dismissed series are dropped. */
export function applyDismissals(result: DetectResult, dismissed: DismissedEntry[]): DetectionBundle {
  const hidden = result.suggestions.filter((s) => isDismissed(s.key, dismissed));
  const visible = result.suggestions.filter((s) => !isDismissed(s.key, dismissed));
  return {
    suggestions: visible,
    dismissed: hidden,
    flags: result.flags.filter((f) => f.seriesKey === null || !isDismissed(f.seriesKey, dismissed)),
    suppressed: result.suppressed,
    suppressedCount: result.suppressedCount,
    staleCount: result.staleCount,
  };
}
