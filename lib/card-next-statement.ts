// Credit-card statements: paid-statement detection, funding-account inference and next-statement projection.
//
// PURE: no DB, no Prisma client, no clock, no server-action directive. The DB-aware, read-only loader is
// lib/card-next-statement-build.ts; callers hand in plain rows and `today` (the America/New_York date as UTC
// midnight, `todayForNewYork`).
//
// The owner pays EVERY card in full each month, so the only amount that matters is the whole statement balance.
// Nothing in this file reads a smaller "minimum" figure.
//
// Honesty rules (spec: ground rule 1, never fabricate):
//  - A statement is "paid" only with evidence (payment rows on the card, or a payment on the card plus the same
//    amount leaving a bank account). No evidence keeps the old "may already be paid" wording.
//  - A funding account is inferred only from matched past payments; otherwise it is "not determined" and the card
//    is never assigned to an account.
//  - A next statement is estimated only when its gates pass; otherwise the reason is returned and NO amount.
//    Every estimate carries a confidence and a plain "why", and is shown as an estimate.

import { Decimal } from "@prisma/client/runtime/library";
import {
  generateCardEstimatePayments,
  generateCardStatementPayment,
  monthlyDueDates,
  type ScheduleEvent,
} from "@/lib/forecast";
import type { CardDue } from "@/lib/cc-funding";
import type { UpcomingCardEstimateRow, UpcomingCardPaid } from "@/lib/upcoming-ledger";

// ── Constants (the plan's thresholds; backtest evidence is in the pipeline folder) ────────────────

/**
 * FALLBACK only: a statement closes about this many days before its due date (US cards mail it at least 21 days
 * before). The real lag differs per card (one household's history: Barclay fits 27, Capital One and jetBlue are not
 * pinned), so it is inferred per card from the card's own history (inferCloseLag); when it cannot be, this
 * assumption is used and the estimate's confidence is capped at medium.
 */
export const CLOSE_LAG_DAYS = 25;
/** Lags tried when inferring a card's close lag, and how a past cycle must fit. */
export const MIN_CLOSE_LAG_DAYS = 15;
export const MAX_CLOSE_LAG_DAYS = 32;
export const CLOSE_LAG_FIT_TOLERANCE = new Decimal(5);
/** At least this many conclusive past cycles must agree (within +-1 day) for a lag to be accepted... */
export const CLOSE_LAG_MIN_CYCLES = 3;
/** ...and at least this many of them must be NARROW (fit at most CLOSE_LAG_MAX_NARROW_LAGS lags): a cycle with no charges near its close fits almost every lag and proves nothing. */
export const CLOSE_LAG_MIN_NARROW_CYCLES = 2;
export const CLOSE_LAG_MAX_NARROW_LAGS = 4;
/** The card's first posted transaction must be at least this old before any projection. */
export const MIN_HISTORY_DAYS = 60;
/** Payments seen before the open-cycle estimate / a typical-month estimate is allowed. */
export const MIN_PAYMENTS_CYCLE = 2;
export const MIN_PAYMENTS_TYPICAL = 3;
/** The card balance must have been synced within this many days of today. */
export const BALANCE_MAX_AGE_DAYS = 3;
/** The statement due date on file must not be older than this. */
export const STATEMENT_MAX_AGE_DAYS = 45;
/** The card balance may be this far below the unpaid statement on file before the two are called inconsistent. */
export const RECONCILE_TOLERANCE = new Decimal(5);
/**
 * A payment counts toward a statement from this many days before its due date (the statement cannot have been
 * issued earlier than the 21-day legal minimum), so the previous cycle's payment never counts toward the next one.
 */
