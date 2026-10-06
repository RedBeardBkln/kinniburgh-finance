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
//     * Line 2: total basis from earlier years. "Generally, if this is the first year you are required to file Form 8606, enter -0-.
//       Otherwise, use the Total Basis Chart" (instructions, Line 2 and "Total Basis Chart--Line 2", p. 9): for a last Form 8606 filed for
//       a year after 2023 and before 2025 (the 2024 form) it is "the amount from line 14 of that Form 8606 as adjusted to include the
//       amount from line 6 of the Line 15c Worksheet, if any". The app cannot see the 2024 Form 8606 (the 2024 return facts it holds are
//       adjusted gross income and tax only), so line 2 is the OWNER'S ANSWER (PersonAnswers.priorBasisCents: the 2024 line 14 amount, 0 if
//       none or never filed one): never an unstated 0, never negative, never checked against a document (the line's reason says so).
//     * Line 3 = line 1 + line 2.
//     * The form's own flow box after line 3: "In 2025, did you take a distribution from a traditional IRA, or make a Roth IRA
//       conversion? No: Enter the amount from line 3 on line 14. Do not complete the rest of Part I. Yes: Go to line 4."
//       So lines 4-13 and 15a-15c are NOT completed here: they are for a year with a distribution or a conversion, and Parts II and
//       III (Roth conversions and Roth distributions) are blank by the owner's statements.
//     * Line 14 = total basis for 2025 and earlier years (next year's line 2).
//   A "Yes" to a distribution (retirement_ss_income: IRA distributions, pensions, Social Security) or to the distribution /
//   conversion / recharacterization / returned-contribution statement (ira_basis_other) is NOT figured: the affected lines are BLOCKED
//   with a plain reason, so a wrong number is never printed. Lines 4-13, 15a-15c and Parts II and III print blank (the PDF map's blank
//   reasons say why).
//
// Penalties (constants.ts): $50 for not filing when required, $100 for overstating nondeductible contributions.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { NONE_GROUP_TEXT, lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import { ZERO, amountLine, blockedLine, fmt } from "@/lib/tax2025/money";
import { aggregateStatus, hasAmount, worstBlocked, type RuleLine, type RuleResult, type RuleStatus } from "@/lib/tax2025/types";

export type Form8606Slot = "a" | "b";

export interface Form8606PersonInput {
  slot: Form8606Slot;
  name: string;
  /** The person's `ira.<slot>.nd` line (Form 8606 line 1 before the form flow): amount (whole dollars) and status; null amount = not figured. */
  nondeductible: { amount: Decimal | null; status: RuleStatus | undefined; reason: string | null };
  /**
   * The owner's answer: line 14 of the person's most recent filed Form 8606 (the 2024 form), in dollars; 0 = none or never filed one.
   * Read only when line 1 is above 0. A negative amount is refused (line 2 blocked).
   */
  priorBasis: Ans<Decimal>;
}

