// Pure credit-card funding analysis — client-safe.
// Answers: how much is due on each card, when, and does the funding account
// (x2631 Credit Cards) cover the autopayments while holding its $250 minimum?

import { Decimal } from "@prisma/client/runtime/library";

/**
 * One card payment the funding account must cover: the WHOLE statement balance (every card is paid in full each
 * month, so no smaller amount is ever modelled).
 */
export interface CardDue {
  accountNickname: string;
  dueDate: Date;
  statementBalance: Decimal;
  /** The card's own entity (a business card can be paid from a personal account). Display only. */
  entityId?: string;
  /**
   * Set when `statementBalance` is an ESTIMATE of a statement not yet issued (lib/card-next-statement.ts):
   * its confidence and the plain reason. Absent = the statement on file.
   */
  estimate?: { confidence: "high" | "medium" | "low"; why: string };
}

/** A signed scheduled movement on the funding account (positive = money in): transfers, paychecks, bills. */
export interface ScheduledFlow {
  date: Date;
  amount: Decimal;
}

export type CoverageStatus = "covered" | "shortfall" | "at_risk";

export interface CoverageResult {
  status: CoverageStatus;
  /** Sum of all statement balances due within the horizon (estimates included) */
  totalDue: Decimal;
  /** The part of totalDue that is estimated (statements not yet issued) */
  estimatedTotalDue: Decimal;
  /** What the funding account needs to hold on the worst day to keep >= minimum */
  shortfall: Decimal | null;
  /** First date the projected balance dips below the minimum (worst day) */
  firstShortfallDate: Date | null;
  /**
   * What it takes to keep the minimum through the LOWEST point of the horizon (can exceed `shortfall` when later
   * payments, such as an estimated next statement, push the balance lower still); null when no day dips below.
   */
  peakShortfall: Decimal | null;
  /** The (first) day the balance is at its lowest, when peakShortfall is set. */
  peakShortfallDate: Date | null;
  /** Running daily projection of the funding account across the horizon */
  daily: { date: Date; balanceAfter: Decimal; paymentsThatDay: CardDue[] }[];
  /** Per-card due list sorted by due date */
  cards: CardDue[];
}

/**
 * True when an ESTIMATED statement falls due on or before the first day the balance dips below the minimum, i.e. the
 * first-dip `shortfall` figure itself includes an estimate. A later estimate only deepens the balance afterwards
 * (see `peakShortfall`), so it must not be described as part of the first-dip amount.
 */
export function shortfallIncludesEstimate(cards: CardDue[], firstShortfallDate: Date | null): boolean {
  if (firstShortfallDate === null) return false;
  return cards.some((c) => c.estimate !== undefined && c.dueDate.getTime() <= firstShortfallDate.getTime());
}

/** Groups cards by due date, in UTC day buckets. */
export function groupCardsByDueDate(cards: CardDue[]): Map<string, CardDue[]> {
  const byDay = new Map<string, CardDue[]>();
  for (const card of cards) {
    const key = card.dueDate.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(card);
  }
  return byDay;
}

/**
 * Projects the funding account balance across [from, to) applying card
 * payments on their due dates, and checks the minimum-balance rule on the
 * worst day.
 *
 * - status "covered": every day stays >= minimum
 * - status "shortfall": some day dips below minimum
 * - status "at_risk": covered today, but the cushion after all payments is
 *   under $50 — worth surfacing so a surprise doesn't become a fee
 *
 * `otherFlows` (optional) are the account's other scheduled movements (transfers in, paychecks, bills) on their
 * dates, signed. Without them the projection ignores money moving into or out of the account and therefore
 * over-reports shortfalls; with none given the result is exactly what it was before this option existed.
 */
