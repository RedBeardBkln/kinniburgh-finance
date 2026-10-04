// Schedule 1-A (new for 2025): additional deductions, Form 1040 line 13b.
//   Part I   MAGI                              (line 3 = Form 1040 line 11b + lines 2a-2e)
//   Part II  qualified tips                     (lines 4-13)
//   Part III qualified overtime compensation    (lines 14-21)
//   Part IV  qualified passenger vehicle loan interest (lines 22-30)
//   Part V   enhanced deduction for seniors     (lines 31-37)
//   Part VI  total                              (line 38 -> Form 1040 line 13b)
//
// Every formula and amount is read from the 2025 form itself (f1040s1a.pdf) and
// the Schedule 1-A instructions inside the 1040 instructions, both on irs.gov and
// registered in lib/tax2025/constants.ts (verified 2026-10-03):
//   - tips: smaller of line 6 and the maximum (a COMBINED limit, not per spouse);
//     the amount is reduced by $100 per $1,000 (rounded DOWN) of MAGI over the start;
//   - overtime: the maximum is the MFJ limit (combined, not per spouse), same
//     reduction and rounding;
//   - car-loan interest: smaller of line 23 and the maximum; reduced by $200 per
//     $1,000 (rounded UP) of MAGI over the start; interest also deducted on
//     Schedule C is excluded (column ii);
//   - seniors: the per-person amount minus 6% of the MAGI over the start, floored
//     at zero, for each person born before January 2, 1961 with a valid SSN.
// MFJ is required for all four (the engine is MFJ-only).
//
// Nothing is guessed: an unanswered or "not sure" input gives missing_input /
// needs_cpa_judgment; "none" gives a not_applicable zero that states why. The
// qualified-tip and qualified-overtime AMOUNTS are owner-stated (the 2025 W-2 does
// not separately report them; the instructions say so), so the reasons name the
// method used. Tips from the owner's own business (Forms 1099-NEC / 1099-K, line 5)
// and Form 4137 are not collected: the owner answers "Not sure" and the CPA decides.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD, roundLine } from "@/lib/tax2025/money";
import { aggregateStatus, worstBlocked, type RuleLine, type RuleResult, type RuleStatus } from "@/lib/tax2025/types";

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
}

type Blocked = Exclude<RuleStatus, "computed" | "not_applicable">;

/** An amount, or why there is none. */
type Piece = { kind: "amount"; value: Decimal; notes: string[] } | { kind: "blocked"; status: Blocked; reason: string; missing: string };

const CITES = [
  "SCH1A_TIPS_MAX",
  "SCH1A_TIPS_MAGI_START_MFJ",
  "SCH1A_TIPS_REDUCTION_PER_1000",
  "SCH1A_OVERTIME_MAX_MFJ",
  "SCH1A_CAR_LOAN_MAX",
  "SCH1A_CAR_LOAN_MAGI_START_MFJ",
  "SCH1A_CAR_LOAN_REDUCTION_PER_1000",
  "SCH1A_SENIOR_AMOUNT",
  "SCH1A_SENIOR_MAGI_START_MFJ",
  "SCH1A_SENIOR_REDUCTION_RATE",
  "SCH1A_REDUCTION_STEP",
  "SCH1A_SENIOR_BORN_BEFORE",
];

function block(status: Blocked, reason: string, missing: string): Piece {
  return { kind: "blocked", status, reason, missing };
}

