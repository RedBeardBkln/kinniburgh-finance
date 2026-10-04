// Screens for Form 6251 (alternative minimum tax) and Form 8960 (net investment
// income tax), TY2025, MFJ. A screen answers one question: "does this return owe
// the tax?" and either concludes "no" with the numbers, or produces the amount, or
// says exactly why it cannot (needs_cpa_*). It is not a full Form 6251 / 8960.
//
// Form 6251 screen. AMTI = taxable income + the Schedule A taxes deduction (or the
// standard deduction when not itemizing; Form 6251 line 2a) + private activity
// bond interest (1099-INT box 9). Other AMT adjustments (ISO exercises, passive
// activity, depreciation differences ...) are not modeled and no input indicates
// any. Tentative minimum tax = 26% of the first $239,100 of AMTI over the
// exemption, 28% above. Not verified, so they return needs_cpa_rule_unverified:
// the exemption phase-out above $1,252,700, and Form 6251 Part III (the
// preferential-rate computation used when qualified dividends / capital gain are
// present). With preferential income present the screen treats the straight 26/28%
// figure as an UPPER BOUND on the tentative minimum tax: if even that is not above
// the regular tax there is no AMT; if it is, the CPA decides.
//
// Form 8960 screen. NIIT = 3.8% x the lesser of net investment income or the MAGI
// excess over $250,000 (MFJ). Below the threshold the conclusion is "no NIIT"
// whatever the investment income. Above it, net investment income is taken as the
// GROSS taxable interest + ordinary dividends + capital gain distributions (Form
// 8960 line 9 deductions are not modeled: an upper bound, said so on the line).
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD, roundLine } from "@/lib/tax2025/money";
import { aggregateStatus, type RuleLine, type RuleResult } from "@/lib/tax2025/types";

// ── Form 6251 ─────────────────────────────────────────────────────────────────

export interface AmtScreenInput {
  /** 1040 line 15. */
  taxableIncome: Decimal | null;
  /** true when itemizing (then the Schedule A SALT deduction is added back), false for the standard deduction. */
  itemizing: boolean | null;
  /** Schedule A line 5e when itemizing. */
  saltDeduction: Decimal | null;
  /** 1040 line 12 when taking the standard deduction. */
  standardDeduction: Decimal | null;
  /** 1099-INT box 9 private activity bond interest, whole dollars. */
  privateActivityBondInterest: Decimal | null;
  /** 1040 line 16. */
  regularTax: Decimal | null;
  /** True when qualified dividends or capital gain are on the return (Part III would apply). */
  hasPreferentialIncome: boolean | null;
}

const AMT_CITATIONS = [
  "AMT_EXEMPTION_MFJ",
  "AMT_PHASEOUT_START_MFJ",
  "AMT_28_PERCENT_THRESHOLD",
  "AMT_RATE_LOW",
  "AMT_RATE_HIGH",
];

