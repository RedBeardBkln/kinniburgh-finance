// Seasonal model v0 for the three variable household bills (Electric (Eversource), Oil (McCarthy), Firewood), built ONLY
// from transactions that already exist plus the owner's heating-oil $/gal entries. Pure: no database, no clock (callers
// pass `now`), no Next.js. The read-only loader is lib/seasonal-energy-build.ts.
//
// Contract (carry-forward-seasonal-energy, step 2): every model returns EITHER an estimate (amount, range, confidence,
// a plain `basis`) OR a gate reason and NO number. Consumers use the flat budget / bill figure whenever the result is
// gated and print the reason once. An estimate is never shown without its basis. Nothing here writes anywhere.
//
// Owner statements applied (2026-10-09, .claude/pipeline/carry-forward-seasonal-energy/01-plan.md "OWNER ANSWERS"):
//   * The PERSONAL house has solar, live since March 2023. Eversource bills are net of generation, so electric is
//     modelled in NET DOLLARS (kWh is not needed). A credit or near-zero month is real data and is kept. Only payments
//     from the solar-live month on are used.
//   * McCarthy oil heats the Personal house. Some McCarthy payments were charged to the EK Consulting card by mistake;
//     they are READ into the Personal house's oil history by payee (limited to that one entity, labelled), and nothing
//     is changed or moved. Sudden Valley (56 Arbor Rd) never receives another entity's payments.
//   * The $292.46 McCarthy charge is the yearly furnace service: it is left out of consumption / price modelling and
//     offered as an annual item.
//   * Sudden Valley is a short-term rental since April 2026, so occupancy changes use; its profile is its own.
//
// Electric method (documented, with a leave-one-out check reported to the owner): net dollars per observed calendar
// month (payments are summed per month, credits net out). Months are grouped into heating (Nov-Mar) and other (Apr-Oct).
// A month's estimate = (sum of its own observations + 1 x season mean) / (n + 1): it leans on its own history exactly
// as much as one extra season-average observation (k = 1, fixed). A month with no payment seen is NOT zero: it uses the
// season mean. The range is the lowest and highest month actually seen in that season. Gate: at least 6 different
// months, at least 2 in each season, the newest payment within 90 days. Confidence is "low" until every calendar month
// has been seen at least once, "medium" then, "high" once every calendar month has been seen at least twice.

import { Decimal } from "@prisma/client/runtime/library";
import { activeOilPrices, priceOn, type OilPriceEntry } from "@/lib/seasonal-energy-prices";
import { resolveMarks, type MarkRow, type OilMark } from "@/lib/seasonal-energy-marks";

export type EnergyKind = "electric" | "oil" | "firewood";
export type Confidence = "low" | "medium" | "high";

export const HEATING_MONTHS: readonly number[] = [11, 12, 1, 2, 3];
export const ELECTRIC_GATE_MIN_MONTHS = 6;
export const ELECTRIC_GATE_MIN_PER_SEASON = 2;
export const ELECTRIC_GATE_FRESH_DAYS = 90;
export const MAX_HISTORY_MONTHS = 36;
export const OIL_PRICE_MIN_GAP_MONTHS = 6;
export const OIL_SENSITIVITY_STEP = new Decimal("0.5");
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const ZERO = new Decimal(0);
const DAY_MS = 86_400_000;

// ── Site facts (owner statements) ───────────────────────────────────────────────

export interface ServiceCharge {
  /** Exact amount in cents. */
  cents: number;
  label: string;
}

export interface EnergySiteFacts {
  /** Entity slug these facts belong to. */
  slug: string;
  /** First YYYY-MM with solar generation (a regime boundary), or null when the owner has not said the site has solar. */
  solarLiveFrom: string | null;
  /** Entity slugs whose McCarthy payments are read into THIS site's oil history (charged to the wrong card). */
  oilFromEntitySlugs: readonly string[];
  /** Since YYYY-MM the property is a short-term rental, or null. */
  rentalSince: string | null;
  /** Amounts the owner has confirmed are not oil deliveries. */
  serviceCharges: readonly ServiceCharge[];
  statedOn: string;
}

export const ENERGY_SITE_FACTS: Readonly<Record<string, EnergySiteFacts>> = {
  personal: {
    slug: "personal",
    solarLiveFrom: "2023-03",
    oilFromEntitySlugs: ["ek-consulting"],
    rentalSince: null,
    serviceCharges: [{ cents: 29246, label: "yearly furnace service" }],
    statedOn: "2026-10-09",
  },
  "sudden-valley": {
    slug: "sudden-valley",
    solarLiveFrom: null,
    oilFromEntitySlugs: [],
    rentalSince: "2026-04",
    serviceCharges: [],
    statedOn: "2026-10-09",
  },
};

export function siteFactsFor(slug: string | null | undefined): EnergySiteFacts | null {
  if (!slug) return null;
  return ENERGY_SITE_FACTS[slug] ?? null;
}

// ── Small helpers ───────────────────────────────────────────────────────────────

