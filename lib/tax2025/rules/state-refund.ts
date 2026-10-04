// Schedule 1 line 1: taxable refunds, credits or offsets of state and local income taxes.
// Source: the 2025 Instructions for Form 1040, Schedule 1 line 1 and the "State and Local Income
// Tax Refund Worksheet - Schedule 1, Line 1" (https://www.irs.gov/instructions/i1040gi, read
// 2026-10-04); Pub. 525 ("Tax benefit rule", "Itemized Deduction Recoveries") is the fallback the
// instructions name for the exceptions.
//   * None of the refund is taxable if, in the year the tax was paid (2024), the filer did not
//     itemize, or elected to deduct general SALES taxes instead of income taxes.
//   * Otherwise the worksheet (MFJ 2024 figures printed in it: standard deduction 29,200; 1,550 per
//     box for age 65+ / blind):
//       1  refund (not more than 2024 Schedule A line 5d)
//       2  if 5d is more than 5e: 5d - 5e, else line 3 = line 1 (skip to line 4)
//       3  line 1 - line 2 (none taxable if line 1 is not more than line 2)
//       4  2024 Schedule A line 17;  5 = 29,200;  6 = boxes x 1,550;  7 = 5 + 6
//       8  line 4 - line 7 (none taxable if line 7 is not less than line 4)
//       9  taxable part = smaller of line 3 and line 8  -> Schedule 1 line 1
//   * The instructions send these cases to Pub. 525 instead (needs_cpa_judgment here): a refund for a
//     year other than 2024, a non-income-tax refund, 0%-rate capital gain situations, a refund larger
//     than the tax deducted minus the sales-tax alternative, the last 2024 estimate paid in 2025, AMT in
//     2024, unused credits in 2024, claimed as a dependent in 2024, a refund from a joint state return
//     when not filing jointly now.
// Only a 2024 JOINT return is computed (the household is MFJ); any other 2024 filing status is a CPA matter.
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD } from "@/lib/tax2025/money";
import type { RuleResult } from "@/lib/tax2025/types";

export interface StateRefundInput {
  /** Total refund (Form 1099-G box 2), including any part applied to 2025 estimated tax. */
  refund: Ans<Decimal>;
  /** How the 2024 return deducted state taxes. */
  deduction2024: Ans<"standard" | "itemized_income" | "itemized_sales">;
  /** The 2024 return was a joint return. */
  filedJoint2024: Ans<boolean>;
  /** 2024 Schedule A lines 5d, 5e and 17. */
  sch5d: Ans<Decimal>;
  sch5e: Ans<Decimal>;
  sch17: Ans<Decimal>;
  /** Number of boxes checked on 2024 Form 1040 line 12d (born before Jan 2, 1960 / blind, you and spouse). */
  boxes2024: Ans<number>;
  /** One of the Pub. 525 exceptions applies (see header). */
  exceptionApplies: Ans<boolean>;
}

const CITES = ["STATE_REFUND_2024_STANDARD_DEDUCTION_MFJ", "STATE_REFUND_2024_BOX_AMOUNT"];
const LABEL = "Taxable refunds, credits or offsets of state and local income taxes";