export function analyzeCardFunding(opts: {
  currentBalance: Decimal;
  minimumBalance: Decimal | null;
  cards: CardDue[];
  from: Date;
  to: Date;
  cushionThreshold?: Decimal;
  otherFlows?: ScheduledFlow[];
}): CoverageResult {
  const { currentBalance, minimumBalance, cards, from, to } = opts;
  const cushionThreshold = opts.cushionThreshold ?? new Decimal(50);

  const sorted = [...cards].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const byDay = groupCardsByDueDate(sorted);
  const flowsByDay = new Map<string, Decimal>();
  for (const f of opts.otherFlows ?? []) {
    const key = f.date.toISOString().slice(0, 10);
    flowsByDay.set(key, (flowsByDay.get(key) ?? new Decimal(0)).plus(f.amount));
  }

  // Null minimum = the account still can't go negative
  const effectiveMin = minimumBalance ?? new Decimal(0);

  const daily: CoverageResult["daily"] = [];
  let balance = currentBalance;
  let firstShortfallDate: Date | null = null;
  let shortfall: Decimal | null = null;

  const start = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  );
  const days = Math.round((to.getTime() - start.getTime()) / 86400000);

  for (let i = 0; i < days; i++) {
    const day = new Date(start.getTime() + i * 86400000);
    const key = day.toISOString().slice(0, 10);
    const paymentsThatDay = byDay.get(key) ?? [];

    const flow = flowsByDay.get(key);
    if (flow) balance = balance.plus(flow);
    for (const payment of paymentsThatDay) {
      balance = balance.minus(payment.statementBalance);
    }

    if (balance.lessThan(effectiveMin)) {
      if (firstShortfallDate === null) {
        firstShortfallDate = new Date(day);
        // Amount needed to restore the minimum on this day
        shortfall = effectiveMin.minus(balance);
      }
    }

    daily.push({ date: new Date(day), balanceAfter: new Decimal(balance), paymentsThatDay });
  }

  const totalDue = sorted.reduce((s, c) => s.plus(c.statementBalance), new Decimal(0));
  const estimatedTotalDue = sorted
    .filter((c) => c.estimate !== undefined)
    .reduce((s, c) => s.plus(c.statementBalance), new Decimal(0));

  let peakShortfall: Decimal | null = null;
  let peakShortfallDate: Date | null = null;
  if (firstShortfallDate !== null) {
    let lowest = daily[0] as CoverageResult["daily"][number];
    for (const d of daily) if (d.balanceAfter.lessThan(lowest.balanceAfter)) lowest = d;
    peakShortfall = effectiveMin.minus(lowest.balanceAfter);
    peakShortfallDate = new Date(lowest.date);
  }

  let status: CoverageStatus;
  if (firstShortfallDate !== null) {
    status = "shortfall";
  } else {
    const worst = daily.reduce(
      (min, d) => (d.balanceAfter.lessThan(min) ? d.balanceAfter : min),
      currentBalance
    );
    if (worst.minus(effectiveMin).lessThan(cushionThreshold)) {
      status = "at_risk";
    } else {
      status = "covered";
    }
  }

  return {
    status,
    totalDue,
    estimatedTotalDue,
    shortfall,
    firstShortfallDate,
    peakShortfall,
    peakShortfallDate,
    daily,
    cards: sorted,
  };
}

/**
 * Builds the notification message in the owner's requested format:
 * "The credit card account has a current balance of $400 and the Barclay card
 *  has a statement due balance of $500 which will be automatically deducted on
 *  the 4th. Please transfer $350 to cover the credit card payment and the
 *  minimum balance requirement to avoid the $15 monthly low balance fee."
 */
export function buildFundingMessage(opts: {
  fundingAccountNickname: string;
  currentBalance: Decimal;
  minimumBalance: Decimal | null;
  minimumBalanceFee: Decimal | null;
  result: CoverageResult;
}): { title: string; body: string } {
  const { fundingAccountNickname, currentBalance, minimumBalance, minimumBalanceFee, result } = opts;

  const fmt = (d: Decimal) =>
    `$${d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

  const dueList = result.cards
    .map((c) => {
      const due = c.dueDate.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
      if (c.estimate) {
        // Not yet issued: observational wording, with the basis, never a guarantee.
        return `the ${c.accountNickname} has an expected statement payment of about ${fmt(c.statementBalance)} on ${due} (an estimate ${c.estimate.why})`;
      }
      return `the ${c.accountNickname} has a statement due balance of ${fmt(c.statementBalance)} which will be automatically deducted on ${due}`;
    })
    .join(" and ");
  const estimateNote = result.cards.some((c) => c.estimate)
    ? " Estimated amounts are not final until the statements are issued."
    : "";

  if (result.status === "shortfall" && result.shortfall !== null && result.firstShortfallDate !== null) {
    const transfer = result.shortfall.greaterThan(0)
      ? result.shortfall
      : new Decimal(0);
    const shortfallDate = result.firstShortfallDate.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
    // Later payments (e.g. an estimated next statement) can push the balance lower than the first dip.
    const peakNote =
      result.peakShortfall !== null &&
      result.peakShortfallDate !== null &&
      result.peakShortfall.greaterThan(result.shortfall)
        ? ` The balance keeps falling after that: covering every payment through ${result.peakShortfallDate.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })} takes about ${fmt(result.peakShortfall)} in total.`
        : "";
    const feeNote = minimumBalanceFee
      ? ` to avoid the ${fmt(minimumBalanceFee)} monthly low balance fee`
      : "";

    const body =
      `The ${fundingAccountNickname} account has a current balance of ${fmt(currentBalance)} and ` +
      `${dueList}. ` +
      `The account is projected to fall below ${minimumBalance ? fmt(minimumBalance) : "$0"} on ${shortfallDate}. ` +
      `Please transfer ${fmt(transfer)}${feeNote}.${peakNote}${estimateNote}`;

    return { title: `Credit card funding shortfall: ${fundingAccountNickname}`, body };
  }

  // at_risk / covered summary
  const body =
    `The ${fundingAccountNickname} account has a current balance of ${fmt(currentBalance)} and ` +
    `${dueList}. ` +
    (result.status === "at_risk"
      ? `This leaves less than $50 of cushion above the minimum — a small surprise could trigger the low balance fee.`
      : `The account will remain above the minimum balance after all payments.`) +
    estimateNote;

  return {
    title:
      result.status === "at_risk"
        ? `Credit card funding is tight: ${fundingAccountNickname}`
        : `Credit card payments covered: ${fundingAccountNickname}`,
    body,
  };
}