export function usd(d: Decimal): string {
  const neg = d.isNegative() && !d.isZero();
  const [whole = "0", frac = "00"] = d.abs().toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${grouped}.${frac}`;
}

export function periodOfDate(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function periodIndex(period: string): number {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  return y * 12 + (m - 1);
}

export function monthOfPeriod(period: string): number {
  return Number(period.slice(5, 7));
}

export function isHeatingMonth(month: number): boolean {
  return HEATING_MONTHS.includes(month);
}

export function monthYearLabel(period: string): string {
  return `${MONTH_NAMES[monthOfPeriod(period) - 1] ?? "?"} ${period.slice(0, 4)}`;
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** A date written YYYY-MM-DD as a UTC date. */
export function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function addMonthsIso(iso: string, months: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1;
  const d = Number(iso.slice(8, 10));
  const target = y * 12 + m + months;
  const ty = Math.floor(target / 12);
  const tm = target % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, last))).toISOString().slice(0, 10);
}

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((a, b) => a.plus(b), ZERO);
}

function mean(values: readonly Decimal[]): Decimal {
  return sum(values).div(values.length);
}

function cents2(d: Decimal): Decimal {
  return d.toDecimalPlaces(2);
}

// ── Payments ────────────────────────────────────────────────────────────────────

/** One payment read from the books (a transaction), already attributed to a line of one site. */
export interface EnergyPayment {
  id: string;
  date: Date;
  /** Signed as in the ledger: negative = money out. */
  amount: Decimal;
  payee: string;
  /** Account nickname (never a number). */
  account: string | null;
  /** Set when the payment sits on ANOTHER entity's books and is read into this site's history (the card charged by mistake). */
  fromOtherEntity: string | null;
  /** Full tag paths of the transaction (display and the "check these" rule only; tags on McCarthy rows are unreliable). */
  tagPaths?: readonly string[];
  /** The ONE bank descriptor (payeeNormalized, else payeeRaw, else description) a mark compares; `payee` is the joined text used only to recognise the supplier. */
  descriptor?: string;
  /** Internal account id (never a number): part of a mark's durable signature. */
  accountId?: string;
  /** True while the bank row is pending (the bank may replace it with a posted row under a new id). */
  pending?: boolean;
}

export interface Gated {
  status: "gated";
  kind: EnergyKind;
  /** Plain-language reason; the flat budget / bill figure stays in use. No amount is attached. */
  reason: string;
}

// ── Electric ────────────────────────────────────────────────────────────────────

export interface MonthTotal {
  /** YYYY-MM */
  period: string;
  month: number;
  /** Net dollars paid that month (cost positive; a net credit is negative). */
  net: Decimal;
  payments: number;
  newest: Date;
}

/**
 * Net dollars per calendar month from the payments, inside the history window: not before the solar-live month (when
 * given), not older than MAX_HISTORY_MONTHS, not in the future. Payments in the same month are summed (a refund nets out).
 */
export function observedMonths(payments: readonly EnergyPayment[], now: Date, solarLiveFrom: string | null): MonthTotal[] {
  const nowIdx = periodIndex(periodOfDate(now));
  const byPeriod = new Map<string, { net: Decimal; payments: number; newest: Date }>();
  for (const p of payments) {
    const period = periodOfDate(p.date);
    const idx = periodIndex(period);
    if (idx > nowIdx) continue;
    if (nowIdx - idx >= MAX_HISTORY_MONTHS) continue;
    if (solarLiveFrom !== null && period < solarLiveFrom) continue;
    const cur = byPeriod.get(period) ?? { net: ZERO, payments: 0, newest: p.date };
    cur.net = cur.net.minus(p.amount);
    cur.payments += 1;
    if (p.date > cur.newest) cur.newest = p.date;
    byPeriod.set(period, cur);
  }
  return [...byPeriod.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([period, v]) => ({ period, month: monthOfPeriod(period), net: v.net, payments: v.payments, newest: v.newest }));
}

export interface MonthEstimate {
  /** 1 to 12 */
  month: number;
  /** Net dollars expected (may be zero or negative: a credit). */
  amount: Decimal;
  low: Decimal;
  high: Decimal;
  /** Months of the same calendar month actually seen. */
  ownObservations: number;
  /** "own" = leans on this month's own payments as well; "season" = no payment seen for this month, the season mean is used. */
  basis: "own" | "season";
}

interface Profile {
  months: MonthEstimate[];
  heatingMean: Decimal;
  otherMean: Decimal;
}

/** The profile math with no gates (used by the estimate and by the leave-one-out check). null when a season has no month. */
function fitProfile(observed: readonly MonthTotal[]): Profile | null {
  const heat = observed.filter((m) => isHeatingMonth(m.month));
  const other = observed.filter((m) => !isHeatingMonth(m.month));
  if (heat.length === 0 || other.length === 0) return null;
  const heatingMean = mean(heat.map((m) => m.net));
  const otherMean = mean(other.map((m) => m.net));
  const months: MonthEstimate[] = [];
  for (let month = 1; month <= 12; month++) {
    const group = isHeatingMonth(month) ? heat : other;
    const groupMean = isHeatingMonth(month) ? heatingMean : otherMean;
    const own = observed.filter((m) => m.month === month);
    const amount = sum(own.map((m) => m.net)).plus(groupMean).div(own.length + 1);
    const nets = group.map((m) => m.net);
    const low = nets.reduce((a, b) => (b.lessThan(a) ? b : a));
    const high = nets.reduce((a, b) => (b.greaterThan(a) ? b : a));
    months.push({ month, amount, low, high, ownObservations: own.length, basis: own.length > 0 ? "own" : "season" });
  }
  return { months, heatingMean, otherMean };
}

export interface Backtest {
  /** Months re-predicted. */
  months: number;
  /** Mean absolute miss, in dollars per month, predicting each observed month from all the others. */
  modelMiss: Decimal;
  /** The same for the flat figure the budget uses, when one was given. */
  flatMiss: Decimal | null;
}

/** Leave-one-out: predict each observed month from the others (same method), mean absolute miss. null when too thin. */
export function leaveOneOut(observed: readonly MonthTotal[], flatMonthly: Decimal | null): Backtest | null {
  const misses: Decimal[] = [];
  const flatMisses: Decimal[] = [];
  for (const held of observed) {
    const rest = observed.filter((m) => m.period !== held.period);
    const fit = fitProfile(rest);
    if (!fit) continue;
    const pred = fit.months[held.month - 1] as MonthEstimate;
    misses.push(pred.amount.minus(held.net).abs());
    if (flatMonthly !== null) flatMisses.push(flatMonthly.minus(held.net).abs());
  }
  if (misses.length === 0) return null;
  return { months: misses.length, modelMiss: mean(misses), flatMiss: flatMonthly !== null ? mean(flatMisses) : null };
}

export interface ElectricEstimate {
  status: "estimate";
  kind: "electric";
  months: MonthEstimate[];
  /** Twelve months added up, net dollars. */
  annual: Decimal;
  confidence: Confidence;
  basis: string;
  shortBasis: string;
  heatingMean: Decimal;
  otherMean: Decimal;
  observedMonths: number;
  paymentCount: number;
  backtest: Backtest | null;
}

export interface ElectricInput {
  payments: readonly EnergyPayment[];
  now: Date;
  site: EnergySiteFacts | null;
  /** The flat monthly figure the budget uses, for the comparison in the basis. */
  flatMonthly: Decimal | null;
  /** Names the supplier in the text. */
  supplier?: string;
}

export function electricConfidence(observed: readonly MonthTotal[]): Confidence {
  const counts = new Array<number>(12).fill(0);
  for (const m of observed) counts[m.month - 1] = (counts[m.month - 1] ?? 0) + 1;
  if (counts.every((c) => c >= 2)) return "high";
  if (counts.every((c) => c >= 1)) return "medium";
  return "low";
}

export function electricEstimate(input: ElectricInput): ElectricEstimate | Gated {
  const supplier = input.supplier ?? "Eversource";
  const observed = observedMonths(input.payments, input.now, input.site?.solarLiveFrom ?? null);
  const gated = (reason: string): Gated => ({ status: "gated", kind: "electric", reason });
  if (observed.length === 0) {
    return gated(`No ${supplier} payments were found in the last ${MAX_HISTORY_MONTHS} months, so there is nothing to estimate from.`);
  }
  if (observed.length < ELECTRIC_GATE_MIN_MONTHS) {
    return gated(
      `Only ${observed.length} different month${observed.length === 1 ? "" : "s"} of ${supplier} payments ${observed.length === 1 ? "was" : "were"} found; at least ${ELECTRIC_GATE_MIN_MONTHS} are needed before a seasonal estimate is shown.`
    );
  }
  const heat = observed.filter((m) => isHeatingMonth(m.month));
  const other = observed.filter((m) => !isHeatingMonth(m.month));
  if (heat.length < ELECTRIC_GATE_MIN_PER_SEASON) {
    return gated(
      `Only ${heat.length} month${heat.length === 1 ? "" : "s"} of payments fall in November to March (${observed.length} months in all); at least ${ELECTRIC_GATE_MIN_PER_SEASON} are needed to see the heating season.`
    );
  }
  if (other.length < ELECTRIC_GATE_MIN_PER_SEASON) {
    return gated(
      `Only ${other.length} month${other.length === 1 ? "" : "s"} of payments fall in April to October (${observed.length} months in all); at least ${ELECTRIC_GATE_MIN_PER_SEASON} are needed to see the rest of the year.`
    );
  }
  const newest = observed.reduce((a, m) => (m.newest > a ? m.newest : a), observed[0]!.newest);
  const ageDays = Math.floor((startOfDayUTC(input.now).getTime() - startOfDayUTC(newest).getTime()) / DAY_MS);
  if (ageDays > ELECTRIC_GATE_FRESH_DAYS) {
    return gated(
      `The newest ${supplier} payment found is from ${dayKey(newest)}, more than ${ELECTRIC_GATE_FRESH_DAYS} days ago, so the history may have stopped being recorded.`
    );
  }
  const fit = fitProfile(observed) as Profile;
  const confidence = electricConfidence(observed);
  const backtest = leaveOneOut(observed, input.flatMonthly);
  const paymentCount = observed.reduce((n, m) => n + m.payments, 0);
  const first = observed[0]!.period;
  const last = observed[observed.length - 1]!.period;
  // The twelve rounded months added up, so the headline and the table always agree to the cent.
  const annual = sum(fit.months.map((m) => cents2(m.amount)));

  const parts: string[] = [];
  parts.push(
    `Net dollars paid to ${supplier}: ${paymentCount} payment${paymentCount === 1 ? "" : "s"} in ${observed.length} different months (${monthYearLabel(first)} to ${monthYearLabel(last)}), read across all accounts.`
  );
  parts.push(
    `Months from November to March averaged ${usd(cents2(fit.heatingMean))} and April to October ${usd(cents2(fit.otherMean))}. A month with a payment of its own leans half on it and half on its season average; a month with none seen (not zero) uses the season average. The range is the lowest and highest month actually seen in that season.`
  );
  parts.push("These are payments, not usage: a bill is usually paid after the month it covers, and a month with no payment found is unknown, not free.");
  if (input.site?.solarLiveFrom) {
    parts.push(
      `This house has solar (live since ${monthYearLabel(input.site.solarLiveFrom)}), so the bills are net of what the panels generate: a very low or credit month is real data and is kept, and only payments from ${monthYearLabel(input.site.solarLiveFrom)} on are used.`
    );
  }
  if (input.site?.rentalSince) {
    parts.push(
      `This property has been a short-term rental since ${monthYearLabel(input.site.rentalSince)}, so occupancy changes use; it is modelled from its own payments only and the Personal house's pattern is not assumed.`
    );
  }
  if (backtest) {
    const flat = backtest.flatMiss !== null && input.flatMonthly !== null ? ` (a flat ${usd(input.flatMonthly)} would have missed by ${usd(cents2(backtest.flatMiss))})` : "";
    parts.push(
      `Check against your own history: predicting each of ${backtest.months} months from the others missed by about ${usd(cents2(backtest.modelMiss))} on average${flat}.`
    );
  }
  parts.push(
    confidence === "low"
      ? "Low confidence: not every calendar month has been seen yet, so the season averages carry most of the weight."
      : confidence === "medium"
        ? "Medium confidence: every calendar month has been seen at least once."
        : "Higher confidence: every calendar month has been seen at least twice."
  );

  return {
    status: "estimate",
    kind: "electric",
    months: fit.months.map((m) => ({ ...m, amount: cents2(m.amount), low: cents2(m.low), high: cents2(m.high) })),
    annual: cents2(annual),
    confidence,
    basis: parts.join(" "),
    shortBasis: `Seasonal estimate from ${paymentCount} ${supplier} payments in ${observed.length} months (${confidence} confidence)`,
    heatingMean: fit.heatingMean,
    otherMean: fit.otherMean,
    observedMonths: observed.length,
    paymentCount,
    backtest,
  };
}

