// The split of an overpayment into "refunded" and "applied to 2026 estimated tax" under the owner's decision
// (X7 for Form 1040 lines 35a / 36, X8 for CT-1040 lines 25 / 23). Shared by rules/overpayment-federal.ts and
// rules/ct-settlement.ts. No tax constant: this is arithmetic on lines that are already whole dollars.
//
// Sources (pinned pack data/tax-sources/2025, read 2026-10-06; quotes in specs/09 "Overpayment: refund or apply to 2026"):
//   Form 1040 instructions, line 36: "Enter on line 36 the amount, if any, of the overpayment on line 34 you want applied to
//     your 2026 estimated tax." and "This election to apply part or all of the amount overpaid to your 2026 estimated tax
//     can't be changed later." Line 38: "Lines 35a, 36, and 38 must equal line 34."
//   CT-1040 instructions, lines 23 to 25: line 23 is the amount applied to 2026 estimated tax (irrevocable), "Line 25:
//     Refund. Subtract Lines 23, 24, and 24a from Line 22 and enter the result."
//
// Behaviour (O = the overpayment, P = the penalty printed on Form 1040 line 38, 0 for CT or a blank line):
//   no decision          both lines blank (not_yet_computed, informational: advisory only, never blocks)
//   refund_all           refunded = max(0, O - P), applied = 0
//   apply_all            refunded = 0, applied = max(0, O - P)
//   apply_amount:A       refunded = max(0, O - P) - A, applied = A; an A above max(0, O - P) blocks (re-record)
// A computed 0 prints blank (pdf/policy.ts), so "applied 0" is a blank printed line, never a printed 0.

