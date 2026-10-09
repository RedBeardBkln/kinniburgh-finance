// Net (take-home) pay for an IncomeSource, for forecasting. Pure: no database, no clock (`today` is passed in).
//
// IncomeSource.amount is the GROSS paycheck (it is shown that way on the Income page and used for tax work). Every
// forecast path must use what actually lands in the account. Preference order, decided from the household's own data
// (see .claude/pipeline/net-income-budget-dates/01-plan.md):
//   a) "deposits": the median of the most recent payroll deposits received for that source (same account, matched
//      by the employer's name in the bank's payee text; at least 3, newest one recent);
//   b) "paystub": the net pay of the latest CONFIRMED paystub that matches the source;
//   c) "gross_unknown": nothing is known, so the gross amount is used BUT flagged (`assumption: true`, label says
//      "take-home unknown"). Gross is never presented as net.
//
// All money is Decimal (never floats). Nothing here changes a date or any stored value: the pay-timing note is
// report-only.
import { Decimal } from "@prisma/client/runtime/library";
import { formatCalendarDate } from "@/lib/card-due";

export type NetBasis = "deposits" | "paystub" | "gross_unknown";

export interface DepositRow {
  postedAt: Date;
  /** Positive inflow. */
  amount: Decimal;
  /** Transaction.payeeNormalized (the bank's own text, often truncated). */
  payee: string | null;
  accountId: string;
  entityId: string;
}

export interface StubRow {
  employerName: string | null;
  payDate: Date | null;
  payFrequency: string | null;
  grossPayCents: number | null;
  netPayCents: number | null;
  depositAccountId: string | null;
}

export interface IncomeSourceInput {
  id: string;
  accountId: string;
  entityId: string;
  description: string;
  cadence: string;
  dayRules: unknown;
  amount: Decimal | string | number;
  active: boolean;
}

export type PayTimingNote =
  | {
      kind: "offset";
      /** UTC weekday the money arrives (0 = Sunday). */
      depositWeekday: number;
      /** UTC weekday the source's own schedule uses. */
      scheduleWeekday: number;
      /** Signed days the schedule lands AFTER the money (negative = before). */
      days: number;
      /** The schedule's first paycheck date, moved by `days` to match the deposits (yyyy-mm-dd). */
      suggestedAnchor: string;
      text: string;
    }
  | { kind: "early"; minDays: number; maxDays: number; text: string }
  | { kind: "irregular"; text: string; minDays?: number; maxDays?: number };

export interface NetIncomeInfo {
  basis: NetBasis;
  /** Per-paycheck amount to forecast with (take-home, or gross when `basis` is "gross_unknown"). */
  net: Decimal;
  gross: Decimal;
  /** Deposits used (basis "deposits"), otherwise 0 or 1 (a stub). */
  samples: number;
  min: Decimal | null;
  max: Decimal | null;
  /** True when the deposits spread more than 5% (shown as "about", with the range). */
  variable: boolean;
  lastDepositOn: Date | null;
  stubPayDate: Date | null;
  /** Plain-language basis, always shown beside the number. */
  label: string;
  /** True when the number is an unflagged-by-data assumption (gross used because take-home is unknown). */
  assumption: boolean;
  timing: PayTimingNote | null;
}

/** Deposits to use, newest first window. */
export const NET_MAX_DEPOSITS = 6;
export const NET_MIN_DEPOSITS = 3;
/** The loader reads this far back. */
export const NET_LOOKBACK_DAYS = 150;
const STALE_MIN_DAYS = 45;
const VARIABLE_SPREAD = 0.05;
/** A deposit above gross * this, or below gross * LOW, is not a paycheck for this source. */
const SANITY_HIGH = new Decimal("1.05");
const SANITY_LOW = new Decimal("0.25");
const DAY_MS = 86400000;

const STOP_WORDS = new Set(["inc", "llc", "corp", "co", "the", "ltd", "company", "corporation", "payroll", "and"]);

// ── Money formatting (string based; no float math) ───────────────────────────

