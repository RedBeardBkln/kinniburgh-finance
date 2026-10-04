// Schedule 1-A (new for 2025): additional deductions, Form 1040 line 13b. EVERY printed money line of the
// 2025 form has an engine line (the PDF layer never computes anything):
//   Part I   MAGI                              (line 1 = Form 1040 line 11b, line 3 = line 1 + 2e)
//   Part II  qualified tips                     (lines 4a-13)
//   Part III qualified overtime compensation    (lines 14a-21)
//   Part IV  qualified passenger vehicle loan interest (lines 23-30; line 22 holds VINs, never stored)
//   Part V   enhanced deduction for seniors     (lines 31-37)
//   Part VI  total                              (line 38 -> Form 1040 line 13b)
//
// Every formula and amount is read from the 2025 form itself (f1040s1a.pdf) and the Schedule 1-A
// instructions, which are printed inside the 2025 Form 1040 instructions (pp. 101-110, irs.gov
// /pub/irs-prior/i1040gi--2025.pdf), registered in lib/tax2025/constants.ts (verified 2026-10-04):
//   - tips: smaller of line 6 and the maximum (a COMBINED limit, not per spouse); the amount is reduced
//     by $100 per $1,000 (rounded DOWN) of MAGI over the start;
//   - overtime: the maximum is the MFJ limit (combined, not per spouse), same reduction and rounding;
//   - car-loan interest: smaller of line 23 and the maximum; reduced by $200 per $1,000 (rounded UP) of
//     MAGI over the start; interest also deducted on Schedule C is excluded (column ii);
//   - seniors: $6,000 minus 6% of the MAGI over the start (line 35), entered for each person born before
//     January 2, 1961 with a valid SSN.
// MFJ is required for all four (the engine is MFJ-only).
//
// The printed form foots BY CONSTRUCTION: like a person filling it in, the rule rounds the ENTERED lines
// (4a, 14a, 23, and every line copied from the return) to whole dollars and derives every later line from the
// whole-dollar lines above it. A part that is not used emits not_applicable for ALL its lines (the form says to
// fill out a part only if you received that kind of income); when the MAGI is not over the part's start the
// instructions skip the reduction lines and carry the capped amount straight to the deduction line, so those
// lines are not_applicable and the deduction line is the capped amount.
//
// Nothing is guessed: an unanswered or "not sure" input gives missing_input / needs_cpa_judgment; "none" gives a
// not_applicable zero that states why. The qualified-tip and qualified-overtime AMOUNTS are owner-stated (the 2025
// W-2 does not separately report them; the instructions say so), so the reasons name the method used. Whether the
// tips were received in an occupation on the IRS list is the owner's statement (the app records no occupation).
// Tips from the owner's own business (Forms 1099-NEC / 1099-K, line 5) are not collected: line 5 is 0 only when the
// Schedule C owner states no tips at all, otherwise it goes to the CPA.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { block, makeEmitters, mergeBlocked, type BlockedVal, type Blocked, type Emitters, type Val } from "@/lib/tax2025/rules/line-emit";
import { D, ZERO, fmt, maxD, minD, roundLine } from "@/lib/tax2025/money";
import { aggregateStatus, type LineKey, type RuleLine, type RuleResult } from "@/lib/tax2025/types";

export interface Sch1aPersonInput {
  name: string;
  bornBefore1961: Ans<boolean>;
  validSsn: Ans<boolean>;
  tips: Ans<"none" | "some" | "ask_employer">;
  tipsAmount: Ans<Decimal>;
  overtime: Ans<"none" | "premium" | "total" | "ask_employer">;
  overtimeAmount: Ans<Decimal>;
}

