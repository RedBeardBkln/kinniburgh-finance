// CT-1040 Schedule 1, "Modifications to Federal Adjusted Gross Income", TY2025: every detail line
// (additions 31-37, subtractions 39-49 incl. 36a and 48a-48d). The line 38 / line 50 totals are
// summed by return.ts and fed to rules/ct.ts.
//
// Every line is one of:
//   - COMPUTED from a document total or from a federal line already on the return (a 0 only when that
//     source is known and is 0; never from a missing or unread source);
//   - NOT_APPLICABLE 0 because the owner stated "none" for the Return-completeness group that covers it
//     (facts.statedNone, the same mechanism as the federal none groups);
//   - blocked: missing_input (statement not answered / document not read), needs_cpa_judgment (the owner
//     answered Yes, a document value is positive, or a federal source line is positive: the CPA works it),
//     or the status of the federal line it waits for (worst wins).
// Nothing is ever a silent 0.
//
// NOT built here (they are in the CT-1040 instructions, specs/09 "Not verified"): the Social Security
// Benefit Adjustment Worksheet (p. 24), the Pension and Annuity Worksheet (pp. 24-25), the CHET maximum /
// carryforward, positive bonus / Section 179 add-backs and prior add-back subtractions. When a source for
// one of them is positive the line goes to the CPA (needs_cpa_judgment).
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { K } from "@/lib/tax2025/constants";
import { NONE_GROUP_TEXT, lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import { ZERO, amountLine, blockedLine, fmt } from "@/lib/tax2025/money";
import { aggregateStatus, hasAmount, worstBlocked, type Ref, type RuleLine, type RuleResult, type RuleStatus } from "@/lib/tax2025/types";

/** The six Return-completeness groups that gate Schedule 1 lines. */
export const CT_SCH1_GROUPS = ["ct_muni_bonds", "ct_us_gov_funds", "ct_chet_able", "ct_prior_addbacks", "ct_other_additions", "ct_other_subtractions"] as const;
export type CtSch1Group = (typeof CT_SCH1_GROUPS)[number];

/** Schedule 1 additions detail lines (summed into line 38) and subtractions detail lines (summed into line 50). */
export const CT_SCH1_ADDITION_KEYS = [
  "ct1040.s1.31",
  "ct1040.s1.32",
  "ct1040.s1.33",
  "ct1040.s1.34",
  "ct1040.s1.35",
  "ct1040.s1.36",
  "ct1040.s1.36a",
  "ct1040.s1.37",
] as const satisfies readonly LineKey[];
export const CT_SCH1_SUBTRACTION_KEYS = [
  "ct1040.s1.39",
  "ct1040.s1.40",
  "ct1040.s1.41",
  "ct1040.s1.42",
  "ct1040.s1.43",
  "ct1040.s1.44",
  "ct1040.s1.45",
  "ct1040.s1.46",
  "ct1040.s1.47",
  "ct1040.s1.48",
  "ct1040.s1.48a",
  "ct1040.s1.48b",
  "ct1040.s1.48c",
  "ct1040.s1.48d",
  "ct1040.s1.49",
] as const satisfies readonly LineKey[];

type Blocked = Exclude<RuleStatus, "computed" | "not_applicable">;

/** A federal line already on the return: its whole-dollar amount (null when blocked), its status and provenance. */
export interface CtFederalLead {
  amount: Decimal | null;
  status: RuleStatus | undefined;
  refs?: Ref[];
}

export interface CtSchedule1Input {
  /** Sum of 1099-INT box 8 (tax-exempt interest); null = the interest documents are not known / a box is unread. */
  exemptInterestBox8: Decimal | null;
  /** Sum of 1099-DIV exempt-interest dividends (extraction field `div_box11Cents`); null = not known. */
  exemptDividends: Decimal | null;
  /** Sum of 1099-INT box 3 (US savings bond / Treasury interest, already inside federal 2b); null = not known. */
  usGovInterestBox3: Decimal | null;
  fed: {
    /** Federal Schedule 1 line 1 (taxable state refund): CT line 42 repeats it. */
    refund: CtFederalLead;
    /** Federal Schedule 1 line 5 (rental, partnerships, S corporations, estates, trusts): the only source of fiduciary / pass-through modifications. */
    trustsPartnerships: CtFederalLead;
    /** Schedule C line 13 (depreciation and Section 179 expense). */
    depreciation: CtFederalLead;
    /** Form 1040 lines 4b, 5b, 6b. */
    ira: CtFederalLead;
    pension: CtFederalLead;
    ss: CtFederalLead;
  };
  /** true = the owner stated "none", false = answered Yes, absent = not answered / not sure. */
  stated: Partial<Record<CtSch1Group | "savings_bond_exclusion", boolean>>;
  /** About how much, when the owner answered Yes (shown to the CPA in the reason only; never computed). */
  statedSomeAmounts?: Partial<Record<CtSch1Group, Decimal | null>>;
  /** Owner / CPA stated total for line 37 / line 49 ("other"); overrides the group when not null. */
  otherAdditions: Decimal | null;
  otherSubtractions: Decimal | null;
  /** Provenance of the document totals, the statements and the stated overrides. */
  refs?: {
    interest?: Ref[];
    dividends?: Ref[];
    groups?: Partial<Record<CtSch1Group | "savings_bond_exclusion", Ref[]>>;
    otherAdditions?: Ref[];
    otherSubtractions?: Ref[];
  };
}

const CITATIONS = [
  "CT_SCH1_LINE_RULES",
  "CT_SCH1_STATUTORY_MODIFICATIONS_ONLY",
  "CT_SCH1_BONUS_168K_ADDBACK_PERCENT",
  "CT_SCH1_SECTION_179_ADDBACK_PERCENT",
  "CT_SCH1_PRIOR_ADDBACK_SUBTRACTION_PERCENT",
];

/** Plain-language name of each Return-completeness question (matches the questionnaire labels). */
const QUESTION_NAME: Record<CtSch1Group, string> = {
  ct_muni_bonds: "Connecticut bond sales",
  ct_us_gov_funds: "U.S. government bond funds",
  ct_chet_able: "CHET and ABLE accounts",
  ct_prior_addbacks: "earlier Connecticut depreciation add-backs",
  ct_other_additions: "other Connecticut additions",
  ct_other_subtractions: "other Connecticut subtractions",
};

const INSTR = "CT-1040 instructions, Schedule 1";

interface Pending {
  status: Blocked;
  lineIds: string[];
  missingName: string | null;
}

export function computeCtSchedule1(input: CtSchedule1Input): RuleResult {
  const lines: RuleLine[] = [];
  const pending = new Map<string, Pending>();
  const idOf = (key: LineKey): string => key.slice("ct1040.s1.".length);
  const ruleText = (key: LineKey): string => K.CT_SCH1_LINE_RULES.value[idOf(key)] ?? `Line ${idOf(key)}.`;
  const refsFor = (...groups: (Ref[] | undefined)[]): Ref[] | undefined => {
    const out = groups.flatMap((g) => g ?? []);
    return out.length > 0 ? out : undefined;
  };

  const ok = (key: LineKey, amount: Decimal, status: "computed" | "not_applicable", detail: string, refs?: Ref[]): void => {
    const line = amountLine(key, lineMeta(key).label, lineMeta(key).formLine, amount, status, `${INSTR} line ${idOf(key)}: ${detail} ${ruleText(key)}`);
    if (refs !== undefined) line.refs = refs;
    lines.push(line);
  };
  /** Emits one blocked line (never a number). */
  const emitBlocked = (key: LineKey, status: Blocked, detail: string, refs?: Ref[]): void => {
    const line = blockedLine(key, lineMeta(key).label, lineMeta(key).formLine, status, `${INSTR} line ${idOf(key)}: ${detail} ${ruleText(key)}`);
    if (refs !== undefined) line.refs = refs;
    lines.push(line);
  };
  /** topic = what the owner / CPA / a federal line must settle; the summary lists one entry per topic. */
  const note = (key: LineKey, status: Blocked, topic: string, missingName: string | null): void => {
    const prior = pending.get(topic);
    if (prior === undefined) pending.set(topic, { status, lineIds: [idOf(key)], missingName });
    else {
      prior.lineIds.push(idOf(key));
      prior.status = worstBlocked([prior.status, status]) ?? prior.status;
    }
  };
  const block = (key: LineKey, status: Blocked, topic: string, detail: string, missingName: string | null, refs?: Ref[]): void => {
    emitBlocked(key, status, detail, refs);
    note(key, status, topic, missingName);
  };

  // ── A statement-driven line (owner "none" group) ────────────────────────────
  const fromGroups = (key: LineKey, groups: readonly CtSch1Group[], whyYes: string): void => {
    const refs = refsFor(...groups.map((g) => input.refs?.groups?.[g]));
    const yes = groups.filter((g) => input.stated[g] === false);
    const unanswered = groups.filter((g) => input.stated[g] === undefined);
    if (yes.length === 0 && unanswered.length === 0) {
      ok(key, ZERO, "not_applicable", `Stated: ${groups.map((g) => NONE_GROUP_TEXT[g]).join(" ")}`, refs);
      return;
    }
    const parts: string[] = [];
    for (const g of yes) {
      const about = input.statedSomeAmounts?.[g];
      const carried = about === null || about === undefined ? "" : ` (about ${fmt(about)})`;
      parts.push(`the owner answered Yes to "${QUESTION_NAME[g]}"${carried}: ${whyYes} The statement that does not hold: ${NONE_GROUP_TEXT[g]}`);
      note(key, "needs_cpa_judgment", `Return completeness "${QUESTION_NAME[g]}" answered Yes${carried}`, null);
    }
    for (const g of unanswered) {
      parts.push(`needs an owner / CPA statement: ${NONE_GROUP_TEXT[g]}`);
      note(key, "missing_input", `Return completeness "${QUESTION_NAME[g]}"`, `Return completeness: the "${QUESTION_NAME[g]}" question`);
    }
    emitBlocked(key, unanswered.length > 0 ? "missing_input" : "needs_cpa_judgment", parts.join(" "), refs);
  };

  // ── A line that follows federal source lines (Form 1040 4b / 5b / 6b, Schedule 1 line 5, ...) ──
  const fromFederal = (key: LineKey, leads: readonly (readonly [name: string, lead: CtFederalLead])[], whyPositive: string, waiting?: string): void => {
    const refs = refsFor(...leads.map(([, l]) => l.refs));
    const blockedLeads = leads.filter(([, l]) => !(l.amount !== null && l.status !== undefined && hasAmount(l.status)));
    if (blockedLeads.length > 0) {
      const status = worstBlocked(blockedLeads.map(([, l]) => l.status)) ?? "missing_input";
      const names = blockedLeads.map(([n]) => n).join(", ");
      block(key, status, `federal ${names}`, `waits for ${names}, which is not computed yet.${waiting === undefined ? "" : ` ${waiting}`}`, null, refs);
      return;
    }
    const positive = leads.filter(([, l]) => l.amount !== null && !l.amount.isZero());
    if (positive.length > 0) {
      const names = positive.map(([n, l]) => `${n} ${fmt(l.amount!)}`).join(", ");
      block(key, "needs_cpa_judgment", `federal ${positive.map(([n]) => n).join(", ")} is not zero`, `${names} is not zero: ${whyPositive}`, null, refs);
      return;
    }
    ok(key, ZERO, "computed", `${leads.map(([n]) => n).join(", ")} ${leads.length === 1 ? "is" : "are"} $0 on this return.`, refs);
  };

  const { fed } = input;
  const retirement = [
    ["Form 1040 line 4b (IRA distributions)", fed.ira],
    ["Form 1040 line 5b (pensions and annuities)", fed.pension],
    ["Form 1040 line 6b (Social Security)", fed.ss],
  ] as const;
  const retirementPositive = "the Social Security Benefit Adjustment Worksheet (instructions p. 24) and the Pension and Annuity Worksheet (pp. 24-25) are not built here, so the CPA works this line.";

  // ── Additions ────────────────────────────────────────────────────────────────
  // 31: tax-exempt interest from a non-Connecticut issuer (1099-INT box 8)
  if (input.exemptInterestBox8 === null) {
    block("ct1040.s1.31", "missing_input", "1099-INT documents", "the 1099-INT documents are not all on file or read (box 8 tax-exempt interest is unknown).", "1099-INT documents (box 8 tax-exempt interest)", input.refs?.interest);
  } else if (input.exemptInterestBox8.isZero()) {
    ok("ct1040.s1.31", ZERO, "computed", "1099-INT box 8 (tax-exempt interest) totals $0.", input.refs?.interest);
  } else {
    block("ct1040.s1.31", "needs_cpa_judgment", "1099-INT box 8 is not zero", `1099-INT box 8 reports tax-exempt interest of ${fmt(input.exemptInterestBox8)}; the issuing state is not extracted and Connecticut adds back only non-Connecticut issuers, so the CPA decides.`, null, input.refs?.interest);
  }
  // 32: exempt-interest dividends from a fund (non-Connecticut share)
  if (input.exemptDividends === null) {
    block("ct1040.s1.32", "missing_input", "1099-DIV documents", "the 1099-DIV documents are not all on file or read (exempt-interest dividends are unknown).", "1099-DIV documents (exempt-interest dividends)", input.refs?.dividends);
  } else if (input.exemptDividends.isZero()) {
    ok("ct1040.s1.32", ZERO, "computed", "1099-DIV exempt-interest dividends (extracted field) total $0.", input.refs?.dividends);
  } else {
    block("ct1040.s1.32", "needs_cpa_judgment", "1099-DIV exempt-interest dividends are not zero", `1099-DIV reports exempt-interest dividends of ${fmt(input.exemptDividends)}; the fund's Connecticut / non-Connecticut percentage is on the fund's own statement, not the 1099, so the CPA decides.`, null, input.refs?.dividends);
  }
  // 33: lump-sum distributions (Form 4972) can only come from a qualified plan
  fromFederal("ct1040.s1.33", retirement, retirementPositive, "Lump-sum distributions need a qualified plan distribution.");
  // 34 / 46: fiduciary adjustment, only from an estate or trust (federal Schedule 1 line 5)
  const passThrough = [["Schedule 1 line 5 (rental, partnerships, S corporations, estates, trusts)", fed.trustsPartnerships]] as const;
  const passThroughPositive = "an estate or trust may carry a Connecticut fiduciary adjustment that is not extracted, so the CPA decides.";
  fromFederal("ct1040.s1.34", passThrough, passThroughPositive);
  // 35: loss on Connecticut bonds
  fromGroups("ct1040.s1.35", ["ct_muni_bonds"], "the amount is not extracted from the 1099-B summary, so the CPA works it.");
  // 36 / 36a: bonus depreciation and Section 179 come from Form 4562 (Schedule C line 13) or a pass-through (Schedule 1 line 5)
  const depreciation = [
    ["Schedule C line 13 (depreciation and Section 179)", fed.depreciation],
    ["Schedule 1 line 5 (rental, partnerships, S corporations, estates, trusts)", fed.trustsPartnerships],
  ] as const;
  const bonusWaiting = `Connecticut adds back ${K.CT_SCH1_BONUS_168K_ADDBACK_PERCENT.value}% of bonus depreciation and ${K.CT_SCH1_SECTION_179_ADDBACK_PERCENT.value}% of Section 179 once Form 4562 is computed.`;
  const bonusPositive = "the bonus / Section 179 / regular depreciation split is not known, so the CPA works it.";
  fromFederal("ct1040.s1.36", depreciation, bonusPositive, bonusWaiting);
  fromFederal("ct1040.s1.36a", depreciation, bonusPositive, bonusWaiting);
  // 37: other additions (a stated total wins over the statement)
  if (input.otherAdditions !== null) {
    ok("ct1040.s1.37", input.otherAdditions, "computed", "stated by the owner / CPA.", refsFor(input.refs?.otherAdditions));
  } else {
    fromGroups("ct1040.s1.37", ["ct_other_additions"], "the CPA works these additions (the form also needs a description).");
  }

  // ── Subtractions ─────────────────────────────────────────────────────────────
  // 39: U.S. government obligation interest (1099-INT box 3, already in federal 2b)
  if (input.usGovInterestBox3 === null) {
    block("ct1040.s1.39", "missing_input", "1099-INT documents", "the 1099-INT documents are not all on file or read (box 3 savings bond / Treasury interest is unknown).", "1099-INT documents (box 3 savings bond / Treasury interest)", input.refs?.interest);
  } else if (input.usGovInterestBox3.isZero()) {
    ok("ct1040.s1.39", ZERO, "computed", "1099-INT box 3 (U.S. savings bond and Treasury interest) totals $0.", input.refs?.interest);
  } else if (input.stated.savings_bond_exclusion === true) {
    ok(
      "ct1040.s1.39",
      input.usGovInterestBox3,
      "computed",
      `1099-INT box 3 (U.S. savings bond and Treasury interest) is ${fmt(input.usGovInterestBox3)} and is in federal AGI; no Form 8815 exclusion was taken (stated none), so the whole amount is subtracted. Fannie Mae, Ginnie Mae and Freddie Mac interest (in box 1) is not.`,
      refsFor(input.refs?.interest, input.refs?.groups?.savings_bond_exclusion)
    );
  } else {
    block(
      "ct1040.s1.39",
      "needs_cpa_judgment",
      "1099-INT box 3 is not zero",
      `1099-INT box 3 reports U.S. savings bond / Treasury interest of ${fmt(input.usGovInterestBox3)}; Series EE interest is subtractable only after the Form 8815 exclusion and the savings bond exclusion statement is not "none", so the CPA decides.`,
      null,
      refsFor(input.refs?.interest, input.refs?.groups?.savings_bond_exclusion)
    );
  }
  // 40: fund dividends from U.S. government obligations (the percentage is not on the 1099-DIV)
  fromGroups("ct1040.s1.40", ["ct_us_gov_funds"], "the fund's U.S.-obligation percentage is not on the 1099-DIV, so the CPA works it from the fund's statement.");
  // 41 / 43 / 44 / 45 / 48b: Social Security, railroad, military, teachers, pension and annuity
  for (const key of ["ct1040.s1.41", "ct1040.s1.43", "ct1040.s1.44", "ct1040.s1.45", "ct1040.s1.48b"] as const) {
    fromFederal(key, retirement, retirementPositive);
  }
  // 42: the taxable state refund on federal Schedule 1 line 1, repeated
  {
    const refund = fed.refund;
    const refs = refsFor(refund.refs);
    if (refund.amount !== null && refund.status !== undefined && hasAmount(refund.status)) {
      ok("ct1040.s1.42", refund.amount, refund.status === "not_applicable" ? "not_applicable" : "computed", `the taxable state refund on federal Schedule 1 line 1 is ${fmt(refund.amount)}.${refund.amount.isZero() ? " (Federal Schedule 1 line 1 explains why; for example none of a refund is taxable when the 2024 standard deduction was taken.)" : ""}`, refs);
    } else {
      block("ct1040.s1.42", worstBlocked([refund.status]) ?? "missing_input", "federal Schedule 1 line 1", "waits for federal Schedule 1 line 1 (the state refund), which is not computed yet.", null, refs);
    }
  }
  // 46: fiduciary adjustment below zero
  fromFederal("ct1040.s1.46", passThrough, passThroughPositive);
  // 47: gain on Connecticut bonds
  fromGroups("ct1040.s1.47", ["ct_muni_bonds"], "the amount is not extracted from the 1099-B summary, so the CPA works it.");
  // 48 / 48d: CHET and ABLE
  fromGroups("ct1040.s1.48", ["ct_chet_able"], "the maximum contribution and the five-year carryforward are not computed here, so the CPA works it.");
  // 48a: 25% of earlier bonus add-backs
  fromGroups("ct1040.s1.48a", ["ct_prior_addbacks"], `${K.CT_SCH1_PRIOR_ADDBACK_SUBTRACTION_PERCENT.value}% of the earlier add-backs is not computed here, so the CPA works it.`);
  // 48c: cannabis licensee expenses
  fromGroups("ct1040.s1.48c", ["ct_other_subtractions"], "the CPA works this subtraction.");
  fromGroups("ct1040.s1.48d", ["ct_chet_able"], "the maximum contribution is not computed here, so the CPA works it.");
  // 49: other subtractions (a stated total wins over the statements)
  if (input.otherSubtractions !== null) {
    ok("ct1040.s1.49", input.otherSubtractions, "computed", "stated by the owner / CPA.", refsFor(input.refs?.otherSubtractions));
  } else {
    fromGroups("ct1040.s1.49", ["ct_other_subtractions", "ct_prior_addbacks", "ct_chet_able"], "the CPA works these subtractions (the form also needs a description).");
  }

  // ── Result ───────────────────────────────────────────────────────────────────
  const ordered = [...CT_SCH1_ADDITION_KEYS, ...CT_SCH1_SUBTRACTION_KEYS].map((k) => lines.find((l) => l.key === k)).filter((l): l is RuleLine => l !== undefined);
  const status = aggregateStatus(ordered);
  const items = [...pending.entries()].map(([topic, p]) => `${topic} (line${p.lineIds.length === 1 ? "" : "s"} ${[...new Set(p.lineIds)].join(", ")})`);
  const reasons =
    items.length === 0
      ? [`CT-1040 Schedule 1 detail lines 31-37 and 39-49 are all computed or stated none; the totals are line 38 (additions) and line 50 (subtractions). Only changes allowed by ${K.CT_SCH1_STATUTORY_MODIFICATIONS_ONLY.value} are applied.`]
      : [`CT-1040 Schedule 1 is not final. Waiting on: ${items.join("; ")}.`];
  const inputsMissing = [...new Set([...pending.values()].filter((p) => p.missingName !== null).map((p) => p.missingName as string))];
  return {
    ruleId: "ct-schedule1",
    form: "CT-1040 Schedule 1",
    status,
    lines: ordered,
    reasons,
    citations: CITATIONS,
    inputsUsed: [],
    inputsMissing,
  };
}
