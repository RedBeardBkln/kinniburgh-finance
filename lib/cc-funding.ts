// Pure credit-card funding analysis — client-safe.
// Answers: how much is due on each card, when, and does the funding account
// (x2631 Credit Cards) cover the autopayments while holding its $250 minimum?

import { Decimal } from "@prisma/client/runtime/library";

export interface CardDue {
  accountNickname: string;
  dueDate: Date;
  statementBalance: Decimal;
  minimumPayment: Decimal | null;
}

export type CoverageStatus = "covered" | "shortfall" | "at_risk";

export interface CoverageResult {
  status: CoverageStatus;
  /** Sum of all statement balances due within the horizon */
  totalDue: Decimal;
  /** What the funding account needs to hold on the worst day to keep >= minimum */
  shortfall: Decimal | null;
  /** First date the projected balance dips below the minimum (worst day) */
  firstShortfallDate: Date | null;
  /** Running daily projection of the funding account across the horizon */
  daily: { date: Date; balanceAfter: Decimal; paymentsThatDay: CardDue[] }[];
  /** Per-card due list sorted by due date */
  cards: CardDue[];
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
 */
export function analyzeCardFunding(opts: {
  currentBalance: Decimal;
  minimumBalance: Decimal | null;
  cards: CardDue[];
  from: Date;
  to: Date;
  cushionThreshold?: Decimal;
}): CoverageResult {
  const { currentBalance, minimumBalance, cards, from, to } = opts;
  const cushionThreshold = opts.cushionThreshold ?? new Decimal(50);

  const sorted = [...cards].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const byDay = groupCardsByDueDate(sorted);

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
    shortfall,
    firstShortfallDate,
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
      return `the ${c.accountNickname} has a statement due balance of ${fmt(c.statementBalance)} which will be automatically deducted on ${due}`;
    })
    .join(" and ");

  if (result.status === "shortfall" && result.shortfall !== null && result.firstShortfallDate !== null) {
    const transfer = result.shortfall.greaterThan(0)
      ? result.shortfall
      : new Decimal(0);
    const shortfallDate = result.firstShortfallDate.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
    const feeNote = minimumBalanceFee
      ? ` to avoid the ${fmt(minimumBalanceFee)} monthly low balance fee`
      : "";

    const body =
      `The ${fundingAccountNickname} account has a current balance of ${fmt(currentBalance)} and ` +
      `${dueList}. ` +
      `The account is projected to fall below ${minimumBalance ? fmt(minimumBalance) : "$0"} on ${shortfallDate}. ` +
      `Please transfer ${fmt(transfer)}${feeNote}.`;

    return { title: `Credit card funding shortfall: ${fundingAccountNickname}`, body };
  }

  // at_risk / covered summary
  const body =
    `The ${fundingAccountNickname} account has a current balance of ${fmt(currentBalance)} and ` +
    `${dueList}. ` +
    (result.status === "at_risk"
      ? `This leaves less than $50 of cushion above the minimum — a small surprise could trigger the low balance fee.`
      : `The account will remain above the minimum balance after all payments.`);

  return {
    title:
      result.status === "at_risk"
        ? `Credit card funding is tight: ${fundingAccountNickname}`
        : `Credit card payments covered: ${fundingAccountNickname}`,
    body,
  };
}