export interface Form8606Input {
  people: Form8606PersonInput[];
  /** Statement `ira_basis_other`: true = no IRA distribution, Roth conversion, recharacterization or returned contribution in 2025, false = answered Yes, null = not stated. */
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
  "You answered Yes to the question about IRA withdrawals, Roth conversions, recharacterizations and returned contributions in 2025. Any of them changes Form 8606 lines 4-18, which this app does not figure from your answers. Fill those lines in yourself from the 2025 Form 8606 instructions.";
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

/** Line 2 for one person: the owner's answer, or why it is not known yet. */
type Line2 = { kind: "amount"; amount: Decimal; reason: string } | { kind: "blocked"; status: Blocked; reason: string };

function line2Of(name: string, pb: Ans<Decimal>): Line2 {
  if (pb.state === "answered") {
    if (pb.value.isNegative()) {
      return { kind: "blocked", status: "missing_input", reason: `${name}: a total basis cannot be below zero (the amount on line 14 of the 2024 Form 8606). Enter 0 if there was none.` };
    }
    return {
      kind: "amount",
      amount: pb.value,
      reason: `Owner answer (from the 2024 Form 8606 line 14): ${fmt(pb.value)}${pb.value.isZero() ? " (none, or no earlier Form 8606)" : ""}. The 2025 instructions' Total Basis Chart carries line 14 of the last Form 8606 filed into line 2. The app holds only adjusted gross income and tax from the 2024 return, so this amount is not checked against any 2024 document.`,
    };
  }
  if (pb.state === "unsure") {
    return {
      kind: "blocked",
      status: "needs_cpa_judgment",
      reason: `${name}: you marked the amount on line 14 of the 2024 Form 8606 as not sure. Look it up (the 2024 return, or whoever prepared it) and answer it; until then line 2 stays blank. Enter 0 if there was none.`,
    };
  }
  return {
    kind: "blocked",
    status: "missing_input",
    reason: `${name}: needs your answer: the amount on line 14 of your most recent filed Form 8606 (for 2024), your total basis in traditional IRAs. Enter 0 if there was none or you never filed one.`,
  };
}

export function computeForm8606(input: Form8606Input): RuleResult {
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  const missing: string[] = [];
  const addMissing = (m: string): void => {
    if (!missing.includes(m)) missing.push(m);
  };
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
      addMissing(`IRA answers for Form 8606 (${p.name})`);
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
    // Line 2: the owner's answer (line 14 of the most recent filed Form 8606). A Yes to the distribution / conversion statement is not figured:
    // lines 2, 3 and 14 wait, whatever the amount is.
    const l2 = line2Of(p.name, p.priorBasis);
    if (l2.kind === "blocked") {
      reasons.push(l2.reason);
      addMissing(`Amount on the 2024 Form 8606 line 14 (${p.name})`);
      // Line 14 also waits for the two statements: name the ones still missing now, so the owner answers everything in one round.
      if (basis === null) {
        reasons.push(`${p.name}: Needs an owner statement: ${NONE_GROUP_TEXT.ira_basis_other}`);
        addMissing("Statement: no IRA withdrawal, Roth conversion, recharacterization or returned contribution in 2025");
      }
      if (dist === null) addMissing("Statement: no IRA distributions, pensions or Social Security");
    }
    if (basis === false) {
      reasons.push(`${p.name}: ${YES_BASIS}`);
      for (const key of [k.l2, k.l3, k.l14]) lines.push(blocked(key, "needs_cpa_judgment", YES_BASIS));
      continue;
    }
    if (l2.kind === "blocked") {
      lines.push(blocked(k.l2, l2.status, l2.reason));
      lines.push(blocked(k.l3, l2.status, "Depends on Form 8606 line 2, which is not figured yet."));
      lines.push(blocked(k.l14, l2.status, "Depends on Form 8606 line 3, which is not figured yet."));
      continue;
    }
    lines.push(line(k.l2, l2.amount, "computed", l2.reason));
    // Line 3 = 1 + 2.
    const line3 = nd.amount.plus(l2.amount);
    lines.push(line(k.l3, line3, "computed", `Line 1 ${fmt(nd.amount)} plus line 2 ${fmt(l2.amount)}.`));
    // Line 14: the form's flow box says "No (no distribution, no conversion): enter the amount from line 3 on line 14".
    if (dist === true && basis === true) {
      lines.push(line(k.l14, line3, "computed", "No distribution from a traditional IRA and no Roth conversion (your statements): the form says to enter line 3 on line 14. This is next year's line 2."));
    } else if (dist === false) {
      lines.push(blocked(k.l14, "needs_cpa_judgment", YES_DISTRIBUTION));
      reasons.push(`${p.name}: ${YES_DISTRIBUTION}`);
    } else {
      const which = dist === null ? "IRA distributions, pensions or Social Security (statement not given)" : "IRA withdrawals, Roth conversions, recharacterizations and returned contributions (statement not given)";
      lines.push(blocked(k.l14, "missing_input", `Needs your statements before line 14 is final: ${which}. The form's flow box after line 3 sends a person with no IRA distribution and no conversion straight to line 14.`));
      if (basis === null) {
        reasons.push(`${p.name}: Needs an owner statement: ${NONE_GROUP_TEXT.ira_basis_other}`);
        addMissing("Statement: no IRA withdrawal, Roth conversion, recharacterization or returned contribution in 2025");
      }
      if (dist === null) addMissing("Statement: no IRA distributions, pensions or Social Security");
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
