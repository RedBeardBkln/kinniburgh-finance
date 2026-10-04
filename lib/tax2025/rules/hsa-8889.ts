// Form 8889 Part I (HSA contributions and deduction) -> Schedule 1 line 13.
//
// One Form 8889 per spouse (Form 8889 instructions: "Complete a separate Form 8889
// for each spouse. Combine the amounts on line 13 of both Forms 8889 ..."). Sources
// (all irs.gov, verified 2026-10-03; ids in lib/tax2025/constants.ts):
//   line 3  limit: $4,300 self-only / $8,550 family; if either spouse has family
//           coverage and both are eligible, both are treated as family; a person who
//           was an eligible individual on the first day of the LAST month (December 1)
//           is treated as eligible for the whole year (the "last-month rule", with a
//           testing period through the end of the next year); otherwise the Line 3
//           Limitation Chart is applied month by month (months / 12);
//   line 7  the additional contribution amount for a person age 55 or older who is
//           married with family coverage ($1,000 x eligible months / 12); for self-only
//           coverage the $1,000 is part of line 3;
//   line 6  spouses with separate HSAs and family coverage divide line 5 equally
//           (unless they agree otherwise); only the equal split is computed here;
//   line 9  employer contributions = W-2 box 12 code W (payroll contributions through
//           a cafeteria plan are employer contributions);
//   line 13 the smaller of line 2 and line 12.
// What the engine does NOT decide (needs_cpa_judgment, never guessed): a coverage
// type that changed during the year, any month in Medicare or as someone's
// dependent, employer contributions that belong to another year, contributions
// above the limit (excess contributions, Form 5329), HSA distributions (Part II),
// separate HSAs with family coverage that is not in force all year (Line 6 steps),
// and Archer MSA / qualified funding distributions (lines 4 and 10 are taken as $0;
// the "other adjustments" statement covers Form 8853).
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD, sumThenRound } from "@/lib/tax2025/money";
import { aggregateStatus, worstBlocked, type LineKey, type RuleLine, type RuleResult, type RuleStatus } from "@/lib/tax2025/types";

export type HsaSlot = "a" | "b";

export interface HsaPersonInput {
  slot: HsaSlot;
  name: string;
  coverage: Ans<"none" | "self_only" | "family" | "changed">;
  /** Months (0-12) the person was an eligible individual on the first day of the month. */
  monthsEligible: Ans<number>;
  eligibleDec1: Ans<boolean>;
  /** True = some month enrolled in Medicare or someone else's dependent. */
  medicareOrDependent: Ans<boolean>;
  age55Plus: Ans<boolean>;
  directContributions: Ans<Decimal>;
  employerOtherYear: Ans<boolean>;
  distributions: Ans<"none" | "some">;
  /** W-2 box 12 code W total for this person (0 when no code W); null = unknown (a W-2 box 12 was not read). */
  employerContributionsW2: Decimal | null;
}

type Blocked = Exclude<RuleStatus, "computed" | "not_applicable">;

type PersonOut =
  | { ok: true; deduction: Decimal; applicable: boolean; notes: string[]; lines: RuleLine[] }
  | { ok: false; status: Blocked; reason: string; missing: string[]; lines: RuleLine[] };

const KEYS: Record<HsaSlot, Record<"2" | "3" | "8" | "9" | "12" | "13", LineKey>> = {
  a: { "2": "f8889a.2", "3": "f8889a.3", "8": "f8889a.8", "9": "f8889a.9", "12": "f8889a.12", "13": "f8889a.13" },
  b: { "2": "f8889b.2", "3": "f8889b.3", "8": "f8889b.8", "9": "f8889b.9", "12": "f8889b.12", "13": "f8889b.13" },
};
const LABELS: Record<"2" | "3" | "8" | "9" | "12" | "13", string> = {
  "2": "HSA contributions made by or for the spouse",
  "3": "Contribution limit before reductions",
  "8": "Limit including the additional contribution amount",
  "9": "Employer contributions",
  "12": "Limit after employer contributions",
  "13": "HSA deduction",
};
const LINE_IDS = ["2", "3", "8", "9", "12", "13"] as const;