export function computeAmtScreen(input: AmtScreenInput): RuleResult {
  const base = { ruleId: "amt-screen-6251", form: "Form 6251", citations: AMT_CITATIONS, inputsUsed: [] };
  const missing: string[] = [];
  if (input.taxableIncome === null) missing.push("taxable income (1040 line 15)");
  if (input.itemizing === null) missing.push("standard-versus-itemized result");
  else if (input.itemizing && input.saltDeduction === null) missing.push("Schedule A SALT deduction (line 5e)");
  else if (!input.itemizing && input.standardDeduction === null) missing.push("standard deduction");
  if (input.privateActivityBondInterest === null) missing.push("private activity bond interest (1099-INT box 9)");
  if (input.regularTax === null) missing.push("regular tax (1040 line 16)");
  if (input.hasPreferentialIncome === null) missing.push("qualified dividends / capital gain");

  if (
    missing.length > 0 ||
    input.taxableIncome === null ||
    input.itemizing === null ||
    input.privateActivityBondInterest === null ||
    input.regularTax === null ||
    input.hasPreferentialIncome === null
  ) {
    const reason = `The AMT screen cannot run: missing ${missing.join(", ")}.`;
    return {
      ...base,
      status: "missing_input",
      lines: [
        blockedLine("f6251.amt", "Alternative minimum tax", "6251 line 11", "missing_input", reason),
        blockedLine("sch2.2", "Alternative minimum tax", "Sch 2 (AMT)", "missing_input", reason),
      ],
      reasons: [reason],
      inputsMissing: missing,
    };
  }
  const addBack = input.itemizing ? input.saltDeduction : input.standardDeduction;
  if (addBack === null) {
    // unreachable (checked above) but keeps the type narrow without a non-null assertion
    return { ...base, status: "missing_input", lines: [], reasons: ["AMT add-back missing."], inputsMissing: ["AMT add-back"] };
  }

  const amti = roundLine(input.taxableIncome.plus(addBack).plus(input.privateActivityBondInterest));
  const phaseOutStart = D(K.AMT_PHASEOUT_START_MFJ.value);
  if (amti.greaterThan(phaseOutStart)) {
    const reason = `AMTI ${fmt(amti)} is above ${fmt(phaseOutStart)}, where the AMT exemption phases out; the reduction rate is not verified here, so the screen cannot conclude.`;
    return {
      ...base,
      status: "needs_cpa_rule_unverified",
      lines: [
        amountLine("f6251.amti", "Alternative minimum taxable income", "6251 line 4", amti),
        blockedLine("f6251.amt", "Alternative minimum tax", "6251 line 11", "needs_cpa_rule_unverified", reason),
        blockedLine("sch2.2", "Alternative minimum tax", "Sch 2 (AMT)", "needs_cpa_rule_unverified", reason),
      ],
      reasons: [reason],
      inputsMissing: [],
    };
  }
  const exemption = D(K.AMT_EXEMPTION_MFJ.value);
  const excess = maxD(ZERO, amti.minus(exemption));
  const lowPart = minD(excess, D(K.AMT_28_PERCENT_THRESHOLD.value));
  const highPart = maxD(ZERO, excess.minus(K.AMT_28_PERCENT_THRESHOLD.value));
  const tmt = roundLine(lowPart.times(K.AMT_RATE_LOW.value).plus(highPart.times(K.AMT_RATE_HIGH.value)));
  const regular = roundLine(input.regularTax);
  const lines: RuleLine[] = [
    amountLine("f6251.amti", "Alternative minimum taxable income", "6251 line 4", amti),
    amountLine("f6251.tmt", "Tentative minimum tax", "6251 line 10", tmt),
  ];

  if (tmt.lessThanOrEqualTo(regular)) {
    lines.push(
      amountLine("f6251.amt", "Alternative minimum tax", "6251 line 11", ZERO),
      amountLine("sch2.2", "Alternative minimum tax", "Sch 2 (AMT)", ZERO)
    );
    return {
      ...base,
      status: "computed",
      conclusion: "ineligible",
      lines,
      reasons: [
        `No AMT: tentative minimum tax ${fmt(tmt)} is not more than the regular tax ${fmt(regular)} (AMTI ${fmt(amti)}, exemption ${fmt(exemption)}${input.hasPreferentialIncome ? "; with qualified dividends / capital gain this straight 26%/28% figure is an upper bound, so the conclusion holds" : ""}). Other AMT adjustments are not modeled and no input indicates any.`,
      ],
      inputsMissing: [],
    };
  }
  if (input.hasPreferentialIncome) {
    const reason = `The straight 26%/28% tentative minimum tax ${fmt(tmt)} is above the regular tax ${fmt(regular)}, but qualified dividends / capital gain are present and Form 6251 Part III (preferential rates) is not verified here; the CPA must figure the AMT.`;
    lines.push(
      blockedLine("f6251.amt", "Alternative minimum tax", "6251 line 11", "needs_cpa_rule_unverified", reason),
      blockedLine("sch2.2", "Alternative minimum tax", "Sch 2 (AMT)", "needs_cpa_rule_unverified", reason)
    );
    return { ...base, status: "needs_cpa_rule_unverified", lines, reasons: [reason], inputsMissing: [] };
  }
  const amt = tmt.minus(regular);
  lines.push(
    amountLine("f6251.amt", "Alternative minimum tax", "6251 line 11", amt),
    amountLine("sch2.2", "Alternative minimum tax", "Sch 2 (AMT)", amt)
  );
  return {
    ...base,
    status: aggregateStatus(lines),
    conclusion: "eligible",
    lines,
    reasons: [
      `AMT applies: tentative minimum tax ${fmt(tmt)} exceeds the regular tax ${fmt(regular)} by ${fmt(amt)}. Connecticut then requires CT-6251 (not built: the CT AMT line is flagged for the CPA).`,
    ],
    inputsMissing: [],
  };
}

// ── Form 8960 ─────────────────────────────────────────────────────────────────

