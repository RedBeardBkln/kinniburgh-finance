import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { computePersonalTaxReturn, SALT_CAP_MFJ_2025 } from "../tax-compute";
import {
  formatTaxDollars,
  describeBalance,
  serializeTaxComputeResult,
  isPromotedTaxQuestion,
  PROMOTED_TAX_QUESTION_KEYS,
} from "../tax-compute-display";

const D = (s: string) => new Decimal(s);
const d = (iso: string) => new Date(iso + "T00:00:00Z");

// ── formatTaxDollars ──────────────────────────────────────────────────────────

describe("formatTaxDollars", () => {
  it("formats a plain decimal with 2 places", () => {
    expect(formatTaxDollars(D("1234.5"))).toBe("$1,234.50");
  });

  it("formats zero", () => {
    expect(formatTaxDollars(D("0"))).toBe("$0.00");
  });

  it("comma-groups large numbers", () => {
    expect(formatTaxDollars(D("1000000"))).toBe("$1,000,000.00");
  });

  it("preserves a negative sign (defensive — most callers pass non-negative Decimals)", () => {
    expect(formatTaxDollars(D("-500"))).toBe("-$500.00");
  });
});

// ── describeBalance ────────────────────────────────────────────────────────────

describe("describeBalance", () => {
  it("positive -> Refund", () => {
    expect(describeBalance(D("500"))).toEqual({ label: "Refund", amountFormatted: "$500.00" });
  });

  it("negative -> Balance due, absolute value formatted (sign lives in the label)", () => {
    expect(describeBalance(D("-750"))).toEqual({ label: "Balance due", amountFormatted: "$750.00" });
  });

  it("zero -> Even", () => {
    expect(describeBalance(D("0"))).toEqual({ label: "Even", amountFormatted: "$0.00" });
  });

  it("null -> Not computable", () => {
    expect(describeBalance(null)).toEqual({ label: "Not computable", amountFormatted: null });
  });
});

// ── isPromotedTaxQuestion ────────────────────────────────────────────────────

describe("isPromotedTaxQuestion", () => {
  it.each(PROMOTED_TAX_QUESTION_KEYS)("'%s' is promoted", (key) => {
    expect(isPromotedTaxQuestion(key)).toBe(true);
  });

  it("a pre-existing narrative (non-structured) counterpart key is not promoted", () => {
    expect(isPromotedTaxQuestion("retirement_contributions")).toBe(false);
    expect(isPromotedTaxQuestion("estimated_taxes_2025")).toBe(false);
  });

  it("an arbitrary unknown key is not promoted", () => {
    expect(isPromotedTaxQuestion("some_unrelated_key")).toBe(false);
  });
});

// ── serializeTaxComputeResult ────────────────────────────────────────────────
// Fixtures built by actually calling the real, already-approved
// computePersonalTaxReturn (not a hand-rolled fake TaxComputeResult) —
// guards against type-shape drift and reuses the already-proven-correct
// engine rather than re-deriving expected numbers independently.

