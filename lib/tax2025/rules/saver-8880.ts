// Form 8880: credit for qualified retirement savings contributions (the saver's
// credit) -> Schedule 3 line 4. Source: the 2025 Form 8880 (f8880.pdf) and its
// instructions, verified 2026-10-03:
//   * NO credit when Form 1040 line 11a is more than $79,000 (married filing jointly)
//     -> a computed "ineligible" conclusion with that citation, no further inputs needed;
//   * otherwise: each spouse's qualified contributions (IRA / Roth IRA plus elective
//     deferrals) reduced by certain recent distributions, capped at $2,000 per person
//     (line 6), added (line 7), times the decimal from the line 9 table by AGI
//     (MFJ: 50% to $47,500, 20% to $51,000, 10% to $79,000), then limited to the tax
//     (Credit Limit Worksheet: Form 1040 line 18 minus Schedule 3 lines 1-3, 6d, 6l).
//   * a person born after January 1, 2008, claimed as someone's dependent, or a
//     full-time student for 5 months gets no credit: any "yes" there is
//     needs_cpa_judgment (it cannot be attributed to a spouse without more data).
// Distributions (line 4) are not computed: a "yes" is needs_cpa_judgment.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD } from "@/lib/tax2025/money";
import { aggregateStatus, type RuleLine, type RuleResult, type RuleStatus } from "@/lib/tax2025/types";

export interface SaverPersonInput {
  name: string;
  /** Traditional + Roth IRA (and ABLE) contributions for 2025; none = answered(0). */
  iraContributions: Ans<Decimal>;
  /** Elective deferrals to a 401(k), 403(b), 457(b), SEP, SIMPLE or TSP; none = answered(0). */
  deferrals: Ans<Decimal>;
}

export interface SaverInput {
  /** Form 1040 line 11a; null = not computed yet. */
  agi: Decimal | null;
  people: SaverPersonInput[];
  distributionsSince2022: Ans<boolean>;
  studentOrDependent: Ans<boolean>;
  /** Form 1040 line 18; null = not computed yet. */
  taxBeforeCredits: Decimal | null;
  /** Schedule 3 lines 1 through 3, 6d and 6l; null = not computed yet. */
  otherCredits: Decimal | null;
}

type Blocked = Exclude<RuleStatus, "computed" | "not_applicable">;

const CITES = ["SAVERS_RATE_BANDS_MFJ", "SAVERS_CONTRIBUTION_CAP", "SCH3_LINE_MAP"];

function blockAll(status: Blocked, reason: string, missing: string[]): RuleResult {
  const lines: RuleLine[] = [
    blockedLine("f8880.7", "Qualified contributions after the $2,000 cap per person", "7", status, reason),
    blockedLine("f8880.10", "Contributions times the applicable decimal", "10", status, reason),
    blockedLine("f8880.11", "Limitation based on tax liability", "11", status, reason),
    blockedLine("f8880.12", "Credit for qualified retirement savings contributions", "12", status, reason),
    blockedLine("sch3.4", "Retirement savings contributions credit (Form 8880)", "4", status, reason),
  ];
  return { ruleId: "saver-8880", form: "Form 8880", status, lines, reasons: [reason], citations: CITES, inputsUsed: [], inputsMissing: missing };
}

