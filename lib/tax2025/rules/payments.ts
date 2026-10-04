// Payments and withholding, TY2025: federal (1040 lines 25a-25d, 26, 31, 33,
// Schedule 3 lines 10, 11, 15) and Connecticut (CT-1040 lines 18, 19, 20).
//
// Fixes defect D2: the old engine treated one combined "federal + state estimated
// payments" figure as all federal. Here federal and CT estimates are separate
// inputs (a dated list each); the legacy combined figure can never be split, so it
// is not used for either side (the resolver turns it into a blocking open item).
// Estimates count for the tax year they APPLY to, whenever they were paid (a
// January 2026 payment can be a 2025 estimate); for Schedule A only payments MADE
// in 2025 count (cash basis, handled in schedule-a.ts via paidOn).
//
// Excess Social Security (Schedule 3 line 11): a person with more than one
// employer whose W-2 box 4 total exceeds the maximum Social Security tax for the
// year (6.2% x the wage base) is credited the excess; figured separately for each
// spouse. The 6.2% employee rate is derived as half of the verified 12.4% OASDI
// rate (Schedule SE line 10), not a separately hardcoded figure.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, roundLine, sumThenRound } from "@/lib/tax2025/money";
import { aggregateStatus, type LineKey, type RuleLine, type RuleResult } from "@/lib/tax2025/types";

// ── Excess Social Security ────────────────────────────────────────────────────

export interface PersonSsWithholding {
  /** Display name, e.g. "Eric". */
  name: string;
  /** Number of W-2s (employers) for this person. */
  w2Count: number;
  /** Sum of W-2 box 4; null = at least one box 4 not read. */
  totalWithheld: Decimal | null;
}

/** Maximum employee Social Security tax for the year: wage base x half the 12.4% OASDI rate (exact dollars and cents). */
export function maxEmployeeSocialSecurityTax(): Decimal {
  return D(K.SE_WAGE_BASE.value).times(D(K.SE_OASDI_RATE.value).div(2));
}

export function computeExcessSocialSecurity(input: {
  people: PersonSsWithholding[];
  /** W-2s that no person is assigned to (their box 4 cannot be attributed). */
  unattributedW2Count: number;
}): RuleResult {
  const base = { ruleId: "excess-social-security", form: "Schedule 3", citations: ["SE_WAGE_BASE", "SE_OASDI_RATE", "SCH3_LINE_MAP"], inputsUsed: [] };
  const label = "Excess Social Security tax withheld";
  if (input.unattributedW2Count > 0) {
    const reason = `${input.unattributedW2Count} W-2(s) have no person assigned, so Social Security withheld cannot be attributed to a spouse (the excess is figured per spouse).`;
    return {
      ...base,
      status: "missing_input",
      lines: [blockedLine("sch3.11", label, "Sch 3 line 11", "missing_input", reason)],
      reasons: [reason],
      inputsMissing: ["person on every W-2"],
    };
  }
  const cap = maxEmployeeSocialSecurityTax();
  const parts: Decimal[] = [];
  const reasons: string[] = [];
  const missing: string[] = [];
  for (const p of input.people) {
    if (p.w2Count <= 1) continue; // a single employer must refund an over-withholding itself
    if (p.totalWithheld === null) {
      missing.push(`Social Security tax withheld (W-2 box 4) for ${p.name}`);
      continue;
    }
    const excess = maxD(ZERO, p.totalWithheld.minus(cap));
    parts.push(excess);
    reasons.push(
      `${p.name}: ${p.w2Count} employers, Social Security tax withheld ${fmt(p.totalWithheld)} against the ${fmt(cap)} maximum: excess ${fmt(excess)}.`
    );
  }
  if (missing.length > 0) {
    const reason = `Excess Social Security cannot be figured: missing ${missing.join(", ")}.`;
    return {
      ...base,
      status: "missing_input",
      lines: [blockedLine("sch3.11", label, "Sch 3 line 11", "missing_input", reason)],
      reasons: [reason],
      inputsMissing: missing,
    };
  }
  if (reasons.length === 0) reasons.push("No spouse has more than one employer: no excess Social Security credit.");
  return {
    ...base,
    status: "computed",
    lines: [amountLine("sch3.11", label, "Sch 3 line 11", sumThenRound(parts))],
    reasons,
    inputsMissing: [],
  };
}

// ── Federal payments ──────────────────────────────────────────────────────────

