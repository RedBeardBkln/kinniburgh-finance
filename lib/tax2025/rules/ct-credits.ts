// CT-1040 lines 7, 13 and 20a-20d, TY2025: the credits this engine does NOT compute.
//
//   line 7   credit for income taxes paid to qualifying jurisdictions (Schedule 2 line 59)
//   line 13  allowable credits, Schedule CT-IT Credit Part 1 line 10 (includes CT-8801 and the CT-1040 REC credits)
//   line 20a CT earned income tax credit (Schedule CT-EITC line 16; 40% of the federal EIC, instructions p. 3)
//   line 20b claim of right credit (Form CT-1040 CRC line 6)
//   line 20c pass-through entity tax credit (Schedule CT-PE line 1)
//   line 20d historic home credit
//
// Form text and instruction pages: specs/09 "CT-1040 lines 3-30". No amount is figured here: an owner
// "none" statement (Return completeness, facts.statedNone `ct_other_state_tax` / `ct_other_credits`) makes the line a
// not_applicable 0 that carries the statement; a Yes goes to the CPA (needs_cpa_judgment); no answer is a
// missing_input (blocking). Never a silent 0.
//
// Line 7 additionally goes to the CPA when a W-2 shows withholding for a state other than Connecticut, even when the owner
// stated "none": a document that disagrees with the statement is not resolved by the app.
//
// Pure. No constants are needed.

import type { Ref } from "@/lib/tax2025/types";
import { NONE_GROUP_TEXT, lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import { ZERO, amountLine, blockedLine } from "@/lib/tax2025/money";
import { aggregateStatus, type RuleLine, type RuleResult } from "@/lib/tax2025/types";

export const CT_OTHER_CREDIT_LINES = ["ct1040.13", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"] as const satisfies readonly LineKey[];
export const CT_CREDIT_LINES = ["ct1040.7", ...CT_OTHER_CREDIT_LINES] as const satisfies readonly LineKey[];

export interface CtOtherCreditsInput {
  /** `ct_other_state_tax`: true = the owner stated "none", false = answered Yes, undefined = not answered / not sure. */
  otherStateTax: boolean | undefined;
  /** `ct_other_credits`: same convention. */
  otherCredits: boolean | undefined;
  /** A W-2 shows withholding for a state other than Connecticut. */
  nonCtStateWithholdingPresent: boolean;
  /** Provenance of the two statements. */
  refs?: { otherStateTax?: Ref[]; otherCredits?: Ref[] };
}

const QUESTION_NAME = {
  ct_other_state_tax: "income taxed by another state",
  ct_other_credits: "other Connecticut credits",
} as const;

export function computeCtOtherCredits(input: CtOtherCreditsInput): RuleResult {
  const base = { ruleId: "ct-credits", form: "CT-1040", citations: [], inputsUsed: [] };
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  const missing: string[] = [];

  const emit = (key: LineKey, group: keyof typeof QUESTION_NAME, stated: boolean | undefined, refs: Ref[] | undefined, extraWhy?: string): void => {
    const meta = lineMeta(key);
    const name = QUESTION_NAME[group];
    let line: RuleLine;
    if (stated === true && extraWhy === undefined) {
      line = amountLine(key, meta.label, meta.formLine, ZERO, "not_applicable", `Stated by the owner: ${NONE_GROUP_TEXT[group]}`);
    } else if (stated === false || extraWhy !== undefined) {
      const why =
        stated === false
          ? `the owner answered Yes to "${name}": this amount is not computed here and the CPA works it. The statement that does not hold: ${NONE_GROUP_TEXT[group]}`
          : (extraWhy ?? "");
      line = blockedLine(key, meta.label, meta.formLine, "needs_cpa_judgment", `CT-1040 line ${meta.formLine}: ${why}`);
      const summary = `CT-1040 credits: ${why}`;
      if (!reasons.includes(summary)) reasons.push(summary);
    } else {
      const why = `needs an owner / CPA statement: ${NONE_GROUP_TEXT[group]}`;
      line = blockedLine(key, meta.label, meta.formLine, "missing_input", `CT-1040 line ${meta.formLine} ${why}`);
      const summary = `CT-1040 credits ${why}`;
      if (!reasons.includes(summary)) reasons.push(summary);
      if (!missing.includes(`Return completeness: the "${name}" question`)) missing.push(`Return completeness: the "${name}" question`);
    }
    if (refs !== undefined && refs.length > 0) line.refs = refs;
    lines.push(line);
  };

  emit(
    "ct1040.7",
    "ct_other_state_tax",
    input.otherStateTax,
    input.refs?.otherStateTax,
    input.nonCtStateWithholdingPresent
      ? "a W-2 shows withholding for a state other than Connecticut: a credit for taxes paid to another jurisdiction may apply (Schedule 2) and is not computed here."
      : undefined
  );
  for (const key of CT_OTHER_CREDIT_LINES) emit(key, "ct_other_credits", input.otherCredits, input.refs?.otherCredits);

  return { ...base, status: aggregateStatus(lines), lines, reasons, inputsMissing: missing };
}