export interface Sch1aInput {
  /** Form 1040 line 11b; null = not computed yet. */
  magi: Decimal | null;
  /** True = no Puerto Rico excluded income and no Form 2555 / 4563 (lines 2a-2e are zero). */
  magiExclusionsNone: Ans<boolean>;
  /** One or two taxpayers, in slot order (A then B). */
  people: Sch1aPersonInput[];
  carLoan: {
    choice: Ans<"none" | "some">;
    /** The vehicle and the loan meet every listed condition. */
    qualifies: Ans<boolean>;
    interestPaid: Ans<Decimal>;
    deductedElsewhere: Ans<Decimal>;
  };
  /**
   * W-2 box 7 (social security tips) across the household: how many W-2s show a positive box 7 and their total in dollars.
   * Line 4a may be filled only when exactly one employer reported tips and the owner's tips equal that box 7; null = unknown.
   */
  tipsEmployers: { employersWithBox7: number; box7Total: Decimal } | null;
  /**
   * The Schedule C owner's own tips answer ("none" means no tips at all, so there are no business tips for line 5);
   * null = no Schedule C owner is identified.
   */
  scheduleCOwnerTips: Ans<"none" | "some" | "ask_employer"> | null;
}

/** An amount, or why there is none (used for the owner's tips / overtime / seniors answers). */
type Piece = { kind: "amount"; value: Decimal; notes: string[] } | { kind: "blocked"; status: Blocked; reason: string; missing: string };

const CITES = [
  "SCH1A_TIPS_MAX",
  "SCH1A_TIPS_MAGI_START_MFJ",
  "SCH1A_TIPS_REDUCTION_PER_1000",
  "SCH1A_OVERTIME_MAX_MFJ",
  "SCH1A_OVERTIME_MAGI_START_MFJ",
  "SCH1A_OVERTIME_REDUCTION_PER_1000",
  "SCH1A_CAR_LOAN_MAX",
  "SCH1A_CAR_LOAN_MAGI_START_MFJ",
  "SCH1A_CAR_LOAN_REDUCTION_PER_1000",
  "SCH1A_SENIOR_AMOUNT",
  "SCH1A_SENIOR_MAGI_START_MFJ",
  "SCH1A_SENIOR_REDUCTION_RATE",
  "SCH1A_REDUCTION_STEP",
  "SCH1A_SENIOR_BORN_BEFORE",
];

/** The owner's answer as a blocking reason (missing / not sure), or null when it is answered. */
function ansBlock<T>(a: Ans<T>, who: string, what: string, askWhom: string): BlockedVal | null {
  if (a.state === "missing") return block("missing_input", `${who}: ${what} has not been answered.`, `${what} (${who})`);
  if (a.state === "unsure") return block("needs_cpa_judgment", `${who}: the owner is not sure about ${what}; ${askWhom}.`, `${what} (${who})`);
  return null;
}

/** Tips or overtime for one person after the SSN check; amount may be zero. */
function employeeAmount(kind: "tips" | "overtime", p: Sch1aPersonInput): Piece {
  const choice = kind === "tips" ? p.tips : p.overtime;
  const raw = kind === "tips" ? p.tipsAmount : p.overtimeAmount;
  const noun = kind === "tips" ? "qualified tips" : "qualified overtime";
  const first = ansBlock(choice, p.name, noun, "the CPA decides");
  if (first !== null) return { kind: "blocked", status: first.status, reason: first.reason, missing: first.missing };
  if (choice.state !== "answered") return { kind: "blocked", status: "missing_input", reason: `${p.name}: ${noun} not answered.`, missing: noun };
  if (choice.value === "none") return { kind: "amount", value: ZERO, notes: [`${p.name}: the owner states no ${noun}.`] };
  if (choice.value === "ask_employer") {
    return {
      kind: "blocked",
      status: "missing_input",
      reason:
        kind === "tips"
          ? `${p.name}: the owner will ask the employer for the qualified tips figure (W-2 box 7, or the tips reported to the employer on Form 4070).`
          : `${p.name}: the owner will ask the employer for the FLSA overtime premium (W-2 box 14 may show it; otherwise the instructions give methods based on a statement of overtime pay).`,
      missing: `${noun} figure from the employer (${p.name})`,
    };
  }
  const amt = ansBlock(raw, p.name, `the ${noun} amount`, "the CPA decides");
  if (amt !== null) return { kind: "blocked", status: amt.status, reason: amt.reason, missing: amt.missing };
  if (raw.state !== "answered") return { kind: "blocked", status: "missing_input", reason: `${p.name}: the ${noun} amount is missing.`, missing: `${noun} amount (${p.name})` };
  const stated = kind === "overtime" && choice.value === "total" ? raw.value.div(3) : raw.value;
  const how =
    kind === "overtime" && choice.value === "total"
      ? `total pay for the overtime hours ${fmt(raw.value)} divided by three (the instructions' method for a statement showing premium plus regular wages, correct only for time-and-a-half) = ${fmt(stated)}`
      : kind === "overtime"
        ? `the FLSA overtime premium ${fmt(stated)} as stated by the owner`
        : `qualified tips ${fmt(stated)} as stated by the owner (W-2 box 7 or tips reported to the employer)`;
  // A valid SSN is required for the person who received the amount.
  if (stated.greaterThan(0)) {
    if (p.validSsn.state === "unsure") {
      return { kind: "blocked", status: "needs_cpa_judgment", reason: `${p.name}: the owner is not sure the Social Security number is valid for employment; the CPA decides.`, missing: `valid SSN (${p.name})` };
    }
    if (p.validSsn.state === "missing") {
      return { kind: "blocked", status: "missing_input", reason: `${p.name}: whether the Social Security number is valid for employment has not been answered.`, missing: `valid SSN (${p.name})` };
    }
    if (p.validSsn.value === false) {
      return { kind: "amount", value: ZERO, notes: [`${p.name}: no Social Security number valid for employment, so the ${noun} do not qualify (${how}).`] };
    }
  }
  return { kind: "amount", value: stated, notes: [`${p.name}: ${how}.`] };
}