// ── Oil ─────────────────────────────────────────────────────────────────────────

export interface OilPaymentFact {
  id: string;
  date: string;
  amount: Decimal;
  account: string | null;
  fromOtherEntity: string | null;
  /** True when the amount matches a charge the owner confirmed is not a delivery (the yearly furnace service). */
  service: boolean;
  /** True when the owner marked this row "not heating oil": left out of every figure. */
  excluded: boolean;
  tags: string[];
  /** True while the bank row is pending: a mark on it carries over to the posted row. */
  pending: boolean;
  /** Why this row is unconfirmed (it looks like it may not be oil); empty = nothing odd. Never set for service / excluded rows. */
  checkWhy: string[];
}

/** A payment further than this share of the median payment (below) or this multiple of it (above) is listed to check. */
export const OIL_CHECK_LOW = 0.25;
/** A payment within this share of a known service amount (but not equal to it) is listed to check. */
export const OIL_SERVICE_NEAR = 0.2;
export const OIL_CHECK_HIGH = 3;

export interface OilFactsOptions {
  /** Transaction ids the owner marked "not heating oil". */
  excludedIds?: ReadonlySet<string>;
  /** Full tag path of the site's Oil budget line (a McCarthy row tagged anything else is listed to check). */
  oilTagName?: string | null;
}

