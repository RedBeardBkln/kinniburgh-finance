// Usage-based seasonal models (utility-usage-upload, seasonal energy step 3): the owner's uploaded monthly kWh, oil
// gallons and firewood purchases give the three bills a real seasonal shape and a quantity base. Pure: no database, no
// clock (callers pass `now`), no Next.js. It imports only TYPES from lib/seasonal-energy.ts (which calls these functions),
// so there is no import cycle; it carries its own few formatting helpers.
//
// Contract (same as the payments models): every function returns EITHER an estimate (amount, range, confidence, a plain
// basis) OR a gate reason and NO number. Nothing is invented: a $/kWh appears only when measured from paired kWh + dollar
// rows; an oil price is the owner's entry, else the price of his newest delivery that had an amount (labelled); firewood
// needs the amounts. All money is Decimal and rounded to cents once, at the end.
//
// Shared pieces (plan section 5): `smooth3` spreads a monthly vector over its neighbours, circularly (Dec wraps to Jan),
// preserving the sum, because deliveries are lumpy and burning is not; the latest MAX_YEARS_USED values of a calendar month
// (or window) are used.

import { Decimal } from "@prisma/client/runtime/library";
import { activeOilPrices, type OilPriceEntry } from "@/lib/seasonal-energy-prices";
import type {
  Confidence,
  ElectricEstimate,
  EnergyKind,
  EnergySiteFacts,
  FirewoodEstimate,
  FirewoodSeasonFact,
  Gated,
  MonthEstimate,
  OilEstimate,
} from "@/lib/seasonal-energy";

/** Whether the UtilityUsage table could be read: ok, not created yet (migration not applied), or a read failure. */
export type UsageStatus = "ok" | "not_set_up" | "failed";

export const MAX_YEARS_USED = 3;
export const USAGE_MAX_AGE_MONTHS = 24;
export const OLS_MIN_PAIRED = 12;
export const OLS_MIN_CALENDAR_MONTHS = 8;
export const OLS_MIN_R2 = 0.5;
export const OLS_HIGH_R2 = 0.8;
const OIL_SENSITIVITY = new Decimal("0.5");

const ZERO = new Decimal(0);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** One uploaded usage row as the models read it (already limited to one entity and one kind by the caller). */
export interface UsageRow {
  id: string;
  kind: EnergyKind;
  /** YYYY-MM */
  period: string;
  /** YYYY-MM-DD */
  occurredOn: string;
  /** kWh | gallons | cords | face cords, per `unit`. */
  quantity: Decimal;
  unit: string;
  /** Dollars billed (from costCents / 100); a credit month may be negative. */
  cost: Decimal | null;
  note: string | null;
}

/** What the Seasonal card says about the rows on file for one line. */
export interface UsageInfo {
  /** Rows on file for this line (all of them, used or not). */
  count: number;
  from: string | null;
  to: string | null;
  unit: string;
  /** True when the usage-based estimate is the one in use. */
  used: boolean;
  /** Why the rows are not used yet (a gate reason); null when used. */
  why: string | null;
  /** Electric only: rows before the solar-live month (kept, not used). */
  ignored: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((a, b) => a.plus(b), ZERO);
}

function mean(values: readonly Decimal[]): Decimal {
  return sum(values).div(values.length);
}

function cents2(d: Decimal): Decimal {
  return d.toDecimalPlaces(2);
}