export interface FederalPaymentsInput {
  /** Sum of W-2 box 2; null = at least one W-2 has no box 2 read. */
  w2Withheld: Decimal | null;
  /** True when there is at least one W-2 (no W-2 at all means withholding is unknown, not 0). */
  hasW2: boolean;
  /** 1099 box 4 federal withholding (interest + dividends), 0 when none. */
  form1099Withheld: Decimal;
  /** Form 8959 line 24 (to line 25c); null = missing / not computed. */
  additionalMedicareWithheld: Decimal | null;
  /** Estimated payments applying to 2025; null = unknown. */
  estimates: Decimal | null;
  /** 2024 overpayment applied to 2025; null = unknown. */
  priorYearOverpaymentApplied: Decimal | null;
  /** Form 4868 payment; null = unknown. */
  extensionPayment: Decimal | null;
  /** Schedule 3 line 11 from computeExcessSocialSecurity; null = missing. */
  excessSocialSecurity: Decimal | null;
}

const FED_CITATIONS = ["SCH3_LINE_MAP"];

export function computeFederalPayments(input: FederalPaymentsInput): RuleResult {
  const base = { ruleId: "payments-federal", form: "Form 1040", citations: FED_CITATIONS, inputsUsed: [] };
  const lines: RuleLine[] = [];
  const missing: string[] = [];
  const reasons: string[] = [];
  const blocked = (key: LineKey, lbl: string, formLine: string, reason: string) =>
    blockedLine(key, lbl, formLine, "missing_input", reason);

  // 25a W-2 withholding
  let l25a: Decimal | null = null;
  if (!input.hasW2) {
    lines.push(blocked("f1040.25a", "Federal income tax withheld from W-2s", "25a", "No W-2 is on file, so federal withholding is unknown (not 0)."));
    missing.push("W-2 documents");
  } else if (input.w2Withheld === null) {
    lines.push(blocked("f1040.25a", "Federal income tax withheld from W-2s", "25a", "A W-2 has no federal withholding (box 2) read."));
    missing.push("W-2 box 2");
  } else {
    l25a = roundLine(input.w2Withheld);
    lines.push(amountLine("f1040.25a", "Federal income tax withheld from W-2s", "25a", l25a));
  }
  // 25b 1099 withholding
  const l25b = roundLine(input.form1099Withheld);
  lines.push(amountLine("f1040.25b", "Federal income tax withheld from 1099s", "25b", l25b));
  // 25c from Form 8959
  let l25c: Decimal | null = null;
  if (input.additionalMedicareWithheld === null) {
    lines.push(blocked("f1040.25c", "Additional Medicare Tax withheld (Form 8959 line 24)", "25c", "Form 8959 is not computed (missing input)."));
    missing.push("Form 8959 line 24");
  } else {
    l25c = roundLine(input.additionalMedicareWithheld);
    lines.push(amountLine("f1040.25c", "Additional Medicare Tax withheld (Form 8959 line 24)", "25c", l25c));
  }
  // 25d
  if (l25a !== null && l25c !== null) {
    lines.push(amountLine("f1040.25d", "Total federal income tax withheld", "25d", l25a.plus(l25b).plus(l25c)));
  } else {
    lines.push(blocked("f1040.25d", "Total federal income tax withheld", "25d", "A withholding line is missing."));
  }
  // 26 estimated payments + prior-year overpayment applied
  let l26: Decimal | null = null;
  if (input.estimates === null || input.priorYearOverpaymentApplied === null) {
    const what = [
      input.estimates === null ? "federal estimated payments for 2025" : null,
      input.priorYearOverpaymentApplied === null ? "2024 overpayment applied to 2025" : null,
    ].filter((x): x is string => x !== null);
    lines.push(
      blocked(
        "f1040.26",
        "Estimated tax payments and 2024 overpayment applied",
        "26",
        `Missing ${what.join(" and ")}. The single combined "federal + state" figure cannot be split, so federal and Connecticut payments must be entered separately.`
      )
    );
    missing.push(...what);
  } else {
    l26 = sumThenRound([input.estimates, input.priorYearOverpaymentApplied]);
    lines.push(amountLine("f1040.26", "Estimated tax payments and 2024 overpayment applied", "26", l26));
  }
  // Schedule 3 lines 10, 11, 15 -> 1040 line 31
  let l10: Decimal | null = null;
  if (input.extensionPayment === null) {
    lines.push(blocked("sch3.10", "Amount paid with the extension request (Form 4868)", "Sch 3 line 10", "The amount paid with Form 4868 is not stated."));
    missing.push("amount paid with Form 4868");
  } else {
    l10 = roundLine(input.extensionPayment);
    lines.push(amountLine("sch3.10", "Amount paid with the extension request (Form 4868)", "Sch 3 line 10", l10));
  }
  const l11 = input.excessSocialSecurity === null ? null : roundLine(input.excessSocialSecurity);
  if (l11 === null) {
    lines.push(blocked("sch3.11", "Excess Social Security tax withheld", "Sch 3 line 11", "Excess Social Security is not computed (see its rule)."));
    missing.push("excess Social Security");
  } else {
    lines.push(amountLine("sch3.11", "Excess Social Security tax withheld", "Sch 3 line 11", l11));
  }
  let l31: Decimal | null = null;
  if (l10 !== null && l11 !== null) {
    l31 = l10.plus(l11);
    lines.push(amountLine("sch3.15", "Total other payments and refundable credits (Schedule 3 Part II)", "Sch 3 line 15", l31));
    lines.push(amountLine("f1040.31", "Amounts from Schedule 3, line 15", "31", l31));
    reasons.push(
      "Schedule 3 Part II counts only the extension payment and excess Social Security; no premium tax credit, fuel credit or other refundable credit is stated or modeled."
    );
  } else {
    lines.push(blocked("sch3.15", "Total other payments and refundable credits (Schedule 3 Part II)", "Sch 3 line 15", "A Schedule 3 payment line is missing."));
    lines.push(blocked("f1040.31", "Amounts from Schedule 3, line 15", "31", "A Schedule 3 payment line is missing."));
  }
  // 33 total payments (25d + 26 + 31; no other refundable credits modeled)
  if (l25a !== null && l25c !== null && l26 !== null && l31 !== null) {
    lines.push(amountLine("f1040.33", "Total payments", "33", l25a.plus(l25b).plus(l25c).plus(l26).plus(l31)));
  } else {
    lines.push(blocked("f1040.33", "Total payments", "33", "A payment line is missing."));
  }

  return { ...base, status: aggregateStatus(lines), lines, reasons, inputsMissing: missing };
}