export function computeSaversCredit(input: SaverInput): RuleResult {
  const bands = K.SAVERS_RATE_BANDS_MFJ.value;
  const noCreditAbove = bands.filter((b) => b.upTo !== null).reduce((m, b) => Math.max(m, b.upTo as number), 0);
  if (input.agi === null) {
    return blockAll("missing_input", "Form 1040 line 11a (adjusted gross income) is not computed yet, so the saver's credit cannot be decided.", ["Form 1040 line 11a"]);
  }
  const agi = input.agi;
  const lineLabel8 = "Adjusted gross income (Form 1040 line 11a)";
  if (agi.greaterThan(noCreditAbove)) {
    const why = `Ineligible: Form 8880 says no credit when Form 1040 line 11a is more than ${fmt(D(noCreditAbove))} (married filing jointly); adjusted gross income is ${fmt(agi)}.`;
    const lines: RuleLine[] = [
      amountLine("f8880.8", lineLabel8, "8", agi, "computed"),
      amountLine("f8880.7", "Qualified contributions after the $2,000 cap per person", "7", ZERO, "not_applicable", "Not needed: adjusted gross income is over the limit."),
      amountLine("f8880.10", "Contributions times the applicable decimal", "10", ZERO, "not_applicable", "Not needed: adjusted gross income is over the limit."),
      amountLine("f8880.11", "Limitation based on tax liability", "11", ZERO, "not_applicable", "Not needed: adjusted gross income is over the limit."),
      amountLine("f8880.12", "Credit for qualified retirement savings contributions", "12", ZERO, "computed", why),
      amountLine("sch3.4", "Retirement savings contributions credit (Form 8880)", "4", ZERO, "computed", why),
    ];
    return { ruleId: "saver-8880", form: "Form 8880", status: "computed", conclusion: "ineligible", lines, reasons: [why], citations: CITES, inputsUsed: [], inputsMissing: [] };
  }

  // AGI is within the credit range: the contributions decide.
  const missing: string[] = [];
  const stops: { status: Blocked; reason: string }[] = [];
  const note = (a: Ans<unknown>, what: string): void => {
    if (a.state === "missing") {
      stops.push({ status: "missing_input", reason: `${what} has not been answered.` });
      missing.push(what);
    } else if (a.state === "unsure") {
      stops.push({ status: "needs_cpa_judgment", reason: `the owner is not sure about ${what}; the CPA decides.` });
      missing.push(what);
    }
  };
  note(input.studentOrDependent, "whether either spouse was a student or claimed as a dependent");
  note(input.distributionsSince2022, "whether a retirement distribution was received after 2022");
  for (const p of input.people) {
    note(p.iraContributions, `IRA contributions (${p.name})`);
    note(p.deferrals, `elective deferrals (${p.name})`);
  }
  if (input.studentOrDependent.state === "answered" && input.studentOrDependent.value) {
    stops.push({ status: "needs_cpa_judgment", reason: "a spouse was a student or claimed as a dependent, which removes that person's contributions; the CPA decides." });
  }
  if (input.distributionsSince2022.state === "answered" && input.distributionsSince2022.value) {
    stops.push({ status: "needs_cpa_judgment", reason: "a retirement distribution was received after 2022: Form 8880 line 4 reduces the contributions and is the CPA's." });
  }
  if (stops.length > 0) {
    const order: Blocked[] = ["missing_input", "needs_cpa_judgment", "needs_cpa_rule_unverified", "not_yet_computed"];
    const status = order.find((s) => stops.some((x) => x.status === s)) ?? "missing_input";
    return blockAll(status, `Saver's credit: ${stops.map((s) => s.reason).join(" ")}`, missing);
  }

  const cap = D(K.SAVERS_CONTRIBUTION_CAP.value);
  let line7 = ZERO;
  const parts: string[] = [];
  for (const p of input.people) {
    const ira = (p.iraContributions as { state: "answered"; value: Decimal }).value;
    const def = (p.deferrals as { state: "answered"; value: Decimal }).value;
    const line6 = minD(ira.plus(def), cap);
    line7 = line7.plus(line6);
    parts.push(`${p.name}: ${fmt(ira)} IRA + ${fmt(def)} deferrals, counted ${fmt(line6)}`);
  }
  const lines: RuleLine[] = [amountLine("f8880.8", lineLabel8, "8", agi, "computed")];
  lines.push(amountLine("f8880.7", "Qualified contributions after the $2,000 cap per person", "7", line7, line7.isZero() ? "not_applicable" : "computed", parts.join("; ") || "No contributions."));
  if (line7.isZero()) {
    const why = "No qualified retirement contributions: no credit (Form 8880 line 7 is zero).";
    lines.push(
      amountLine("f8880.10", "Contributions times the applicable decimal", "10", ZERO, "not_applicable", why),
      amountLine("f8880.11", "Limitation based on tax liability", "11", ZERO, "not_applicable", why),
      amountLine("f8880.12", "Credit for qualified retirement savings contributions", "12", ZERO, "computed", why),
      amountLine("sch3.4", "Retirement savings contributions credit (Form 8880)", "4", ZERO, "computed", why)
    );
    return { ruleId: "saver-8880", form: "Form 8880", status: "computed", conclusion: "ineligible", lines, reasons: [why], citations: CITES, inputsUsed: [], inputsMissing: [] };
  }
  const band = bands.find((b) => b.upTo === null || agi.lessThanOrEqualTo(b.upTo));
  const decimal = D(band === undefined ? 0 : band.value);
  const line10 = line7.times(decimal);
  lines.push(amountLine("f8880.10", "Contributions times the applicable decimal", "10", line10, "computed", `${fmt(line7)} x ${decimal.toString()} (line 9 decimal for adjusted gross income ${fmt(agi)}).`));
  if (input.taxBeforeCredits === null || input.otherCredits === null) {
    const reason = "The Credit Limit Worksheet needs Form 1040 line 18 and the other Schedule 3 credits, which are not computed yet.";
    lines.push(
      blockedLine("f8880.11", "Limitation based on tax liability", "11", "missing_input", reason),
      blockedLine("f8880.12", "Credit for qualified retirement savings contributions", "12", "missing_input", reason),
      blockedLine("sch3.4", "Retirement savings contributions credit (Form 8880)", "4", "missing_input", reason)
    );
    return { ruleId: "saver-8880", form: "Form 8880", status: aggregateStatus(lines, "computed"), lines, reasons: [reason], citations: CITES, inputsUsed: [], inputsMissing: ["Form 1040 line 18"] };
  }
  const line11 = maxD(ZERO, input.taxBeforeCredits.minus(input.otherCredits));
  const credit = minD(line10, line11);
  const why = `Credit ${fmt(credit)}: smaller of ${fmt(line10)} (contributions x decimal) and the tax limit ${fmt(line11)} (Form 1040 line 18 ${fmt(input.taxBeforeCredits)} minus other credits ${fmt(input.otherCredits)}).`;
  lines.push(
    amountLine("f8880.11", "Limitation based on tax liability", "11", line11, "computed", "Credit Limit Worksheet line 3."),
    amountLine("f8880.12", "Credit for qualified retirement savings contributions", "12", credit, credit.isZero() ? "not_applicable" : "computed", why),
    amountLine("sch3.4", "Retirement savings contributions credit (Form 8880)", "4", credit, credit.isZero() ? "not_applicable" : "computed", why)
  );
  return {
    ruleId: "saver-8880",
    form: "Form 8880",
    status: "computed",
    conclusion: decimal.isZero() ? "ineligible" : credit.lessThan(line10) ? "partial" : "eligible",
    lines,
    reasons: [why],
    citations: CITES,
    inputsUsed: [],
    inputsMissing: [],
  };
}