/** "$6,064.86" from a Decimal. */
export function formatMoneyDecimal(d: Decimal): string {
  const fixed = d.toDecimalPlaces(2).toFixed(2);
  const neg = fixed.startsWith("-");
  const body = neg ? fixed.slice(1) : fixed;
  const [whole, frac] = body.split(".");
  const withCommas = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${withCommas}.${frac ?? "00"}`;
}

function toDecimal(v: Decimal | string | number): Decimal {
  return new Decimal(String(v));
}

// ── Employer matching ────────────────────────────────────────────────────────

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

/**
 * Employer words used to find a source's deposits. They come from the parenthetical in the description (the
 * paystub sync writes "payroll (Employer Name)") and, when given, the matched paystub's employer name. A
 * description without a parenthetical and no stub gives no tokens (the source then cannot be matched by payee).
 */
export function employerTokens(description: string, stubEmployer?: string | null): string[] {
  const out: string[] = [];
  const paren = /\(([^)]+)\)/.exec(description);
  if (paren && paren[1]) out.push(...wordsOf(paren[1]));
  if (out.length === 0 && stubEmployer) out.push(...wordsOf(stubEmployer));
  return [...new Set(out)];
}

/** A payee word matches an employer word exactly, or is a prefix of at least 5 characters (the bank truncates). */
function wordMatches(payeeWord: string, employerWord: string): boolean {
  if (payeeWord === employerWord) return true;
  return payeeWord.length >= 5 && employerWord.startsWith(payeeWord);
}

function payeeHasEveryToken(payee: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const words = payee
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
  return tokens.every((t) => words.some((w) => wordMatches(w, t)));
}

/**
 * Deposits that look like this source's paycheck: same account and entity, a positive amount, and a payee that
 * contains every employer word (a payee word may be a truncated prefix of 5+ characters). The word "payroll" is
 * not required. Non-payroll inflows (claims, Venmo, refunds) do not contain the employer and are ignored.
 */
export function matchDeposits(
  src: Pick<IncomeSourceInput, "accountId" | "entityId">,
  tokens: string[],
  deposits: DepositRow[]
): DepositRow[] {
  if (tokens.length === 0) return [];
  return deposits
    .filter(
      (d) =>
        d.accountId === src.accountId &&
        d.entityId === src.entityId &&
        d.amount.greaterThan(0) &&
        d.payee != null &&
        payeeHasEveryToken(d.payee, tokens)
    )
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
}

// ── Cadence helpers ──────────────────────────────────────────────────────────

function cycleDays(cadence: string): number {
  if (cadence === "weekly") return 7;
  if (cadence === "biweekly") return 14;
  if (cadence === "semi_monthly") return 15.2;
  return 30.4;
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDayUTC(b).getTime() - startOfDayUTC(a).getTime()) / DAY_MS);
}

function median(sorted: Decimal[]): Decimal {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid]!;
  return sorted[mid - 1]!.plus(sorted[mid]!).div(2).toDecimalPlaces(2);
}

// ── Stubs ────────────────────────────────────────────────────────────────────

function stubGrossMatches(stub: StubRow, gross: Decimal): boolean {
  if (stub.grossPayCents == null || stub.grossPayCents <= 0) return false;
  const stubGross = new Decimal(stub.grossPayCents).div(100);
  if (gross.isZero()) return false;
  return stubGross.minus(gross).abs().div(gross).lessThanOrEqualTo("0.01");
}

/**
 * The newest confirmed paystub that matches the source: its gross equals the source's amount (within 1%) AND
 * either its employer matches the source's employer words or its pay frequency equals the source's cadence. A
 * stub that names a deposit account must name this source's account. Newest payDate wins.
 */
function pickStub(src: IncomeSourceInput, tokens: string[], stubs: StubRow[], gross: Decimal): StubRow | null {
  const ok = stubs.filter((s) => {
    if (s.netPayCents == null || s.netPayCents <= 0) return false;
    if (!stubGrossMatches(s, gross)) return false;
    if (s.depositAccountId != null && s.depositAccountId !== src.accountId) return false;
    const employerOk =
      tokens.length > 0 && s.employerName != null && payeeHasEveryToken(s.employerName, tokens);
    const freqOk = s.payFrequency != null && s.payFrequency === src.cadence;
    return employerOk || freqOk;
  });
  ok.sort((a, b) => (b.payDate?.getTime() ?? 0) - (a.payDate?.getTime() ?? 0));
  return ok[0] ?? null;
}

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolves one source's per-paycheck take-home. `deposits` may hold deposits of other accounts and employers; this
 * function matches. Never throws; money stays Decimal.
 */
export function resolveNetIncome(
  src: IncomeSourceInput,
  deposits: DepositRow[],
  stubs: StubRow[],
  today: Date
): NetIncomeInfo {
  const gross = toDecimal(src.amount);
  const empty = {
    gross,
    min: null,
    max: null,
    variable: false,
    lastDepositOn: null,
    stubPayDate: null,
    timing: null,
  };

  // Employer words: the description's parenthetical, else the employer of a stub that matches by amount + cadence.
  let tokens = employerTokens(src.description);
  if (tokens.length === 0) {
    const byAmount = pickStub(src, [], stubs, gross);
    if (byAmount?.employerName) tokens = employerTokens("", byAmount.employerName);
  }

  // (a) deposits
  const matched = matchDeposits(src, tokens, deposits).filter(
    (d) => d.amount.lessThanOrEqualTo(gross.times(SANITY_HIGH)) && d.amount.greaterThanOrEqualTo(gross.times(SANITY_LOW))
  );
  const newest = matched[0];
  const staleLimit = Math.max(STALE_MIN_DAYS, Math.ceil(cycleDays(src.cadence) * 2.5));
  if (matched.length >= NET_MIN_DEPOSITS && newest && daysBetween(newest.postedAt, today) <= staleLimit) {
    const used = matched.slice(0, NET_MAX_DEPOSITS);
    const amounts = used.map((d) => d.amount).sort((a, b) => a.comparedTo(b));
    const med = median(amounts);
    const min = amounts[0]!;
    const max = amounts[amounts.length - 1]!;
    const variable = med.greaterThan(0) && max.minus(min).div(med).greaterThan(VARIABLE_SPREAD);
    const label = variable
      ? `about ${formatMoneyDecimal(med)} take-home (usually ${formatMoneyDecimal(min)} to ${formatMoneyDecimal(max)}), median of your last ${used.length} deposits`
      : `take-home ${formatMoneyDecimal(med)}, from your last ${used.length} deposits`;
    return {
      ...empty,
      basis: "deposits",
      net: med,
      samples: used.length,
      min,
      max,
      variable,
      lastDepositOn: newest.postedAt,
      label,
      assumption: false,
      timing: payTimingNote(src, used),
    };
  }

  // (b) latest confirmed paystub
  const stub = pickStub(src, tokens, stubs, gross);
  if (stub && stub.netPayCents != null) {
    const net = new Decimal(stub.netPayCents).div(100);
    const when = stub.payDate ? `of ${formatCalendarDate(stub.payDate)}` : "";
    return {
      ...empty,
      basis: "paystub",
      net,
      samples: 1,
      stubPayDate: stub.payDate,
      label: `take-home ${formatMoneyDecimal(net)} from your confirmed paystub ${when}${when ? " " : ""}(no recent deposits matched)`,
      assumption: false,
      timing: null,
    };
  }

  // (c) nothing known: gross, flagged
  return {
    ...empty,
    basis: "gross_unknown",
    net: gross,
    samples: 0,
    label: `gross ${formatMoneyDecimal(gross)} used, take-home unknown: confirm a paystub on the Income page`,
    assumption: true,
    timing: null,
  };
}

/** The label used when the deposit / paystub reads failed. */
export function unreadableNetInfo(src: Pick<IncomeSourceInput, "amount">): NetIncomeInfo {
  const gross = toDecimal(src.amount);
  return {
    basis: "gross_unknown",
    net: gross,
    gross,
    samples: 0,
    min: null,
    max: null,
    variable: false,
    lastDepositOn: null,
    stubPayDate: null,
    label: `gross ${formatMoneyDecimal(gross)} used, take-home could not be read`,
    assumption: true,
    timing: null,
  };
}

/** Short word for the basis column / tool output. */
export function basisWord(info: Pick<NetIncomeInfo, "basis" | "variable">): string {
  if (info.basis === "deposits") return info.variable ? "about (median of recent deposits)" : "recent deposits";
  if (info.basis === "paystub") return "confirmed paystub";
  return "gross, take-home unknown";
}

// ── Pay timing (report only; never alters a date) ───────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function weekdayName(n: number): string {
  return WEEKDAYS[n] ?? "?";
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Day-of-month list a semi_monthly / monthly source states, clamped to the month length. */
function statedDays(src: IncomeSourceInput, year: number, month: number): number[] {
  const rules = (src.dayRules ?? {}) as Record<string, unknown>;
  const dim = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let days: number[];
  if (src.cadence === "semi_monthly") {
    days = Array.isArray(rules["daysOfMonth"]) ? (rules["daysOfMonth"] as number[]) : [15, 30];
  } else {
    days = [typeof rules["dayOfMonth"] === "number" ? (rules["dayOfMonth"] as number) : 1];
  }
  return [...new Set(days.filter((d) => Number.isInteger(d)).map((d) => Math.min(d, dim)))];
}

/**
 * Reports how the deposits line up with the source's own schedule. REPORT ONLY (the forecast and every stored
 * date are untouched).
 * - weekly / biweekly: with >= 4 deposits that share one weekday and arrive in whole cycles, and a schedule that
 *   falls on a different weekday, returns an "offset" with the first-paycheck date that would match.
 * - semi_monthly / monthly: with >= 4 deposits, the number of days each arrived BEFORE the stated day.
 */
export function payTimingNote(src: IncomeSourceInput, matched: DepositRow[]): PayTimingNote | null {
  const used = [...matched].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime()).slice(0, NET_MAX_DEPOSITS);
  if (used.length < 4) return null;
  const rules = (src.dayRules ?? {}) as Record<string, unknown>;

  if (src.cadence === "weekly" || src.cadence === "biweekly") {
    const cycle = src.cadence === "weekly" ? 7 : typeof rules["intervalDays"] === "number" ? (rules["intervalDays"] as number) : 14;
    if (!Number.isInteger(cycle) || cycle <= 0) return null;
    const weekdays = new Set(used.map((d) => d.postedAt.getUTCDay()));
    if (weekdays.size !== 1) return null;
    const depositWeekday = used[0]!.postedAt.getUTCDay();
    const oldest = used[used.length - 1]!.postedAt;
    const gapsOk = used.every((d) => daysBetween(oldest, d.postedAt) % cycle === 0);
    if (!gapsOk) return null;

    let anchor: Date | null = null;
    let scheduleWeekday: number;
    if (src.cadence === "weekly") {
      scheduleWeekday = typeof rules["dayOfWeek"] === "number" ? (rules["dayOfWeek"] as number) : 1;
      anchor = null;
    } else {
      if (typeof rules["anchorDate"] !== "string") return null;
      const a = new Date(rules["anchorDate"]);
      if (Number.isNaN(a.getTime())) return null;
      anchor = startOfDayUTC(a);
      scheduleWeekday = anchor.getUTCDay();
    }
    if (scheduleWeekday === depositWeekday) return null;

    const days = ((scheduleWeekday - depositWeekday + 10) % 7) - 3;
    const latest = startOfDayUTC(used[0]!.postedAt);
    // suggested first paycheck date: the schedule's anchor moved by `days` (weekly has no anchor: the latest deposit)
    const suggested = anchor ? new Date(anchor.getTime() - days * DAY_MS) : latest;
    if (anchor && daysBetween(suggested, latest) % cycle !== 0) {
      return {
        kind: "irregular",
        text: `Deposits arrive on ${weekdayName(depositWeekday)}s but this schedule falls on ${weekdayName(scheduleWeekday)}s and in a different cycle. The forecast uses the schedule as saved. Nothing was changed.`,
      };
    }
    const where = days > 0 ? `${plural(days, "day")} after` : `${plural(-days, "day")} before`;
    const text =
      `Deposits arrive on ${weekdayName(depositWeekday)}s; this schedule starts ${weekdayName(scheduleWeekday).slice(0, 3)} ${formatCalendarDate(anchor ?? latest)}, ` +
      `so forecast paychecks land ${where} the money does. To match, set the first paycheck date to ${weekdayName(depositWeekday).slice(0, 3)} ${formatCalendarDate(suggested)} in Settings > Income sources.` +
      (days > 0
        ? " Until then, the first paycheck shown after today may already be in your balance, so near-term projections can be too high by about one paycheck."
        : "") +
      " Nothing was changed.";
    return { kind: "offset", depositWeekday, scheduleWeekday, days, suggestedAnchor: ymd(suggested), text };
  }

  if (src.cadence === "semi_monthly" || src.cadence === "monthly") {
    const gaps: number[] = [];
    for (const d of used) {
      const y = d.postedAt.getUTCFullYear();
      const m = d.postedAt.getUTCMonth();
      const day0 = startOfDayUTC(d.postedAt);
      // nearest stated day on or after the deposit date (this month or next)
      let best: number | null = null;
      for (const [yy, mm] of [
        [y, m],
        [m === 11 ? y + 1 : y, (m + 1) % 12],
      ] as const) {
        for (const sd of statedDays(src, yy, mm)) {
          const delta = daysBetween(day0, new Date(Date.UTC(yy, mm, sd)));
          if (delta >= 0 && (best === null || delta < best)) best = delta;
        }
      }
      if (best === null || best > 7) return null;
      gaps.push(best);
    }
    const minDays = Math.min(...gaps);
    const maxDays = Math.max(...gaps);
    if (maxDays === 0) return null;
    const range = minDays === maxDays ? plural(minDays, "day") : `${minDays} to ${plural(maxDays, "day")}`;
    return {
      kind: minDays === maxDays ? "early" : "irregular",
      minDays,
      maxDays,
      text: `Deposits arrive ${range} before the stated day; the forecast uses the stated day.`,
    };
  }
  return null;
}
