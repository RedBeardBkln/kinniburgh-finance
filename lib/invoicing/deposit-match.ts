// Suggests which bank deposit settles a payment, and enforces the shared-deposit sum rule (plan 1.9). PURE. The owner always confirms:
// nothing links silently. A deposit is a Transaction (never altered); the link lives on BillingPayment.depositTransactionId.

import { DEPOSIT_WINDOW_DAYS } from "@/lib/invoicing/constants";

export interface DepositCandidate {
  transactionId: string;
  postedAt: Date;
  /** Positive cents (the loader converts Transaction.amount at the boundary). */
  amountCents: number;
  /** Payee / description text of the deposit. */
  text: string;
  /** Sum of (amount - fee) of the OTHER non-void payments already linked to this deposit. */
  alreadyLinkedNetCents: number;
}

export interface PaymentForMatch {
  amountCents: number;
  feeCents: number;
  receivedOn: Date;
  clientName: string;
}

export interface ScoredDeposit {
  transactionId: string;
  score: number;
  reasons: string[];
  remainingCents: number;
}

const STOP = new Set(["llc", "inc", "corp", "corporation", "company", "the", "and", "ltd", "co", "group", "of", "for", "services", "service"]);

export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Σ rule: the net of all non-void payments linked to one deposit may not exceed the deposit amount. */
export function depositCapacityOk(depositCents: number, otherLinkedNetCents: number, thisNetCents: number): boolean {
  return otherLinkedNetCents + thisNetCents <= depositCents;
}

export function scoreDeposits(payment: PaymentForMatch, candidates: readonly DepositCandidate[], windowDays = DEPOSIT_WINDOW_DAYS): ScoredDeposit[] {
  const net = payment.amountCents - payment.feeCents;
  const tokens = nameTokens(payment.clientName);
  const out: ScoredDeposit[] = [];
  for (const c of candidates) {
    const remaining = c.amountCents - c.alreadyLinkedNetCents;
    if (!depositCapacityOk(c.amountCents, c.alreadyLinkedNetCents, net)) continue;
    const days = Math.abs(Math.round((c.postedAt.getTime() - payment.receivedOn.getTime()) / 86_400_000));
    if (days > windowDays) continue;
    let score = 0;
    const reasons: string[] = [];
    if (c.amountCents === payment.amountCents && c.alreadyLinkedNetCents === 0) {
      score += 60;
      reasons.push("same amount");
    } else if (c.amountCents === net && c.alreadyLinkedNetCents === 0) {
      score += 55;
      reasons.push("same as the amount after the fee");
    } else if (remaining === net) {
      score += 45;
      reasons.push("fills the rest of a shared deposit");
    } else {
      score += 5;
      reasons.push("deposit is large enough (a payout may batch several payments)");
    }
    score += Math.max(0, 20 - days);
    if (days === 0) reasons.push("same day");
    else reasons.push(`${days} day${days === 1 ? "" : "s"} apart`);
    const text = c.text.toLowerCase();
    const hit = tokens.find((t) => text.includes(t));
    if (hit) {
      score += 25;
      reasons.push("client name appears in the deposit text");
    }
    out.push({ transactionId: c.transactionId, score, reasons, remainingCents: remaining });
  }
  return out.sort((a, b) => b.score - a.score || a.transactionId.localeCompare(b.transactionId));
}

/**
 * Phase 2 (task 2.6): suggests the bank deposit that is the Stripe PAYOUT of several Stripe payments. Stripe pays out the sum of the
 * payments NET of its fees, usually a few days after the latest payment, so the window runs from `latestReceivedOn` forward (and a little
 * before, for a same-day payout). An exact match of the net sum comes first; deposit text that mentions Stripe adds to the score. The Σ
 * rule only requires the nets to fit, so a payout reduced by a refund or a dispute fee still links (the remainder stays visible).
 */
export function scorePayoutDeposits(netSumCents: number, latestReceivedOn: Date, candidates: readonly DepositCandidate[], windowDays = DEPOSIT_WINDOW_DAYS): ScoredDeposit[] {
  const out: ScoredDeposit[] = [];
  for (const c of candidates) {
    if (!depositCapacityOk(c.amountCents, c.alreadyLinkedNetCents, netSumCents)) continue;
    const days = Math.round((c.postedAt.getTime() - latestReceivedOn.getTime()) / 86_400_000);
    if (days < -1 || days > windowDays) continue;
    const remaining = c.amountCents - c.alreadyLinkedNetCents;
    let score = 0;
    const reasons: string[] = [];
    if (c.amountCents === netSumCents && c.alreadyLinkedNetCents === 0) {
      score += 60;
      reasons.push("same as the total after Stripe fees");
    } else if (remaining === netSumCents) {
      score += 45;
      reasons.push("fills the rest of a shared deposit");
    } else {
      score += 5;
      reasons.push("deposit is large enough");
    }
    score += Math.max(0, 20 - Math.abs(days));
    reasons.push(days === 0 ? "same day as the latest payment" : `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days < 0 ? "before" : "after"} the latest payment`);
    if (/stripe/i.test(c.text)) {
      score += 25;
      reasons.push("the deposit text mentions Stripe");
    }
    out.push({ transactionId: c.transactionId, score, reasons, remainingCents: remaining });
  }
  return out.sort((a, b) => b.score - a.score || a.transactionId.localeCompare(b.transactionId));
}
