// Qualified business income deduction (section 199A), Form 8995, TY2025, MFJ.
//
// Fixes defect D5 relative to lib/tax-compute.ts computeQBIDeduction:
//   - the QBI base is Schedule C net profit NET OF the deductible half of SE tax,
//     SE health insurance and SE retirement contributions (Form 8995 instructions);
//   - the 20%-of-taxable-income cap is figured on taxable income before QBI MINUS
//     net capital gain (qualified dividends + capital gain), line 12/13/14;
//   - section 199A dividends (1099-DIV box 5, REIT) go on line 6 (verified form
//     structure);
//   - no linear interpolation: above the Form 8995 limit the form is not allowed
//     and the result is needs_cpa_judgment with the X3 alternatives (8995-A needs
//     W-2 wages / UBIA / SSTB data this app does not capture).
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD, roundLine } from "@/lib/tax2025/money";
import {
  aggregateStatus,
  type Decided,
  type RuleAlternative,
  type RuleDecision,
  type RuleLine,
  type RuleResult,
} from "@/lib/tax2025/types";

export interface Qbi8995Input {
  /** Schedule C line 31 (whole dollars); null = missing. */
  scheduleCNetProfit: Decimal | null;
  /** Schedule 1 line 15 (deductible half of SE tax); null = missing. */
  deductibleHalfSeTax: Decimal | null;
  /** Schedule 1 line 17, SE health insurance; null = not stated (missing, never 0). */
  seHealthInsurance: Decimal | null;
  /** Schedule 1 line 16, SEP / SIMPLE / qualified plan contributions; null = not stated. */
  seRetirement: Decimal | null;
  /** 1040 line 11b - line 12 - line 13b (floored at 0); null = missing. */
  taxableIncomeBeforeQbi: Decimal | null;
  /** 1040 line 3a. */
  qualifiedDividends: Decimal | null;
  /** Net capital gain (capital gain distributions when no Schedule D is required). */
  netCapitalGain: Decimal | null;
  /** 1099-DIV box 5 section 199A dividends (REIT), whole dollars. */
  section199aDividends: Decimal | null;
  /** X3 decision. */
  decision?: Decided<"8995" | "8995a">;
}

const CITATIONS = ["QBI_RATE", "QBI_8995_THRESHOLD_MFJ"];

