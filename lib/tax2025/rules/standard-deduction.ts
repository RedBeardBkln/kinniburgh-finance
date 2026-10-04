// Standard deduction with the Form 1040 line 12d boxes (born before January 2, 1961;
// blind), married filing jointly. Source: the 2025 Form 1040 instructions, "Standard
// Deduction Chart for People Who Were Born Before January 2, 1961, or Were Blind":
// MFJ is 33,100 / 34,700 / 36,300 / 37,900 for 1 / 2 / 3 / 4 boxes checked, which is
// the base standard deduction plus the additional amount per box (verified
// 2026-10-03; ids in lib/tax2025/constants.ts). Each spouse has two boxes (age,
// blind). An unanswered or "not sure" box is NEVER taken as "no": the line stays
// blocked (missing_input / needs_cpa_judgment), so the standard deduction is never
// silently the base amount.
// Assumes neither spouse can be claimed as a dependent on someone else's return (the
// instructions send those filers to a different worksheet) and that both spouses are
// alive and a nonresident-alien / dual-status election is not in play (MFJ engine).
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { D, amountLine, blockedLine, fmt } from "@/lib/tax2025/money";
import type { RuleResult } from "@/lib/tax2025/types";

export interface StandardDeductionPerson {
  name: string;
  bornBefore1961: Ans<boolean>;
  blind: Ans<boolean>;
}

const CITES = ["STANDARD_DEDUCTION_MFJ", "STANDARD_DEDUCTION_ADDITIONAL_MFJ"];

export function computeStandardDeduction(input: { people: StandardDeductionPerson[] }): RuleResult {
  const base = D(K.STANDARD_DEDUCTION_MFJ.value);
  const per = D(K.STANDARD_DEDUCTION_ADDITIONAL_MFJ.value);
  const head = { ruleId: "standard-deduction", form: "Form 1040", citations: CITES, inputsUsed: [] };
  const missing: string[] = [];
  let unsure = false;
  let boxes = 0;
  const parts: string[] = [];
  for (const p of input.people) {
    for (const [what, a] of [["born before January 2, 1961", p.bornBefore1961], ["blind", p.blind]] as const) {
      if (a.state === "missing") missing.push(`${p.name}: ${what}`);
      else if (a.state === "unsure") {
        missing.push(`${p.name}: ${what}`);
        unsure = true;
      } else if (a.value) {
        boxes += 1;
        parts.push(`${p.name} ${what}`);
      }
    }
  }
  if (input.people.length < 2) missing.push("both spouses' age and blindness answers");
  if (missing.length > 0) {
    const status = missing.some((m) => m.endsWith("both spouses' age and blindness answers")) || !unsure ? "missing_input" : "needs_cpa_judgment";
    const reason = `The standard deduction cannot be set: ${unsure ? "the owner is not sure about" : "no answer yet for"} ${missing.join("; ")} (Form 1040 line 12d boxes).`;
    return {
      ...head,
      status,
      lines: [
        blockedLine("std.additional", "Additional standard deduction", "12d", status, reason),
        blockedLine("std.total", "Standard deduction", "12e", status, reason),
      ],
      reasons: [reason],
      inputsMissing: missing,
    };
  }
  const additional = per.times(boxes);
  const total = base.plus(additional);
  const why = `${boxes} box(es) checked on line 12d${parts.length > 0 ? ` (${parts.join(", ")})` : ""}: ${fmt(base)} + ${boxes} x ${fmt(per)} = ${fmt(total)}.`;
  return {
    ...head,
    status: "computed",
    lines: [
      amountLine("std.additional", "Additional standard deduction", "12d", additional, boxes === 0 ? "not_applicable" : "computed", boxes === 0 ? "Neither spouse was born before January 2, 1961 or is blind (owner answers)." : why),
      amountLine("std.total", "Standard deduction", "12e", total, "computed", why),
    ],
    reasons: [why, "Assumes neither spouse can be claimed as a dependent on another return."],
    inputsMissing: [],
  };
}

