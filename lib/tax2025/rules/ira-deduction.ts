// Traditional IRA deduction -> Schedule 1 line 20. Source: Pub. 590-A (2025),
// Worksheets 1-1 (modified AGI) and 1-2 (reduced deduction), Tables 1-2 and 1-3,
// and the Kay Bailey Hutchison spousal IRA limit; the 1040 instructions carry the
// same IRA Deduction Worksheet (rounding up to a multiple of $10, minimum $200).
//
// MFJ only. Per person (each spouse's deduction is figured separately):
//   * covered by a workplace plan (W-2 box 13 "Retirement plan", or a SEP / SIMPLE /
//     qualified plan for the self-employed): MAGI range $126,000-$146,000,
//     reduction = (146,000 - MAGI) x 35% (40% if age 50+), full deduction at a gap of
//     $20,000 or more, none at MAGI $146,000 or more;
//   * NOT covered but the spouse is: MAGI range $236,000-$246,000, reduction x 70%
//     (80% if age 50+), full deduction at a gap of $10,000 or more;
//   * neither covered: no phase-out.
//   deduction = the smallest of the reduced limit (when it applies), compensation
//   (line 5; a spouse with less compensation adds the other spouse's compensation
//   reduced by that spouse's traditional and Roth IRA contributions) and the
//   contribution (capped at the $7,000 / $8,000 limit).
// MAGI (Worksheet 1-1) = Form 1040 line 9 minus Schedule 1 lines 11-19a, 23 and 25
// (so it is before the IRA and student loan interest deductions); the caller
// supplies it.
//
// Not computed (needs_cpa_judgment): contributions above the limit (traditional plus
// Roth), and any year with Social Security benefits when a spouse is covered (the
// Pub. 590-A Appendix B worksheets). "Not sure" and unanswered inputs are never
// guessed. Nondeductible contributions (Form 8606) are the CPA's.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD, sumThenRound } from "@/lib/tax2025/money";
import { aggregateStatus, worstBlocked, type RuleLine, type RuleResult, type RuleStatus } from "@/lib/tax2025/types";

export type IraSlot = "a" | "b";

export interface IraPersonInput {
  slot: IraSlot;
  name: string;
  /** Traditional IRA contributions for 2025 (dollars); none = answered(0). */
  traditional: Ans<Decimal>;
  roth: Ans<Decimal>;
  age50Plus: Ans<boolean>;
  covered: Ans<boolean>;
  /** The person's own compensation for the IRA limit (wages + net self-employment earnings less Schedule 1 lines 15 and 16); null = unknown. */
  compensation: Decimal | null;
}

export interface IraInput {
  people: IraPersonInput[];
  /** Worksheet 1-1 line 7; null = not computed yet. */
  magi: Decimal | null;
  /** Owner statement: no IRA distributions, pensions or Social Security benefits (retirement_ss_income). */
  noSocialSecurityBenefits: boolean | null;
}

type Blocked = Exclude<RuleStatus, "computed" | "not_applicable">;
type Out = { ok: true; deduction: Decimal; notes: string[]; line: RuleLine } | { ok: false; status: Blocked; reason: string; missing: string; line: RuleLine };

const CITES = ["IRA_LIMIT", "IRA_LIMIT_AGE_50", "IRA_PHASEOUT_COVERED_MFJ", "IRA_PHASEOUT_SPOUSE_COVERED_MFJ", "IRA_WORKSHEET_REDUCTION_COVERED_MFJ", "IRA_WORKSHEET_REDUCTION_OTHER", "IRA_FULL_DEDUCTION_RANGE_COVERED_MFJ", "IRA_FULL_DEDUCTION_RANGE_OTHER", "IRA_REDUCED_MINIMUM", "IRA_ROUND_UP_TO"];
const SLOT_KEY = { a: "ira.a.7", b: "ira.b.7" } as const;
const SLOT_LABEL = { a: "IRA deduction, taxpayer A", b: "IRA deduction, taxpayer B" } as const;
const SLOT_LINE = { a: "1-2 line 7 (A)", b: "1-2 line 7 (B)" } as const;

function stopOut(p: IraPersonInput, status: Blocked, reason: string, missing: string): Out {
  const text = `${p.name}: ${reason}`;
  return { ok: false, status, reason: text, missing, line: blockedLine(SLOT_KEY[p.slot], SLOT_LABEL[p.slot], SLOT_LINE[p.slot], status, text) };
}

function need<T>(a: Ans<T>, p: IraPersonInput, what: string): Out | null {
  if (a.state === "missing") return stopOut(p, "missing_input", `${what} has not been answered.`, `${what} (${p.name})`);
  if (a.state === "unsure") return stopOut(p, "needs_cpa_judgment", `the owner is not sure about ${what}; the CPA decides.`, `${what} (${p.name})`);
  return null;
}

