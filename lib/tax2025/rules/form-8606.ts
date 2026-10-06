// Form 8606 (Nondeductible IRAs), Part I, TY2025: one form per person who made a nondeductible contribution to a traditional IRA.
//
// Sources (primary; registered in specs/09 "Form 8606"):
//   2025 Form 8606 (https://www.irs.gov/pub/irs-prior/f8606--2025.pdf) and its instructions
//   (https://www.irs.gov/pub/irs-prior/i8606--2025.pdf):
//     * "Who Must File": a person who made nondeductible contributions to a traditional IRA for 2025 files Form 8606; a married couple
//       files one form EACH ("If you file a joint return, enter only the name and SSN of the spouse whose information is being reported").
//     * Line 1: the contribution not deducted: the smaller of the IRA Deduction Worksheet's line 10 (compensation) or line 11 (the
//       contribution) minus its line 12 (the deduction). The IRA deduction rule (rules/ira-deduction.ts) holds those numbers and emits
//       it as `ira.<slot>.nd`; this rule copies it.
//     * Line 2: total basis from earlier years. "Generally, if this is the first year you are required to file Form 8606, enter -0-."
//       The app cannot see earlier returns, so line 2 is 0 only on the owner's statement `ira_basis_other` (no nondeductible
//       contribution for 2024 or an earlier year, no after-tax rollover, ...), never an unstated 0.
//     * Line 3 = line 1 + line 2.
//     * The form's own flow box after line 3: "In 2025, did you take a distribution from a traditional IRA, or make a Roth IRA
//       conversion? No: Enter the amount from line 3 on line 14. Do not complete the rest of Part I. Yes: Go to line 4."
//       So lines 4-13 and 15a-15c are NOT completed here: they are for a year with a distribution or a conversion, and Parts II and
//       III (Roth conversions and Roth distributions) are blank by the owner's statements.
//     * Line 14 = total basis for 2025 and earlier years (next year's line 2).
//   A "Yes" to a distribution (retirement_ss_income: IRA distributions, pensions, Social Security) or to the earlier-basis /
//   conversion / recharacterization statement is NOT figured: the affected lines are BLOCKED with a plain reason, so a wrong number is
//   never printed. Lines 4-13, 15a-15c and Parts II and III print blank (the PDF map's blank reasons say why).
//
// Penalties (constants.ts): $50 for not filing when required, $100 for overstating nondeductible contributions.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { NONE_GROUP_TEXT, lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import { ZERO, amountLine, blockedLine, fmt } from "@/lib/tax2025/money";
import { aggregateStatus, hasAmount, worstBlocked, type RuleLine, type RuleResult, type RuleStatus } from "@/lib/tax2025/types";

export type Form8606Slot = "a" | "b";

export interface Form8606PersonInput {
  slot: Form8606Slot;
  name: string;
  /** The person's `ira.<slot>.nd` line (Form 8606 line 1 before the form flow): amount (whole dollars) and status; null amount = not figured. */
  nondeductible: { amount: Decimal | null; status: RuleStatus | undefined; reason: string | null };
}

export interface Form8606Input {
  people: Form8606PersonInput[];
  /** Statement `ira_basis_other`: true = none of the earlier-year basis / conversion / recharacterization items, false = answered Yes, null = not stated. */
  noEarlierBasisOrOtherIraEvent: boolean | null;
  /** Statement `retirement_ss_income` (no IRA distributions, pensions or Social Security): same tri-state. */
  noIraDistributions: boolean | null;
}

const CITES = ["FORM_8606_NOT_FILED_PENALTY", "FORM_8606_OVERSTATEMENT_PENALTY", "IRA_PHASEOUT_COVERED_MFJ", "IRA_PHASEOUT_SPOUSE_COVERED_MFJ"];

/** Every key of this rule (the assembler owns them all). */
export const FORM_8606_KEYS = ["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14", "f8606b.1", "f8606b.2", "f8606b.3", "f8606b.14"] as const satisfies readonly LineKey[];

type Blocked = Exclude<RuleStatus, "computed" | "not_applicable">;

const KEYS = {
  a: { l1: "f8606a.1", l2: "f8606a.2", l3: "f8606a.3", l14: "f8606a.14" },
  b: { l1: "f8606b.1", l2: "f8606b.2", l3: "f8606b.3", l14: "f8606b.14" },
} as const satisfies Record<Form8606Slot, Record<string, LineKey>>;

const YES_BASIS =
  "You answered Yes to the question about earlier-year IRA basis and other IRA changes. Earlier basis, an after-tax rollover, a conversion to a Roth IRA, a recharacterization or a returned contribution change Form 8606 lines 2 and 4-18, which this app does not figure from your answers. Fill those lines in yourself from the 2025 Form 8606 instructions.";
const YES_DISTRIBUTION =
  "You answered Yes to IRA distributions, pensions or Social Security benefits. A distribution from a traditional IRA means Form 8606 lines 4-13 and 15a-15c apply (the form's flow box after line 3), which this app does not figure from your answers. Fill them in yourself from the 2025 Form 8606 instructions.";