export interface OilFacts {
  /** Payments in the last 12 months, newest first (service and marked rows included, flagged). */
  payments: OilPaymentFact[];
  /** The rows every oil figure is built from: not service, not marked "not heating oil". */
  counted: OilPaymentFact[];
  /** Counted rows that look like they may not be heating oil (unconfirmed), see checkWhy. */
  check: OilPaymentFact[];
  /** Rows the owner marked "not heating oil". */
  excluded: OilPaymentFact[];
  /** Deliveries and other payments, service charges left out, as paid. */
  trailingAsPaid: Decimal;
  /** Number of payments counted in trailingAsPaid. */
  trailingCount: number;
  /** The confirmed service charge, when it was paid in the history. */
  service: { label: string; amount: Decimal; dates: string[] } | null;
  /** Payments counted in the figures that sit on another entity's books (charged to the wrong card). */
  otherEntityCount: number;
  /** Every payment in the window read from another entity's books, counted or not (service and marked rows too). */
  otherEntityRows: number;
  windowFrom: string;
  windowTo: string;
}

export function isServiceCharge(amount: Decimal, site: EnergySiteFacts | null): ServiceCharge | null {
  if (!site) return null;
  const cents = amount.abs().times(100).toDecimalPlaces(0);
  for (const s of site.serviceCharges) if (cents.equals(s.cents)) return s;
  return null;
}

function medianOf(values: readonly Decimal[]): Decimal {
  const s = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as Decimal) : (s[mid - 1] as Decimal).plus(s[mid] as Decimal).div(2);
}

export function oilFacts(payments: readonly EnergyPayment[], now: Date, site: EnergySiteFacts | null, opts: OilFactsOptions = {}): OilFacts {
  const today = startOfDayUTC(now);
  const from = new Date(today.getTime() - 365 * DAY_MS);
  const inWindow = payments
    .filter((p) => p.date > from && startOfDayUTC(p.date) <= today)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  const facts: OilPaymentFact[] = inWindow.map((p) => ({
    id: p.id,
    date: dayKey(p.date),
    amount: p.amount.negated(),
    account: p.account,
    fromOtherEntity: p.fromOtherEntity,
    service: isServiceCharge(p.amount, site) !== null,
    excluded: opts.excludedIds?.has(p.id) ?? false,
    tags: [...(p.tagPaths ?? [])],
    pending: p.pending ?? false,
    checkWhy: [],
  }));
  const counted = facts.filter((f) => !f.service && !f.excluded);
  // Unconfirmed rows: a tag other than the Oil line's, or an amount far from the typical payment. Tags are NOT trusted
  // to classify a McCarthy row; these rows stay counted until the owner marks them, and are listed so he can.
  if (counted.length > 0) {
    // A charge close to (but not exactly) the owner-confirmed yearly service amount may be next year's service at a new
    // price. The service rule itself is an EXACT-cents match, so this is what keeps such a row from being silently counted as oil.
    for (const f of counted) {
      for (const s of site?.serviceCharges ?? []) {
        const diff = f.amount.times(100).minus(s.cents).abs();
        if (diff.greaterThan(0) && diff.lessThanOrEqualTo(new Decimal(s.cents).times(OIL_SERVICE_NEAR))) {
          f.checkWhy.push(`close to the ${s.label} amount (${usd(new Decimal(s.cents).div(100))}); it may be the next ${s.label}, not oil`);
        }
      }
    }
    const med = counted.length >= 3 ? medianOf(counted.map((f) => f.amount)) : null;
    for (const f of counted) {
      if (opts.oilTagName && !f.tags.includes(opts.oilTagName)) {
        f.checkWhy.push(f.tags.length === 0 ? `not tagged ${opts.oilTagName}` : `tagged ${f.tags.join(", ")}, not ${opts.oilTagName}`);
      }
      if (med !== null && med.greaterThan(0)) {
        if (f.amount.lessThan(med.times(OIL_CHECK_LOW))) f.checkWhy.push(`far below the typical payment (median ${usd(cents2(med))})`);
        else if (f.amount.greaterThan(med.times(OIL_CHECK_HIGH))) f.checkWhy.push(`far above the typical payment (median ${usd(cents2(med))})`);
      }
    }
  }
  const serviceFacts = facts.filter((f) => f.service);
  const svc = serviceFacts.length > 0 ? isServiceCharge(serviceFacts[0]!.amount.negated(), site) : null;
  return {
    payments: facts,
    counted,
    check: counted.filter((f) => f.checkWhy.length > 0),
    excluded: facts.filter((f) => f.excluded),
    trailingAsPaid: sum(counted.map((f) => f.amount)),
    trailingCount: counted.length,
    service: svc ? { label: svc.label, amount: serviceFacts[0]!.amount, dates: serviceFacts.map((f) => f.date).reverse() } : null,
    otherEntityCount: counted.filter((f) => f.fromOtherEntity !== null).length,
    otherEntityRows: facts.filter((f) => f.fromOtherEntity !== null).length,
    windowFrom: dayKey(new Date(from.getTime() + DAY_MS)),
    windowTo: dayKey(today),
  };
}