describe("serializeTaxComputeResult", () => {
  it("(a) golden-path input producing a federal refund and a CT refund", () => {
    const result = computePersonalTaxReturn({
      taxYear: 2025,
      wages: D("90000"),
      medicareWages: D("90000"),
      interestIncome: D("1000"),
      glIncomeTotal: D("80000"),
      glExpenseTotal: D("30000"),
      mileageEntries: [{ miles: 1000, ratePerMile: D("0.70"), date: d("2025-03-01") }],
      homeOfficeSqft: 200,
      mortgageInterestCents: 1_200_000,
      propertyTaxCents: 800_000,
      ctIncomeTaxWithheldCents: 600_000,
      charitableCents: 100_000,
      saltCapCents: SALT_CAP_MFJ_2025 * 100,
      // Bumped from the engine's own "golden path" test's $15,000 to $20,000
      // federal withholding (all else identical) specifically so the federal
      // balance flips to a Refund for this fixture — see (b) below for the
      // negative/Balance-due path using the engine test's own original figure.
      federalWithholdingCents: 2_000_000,
      estimatedPaymentsCents: 200_000,
      ctWithholdingCents: 700_000,
    });

    // Sanity-check the engine's own intermediate figures this fixture relies
    // on (hand-computed from lib/tax-compute.ts's own already-proven-correct
    // arithmetic, cross-checked against the engine's own "golden path" test
    // which uses the identical input except for federalWithholdingCents).
    expect(result.federal.balanceDueOrRefundBeforeCredits.toString()).toBe("4285.101709");
    expect(result.connecticut.balanceDueOrRefund!.toString()).toBe("626.175747875");

    const serialized = serializeTaxComputeResult(result);

    expect(serialized).toEqual({
      taxYear: 2025,
      scheduleC: {
        mileageDeduction: "$700.00",
        homeOfficeDeduction: "$1,000.00",
        netProfit: "$48,300.00",
      },
      federal: {
        totalIncome: "$139,300.00",
        agiUpperBound: "$135,887.71",
        deductionMethod: "standard",
        deductionUsed: "$31,500.00",
        taxableIncome: "$94,727.71",
        selfEmploymentTax: "$6,824.57",
        additionalMedicareTax: "$0.00",
        qbiDeduction: "$9,660.00",
        totalTaxBeforeCredits: "$17,714.90",
        totalPayments: "$22,000.00",
        balance: { label: "Refund", amountFormatted: "$4,285.10" },
      },
      connecticut: {
        ctAGI: "$135,887.71",
        ctTaxableIncome: "$135,887.71",
        ctTaxComputed: "$6,373.82",
        ctWithholding: "$7,000.00",
        balance: { label: "Refund", amountFormatted: "$626.18" },
      },
      gaps: result.gaps,
    });
  });

  it("(b) lower withholding produces a federal balance due — proves the negative-balance path renders 'Balance due' end-to-end", () => {
    const result = computePersonalTaxReturn({
      taxYear: 2025,
      wages: D("90000"),
      medicareWages: D("90000"),
      interestIncome: D("1000"),
      glIncomeTotal: D("80000"),
      glExpenseTotal: D("30000"),
      mileageEntries: [{ miles: 1000, ratePerMile: D("0.70"), date: d("2025-03-01") }],
      homeOfficeSqft: 200,
      mortgageInterestCents: 1_200_000,
      propertyTaxCents: 800_000,
      ctIncomeTaxWithheldCents: 600_000,
      charitableCents: 100_000,
      saltCapCents: SALT_CAP_MFJ_2025 * 100,
      federalWithholdingCents: 1_500_000,
      estimatedPaymentsCents: 200_000,
      ctWithholdingCents: 700_000,
    });

    expect(result.federal.balanceDueOrRefundBeforeCredits.toString()).toBe("-714.898291");

    const serialized = serializeTaxComputeResult(result);

    expect(serialized.federal.balance).toEqual({ label: "Balance due", amountFormatted: "$714.90" });
    expect(serialized.federal.totalPayments).toBe("$17,000.00");
  });

  it("(c) passes gaps through verbatim — same array contents, not re-derived or filtered", () => {
    const result = computePersonalTaxReturn({
      taxYear: 2025,
      wages: D("280000"),
      medicareWages: D("280000"),
      interestIncome: D("0"),
      glIncomeTotal: D("0"),
      glExpenseTotal: D("0"),
      mileageEntries: [],
      homeOfficeSqft: null,
      mortgageInterestCents: 0,
      propertyTaxCents: 0,
      ctIncomeTaxWithheldCents: 0,
      charitableCents: null,
      saltCapCents: SALT_CAP_MFJ_2025 * 100,
      federalWithholdingCents: 0,
      estimatedPaymentsCents: null,
      ctWithholdingCents: 0,
    });

    const serialized = serializeTaxComputeResult(result);

    expect(serialized.gaps).toEqual(result.gaps);
    expect(serialized.gaps.length).toBeGreaterThan(0);
    expect(serialized.gaps).toContain("home office square footage not captured — $0 deduction assumed");
  });

  it("CT balance renders 'Not computable' when ctTaxComputed is null (defensive path)", () => {
    // No live/reachable input produces this today (both CT tables are fully
    // transcribed) — exercised directly against describeBalance/formatting
    // logic rather than trying to force computePersonalTaxReturn into the
    // unreachable branch.
    expect(describeBalance(null)).toEqual({ label: "Not computable", amountFormatted: null });
  });
});