export const PAID_WINDOW_DAYS = 21;
export const PAID_TOLERANCE = new Decimal("0.01");
/** A bank outflow matches a payment received on the card when it is this many days before / after it. */
export const OUTFLOW_MATCH_BEFORE_DAYS = 1;
export const OUTFLOW_MATCH_AFTER_DAYS = 5;
export const FUNDING_LOOKBACK_PAYMENTS = 6;
export const FUNDING_MIN_MATCHES = 2;
/** Confidence thresholds on the days left until the open cycle's statement closes. */
export const HIGH_CONFIDENCE_DAYS = 3;
export const MEDIUM_CONFIDENCE_DAYS = 10;
/** Trailing window for the "could reach about" run-rate, and the minimum history it needs. */
export const RUN_RATE_DAYS = 90;
export const RUN_RATE_MIN_SPAN_DAYS = 30;
/** Payment rows this close together are one payment (a split payment). */
export const PAYMENT_CLUSTER_GAP_DAYS = 7;
export const TYPICAL_MONTH_PAYMENTS = 3;
export const TYPICAL_RANGE_PAYMENTS = 6;
/** The widest set of future statements ever projected. */
export const MAX_ESTIMATES = 3;

/** Text on a card-account inflow that marks it as a payment ("payment received", "autopay", "pymt"). Refunds do not match. */
export const PAYMENT_LIKE_RE = /payment|autopay|pymt/i;
/** Payee text that identifies a card payment on a bank account (used only to break a tie between accounts). */
const FUNDING_PAYEE_RE = /barclay|crcardpmt|capital one|card|autopay/i;

const DAY_MS = 86_400_000;

// ── Plain input / output shapes ──────────────────────────────────────────────────────────────────

/** One transaction on the CARD account: negative = charge, positive = payment or refund. */
export interface CardTxRow {
  postedAt: Date;
  amount: Decimal;
  /** payeeNormalized and payeeRaw joined; matched against PAYMENT_LIKE_RE. */
  text: string;
  pending: boolean;
}

/** One outflow (negative amount) on a non-card checking / savings account. */
export interface BankOutflowRow {
  accountId: string;
  accountNickname: string;
  postedAt: Date;
  amount: Decimal;
  text: string;
}

export interface CardInput {
  id: string;
  nickname: string;
  entityId: string;
  /** Amount owed, positive (Plaid's posted balance; pending rows are not in it). */
  currentBalance: Decimal | null;
  currentBalanceAt: Date | null;
  ccDueDate: Date | null;
  ccStatementBalance: Decimal | null;
  txs: CardTxRow[];
}

export interface PaidEvidence {
  /** Date of the (latest) payment on the card. */
  date: Date;
  amount: Decimal;
  rule: "payment_inflows" | "matched_outflow";
  /** Plain words for the UI: "payment received on the card" / "payment from <account>". */
  via: string;
}

export interface FundingInference {
  accountId: string;
  accountNickname: string;
  /** Past payments matched to this account. */
  matches: number;
  /** Past payments that matched exactly one account. */
  of: number;
}

export type Confidence = "high" | "medium" | "low";

export interface CardEstimate {
  kind: "cycle_to_date" | "typical_month";
  dueDate: Date;
  /** Positive, 2 decimals. */
  amount: Decimal;
  confidence: Confidence;
  /** Plain, observational basis. */
  why: string;
  /** cycle_to_date only. */
  closeDate: Date | null;
  daysToClose: number | null;
  /** cycle_to_date only: the days between the statement close and its due date used, and whether it was inferred from the card's own history (false = the 25-day assumption). */
  closeLagDays?: number;
  closeLagInferred?: boolean;
  /** cycle_to_date only: the figure if spending continues at its recent pace. */
  upTo: Decimal | null;
}

export interface OnFileStatement {
  dueDate: Date;
  amount: Decimal;
  /** Evidence it was paid, or null when no payment was found. */
  paid: PaidEvidence | null;
  /** Due date is today or later. */
  isFuture: boolean;
}