export interface NiitScreenInput {
  /** 1040 line 11a (MAGI: no foreign income exclusions modeled). */
  magi: Decimal | null;
  /** Gross taxable interest (1040 line 2b). */
  taxableInterest: Decimal | null;
  /** Ordinary dividends (1040 line 3b). */
  ordinaryDividends: Decimal | null;
  /**
   * Form 8960 line 5a: Form 1040 line 7a, SIGNED (capital gain distributions, net gain, or the capital loss limited to $3,000 by Schedule D
   * line 21, which reduces net investment income). The name predates Schedule D; the amount is the whole of line 7a.
   */
  capitalGainDistributions: Decimal | null;
  /** True when the return has investment income this engine does not compute (Section 1256 / 1099-DA / unread 1099-B, other 1099 boxes, K-1). */
  otherInvestmentIncomePresent: boolean;
}

const NIIT_CITATIONS = ["NIIT_RATE", "NIIT_THRESHOLD_MFJ"];

export function computeNiitScreen(input: NiitScreenInput): RuleResult {
  const base = { ruleId: "niit-screen-8960", form: "Form 8960", citations: NIIT_CITATIONS, inputsUsed: [] };
  if (
    input.magi === null ||
    input.taxableInterest === null ||
    input.ordinaryDividends === null ||
    input.capitalGainDistributions === null
  ) {
    const reason = "The NIIT screen needs AGI, interest, dividends and capital gain distributions.";
    return {
      ...base,
      status: "missing_input",
      lines: [
        blockedLine("f8960.niit", "Net investment income tax", "8960 line 17", "missing_input", reason),
        blockedLine("sch2.12", "Net investment income tax", "Sch 2 line 12", "missing_input", reason),
      ],
      reasons: [reason],
      inputsMissing: ["AGI", "interest / dividend / capital gain income"],
    };
  }
  const threshold = D(K.NIIT_THRESHOLD_MFJ.value);
  const magi = roundLine(input.magi);
  const excess = maxD(ZERO, magi.minus(threshold));
  // Form 8960 line 12: "If zero or less, enter -0-" (a limited capital loss can pull it below zero)
  const nii = maxD(ZERO, roundLine(input.taxableInterest.plus(input.ordinaryDividends).plus(input.capitalGainDistributions)));

  if (excess.isZero()) {
    const why = `No net investment income tax: MAGI ${fmt(magi)} is not over the ${fmt(threshold)} threshold.`;
    return {
      ...base,
      status: "computed",
      conclusion: "ineligible",
      lines: [
        amountLine("f8960.nii", "Net investment income", "8960 line 12", nii),
        amountLine("f8960.niit", "Net investment income tax", "8960 line 17", ZERO),
        amountLine("sch2.12", "Net investment income tax", "Sch 2 line 12", ZERO),
      ],
      reasons: [why],
      inputsMissing: [],
    };
  }
  if (input.otherInvestmentIncomePresent) {
    const reason = `MAGI ${fmt(magi)} is over ${fmt(threshold)} and the return has investment income this engine does not compute (1099-B / other boxes / K-1), so net investment income is incomplete; the CPA must figure Form 8960.`;
    return {
      ...base,
      status: "needs_cpa_judgment",
      lines: [
        amountLine("f8960.nii", "Net investment income (computed items only)", "8960 line 12", nii),
        blockedLine("f8960.niit", "Net investment income tax", "8960 line 17", "needs_cpa_judgment", reason),
        blockedLine("sch2.12", "Net investment income tax", "Sch 2 line 12", "needs_cpa_judgment", reason),
      ],
      reasons: [reason],
      inputsMissing: [],
    };
  }
  const niit = roundLine(minD(nii, excess).times(K.NIIT_RATE.value));
  return {
    ...base,
    status: "computed",
    conclusion: "eligible",
    lines: [
      amountLine("f8960.nii", "Net investment income", "8960 line 12", nii),
      amountLine("f8960.niit", "Net investment income tax", "8960 line 17", niit),
      amountLine("sch2.12", "Net investment income tax", "Sch 2 line 12", niit),
    ],
    reasons: [
      `NIIT: 3.8% of the lesser of net investment income ${fmt(nii)} or MAGI over the threshold ${fmt(excess)} = ${fmt(niit)}. Upper bound: Form 8960 line 9 deductions are not modeled.`,
    ],
    inputsMissing: [],
  };
}