// ── Connecticut payments ──────────────────────────────────────────────────────

export interface CtPaymentsInput {
  /** CT income tax withheld (W-2 box 17 CT lines + paystubs); null = not read. */
  withholding: Decimal | null;
  /**
   * The exact amount of each W-2 (the Column C rows 18a-18e). The CT W-2 instruction asks for each box 17 amount "in whole
   * dollars" in Column C and line 18 adds Column C, so line 18 is the sum of the rounded rows, not the rounded sum (they
   * differ by $1 when the cents do not cancel). Omitted/null: line 18 is the rounded `withholding`.
   */
  withholdingRows?: readonly Decimal[] | null;
  hasW2: boolean;
  /** CT estimated payments applying to 2025 plus 2024 overpayment applied; null parts = unknown. */
  estimates: Decimal | null;
  priorYearOverpaymentApplied: Decimal | null;
  /** CT-1040 EXT payment; null = unknown. */
  extensionPayment: Decimal | null;
}

export function computeCtPayments(input: CtPaymentsInput): RuleResult {
  const base = { ruleId: "payments-ct", form: "CT-1040", citations: [], inputsUsed: [] };
  const lines: RuleLine[] = [];
  const missing: string[] = [];
  const miss = (key: LineKey, lbl: string, formLine: string, reason: string) =>
    blockedLine(key, lbl, formLine, "missing_input", reason);

  if (!input.hasW2 || input.withholding === null) {
    lines.push(miss("ct1040.18", "Connecticut income tax withheld", "18", "CT withholding (W-2 box 17) is not available for every W-2."));
    missing.push("CT withholding");
  } else {
    const rows = input.withholdingRows ?? null;
    if (rows !== null && rows.length > 0) {
      const line18 = rows.reduce((acc, r) => acc.plus(roundLine(r)), ZERO);
      lines.push(
        amountLine("ct1040.18", "Connecticut income tax withheld", "18", line18, "computed", "Sum of the whole-dollar Column C entries (one per W-2, each rounded to the nearest dollar), as the form's line 18 adds Column C.")
      );
    } else {
      lines.push(amountLine("ct1040.18", "Connecticut income tax withheld", "18", roundLine(input.withholding)));
    }
  }
  if (input.estimates === null || input.priorYearOverpaymentApplied === null) {
    lines.push(
      miss(
        "ct1040.19",
        "2025 estimated tax payments and 2024 overpayment applied",
        "19",
        "Connecticut estimated payments (including 2025 estimates paid in 2026) and any 2024 overpayment applied are not stated."
      )
    );
    missing.push("CT estimated payments / overpayment applied");
  } else {
    lines.push(
      amountLine(
        "ct1040.19",
        "2025 estimated tax payments and 2024 overpayment applied",
        "19",
        sumThenRound([input.estimates, input.priorYearOverpaymentApplied])
      )
    );
  }
  if (input.extensionPayment === null) {
    lines.push(miss("ct1040.20", "Payment made with Form CT-1040 EXT", "20", "The CT extension payment is not stated."));
    missing.push("CT-1040 EXT payment");
  } else {
    lines.push(amountLine("ct1040.20", "Payment made with Form CT-1040 EXT", "20", roundLine(input.extensionPayment)));
  }
  return { ...base, status: aggregateStatus(lines), lines, reasons: [], inputsMissing: missing };
}
