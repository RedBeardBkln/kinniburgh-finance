// Accrual P&L on the invoicing side (plan D2). PURE. Shown only on the invoicing reports page, labelled "Accrual (invoices)".
//
// revenue  = invoice revenue lines by period (from the derived ledger), less discounts,
//          + "Other revenue not invoiced" = revenue-coded LEDGER deposits that are NOT linked to any non-void payment.
//            A deposit linked to a payment is settlement of A/R, not new revenue, so it is excluded here (it stays in the
//            ledger P&L, which is unchanged and is effectively cash by deposit date).
// expenses = the ledger P&L expense lines for the same dates, unchanged, + payment-processing fees from payments.
// Each dollar is therefore counted once in each view. Before go-live the accrual view does not exist: callers show the ledger P&L only.

import { ACCOUNT_DISCOUNTS, ACCOUNT_FEES, netInRange, glAccount, type LedgerEntry } from "@/lib/invoicing/ledger";

export interface LedgerExpenseLine {
  glCodeId: string;
  code: string;
  name: string;
  cents: number;
}

export interface UnlinkedRevenueDeposit {
  transactionId: string;
  postedAt: Date;
  /** Signed cents (a revenue-coded row; unlinked). */
  amountCents: number;
}

export interface AccrualPlInput {
  from: Date;
  to: Date;
  goLiveOn: Date;
  entries: readonly LedgerEntry[];
  /** Revenue GL accounts that may carry invoice lines: id, code and name for display. */
  revenueAccounts: readonly { glCodeId: string; code: string; name: string }[];
  /** computePL expense lines for [effectiveFrom, to]; the loader calls computePL with the clamped range. */
  ledgerExpenseLines: readonly LedgerExpenseLine[];
  /**
   * Revenue deposits that are NOT linked to a recorded (non-void) payment. This pure module TRUSTS its caller to have filtered out
   * the linked ones (that is what stops a deposit being counted twice, plan D2); the loader built in task 1.12 must pass only unlinked
   * deposits (a deposit linked to a non-void payment is already counted through its invoice).
   */
  unlinkedRevenueDeposits: readonly UnlinkedRevenueDeposit[];
}

export interface AccrualPl {
  basis: "accrual";
  /** The range actually computed (from clamped up to go-live). */
  effectiveFrom: Date;
  to: Date;
  /** True when part of the requested range is before go-live: that part is ledger-only and is not in this report. */
  partlyBeforeGoLive: boolean;
  /** The whole range is before go-live: there is no accrual view for it. */
  entirelyBeforeGoLive: boolean;
  revenueLines: { glCodeId: string; code: string; name: string; cents: number }[];
  invoicedRevenueCents: number;
  discountsCents: number;
  otherRevenueNotInvoicedCents: number;
  totalRevenueCents: number;
  expenseLines: LedgerExpenseLine[];
  ledgerExpensesCents: number;
  processingFeesCents: number;
  totalExpensesCents: number;
  netCents: number;
}

export function buildAccrualPl(input: AccrualPlInput): AccrualPl {
  const goLive = input.goLiveOn.getTime();
  const entirelyBefore = input.to.getTime() < goLive;
  const effectiveFrom = new Date(Math.max(input.from.getTime(), goLive));
  const partly = input.from.getTime() < goLive;
  if (entirelyBefore) {
    return {
      basis: "accrual",
      effectiveFrom,
      to: input.to,
      partlyBeforeGoLive: true,
      entirelyBeforeGoLive: true,
      revenueLines: [],
      invoicedRevenueCents: 0,
      discountsCents: 0,
      otherRevenueNotInvoicedCents: 0,
      totalRevenueCents: 0,
      expenseLines: [],
      ledgerExpensesCents: 0,
      processingFeesCents: 0,
      totalExpensesCents: 0,
      netCents: 0,
    };
  }

  const revenueLines = input.revenueAccounts
    .map((a) => ({ ...a, cents: -netInRange(input.entries, glAccount(a.glCodeId), effectiveFrom, input.to) }))
    .filter((l) => l.cents !== 0);
  const invoicedRevenueCents = revenueLines.reduce((s, l) => s + l.cents, 0);
  const discountsCents = netInRange(input.entries, ACCOUNT_DISCOUNTS, effectiveFrom, input.to);
  let other = 0;
  for (const d of input.unlinkedRevenueDeposits) {
    if (d.postedAt.getTime() >= effectiveFrom.getTime() && d.postedAt.getTime() <= input.to.getTime()) other += d.amountCents;
  }
  const processingFeesCents = netInRange(input.entries, ACCOUNT_FEES, effectiveFrom, input.to);
  const ledgerExpensesCents = input.ledgerExpenseLines.reduce((s, l) => s + l.cents, 0);
  const totalRevenueCents = invoicedRevenueCents - discountsCents + other;
  const totalExpensesCents = ledgerExpensesCents + processingFeesCents;
  return {
    basis: "accrual",
    effectiveFrom,
    to: input.to,
    partlyBeforeGoLive: partly,
    entirelyBeforeGoLive: false,
    revenueLines,
    invoicedRevenueCents,
    discountsCents,
    otherRevenueNotInvoicedCents: other,
    totalRevenueCents,
    expenseLines: [...input.ledgerExpenseLines],
    ledgerExpensesCents,
    processingFeesCents,
    totalExpensesCents,
    netCents: totalRevenueCents - totalExpensesCents,
  };
}
