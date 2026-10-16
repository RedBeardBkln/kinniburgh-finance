// Cash-basis (tax) view of receipts and the hygiene checks (plan D3). PURE, READ-ONLY reporting. Nothing in the tax engine reads
// it (a pin test). The entity files on the cash method, so receipts are listed by DEPOSIT date: for each non-void payment the
// linked deposit's postedAt, else receivedOn flagged "no bank deposit linked". Whether any receipt is deferrable for tax is NOT
// decided here ("needs a professional's input").

export interface CashPayment {
  id: string;
  clientId: string;
  receivedOn: Date;
  amountCents: number;
  feeCents: number;
  status: string; // recorded | void
  /** The linked deposit when it exists and is not archived; null otherwise. */
  depositPostedAt: Date | null;
  /** A deposit was linked but it has since been archived (treated as unlinked, flagged). */
  depositArchived: boolean;
}

export interface CashReceipt {
  paymentId: string;
  clientId: string;
  date: Date;
  month: string; // YYYY-MM (UTC)
  grossCents: number;
  feeCents: number;
  noDepositLinked: boolean;
  depositArchived: boolean;
}

const monthOf = (d: Date) => d.toISOString().slice(0, 7);

/** Receipts whose cash date falls in [from, to], with the cash date = deposit posted date, else the received date. */
export function cashReceipts(payments: readonly CashPayment[], from: Date, to: Date): CashReceipt[] {
  const out: CashReceipt[] = [];
  for (const p of payments) {
    if (p.status !== "recorded") continue;
    const date = p.depositPostedAt ?? p.receivedOn;
    if (date.getTime() < from.getTime() || date.getTime() > to.getTime()) continue;
    out.push({
      paymentId: p.id,
      clientId: p.clientId,
      date,
      month: monthOf(date),
      grossCents: p.amountCents,
      feeCents: p.feeCents,
      noDepositLinked: p.depositPostedAt === null,
      depositArchived: p.depositArchived,
    });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export interface CashSummary {
  grossCents: number;
  feeCents: number;
  byMonth: Map<string, { grossCents: number; feeCents: number }>;
  byClient: Map<string, { grossCents: number; feeCents: number }>;
  unlinkedCount: number;
}

export function summarizeCash(receipts: readonly CashReceipt[]): CashSummary {
  const byMonth = new Map<string, { grossCents: number; feeCents: number }>();
  const byClient = new Map<string, { grossCents: number; feeCents: number }>();
  let grossCents = 0;
  let feeCents = 0;
  let unlinkedCount = 0;
  for (const r of receipts) {
    grossCents += r.grossCents;
    feeCents += r.feeCents;
    if (r.noDepositLinked) unlinkedCount += 1;
    for (const [map, key] of [[byMonth, r.month], [byClient, r.clientId]] as const) {
      const cur = map.get(key) ?? { grossCents: 0, feeCents: 0 };
      cur.grossCents += r.grossCents;
      cur.feeCents += r.feeCents;
      map.set(key, cur);
    }
  }
  return { grossCents, feeCents, byMonth, byClient, unlinkedCount };
}

/** Reconciliation line to computePL(...).totalIncome for the same dates; the difference is listed row by row via the hygiene panel. */
export function reconcileToLedger(cashGrossCents: number, ledgerRevenueCents: number): { differenceCents: number; matches: boolean } {
  const differenceCents = ledgerRevenueCents - cashGrossCents;
  return { differenceCents, matches: differenceCents === 0 };
}

// ── Hygiene panel (information only) ──────────────────────────────────────────────

export interface HygienePayment {
  paymentId: string;
  status: string;
  receivedOn: Date;
  amountCents: number;
  depositId: string | null;
  depositArchived: boolean;
  /** GlCode.type of the linked deposit's GL (null = none coded). */
  depositGlType: string | null;
}

export interface HygieneRevenueDeposit {
  transactionId: string;
  postedAt: Date;
  amountCents: number;
  linked: boolean;
}

export interface Hygiene {
  /** (a) Linked deposits whose GL is not revenue-typed: fine for accrual, but the ledger view will not count them as receipts. */
  linkedNotRevenueTyped: { paymentId: string; depositId: string; glType: string | null }[];
  /** (b) Revenue-coded deposits not linked to any payment: possible unrecorded invoice payments, or non-invoice income. */
  revenueDepositsNotLinked: HygieneRevenueDeposit[];
  /** (c) Payments with no usable deposit link: cash in hand / not yet matched. */
  paymentsWithoutDeposit: { paymentId: string; receivedOn: Date; amountCents: number; deposit: "none" | "archived" }[];
}

export function buildHygiene(payments: readonly HygienePayment[], revenueDeposits: readonly HygieneRevenueDeposit[]): Hygiene {
  const linkedNotRevenueTyped: Hygiene["linkedNotRevenueTyped"] = [];
  const paymentsWithoutDeposit: Hygiene["paymentsWithoutDeposit"] = [];
  for (const p of payments) {
    if (p.status !== "recorded") continue;
    if (p.depositId && !p.depositArchived) {
      if (p.depositGlType !== "revenue") linkedNotRevenueTyped.push({ paymentId: p.paymentId, depositId: p.depositId, glType: p.depositGlType });
    } else {
      paymentsWithoutDeposit.push({ paymentId: p.paymentId, receivedOn: p.receivedOn, amountCents: p.amountCents, deposit: p.depositId ? "archived" : "none" });
    }
  }
  return {
    linkedNotRevenueTyped,
    revenueDepositsNotLinked: revenueDeposits.filter((d) => !d.linked),
    paymentsWithoutDeposit,
  };
}