export interface OilEstimate {
  status: "estimate";
  kind: "oil";
  /** Dollars a month, the same for every month (payments do not show gallons, so no winter peak is claimed). */
  monthly: Decimal;
  low: Decimal;
  high: Decimal;
  annual: Decimal;
  confidence: Confidence;
  basis: string;
  shortBasis: string;
  price: { pricePerGal: string; effectiveOn: string };
  /** Gallons the last 12 months of payments imply at the prices in force when they were paid. */
  impliedGallons: Decimal;
  /** Extra dollars over those 12 months of use for each +$0.50 per gallon. */
  sensitivity: Decimal;
}

export interface OilInput {
  payments: readonly EnergyPayment[];
  entries: readonly OilPriceEntry[];
  now: Date;
  site: EnergySiteFacts | null;
  excludedIds?: ReadonlySet<string>;
  oilTagName?: string | null;
}

export function oilEstimate(input: OilInput): OilEstimate | Gated {
  const gated = (reason: string): Gated => ({ status: "gated", kind: "oil", reason });
  const facts = oilFacts(input.payments, input.now, input.site, { excludedIds: input.excludedIds, oilTagName: input.oilTagName });
  const counted = facts.counted;
  if (counted.length === 0) {
    return gated("No heating-oil payments were found in the last 12 months, so there is nothing to estimate from.");
  }
  const today = dayKey(startOfDayUTC(input.now));
  const active = activeOilPrices(input.entries).filter((e) => e.effectiveOn <= today);
  if (active.length < 2) {
    return gated(
      `${active.length === 0 ? "No heating-oil price has been entered" : "Only one heating-oil price has been entered"}. The monthly estimate needs at least two prices at least ${OIL_PRICE_MIN_GAP_MONTHS} months apart (for example what you paid per gallon last winter and the price now), because the payments do not show gallons.`
    );
  }
  const first = active[0] as OilPriceEntry;
  const latest = active[active.length - 1] as OilPriceEntry;
  if (latest.effectiveOn < addMonthsIso(first.effectiveOn, OIL_PRICE_MIN_GAP_MONTHS)) {
    return gated(
      `The entered prices are less than ${OIL_PRICE_MIN_GAP_MONTHS} months apart (${first.effectiveOn} to ${latest.effectiveOn}); the estimate needs a price from at least ${OIL_PRICE_MIN_GAP_MONTHS} months before the latest one.`
    );
  }
  const uncovered = counted.filter((p) => priceOn(active, p.date) === null);
  if (uncovered.length > 0) {
    const oldest = uncovered[uncovered.length - 1] as OilPaymentFact;
    return gated(
      `${uncovered.length} payment${uncovered.length === 1 ? " is" : "s are"} older than your first price entry (${first.effectiveOn}), so ${uncovered.length === 1 ? "it" : "they"} cannot be restated at today's price. Enter the price in force on or before ${oldest.date}.`
    );
  }

  const pNow = new Decimal(latest.pricePerGal);
  let adjusted = ZERO;
  let gallons = ZERO;
  for (const p of counted) {
    const pAt = new Decimal((priceOn(active, p.date) as OilPriceEntry).pricePerGal);
    adjusted = adjusted.plus(p.amount.times(pNow).div(pAt));
    gallons = gallons.plus(p.amount.div(pAt));
  }
  const asPaid = facts.trailingAsPaid;
  const annual = cents2(adjusted);
  const monthly = cents2(adjusted.div(12));
  const a = cents2(asPaid.div(12));
  const low = monthly.lessThan(a) ? monthly : a;
  const high = monthly.greaterThan(a) ? monthly : a;
  const sensitivity = cents2(gallons.times(OIL_SENSITIVITY_STEP));

  const parts: string[] = [];
  parts.push(
    `McCarthy payments over the last 12 months (${facts.windowFrom} to ${facts.windowTo}): ${counted.length} payment${counted.length === 1 ? "" : "s"} totalling ${usd(cents2(asPaid))} as paid.`
  );
  if (facts.service) {
    parts.push(`The ${facts.service.label} (${usd(facts.service.amount)}) is left out: it is a yearly item, not oil.`);
  }
  parts.push(
    `Each payment is restated at today's price (${usd(pNow)} a gallon, in force since ${latest.effectiveOn}, entered by you) using the price in force when it was paid, which gives ${usd(annual)} for a year, or ${usd(monthly)} a month. The range runs from the as-paid figure to the restated one.`
  );
  parts.push("Prices between your entries are assumed unchanged until the next entry, so two entries a long way apart are not a measured trend.");
  parts.push(
    "It is spread evenly over the year because the payments do not show gallons or when the oil is burned, so no winter peak is claimed. Deliveries are lumpy: a 12-month window can hold two fall fills or none, so treat this as a rough guide."
  );
  if (facts.otherEntityCount > 0) {
    parts.push(
      `${facts.otherEntityCount} of the payments sit on another entity's books (charged to the wrong card by mistake); they are read here by payee and nothing was changed or moved.`
    );
  }
  if (facts.excluded.length > 0) {
    parts.push(`${facts.excluded.length} McCarthy charge${facts.excluded.length === 1 ? "" : "s"} you marked "not heating oil" ${facts.excluded.length === 1 ? "is" : "are"} left out.`);
  }
  if (facts.check.length > 0) {
    parts.push(
      `${facts.check.length} of the ${counted.length} payments counted ${facts.check.length === 1 ? "is" : "are"} unconfirmed (${facts.check.length === 1 ? "it looks" : "they look"} like ${facts.check.length === 1 ? "it" : "they"} may not be heating oil: see "Check these McCarthy charges"); ${facts.check.length === 1 ? "it is" : "they are"} counted until you mark ${facts.check.length === 1 ? "it" : "them"} "not heating oil".`
    );
  }
  parts.push("Low confidence.");

  return {
    status: "estimate",
    kind: "oil",
    monthly,
    low,
    high,
    annual,
    confidence: "low",
    basis: parts.join(" "),
    shortBasis: `Heating-oil estimate from ${counted.length} McCarthy payments restated at today's price (low confidence)`,
    price: { pricePerGal: latest.pricePerGal, effectiveOn: latest.effectiveOn },
    impliedGallons: gallons.toDecimalPlaces(0),
    sensitivity,
  };
}

