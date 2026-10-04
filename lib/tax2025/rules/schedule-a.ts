// Schedule A (itemized deductions) and the standard-vs-itemized choice, TY2025, MFJ.
//
// Fixes defect D6: SALT now includes CT estimated payments made in 2025 and any
// 2024 CT balance paid in 2025 (cash basis), not just W-2 withholding; the SALT
// cap follows the Schedule A worksheet (cap $40,000, reduced by 30% of MAGI over
// $500,000, never below $10,000); the home acquisition debt limit is checked;
// charitable gifts come from the donation log; per-bill property tax
// classification decides what is Schedule A real estate / personal property.
//
// Rules that are NOT verified (specs/09 "Not verified") are not guessed:
//   - charitable gifts above 20% of AGI -> needs_cpa_rule_unverified (only the
//     30% / 20% limits are mentioned in the verified instructions, so gifts up to
//     the lowest limit, 20%, need no limit analysis);
//   - mortgage insurance premiums (1098 box 5) and points (box 6) -> needs_cpa_rule_unverified;
//   - acquisition debt over the $750,000 limit (Pub 936 worksheet) -> needs_cpa_rule_unverified.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { flagsForDonation } from "@/lib/donation-substantiation";
import { K } from "@/lib/tax2025/constants";
import type { PropertyBillKind } from "@/lib/tax2025/facts";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD, roundLine, sumThenRound } from "@/lib/tax2025/money";
import {
  aggregateStatus,
  type Decided,
  type RuleAlternative,
  type RuleDecision,
  type RuleLine,
  type RuleResult,
  type RuleStatus,
} from "@/lib/tax2025/types";

// ── Pure helpers (exported for the worksheet tests) ──────────────────────────

/**
 * SALT cap worksheet (Schedule A instructions, verified 2026-10-03): line 1 cap;
 * line 6 = MAGI over the threshold; line 7 = 30% of line 6; line 8 = line 1 - line 7;
 * line 9 = the larger of line 8 or the floor.
 */
export function saltCapForMagi(magi: Decimal): Decimal {
  const cap = D(K.SALT_CAP_MFJ.value);
  const line6 = maxD(ZERO, roundLine(magi.minus(K.SALT_PHASE_DOWN_THRESHOLD_MFJ.value)));
  if (line6.isZero()) return cap;
  const line7 = roundLine(line6.times(K.SALT_PHASE_DOWN_RATE.value));
  return maxD(cap.minus(line7), D(K.SALT_FLOOR.value));
}

// ── Inputs ────────────────────────────────────────────────────────────────────

export interface PropertyBillInput {
  docId: string;
  label: string;
  kind: PropertyBillKind;
  /** Owner-entered paid-in-year amount (dollars); null = not entered. */
  paid: Decimal | null;
}

export interface MortgageInput {
  docId: string;
  label: string;
  interest: Decimal | null;
  principal: Decimal | null;
  mortgageInsurance: Decimal | null;
  points: Decimal | null;
  legacyFormat: boolean;
  /**
   * The 1098 is for a property that is not (or cannot be shown to be) the primary residence. Its interest is not
   * silently treated as primary-residence Schedule A interest: line 8a becomes needs_cpa_judgment (fail safe).
   */
  needsReview?: boolean;
}

export interface DonationInput {
  id: string;
  kind: "cash" | "noncash";
  amount: Decimal;
  substantiation: string;
  receiptDocumentId: string | null;
  amountCents: number;
}

export interface ScheduleAInput {
  /** 1040 line 11a (MAGI for the SALT worksheet; no foreign income exclusions modeled). Null = missing. */
  agi: Decimal | null;
  /** CT income tax withheld on W-2s / paystubs; null = not read. */
  ctWithholding: Decimal | null;
  /** CT estimated payments MADE during 2025 (any tax year they apply to); null = unknown. */
  ctEstimatesPaidIn2025: Decimal | null;
  /** 2024 CT balance paid during 2025; null = unknown. */
  ctPriorYearBalancePaidIn2025: Decimal | null;
  propertyBills: PropertyBillInput[];
  /** Owner confirmed there are no property tax bills to report. */
  propertyTaxNoneConfirmed: boolean;
  mortgages: MortgageInput[];
  donations: DonationInput[];
  donationsNoneConfirmed: boolean;
  /** X5 decision (56 Arbor Rd and other non-primary real estate). */
  arborDecision?: Decided<"schedule_a" | "capitalize">;
}