/** The answer of one owner question as an amount, or the reason it cannot be one. */
function ansBlock<T>(a: Ans<T>, who: string, what: string, askWhom: string): Piece | null {
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
  if (first !== null) return first;
  if (choice.state !== "answered") return block("missing_input", `${p.name}: ${noun} not answered.`, noun);
  if (choice.value === "none") return { kind: "amount", value: ZERO, notes: [`${p.name}: the owner states no ${noun}.`] };
  if (choice.value === "ask_employer") {
    return block(
      "missing_input",
      kind === "tips"
        ? `${p.name}: the owner will ask the employer for the qualified tips figure (W-2 box 7, or the tips reported to the employer on Form 4070).`
        : `${p.name}: the owner will ask the employer for the FLSA overtime premium (W-2 box 14 may show it; otherwise the instructions give methods based on a statement of overtime pay).`,
      `${noun} figure from the employer (${p.name})`
    );
  }
  const amt = ansBlock(raw, p.name, `the ${noun} amount`, "the CPA decides");
  if (amt !== null) return amt;
  if (raw.state !== "answered") return block("missing_input", `${p.name}: the ${noun} amount is missing.`, `${noun} amount (${p.name})`);
  const stated = kind === "overtime" && choice.value === "total" ? raw.value.div(3) : raw.value;
  const how =
    kind === "overtime" && choice.value === "total"
      ? `total pay for the overtime hours ${fmt(raw.value)} divided by three (the instructions' method for a statement showing premium plus regular wages) = ${fmt(stated)}`
      : kind === "overtime"
        ? `the FLSA overtime premium ${fmt(stated)} as stated by the owner`
        : `qualified tips ${fmt(stated)} as stated by the owner (W-2 box 7 or tips reported to the employer)`;
  // A valid SSN is required for the person who received the amount.
  if (stated.greaterThan(0)) {
    if (p.validSsn.state === "unsure") return block("needs_cpa_judgment", `${p.name}: the owner is not sure the Social Security number is valid for employment; the CPA decides.`, `valid SSN (${p.name})`);
    if (p.validSsn.state === "missing") return block("missing_input", `${p.name}: whether the Social Security number is valid for employment has not been answered.`, `valid SSN (${p.name})`);
    if (p.validSsn.value === false) {
      return { kind: "amount", value: ZERO, notes: [`${p.name}: no Social Security number valid for employment, so the ${noun} do not qualify (${how}).`] };
    }
  }
  return { kind: "amount", value: stated, notes: [`${p.name}: ${how}.`] };
}

