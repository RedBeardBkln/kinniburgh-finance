// Form 1040 lines 35a (refunded) and 36 (applied to 2026 estimated tax): the owner's decision X7.
// Form text: specs/09 "Overpayment: refund or apply to 2026". Arithmetic only; no tax constant.
//
//   line 34 = 0            no overpayment: both lines not_applicable 0 (no decision is raised)
//   no decision recorded   both lines blank (not_yet_computed, informational), decision X7 default_undecided
//   refund_all / apply_all / apply_amount:A   see rules/overpayment-split.ts
// "Lines 35a, 36, and 38 must equal line 34" (Form 1040 instructions, line 38): the amount available to split is line 34
// less the penalty printed on line 38 (a blank line 38 counts as 0: the IRS figures any penalty itself and bills it).
//
// Pure. Intentionally independent of the L2 oracle (lib/tax-review/l2), which restates the same sentence on its own.

import type { Decimal } from "@prisma/client/runtime/library";
import { ZERO, amountLine, fmt } from "@/lib/tax2025/money";
import { lineMeta } from "@/lib/tax2025/line-catalog";
import { buildOverpaymentSplit } from "@/lib/tax2025/rules/overpayment-split";
import { aggregateStatus, type DecidedOverpayment, type RuleResult } from "@/lib/tax2025/types";

export interface FederalOverpaymentInput {
  /** Form 1040 line 34 (the overpayment), whole dollars. */
  line34: Decimal;
  /** The amount printed on Form 1040 line 38 (whole dollars); null when that line is blank. */
  line38: Decimal | null;
  decision?: DecidedOverpayment;
}

export const FEDERAL_OVERPAYMENT_RULE_ID = "overpayment-federal";

/** True when a printed line 38 penalty is more than the overpayment (R4: line 37 does not carry the difference). */
export function federalPenaltyExceedsOverpayment(line34: Decimal, line38: Decimal | null): boolean {
  return line38 !== null && line34.greaterThan(ZERO) && line38.greaterThan(line34);
}

export function computeFederalOverpayment(input: FederalOverpaymentInput): RuleResult {
  const base = { ruleId: FEDERAL_OVERPAYMENT_RULE_ID, form: "Form 1040", citations: [], inputsUsed: [] };
  const refundMeta = lineMeta("f1040.35a");
  const appliedMeta = lineMeta("f1040.36");

  if (input.line34.isZero()) {
    const reason = "There is no overpayment (line 34 is 0), so nothing is refunded or applied to 2026.";
    const lines = [
      amountLine("f1040.35a", refundMeta.label, refundMeta.formLine, ZERO, "not_applicable", reason),
      amountLine("f1040.36", appliedMeta.label, appliedMeta.formLine, ZERO, "not_applicable", reason),
    ];
    return { ...base, status: aggregateStatus(lines), lines, reasons: [], inputsMissing: [] };
  }

  const out = buildOverpaymentSplit({
    decisionId: "X7",
    refundKey: "f1040.35a",
    appliedKey: "f1040.36",
    overpaymentWhere: "Form 1040 line 34",
    overpayment: input.line34,
    penaltyPrinted: input.line38,
    penaltyWhere: "line 38",
    decision: input.decision,
    formula: "Lines 35a, 36, and 38 must equal line 34 (Form 1040 instructions, line 38).",
    refundName: "line 35a",
    appliedName: "line 36",
    byHandNote:
      "Direct deposit (lines 35b to 35d) and Form 8888 are entered by hand; the IRS generally stops issuing paper checks (Form 1040 instructions, lines 35a through 35d).",
    irrevocableNote: "Once the return is filed the choice to apply an amount to 2026 cannot be changed (Form 1040 instructions, line 36).",
    refundExtra: input.line38 !== null && input.line38.greaterThan(ZERO)
      ? `The penalty on line 38 (${fmt(input.line38)}) is a Form 2210 estimate; the IRS may figure a different amount.`
      : "",
  });
  const lines = [out.refunded, out.applied];
  const blocked = out.tooMuch;
  const reasons = blocked ? [out.refunded.reason ?? ""] : [];
  return {
    ...base,
    status: blocked ? "missing_input" : aggregateStatus(lines),
    lines,
    reasons,
    inputsMissing: blocked ? ["a new X7 choice: the amount to apply is more than the overpayment now available"] : [],
    decision: out.decision,
    alternatives: out.alternatives,
  };
}