function usd(d: Decimal): string {
  const neg = d.isNegative() && !d.isZero();
  const [whole = "0", frac = "00"] = d.abs().toFixed(2).split(".");
  return `${neg ? "-" : ""}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

function pIdx(period: string): number {
  return Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7)) - 1;
}

function idxPeriod(i: number): string {
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

function monthOf(period: string): number {
  return Number(period.slice(5, 7));
}

function label(period: string): string {
  return `${MONTHS[monthOf(period) - 1] ?? "?"} ${period.slice(0, 4)}`;
}

function nowPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function fixedVec(): Decimal[] {
  return new Array<Decimal>(12).fill(ZERO);
}

/** Circular 3-month smoothing: s[m] = (v[m-1] + v[m] + v[m+1]) / 3, Dec wrapping to Jan. The sum is preserved. */
export function smooth3(v: readonly Decimal[]): Decimal[] {
  const out: Decimal[] = [];
  for (let m = 0; m < 12; m++) {
    out.push((v[(m + 11) % 12] as Decimal).plus(v[m] as Decimal).plus(v[(m + 1) % 12] as Decimal).div(3));
  }
  return out;
}

/** Summary of the rows on file for a line (the "usage on file" sentence). `ignored` counts electric rows before solar. */
export function usageInfo(rows: readonly UsageRow[], kind: EnergyKind, site: EnergySiteFacts | null): Omit<UsageInfo, "used" | "why"> {
  const periods = rows.map((r) => r.period).sort();
  const solar = kind === "electric" ? (site?.solarLiveFrom ?? null) : null;
  return {
    count: rows.length,
    from: periods[0] ?? null,
    to: periods[periods.length - 1] ?? null,
    unit: kind === "electric" ? "kWh" : kind === "oil" ? "gallons" : (rows[0]?.unit === "face_cord" ? "face cords" : "cords"),
    ignored: solar === null ? 0 : rows.filter((r) => r.period < solar).length,
  };
}

// ── Electric ────────────────────────────────────────────────────────────────────

export interface ElectricUsageInput {
  rows: readonly UsageRow[];
  now: Date;
  site: EnergySiteFacts | null;
  /** The payments model's annual net dollars when it produced an estimate, else null. */
  paymentAnnual: Decimal | null;
  /** Net dollars paid in the last 12 complete months and how many of those months had a payment, for the sanity line. */
  paymentsRecent?: { total: Decimal; months: number } | null;
  supplier?: string;
}

interface OlsFit {
  a: Decimal;
  b: Decimal;
  r2: Decimal;
  se: Decimal;
  n: number;
}

/** Ordinary least squares y = a + b x in Decimal (closed form). null when x has no spread. */
export function olsFit(points: ReadonlyArray<{ x: Decimal; y: Decimal }>): OlsFit | null {
  const n = points.length;
  if (n < 3) return null;
  const sx = sum(points.map((p) => p.x));
  const sy = sum(points.map((p) => p.y));
  const sxx = sum(points.map((p) => p.x.times(p.x)));
  const sxy = sum(points.map((p) => p.x.times(p.y)));
  const den = sxx.times(n).minus(sx.times(sx));
  if (den.isZero()) return null;
  const b = sxy.times(n).minus(sx.times(sy)).div(den);
  const a = sy.minus(b.times(sx)).div(n);
  const ybar = sy.div(n);
  const sse = sum(points.map((p) => p.y.minus(a).minus(b.times(p.x)).pow(2)));
  const sst = sum(points.map((p) => p.y.minus(ybar).pow(2)));
  if (sst.isZero()) return null;
  return { a, b, r2: new Decimal(1).minus(sse.div(sst)), se: sse.div(n - 2).sqrt(), n };
}

interface MonthKwh {
  k: Decimal;
  kMin: Decimal;
  kMax: Decimal;
  years: number;
}

function stepDown(c: Confidence): Confidence {
  return c === "high" ? "medium" : "low";
}

export function electricUsageEstimate(input: ElectricUsageInput): ElectricEstimate | Gated {
  const supplier = input.supplier ?? "Eversource";
  const gated = (reason: string): Gated => ({ status: "gated", kind: "electric", reason });
  const nowP = nowPeriod(input.now);
  const solar = input.site?.solarLiveFrom ?? null;

  // Completed months only, from the solar-live month on; one row per month (the newest listed wins if a month repeats).
  const byPeriod = new Map<string, UsageRow>();
  let dropped = 0;
  for (const r of input.rows) {
    if (r.kind !== "electric") continue;
    if (r.period >= nowP) continue;
    if (solar !== null && r.period < solar) {
      dropped += 1;
      continue;
    }
    byPeriod.set(r.period, r);
  }
  const rows = [...byPeriod.values()].sort((a, b) => (a.period < b.period ? -1 : 1));
  if (rows.length === 0) {
    return gated(
      dropped > 0
        ? `All ${dropped} uploaded kWh month${dropped === 1 ? " is" : "s are"} from before solar went live (${label(solar as string)}), so ${dropped === 1 ? "it is" : "they are"} kept but not used.`
        : "No completed month of kWh is on file yet."
    );
  }
  const have = new Set(rows.map((r) => monthOf(r.period)));
  const missing = MONTHS.filter((_, i) => !have.has(i + 1));
  if (missing.length > 0) {
    return gated(
      `The kWh history is missing ${missing.join(", ")}; all 12 calendar months are needed${solar ? ` (only months from ${label(solar)} on count)` : ""}.`
    );
  }
  const newest = rows[rows.length - 1] as UsageRow;
  if (pIdx(nowP) - pIdx(newest.period) > USAGE_MAX_AGE_MONTHS) {
    return gated(`The newest kWh month on file is ${label(newest.period)}, more than ${USAGE_MAX_AGE_MONTHS} months ago, so the history may be out of date.`);
  }

  // Latest MAX_YEARS_USED values per calendar month.
  const perMonth: MonthKwh[] = [];
  for (let m = 1; m <= 12; m++) {
    const mine = rows.filter((r) => monthOf(r.period) === m).sort((a, b) => (a.period < b.period ? 1 : -1)).slice(0, MAX_YEARS_USED);
    const q = mine.map((r) => r.quantity);
    perMonth.push({
      k: mean(q),
      kMin: q.reduce((a, b) => (b.lessThan(a) ? b : a)),
      kMax: q.reduce((a, b) => (b.greaterThan(a) ? b : a)),
      years: mine.length,
    });
  }
  const nMin = Math.min(...perMonth.map((p) => p.years));
  const nMax = Math.max(...perMonth.map((p) => p.years));

  const parts: string[] = [];
  parts.push(
    `Monthly kWh from your uploaded history: ${rows.length} month${rows.length === 1 ? "" : "s"} (${label(rows[0]!.period)} to ${label(newest.period)}), ${nMin === nMax ? `${nMin} year${nMin === 1 ? "" : "s"}` : `${nMin} to ${nMax} years`} for each calendar month (the latest ${MAX_YEARS_USED} years of a month are averaged).`
  );
  if (dropped > 0 && solar) {
    parts.push(`${dropped} month${dropped === 1 ? "" : "s"} from before solar went live (${label(solar)}) ${dropped === 1 ? "is" : "are"} kept but not used.`);
  }

  // Tier A: measured dollars per kWh from paired months.
  const paired = rows.filter((r) => r.cost !== null);
  const pairedMonths = new Set(paired.map((r) => monthOf(r.period))).size;
  let fit: OlsFit | null = null;
  let fitNote: string | null = null;
  if (paired.length >= OLS_MIN_PAIRED && pairedMonths >= OLS_MIN_CALENDAR_MONTHS) {
    const f = olsFit(paired.map((r) => ({ x: r.quantity, y: r.cost as Decimal })));
    if (f && f.b.greaterThan(0) && f.r2.greaterThanOrEqualTo(OLS_MIN_R2)) fit = f;
    else if (f) fitNote = `The dollar amounts on file did not give a usable price per kWh (slope ${f.b.toFixed(4)}, R2 ${f.r2.toFixed(2)}), so they are not used for a rate.`;
    else fitNote = "The dollar amounts on file did not give a usable price per kWh (the kWh values barely vary), so they are not used for a rate.";
  } else if (paired.length > 0) {
    fitNote = `${paired.length} month${paired.length === 1 ? "" : "s"} have a dollar amount; a measured price per kWh needs ${OLS_MIN_PAIRED} or more paired months covering ${OLS_MIN_CALENDAR_MONTHS} or more calendar months.`;
  }

  let amounts: Decimal[];
  let lows: Decimal[];
  let highs: Decimal[];
  let confidence: Confidence;
  let method: "usage_paired" | "usage_shape";
  if (fit) {
    method = "usage_paired";
    amounts = perMonth.map((p) => fit!.a.plus(fit!.b.times(p.k)));
    lows = perMonth.map((p, i) => {
      const lo = fit!.a.plus(fit!.b.times(p.kMin));
      return p.years === 1 ? Decimal.min(lo, (amounts[i] as Decimal).minus(fit!.se)) : lo;
    });
    highs = perMonth.map((p, i) => {
      const hi = fit!.a.plus(fit!.b.times(p.kMax));
      return p.years === 1 ? Decimal.max(hi, (amounts[i] as Decimal).plus(fit!.se)) : hi;
    });
    confidence = nMin >= 3 ? "high" : nMin === 2 ? "medium" : "low";
    if (fit.r2.lessThan(OLS_HIGH_R2)) confidence = stepDown(confidence);
    parts.push(
      `Dollars: about ${usd(cents2(fit.a))} a month fixed plus $${fit.b.toFixed(4)} per kWh, measured from ${fit.n} paired months of your own bills (R2 ${fit.r2.toFixed(2)}); each month is that line at its average kWh.${nMin === 1 ? ` A month with only one year of kWh is shown with a range of about ${usd(cents2(fit.se))} either way.` : ""}`
    );
  } else {
    method = "usage_shape";
    if (input.paymentAnnual === null) {
      return gated(
        `${rows.length} months of kWh are on file and give the shape, but the dollars are unknown: add the bill amount to the rows (${OLS_MIN_PAIRED} or more months), or wait for ${6} months of ${supplier} payments.${fitNote ? ` ${fitNote}` : ""}`
      );
    }
    const total = sum(perMonth.map((p) => p.k));
    if (!total.greaterThan(0)) return gated("The uploaded kWh values add up to zero, so they cannot give a shape.");
    amounts = perMonth.map((p) => input.paymentAnnual!.times(p.k).div(total));
    lows = perMonth.map((p) => input.paymentAnnual!.times(p.kMin).div(total));
    highs = perMonth.map((p) => input.paymentAnnual!.times(p.kMax).div(total));
    confidence = nMin >= 2 ? "medium" : "low";
    parts.push(
      `Dollars: your ${supplier} payments imply about ${usd(cents2(input.paymentAnnual))} a year, and this spreads that over the months in proportion to kWh. It assumes the bill moves in proportion to kWh (a fixed monthly charge is not separated); add the dollar amounts to measure it.`
    );
    if (fitNote) parts.push(fitNote);
  }

  const months: MonthEstimate[] = perMonth.map((p, i) => ({
    month: i + 1,
    amount: cents2(amounts[i] as Decimal),
    low: cents2(Decimal.min(lows[i] as Decimal, amounts[i] as Decimal)),
    high: cents2(Decimal.max(highs[i] as Decimal, amounts[i] as Decimal)),
    ownObservations: p.years,
    basis: "usage",
  }));
  const annual = sum(months.map((m) => m.amount));
  if (input.paymentsRecent && input.paymentsRecent.months > 0) {
    parts.push(
      `Check: payments in the last 12 months were ${usd(cents2(input.paymentsRecent.total))} (${input.paymentsRecent.months} of 12 months had a payment); this estimate for a full year is ${usd(annual)}.`
    );
  }
  parts.push("The estimate is by month of use; a bill is usually paid in the same or the next month, so the cash can land a month later.");
  parts.push(
    confidence === "high"
      ? "Higher confidence: three years of each month and a measured rate."
      : confidence === "medium"
        ? "Medium confidence."
        : "Low confidence: thin history (one year of some months) or an unmeasured rate."
  );
  const heat = months.filter((m) => [11, 12, 1, 2, 3].includes(m.month)).map((m) => m.amount);
  const other = months.filter((m) => ![11, 12, 1, 2, 3].includes(m.month)).map((m) => m.amount);
  return {
    status: "estimate",
    kind: "electric",
    method,
    months,
    annual,
    confidence,
    basis: parts.join(" "),
    shortBasis: `Seasonal estimate from ${rows.length} months of uploaded kWh (${confidence} confidence)`,
    heatingMean: mean(heat),
    otherMean: mean(other),
    observedMonths: rows.length,
    paymentCount: 0,
    backtest: null,
  };
}

// ── Oil ─────────────────────────────────────────────────────────────────────────

export interface OilUsageInput {
  rows: readonly UsageRow[];
  entries: readonly OilPriceEntry[];
  now: Date;
  /** Heating-oil payments over the last 12 months as paid (service charge left out), for the sanity line. */
  paymentsAsPaid?: { total: Decimal; count: number } | null;
}

export function oilUsageEstimate(input: OilUsageInput): OilEstimate | Gated {
  const gated = (reason: string): Gated => ({ status: "gated", kind: "oil", reason });
  const rows = input.rows.filter((r) => r.kind === "oil");
  if (rows.length === 0) return gated("No oil deliveries are on file.");
  const nowP = nowPeriod(input.now);
  const last = pIdx(nowP) - 1; // last complete month
  const firstIdx = Math.min(...rows.map((r) => pIdx(r.period)));
  const gallons = new Map<number, Decimal>();
  for (const r of rows) gallons.set(pIdx(r.period), (gallons.get(pIdx(r.period)) ?? ZERO).plus(r.quantity));

  // Windows of 12 months ending at the last complete month; a window is complete only from the first listed row's month on.
  const windows: Decimal[][] = []; // per window, gallons by calendar month (index 0 = Jan)
  for (let w = 0; w < MAX_YEARS_USED; w++) {
    const start = last - 11 - 12 * w;
    if (start < firstIdx) break;
    const vec = fixedVec();
    for (let i = start; i <= last - 12 * w; i++) {
      const m = i % 12;
      vec[m] = (vec[m] as Decimal).plus(gallons.get(i) ?? ZERO);
    }
    windows.push(vec);
  }
  if (windows.length === 0) {
    return gated(
      `The oil history starts in ${label(idxPeriod(firstIdx))}. A month you leave out counts as no delivery, so one full 12 months is needed: from ${label(idxPeriod(last - 11))} to ${label(idxPeriod(last))}. Add earlier deliveries, or wait.`
    );
  }
  const newestTotal = sum(windows[0] as Decimal[]);
  if (!newestTotal.greaterThan(0)) return gated("No oil delivery is listed in the last 12 months, so there is nothing to estimate from. If you did not buy oil, leave this on the budget figure.");

  const k = windows.length;
  const g: Decimal[] = [];
  for (let m = 0; m < 12; m++) g.push(mean(windows.map((w) => w[m] as Decimal)));
  const G = sum(g);
  const s = smooth3(g);
  const perWindow = windows.map((w) => smooth3(w));

  // Price: the owner's latest entry on or before today, else the newest delivery that had an amount (labelled), else gated.
  const day = today(input.now);
  const active = activeOilPrices(input.entries).filter((e) => e.effectiveOn <= day);
  let price: Decimal;
  let priceInfo: { pricePerGal: string; effectiveOn: string };
  let priceSource: "owner" | "delivery";
  let priceText: string;
  if (active.length > 0) {
    const latest = active[active.length - 1] as OilPriceEntry;
    price = new Decimal(latest.pricePerGal);
    priceInfo = { pricePerGal: latest.pricePerGal, effectiveOn: latest.effectiveOn };
    priceSource = "owner";
    priceText = `today's price of $${latest.pricePerGal} a gallon (entered by you, in force since ${latest.effectiveOn})`;
  } else {
    const priced = rows
      .filter((r) => r.cost !== null && r.quantity.greaterThan(0) && pIdx(nowP) - pIdx(r.period) <= USAGE_MAX_AGE_MONTHS)
      .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1))[0];
    if (!priced) {
      return gated(`The gallons are known (about ${G.toDecimalPlaces(0).toFixed(0)} a year) but there is no price: enter today's price per gallon above, or add the amount paid to a recent delivery.`);
    }
    price = (priced.cost as Decimal).div(priced.quantity);
    priceInfo = { pricePerGal: price.toFixed(4), effectiveOn: priced.occurredOn };
    priceSource = "delivery";
    priceText = `$${price.toFixed(4)} a gallon from your ${label(priced.period)} delivery (not today's price: enter one above to use it instead)`;
  }

  const byMonth = s.map((v) => cents2(v.times(price)));
  const ranges = s.map((_, m) => {
    const vals = perWindow.map((w) => (w[m] as Decimal).times(price));
    return { low: cents2(vals.reduce((a, b) => (b.lessThan(a) ? b : a))), high: cents2(vals.reduce((a, b) => (b.greaterThan(a) ? b : a))) };
  });
  const annual = sum(byMonth);
  let confidence: Confidence = k >= 3 ? "high" : k === 2 ? "medium" : "low";
  if (priceSource === "delivery" && confidence === "high") confidence = "medium";
  const firstP = idxPeriod(last - 11 - 12 * (k - 1));

  const parts: string[] = [];
  parts.push(
    `Oil deliveries from your uploaded history: ${k} full year${k === 1 ? "" : "s"} (${label(firstP)} to ${label(idxPeriod(last))}), about ${G.toDecimalPlaces(0).toFixed(0)} gallons a year on average. A month you left out counts as no delivery.`
  );
  parts.push(
    "A delivery is spread over the month before it, the month of it and the month after, because a fill is lumpy and burning is not; that gives the monthly gallons."
  );
  parts.push(`Gallons x ${priceText} give ${usd(annual)} for a year.`);
  parts.push(
    k === 1
      ? "Only one year is on file, so the range is the estimate itself (no range)."
      : `The range for a month is the lowest and highest of the ${k} years, smoothed the same way.`
  );
  if (input.paymentsAsPaid && input.paymentsAsPaid.count > 0) {
    parts.push(`Check: McCarthy payments over the last 12 months were ${usd(cents2(input.paymentsAsPaid.total))} as paid (${input.paymentsAsPaid.count} payment${input.paymentsAsPaid.count === 1 ? "" : "s"}); this estimate for a year is ${usd(annual)}.`);
  }
  parts.push(
    confidence === "high"
      ? "Higher confidence: three full years of deliveries."
      : confidence === "medium"
        ? `Medium confidence${priceSource === "delivery" ? " (capped because the price comes from one past delivery)" : ": two full years of deliveries"}.`
        : "Low confidence: one year of deliveries."
  );
  const lowAll = ranges.reduce((a, r) => (r.low.lessThan(a) ? r.low : a), ranges[0]!.low);
  const highAll = ranges.reduce((a, r) => (r.high.greaterThan(a) ? r.high : a), ranges[0]!.high);
  return {
    status: "estimate",
    kind: "oil",
    method: "usage",
    monthly: cents2(annual.div(12)),
    low: lowAll,
    high: highAll,
    annual,
    confidence,
    basis: parts.join(" "),
    shortBasis: `Heating-oil estimate from ${k} year${k === 1 ? "" : "s"} of uploaded deliveries (${confidence} confidence)`,
    price: priceInfo,
    priceSource,
    impliedGallons: G.toDecimalPlaces(0),
    sensitivity: cents2(G.times(OIL_SENSITIVITY)),
    byMonth,
    byMonthRange: ranges,
  };
}