// ── Firewood ────────────────────────────────────────────────────────────────────

export interface FirewoodFacts {
  purchases: { id: string; date: string; amount: Decimal; account: string | null }[];
  /** Distinct heating seasons (July to June) with a purchase. */
  seasons: number;
}

export function heatingSeasonOf(d: Date): number {
  return d.getUTCMonth() + 1 >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

export function firewoodFacts(payments: readonly EnergyPayment[], now: Date): FirewoodFacts {
  const today = startOfDayUTC(now);
  const rows = payments
    .filter((p) => startOfDayUTC(p.date) <= today)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  return {
    purchases: rows.map((p) => ({ id: p.id, date: dayKey(p.date), amount: p.amount.negated(), account: p.account })),
    seasons: new Set(rows.map((p) => heatingSeasonOf(p.date))).size,
  };
}

/**
 * Firewood stays on its budget and the owner's hand-entered draws in this version: it is bought in a few loads, so a
 * monthly estimate would need at least two heating seasons of purchases and the owner's quantities. Always gated.
 */
export function firewoodResult(facts: FirewoodFacts): Gated {
  const reason =
    facts.purchases.length === 0
      ? "No firewood purchases were found in the books; the budget line and your entered draws are used."
      : `${facts.purchases.length} purchase${facts.purchases.length === 1 ? "" : "s"} in ${facts.seasons} heating season${facts.seasons === 1 ? "" : "s"} found. Firewood is bought in a few loads, so it stays on its budget line and your entered draws; a seasonal estimate needs at least two heating seasons of purchases.`;
  return { status: "gated", kind: "firewood", reason };
}

// ── Plans (what the forecast, ledger, pace and assistant consume) ───────────────

export interface BillSeasonalPlan {
  kind: "electric" | "oil";
  entityId: string;
  /** `${entityId}|${tagId}` of the Budget line this plan belongs to. */
  lineKey: string;
  lineLabel: string;
  /** Outflow dollars by calendar month, index 0 = January; null = no outflow estimate for that month. Rounded to cents. */
  monthly: ReadonlyArray<Decimal | null>;
  confidence: Confidence;
  basis: string;
  shortBasis: string;
  /** Owner opt-in (default off): replace hand-entered accrual draws in forecasts (the draws stay in the database). */
  replaceDraws: boolean;
}

const PAYEE_PATTERNS: Record<EnergyKind, RegExp> = {
  electric: /eversource/i,
  oil: /mccarthy[\s\S]*(heating|oil)|(heating|oil)[\s\S]*mccarthy/i,
  firewood: /firewood/i,
};

export function payeeKindOf(payee: string): EnergyKind | null {
  for (const kind of ["electric", "oil", "firewood"] as const) if (PAYEE_PATTERNS[kind].test(payee)) return kind;
  return null;
}

/** Which of the three kinds a budget tag path stands for, or null. */
export function lineKindOfTag(tagPath: string): EnergyKind | null {
  if (/firewood/i.test(tagPath)) return "firewood";
  if (/electric|eversource/i.test(tagPath)) return "electric";
  if (/(^|[\s/])oil$/i.test(tagPath.trim())) return "oil";
  return null;
}

export function monthlyFromEstimate(months: readonly MonthEstimate[]): Array<Decimal | null> {
  const out: Array<Decimal | null> = new Array(12).fill(null);
  for (const m of months) out[m.month - 1] = m.amount.greaterThan(0) ? cents2(m.amount) : null;
  return out;
}

/** The plan's outflow for a calendar date's month, or null. */
export function planAmountFor(plan: BillSeasonalPlan, date: Date): Decimal | null {
  return plan.monthly[date.getUTCMonth()] ?? null;
}

/** The plan of a Budget line (entity + tag), or null: the Category Spend Pace and the assistant look a line up this way. */
export function planForLine(plans: readonly BillSeasonalPlan[] | null | undefined, entityId: string, tagId: string): BillSeasonalPlan | null {
  if (!plans) return null;
  return plans.find((p) => p.lineKey === `${entityId}|${tagId}`) ?? null;
}

/**
 * One sentence for a Budget notification (overspend / pace) about where its figure comes from: a budget carried forward
 * from an earlier month, and/or, on a seasonal line whose model gate has passed, the seasonal card's estimate for the month.
 * Empty when neither applies. Observational; the estimate is labelled as one.
 */
export function budgetAlertNote(carriedFrom: string | null | undefined, plan: BillSeasonalPlan | null, month: number): string {
  const parts: string[] = [];
  if (carriedFrom) parts.push(`Based on a budget carried forward from ${carriedFrom}.`);
  const amount = plan ? planAmountForMonth(plan, month) : null;
  if (plan && amount) {
    parts.push(`The Seasonal bills card expects about ${usd(amount)} for this month (estimate, ${plan.confidence} confidence), which is a different amount from the budget figure.`);
  }
  return parts.join(" ");
}

/** The plan's estimate for a calendar month (1 to 12), or null when there is none (or the estimate is not an outflow). */
export function planAmountForMonth(plan: BillSeasonalPlan, month: number): Decimal | null {
  return plan.monthly[month - 1] ?? null;
}

export interface PlanBillRef {
  entityId?: string | null;
  budgetTagId?: string | null;
  budgetEntityId?: string | null;
  payee: string;
}

/** True when a scheduled bill belongs to a seasonal line: by Budget link, else (no link at all) own entity + supplier payee. */
export function billMatchesLine(bill: PlanBillRef, line: { entityId: string; tagId: string; kind: EnergyKind }): boolean {
  if (bill.budgetTagId) return `${bill.budgetEntityId ?? bill.entityId ?? ""}|${bill.budgetTagId}` === `${line.entityId}|${line.tagId}`;
  return bill.entityId === line.entityId && payeeKindOf(bill.payee) === line.kind;
}

/**
 * The plan that applies to a scheduled bill: by its Budget link first; a bill with no Budget link at all (Sudden
 * Valley's Eversource / McCarthy bills today) matches on its own entity and a payee that names the supplier. Never
 * across entities.
 */
export function planForBill(plans: readonly BillSeasonalPlan[] | null | undefined, bill: PlanBillRef): BillSeasonalPlan | null {
  if (!plans || plans.length === 0) return null;
  if (bill.budgetTagId) {
    const key = `${bill.budgetEntityId ?? bill.entityId ?? ""}|${bill.budgetTagId}`;
    return plans.find((p) => p.lineKey === key) ?? null;
  }
  if (!bill.entityId) return null;
  const kind = payeeKindOf(bill.payee);
  if (kind === null) return null;
  return plans.find((p) => p.entityId === bill.entityId && p.kind === kind) ?? null;
}

// ── Raw transactions to payments, per site ──────────────────────────────────────

export interface EnergyEntityRef {
  id: string;
  name: string;
  slug: string | null;
}

/** A transaction as the loader reads it. */
export interface RawEnergyTx {
  id: string;
  date: Date;
  amount: Decimal;
  entityId: string;
  /** payeeNormalized, else payeeRaw, else description. */
  payee: string;
  account: string | null;
  /** Full tag paths. */
  tagPaths: readonly string[];
  /** The ONE bank descriptor a mark compares (payeeNormalized, else payeeRaw, else description). */
  descriptor?: string;
  /** Internal account id (part of a mark's durable signature). */
  accountId?: string;
  /** True while the bank row is pending. */
  pending?: boolean;
}

export interface SeasonalLineRef {
  entityId: string;
  tagId: string;
  /** Full tag path. */
  tagName: string;
  kind: EnergyKind;
}

export interface SitePayments {
  electric: EnergyPayment[];
  oil: EnergyPayment[];
  firewood: EnergyPayment[];
}

/**
 * Which transactions count for which line of ONE site (entity). Payee decides the kind first (Eversource, McCarthy
 * heating oil, firewood); a transaction with none of those payees counts through its tag. Own-entity rows are read
 * for every kind; ANOTHER entity's rows are read only for oil, only by a McCarthy payee, and only for the entities the
 * owner named for this site (site facts). Sudden Valley therefore never receives anything from another entity.
 */
export function selectSitePayments(
  txs: readonly RawEnergyTx[],
  entity: EnergyEntityRef,
  lines: readonly SeasonalLineRef[],
  entities: readonly EnergyEntityRef[]
): SitePayments {
  const site = siteFactsFor(entity.slug);
  const lineKinds = new Set(lines.filter((l) => l.entityId === entity.id).map((l) => l.kind));
  const tagKind = new Map<string, EnergyKind>();
  for (const l of lines) if (l.entityId === entity.id) tagKind.set(l.tagName, l.kind);
  const otherSlugs = new Set(site?.oilFromEntitySlugs ?? []);
  const slugById = new Map(entities.map((e) => [e.id, e]));
  const out: SitePayments = { electric: [], oil: [], firewood: [] };

  for (const tx of txs) {
    const payeeKind = payeeKindOf(tx.payee);
    if (tx.entityId === entity.id) {
      let kind: EnergyKind | null = payeeKind;
      if (kind === null) {
        for (const t of tx.tagPaths) {
          const k = tagKind.get(t);
          if (k) {
            kind = k;
            break;
          }
        }
      }
      if (kind === null || !lineKinds.has(kind)) continue;
      out[kind].push({ id: tx.id, date: tx.date, amount: tx.amount, payee: tx.payee, account: tx.account, fromOtherEntity: null, tagPaths: tx.tagPaths, descriptor: tx.descriptor, accountId: tx.accountId, pending: tx.pending });
      continue;
    }
    if (payeeKind !== "oil" || !lineKinds.has("oil")) continue;
    const owner = slugById.get(tx.entityId);
    if (!owner?.slug || !otherSlugs.has(owner.slug)) continue;
    out.oil.push({ id: tx.id, date: tx.date, amount: tx.amount, payee: tx.payee, account: tx.account, fromOtherEntity: owner.name, tagPaths: tx.tagPaths, descriptor: tx.descriptor, accountId: tx.accountId, pending: tx.pending });
  }
  for (const k of ["electric", "oil", "firewood"] as const) out[k].sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

// ── One site, end to end ────────────────────────────────────────────────────────

/** A hand-entered accrual draw (an AccrualDraw of the line's bill), for display next to the estimate. */
export interface DrawFact {
  /** YYYY-MM-DD */
  date: string;
  amount: Decimal;
}

export interface SiteEnergyInput {
  entity: EnergyEntityRef;
  lines: readonly SeasonalLineRef[];
  txs: readonly RawEnergyTx[];
  entities: readonly EnergyEntityRef[];
  /** All stored price entries for this entity (removed ones included, for the list). */
  priceEntries: readonly OilPriceEntry[];
  /** Flat monthly figure per kind from the Budget line (carried), for comparison. */
  flatMonthly: Partial<Record<EnergyKind, Decimal | null>>;
  replaceDraws: boolean;
  /** Hand-entered draws of each line's accrued bill, oldest first (display only; the model never changes them). */
  draws?: Partial<Record<EnergyKind, DrawFact[]>>;
  /** McCarthy transaction ids the owner marked "not heating oil" for this site. */
  excludedOilIds?: ReadonlySet<string>;
  /** The stored "not heating oil" marks (id + durable signature): resolved against the current rows, so a posted twin inherits a mark. */
  oilMarks?: readonly OilMark[];
  now: Date;
}

export interface SiteEnergy {
  entityId: string;
  entityName: string;
  slug: string | null;
  lines: SeasonalLineRef[];
  electric: null | { history: MonthTotal[]; result: ElectricEstimate | Gated; line: SeasonalLineRef; flat: Decimal | null };
  oil: null | { facts: OilFacts; result: OilEstimate | Gated; line: SeasonalLineRef; flat: Decimal | null; entries: OilPriceEntry[]; draws: DrawFact[] };
  firewood: null | { facts: FirewoodFacts; result: Gated; line: SeasonalLineRef; flat: Decimal | null; draws: DrawFact[] };
  replaceDraws: boolean;
  plans: BillSeasonalPlan[];
  /** Notes to show once for the site (owner statements that shape the model). */
  siteNotes: string[];
}

function lineLabel(tagName: string): string {
  const i = tagName.lastIndexOf("/");
  return (i >= 0 ? tagName.slice(i + 1) : tagName).trim();
}

export function buildSiteEnergy(input: SiteEnergyInput): SiteEnergy {
  const { entity, now } = input;
  const site = siteFactsFor(entity.slug);
  const lines = input.lines.filter((l) => l.entityId === entity.id);
  const pay = selectSitePayments(input.txs, entity, lines, input.entities);
  const plans: BillSeasonalPlan[] = [];
  const result: SiteEnergy = {
    entityId: entity.id,
    entityName: entity.name,
    slug: entity.slug,
    lines,
    electric: null,
    oil: null,
    firewood: null,
    replaceDraws: input.replaceDraws,
    plans,
    siteNotes: [],
  };

  const electricLine = lines.find((l) => l.kind === "electric");
  if (electricLine) {
    const flat = input.flatMonthly.electric ?? null;
    const history = observedMonths(pay.electric, now, site?.solarLiveFrom ?? null);
    const est = electricEstimate({ payments: pay.electric, now, site, flatMonthly: flat });
    result.electric = { history, result: est, line: electricLine, flat };
    if (est.status === "estimate") {
      plans.push({
        kind: "electric",
        entityId: entity.id,
        lineKey: `${electricLine.entityId}|${electricLine.tagId}`,
        lineLabel: lineLabel(electricLine.tagName),
        monthly: monthlyFromEstimate(est.months),
        confidence: est.confidence,
        basis: est.basis,
        shortBasis: est.shortBasis,
        replaceDraws: input.replaceDraws,
      });
    }
  }

  const oilLine = lines.find((l) => l.kind === "oil");
  if (oilLine) {
    const flat = input.flatMonthly.oil ?? null;
    const excludedIds = new Set(input.excludedOilIds ?? []);
    if (input.oilMarks && input.oilMarks.length > 0) {
      const rows: MarkRow[] = pay.oil.flatMap((p) => (p.accountId ? [{ id: p.id, accountId: p.accountId, amount: p.amount, payee: p.descriptor ?? p.payee, date: p.date }] : []));
      for (const id of resolveMarks(input.oilMarks, rows).excludedIds) excludedIds.add(id);
      for (const m of input.oilMarks) if (pay.oil.some((p) => p.id === m.id)) excludedIds.add(m.id); // a mark on a row without an account id still works by id
    }
    const est = oilEstimate({ payments: pay.oil, entries: input.priceEntries, now, site, excludedIds, oilTagName: oilLine.tagName });
    result.oil = { facts: oilFacts(pay.oil, now, site, { excludedIds, oilTagName: oilLine.tagName }), result: est, line: oilLine, flat, entries: [...input.priceEntries], draws: input.draws?.oil ?? [] };
    if (est.status === "estimate") {
      plans.push({
        kind: "oil",
        entityId: entity.id,
        lineKey: `${oilLine.entityId}|${oilLine.tagId}`,
        lineLabel: lineLabel(oilLine.tagName),
        monthly: new Array<Decimal | null>(12).fill(est.monthly),
        confidence: est.confidence,
        basis: est.basis,
        shortBasis: est.shortBasis,
        replaceDraws: input.replaceDraws,
      });
    }
  }

  const woodLine = lines.find((l) => l.kind === "firewood");
  if (woodLine) {
    const facts = firewoodFacts(pay.firewood, now);
    result.firewood = { facts, result: firewoodResult(facts), line: woodLine, flat: input.flatMonthly.firewood ?? null, draws: input.draws?.firewood ?? [] };
  }

  if (site?.solarLiveFrom) {
    result.siteNotes.push(
      `This house has solar (live since ${monthYearLabel(site.solarLiveFrom)}), so electric bills are net of generation and are modelled in net dollars; a credit or near-zero bill is kept as real data.`
    );
  }
  if (site?.rentalSince) {
    result.siteNotes.push(
      `This property has been a short-term rental since ${monthYearLabel(site.rentalSince)}; occupancy changes use, so its history is its own and is never combined with another property's.`
    );
  }
  if (result.oil && result.oil.facts.otherEntityRows > 0) {
    result.siteNotes.push(
      "Some McCarthy oil payments for this house were charged to another entity's card by mistake. They are read into this house's oil history by payee, labelled below, and no transaction was changed or moved. A personal expense paid from a business card has bookkeeping and tax implications to review at tax time; that is not decided here."
    );
  }
  return result;
}