function sumPieces(pieces: Piece[]): Piece {
  const blocked = pieces.filter((p): p is Extract<Piece, { kind: "blocked" }> => p.kind === "blocked");
  if (blocked.length > 0) {
    const m = mergeBlocked(blocked.map((b) => block(b.status, b.reason, b.missing)));
    return { kind: "blocked", status: m.status, reason: m.reason, missing: m.missing };
  }
  let total = ZERO;
  const notes: string[] = [];
  for (const p of pieces) {
    if (p.kind === "amount") {
      total = total.plus(p.value);
      notes.push(...p.notes);
    }
  }
  return { kind: "amount", value: total, notes };
}

interface ReductionKeys {
  l8: LineKey;
  l9: LineKey;
  l10: LineKey;
  l11: LineKey;
  l12: LineKey;
  l13: LineKey;
}

/**
 * Lines "copy of line 3", "threshold", "subtract", "divide by $1,000", "multiply", "deduction" of tips, overtime and car-loan
 * interest. `base` is the capped amount (line 7 / 15 / 24); returns the deduction line (13 / 21 / 30).
 */
function reductionPart(
  h: Emitters,
  k: ReductionKeys,
  base: Val,
  line3: Val,
  cfg: { threshold: Decimal; per: Decimal; direction: "down" | "up"; baseLine: string; skipped: string }
): Val {
  const step = D(K.SCH1A_REDUCTION_STEP.value);
  const l8 = h.calc(k.l8, [line3], (v) => v[0] ?? ZERO, "Copy of line 3 (MAGI).");
  h.amt(k.l9, cfg.threshold, "computed", `The printed threshold for married filing jointly (${fmt(cfg.threshold)}).`);
  if (!l8.ok) {
    h.blk(k.l10, l8);
    h.blk(k.l11, l8);
    h.blk(k.l12, l8);
    return h.blk(k.l13, l8);
  }
  const diff = l8.v.minus(cfg.threshold);
  if (diff.lessThanOrEqualTo(0)) {
    const why = `MAGI ${fmt(l8.v)} is not over ${fmt(cfg.threshold)}: ${cfg.skipped}`;
    h.na(k.l10, why);
    h.na(k.l11, why);
    h.na(k.l12, why);
    return h.calc(k.l13, [base], (v) => v[0] ?? ZERO, `${why} (line ${cfg.baseLine} goes on this line).`);
  }
  h.amt(k.l10, diff, "computed", `MAGI ${fmt(l8.v)} minus ${fmt(cfg.threshold)}.`);
  const quotient = diff.div(step);
  const l11 = h.amt(k.l11, cfg.direction === "down" ? quotient.floor() : quotient.ceil(), "computed", `${fmt(diff)} divided by ${fmt(step)}, rounded ${cfg.direction === "down" ? "DOWN" : "UP"} to a whole number.`);
  const l12 = h.calc(k.l12, [l11], (v) => (v[0] ?? ZERO).times(cfg.per), `Line 11 times $${cfg.per.toString()}.`);
  return h.calc(k.l13, [base, l12], (v) => maxD(ZERO, (v[0] ?? ZERO).minus(v[1] ?? ZERO)), `Line ${cfg.baseLine} minus line 12, not below zero.`);
}

