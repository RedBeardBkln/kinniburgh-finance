import { Decimal } from "@prisma/client/runtime/library";
import type { TaxComputeResult } from "@/lib/tax-compute";

// ── Display/formatting layer for the tax computation engine (TY2025) ────────
// Pure functions only — no DB, no "use server". This is the ONLY place a
// Decimal instance from lib/tax-compute.ts is touched; everything downstream
// (page props, client components) receives plain strings, matching this
// repo's confirmed RSC-to-client serialization convention.
//
// Dollar-native (NOT cents) formatter, mirroring lib/notifications.ts's own
// local dollar-native formatUSD precedent rather than lib/utils.ts's
// cents-native one (lib/tax-compute.ts's TaxComputeResult is entirely
// Decimal DOLLAR amounts, never cents).
//
// Ground rule 8 (CLAUDE.md): every figure surfaced through this module is a
// draft estimate for CPA review, never a filed number nor financial/tax
// advice — see DRAFT_LABEL below, rendered persistently by the UI layer.

export const DRAFT_LABEL = "DRAFT — before credits, not a filed number";

/**
 * Dollar-native (NOT cents) formatter. Always shows 2 decimals with comma
 * grouping; a negative Decimal renders with a leading "-" before the "$"
 * (defensive — most callers pass non-negative Decimals per the engine's own
 * `Decimal.max(0, ...)` floors, but this function must not silently drop a
 * sign if ever called with one).
 */
export function formatTaxDollars(d: Decimal): string {
  const sign = d.isNegative() ? "-" : "";
  const abs = d.abs().toFixed(2);
  const [wholePart, decimalPart] = abs.split(".");
  const withCommas = wholePart!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${withCommas}.${decimalPart}`;
}

export type BalanceLabel = "Refund" | "Balance due" | "Even" | "Not computable";

/**
 * `d === null` -> "Not computable" / `amountFormatted: null` (CT Table D/E's
 * defensive-only unreachable-in-practice case). `d.isZero()` -> "Even".
 * `d > 0` -> "Refund" (payments/withholding exceeded tax). `d < 0` ->
 * "Balance due". `amountFormatted` is always the ABSOLUTE value, formatted —
 * the label carries the sign meaning, never a bare negative number in the UI.
 */
export function describeBalance(d: Decimal | null): { label: BalanceLabel; amountFormatted: string | null } {
  if (d === null) return { label: "Not computable", amountFormatted: null };
  const amountFormatted = formatTaxDollars(d.abs());
  if (d.isZero()) return { label: "Even", amountFormatted };
  if (d.isNegative()) return { label: "Balance due", amountFormatted };
  return { label: "Refund", amountFormatted };
}

export interface SerializedTaxDraft {
  taxYear: number;
  scheduleC: { mileageDeduction: string; homeOfficeDeduction: string; netProfit: string };
  federal: {
    totalIncome: string;
    agiUpperBound: string; // label reinforced in the component, not renamed again here
    deductionMethod: "standard" | "itemized";
    deductionUsed: string;
    taxableIncome: string;
    selfEmploymentTax: string;
    additionalMedicareTax: string;
    qbiDeduction: string;
    totalTaxBeforeCredits: string;
    totalPayments: string;
    balance: { label: BalanceLabel; amountFormatted: string | null };
  };
  connecticut: {
    ctAGI: string;
    ctTaxableIncome: string;
    ctTaxComputed: string | null;
    ctWithholding: string;
    balance: { label: BalanceLabel; amountFormatted: string | null };
  };
  gaps: string[]; // computePersonalTaxReturn's own gaps array, passed through verbatim
}

/**
 * Converts every Decimal in a TaxComputeResult to a formatted display
 * string — the ONLY place a Decimal instance from lib/tax-compute.ts is
 * touched; nothing downstream (the page's props, the client component) ever
 * receives a Decimal or Date instance.
 */
export function serializeTaxComputeResult(result: TaxComputeResult): SerializedTaxDraft {
  return {
    taxYear: result.taxYear,
    scheduleC: {
      mileageDeduction: formatTaxDollars(result.scheduleC.mileage.deduction),
      homeOfficeDeduction: formatTaxDollars(result.scheduleC.homeOfficeSimplifiedDeduction),
      netProfit: formatTaxDollars(result.scheduleC.netProfit),
    },
    federal: {
      totalIncome: formatTaxDollars(result.federal.totalIncome),
      agiUpperBound: formatTaxDollars(result.federal.agiUpperBound),
      deductionMethod: result.federal.deductionMethod,
      deductionUsed: formatTaxDollars(result.federal.deductionUsed),
      taxableIncome: formatTaxDollars(result.federal.taxableIncome),
      selfEmploymentTax: formatTaxDollars(result.federal.selfEmploymentTax.totalSETax),
      additionalMedicareTax: formatTaxDollars(result.federal.additionalMedicareTax),
      qbiDeduction: formatTaxDollars(result.federal.qbi.deduction),
      totalTaxBeforeCredits: formatTaxDollars(result.federal.totalTaxBeforeCredits),
      totalPayments: formatTaxDollars(result.federal.totalPayments),
      balance: describeBalance(result.federal.balanceDueOrRefundBeforeCredits),
    },
    connecticut: {
      ctAGI: formatTaxDollars(result.connecticut.ctAGI),
      ctTaxableIncome: formatTaxDollars(result.connecticut.ctTaxableIncome),
      ctTaxComputed:
        result.connecticut.ctTaxComputed === null ? null : formatTaxDollars(result.connecticut.ctTaxComputed),
      ctWithholding: formatTaxDollars(result.connecticut.ctWithholding),
      balance: describeBalance(result.connecticut.balanceDueOrRefund),
    },
    gaps: result.gaps,
  };
}

/**
 * The 3 code-ready structured questions this task's predecessor added — used
 * only to SORT them to the top of the existing unanswered-questions list
 * (never to change which questions render; that's still driven entirely by
 * real TaxQuestion rows, per the existing component).
 */
export const PROMOTED_TAX_QUESTION_KEYS = [
  "home_office_sqft",
  "retirement_contribution_amount",
  "estimated_tax_payments_amount",
] as const;

export function isPromotedTaxQuestion(key: string): boolean {
  return (PROMOTED_TAX_QUESTION_KEYS as readonly string[]).includes(key);
}
