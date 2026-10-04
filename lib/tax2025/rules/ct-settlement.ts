// CT-1040 lines 25, 27, 28, 29 and 30 (the settlement of the return), TY2025. Form text: specs/09 "CT-1040 lines 3-30".
//
//   25  refund = line 22 less lines 23, 24 and 24a. Lines 23 (applied to 2026 estimated tax), 24 (CHET) and 24a
//       (charities) are the owner's irrevocable elections: never computed, never guessed. Line 25 is informational
//       (not_yet_computed) whenever there is an overpayment, with the reason stating line 22 and the rule, so the
//       relationship stays visible; it is not_applicable 0 when there is none.
//   27 / 28  late payment penalty (10% of line 26) and interest (1% per month): a not_applicable 0 when line 26 is 0
//       (nothing is due, nothing to multiply); otherwise informational needs_cpa_rule_unverified (the month counting
//       and the minimum are not verified, specs/09).
//   29  interest on underpayment of estimated tax (Form CT-2210). CT-2210 page 1 / Part 2 line 4 and the CT-1040 instructions
//       (line 29): when line 14 less CT withholding (line 18) and the pass-through entity tax credit (line 20c) is under
//       $1,000 there is no such interest, so 0. At $1,000 or more the form is not modeled: informational
//       needs_cpa_rule_unverified (the filer may leave line 29 blank and DRS bills the interest).
//   30  line 26 + 27 + 28 + 29 (total amount due); informational when an input is informational.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt } from "@/lib/tax2025/money";
import { lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import { aggregateStatus, type RuleLine, type RuleResult } from "@/lib/tax2025/types";

export interface CtSettlementInput {
  /** CT-1040 line 14 (CT income tax after credits). */
  line14: Decimal;
  /** CT-1040 line 18 (CT withholding) and line 20c (pass-through entity tax credit). */
  line18: Decimal;
  line20c: Decimal;
  /** CT-1040 line 22 (overpayment) and line 26 (tax due); at most one is non-zero. */
  line22: Decimal;
  line26: Decimal;
}

const CITATIONS = ["CT_ESTIMATED_TAX_INTEREST_MIN", "CT_LATE_PAYMENT_PENALTY_RATE", "CT_INTEREST_RATE_PER_MONTH"];

const LATE_INFORMATIONAL =
  "Informational: the late-payment penalty rate (10%) and interest (1% per month) are verified, but the minimum penalty, the months to count and how the extension payment is treated are not, so no amount is estimated.";

export function computeCtSettlement(input: CtSettlementInput): RuleResult {
  const base = { ruleId: "ct-settlement", form: "CT-1040", citations: CITATIONS, inputsUsed: [] };
  const lines: RuleLine[] = [];
  const meta = (key: LineKey) => lineMeta(key);
  const na = (key: LineKey, reason: string): RuleLine => amountLine(key, meta(key).label, meta(key).formLine, ZERO, "not_applicable", reason);
  const info = (key: LineKey, status: "not_yet_computed" | "needs_cpa_rule_unverified", reason: string): RuleLine => ({
    ...blockedLine(key, meta(key).label, meta(key).formLine, status, reason),
    informational: true,
  });

  // Line 25: the refund (owner's elections on lines 23, 24 and 24a)
  if (input.line22.isZero()) {
    lines.push(na("ct1040.25", "There is no overpayment (line 22 is 0), so there is no refund."));
  } else {
    lines.push(
      info(
        "ct1040.25",
        "not_yet_computed",
        `Refund = line 22 less lines 23, 24 and 24a. With no election the refund is ${fmt(input.line22)} (line 22). Line 23 (apply to 2026 estimated tax), line 24 (CHET, Schedule CT-CHET) and line 24a (charities, Schedule 5) are the owner's irrevocable choices and are left blank; bank lines 25a-25d are never filled.`
      )
    );
  }

  // Lines 27 and 28
  if (input.line26.isZero()) {
    const reason = "Nothing is due (line 26 is 0), so there is no late payment penalty or interest to figure.";
    lines.push(na("ct1040.27", reason), na("ct1040.28", reason));
  } else {
    lines.push(info("ct1040.27", "needs_cpa_rule_unverified", LATE_INFORMATIONAL), info("ct1040.28", "needs_cpa_rule_unverified", LATE_INFORMATIONAL));
  }

  // Line 29: CT-2210 test
  const underpayTest = input.line14.minus(input.line18).minus(input.line20c);
  const threshold = D(K.CT_ESTIMATED_TAX_INTEREST_MIN.value);
  const testText = `CT-1040 line 14 ${fmt(input.line14)} less line 18 ${fmt(input.line18)} less line 20c ${fmt(input.line20c)} = ${fmt(underpayTest)}`;
  if (underpayTest.lessThan(threshold)) {
    lines.push(na("ct1040.29", `${testText}, under ${fmt(threshold)}: no interest on underpayment of estimated tax (Form CT-2210 Part 2 line 4; CT-1040 instructions, line 29).`));
  } else {
    lines.push(
      info(
        "ct1040.29",
        "needs_cpa_rule_unverified",
        `${testText}, ${fmt(threshold)} or more: interest on underpayment of estimated tax may be owed. Form CT-2210 is not modeled; the filer may leave line 29 blank and the Department of Revenue Services bills the interest.`
      )
    );
  }

  // Line 30 = 26 + 27 + 28 + 29 once every part has an amount
  const parts = lines.filter((l) => l.key === "ct1040.27" || l.key === "ct1040.28" || l.key === "ct1040.29");
  if (parts.every((l) => l.amount !== null)) {
    lines.push(amountLine("ct1040.30", meta("ct1040.30").label, meta("ct1040.30").formLine, input.line26, "computed", `Line 26 ${fmt(input.line26)} plus lines 27, 28 and 29 (all 0).`));
  } else {
    lines.push(
      info(
        "ct1040.30",
        "needs_cpa_rule_unverified",
        `Total amount due = line 26 (${fmt(input.line26)}) + line 27 + line 28 + line 29. Lines 27, 28 and 29 are not estimated, so the total is left for the CPA.`
      )
    );
  }
  // Informational lines never decide the rule status (aggregateStatus ignores them).
  return { ...base, status: aggregateStatus(lines), lines, reasons: [], inputsMissing: [] };
}