export function computeQbi8995(input: Qbi8995Input): RuleResult {
  const base = { ruleId: "qbi-8995", form: "Form 8995", citations: CITATIONS, inputsUsed: [] };

  const missing: string[] = [];
  if (input.scheduleCNetProfit === null) missing.push("Schedule C net profit");
  if (input.deductibleHalfSeTax === null) missing.push("deductible half of SE tax");
  if (input.seHealthInsurance === null) missing.push("self-employed health insurance amount (stated; none = 0)");
  if (input.seRetirement === null) missing.push("self-employed retirement contributions (stated; none = 0)");
  if (input.taxableIncomeBeforeQbi === null) missing.push("taxable income before the QBI deduction");
  if (input.qualifiedDividends === null) missing.push("qualified dividends");
  if (input.netCapitalGain === null) missing.push("net capital gain");
  if (input.section199aDividends === null) missing.push("section 199A dividends (1099-DIV box 5)");

  if (
    missing.length > 0 ||
    input.scheduleCNetProfit === null ||
    input.deductibleHalfSeTax === null ||
    input.seHealthInsurance === null ||
    input.seRetirement === null ||
    input.taxableIncomeBeforeQbi === null ||
    input.qualifiedDividends === null ||
    input.netCapitalGain === null ||
    input.section199aDividends === null
  ) {
    const reason = `The QBI deduction cannot be figured: missing ${missing.join(", ")}.`;
    return {
      ...base,
      status: "missing_input",
      lines: [blockedLine("f1040.13a", "Qualified business income deduction", "13a", "missing_input", reason)],
      reasons: [reason],
      inputsMissing: missing,
    };
  }

  const tiBefore = roundLine(maxD(ZERO, input.taxableIncomeBeforeQbi));
  const limit = D(K.QBI_8995_THRESHOLD_MFJ.value);

  // ── Above the Form 8995 limit: 8995-A territory (X3) ───────────────────────
  if (tiBefore.greaterThan(limit)) {
    const reason = `Taxable income before the QBI deduction (${fmt(tiBefore)}) is over ${fmt(limit)}, so Form 8995 cannot be used. Form 8995-A needs W-2 wages paid by the business, the unadjusted basis of qualified property and whether the business is a specified service trade or business; none of that is captured, so no deduction is estimated and no phase-in is interpolated.`;
    const decision: RuleDecision = {
      id: "X3",
      label: "QBI form: Form 8995 (not allowed at this income) or Form 8995-A",
      chosen: input.decision?.chosen ?? "8995a",
      status: input.decision ? "decided" : "default_undecided",
      ...(input.decision ? { decidedBy: input.decision.by, decidedAt: input.decision.at } : {}),
    };
    const alternatives: RuleAlternative[] = [
      {
        id: "8995",
        label: "Form 8995 (simplified)",
        status: "needs_cpa_judgment",
        isDefault: false,
        inForce: decision.chosen === "8995",
        lines: [],
        effect: null,
        reasons: [`Not allowed: taxable income before QBI is over ${fmt(limit)}.`],
      },
      {
        id: "8995a",
        label: "Form 8995-A",
        status: "missing_input",
        isDefault: true,
        inForce: decision.chosen === "8995a",
        lines: [],
        effect: null,
        reasons: ["Inputs missing: W-2 wages paid by EK Consulting, unadjusted basis of qualified property (UBIA), SSTB determination."],
      },
    ];
    return {
      ...base,
      status: "needs_cpa_judgment",
      lines: [blockedLine("f1040.13a", "Qualified business income deduction", "13a", "needs_cpa_judgment", reason)],
      reasons: [reason],
      inputsMissing: ["W-2 wages paid by EK Consulting", "UBIA of qualified property", "SSTB determination"],
      decision,
      alternatives,
    };
  }

  // ── Form 8995 ───────────────────────────────────────────────────────────────
  const netProfit = roundLine(input.scheduleCNetProfit);
  const line1 = netProfit
    .minus(roundLine(input.deductibleHalfSeTax))
    .minus(roundLine(input.seHealthInsurance))
    .minus(roundLine(input.seRetirement));
  const line2 = line1;
  const line4 = maxD(ZERO, line2); // prior-year QBI loss carryforward (line 3): not available, none assumed (see openItems)
  const line5 = roundLine(line4.times(K.QBI_RATE.value));
  const line6 = maxD(ZERO, roundLine(input.section199aDividends));
  const line9 = roundLine(line6.times(K.QBI_RATE.value));
  const line10 = line5.plus(line9);
  const line11 = tiBefore;
  const line12 = roundLine(input.qualifiedDividends.plus(maxD(ZERO, input.netCapitalGain)));
  const line13 = maxD(ZERO, line11.minus(line12));
  const line14 = roundLine(line13.times(K.QBI_RATE.value));
  const line15 = minD(line10, line14);

  const lines: RuleLine[] = [
    amountLine("f8995.1i", "Qualified business income of EK Consulting (net of half of SE tax, SE health insurance, SE retirement)", "8995 line 1i(c)", line1),
    amountLine("f8995.2", "Total qualified business income or (loss)", "8995 line 2", line2),
    amountLine("f8995.4", "Total qualified business income (after loss carryforward, not below 0)", "8995 line 4", line4),
    amountLine("f8995.5", "QBI component (20%)", "8995 line 5", line5),
    amountLine("f8995.6", "Qualified REIT dividends and PTP income", "8995 line 6", line6),
    amountLine("f8995.8", "Total qualified REIT dividends and PTP income", "8995 line 8", line6),
    amountLine("f8995.9", "REIT and PTP component (20%)", "8995 line 9", line9),
    amountLine("f8995.10", "QBI deduction before the income limitation", "8995 line 10", line10),
    amountLine("f8995.11", "Taxable income before the QBI deduction", "8995 line 11", line11),
    amountLine("f8995.12", "Net capital gain (qualified dividends + capital gain)", "8995 line 12", line12),
    amountLine("f8995.13", "Taxable income minus net capital gain", "8995 line 13", line13),
    amountLine("f8995.14", "Income limitation (20% of line 13)", "8995 line 14", line14),
    amountLine("f8995.15", "Qualified business income deduction", "8995 line 15", line15),
    amountLine("f1040.13a", "Qualified business income deduction", "13a", line15),
  ];
  const reasons = [
    `Form 8995: Schedule C net profit ${fmt(netProfit)} minus half of SE tax ${fmt(roundLine(input.deductibleHalfSeTax))}, SE health insurance ${fmt(roundLine(input.seHealthInsurance))} and SE retirement ${fmt(roundLine(input.seRetirement))} = QBI ${fmt(line1)}; 20% = ${fmt(line5)}${line9.greaterThan(0) ? ` plus 20% of section 199A dividends ${fmt(line9)}` : ""}.`,
    `Income limitation: 20% x (taxable income before QBI ${fmt(line11)} minus net capital gain ${fmt(line12)}) = ${fmt(line14)}; the deduction is the smaller, ${fmt(line15)}.`,
  ];
  if (line1.lessThan(0)) {
    reasons.push(
      `QBI is negative (${fmt(line1)}): no deduction, and the loss carries forward to 2026 (the carryforward amount is not tracked here).`
    );
  }
  return { ...base, status: aggregateStatus(lines), lines, reasons, inputsMissing: [] };
}