export function computeStateRefund(input: StateRefundInput): RuleResult {
  const base = { ruleId: "state-refund", form: "Schedule 1", citations: CITES, inputsUsed: [] as never[] };
  const blocked = (status: "missing_input" | "needs_cpa_judgment", reason: string, missing: string): RuleResult => ({
    ...base,
    status,
    lines: [blockedLine("sch1.1", LABEL, "1", status, reason)],
    reasons: [reason],
    inputsMissing: [missing],
  });
  const need = <T>(a: Ans<T>, what: string): RuleResult | null => {
    if (a.state === "missing") return blocked("missing_input", `The state tax refund: ${what} has not been answered.`, what);
    if (a.state === "unsure") return blocked("needs_cpa_judgment", `The state tax refund: the owner is not sure about ${what}; the CPA decides (Pub. 525).`, what);
    return null;
  };
  const r2 = need(input.deduction2024, "whether the 2024 return itemized");
  if (r2) return r2;
  const how = (input.deduction2024 as { state: "answered"; value: "standard" | "itemized_income" | "itemized_sales" }).value;
  if (how !== "itemized_income") {
    // Nothing was deducted in 2024, so nothing is taxable whatever the refund was: the amount is only named when known.
    const amountText = input.refund.state === "answered" ? ` of the ${fmt(input.refund.value)} refund` : " of the refund";
    const why =
      how === "standard"
        ? `None${amountText} is taxable: the 2024 return took the standard deduction, so the state income tax was not deducted (tax benefit rule; Form 1040 instructions, Schedule 1 line 1).`
        : `None${amountText} is taxable: the 2024 return deducted general sales taxes instead of state income taxes (Form 1040 instructions, Schedule 1 line 1).`;
    return { ...base, status: "computed", lines: [amountLine("sch1.1", LABEL, "1", ZERO, "not_applicable", why)], reasons: [why], inputsMissing: [] };
  }
  const r1 = need(input.refund, "the refund amount");
  if (r1) return r1;
  const r3 = need(input.exceptionApplies, "the Pub. 525 exception check");
  if (r3) return r3;
  const refund = (input.refund as { state: "answered"; value: Decimal }).value;
  if ((input.exceptionApplies as { state: "answered"; value: boolean }).value) {
    return blocked(
      "needs_cpa_judgment",
      `The refund of ${fmt(refund)} meets a case the Form 1040 instructions send to Pub. 525 (itemized deduction recoveries), which is not computed here: the CPA figures the taxable part.`,
      "Pub. 525 itemized deduction recovery"
    );
  }
  const r4 = need(input.filedJoint2024, "whether the 2024 return was a joint return");
  if (r4) return r4;
  if (!(input.filedJoint2024 as { state: "answered"; value: boolean }).value) {
    return blocked("needs_cpa_judgment", "The 2024 return was not a joint return: only the joint-filer figures of the refund worksheet are built in; the CPA figures the taxable part.", "2024 filing status");
  }
  for (const [a, what] of [
    [input.sch5d, "2024 Schedule A line 5d"],
    [input.sch5e, "2024 Schedule A line 5e"],
    [input.sch17, "2024 Schedule A line 17"],
    [input.boxes2024, "the boxes checked on 2024 Form 1040 line 12d"],
  ] as const) {
    const r = need(a as Ans<unknown>, what);
    if (r) return r;
  }
  const v5d = (input.sch5d as { state: "answered"; value: Decimal }).value;
  const v5e = (input.sch5e as { state: "answered"; value: Decimal }).value;
  const v17 = (input.sch17 as { state: "answered"; value: Decimal }).value;
  const boxes = (input.boxes2024 as { state: "answered"; value: number }).value;
  if (v5e.greaterThan(v5d)) return blocked("missing_input", "2024 Schedule A line 5e is larger than line 5d: re-check the two figures.", "2024 Schedule A lines 5d / 5e");
  const steps: string[] = [];
  const line1 = minD(refund, v5d);
  steps.push(`line 1 = smaller of the refund ${fmt(refund)} and Schedule A line 5d ${fmt(v5d)} = ${fmt(line1)}`);
  let line3: Decimal;
  if (v5d.greaterThan(v5e)) {
    const line2 = v5d.minus(v5e);
    line3 = line1.greaterThan(line2) ? line1.minus(line2) : ZERO;
    steps.push(`line 2 = 5d - 5e = ${fmt(line2)} (taxes over the SALT cap, not deducted); line 3 = ${fmt(line3)}`);
  } else {
    line3 = line1;
    steps.push(`5d is not more than 5e: line 3 = line 1 = ${fmt(line3)}`);
  }
  const line5 = D(K.STATE_REFUND_2024_STANDARD_DEDUCTION_MFJ.value);
  const line6 = D(K.STATE_REFUND_2024_BOX_AMOUNT.value).times(boxes);
  const line7 = line5.plus(line6);
  const line8 = v17.greaterThan(line7) ? v17.minus(line7) : ZERO;
  steps.push(`line 4 (Schedule A line 17) ${fmt(v17)}; line 5 ${fmt(line5)} + line 6 ${fmt(line6)} (${boxes} box(es)) = line 7 ${fmt(line7)}; line 8 = ${fmt(line8)}`);
  const line9 = maxD(ZERO, minD(line3, line8));
  const why = `Taxable part of the state refund ${fmt(line9)} (State and Local Income Tax Refund Worksheet, line 9 = smaller of line 3 ${fmt(line3)} and line 8 ${fmt(line8)}). ${steps.join("; ")}.`;
  return { ...base, status: "computed", lines: [amountLine("sch1.1", LABEL, "1", line9, line9.isZero() ? "not_applicable" : "computed", why)], reasons: [why], inputsMissing: [] };
}
