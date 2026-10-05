// Screen for Form 6251 (alternative minimum tax), TY2025, MFJ. A screen answers one question: "does this
// return owe the tax?" and either concludes "no" with the numbers, or produces the amount, or says exactly
// why it cannot (needs_cpa_*). It is not a full Form 6251. (Form 8960, the net investment income tax, is a
// full line-by-line rule: rules/form-8960.ts.)
//
// Form 6251 screen. AMTI is built the way the form builds it (Part I): line 1a = Form 1040 line 14 minus
// Schedule 1-A line 37 (the senior deduction is added back as a personal exemption, section 56(b)(5)(D));
// line 1b = Form 1040 line 11b minus line 1a (NOT floored: the form says "if less than zero, enter as a
// negative amount"); line 2a = the Schedule A taxes (line 7, which is line 5e plus other taxes) when
// itemizing, else Form 1040 line 12e; plus private activity bond interest (1099-INT box 9, line 2g).
// Other AMT adjustments (ISO exercises, passive
// activity, depreciation differences ...) are not modeled and no input indicates
// any. Tentative minimum tax = 26% of the first $239,100 of AMTI over the
// exemption, 28% above. Not verified, so they return needs_cpa_rule_unverified:
// the exemption phase-out above $1,252,700, and Form 6251 Part III (the
// preferential-rate computation used when qualified dividends / capital gain are
// present). With preferential income present the screen treats the straight 26/28%
// figure as an UPPER BOUND on the tentative minimum tax: if even that is not above
// the regular tax there is no AMT; if it is, the CPA decides.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD, roundLine } from "@/lib/tax2025/money";
import { aggregateStatus, type RuleLine, type RuleResult } from "@/lib/tax2025/types";

// ── Form 6251 ─────────────────────────────────────────────────────────────────

export interface AmtScreenInput {
  /** Form 1040 line 11b (adjusted gross income). */
  agi: Decimal | null;
  /** Form 1040 line 14 (total deductions: 12e + 13a + 13b). */
  deductionsLine14: Decimal | null;
  /** Schedule 1-A line 37 (the senior deduction), 0 when there is none; null = not known (a stated Schedule 1-A total that is not 0). */
  seniorDeduction: Decimal | null;
  /** true when itemizing (then the Schedule A taxes are added back), false for the standard deduction. */
  itemizing: boolean | null;
  /** Schedule A line 7 (taxes: line 5e plus line 6) when itemizing; Form 6251 line 2a. */
  scheduleATaxes: Decimal | null;
  /** 1040 line 12e when taking the standard deduction; Form 6251 line 2a. */
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
  "AMT_SENIOR_DEDUCTION_ADDBACK",
  "AMT_LINE_2A_TAXES",
];

export function computeAmtScreen(input: AmtScreenInput): RuleResult {
  const base = { ruleId: "amt-screen-6251", form: "Form 6251", citations: AMT_CITATIONS, inputsUsed: [] };
  const missing: string[] = [];
  if (input.agi === null) missing.push("adjusted gross income (1040 line 11b)");
  if (input.deductionsLine14 === null) missing.push("total deductions (1040 line 14)");
  if (input.seniorDeduction === null) missing.push("Schedule 1-A line 37 (the senior deduction)");
  if (input.itemizing === null) missing.push("standard-versus-itemized result");
  else if (input.itemizing && input.scheduleATaxes === null) missing.push("Schedule A taxes (line 7)");
  else if (!input.itemizing && input.standardDeduction === null) missing.push("standard deduction");
  if (input.privateActivityBondInterest === null) missing.push("private activity bond interest (1099-INT box 9)");
  if (input.regularTax === null) missing.push("regular tax (1040 line 16)");
  if (input.hasPreferentialIncome === null) missing.push("qualified dividends / capital gain");

  if (
    missing.length > 0 ||
    input.agi === null ||
    input.deductionsLine14 === null ||
    input.seniorDeduction === null ||
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
  const line2a = input.itemizing ? input.scheduleATaxes : input.standardDeduction;
  if (line2a === null) {
    // unreachable (checked above) but keeps the type narrow without a non-null assertion
    return { ...base, status: "missing_input", lines: [], reasons: ["AMT add-back missing."], inputsMissing: ["AMT add-back"] };
  }

  const line1a = roundLine(input.deductionsLine14.minus(input.seniorDeduction));
  const line1b = roundLine(input.agi).minus(line1a); // may be negative: the form says so
  const amti = roundLine(line1b.plus(line2a).plus(input.privateActivityBondInterest));
  const amtiHow = `AMTI ${fmt(amti)} = line 1b ${fmt(line1b)} (AGI ${fmt(roundLine(input.agi))} minus line 1a ${fmt(line1a)}, which is deductions ${fmt(roundLine(input.deductionsLine14))} minus the Schedule 1-A senior deduction ${fmt(roundLine(input.seniorDeduction))}) plus line 2a ${fmt(roundLine(line2a))} (${input.itemizing ? "Schedule A taxes, line 7" : "standard deduction, 1040 line 12e"}) plus private activity bond interest ${fmt(roundLine(input.privateActivityBondInterest))}.`;
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
      reasons: [reason, amtiHow],
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
    amountLine("f6251.tmt", "Tentative minimum tax", "6251 line 9", tmt),
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
        amtiHow,
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
    return { ...base, status: "needs_cpa_rule_unverified", lines, reasons: [reason, amtiHow], inputsMissing: [] };
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
      amtiHow,
    ],
    inputsMissing: [],
  };
}