function line(key: LineKey, amount: Decimal, status: "computed" | "not_applicable", reason: string): RuleLine {
  const m = lineMeta(key);
  return amountLine(key, m.label, m.formLine, amount, status, reason);
}

function blocked(key: LineKey, status: Blocked, reason: string): RuleLine {
  const m = lineMeta(key);
  return blockedLine(key, m.label, m.formLine, status, reason);
}

export function computeForm8606(input: Form8606Input): RuleResult {
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  const missing: string[] = [];
  const basis = input.noEarlierBasisOrOtherIraEvent;
  const dist = input.noIraDistributions;

  for (const slot of ["a", "b"] as const) {
    const k = KEYS[slot];
    const p = input.people.find((x) => x.slot === slot);
    if (p === undefined) {
      for (const key of [k.l1, k.l2, k.l3, k.l14]) lines.push(line(key, ZERO, "not_applicable", "No second person on this return."));
      continue;
    }
    const nd = p.nondeductible;
    const status = nd.status ?? "missing_input";
    // Line 1 is not figured (an unanswered or unsure IRA question, an excess contribution, a stated IRA deduction ...): the whole form waits.
    if (!hasAmount(status) || nd.amount === null) {
      const st = worstBlocked([status]) ?? "missing_input";
      const why = nd.reason ?? `${p.name}: the nondeductible IRA contribution is not figured yet.`;
      lines.push(blocked(k.l1, st, why));
      for (const key of [k.l2, k.l3, k.l14]) lines.push(blocked(key, st, `Depends on Form 8606 line 1, which is not figured yet: ${why}`));
      reasons.push(`${p.name}: Form 8606 waits for the IRA deduction and contribution answers. ${why}`);
      missing.push(`IRA answers for Form 8606 (${p.name})`);
      continue;
    }
    // Nothing nondeductible: no Form 8606 for this person.
    if (status === "not_applicable" || nd.amount.isZero()) {
      const why = `${p.name}: no nondeductible traditional IRA contribution, so no Form 8606.`;
      for (const key of [k.l1, k.l2, k.l3, k.l14]) lines.push(line(key, ZERO, "not_applicable", why));
      continue;
    }
    // Line 1.
    lines.push(line(k.l1, nd.amount, "computed", nd.reason ?? `${p.name}: ${fmt(nd.amount)} of the traditional IRA contribution is not deducted.`));
    // Line 2: earlier-year basis, only on the owner's statement.
    let line2: Decimal | null = null;
    let line2Status: Blocked | null = null;
    if (basis === true) {
      line2 = ZERO;
      lines.push(line(k.l2, ZERO, "computed", `Stated: ${NONE_GROUP_TEXT.ira_basis_other}`));
    } else if (basis === null) {
      line2Status = "missing_input";
      const why = `Needs an owner statement: ${NONE_GROUP_TEXT.ira_basis_other}`;
      lines.push(blocked(k.l2, line2Status, why));
      reasons.push(`${p.name}: ${why}`);
      if (!missing.includes("Statement: no earlier-year IRA basis and no other IRA change")) missing.push("Statement: no earlier-year IRA basis and no other IRA change");
    } else {
      line2Status = "needs_cpa_judgment";
      lines.push(blocked(k.l2, line2Status, YES_BASIS));
      reasons.push(`${p.name}: ${YES_BASIS}`);
    }
    // Line 3 = 1 + 2.
    if (line2 !== null) {
      lines.push(line(k.l3, nd.amount.plus(line2), "computed", `Line 1 ${fmt(nd.amount)} plus line 2 ${fmt(line2)}.`));
    } else {
      lines.push(blocked(k.l3, line2Status ?? "missing_input", "Depends on Form 8606 line 2, which is not figured yet."));
    }
    // Line 14: the form's flow box says "No (no distribution, no conversion): enter the amount from line 3 on line 14".
    if (line2 !== null && dist === true && basis === true) {
      lines.push(line(k.l14, nd.amount.plus(line2), "computed", "No distribution from a traditional IRA and no Roth conversion (your statements): the form says to enter line 3 on line 14. This is next year's line 2."));
    } else if (basis === false) {
      lines.push(blocked(k.l14, "needs_cpa_judgment", YES_BASIS));
    } else if (dist === false) {
      lines.push(blocked(k.l14, "needs_cpa_judgment", YES_DISTRIBUTION));
      reasons.push(`${p.name}: ${YES_DISTRIBUTION}`);
    } else {
      const which = dist === null ? "IRA distributions, pensions or Social Security (statement not given)" : "earlier-year basis and other IRA changes (statement not given)";
      lines.push(blocked(k.l14, "missing_input", `Needs your statements before line 14 is final: ${which}. The form's flow box after line 3 sends a person with no IRA distribution and no conversion straight to line 14.`));
      if (dist === null && !missing.includes("Statement: no IRA distributions, pensions or Social Security")) missing.push("Statement: no IRA distributions, pensions or Social Security");
    }
  }
  return {
    ruleId: "form-8606",
    form: "Form 8606 (Nondeductible IRAs), Part I",
    status: aggregateStatus(lines, "computed"),
    lines,
    reasons,
    citations: CITES,
    inputsUsed: [],
    inputsMissing: missing,
  };
}