function sumPieces(pieces: Piece[]): Piece {
  const blocked = pieces.filter((p): p is Extract<Piece, { kind: "blocked" }> => p.kind === "blocked");
  if (blocked.length > 0) {
    const status = worstBlocked(blocked.map((b) => b.status)) as Blocked;
    return { kind: "blocked", status, reason: blocked.map((b) => b.reason).join(" "), missing: blocked.map((b) => b.missing).join("; ") };
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

export function computeSchedule1a(input: Sch1aInput): RuleResult {
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  const missing: string[] = [];
  const startTips = D(K.SCH1A_TIPS_MAGI_START_MFJ.value);
  const step = D(K.SCH1A_REDUCTION_STEP.value);

  // ── MAGI (Part I) ───────────────────────────────────────────────────────────
  const excl = input.magiExclusionsNone;
  const magiBlock: Piece | null =
    input.magi === null
      ? block("missing_input", "Form 1040 line 11b (adjusted gross income) is not computed yet.", "Form 1040 line 11b")
      : excl.state === "missing"
        ? block("missing_input", "Whether either spouse excluded Puerto Rico income or filed Form 2555 / 4563 has not been answered (Schedule 1-A lines 2a-2e).", "Puerto Rico / Form 2555 / Form 4563 exclusions")
        : excl.state === "unsure"
          ? block("needs_cpa_judgment", "The owner is not sure whether income was excluded (Puerto Rico, Form 2555, Form 4563); the CPA completes Schedule 1-A lines 2a-2e.", "Puerto Rico / Form 2555 / Form 4563 exclusions")
          : excl.value === false
            ? block("needs_cpa_judgment", "The owner reports excluded income (Puerto Rico, Form 2555 or Form 4563): Schedule 1-A lines 2a-2e are not computed by this engine.", "Schedule 1-A lines 2a-2e")
            : null;
  const magi = magiBlock === null ? (input.magi as Decimal) : null;
  if (magi !== null) {
    lines.push(amountLine("sch1a.3", "Modified adjusted gross income", "3", magi, "computed", "Form 1040 line 11b plus lines 2a-2e (none: the owner states no excluded income)."));
  }

  // MAGI is only needed when a part has a positive base; blocked lines carry the MAGI reason then.
  const needMagi = (part: string): Piece | null => (magiBlock === null ? null : magiBlock.kind === "blocked" ? { ...magiBlock, reason: `${part}: ${magiBlock.reason}` } : null);

  // ── Part II: tips ───────────────────────────────────────────────────────────
  const tipsPieces = input.people.map((p) => employeeAmount("tips", p));
  const tipsSum = sumPieces(tipsPieces);
  let tipsDeduction: Piece;
  if (tipsSum.kind === "blocked") {
    tipsDeduction = tipsSum;
    lines.push(blockedLine("sch1a.4c", "Qualified tips received as an employee", "4c", tipsSum.status, tipsSum.reason));
    lines.push(blockedLine("sch1a.7", "Qualified tips, smaller of line 6 or the maximum", "7", tipsSum.status, tipsSum.reason));
    lines.push(blockedLine("sch1a.13", "Qualified tips deduction", "13", tipsSum.status, tipsSum.reason));
  } else {
    lines.push(amountLine("sch1a.4c", "Qualified tips received as an employee", "4c", tipsSum.value, tipsSum.value.isZero() ? "not_applicable" : "computed", tipsSum.notes.join(" ")));
    const line7 = minD(tipsSum.value, D(K.SCH1A_TIPS_MAX.value));
    lines.push(amountLine("sch1a.7", "Qualified tips, smaller of line 6 or the maximum", "7", line7, line7.isZero() ? "not_applicable" : "computed", "The maximum is a combined limit for both spouses."));
    if (line7.isZero()) {
      tipsDeduction = { kind: "amount", value: ZERO, notes: [] };
      lines.push(amountLine("sch1a.13", "Qualified tips deduction", "13", ZERO, "not_applicable", "No qualified tips."));
    } else {
      const mb = needMagi("Qualified tips deduction");
      if (mb !== null) {
        tipsDeduction = mb;
        const blockedMb = mb as Extract<Piece, { kind: "blocked" }>;
        lines.push(blockedLine("sch1a.13", "Qualified tips deduction", "13", blockedMb.status, blockedMb.reason));
      } else {
        const excess = (magi as Decimal).minus(startTips);
        const reduction = excess.greaterThan(0) ? excess.div(step).floor().times(D(K.SCH1A_TIPS_REDUCTION_PER_1000.value)) : ZERO;
        const ded = maxD(ZERO, line7.minus(reduction));
        tipsDeduction = { kind: "amount", value: ded, notes: [] };
        lines.push(
          amountLine(
            "sch1a.13",
            "Qualified tips deduction",
            "13",
            ded,
            "computed",
            excess.greaterThan(0)
              ? `${fmt(line7)} minus ${fmt(reduction)} (MAGI ${fmt(magi as Decimal)} is ${fmt(excess)} over ${fmt(startTips)}; $${K.SCH1A_TIPS_REDUCTION_PER_1000.value} per $${step.toNumber().toLocaleString("en-US")}, rounded down).`
              : `MAGI ${fmt(magi as Decimal)} does not exceed ${fmt(startTips)}: no reduction.`
          )
        );
      }
    }
  }

  // ── Part III: overtime ──────────────────────────────────────────────────────
  const otPieces = input.people.map((p) => employeeAmount("overtime", p));
  const otSum = sumPieces(otPieces);
  let otDeduction: Piece;
  if (otSum.kind === "blocked") {
    otDeduction = otSum;
    lines.push(blockedLine("sch1a.14a", "Qualified overtime compensation included in Form W-2, box 1", "14a", otSum.status, otSum.reason));
    lines.push(blockedLine("sch1a.15", "Qualified overtime, smaller of line 14c or the maximum", "15", otSum.status, otSum.reason));
    lines.push(blockedLine("sch1a.21", "Qualified overtime compensation deduction", "21", otSum.status, otSum.reason));
  } else {
    lines.push(amountLine("sch1a.14a", "Qualified overtime compensation included in Form W-2, box 1", "14a", otSum.value, otSum.value.isZero() ? "not_applicable" : "computed", otSum.notes.join(" ")));
    const line15 = minD(otSum.value, D(K.SCH1A_OVERTIME_MAX_MFJ.value));
    lines.push(amountLine("sch1a.15", "Qualified overtime, smaller of line 14c or the maximum", "15", line15, line15.isZero() ? "not_applicable" : "computed", "The maximum is a combined limit for both spouses."));
    if (line15.isZero()) {
      otDeduction = { kind: "amount", value: ZERO, notes: [] };
      lines.push(amountLine("sch1a.21", "Qualified overtime compensation deduction", "21", ZERO, "not_applicable", "No qualified overtime."));
    } else {
      const mb = needMagi("Qualified overtime deduction");
      if (mb !== null) {
        otDeduction = mb;
        const blockedMb = mb as Extract<Piece, { kind: "blocked" }>;
        lines.push(blockedLine("sch1a.21", "Qualified overtime compensation deduction", "21", blockedMb.status, blockedMb.reason));
      } else {
        const excess = (magi as Decimal).minus(startTips);
        const reduction = excess.greaterThan(0) ? excess.div(step).floor().times(D(K.SCH1A_TIPS_REDUCTION_PER_1000.value)) : ZERO;
        const ded = maxD(ZERO, line15.minus(reduction));
        otDeduction = { kind: "amount", value: ded, notes: [] };
        lines.push(
          amountLine(
            "sch1a.21",
            "Qualified overtime compensation deduction",
            "21",
            ded,
            "computed",
            excess.greaterThan(0)
              ? `${fmt(line15)} minus ${fmt(reduction)} (MAGI ${fmt(magi as Decimal)} is ${fmt(excess)} over ${fmt(startTips)}, rounded down per $${step.toNumber().toLocaleString("en-US")}).`
              : `MAGI ${fmt(magi as Decimal)} does not exceed ${fmt(startTips)}: no reduction.`
          )
        );
      }
    }
  }

  // ── Part IV: car loan interest ──────────────────────────────────────────────
  let carDeduction: Piece;
  {
    const c = input.carLoan;
    const label23 = "Qualified passenger vehicle loan interest (column iii total)";
    const label24 = "Car-loan interest, smaller of line 23 or the maximum";
    const label30 = "Qualified passenger vehicle loan interest deduction";
    const stop = (p: Piece): void => {
      carDeduction = p;
      const b = p as Extract<Piece, { kind: "blocked" }>;
      lines.push(blockedLine("sch1a.23", label23, "23", b.status, b.reason), blockedLine("sch1a.24", label24, "24", b.status, b.reason), blockedLine("sch1a.30", label30, "30", b.status, b.reason));
    };
    const first = ansBlock(c.choice, "Household", "whether a vehicle was bought with a new loan in 2025", "the CPA decides");
    carDeduction = { kind: "amount", value: ZERO, notes: [] };
    if (first !== null) stop(first);
    else if (c.choice.state === "answered" && c.choice.value === "none") {
      for (const [k, l, n] of [["sch1a.23", label23, "23"], ["sch1a.24", label24, "24"], ["sch1a.30", label30, "30"]] as const) {
        lines.push(amountLine(k, l, n, ZERO, "not_applicable", "The owner states no vehicle was bought with a loan that started after December 31, 2024."));
      }
    } else {
      const q = ansBlock(c.qualifies, "Household", "whether the vehicle and loan meet every listed condition", "the CPA decides");
      const paid = ansBlock(c.interestPaid, "Household", "the car-loan interest paid in 2025", "the CPA decides");
      const else_ = ansBlock(c.deductedElsewhere, "Household", "the part of that interest deducted on Schedule C", "the CPA decides");
      const firstBlocked = q ?? paid ?? else_;
      if (firstBlocked !== null) stop(firstBlocked);
      else if (c.qualifies.state === "answered" && c.qualifies.value === false) {
        for (const [k, l, n] of [["sch1a.23", label23, "23"], ["sch1a.24", label24, "24"], ["sch1a.30", label30, "30"]] as const) {
          lines.push(amountLine(k, l, n, ZERO, "not_applicable", "The owner reports the vehicle or loan does not meet the conditions (original use, personal use, first lien, final assembly in the United States, loan originated after December 31, 2024): no deduction."));
        }
      } else if (c.interestPaid.state === "answered" && c.deductedElsewhere.state === "answered") {
        const line23 = maxD(ZERO, c.interestPaid.value.minus(c.deductedElsewhere.value));
        const line24 = minD(line23, D(K.SCH1A_CAR_LOAN_MAX.value));
        lines.push(amountLine("sch1a.23", label23, "23", line23, "computed", `Interest paid ${fmt(c.interestPaid.value)} minus ${fmt(c.deductedElsewhere.value)} deducted on Schedule C. The vehicle identification number(s) must be on the return (not stored by this app).`));
        lines.push(amountLine("sch1a.24", label24, "24", line24, "computed"));
        const mb = line24.isZero() ? null : needMagi("Car-loan interest deduction");
        if (mb !== null) {
          carDeduction = mb;
          const b = mb as Extract<Piece, { kind: "blocked" }>;
          lines.push(blockedLine("sch1a.30", label30, "30", b.status, b.reason));
        } else {
          const excess = line24.isZero() ? ZERO : (magi as Decimal).minus(D(K.SCH1A_CAR_LOAN_MAGI_START_MFJ.value));
          const reduction = excess.greaterThan(0) ? excess.div(step).ceil().times(D(K.SCH1A_CAR_LOAN_REDUCTION_PER_1000.value)) : ZERO;
          const ded = maxD(ZERO, line24.minus(reduction));
          carDeduction = { kind: "amount", value: ded, notes: [] };
          lines.push(
            amountLine(
              "sch1a.30",
              label30,
              "30",
              ded,
              "computed",
              excess.greaterThan(0)
                ? `${fmt(line24)} minus ${fmt(reduction)} (MAGI is ${fmt(excess)} over ${fmt(D(K.SCH1A_CAR_LOAN_MAGI_START_MFJ.value))}; $${K.SCH1A_CAR_LOAN_REDUCTION_PER_1000.value} per $${step.toNumber().toLocaleString("en-US")}, rounded UP).`
                : "No MAGI reduction."
            )
          );
        }
      }
    }
  }

  // ── Part V: seniors ─────────────────────────────────────────────────────────
  const seniorPieces: Piece[] = [];
  const seniorLines: RuleLine[] = [];
  const slotKeys = ["sch1a.36a", "sch1a.36b"] as const;
  const slotLabels = ["Enhanced deduction for seniors, taxpayer A", "Enhanced deduction for seniors, taxpayer B"] as const;
  const per = D(K.SCH1A_SENIOR_AMOUNT.value);
  for (let i = 0; i < 2; i++) {
    const p = input.people[i];
    const key = slotKeys[i] as (typeof slotKeys)[number];
    const label = slotLabels[i] as string;
    const formLine = i === 0 ? "36a" : "36b";
    if (p === undefined) {
      seniorLines.push(amountLine(key, label, formLine, ZERO, "not_applicable", "No second taxpayer."));
      seniorPieces.push({ kind: "amount", value: ZERO, notes: [] });
      continue;
    }
    const b = ansBlock(p.bornBefore1961, p.name, `whether born before ${K.SCH1A_SENIOR_BORN_BEFORE.value}`, "the CPA decides");
    if (b !== null) {
      const bb = b as Extract<Piece, { kind: "blocked" }>;
      seniorLines.push(blockedLine(key, label, formLine, bb.status, bb.reason));
      seniorPieces.push(b);
      continue;
    }
    if (p.bornBefore1961.state === "answered" && p.bornBefore1961.value === false) {
      seniorLines.push(amountLine(key, label, formLine, ZERO, "not_applicable", `${p.name} was not born before ${K.SCH1A_SENIOR_BORN_BEFORE.value}.`));
      seniorPieces.push({ kind: "amount", value: ZERO, notes: [] });
      continue;
    }
    // born before 1961: needs a valid SSN and the MAGI
    const ssn = ansBlock(p.validSsn, p.name, "whether the Social Security number is valid for employment", "the CPA decides");
    if (ssn !== null) {
      const sb = ssn as Extract<Piece, { kind: "blocked" }>;
      seniorLines.push(blockedLine(key, label, formLine, sb.status, sb.reason));
      seniorPieces.push(ssn);
      continue;
    }
    if (p.validSsn.state === "answered" && p.validSsn.value === false) {
      seniorLines.push(amountLine(key, label, formLine, ZERO, "not_applicable", `${p.name} has no Social Security number valid for employment: no senior deduction.`));
      seniorPieces.push({ kind: "amount", value: ZERO, notes: [] });
      continue;
    }
    const mb = needMagi(`Senior deduction (${p.name})`);
    if (mb !== null) {
      const mbb = mb as Extract<Piece, { kind: "blocked" }>;
      seniorLines.push(blockedLine(key, label, formLine, mbb.status, mbb.reason));
      seniorPieces.push(mb);
      continue;
    }
    const excess = (magi as Decimal).minus(D(K.SCH1A_SENIOR_MAGI_START_MFJ.value));
    const reduction = excess.greaterThan(0) ? excess.times(D(K.SCH1A_SENIOR_REDUCTION_RATE.value)) : ZERO;
    const amt = maxD(ZERO, per.minus(reduction));
    seniorLines.push(
      amountLine(
        key,
        label,
        formLine,
        amt,
        "computed",
        excess.greaterThan(0)
          ? `${p.name}: ${fmt(per)} minus ${fmt(reduction.toDecimalPlaces(2))} (${K.SCH1A_SENIOR_REDUCTION_RATE.value * 100}% of the ${fmt(excess)} MAGI over ${fmt(D(K.SCH1A_SENIOR_MAGI_START_MFJ.value))}).`
          : `${p.name}: ${fmt(per)}, no MAGI reduction.`
      )
    );
    seniorPieces.push({ kind: "amount", value: amt, notes: [] });
  }
  lines.push(...seniorLines);
  const seniors = sumPieces(seniorPieces);
  if (seniors.kind === "blocked") {
    lines.push(blockedLine("sch1a.37", "Enhanced deduction for seniors", "37", seniors.status, seniors.reason));
  } else {
    lines.push(amountLine("sch1a.37", "Enhanced deduction for seniors", "37", seniors.value, seniors.value.isZero() ? "not_applicable" : "computed", "Line 36a plus line 36b."));
  }

  // ── Part VI: total ──────────────────────────────────────────────────────────
  const parts: [string, Piece][] = [
    ["Qualified tips (line 13)", tipsDeduction],
    ["Qualified overtime (line 21)", otDeduction],
    ["Car-loan interest (line 30)", carDeduction],
    ["Seniors (line 37)", seniors],
  ];
  const blockedParts = parts.filter(([, p]) => p.kind === "blocked");
  if (blockedParts.length > 0) {
    const status = worstBlocked(blockedParts.map(([, p]) => (p as Extract<Piece, { kind: "blocked" }>).status)) as Blocked;
    const why = `Schedule 1-A is not final: ${blockedParts.map(([n, p]) => `${n}: ${(p as Extract<Piece, { kind: "blocked" }>).reason}`).join(" ")}`;
    lines.push(blockedLine("sch1a.38", "Total additional deductions (to Form 1040 line 13b)", "38", status, why));
    reasons.push(why);
    for (const [, p] of blockedParts) missing.push((p as Extract<Piece, { kind: "blocked" }>).missing);
  } else {
    const total = parts.reduce((acc, [, p]) => acc.plus((p as Extract<Piece, { kind: "amount" }>).value), ZERO);
    lines.push(
      amountLine(
        "sch1a.38",
        "Total additional deductions (to Form 1040 line 13b)",
        "38",
        total,
        total.isZero() ? "not_applicable" : "computed",
        total.isZero() ? "No Schedule 1-A deduction: every part is zero by the owner's answers or the limits." : "Lines 13, 21, 30 and 37."
      )
    );
    reasons.push(`Schedule 1-A total ${fmt(roundLine(total))}: tips ${fmt((tipsDeduction as Extract<Piece, { kind: "amount" }>).value)}, overtime ${fmt((otDeduction as Extract<Piece, { kind: "amount" }>).value)}, car-loan interest ${fmt((carDeduction as Extract<Piece, { kind: "amount" }>).value)}, seniors ${fmt((seniors as Extract<Piece, { kind: "amount" }>).value)}.`);
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