import type { Decimal } from "@prisma/client/runtime/library";
import { D, ZERO, amountLine, blockedLine, fmt, maxD } from "@/lib/tax2025/money";
import { lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import {
  OVERPAYMENT_LABELS,
  OVERPAYMENT_NO_ELECTION,
  formatOverpaymentChoice,
  overpaymentChoiceLabel,
  splitOverpayment,
} from "@/lib/tax2025/overpayment";
import type { DecidedOverpayment, Ref, RuleAlternative, RuleDecision, RuleLine } from "@/lib/tax2025/types";

export interface OverpaymentSplitSpec {
  decisionId: "X7" | "X8";
  /** Federal line 35a / CT line 25. */
  refundKey: LineKey;
  /** Federal line 36 / CT line 23. */
  appliedKey: LineKey;
  /** The overpayment line, e.g. "Form 1040 line 34". */
  overpaymentWhere: string;
  /** The overpayment, whole dollars (> 0 here; the caller handles 0). */
  overpayment: Decimal;
  /** The penalty printed on Form 1040 line 38 in whole dollars; null = that line is blank. CT: always null. */
  penaltyPrinted: Decimal | null;
  /** Where the penalty is printed (federal only), e.g. "line 38". */
  penaltyWhere: string | null;
  decision: DecidedOverpayment | undefined;
  /** Short names used in the sentences, e.g. "line 35a" / "line 36". */
  refundName: string;
  appliedName: string;
  /** The printed rule that ties the lines together (a verified sentence of the instructions). */
  formula: string;
  /** Closing sentence of the refund line reason / alternatives (what stays by hand). */
  byHandNote: string;
  /** The verified "cannot be changed later" sentence (with its source). */
  irrevocableNote: string;
  /** Extra text for the refund line (CT: a pending interest on underpayment). */
  refundExtra: string;
}

export interface OverpaymentSplitOutput {
  refunded: RuleLine;
  applied: RuleLine;
  decision: RuleDecision;
  alternatives: RuleAlternative[];
  /** The recorded apply_amount is more than is available now (both lines are blocking). */
  tooMuch: boolean;
  /** The printed penalty is more than the overpayment (both lines 0). */
  penaltyExceeds: boolean;
}

export function overpaymentRef(id: "X7" | "X8", label: string): Ref {
  return { kind: "decision", id, label };
}

function lineAt(key: LineKey, amount: Decimal, reason: string, refs: Ref[]): RuleLine {
  const meta = lineMeta(key);
  return { ...amountLine(key, meta.label, meta.formLine, amount, "computed", reason), refs };
}

function blockedAt(key: LineKey, status: "not_yet_computed" | "missing_input", reason: string, refs: Ref[], informational: boolean): RuleLine {
  const meta = lineMeta(key);
  return { ...blockedLine(key, meta.label, meta.formLine, status, reason), refs, ...(informational ? { informational: true } : {}) };
}

export function buildOverpaymentSplit(spec: OverpaymentSplitSpec): OverpaymentSplitOutput {
  const { overpayment: over, decision } = spec;
  const id = spec.decisionId;
  const penalty = spec.penaltyPrinted ?? ZERO;
  const available = maxD(ZERO, over.minus(penalty));
  const availableNum = available.toNumber();
  const penaltyExceeds = spec.penaltyPrinted !== null && penalty.greaterThan(over);
  const penaltyText =
    spec.penaltyWhere === null
      ? ""
      : spec.penaltyPrinted === null
        ? ` less ${spec.penaltyWhere} (blank: the IRS figures any penalty itself, counted as $0)`
        : ` less ${spec.penaltyWhere} ${fmt(penalty)}`;
  const base = `${spec.overpaymentWhere} ${fmt(over)}${penaltyText} = ${fmt(available)} available`;
  const penaltyNote = penaltyExceeds
    ? ` The penalty on line 38 (${fmt(penalty)}) is more than the overpayment, so the instructions say to enter -0- on lines 35a and 36 and to subtract line 34 from line 38 for line 37 (the Form 1040 instructions, line 38); this return does not add the penalty to line 37, so check it by hand.`
    : "";

  const chosenText = decision === undefined ? OVERPAYMENT_NO_ELECTION : formatOverpaymentChoice(decision.chosen, decision.appliedDollars ?? null);
  const shown = decision === undefined ? null : overpaymentChoiceLabel(chosenText);
  const ruleDecision: RuleDecision = {
    id,
    label: OVERPAYMENT_LABELS[id],
    chosen: chosenText,
    status: decision === undefined ? "default_undecided" : "decided",
    ...(decision === undefined ? {} : { decidedBy: decision.by, decidedAt: decision.at }),
  };

  const refs = [
    overpaymentRef(
      id,
      decision === undefined
        ? `Owner decision ${id}: no election recorded, default, undecided`
        : `Owner decision ${id}: ${(shown ?? chosenText).toLowerCase()}, the owner's recorded choice`
    ),
  ];

  // What each choice would print (also the side-by-side alternatives)
  const printedFor = (refundedDollars: number, appliedDollars: number, why: string): { refunded: RuleLine; applied: RuleLine } => ({
    refunded: lineAt(spec.refundKey, D(refundedDollars), `${base}; ${fmt(D(refundedDollars))} refunded on ${spec.refundName}. ${why}`, refs),
    applied: lineAt(spec.appliedKey, D(appliedDollars), `${base}; ${fmt(D(appliedDollars))} applied to 2026 estimated tax on ${spec.appliedName}. ${why}`, refs),
  });

  const noElection = {
    refunded: blockedAt(
      spec.refundKey,
      "not_yet_computed",
      `Default, undecided (decision ${id}): no election is recorded, so ${spec.refundName} is left blank. ${spec.formula} The overpayment is ${fmt(over)}; record decision ${id} to choose how much to refund.${spec.refundExtra === "" ? "" : ` ${spec.refundExtra}`}`,
      refs,
      true
    ),
    applied: blockedAt(
      spec.appliedKey,
      "not_yet_computed",
      `Default, undecided (decision ${id}): no election is recorded, so ${spec.appliedName} is left blank. Record decision ${id} to choose how much of the ${fmt(over)} overpayment to apply to 2026 estimated tax.`,
      refs,
      true
    ),
  };

  let refunded: RuleLine;
  let applied: RuleLine;
  let tooMuch = false;
  if (decision === undefined) {
    refunded = noElection.refunded;
    applied = noElection.applied;
  } else {
    const split = splitOverpayment(availableNum, decision.chosen, decision.appliedDollars ?? null);
    if (split === null) {
      tooMuch = true;
      const msg = `The amount recorded to apply (${fmt(D(decision.appliedDollars ?? 0))}) is more than the overpayment now available (${fmt(available)}). Record decision ${id} again.`;
      refunded = blockedAt(spec.refundKey, "missing_input", msg, refs, false);
      applied = blockedAt(spec.appliedKey, "missing_input", msg, refs, false);
    } else {
      const why = `Owner decision ${id}: ${(shown ?? chosenText).toLowerCase()}. ${spec.formula}${penaltyNote}`;
      const p = printedFor(split.refunded, split.applied, why);
      refunded = { ...p.refunded, reason: `${p.refunded.reason ?? ""} ${spec.byHandNote}${spec.refundExtra === "" ? "" : ` ${spec.refundExtra.trim()}`}`.trim() };
      applied = split.applied > 0 ? { ...p.applied, reason: `${p.applied.reason ?? ""} ${spec.irrevocableNote}`.trim() } : p.applied;
    }
  }

  const eff = (note: string) => ({ amount: null, note });
  const lines2 = (r: number, a: number): RuleLine[] => {
    const p = printedFor(r, a, "");
    return [p.refunded, p.applied];
  };
  const alt = (altId: string, label: string, isDefault: boolean, inForce: boolean, status: RuleAlternative["status"], lines: RuleLine[], note: string): RuleAlternative => ({
    id: altId,
    label,
    status,
    isDefault,
    inForce,
    lines,
    effect: eff(note),
    reasons: [],
  });
  const printedNote = (r: number, a: number) =>
    `${spec.refundName[0]?.toUpperCase() ?? ""}${spec.refundName.slice(1)} ${r > 0 ? fmt(D(r)) : "blank"}; ${spec.appliedName} ${a > 0 ? fmt(D(a)) : "blank"}.`;
  const appliedAmountInForce = decision?.chosen === "apply_amount";
  const amountSplit = appliedAmountInForce ? splitOverpayment(availableNum, "apply_amount", decision?.appliedDollars ?? null) : null;
  const alternatives: RuleAlternative[] = [
    alt(
      OVERPAYMENT_NO_ELECTION,
      "No election recorded (the lines print blank)",
      true,
      decision === undefined,
      "not_yet_computed",
      [noElection.refunded, noElection.applied],
      `${spec.refundName[0]?.toUpperCase() ?? ""}${spec.refundName.slice(1)} and ${spec.appliedName} are left blank until you record the decision.`
    ),
    alt("refund_all", "Refund all (nothing applied to 2026)", false, decision?.chosen === "refund_all", "computed", lines2(availableNum, 0), `${printedNote(availableNum, 0)} Nothing is applied to 2026. ${spec.byHandNote}`),
    alt(
      "apply_all",
      "Apply all to 2026 estimated tax",
      false,
      decision?.chosen === "apply_all",
      "computed",
      lines2(0, availableNum),
      `${printedNote(0, availableNum)} ${spec.irrevocableNote}`
    ),
    appliedAmountInForce
      ? alt(
          "apply_amount",
          "Apply a stated amount to 2026 (the rest is refunded)",
          false,
          true,
          amountSplit === null ? "missing_input" : "computed",
          amountSplit === null ? [] : lines2(amountSplit.refunded, amountSplit.applied),
          amountSplit === null
            ? `The recorded amount (${fmt(D(decision?.appliedDollars ?? 0))}) is more than the overpayment now available (${fmt(available)}); record decision ${id} again.`
            : `${printedNote(amountSplit.refunded, amountSplit.applied)} ${spec.irrevocableNote}`
        )
      : alt("apply_amount", "Apply a stated amount to 2026 (the rest is refunded)", false, false, "not_yet_computed", [], `${availableNum < 1 ? "There is nothing available to apply." : `You choose how many whole dollars to apply (1 to ${fmt(available)}); the rest is refunded.`} ${spec.irrevocableNote}`),
  ];

  return { refunded, applied, decision: ruleDecision, alternatives, tooMuch, penaltyExceeds };
}