// ── Firewood ────────────────────────────────────────────────────────────────────

export function seasonOfIso(iso: string): number {
  const y = Number(iso.slice(0, 4));
  return Number(iso.slice(5, 7)) >= 7 ? y : y - 1;
}

export function seasonLabel(season: number): string {
  return `${season}-${String((season + 1) % 100).padStart(2, "0")}`;
}

export interface FirewoodUsageInput {
  rows: readonly UsageRow[];
  now: Date;
}

export function firewoodUsageEstimate(input: FirewoodUsageInput): FirewoodEstimate | Gated {
  const gated = (reason: string): Gated => ({ status: "gated", kind: "firewood", reason });
  const rows = input.rows.filter((r) => r.kind === "firewood");
  if (rows.length === 0) return gated("No firewood purchases are on file.");
  const currentSeason = seasonOfIso(today(input.now));
  const firstSeason = Math.min(...rows.map((r) => seasonOfIso(r.occurredOn)));
  const lastComplete = currentSeason - 1;
  if (lastComplete < firstSeason) {
    return gated(
      `The firewood history starts in the ${seasonLabel(firstSeason)} heating season (July to June), which is not finished. A seasonal estimate needs at least two complete heating seasons with a cost on each purchase.`
    );
  }
  const facts: FirewoodSeasonFact[] = [];
  for (let s = firstSeason; s <= lastComplete; s++) {
    const mine = rows.filter((r) => seasonOfIso(r.occurredOn) === s);
    const noCost = mine.filter((r) => r.cost === null).length;
    const units = new Map<string, Decimal>();
    for (const r of mine) units.set(r.unit, (units.get(r.unit) ?? ZERO).plus(r.quantity));
    const quantity =
      mine.length === 0
        ? "no purchase"
        : [...units.entries()].map(([u, q]) => `${q.toDecimalPlaces(3).toString()} ${u === "face_cord" ? "face cord" : "cord"}${q.equals(1) ? "" : "s"}`).join(" + ");
    facts.push({
      season: s,
      label: seasonLabel(s),
      purchases: mine.length,
      quantity,
      cost: sum(mine.map((r) => r.cost ?? ZERO)),
      counted: noCost === 0,
      why: noCost > 0 ? `${noCost} purchase${noCost === 1 ? " has" : "s have"} no amount` : null,
    });
  }
  const counted = facts.filter((f) => f.counted);
  const skipped = facts.filter((f) => !f.counted);
  if (counted.length < 2) {
    return gated(
      `${counted.length} complete heating season${counted.length === 1 ? "" : "s"} with an amount on every purchase ${counted.length === 1 ? "was" : "were"} found${skipped.length > 0 ? ` (${skipped.map((f) => `${f.label}: ${f.why}`).join("; ")})` : ""}. A seasonal estimate needs at least two complete heating seasons (July to June) with a cost on each purchase.`
    );
  }
  const used = counted.slice(-MAX_YEARS_USED);
  const perSeason = used.map((f) => {
    const vec = fixedVec();
    for (const r of rows) {
      if (seasonOfIso(r.occurredOn) !== f.season) continue;
      const m = monthOf(r.period) - 1;
      vec[m] = (vec[m] as Decimal).plus(r.cost ?? ZERO);
    }
    return vec;
  });
  const g: Decimal[] = [];
  for (let m = 0; m < 12; m++) g.push(mean(perSeason.map((v) => v[m] as Decimal)));
  const sm = smooth3(g);
  const smSeasons = perSeason.map((v) => smooth3(v));
  const byMonth = sm.map(cents2);
  const ranges = sm.map((_, m) => {
    const vals = smSeasons.map((v) => v[m] as Decimal);
    return { low: cents2(vals.reduce((a, b) => (b.lessThan(a) ? b : a))), high: cents2(vals.reduce((a, b) => (b.greaterThan(a) ? b : a))) };
  });
  const annual = sum(byMonth);
  const confidence: Confidence = used.length >= 3 ? "medium" : "low";
  const parts: string[] = [];
  parts.push(
    `Firewood purchases from your uploaded history: ${used.length} complete heating season${used.length === 1 ? "" : "s"} (July to June): ${used.map((f) => `${f.label} ${f.quantity}, ${usd(cents2(f.cost))}`).join("; ")}. A season with no purchase listed counts as no purchase.`
  );
  parts.push(
    "Each month's figure is the average cost bought in that calendar month, smoothed over its neighbouring months because wood is bought in a few loads. The amounts are used as given; cords and face cords are not converted."
  );
  if (skipped.length > 0) parts.push(`Left out: ${skipped.map((f) => `${f.label} (${f.why})`).join("; ")}.`);
  parts.push("These figures come from your uploaded purchases only; bank purchases are not added on top.");
  parts.push(used.length >= 3 ? "Medium confidence: three heating seasons." : "Low confidence: two heating seasons.");
  const lowAll = ranges.reduce((a, r) => (r.low.lessThan(a) ? r.low : a), ranges[0]!.low);
  const highAll = ranges.reduce((a, r) => (r.high.greaterThan(a) ? r.high : a), ranges[0]!.high);
  return {
    status: "estimate",
    kind: "firewood",
    method: "usage",
    byMonth,
    byMonthRange: ranges,
    monthly: cents2(annual.div(12)),
    low: lowAll,
    high: highAll,
    annual,
    confidence,
    basis: parts.join(" "),
    shortBasis: `Firewood estimate from ${used.length} heating seasons of uploaded purchases (${confidence} confidence)`,
    seasons: facts,
    firstSeason,
    lastSeason: lastComplete,
  };
}