export function computeIraDeduction(input: IraInput): RuleResult {
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  if (input.magi !== null) {
    lines.push(amountLine("ira.magi", "Modified AGI for the traditional IRA deduction", "1-1 line 7", input.magi, "computed", "Form 1040 line 9 minus Schedule 1 lines 11-19a, 23 and 25."));
  }
  const people = input.people;
  // Coverage of every person is needed whenever a contribution exists (the spouse's coverage matters too).
  const coverageOf = (p: IraPersonInput | undefined): boolean | null => (p === undefined || p.covered.state !== "answered" ? null : p.covered.value);

  const outs: Out[] = people.map((p): Out => {
    const trad = need(p.traditional, p, "the traditional IRA contribution");
    if (trad !== null) return trad;
    const tradAmt = (p.traditional as { state: "answered"; value: Decimal }).value;
    if (tradAmt.isZero()) {
      return {
        ok: true,
        deduction: ZERO,
        notes: [`${p.name}: no traditional IRA contribution, so no IRA deduction.`],
        line: amountLine(SLOT_KEY[p.slot], SLOT_LABEL[p.slot], SLOT_LINE[p.slot], ZERO, "not_applicable", "No traditional IRA contribution for 2025 (owner answer)."),
      };
    }
    const age = need(p.age50Plus, p, "whether age 50 or older at the end of 2025");
    if (age !== null) return age;
    const cov = need(p.covered, p, "whether covered by a retirement plan at work");
    if (cov !== null) return cov;
    const roth = need(p.roth, p, "the Roth IRA contribution");
    if (roth !== null) return roth;
    const other = people.find((o) => o !== p);
    if (other !== undefined) {
      const oc = need(other.covered, p, `whether ${other.name} was covered by a retirement plan at work`);
      if (oc !== null) return oc;
    }
    const age50 = (p.age50Plus as { state: "answered"; value: boolean }).value;
    const limit = D(age50 ? K.IRA_LIMIT_AGE_50.value : K.IRA_LIMIT.value);
    const rothAmt = (p.roth as { state: "answered"; value: Decimal }).value;
    if (tradAmt.plus(rothAmt).greaterThan(limit)) {
      return stopOut(p, "needs_cpa_judgment", `traditional ${fmt(tradAmt)} plus Roth ${fmt(rothAmt)} contributions exceed the ${fmt(limit)} limit: excess contributions are the CPA's.`, `IRA excess contributions (${p.name})`);
    }
    const covered = coverageOf(p) === true;
    const spouseCovered = coverageOf(other) === true;
    if ((covered || spouseCovered) && input.noSocialSecurityBenefits !== true) {
      return stopOut(
        p,
        input.noSocialSecurityBenefits === null ? "missing_input" : "needs_cpa_judgment",
        "a spouse is covered by a workplace plan and the owner has not stated that there are no Social Security benefits, pensions or IRA distributions (Pub. 590-A Appendix B applies if there are Social Security benefits).",
        "Statement: no retirement or Social Security income"
      );
    }
    if (p.compensation === null) {
      return stopOut(p, "missing_input", "compensation (W-2 wages and self-employment earnings) is not known yet.", `compensation (${p.name})`);
    }
    // Worksheet 1-2 line 5: own compensation; a spouse with less compensation adds the other spouse's compensation less their IRA contributions.
    let comp5 = p.compensation;
    if (other !== undefined) {
      if (other.compensation === null) return stopOut(p, "missing_input", `${other.name}'s compensation is not known yet.`, `compensation (${other.name})`);
      if (p.compensation.lessThan(other.compensation)) {
        const otherTrad = other.traditional.state === "answered" ? other.traditional.value : null;
        const otherRoth = other.roth.state === "answered" ? other.roth.value : null;
        if (otherTrad === null || otherRoth === null) {
          return stopOut(p, "missing_input", `${other.name}'s IRA contributions are needed for the spousal IRA limit.`, `IRA contributions (${other.name})`);
        }
        comp5 = p.compensation.plus(maxD(ZERO, other.compensation.minus(otherTrad).minus(otherRoth)));
      }
    }
    comp5 = maxD(ZERO, comp5);
    const line6 = minD(tradAmt, limit);
    const notes: string[] = [];
    let reducedLimit: Decimal | null = null;
    if (covered || spouseCovered) {
      if (input.magi === null) return stopOut(p, "missing_input", "the modified AGI is not computed yet.", "modified AGI");
      const range = covered ? K.IRA_PHASEOUT_COVERED_MFJ.value : K.IRA_PHASEOUT_SPOUSE_COVERED_MFJ.value;
      const line1 = D(range.end);
      const line2 = input.magi;
      if (line2.greaterThanOrEqualTo(line1)) {
        notes.push(`${p.name}: modified AGI ${fmt(line2)} is ${fmt(line1)} or more${covered ? " and the owner is covered by a plan at work" : " and the spouse is covered by a plan at work"}: the contribution is not deductible.`);
        return { ok: true, deduction: ZERO, notes, line: amountLine(SLOT_KEY[p.slot], SLOT_LABEL[p.slot], SLOT_LINE[p.slot], ZERO, "computed", notes[0]) };
      }
      const line3 = line1.minus(line2);
      const fullAt = D(covered ? K.IRA_FULL_DEDUCTION_RANGE_COVERED_MFJ.value : K.IRA_FULL_DEDUCTION_RANGE_OTHER.value);
      if (line3.lessThan(fullAt)) {
        const pct = (covered ? K.IRA_WORKSHEET_REDUCTION_COVERED_MFJ.value : K.IRA_WORKSHEET_REDUCTION_OTHER.value)[age50 ? "age50" : "under50"];
        const step = D(K.IRA_ROUND_UP_TO.value);
        const raw = line3.times(D(pct));
        const rounded = raw.div(step).ceil().times(step);
        reducedLimit = maxD(rounded, D(K.IRA_REDUCED_MINIMUM.value));
        notes.push(`${p.name}: modified AGI ${fmt(line2)} is inside the phase-out (line 3 = ${fmt(line1)} minus ${fmt(line2)} = ${fmt(line3)}); x ${pct * 100}% = ${fmt(raw.toDecimalPlaces(2))}, rounded up to a multiple of ${fmt(step)} and at least ${fmt(D(K.IRA_REDUCED_MINIMUM.value))}: ${fmt(reducedLimit)}.`);
      } else {
        notes.push(`${p.name}: modified AGI ${fmt(line2)} is at least ${fmt(fullAt)} below ${fmt(line1)}: no reduction.`);
      }
    } else {
      notes.push(`${p.name}: neither spouse is covered by a workplace plan: no phase-out.`);
    }
    const candidates = [comp5, line6];
    if (reducedLimit !== null) candidates.push(reducedLimit);
    const ded = candidates.reduce((a, b) => (a.lessThan(b) ? a : b));
    notes.push(`${p.name}: deduction = smallest of compensation ${fmt(comp5)}, contribution ${fmt(line6)}${reducedLimit !== null ? `, reduced limit ${fmt(reducedLimit)}` : ""} = ${fmt(ded)}.`);
    return { ok: true, deduction: ded, notes, line: amountLine(SLOT_KEY[p.slot], SLOT_LABEL[p.slot], SLOT_LINE[p.slot], ded, ded.isZero() ? "not_applicable" : "computed", notes.join(" ")) };
  });

  for (const o of outs) lines.push(o.line);
  const present = new Set(people.map((p) => p.slot));
  for (const slot of ["a", "b"] as const) {
    if (!present.has(slot)) lines.push(amountLine(SLOT_KEY[slot], SLOT_LABEL[slot], SLOT_LINE[slot], ZERO, "not_applicable", "No second person on this return."));
  }
  const missing: string[] = [];
  const blocked = outs.filter((o): o is Extract<Out, { ok: false }> => !o.ok);
  if (blocked.length > 0) {
    const status = worstBlocked(blocked.map((b) => b.status)) as Blocked;
    const why = blocked.map((b) => b.reason).join(" ");
    lines.push(blockedLine("sch1.20", "IRA deduction", "20", status, why));
    reasons.push(why);
    for (const b of blocked) missing.push(b.missing);
  } else {
    const oks = outs as Extract<Out, { ok: true }>[];
    const total = sumThenRound(oks.map((o) => o.deduction));
    lines.push(
      amountLine(
        "sch1.20",
        "IRA deduction",
        "20",
        total,
        total.isZero() ? "not_applicable" : "computed",
        total.isZero() ? "No deductible traditional IRA contribution (see the per-person lines)." : "Worksheet 1-2 line 7 of each spouse, combined."
      )
    );
    for (const o of oks) reasons.push(...o.notes);
  }
  return {
    ruleId: "ira-deduction",
    form: "Pub. 590-A worksheets / Schedule 1",
    status: aggregateStatus(lines, "computed"),
    lines,
    reasons,
    citations: CITES,
    inputsUsed: [],
    inputsMissing: missing,
  };
}