const CITES = ["HSA_LIMIT_SELF_ONLY", "HSA_LIMIT_FAMILY", "HSA_CATCH_UP_55"];

function allBlocked(slot: HsaSlot, status: Blocked, reason: string): RuleLine[] {
  return LINE_IDS.map((id) => blockedLine(KEYS[slot][id], LABELS[id], id, status, reason));
}

function allNotApplicable(slot: HsaSlot, reason: string): RuleLine[] {
  return LINE_IDS.map((id) => amountLine(KEYS[slot][id], LABELS[id], id, ZERO, "not_applicable", reason));
}

function stop(p: HsaPersonInput, status: Blocked, reason: string, missing: string): PersonOut {
  const text = `${p.name}: ${reason}`;
  return { ok: false, status, reason: text, missing: [missing], lines: allBlocked(p.slot, status, text) };
}

function needAns<T>(a: Ans<T>, p: HsaPersonInput, what: string): PersonOut | null {
  if (a.state === "missing") return stop(p, "missing_input", `${what} has not been answered.`, `${what} (${p.name})`);
  if (a.state === "unsure") return stop(p, "needs_cpa_judgment", `the owner is not sure about ${what}; the CPA decides.`, `${what} (${p.name})`);
  return null;
}

export function computeHsa8889(input: { people: HsaPersonInput[] }): RuleResult {
  const people = input.people;
  const limitSelf = D(K.HSA_LIMIT_SELF_ONLY.value);
  const limitFamily = D(K.HSA_LIMIT_FAMILY.value);
  const catchUp = D(K.HSA_CATCH_UP_55.value);

  // The couple's coverage picture: either spouse with family coverage makes BOTH eligible spouses family.
  const eligibleCov = (p: HsaPersonInput): "self_only" | "family" | null =>
    p.coverage.state === "answered" && (p.coverage.value === "self_only" || p.coverage.value === "family") ? p.coverage.value : null;
  const anyFamily = people.some((p) => eligibleCov(p) === "family");

  const outs: PersonOut[] = people.map((p): PersonOut => {
    // Distributions (Part II) are never computed here.
    const dist = needAns(p.distributions, p, "whether any HSA distribution was received in 2025");
    if (dist !== null) return dist;
    if (p.distributions.state === "answered" && p.distributions.value === "some") {
      return stop(p, "needs_cpa_judgment", "the owner received HSA distributions in 2025 (Form 8889 Part II, Form 1099-SA); this engine computes the contribution deduction only.", "HSA distributions (Form 1099-SA)");
    }
    const cov = needAns(p.coverage, p, "high-deductible health plan coverage");
    if (cov !== null) return cov;
    const coverage = (p.coverage as { state: "answered"; value: "none" | "self_only" | "family" | "changed" }).value;
    if (coverage === "none") {
      if (p.employerContributionsW2 !== null && p.employerContributionsW2.greaterThan(0)) {
        return stop(p, "needs_cpa_judgment", `the owner says there was no HDHP coverage but the W-2 shows employer HSA contributions (box 12 code W, ${fmt(p.employerContributionsW2)}).`, "HSA coverage versus W-2 box 12 code W");
      }
      return { ok: true, deduction: ZERO, applicable: false, notes: [`${p.name}: no HDHP coverage and no HSA activity, so no Form 8889.`], lines: allNotApplicable(p.slot, `${p.name} had no HSA-eligible coverage in 2025 (owner answer).`) };
    }
    if (coverage === "changed") {
      return stop(p, "needs_cpa_judgment", "the HDHP coverage type changed during 2025; the Line 3 Limitation Chart (month by month) is the CPA's.", "HDHP coverage type by month");
    }
    const med = needAns(p.medicareOrDependent, p, "Medicare enrollment or dependent status");
    if (med !== null) return med;
    if (p.medicareOrDependent.state === "answered" && p.medicareOrDependent.value) {
      return stop(p, "needs_cpa_judgment", "the owner was enrolled in Medicare or claimed as someone else's dependent for some month, which removes those months from the contribution limit; the month-by-month chart is the CPA's.", "Medicare / dependent months");
    }
    const months = needAns(p.monthsEligible, p, "the months of HDHP coverage");
    if (months !== null) return months;
    const dec1 = needAns(p.eligibleDec1, p, "whether covered on December 1, 2025");
    if (dec1 !== null) return dec1;
    const age = needAns(p.age55Plus, p, "whether age 55 or older at the end of 2025");
    if (age !== null) return age;
    const direct = needAns(p.directContributions, p, "the HSA contributions made directly (not through payroll)");
    if (direct !== null) return direct;
    const emp = needAns(p.employerOtherYear, p, "whether employer contributions include another year's money");
    if (emp !== null) return emp;
    if (p.employerOtherYear.state === "answered" && p.employerOtherYear.value) {
      return stop(p, "needs_cpa_judgment", "employer contributions include another year's money (Form 8889 Employer Contribution Worksheet).", "Employer Contribution Worksheet");
    }
    if (p.employerContributionsW2 === null) {
      return stop(p, "missing_input", "a W-2 box 12 was not read, so employer HSA contributions (code W) are unknown.", `W-2 box 12 code W (${p.name})`);
    }
    // All answered: compute.
    const monthsN = (p.monthsEligible as { state: "answered"; value: number }).value;
    const dec1Yes = (p.eligibleDec1 as { state: "answered"; value: boolean }).value;
    const age55 = (p.age55Plus as { state: "answered"; value: boolean }).value;
    const direct2 = (p.directContributions as { state: "answered"; value: Decimal }).value;
    const notes: string[] = [];
    const treatedFamily = coverage === "family" || (anyFamily && people.some((o) => o !== p && eligibleCov(o) !== null));
    if (treatedFamily && coverage !== "family") notes.push(`${p.name} is treated as having family coverage because the spouse's HDHP is a family plan.`);
    const fullYear = monthsN >= 12 || dec1Yes;
    if (dec1Yes && monthsN < 12) {
      notes.push(`${p.name} was covered on December 1, so the last-month rule treats the whole year as eligible; the person must stay eligible through the end of the next year or part of the contributions becomes income (Form 8889 Part III).`);
    }
    const fraction = fullYear ? D(1) : D(monthsN).div(12);
    const baseAmount = treatedFamily ? limitFamily : age55 ? limitSelf.plus(catchUp) : limitSelf;
    const line3 = baseAmount.times(fraction);
    const line5 = line3; // line 4 (Archer MSA) is $0
    // Line 6: spouses who both have HSAs under family coverage split line 5 equally
    const other = people.find((o) => o !== p);
    const otherHasHsa =
      other !== undefined &&
      eligibleCov(other) !== null &&
      ((other.directContributions.state === "answered" && other.directContributions.value.greaterThan(0)) ||
        (other.employerContributionsW2 !== null && other.employerContributionsW2.greaterThan(0)));
    const meHasHsa = direct2.greaterThan(0) || p.employerContributionsW2.greaterThan(0);
    let line6 = line5;
    if (treatedFamily && otherHasHsa && meHasHsa) {
      const otherFull = other !== undefined && other.monthsEligible.state === "answered" && (other.monthsEligible.value >= 12 || (other.eligibleDec1.state === "answered" && other.eligibleDec1.value));
      if (!fullYear || !otherFull) {
        return stop(p, "needs_cpa_judgment", "both spouses have separate HSAs under family coverage that was not in force all year: Form 8889 line 6 steps 1-4 are the CPA's.", "Form 8889 line 6 allocation");
      }
      line6 = line5.div(2);
      notes.push(`Both spouses have separate HSAs under family coverage: the limit ${fmt(line5)} is divided equally (${fmt(line6)} each) unless the spouses agree on another split.`);
    }
    const line7 = treatedFamily && age55 ? catchUp.times(fraction) : ZERO;
    const line8 = line6.plus(line7);
    const line9 = p.employerContributionsW2;
    const line12 = maxD(ZERO, line8.minus(line9));
    const line13 = minD(direct2, line12);
    const excess = direct2.minus(line13);
    const lines: RuleLine[] = [
      amountLine(KEYS[p.slot]["2"], LABELS["2"], "2", direct2, "computed", "Contributions made directly by the owner for 2025 (payroll contributions are employer contributions on line 9)."),
      amountLine(KEYS[p.slot]["3"], LABELS["3"], "3", line3, "computed", `${treatedFamily ? "Family" : "Self-only"} limit${fullYear ? "" : ` for ${monthsN} of 12 months`}.`),
      amountLine(KEYS[p.slot]["8"], LABELS["8"], "8", line8, "computed", line7.greaterThan(0) ? `Includes the additional contribution amount ${fmt(line7)} (line 7).` : undefined),
      amountLine(KEYS[p.slot]["9"], LABELS["9"], "9", line9, "computed", "W-2 box 12 code W."),
      amountLine(KEYS[p.slot]["12"], LABELS["12"], "12", line12, "computed"),
    ];
    if (direct2.greaterThan(line12)) {
      const why = `${p.name}: contributions of ${fmt(direct2)} exceed the limit of ${fmt(line12)} by ${fmt(excess)}: excess contributions are taxed (Form 5329) or must be withdrawn; the CPA decides.`;
      return { ok: false, status: "needs_cpa_judgment", reason: why, missing: [`Excess HSA contributions (${p.name})`], lines: [...lines, blockedLine(KEYS[p.slot]["13"], LABELS["13"], "13", "needs_cpa_judgment", why)] };
    }
    if (line9.greaterThan(line8)) {
      const why = `${p.name}: employer contributions ${fmt(line9)} exceed the limit ${fmt(line8)} (excess employer contributions are income); the CPA decides.`;
      return { ok: false, status: "needs_cpa_judgment", reason: why, missing: [`Excess employer HSA contributions (${p.name})`], lines: [...lines, blockedLine(KEYS[p.slot]["13"], LABELS["13"], "13", "needs_cpa_judgment", why)] };
    }
    lines.push(amountLine(KEYS[p.slot]["13"], LABELS["13"], "13", line13, line13.isZero() ? "not_applicable" : "computed", `Smaller of line 2 (${fmt(direct2)}) and line 12 (${fmt(line12)}).`));
    notes.push(`${p.name}: HSA deduction ${fmt(line13)} (limit ${fmt(line8)}, employer contributions ${fmt(line9)}, own contributions ${fmt(direct2)}).`);
    return { ok: true, deduction: line13, applicable: true, notes, lines };
  });

  // Slots without a person: explicit not-applicable lines.
  const lines: RuleLine[] = [];
  const present = new Set(people.map((p) => p.slot));
  for (const o of outs) lines.push(...o.lines);
  for (const slot of ["a", "b"] as const) if (!present.has(slot)) lines.push(...allNotApplicable(slot, "No second person on this return."));

  const reasons: string[] = [];
  const missing: string[] = [];
  const blocked = outs.filter((o): o is Extract<PersonOut, { ok: false }> => !o.ok);
  if (blocked.length > 0) {
    const status = worstBlocked(blocked.map((b) => b.status)) as Blocked;
    const why = blocked.map((b) => b.reason).join(" ");
    lines.push(blockedLine("sch1.13", "Health savings account deduction", "13", status, why));
    reasons.push(why);
    for (const b of blocked) missing.push(...b.missing);
  } else {
    const okOuts = outs as Extract<PersonOut, { ok: true }>[];
    const total = sumThenRound(okOuts.map((o) => o.deduction));
    const any = okOuts.some((o) => o.applicable);
    lines.push(
      amountLine(
        "sch1.13",
        "Health savings account deduction",
        "13",
        total,
        any && !total.isZero() ? "computed" : "not_applicable",
        !any
          ? "Neither spouse had HSA-eligible coverage or HSA activity in 2025 (owner answers)."
          : total.isZero()
            ? "HSA-eligible coverage but no deductible contributions of the owner's own (employer and payroll contributions are not deductible here)."
            : "Form 8889 line 13 of each spouse, combined."
      )
    );
    for (const o of okOuts) reasons.push(...o.notes);
  }
  return {
    ruleId: "hsa-8889",
    form: "Form 8889",
    status: aggregateStatus(lines, "computed"),
    lines,
    reasons,
    citations: CITES,
    inputsUsed: [],
    inputsMissing: missing,
  };
}