export interface CardProjection {
  cardId: string;
  nickname: string;
  entityId: string;
  funding: FundingInference | null;
  onFile: OnFileStatement | null;
  estimates: CardEstimate[];
  /** Why no (or fewer) estimates were produced; shown once per card. */
  skipReasons: string[];
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────

function dayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** Whole days from b to a (a - b). */
function dayDiff(a: Date, b: Date): number {
  return Math.round((dayStart(a).getTime() - dayStart(b).getTime()) / DAY_MS);
}

export function isPaymentLike(text: string): boolean {
  return PAYMENT_LIKE_RE.test(text);
}

function cents(d: Decimal): Decimal {
  return d.toDecimalPlaces(2);
}

/** "$2,915" (whole dollars, for plain-language sentences). */
export function fmtWhole(d: Decimal): string {
  return `$${d.toDecimalPlaces(0).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function postedInflows(txs: CardTxRow[]): CardTxRow[] {
  return txs.filter((t) => !t.pending && t.amount.greaterThan(0));
}

// ── Payments ─────────────────────────────────────────────────────────────────────────────────────

export interface ObservedPayment {
  date: Date;
  amount: Decimal;
}

/**
 * The card's payments, oldest first: posted payment-like inflows, with rows within PAYMENT_CLUSTER_GAP_DAYS of
 * each other summed into one payment (a split payment is one payment). Refunds never match PAYMENT_LIKE_RE.
 */
export function observedPayments(txs: CardTxRow[]): ObservedPayment[] {
  const rows = postedInflows(txs)
    .filter((t) => isPaymentLike(t.text))
    .map((t) => ({ date: dayStart(t.postedAt), amount: t.amount }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const out: ObservedPayment[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && dayDiff(r.date, last.date) <= PAYMENT_CLUSTER_GAP_DAYS) {
      last.amount = last.amount.plus(r.amount);
      last.date = r.date;
    } else {
      out.push({ date: r.date, amount: r.amount });
    }
  }
  return out;
}

// ── A. Paid-statement detection ─────────────────────────────────────────────────────────────────

/**
 * Was this statement paid? Evidence only; null means "no payment found" (never "unpaid").
 *
 * Counted rows are POSTED card-account inflows dated from PAID_WINDOW_DAYS before the due date to today (so the
 * previous cycle's payment never counts, and an early payment before a future due date does):
 *  1. payment-like inflows (text matches payment / autopay / pymt) that add up to at least the statement balance
 *     (an overpayment counts), or
 *  2. one inflow of at least the statement balance, whatever its text, whose exact amount also left a checking /
 *     savings account within -1..+5 days of it.
 * A refund (an inflow without payment-like text) never counts on its own.
 */
export function detectStatementPaid(args: {
  dueDate: Date;
  statementBalance: Decimal;
  cardTxs: CardTxRow[];
  bankOutflows: BankOutflowRow[];
  today: Date;
}): PaidEvidence | null {
  const { statementBalance, cardTxs, bankOutflows } = args;
  if (!statementBalance.greaterThan(0)) return null;
  const today = dayStart(args.today);
  const start = addDays(dayStart(args.dueDate), -PAID_WINDOW_DAYS);
  const need = statementBalance.minus(PAID_TOLERANCE);

  const inflows = postedInflows(cardTxs)
    .filter((t) => {
      const d = dayStart(t.postedAt).getTime();
      return d >= start.getTime() && d <= today.getTime();
    })
    .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());

  // Rule 1: payment-like inflows that cover the statement.
  const paymentLike = inflows.filter((t) => isPaymentLike(t.text));
  if (paymentLike.length > 0) {
    const sum = paymentLike.reduce((s, t) => s.plus(t.amount), new Decimal(0));
    if (sum.greaterThanOrEqualTo(need)) {
      const latest = paymentLike[paymentLike.length - 1] as CardTxRow;
      return {
        date: dayStart(latest.postedAt),
        amount: cents(sum),
        rule: "payment_inflows",
        via: "a payment received on the card",
      };
    }
  }

  // Rule 2: one inflow at least the statement, matched to an identical outflow on a bank account.
  for (const inflow of inflows) {
    if (inflow.amount.lessThan(need)) continue;
    const day = dayStart(inflow.postedAt);
    const match = bankOutflows.find((o) => {
      if (!o.amount.isNegative() || !o.amount.negated().equals(inflow.amount)) return false;
      const delta = dayDiff(o.postedAt, day);
      return delta >= -OUTFLOW_MATCH_BEFORE_DAYS && delta <= OUTFLOW_MATCH_AFTER_DAYS && dayStart(o.postedAt).getTime() <= today.getTime();
    });
    if (match) {
      return {
        date: day,
        amount: cents(inflow.amount),
        rule: "matched_outflow",
        via: `a payment from ${match.accountNickname}`,
      };
    }
  }
  return null;
}

// ── B. Funding-account inference ────────────────────────────────────────────────────────────────

/**
 * Which bank account pays this card? For the card's last FUNDING_LOOKBACK_PAYMENTS payments, find outflows of the
 * same amount (to the cent) on checking / savings accounts dated -1..+5 days from the payment row. When several
 * accounts match one payment, only outflows whose text looks like a card payment are kept; if that still does not
 * single out one account the payment is skipped. The funding account is the one with the most matches, needing at
 * least FUNDING_MIN_MATCHES and at least 2/3 of the payments that matched exactly one account. Anything less is
 * null = "not determined": the caller must not assign the card to any account.
 */
export function inferFundingAccount(args: {
  cardTxs: CardTxRow[];
  bankOutflows: BankOutflowRow[];
}): FundingInference | null {
  const payments = postedInflows(args.cardTxs)
    .filter((t) => isPaymentLike(t.text))
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())
    .slice(0, FUNDING_LOOKBACK_PAYMENTS);

  const counts = new Map<string, { nickname: string; n: number }>();
  let matched = 0;
  for (const p of payments) {
    const day = dayStart(p.postedAt);
    let candidates = args.bankOutflows.filter((o) => {
      if (!o.amount.isNegative() || !o.amount.negated().equals(p.amount)) return false;
      const delta = dayDiff(o.postedAt, day);
      return delta >= -OUTFLOW_MATCH_BEFORE_DAYS && delta <= OUTFLOW_MATCH_AFTER_DAYS;
    });
    if (new Set(candidates.map((c) => c.accountId)).size > 1) {
      candidates = candidates.filter((c) => FUNDING_PAYEE_RE.test(c.text));
    }
    const accountIds = new Set(candidates.map((c) => c.accountId));
    if (accountIds.size !== 1) continue;
    const first = candidates[0] as BankOutflowRow;
    matched += 1;
    const prev = counts.get(first.accountId);
    counts.set(first.accountId, { nickname: first.accountNickname, n: (prev?.n ?? 0) + 1 });
  }
  if (counts.size === 0) return null;

  const ranked = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
  const [topId, top] = ranked[0] as [string, { nickname: string; n: number }];
  const second = ranked[1];
  if (second && second[1].n === top.n) return null; // a tie is not a determination
  if (top.n < FUNDING_MIN_MATCHES) return null;
  if (top.n * 3 < matched * 2) return null;
  return { accountId: topId, accountNickname: top.nickname, matches: top.n, of: matched };
}

// ── B2. Statement close-lag inference ───────────────────────────────────────────────────────────

export interface CloseLagInference {
  /** Days between the statement close and its due date. */
  lag: number;
  /** Conclusive past cycles within +-1 day of this lag (and how many of them are narrow). */
  agreeing: number;
  narrowAgreeing: number;
}

/**
 * Infers a card's statement-close lag from its OWN history. Every card is paid in full, so a past payment IS the
 * statement balance. Each payment is attached to the nearest monthly due date (the day of month of the on-file due
 * date) within 7 days; for each such past cycle and each candidate lag L, the net charges posted in
 * (previous due - L, due - L] are compared with the payment; the cycle "fits" L within $5. A cycle that fits no lag
 * (gaps, partial payments) is inconclusive and ignored. A lag is accepted only when at least 3 conclusive cycles
 * fit it within +-1 day, at least 2 of those are narrow (fit at most 4 lags, so they really locate the close), and NO
 * conclusive cycle disagrees; among the lags that pass, the one that fits the most cycles exactly wins (ties go to the
 * lag nearest 25). Otherwise null: the caller falls back to the 25-day assumption and caps the confidence at medium.
 * Needs the card's history to reach back past the earliest candidate close of each cycle used.
 */
export function inferCloseLag(args: { anchorDay: number; txs: CardTxRow[] }): CloseLagInference | null {
  const posted = args.txs.filter((t) => !t.pending);
  if (posted.length === 0) return null;
  const firstTx = posted.reduce((min, t) => {
    const d = dayStart(t.postedAt);
    return d.getTime() < min.getTime() ? d : min;
  }, dayStart((posted[0] as CardTxRow).postedAt));

  // Attach each payment to its due date.
  const byDue = new Map<number, { due: Date; amount: Decimal }>();
  for (const p of observedPayments(args.txs)) {
    const near = monthlyDueDates(args.anchorDay, addDays(p.date, -20), addDays(p.date, 21))
      .map((due) => ({ due, gap: Math.abs(dayDiff(due, p.date)) }))
      .filter((c) => c.gap <= 7)
      .sort((a, b) => a.gap - b.gap)[0];
    if (!near) continue;
    const key = near.due.getTime();
    if (byDue.has(key)) byDue.delete(key); // two payments claim one due date: ambiguous, drop it
    else byDue.set(key, { due: near.due, amount: p.amount });
  }
  const cycles = [...byDue.values()].sort((a, b) => a.due.getTime() - b.due.getTime());

  const charges = posted.filter((t) => !isPaymentLike(t.text)).map((t) => ({ day: dayStart(t.postedAt).getTime(), spent: t.amount.negated() }));
  const fits: Set<number>[] = [];
  for (const cur of cycles) {
    // The previous statement's due date is the monthly date before this one (its close opens this statement's window).
    const prevDue = monthlyDueDates(args.anchorDay, addDays(cur.due, -40), cur.due).pop();
    if (!prevDue) continue;
    // The history must reach back before the earliest candidate close of the previous statement.
    if (firstTx.getTime() > addDays(prevDue, -MAX_CLOSE_LAG_DAYS).getTime()) continue;
    const fitting = new Set<number>();
    for (let lag = MIN_CLOSE_LAG_DAYS; lag <= MAX_CLOSE_LAG_DAYS; lag++) {
      const from = addDays(prevDue, -lag).getTime();
      const to = addDays(cur.due, -lag).getTime();
      let sum = new Decimal(0);
      for (const c of charges) if (c.day > from && c.day <= to) sum = sum.plus(c.spent);
      if (sum.minus(cur.amount).abs().lessThanOrEqualTo(CLOSE_LAG_FIT_TOLERANCE)) fitting.add(lag);
    }
    if (fitting.size >= 1) fits.push(fitting);
  }

  let best: { lag: number; agreeing: number; narrowAgreeing: number; contradicting: number; exact: number } | null = null;
  for (let lag = MIN_CLOSE_LAG_DAYS; lag <= MAX_CLOSE_LAG_DAYS; lag++) {
    let agreeing = 0;
    let narrowAgreeing = 0;
    let exact = 0;
    for (const f of fits) {
      if (f.has(lag - 1) || f.has(lag) || f.has(lag + 1)) {
        agreeing += 1;
        if (f.size <= CLOSE_LAG_MAX_NARROW_LAGS) narrowAgreeing += 1;
      }
      if (f.has(lag)) exact += 1;
    }
    const cand = { lag, agreeing, narrowAgreeing, contradicting: fits.length - agreeing, exact };
    if (cand.agreeing < CLOSE_LAG_MIN_CYCLES || cand.narrowAgreeing < CLOSE_LAG_MIN_NARROW_CYCLES || cand.contradicting > 0) continue;
    const better =
      best === null ||
      cand.exact > best.exact ||
      (cand.exact === best.exact && Math.abs(cand.lag - CLOSE_LAG_DAYS) < Math.abs(best.lag - CLOSE_LAG_DAYS));
    if (better) best = cand;
  }
  return best ? { lag: best.lag, agreeing: best.agreeing, narrowAgreeing: best.narrowAgreeing } : null;
}

// ── C. Next-statement projection ────────────────────────────────────────────────────────────────

function median(values: Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as Decimal;
  return (sorted[mid - 1] as Decimal).plus(sorted[mid] as Decimal).div(2);
}

function confidenceFor(daysToClose: number): Confidence {
  if (daysToClose <= HIGH_CONFIDENCE_DAYS) return "high";
  if (daysToClose <= MEDIUM_CONFIDENCE_DAYS) return "medium";
  return "low";
}

/** Trailing net charges per day (positive = spending), or null when the history is too short for a pace. */
function dailyChargeRate(txs: CardTxRow[], today: Date, firstTxDay: Date): Decimal | null {
  const span = Math.min(RUN_RATE_DAYS, dayDiff(today, firstTxDay));
  if (span < RUN_RATE_MIN_SPAN_DAYS) return null;
  const start = addDays(today, -RUN_RATE_DAYS);
  let net = new Decimal(0);
  for (const t of txs) {
    if (t.pending || isPaymentLike(t.text)) continue;
    const d = dayStart(t.postedAt);
    if (d.getTime() < start.getTime() || d.getTime() > today.getTime()) continue;
    net = net.minus(t.amount); // a charge is negative, so it adds; a refund subtracts
  }
  if (!net.greaterThan(0)) return new Decimal(0);
  return net.div(span);
}

/**
 * Projects a card's on-file statement status and its next statements.
 *
 * Gates (any failure = no estimate, a reason, never a guessed number): balance synced within 3 days, a statement
 * due date on file that is not stale, and at least 60 days of history. The open cycle (#1) additionally needs 2
 * past payments and a balance consistent with the statement on file; typical months (#2, #3) need 3 payments.
 *
 *  #1 "cycle_to_date": what is already charged this cycle = balance owed minus the unpaid statement on file. Due
 *     one month after the on-file due date. Confidence from the days until the statement closes (the card's own
 *     close lag when inferCloseLag can infer it, else an assumed 25 days and never above medium): up to 3 high, up
 *     to 10 medium, else low. Charges that have not posted yet are not predicted, so the figure is a floor early in
 *     the cycle and is never scaled up; a recent-pace figure is shown only as "could reach about". No accuracy is
 *     claimed: the history behind the thresholds is a handful of cycles per card.
 *  #2, #3 "typical_month": the MEDIAN of the last 3 payments; always low confidence.
 */
export function projectCardStatements(args: {
  card: CardInput;
  bankOutflows: BankOutflowRow[];
  today: Date;
}): CardProjection {
  const { card, bankOutflows } = args;
  const today = dayStart(args.today);
  const funding = inferFundingAccount({ cardTxs: card.txs, bankOutflows });

  // On-file statement and whether it has been paid.
  let onFile: OnFileStatement | null = null;
  if (card.ccDueDate && card.ccStatementBalance && card.ccStatementBalance.greaterThan(0)) {
    const dueDate = dayStart(card.ccDueDate);
    onFile = {
      dueDate,
      amount: cents(card.ccStatementBalance),
      paid: detectStatementPaid({
        dueDate,
        statementBalance: card.ccStatementBalance,
        cardTxs: card.txs,
        bankOutflows,
        today,
      }),
      isFuture: dueDate.getTime() >= today.getTime(),
    };
  }

  const result: CardProjection = {
    cardId: card.id,
    nickname: card.nickname,
    entityId: card.entityId,
    funding,
    onFile,
    estimates: [],
    skipReasons: [],
  };
  const skip = (reason: string) => result.skipReasons.push(reason);

  // Common gates.
  const posted = card.txs.filter((t) => !t.pending);
  const firstTx = posted.reduce<Date | null>((min, t) => {
    const d = dayStart(t.postedAt);
    return min === null || d.getTime() < min.getTime() ? d : min;
  }, null);
  if (!card.ccDueDate) skip("no statement due date is on file");
  else if (dayDiff(today, card.ccDueDate) > STATEMENT_MAX_AGE_DAYS) skip("the statement date on file is out of date");
  if (!card.currentBalance || !card.currentBalanceAt || dayDiff(today, card.currentBalanceAt) > BALANCE_MAX_AGE_DAYS) {
    skip("the card balance is missing or was not synced in the last 3 days");
  }
  if (firstTx === null || dayDiff(today, firstTx) < MIN_HISTORY_DAYS) {
    skip("needs about 3 months of card history first");
  }
  if (result.skipReasons.length > 0 || !card.ccDueDate || !card.currentBalance || firstTx === null) return result;

  // Future due dates, one per month after the on-file one (the on-file day of month, clamped for short months).
  const onFileDue = dayStart(card.ccDueDate);
  const after = addDays(onFileDue, 1);
  const dues = monthlyDueDates(onFileDue.getUTCDate(), after, addDays(after, 130));
  const [d1, d2, d3] = dues;
  if (!d1 || dayDiff(d1, today) < 0) {
    skip("the statement date on file is out of date");
    return result;
  }

  const payments = observedPayments(card.txs);
  const unpaidOnFile = onFile !== null && onFile.paid === null ? onFile.amount : new Decimal(0);

  // #1: the open cycle.
  if (payments.length < MIN_PAYMENTS_CYCLE) {
    skip(`needs at least ${MIN_PAYMENTS_CYCLE} past payments to estimate the next statement`);
  } else if (unpaidOnFile.greaterThan(0) && card.currentBalance.lessThan(unpaidOnFile.minus(RECONCILE_TOLERANCE))) {
    skip("the card balance is lower than the statement on file, so the next statement was not estimated");
  } else {
    const cum = cents(card.currentBalance.minus(unpaidOnFile));
    if (cum.greaterThan(0)) {
      // The card's own close lag when its history pins it down; otherwise the 25-day assumption, and then the
      // estimate is never better than medium confidence (the close date itself is a guess).
      const lagInference = inferCloseLag({ anchorDay: onFileDue.getUTCDate(), txs: card.txs });
      const closeLag = lagInference?.lag ?? CLOSE_LAG_DAYS;
      const closeDate = addDays(d1, -closeLag);
      // Days until the close; once the close date has passed, how many days ago (Plaid rolls the statement a few days later).
      const rawToClose = dayDiff(closeDate, today);
      const daysToClose = Math.max(0, rawToClose);
      const daysPastClose = Math.max(0, -rawToClose);
      const byDays = confidenceFor(daysToClose);
      // High needs a close date from the card's own history AND a close that has not passed: after it, the balance
      // keeps absorbing charges that belong to the NEXT statement until Plaid rolls the statement.
      const confidence: Confidence = (lagInference === null || daysPastClose > 0) && byDays === "high" ? "medium" : byDays;
      const rate = dailyChargeRate(card.txs, today, firstTx);
      const upToRaw = rate !== null && daysToClose > 0 ? cum.plus(rate.times(daysToClose)) : null;
      const upTo = upToRaw !== null && upToRaw.minus(cum).greaterThanOrEqualTo(1) ? cents(upToRaw) : null;
      // Owner-visible basis (no confidence word is printed): what the number is, where the close date comes from, and
      // what can move it. The amount is shown next to this text, so the text gives the basis only.
      const closeBasis = lagInference
        ? "the close date is worked out from your past statements and could be a day off"
        : `the close date is assumed to be ${CLOSE_LAG_DAYS} days before the due date and could be off by several days`;
      let head: string;
      if (daysPastClose > 0) {
        head = `based on charges posted so far this cycle; the statement should have closed ${daysPastClose} day${daysPastClose === 1 ? "" : "s"} ago; ${closeBasis}, so charges posted since may belong to the next statement and this may be too high`;
      } else if (daysToClose === 0) {
        head = `based on charges posted so far this cycle; the statement is expected to close about now; ${closeBasis}, so charges posted or pending near the close can change the amount`;
      } else if (daysToClose <= HIGH_CONFIDENCE_DAYS) {
        head = `based on charges posted so far this cycle; the statement is expected to close in about ${daysToClose} day${daysToClose === 1 ? "" : "s"}; ${closeBasis}, so charges posted or pending near the close can change the amount`;
      } else {
        head = `based only on charges posted so far this cycle; the statement is expected to close in about ${daysToClose} days; ${closeBasis}, so more may post`;
      }
      const tail = upTo ? `; could reach about ${fmtWhole(upTo)} if spending continues at its recent pace` : "";
      result.estimates.push({
        kind: "cycle_to_date",
        dueDate: d1,
        amount: cum,
        confidence,
        why: `${head}${tail}`,
        closeDate,
        daysToClose,
        closeLagDays: closeLag,
        closeLagInferred: lagInference !== null,
        upTo,
      });
    }
  }

  // #2, #3: typical months.
  if (payments.length < MIN_PAYMENTS_TYPICAL) {
    skip(`needs at least ${MIN_PAYMENTS_TYPICAL} past payments to estimate a typical month`);
  } else {
    const last = payments.slice(-TYPICAL_MONTH_PAYMENTS).map((p) => p.amount);
    const typical = cents(median(last));
    const range = payments.slice(-TYPICAL_RANGE_PAYMENTS).map((p) => p.amount);
    const lo = range.reduce((m, a) => (a.lessThan(m) ? a : m));
    const hi = range.reduce((m, a) => (a.greaterThan(m) ? a : m));
    if (typical.greaterThan(0)) {
      const why = `based on a typical month: the middle of your last ${last.length} card payments; your last ${range.length} payments ranged ${fmtWhole(lo)} to ${fmtWhole(hi)}`;
      for (const due of [d2, d3]) {
        if (!due) continue;
        result.estimates.push({
          kind: "typical_month",
          dueDate: due,
          amount: typical,
          confidence: "low",
          why,
          closeDate: null,
          daysToClose: null,
          upTo: null,
        });
      }
    }
  }

  result.estimates = result.estimates.slice(0, MAX_ESTIMATES).sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  return result;
}

// ── D. Consumers: forecast events, funding dues, ledger rows ────────────────────────────────────

/**
 * The card payments that should leave the card's funding account in [from, to): the on-file statement (when it is
 * unpaid and due in the window) plus the estimated future statements. Empty when the funding account is not
 * determined: a card is never assigned to an account by guessing.
 */
export function cardPaymentEvents(p: CardProjection, from: Date, to: Date): ScheduleEvent[] {
  if (!p.funding) return [];
  const accountId = p.funding.accountId;
  const events: ScheduleEvent[] = [];
  if (p.onFile && p.onFile.paid === null) {
    events.push(
      ...generateCardStatementPayment(
        { id: p.cardId, nickname: p.nickname, fundingAccountId: accountId, ccDueDate: p.onFile.dueDate, ccStatementBalance: p.onFile.amount },
        from,
        to
      )
    );
  }
  events.push(
    ...generateCardEstimatePayments(
      { nickname: p.nickname, fundingAccountId: accountId, estimates: p.estimates.map((e) => ({ dueDate: e.dueDate, amount: e.amount })) },
      from,
      to
    )
  );
  return events.sort((a, b) => a.date.getTime() - b.date.getTime());
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * The card's dues in [from, to) in the shape lib/cc-funding.ts analyses: the unpaid on-file statement (never
 * flagged as an estimate) and the estimated statements at or above `minConfidence` (default every estimate).
 */
export function cardDuesInWindow(
  p: CardProjection,
  from: Date,
  to: Date,
  opts: { minConfidence?: Confidence } = {}
): CardDue[] {
  const inside = (d: Date) => d.getTime() >= from.getTime() && d.getTime() < to.getTime();
  const dues: CardDue[] = [];
  if (p.onFile && p.onFile.paid === null && inside(p.onFile.dueDate)) {
    dues.push({ accountNickname: p.nickname, dueDate: p.onFile.dueDate, statementBalance: p.onFile.amount, entityId: p.entityId });
  }
  const min = CONFIDENCE_RANK[opts.minConfidence ?? "low"];
  for (const e of p.estimates) {
    if (!inside(e.dueDate) || CONFIDENCE_RANK[e.confidence] < min) continue;
    dues.push({
      accountNickname: p.nickname,
      dueDate: e.dueDate,
      statementBalance: e.amount,
      entityId: p.entityId,
      estimate: { confidence: e.confidence, why: e.why },
    });
  }
  return dues.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

/** What the Upcoming ledger needs: which on-file statements are paid (and which were checked), and the estimates. */
export function toLedgerCardInputs(projections: CardProjection[]): {
  paidByCardId: Map<string, UpcomingCardPaid | null>;
  estimates: UpcomingCardEstimateRow[];
} {
  const paidByCardId = new Map<string, UpcomingCardPaid | null>();
  const estimates: UpcomingCardEstimateRow[] = [];
  for (const p of projections) {
    if (p.onFile) {
      paidByCardId.set(
        p.cardId,
        p.onFile.paid ? { date: p.onFile.paid.date, amount: p.onFile.paid.amount, via: p.onFile.paid.via } : null
      );
    }
    for (const e of p.estimates) {
      estimates.push({
        cardId: p.cardId,
        entityId: p.entityId,
        nickname: p.nickname,
        dueDate: e.dueDate,
        amount: e.amount,
        confidence: e.confidence,
        why: e.why,
        kind: e.kind,
      });
    }
  }
  return { paidByCardId, estimates };
}