const CITATIONS = [
  "STANDARD_DEDUCTION_MFJ",
  "SALT_CAP_MFJ",
  "SALT_PHASE_DOWN_THRESHOLD_MFJ",
  "SALT_PHASE_DOWN_RATE",
  "SALT_FLOOR",
  "MORTGAGE_DEBT_LIMIT",
  "FORM_8283_NONCASH_THRESHOLD",
  "CHARITY_LOWEST_AGI_LIMIT",
];

type Treatment = "schedule_a" | "capitalize";

interface Evaluation {
  lines: RuleLine[];
  reasons: string[];
  missing: string[];
  /** Schedule A line 17, or null when any part is blocked. */
  itemizedTotal: Decimal | null;
  /** Worst status among blocked parts (null when none blocked). */
  blockedStatus: Exclude<RuleStatus, "computed" | "not_applicable"> | null;
}

function worse(
  a: Exclude<RuleStatus, "computed" | "not_applicable"> | null,
  b: Exclude<RuleStatus, "computed" | "not_applicable">
): Exclude<RuleStatus, "computed" | "not_applicable"> {
  const order: RuleStatus[] = ["missing_input", "needs_cpa_judgment", "needs_cpa_rule_unverified", "not_yet_computed"];
  if (a === null) return b;
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

function evaluate(input: ScheduleAInput, treatment: Treatment): Evaluation {
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  const missing: string[] = [];
  // Held in an object so TypeScript does not narrow it to null across the closure below.
  const st: { blocked: Evaluation["blockedStatus"] } = { blocked: null };
  const block = (status: Exclude<RuleStatus, "computed" | "not_applicable">) => {
    st.blocked = worse(st.blocked, status);
  };

  // ── Line 5a: state and local income taxes paid in 2025 ─────────────────────
  let line5a: Decimal | null = null;
  const stateMissing: string[] = [];
  if (input.ctWithholding === null) stateMissing.push("CT income tax withheld (W-2 box 17)");
  if (input.ctEstimatesPaidIn2025 === null) stateMissing.push("CT estimated payments made in 2025");
  if (input.ctPriorYearBalancePaidIn2025 === null) stateMissing.push("2024 CT balance paid in 2025");
  if (stateMissing.length > 0) {
    const reason = `State income tax paid cannot be totaled: missing ${stateMissing.join(", ")}.`;
    lines.push(blockedLine("scha.5a", "State and local income taxes paid in 2025", "5a", "missing_input", reason));
    missing.push(...stateMissing);
    block("missing_input");
  } else {
    line5a = sumThenRound([input.ctWithholding!, input.ctEstimatesPaidIn2025!, input.ctPriorYearBalancePaidIn2025!]);
    lines.push(amountLine("scha.5a", "State and local income taxes paid in 2025", "5a", line5a));
    reasons.push(
      `State income tax paid in 2025: withholding ${fmt(input.ctWithholding!)} + estimates paid in 2025 ${fmt(input.ctEstimatesPaidIn2025!)} + 2024 balance paid in 2025 ${fmt(input.ctPriorYearBalancePaidIn2025!)} (cash basis; 2025 estimates paid in 2026 are not a 2025 deduction).`
    );
  }

  // ── Lines 5b / 5c: property taxes paid in 2025, by bill classification ─────
  let line5b: Decimal | null = null;
  let line5c: Decimal | null = null;
  const unclassified = input.propertyBills.filter((b) => b.kind === "unclassified");
  const noPaid = input.propertyBills.filter((b) => b.paid === null);
  if (input.propertyBills.length === 0 && !input.propertyTaxNoneConfirmed) {
    const reason =
      "No property tax bills are on file for 2025 and the owner has not confirmed there are none: real estate and vehicle property tax cannot be totaled.";
    lines.push(
      blockedLine("scha.5b", "Real estate taxes paid in 2025", "5b", "missing_input", reason),
      blockedLine("scha.5c", "Personal property taxes paid in 2025", "5c", "missing_input", reason)
    );
    missing.push("property tax bills (or confirmation that there are none)");
    block("missing_input");
  } else if (unclassified.length > 0 || noPaid.length > 0) {
    const parts: string[] = [];
    if (unclassified.length > 0) {
      parts.push(
        `classify ${unclassified.map((b) => b.label).join(", ")} (primary residence / other real estate / vehicle)`
      );
      missing.push("property tax bill classification");
    }
    if (noPaid.length > 0) {
      parts.push(`enter the amount paid in 2025 on ${noPaid.map((b) => b.label).join(", ")}`);
      missing.push("property tax paid in 2025 per bill");
    }
    const reason = `Property tax cannot be totaled until you ${parts.join(" and ")}.`;
    lines.push(
      blockedLine("scha.5b", "Real estate taxes paid in 2025", "5b", "missing_input", reason),
      blockedLine("scha.5c", "Personal property taxes paid in 2025", "5c", "missing_input", reason)
    );
    block("missing_input");
  } else {
    const realEstate: Decimal[] = [];
    const personal: Decimal[] = [];
    let capitalized: Decimal = ZERO;
    for (const b of input.propertyBills) {
      const paid = b.paid ?? ZERO;
      if (b.kind === "primary_residence") realEstate.push(paid);
      else if (b.kind === "other_real_estate") {
        if (treatment === "schedule_a") realEstate.push(paid);
        else capitalized = capitalized.plus(paid);
      } else personal.push(paid); // motor_vehicle, other_personal_property
    }
    line5b = sumThenRound(realEstate);
    line5c = sumThenRound(personal);
    lines.push(
      amountLine("scha.5b", "Real estate taxes paid in 2025", "5b", line5b),
      amountLine("scha.5c", "Personal property taxes paid in 2025", "5c", line5c)
    );
    if (capitalized.greaterThan(0)) {
      reasons.push(
        `Decision X5: ${fmt(capitalized)} of non-primary real estate tax is capitalized instead of deducted on Schedule A.`
      );
    }
  }

  // ── Lines 5d / 5e: SALT total and cap ───────────────────────────────────────
  let line5e: Decimal | null = null;
  if (line5a !== null && line5b !== null && line5c !== null) {
    const line5d = sumThenRound([line5a, line5b, line5c]);
    lines.push(amountLine("scha.5d", "Total state and local taxes", "5d", line5d));
    if (input.agi === null) {
      lines.push(
        blockedLine("scha.5e", "State and local tax deduction (after the cap)", "5e", "missing_input", "AGI is needed for the SALT cap worksheet.")
      );
      missing.push("AGI (1040 line 11a) for the SALT cap");
      block("missing_input");
    } else {
      const cap = saltCapForMagi(input.agi);
      line5e = minD(line5d, cap);
      lines.push(amountLine("scha.5e", "State and local tax deduction (after the cap)", "5e", line5e));
      reasons.push(
        `SALT: taxes paid ${fmt(line5d)}; cap ${fmt(cap)} (${fmt(D(K.SALT_CAP_MFJ.value))} reduced by ${fmt(D(K.SALT_PHASE_DOWN_RATE.value).times(100))}% of MAGI over ${fmt(D(K.SALT_PHASE_DOWN_THRESHOLD_MFJ.value))}, never below ${fmt(D(K.SALT_FLOOR.value))}); deduction ${fmt(line5e)}${line5d.greaterThan(cap) ? ` (${fmt(line5d.minus(cap))} lost to the cap)` : ""}.`
      );
    }
  } else {
    lines.push(blockedLine("scha.5d", "Total state and local taxes", "5d", "missing_input", "A SALT component is missing (see lines 5a-5c)."));
    lines.push(blockedLine("scha.5e", "State and local tax deduction (after the cap)", "5e", "missing_input", "A SALT component is missing (see lines 5a-5c)."));
  }

  // ── Line 8a: home mortgage interest and points reported on Form 1098 ────────
  let line8: Decimal | null = null;
  const LINE8_LABEL = "Home mortgage interest and points reported on Form 1098";
  if (input.mortgages.length === 0) {
    const reason = "No Form 1098 is on file for 2025: mortgage interest cannot be totaled.";
    lines.push(blockedLine("scha.8a", LINE8_LABEL, "8a", "missing_input", reason));
    missing.push("Form 1098 (mortgage interest)");
    block("missing_input");
  } else {
    const review = input.mortgages.filter((m) => m.needsReview === true);
    const interestMissing = input.mortgages.some((m) => m.interest === null);
    const principalMissing = input.mortgages.some((m) => m.principal === null);
    if (review.length > 0) {
      const reason = `${review.length} Form 1098(s) (${review.map((m) => m.label).join(", ")}) are for a property that is not the primary residence, or the primary residence cannot be told apart: whether that interest is Schedule A interest (second home) or belongs elsewhere (rental, Schedule E) is a CPA call, so line 8a is not computed.`;
      lines.push(blockedLine("scha.8a", LINE8_LABEL, "8a", "needs_cpa_judgment", reason));
      missing.push("which Form 1098 properties are the primary residence / a qualified second home");
      block("needs_cpa_judgment");
    } else if (interestMissing || principalMissing) {
      const what = interestMissing ? "interest (box 1)" : "outstanding principal (box 2)";
      const reason = `A Form 1098 has no ${what} read, so the interest deduction and the $${K.MORTGAGE_DEBT_LIMIT.value.toLocaleString("en-US")} debt-limit check cannot be completed.`;
      lines.push(blockedLine("scha.8a", LINE8_LABEL, "8a", "missing_input", reason));
      missing.push(`Form 1098 ${what}`);
      block("missing_input");
    } else {
      const totalPrincipal = input.mortgages.reduce((a, m) => a.plus(m.principal!), ZERO);
      const limit = D(K.MORTGAGE_DEBT_LIMIT.value);
      // Points (box 6) are part of line 8a on the 2025 form; mortgage insurance premiums (box 5) have no
      // 2025 Schedule A line ("8d: Reserved for future use"). Whether either is deductible is not verified.
      const points = input.mortgages.reduce((a, m) => a.plus(m.points ?? ZERO), ZERO);
      const mip = input.mortgages.reduce((a, m) => a.plus(m.mortgageInsurance ?? ZERO), ZERO);
      if (totalPrincipal.greaterThan(limit)) {
        const reason = `Outstanding mortgage principal ${fmt(totalPrincipal)} is over the ${fmt(limit)} acquisition debt limit: the Pub 936 limitation worksheet is not verified here, so the deductible interest is not estimated.`;
        lines.push(blockedLine("scha.8a", LINE8_LABEL, "8a", "needs_cpa_rule_unverified", reason));
        block("needs_cpa_rule_unverified");
      } else if (points.greaterThan(0) || mip.greaterThan(0)) {
        const parts: string[] = [];
        if (points.greaterThan(0)) parts.push(`points of ${fmt(points)} (box 6, part of line 8a)`);
        if (mip.greaterThan(0)) parts.push(`mortgage insurance premiums of ${fmt(mip)} (box 5; the 2025 Schedule A has no line for them)`);
        const reason = `Form 1098 reports ${parts.join(" and ")}: whether they are deductible for 2025 is not verified here, so line 8a is not computed.`;
        lines.push(blockedLine("scha.8a", LINE8_LABEL, "8a", "needs_cpa_rule_unverified", reason));
        block("needs_cpa_rule_unverified");
      } else {
        line8 = sumThenRound(input.mortgages.map((m) => m.interest!));
        lines.push(amountLine("scha.8a", LINE8_LABEL, "8a", line8));
        reasons.push(
          `Mortgage interest ${fmt(line8)} from ${input.mortgages.length} Form 1098(s); outstanding principal ${fmt(totalPrincipal)} is within the ${fmt(limit)} limit (assumes all of the debt is home acquisition debt).`
        );
      }
      if (input.mortgages.some((m) => m.legacyFormat)) {
        reasons.push(
          "A Form 1098 was read in the older extraction format: points and mortgage insurance boxes were never read; re-extract to be sure none are reported."
        );
      }
    }
  }

  // ── Lines 11 / 12 / 14: charitable gifts ────────────────────────────────────
  let line14: Decimal | null = null;
  if (input.donations.length === 0 && !input.donationsNoneConfirmed) {
    const reason = "The donation log is empty and the owner has not confirmed there were no gifts: charitable gifts cannot be totaled.";
    lines.push(
      blockedLine("scha.11", "Gifts by cash or check", "11", "missing_input", reason),
      blockedLine("scha.12", "Gifts other than cash", "12", "missing_input", reason),
      blockedLine("scha.14", "Total gifts to charity", "14", "missing_input", reason)
    );
    missing.push("donation log (or confirmation of no gifts)");
    block("missing_input");
  } else {
    const cash = sumThenRound(input.donations.filter((d) => d.kind === "cash").map((d) => d.amount));
    const noncash = sumThenRound(input.donations.filter((d) => d.kind === "noncash").map((d) => d.amount));
    const total = sumThenRound(input.donations.map((d) => d.amount));
    lines.push(
      amountLine("scha.11", "Gifts by cash or check", "11", cash),
      amountLine("scha.12", "Gifts other than cash", "12", noncash)
    );
    if (input.agi === null) {
      lines.push(blockedLine("scha.14", "Total gifts to charity", "14", "missing_input", "AGI is needed to check the charitable AGI limit."));
      missing.push("AGI (1040 line 11a) for the charitable limit");
      block("missing_input");
    } else {
      const lowestLimit = maxD(ZERO, input.agi).times(K.CHARITY_LOWEST_AGI_LIMIT.value);
      if (total.greaterThan(lowestLimit)) {
        const reason = `Gifts of ${fmt(total)} are over ${fmt(lowestLimit)} (20% of AGI, the lowest AGI limit that can apply). The 60% cash limit is not verified here, so the deductible amount is not estimated; the CPA applies the AGI limits.`;
        lines.push(blockedLine("scha.14", "Total gifts to charity", "14", "needs_cpa_rule_unverified", reason));
        block("needs_cpa_rule_unverified");
      } else {
        line14 = total;
        lines.push(amountLine("scha.14", "Total gifts to charity", "14", total));
        if (input.donations.length > 0) {
          reasons.push(`Charitable gifts ${fmt(total)} (cash ${fmt(cash)}, noncash ${fmt(noncash)}) are within 20% of AGI (${fmt(lowestLimit)}), so no AGI limit applies.`);
        } else {
          reasons.push("Owner confirmed no charitable gifts in 2025.");
        }
      }
    }
    if (noncash.greaterThan(K.FORM_8283_NONCASH_THRESHOLD.value)) {
      reasons.push(`Noncash gifts total ${fmt(noncash)}, over ${fmt(D(K.FORM_8283_NONCASH_THRESHOLD.value))}: Form 8283 is required (CPA prepares it).`);
    }
    const flagged = input.donations.filter(
      (d) => flagsForDonation({ amountCents: d.amountCents, kind: d.kind, substantiation: d.substantiation, receiptDocumentId: d.receiptDocumentId }).some((f) => f.level === "action")
    );
    if (flagged.length > 0) {
      reasons.push(`${flagged.length} gift(s) in the log lack the substantiation the donation log flags as required; they are included but must be documented before filing.`);
    }
  }

  // ── Line 17: total itemized ─────────────────────────────────────────────────
  let itemizedTotal: Decimal | null = null;
  if (st.blocked === null && line5e !== null && line8 !== null && line14 !== null) {
    itemizedTotal = sumThenRound([line5e, line8, line14]);
    lines.push(amountLine("scha.17", "Total itemized deductions", "17", itemizedTotal));
  } else {
    const status: Exclude<RuleStatus, "computed" | "not_applicable"> = st.blocked ?? "missing_input";
    lines.push(
      blockedLine("scha.17", "Total itemized deductions", "17", status, "A Schedule A component is not computed (see the lines above).")
    );
  }

  return { lines, reasons, missing, itemizedTotal, blockedStatus: st.blocked };
}

export function computeScheduleA(input: ScheduleAInput): RuleResult {
  const hasOtherRealEstate = input.propertyBills.some((b) => b.kind === "other_real_estate");
  const treatmentInForce: Treatment = input.arborDecision?.chosen ?? "schedule_a";
  const main = evaluate(input, treatmentInForce);
  const standard = D(K.STANDARD_DEDUCTION_MFJ.value);

  const lines = [...main.lines];
  const reasons = [...main.reasons];
  if (main.itemizedTotal !== null) {
    const itemizes = main.itemizedTotal.greaterThan(standard);
    const used = itemizes ? main.itemizedTotal : standard;
    lines.push(
      amountLine(
        "f1040.12e",
        itemizes ? "Itemized deductions" : "Standard deduction",
        "12",
        used
      )
    );
    reasons.push(
      `Itemized ${fmt(main.itemizedTotal)} versus standard ${fmt(standard)}: ${itemizes ? "itemizing wins" : "the standard deduction wins (a tie takes the standard deduction)"}.`
    );
  } else {
    const status: Exclude<RuleStatus, "computed" | "not_applicable"> = main.blockedStatus ?? "missing_input";
    lines.push(
      blockedLine(
        "f1040.12e",
        "Standard or itemized deduction",
        "12",
        status,
        "The standard-versus-itemized comparison needs every itemized component computed; see Schedule A."
      )
    );
  }

  const result: RuleResult = {
    ruleId: "schedule-a",
    form: "Schedule A",
    status: aggregateStatus(lines),
    lines,
    reasons,
    citations: CITATIONS,
    inputsUsed: [],
    inputsMissing: main.missing,
  };

  if (hasOtherRealEstate) {
    const decision: RuleDecision = {
      id: "X5",
      label: "Tax on non-primary real estate (56 Arbor Rd, held for later rental): Schedule A or capitalize",
      chosen: treatmentInForce,
      status: input.arborDecision ? "decided" : "default_undecided",
      ...(input.arborDecision ? { decidedBy: input.arborDecision.by, decidedAt: input.arborDecision.at } : {}),
    };
    const alt = (id: Treatment, label: string): RuleAlternative => {
      const ev = evaluate(input, id);
      return {
        id,
        label,
        status: ev.itemizedTotal === null ? (ev.blockedStatus ?? "missing_input") : "computed",
        isDefault: id === "schedule_a",
        inForce: id === treatmentInForce,
        lines: ev.lines.filter((l) => l.key === "scha.5b" || l.key === "scha.5e" || l.key === "scha.17"),
        effect:
          ev.itemizedTotal === null
            ? null
            : { amount: ev.itemizedTotal, note: `Itemized total ${fmt(ev.itemizedTotal)} under this treatment (standard deduction ${fmt(standard)}).` },
        reasons: [],
      };
    };
    result.decision = decision;
    result.alternatives = [
      alt("schedule_a", "Deduct on Schedule A (subject to the SALT cap)"),
      alt("capitalize", "Capitalize (not deducted)"),
    ];
  }
  return result;
}