export function computeSchedule1a(input: Sch1aInput): RuleResult {
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  const missing: string[] = [];
  const h = makeEmitters(lines);

  // ── MAGI (Part I) ───────────────────────────────────────────────────────────
  const excl = input.magiExclusionsNone;
  const magiBlock: BlockedVal | null =
    input.magi === null
      ? block("missing_input", "Form 1040 line 11b (adjusted gross income) is not computed yet.", "Form 1040 line 11b")
      : excl.state === "missing"
        ? block("missing_input", "Whether either spouse excluded Puerto Rico income or filed Form 2555 / 4563 has not been answered (Schedule 1-A lines 2a-2e).", "Puerto Rico / Form 2555 / Form 4563 exclusions")
        : excl.state === "unsure"
          ? block("needs_cpa_judgment", "The owner is not sure whether income was excluded (Puerto Rico, Form 2555, Form 4563); the CPA completes Schedule 1-A lines 2a-2e.", "Puerto Rico / Form 2555 / Form 4563 exclusions")
          : excl.value === false
            ? block("needs_cpa_judgment", "The owner reports excluded income (Puerto Rico, Form 2555 or Form 4563): Schedule 1-A lines 2a-2e are not computed by this engine.", "Schedule 1-A lines 2a-2e")
            : null;
  const magi: Decimal | null = magiBlock === null ? input.magi : null;
  /** Line 3 as the later parts see it (computed once, emitted after we know whether any part needs it). */
  const line3: Val = magi !== null ? { ok: true, v: roundLine(magi) } : (magiBlock as BlockedVal);

  // ── Which parts are in use ──────────────────────────────────────────────────
  const tipsSum = sumPieces(input.people.map((p) => employeeAmount("tips", p)));
  const otSum = sumPieces(input.people.map((p) => employeeAmount("overtime", p)));
  const tipsUsed = tipsSum.kind === "blocked" || tipsSum.value.greaterThan(0);
  const otUsed = otSum.kind === "blocked" || otSum.value.greaterThan(0);

  type CarState = { kind: "blocked"; b: BlockedVal } | { kind: "unused"; why: string } | { kind: "used"; line23: Decimal; note: string };
  const car: CarState = (() => {
    const c = input.carLoan;
    const first = ansBlock(c.choice, "Household", "whether a vehicle was bought with a new loan in 2025", "the CPA decides");
    if (first !== null) return { kind: "blocked", b: first };
    if (c.choice.state === "answered" && c.choice.value === "none") {
      return { kind: "unused", why: "The owner states no vehicle was bought with a loan that started after December 31, 2024." };
    }
    const q = ansBlock(c.qualifies, "Household", "whether the vehicle and loan meet every listed condition", "the CPA decides");
    const paid = ansBlock(c.interestPaid, "Household", "the car-loan interest paid in 2025", "the CPA decides");
    const else_ = ansBlock(c.deductedElsewhere, "Household", "the part of that interest deducted on Schedule C", "the CPA decides");
    const firstBlocked = q ?? paid ?? else_;
    if (firstBlocked !== null) return { kind: "blocked", b: firstBlocked };
    if (c.qualifies.state === "answered" && c.qualifies.value === false) {
      return {
        kind: "unused",
        why: "The owner reports the vehicle or loan does not meet the conditions (original use, personal use, first lien, final assembly in the United States, loan originated after December 31, 2024): no deduction.",
      };
    }
    if (c.interestPaid.state === "answered" && c.deductedElsewhere.state === "answered") {
      const line23 = maxD(ZERO, c.interestPaid.value.minus(c.deductedElsewhere.value));
      if (roundLine(line23).isZero()) return { kind: "unused", why: `No qualified car-loan interest: interest paid ${fmt(c.interestPaid.value)} minus ${fmt(c.deductedElsewhere.value)} deducted on Schedule C is zero.` };
      return {
        kind: "used",
        line23,
        note: `Interest paid ${fmt(c.interestPaid.value)} minus ${fmt(c.deductedElsewhere.value)} deducted on Schedule C. The vehicle identification number(s) must be on the return (not stored by this app).`,
      };
    }
    return { kind: "blocked", b: block("missing_input", "The car-loan answers are incomplete.", "car-loan interest") };
  })();

  type SeniorState = { kind: "blocked"; b: BlockedVal } | { kind: "no"; why: string } | { kind: "yes" };
  const seniorStates: SeniorState[] = [0, 1].map((i): SeniorState => {
    const p = input.people[i];
    if (p === undefined) return { kind: "no", why: "No second taxpayer." };
    const b = ansBlock(p.bornBefore1961, p.name, `whether born before ${K.SCH1A_SENIOR_BORN_BEFORE.value}`, "the CPA decides");
    if (b !== null) return { kind: "blocked", b };
    if (p.bornBefore1961.state === "answered" && p.bornBefore1961.value === false) return { kind: "no", why: `${p.name} was not born before ${K.SCH1A_SENIOR_BORN_BEFORE.value}.` };
    const ssn = ansBlock(p.validSsn, p.name, "whether the Social Security number is valid for employment", "the CPA decides");
    if (ssn !== null) return { kind: "blocked", b: ssn };
    if (p.validSsn.state === "answered" && p.validSsn.value === false) return { kind: "no", why: `${p.name} has no Social Security number valid for employment: no senior deduction.` };
    return { kind: "yes" };
  });
  const seniorsUsed = seniorStates.some((s) => s.kind === "yes");
  const seniorBlocks = seniorStates.filter((s): s is Extract<SeniorState, { kind: "blocked" }> => s.kind === "blocked").map((s) => s.b);

  const needsMagi = tipsUsed || otUsed || car.kind !== "unused" || seniorsUsed || seniorBlocks.length > 0;

  // ── Part I: MAGI ────────────────────────────────────────────────────────────
  if (input.magi !== null) {
    h.amt("sch1a.1", input.magi, "computed", "Copy of Form 1040 line 11b.");
  } else if (needsMagi) {
    h.blk("sch1a.1", block("missing_input", "Form 1040 line 11b (adjusted gross income) is not computed yet.", "Form 1040 line 11b"));
  } else {
    h.na("sch1a.1", "No Schedule 1-A part has an amount, so no MAGI is needed.");
  }
  if (magi !== null) {
    h.amt("sch1a.3", magi, "computed", "Form 1040 line 11b plus lines 2a-2e (none: the owner states no excluded income).");
  } else if (needsMagi && magiBlock !== null) {
    h.blk("sch1a.3", magiBlock);
  } else {
    h.na("sch1a.3", "No Schedule 1-A part has an amount, so no MAGI is needed.");
  }

  // ── Part II: tips ───────────────────────────────────────────────────────────
  let tipsDeduction: Val;
  {
    const keys = ["sch1a.4a", "sch1a.4b", "sch1a.4c", "sch1a.5", "sch1a.6", "sch1a.7", "sch1a.8", "sch1a.9", "sch1a.10", "sch1a.11", "sch1a.12", "sch1a.13"] as const;
    if (tipsSum.kind === "blocked") {
      const b = block(tipsSum.status, tipsSum.reason, tipsSum.missing);
      for (const key of keys) h.blk(key, b);
      tipsDeduction = b;
    } else if (!tipsUsed) {
      const why = `No qualified tips (${tipsSum.notes.join(" ")}): Part II is left blank.`;
      for (const key of keys) h.na(key, why);
      tipsDeduction = { ok: true, v: ZERO };
    } else {
      const total = tipsSum.value;
      const te = input.tipsEmployers;
      const single = te !== null && te.employersWithBox7 === 1 && te.box7Total.equals(total);
      let l4c: Val;
      if (single) {
        const l4a = h.amt("sch1a.4a", total, "computed", `One employer reported tips: the Form W-2 box 7 total ${fmt(total)}.`);
        const l4b = h.na("sch1a.4b", "Form 4137 is not filed with this return (no unreported tips).");
        l4c = h.calc("sch1a.4c", [l4a, l4b], (v) => maxD(v[0] ?? ZERO, v[1] ?? ZERO), `Only one employer reported tips: the larger of line 4a or 4b. ${tipsSum.notes.join(" ")}`);
      } else {
        const why =
          te === null || te.employersWithBox7 === 0
            ? "No W-2 box 7 amount matches the owner's tips, so line 4c comes from the owner's figure and the Qualified Tips From More Than One Employer Worksheet in the instructions is the CPA's; lines 4a and 4b are left blank."
            : te.employersWithBox7 > 1
              ? "More than one employer reported tips (W-2 box 7): the form says to enter -0- on lines 4a and 4b and use the Qualified Tips From More Than One Employer Worksheet for line 4c; that worksheet is the CPA's, so lines 4a and 4b are left blank."
              : "The owner's tips differ from the single W-2 box 7 amount: the CPA reconciles them; lines 4a and 4b are left blank.";
        h.blk("sch1a.4a", block("not_yet_computed", why, "Schedule 1-A line 4a"), true);
        h.blk("sch1a.4b", block("not_yet_computed", why, "Schedule 1-A line 4b"), true);
        l4c = h.amt("sch1a.4c", total, "computed", `The owner's stated qualified tips. ${tipsSum.notes.join(" ")}`);
      }
      // line 5: tips received in the course of the owner's own trade or business
      const st = input.scheduleCOwnerTips;
      let l5: Val;
      if (st === null) {
        l5 = h.blk("sch1a.5", block("needs_cpa_judgment", "No Schedule C owner is identified, so the engine cannot rule out qualified tips received in the course of a trade or business (line 5); the CPA decides.", "Schedule 1-A line 5"));
      } else if (st.state === "missing") {
        l5 = h.blk("sch1a.5", block("missing_input", "The Schedule C owner's tips answer is missing, so qualified tips from a trade or business (line 5) cannot be ruled out.", "Schedule C owner tips answer"));
      } else if (st.state === "unsure") {
        l5 = h.blk("sch1a.5", block("needs_cpa_judgment", "The Schedule C owner is not sure about tips: qualified tips from a trade or business (line 5) are the CPA's call.", "Schedule C owner tips answer"));
      } else if (st.value === "none") {
        l5 = h.na("sch1a.5", "The Schedule C owner states no tips at all, so there are no qualified tips from a trade or business (Form 1099-NEC / 1099-K).");
      } else {
        l5 = h.blk("sch1a.5", block("needs_cpa_judgment", "The Schedule C owner reports tips (or will ask): the engine cannot split employee tips from tips received in the course of a trade or business (Forms 1099-NEC / 1099-K), so line 5 goes to the CPA.", "Schedule 1-A line 5"));
      }
      const l6 = h.calc("sch1a.6", [l4c, l5], (v) => (v[0] ?? ZERO).plus(v[1] ?? ZERO), "Line 4c plus line 5.");
      const l7 = h.calc("sch1a.7", [l6], (v) => minD(v[0] ?? ZERO, D(K.SCH1A_TIPS_MAX.value)), "The smaller of line 6 or the maximum (a combined limit for both spouses).");
      tipsDeduction = reductionPart(h, { l8: "sch1a.8", l9: "sch1a.9", l10: "sch1a.10", l11: "sch1a.11", l12: "sch1a.12", l13: "sch1a.13" }, l7, line3, {
        threshold: D(K.SCH1A_TIPS_MAGI_START_MFJ.value),
        per: D(K.SCH1A_TIPS_REDUCTION_PER_1000.value),
        direction: "down",
        baseLine: "7",
        skipped: "lines 11 and 12 are skipped",
      });
    }
  }

  // ── Part III: overtime ──────────────────────────────────────────────────────
  let otDeduction: Val;
  {
    const keys = ["sch1a.14a", "sch1a.14b", "sch1a.14c", "sch1a.15", "sch1a.16", "sch1a.17", "sch1a.18", "sch1a.19", "sch1a.20", "sch1a.21"] as const;
    if (otSum.kind === "blocked") {
      const b = block(otSum.status, otSum.reason, otSum.missing);
      for (const key of keys) h.blk(key, b);
      otDeduction = b;
    } else if (!otUsed) {
      const why = `No qualified overtime (${otSum.notes.join(" ")}): Part III is left blank.`;
      for (const key of keys) h.na(key, why);
      otDeduction = { ok: true, v: ZERO };
    } else {
      const l14a = h.amt("sch1a.14a", otSum.value, "computed", otSum.notes.join(" "));
      const l14b = h.na("sch1a.14b", "Qualified overtime is FLSA wage overtime: none is reported on a Form 1099-NEC or 1099-MISC for this household.");
      const l14c = h.calc("sch1a.14c", [l14a, l14b], (v) => (v[0] ?? ZERO).plus(v[1] ?? ZERO), "Line 14a plus line 14b.");
      const l15 = h.calc("sch1a.15", [l14c], (v) => minD(v[0] ?? ZERO, D(K.SCH1A_OVERTIME_MAX_MFJ.value)), "The smaller of line 14c or the maximum (a combined limit for both spouses, married filing jointly).");
      otDeduction = reductionPart(h, { l8: "sch1a.16", l9: "sch1a.17", l10: "sch1a.18", l11: "sch1a.19", l12: "sch1a.20", l13: "sch1a.21" }, l15, line3, {
        threshold: D(K.SCH1A_OVERTIME_MAGI_START_MFJ.value),
        per: D(K.SCH1A_OVERTIME_REDUCTION_PER_1000.value),
        direction: "down",
        baseLine: "15",
        skipped: "lines 19 and 20 are skipped",
      });
    }
  }

  // ── Part IV: car loan interest ──────────────────────────────────────────────
  let carDeduction: Val;
  {
    const keys = ["sch1a.23", "sch1a.24", "sch1a.25", "sch1a.26", "sch1a.27", "sch1a.28", "sch1a.29", "sch1a.30"] as const;
    if (car.kind === "blocked") {
      for (const key of keys) h.blk(key, car.b);
      carDeduction = car.b;
    } else if (car.kind === "unused") {
      for (const key of keys) h.na(key, car.why);
      carDeduction = { ok: true, v: ZERO };
    } else {
      const l23 = h.amt("sch1a.23", car.line23, "computed", car.note);
      const l24 = h.calc("sch1a.24", [l23], (v) => minD(v[0] ?? ZERO, D(K.SCH1A_CAR_LOAN_MAX.value)), "The smaller of line 23 or the maximum.");
      carDeduction = reductionPart(h, { l8: "sch1a.25", l9: "sch1a.26", l10: "sch1a.27", l11: "sch1a.28", l12: "sch1a.29", l13: "sch1a.30" }, l24, line3, {
        threshold: D(K.SCH1A_CAR_LOAN_MAGI_START_MFJ.value),
        per: D(K.SCH1A_CAR_LOAN_REDUCTION_PER_1000.value),
        direction: "up",
        baseLine: "24",
        skipped: "lines 28 and 29 are skipped",
      });
    }
  }

  // ── Part V: seniors ─────────────────────────────────────────────────────────
  let seniors: Val;
  {
    const sharedKeys = ["sch1a.31", "sch1a.32", "sch1a.33", "sch1a.34", "sch1a.35"] as const;
    const slotKeys = ["sch1a.36a", "sch1a.36b"] as const;
    if (!seniorsUsed && seniorBlocks.length === 0) {
      const why = seniorStates.map((s) => (s.kind === "no" ? s.why : "")).filter((x) => x !== "").join(" ");
      for (const key of sharedKeys) h.na(key, `No senior deduction (${why}): Part V is left blank.`);
      for (let i = 0; i < 2; i++) h.na(slotKeys[i] as LineKey, (seniorStates[i] as { why: string }).why);
      seniors = h.na("sch1a.37", "Line 36a plus line 36b: no senior deduction.");
    } else {
      let l35: Val;
      if (!seniorsUsed) {
        // nobody qualifies for sure, but an unanswered / unsure person might: the shared lines wait too
        const b = mergeBlocked(seniorBlocks);
        for (const key of sharedKeys) h.blk(key, b);
        l35 = b;
      } else {
        const l31 = h.calc("sch1a.31", [line3], (v) => v[0] ?? ZERO, "Copy of line 3 (MAGI).");
        h.amt("sch1a.32", D(K.SCH1A_SENIOR_MAGI_START_MFJ.value), "computed", `The printed threshold for married filing jointly (${fmt(D(K.SCH1A_SENIOR_MAGI_START_MFJ.value))}).`);
        if (!l31.ok) {
          h.blk("sch1a.33", l31);
          h.blk("sch1a.34", l31);
          l35 = h.blk("sch1a.35", l31);
        } else {
          const diff = l31.v.minus(D(K.SCH1A_SENIOR_MAGI_START_MFJ.value));
          if (diff.lessThanOrEqualTo(0)) {
            const why = `MAGI ${fmt(l31.v)} is not over ${fmt(D(K.SCH1A_SENIOR_MAGI_START_MFJ.value))}: lines 34 skipped and ${fmt(D(K.SCH1A_SENIOR_AMOUNT.value))} goes on line 35.`;
            h.na("sch1a.33", why);
            h.na("sch1a.34", why);
            l35 = h.amt("sch1a.35", D(K.SCH1A_SENIOR_AMOUNT.value), "computed", why);
          } else {
            h.amt("sch1a.33", diff, "computed", `MAGI ${fmt(l31.v)} minus ${fmt(D(K.SCH1A_SENIOR_MAGI_START_MFJ.value))}.`);
            const l34 = h.amt("sch1a.34", diff.times(D(K.SCH1A_SENIOR_REDUCTION_RATE.value)), "computed", `${K.SCH1A_SENIOR_REDUCTION_RATE.value * 100}% of ${fmt(diff)}, rounded to whole dollars.`);
            l35 = h.calc("sch1a.35", [l34], (v) => maxD(ZERO, D(K.SCH1A_SENIOR_AMOUNT.value).minus(v[0] ?? ZERO)), `${fmt(D(K.SCH1A_SENIOR_AMOUNT.value))} minus line 34, not below zero.`);
          }
        }
      }
      const slotVals: Val[] = [0, 1].map((i): Val => {
        const key = slotKeys[i] as LineKey;
        const s = seniorStates[i] as SeniorState;
        const p = input.people[i];
        if (s.kind === "blocked") return h.blk(key, s.b);
        if (s.kind === "no") return h.na(key, s.why);
        return h.calc(key, [l35], (v) => v[0] ?? ZERO, `${p?.name ?? "Taxpayer"}: the amount from line 35 (born before ${K.SCH1A_SENIOR_BORN_BEFORE.value}, valid SSN).`);
      });
      seniors = h.calc("sch1a.37", slotVals, (v) => v.reduce((a, b) => a.plus(b), ZERO), "Line 36a plus line 36b.");
    }
  }

  // ── Part VI: total ──────────────────────────────────────────────────────────
  {
    const parts: [string, Val][] = [
      ["Qualified tips (line 13)", tipsDeduction],
      ["Qualified overtime (line 21)", otDeduction],
      ["Car-loan interest (line 30)", carDeduction],
      ["Seniors (line 37)", seniors],
    ];
    const blockedParts = parts.filter((x): x is [string, BlockedVal] => !x[1].ok);
    if (blockedParts.length > 0) {
      const merged = mergeBlocked(blockedParts.map(([, b]) => b));
      const why = `Schedule 1-A is not final: ${blockedParts.map(([n, b]) => `${n}: ${b.reason}`).join(" ")}`;
      h.blk("sch1a.38", block(merged.status, why, merged.missing));
      reasons.push(why);
      for (const [, b] of blockedParts) missing.push(b.missing);
    } else {
      const total = parts.reduce((acc, [, v]) => acc.plus((v as { ok: true; v: Decimal }).v), ZERO);
      h.amt("sch1a.38", total, total.isZero() ? "not_applicable" : "computed", total.isZero() ? "No Schedule 1-A deduction: every part is zero by the owner's answers or the limits." : "Lines 13, 21, 30 and 37.");
      const v = (x: Val): string => fmt((x as { ok: true; v: Decimal }).v);
      reasons.push(`Schedule 1-A total ${fmt(total)}: tips ${v(tipsDeduction)}, overtime ${v(otDeduction)}, car-loan interest ${v(carDeduction)}, seniors ${v(seniors)}.`);
    }
  }
  for (const piece of [tipsSum, otSum]) if (piece.kind === "amount") reasons.push(...piece.notes);

  return {
    ruleId: "schedule-1a",
    form: "Schedule 1-A",
    status: aggregateStatus(lines, "computed"),
    lines,
    reasons,
    citations: CITES,
    inputsUsed: [],
    inputsMissing: missing,
  };
}
