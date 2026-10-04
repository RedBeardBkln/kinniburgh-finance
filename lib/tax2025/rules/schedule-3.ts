// Schedule 3 (Additional Credits and Payments): the assembly check.
//
// The line values themselves come from the rules that own them (foreign tax credit
// line 1, saver's credit line 4, extension payment line 10, excess Social Security
// line 11, ...) and the totals (lines 7, 8, 14, 15) are plain sums in the return
// assembler (return.ts). This result records, with citations, how Part I and Part
// II came together and what is deliberately NOT a 2025 credit:
//   * line 5a / Form 5695: not a 2025 item for this household (the owner states the
//     solar system was installed in 2022 and the credit already taken); any carryforward
//     is read from the 2024 return by the CPA;
//   * child and dependent credits, clean vehicle credit: not applicable by the
//     owner's planning answers.
// Source of the line map: the 2025 Schedule 3 (f1040s3.pdf), verified 2026-10-03.
// It emits no lines (informational assembly), only reasons and citations.
//
// Pure.

import type { Decimal } from "@prisma/client/runtime/library";
import { fmt } from "@/lib/tax2025/money";
import type { RuleResult, RuleStatus } from "@/lib/tax2025/types";

export interface Schedule3Input {
  /** Final amount per Schedule 3 line (whole dollars) for the lines that matter here; null = not computed. */
  foreignTax: Decimal | null;
  savers: Decimal | null;
  total8: Decimal | null;
  extensionPayment: Decimal | null;
  excessSocialSecurity: Decimal | null;
  total15: Decimal | null;
  /** Statuses of the Part I / Part II totals. */
  total8Status: RuleStatus | undefined;
  total15Status: RuleStatus | undefined;
}

export function computeSchedule3Summary(input: Schedule3Input): RuleResult {
  const part = (name: string, v: Decimal | null): string => `${name} ${v === null ? "not computed" : fmt(v)}`;
  const reasons = [
    `Part I (nonrefundable credits, to Form 1040 line 20): ${part("foreign tax credit (line 1)", input.foreignTax)}; ${part("saver's credit (line 4)", input.savers)}; residential clean energy credit (line 5a) is not a 2025 item (installed 2022, credit already taken, owner statement); total (line 8) ${input.total8 === null ? "not computed" : fmt(input.total8)}.`,
    `Part II (other payments, to Form 1040 line 31): ${part("extension payment (line 10)", input.extensionPayment)}; ${part("excess Social Security (line 11)", input.excessSocialSecurity)}; total (line 15) ${input.total15 === null ? "not computed" : fmt(input.total15)}.`,
  ];
  const done = input.total8 !== null && input.total15 !== null;
  const status: RuleStatus = done ? "computed" : input.total8Status === "needs_cpa_judgment" || input.total15Status === "needs_cpa_judgment" ? "needs_cpa_judgment" : "missing_input";
  return {
    ruleId: "schedule-3",
    form: "Schedule 3",
    status,
    lines: [],
    reasons,
    citations: ["SCH3_LINE_MAP"],
    inputsUsed: [],
    inputsMissing: done ? [] : ["Schedule 3 line amounts that are not computed yet"],
    informational: true,
  };
}
