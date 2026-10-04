// Connecticut Form CT-1040 pieces for TY2025, MFJ: CT AGI, CT income tax (TCS
// Tables A-E via lib/tax-compute.ts, Table C corrected, defect D7), the CT AMT
// trigger, the property tax credit (line 11 / Schedule 3), use tax (line 15 / Schedule 4).
//
// What is NOT guessed (specs/09 "Not verified"):
//   - CT AGI up to $102,000: the instructions send the filer to the printed CT tax
//     table, which is not transcribed; the TCS figure is shown in the reason only
//     -> needs_cpa_rule_unverified. CT AGI of $24,000 or less (MFJ): no tax (verified).
//   - CT-6251 (CT AMT) when there is a federal AMT -> needs_cpa_rule_unverified.
//   - The CT late-payment minimum and month-counting rules, CT-2210 interest and the refund line 25
//     live in rules/ct-settlement.ts (informational, needs_cpa_rule_unverified).
//   - Lines 7 / 13 / 20a-20d (credits the engine does not compute) come from rules/ct-credits.ts; line 7 enters
//     computeCtTax as an input. The pure arithmetic lines 12, 14, 16, 17, 21, 22 and 26 are derived in return.ts.
//   - The CT Schedule 1 modifications themselves are built by rules/ct-schedule1.ts (line by
//     line); this file only receives the two totals (line 38 additions, line 50 subtractions).
//     When either total is not final the rule's blocking status and reason (`modificationsBlock`)
//     reach CT AGI, tax, AMT and line 10; the default is not_yet_computed (never a silent 0).
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { computeConnecticutTax } from "@/lib/tax-compute";
import { K } from "@/lib/tax2025/constants";
import type { PropertyBillKind } from "@/lib/tax2025/facts";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD, roundLine, sumThenRound } from "@/lib/tax2025/money";
import { aggregateStatus, type LineKey, type RuleLine, type RuleResult, type RuleStatus } from "@/lib/tax2025/types";

// ── Property tax credit (CT-1040 Schedule 3 / line 11) ───────────────────────

export interface CtCreditBill {
  docId: string;
  label: string;
  kind: PropertyBillKind;
  paid: Decimal | null;
}

/** Phase-out decimal for a CT AGI (MFJ), from the verified table: more than the previous bound, at most this one. */
export function ctPropertyTaxPhaseOutDecimal(ctAgi: Decimal): Decimal {
  for (const band of K.CT_PROPERTY_TAX_CREDIT_PHASEOUT_MFJ.value) {
    if (band.upTo === null || ctAgi.lessThanOrEqualTo(band.upTo)) return D(band.value);
  }
  return D(1);
}

/** The CT AGI above which the credit is fully phased out (the last finite bound of the verified table). */
function fullyPhasedOutAbove(): number {
  const finite = K.CT_PROPERTY_TAX_CREDIT_PHASEOUT_MFJ.value.filter((b) => b.upTo !== null);
  return finite[finite.length - 1]?.upTo ?? 0;
}

export interface CtPropertyTaxCreditInput {
  /** CT AGI (whole dollars); null = missing. */
  ctAgi: Decimal | null;
  bills: CtCreditBill[];
  /** CT income tax before credits (CT-1040 line 10); the credit cannot exceed it. Null = not known. */
  ctTaxBeforeCredits: Decimal | null;
}

const CREDIT_CITATIONS = [
  "CT_PROPERTY_TAX_CREDIT_MAX",
  "CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ",
  "CT_PROPERTY_TAX_CREDIT_FULL_AGI_MFJ",
  "CT_PROPERTY_TAX_CREDIT_PHASEOUT_MFJ",
];

const S3_63 = { key: "ct1040.s3.63", formLine: "Sch 3 line 63", label: "Property tax credit: total property tax paid (lines 60 through 62)" } as const;
const S3_65 = { key: "ct1040.s3.65", formLine: "Sch 3 line 65", label: "Property tax credit: lesser of line 63 or line 64" } as const;
const S3_67 = { key: "ct1040.s3.67", formLine: "Sch 3 line 67", label: "Property tax credit: line 65 times the line 66 decimal" } as const;
const S3_LINES = [S3_63, S3_65, S3_67] as const satisfies readonly { key: LineKey; formLine: string; label: string }[];

/**
 * CT-1040 line 11 and Schedule 3 lines 63 / 65 / 67 (line 68 is line 11). Form order, whole-dollar rows:
 *   63 = 60 + 61 + 62 (the printed rows: the home as one row, each vehicle one row, each rounded to whole dollars)
 *   64 = $300 (pre-printed), 65 = the lesser of 63 and 64
 *   66 = the decimal for CT AGI, 67 = 65 x 66 (rounded), 68 = 65 - 67 = line 11 (not more than line 10).
 * Fully phased out (decimal 1.00) or line 10 = 0: the schedule has nothing to claim, lines 63 / 65 / 67 are not_applicable 0
 * and the PDF adapter leaves Schedule 3 blank.
 */
export function computeCtPropertyTaxCredit(input: CtPropertyTaxCreditInput): RuleResult {
  const base = { ruleId: "ct-property-tax-credit", form: "CT-1040 Schedule 3", citations: CREDIT_CITATIONS, inputsUsed: [] };
  const label = "Property tax credit";
  const blockAll = (reason: string, inputsMissing: string[], reasons: string[] = [reason]): RuleResult => ({
    ...base,
    status: "missing_input",
    lines: [
      blockedLine("ct1040.11", label, "11", "missing_input", reason),
      ...S3_LINES.map((l) => blockedLine(l.key, l.label, l.formLine, "missing_input", reason)),
    ],
    reasons,
    inputsMissing,
  });
  const notApplicable = (reason: string): RuleLine[] =>
    S3_LINES.map((l): RuleLine => ({ key: l.key, label: l.label, formLine: l.formLine, amount: ZERO, exact: ZERO, status: "not_applicable", reason }));

  if (input.ctAgi === null) {
    return blockAll("CT AGI is not available, so the property tax credit phase-out cannot be applied.", ["CT AGI"]);
  }
  const ctAgi = roundLine(input.ctAgi);
  const decimal = ctPropertyTaxPhaseOutDecimal(ctAgi);
  if (decimal.greaterThanOrEqualTo(1)) {
    const reason = `No property tax credit: CT AGI ${fmt(ctAgi)} is above ${fmt(D(fullyPhasedOutAbove()))}, where the credit is fully phased out (decimal 1.00).`;
    return {
      ...base,
      status: "computed",
      conclusion: "ineligible",
      lines: [amountLine("ct1040.11", label, "11", ZERO), ...notApplicable(`${reason} Schedule 3 is left blank.`)],
      reasons: [reason],
      inputsMissing: [],
    };
  }

  // Qualifying tax: primary residence + up to N motor vehicles (MFJ). Other real estate (56 Arbor Rd) never qualifies.
  const unclassified = input.bills.filter((b) => b.kind === "unclassified");
  const unpaid = input.bills.filter((b) => b.paid === null && (b.kind === "primary_residence" || b.kind === "motor_vehicle"));
  if (unclassified.length > 0 || unpaid.length > 0) {
    const parts: string[] = [];
    if (unclassified.length > 0) parts.push(`classify ${unclassified.map((b) => b.label).join(", ")}`);
    if (unpaid.length > 0) parts.push(`enter the amount paid in 2025 on ${unpaid.map((b) => b.label).join(", ")}`);
    return blockAll(`The property tax credit cannot be figured until you ${parts.join(" and ")}.`, ["property tax bill classification / paid amounts"]);
  }
  // Schedule 3 rows (the PDF prints the same ones): the home is one row (all its bills added, rounded once);
  // each vehicle is one row (the largest N); every row is a whole-dollar amount and line 63 adds the printed rows.
  const primary = input.bills.filter((b) => b.kind === "primary_residence").map((b) => b.paid ?? ZERO);
  const homeRow = primary.length > 0 ? [sumThenRound(primary)] : [];
  const vehicleRows = input.bills
    .filter((b) => b.kind === "motor_vehicle")
    .map((b) => roundLine(b.paid ?? ZERO))
    .sort((a, b) => b.comparedTo(a))
    .slice(0, K.CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ.value);
  const excluded = input.bills.filter((b) => b.kind === "other_real_estate" || b.kind === "other_personal_property");
  const line63 = [...homeRow, ...vehicleRows].reduce((acc, r) => acc.plus(r), ZERO);
  const line65 = minD(line63, D(K.CT_PROPERTY_TAX_CREDIT_MAX.value));
  const line67 = roundLine(line65.times(decimal));
  let credit = line65.minus(line67);
  const reasons: string[] = [
    `Schedule 3: qualifying property tax paid in 2025 ${fmt(line63)} (primary residence + up to ${K.CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ.value} motor vehicles, each row in whole dollars); line 65 (not more than ${fmt(D(K.CT_PROPERTY_TAX_CREDIT_MAX.value))}) ${fmt(line65)}; CT AGI ${fmt(ctAgi)} phase-out decimal ${decimal.toString()} (line 66); line 67 ${fmt(line67)}; line 68 ${fmt(credit)}.`,
  ];
  if (excluded.length > 0) {
    reasons.push(`Excluded from the credit (not a primary residence or motor vehicle): ${excluded.map((b) => b.label).join(", ")}.`);
  }
  if (input.ctTaxBeforeCredits === null) {
    const reason = "The credit cannot exceed the CT income tax (line 10), which is not available yet.";
    return blockAll(reason, ["CT income tax (line 10)"], [...reasons, reason]);
  }
  const line10 = roundLine(input.ctTaxBeforeCredits);
  if (line10.lessThanOrEqualTo(0)) {
    const reason = `CT-1040 line 10 is ${fmt(line10)}: the form says to skip lines 11 and 12 when line 10 is zero, so there is no property tax credit to take.`;
    return {
      ...base,
      status: "computed",
      conclusion: "ineligible",
      lines: [amountLine("ct1040.11", label, "11", ZERO, "computed", reason), ...notApplicable(`${reason} Schedule 3 is left blank.`)],
      reasons: [reason, ...reasons],
      inputsMissing: [],
    };
  }
  if (credit.greaterThan(line10)) {
    credit = line10;
    reasons.push(`Limited to the CT income tax of ${fmt(credit)} (the credit is not refundable).`);
  }
  const s3 = (m: (typeof S3_LINES)[number], n: string, v: Decimal, extra = ""): RuleLine =>
    amountLine(m.key, m.label, m.formLine, v, "computed", `Schedule 3 line ${n}: ${fmt(v)}${extra}.`);
  return {
    ...base,
    status: "computed",
    conclusion: credit.isZero() ? "ineligible" : decimal.isZero() ? "eligible" : "partial",
    lines: [
      amountLine("ct1040.11", label, "11", credit),
      s3(S3_63, "63", line63),
      s3(S3_65, "65", line65),
      s3(S3_67, "67", line67, ` (line 65 x ${decimal.toString()})`),
    ],
    reasons,
    inputsMissing: [],
  };
}

// ── CT AGI, tax, AMT trigger, line 8 / 10 ────────────────────────────────────

export interface CtTaxInput {
  /** Federal 1040 line 11a; null = missing. */
  federalAgi: Decimal | null;
  /** CT-1040 Schedule 1 line 38 (additions) / line 50 (subtractions) totals; null = at least one line of the total is not final. */
  additions: Decimal | null;
  subtractions: Decimal | null;
  /** Status and reason when `additions` or `subtractions` is null (from the CT Schedule 1 rule); default not_yet_computed. */
  modificationsBlock?: {
    status: "missing_input" | "needs_cpa_judgment" | "needs_cpa_rule_unverified" | "not_yet_computed";
    reason: string;
  };
  /** Federal AMT (Schedule 2 AMT line); null = missing / not computed. */
  federalAmt: Decimal | null;
  /** CT-1040 line 7 (credit for taxes paid to other jurisdictions, from rules/ct-credits.ts); null = not final. */
  otherJurisdictionCredit: Decimal | null;
  /** Status and reason when `otherJurisdictionCredit` is null; default missing_input. */
  otherJurisdictionBlock?: {
    status: Exclude<RuleStatus, "computed" | "not_applicable">;
    reason: string;
  };
}

const CT_TAX_CITATIONS = ["CT_TAX_TABLE_AGI_LIMIT", "CT_ZERO_TAX_AGI_MFJ", "CT_TABLE_C"];

export function computeCtTax(input: CtTaxInput): RuleResult {
  const base = { ruleId: "ct-tax", form: "CT-1040", citations: CT_TAX_CITATIONS, inputsUsed: [] };
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  const missing: string[] = [];
  const miss = (key: LineKey, lbl: string, formLine: string, reason: string) =>
    blockedLine(key, lbl, formLine, "missing_input", reason);
  const L3 = "Federal AGI plus Schedule 1 additions (lines 1 and 2)";
  const L8 = "Connecticut income tax after the credit for taxes paid to other jurisdictions (line 6 less line 7)";

  if (input.federalAgi === null) {
    const reason = "Federal AGI is not available.";
    lines.push(
      miss("ct1040.1", "Federal adjusted gross income (1040 line 11a)", "1", reason),
      miss("ct1040.3", L3, "3", reason),
      miss("ct1040.ctAgi", "Connecticut adjusted gross income", "CT AGI", reason),
      miss("ct1040.6", "Connecticut income tax", "6", reason),
      miss("ct1040.8", L8, "8", reason),
      miss("ct1040.9", "Connecticut alternative minimum tax", "9", reason),
      miss("ct1040.10", "Connecticut income tax before credits", "10", reason)
    );
    return { ...base, status: "missing_input", lines, reasons: [reason], inputsMissing: ["federal AGI"] };
  }
  const fedAgi = roundLine(input.federalAgi);
  lines.push(amountLine("ct1040.1", "Federal adjusted gross income (1040 line 11a)", "1", fedAgi));

  // Schedule 1 modifications (totals from rules/ct-schedule1.ts)
  const modsKnown = input.additions !== null && input.subtractions !== null;
  if (!modsKnown) {
    const status = input.modificationsBlock?.status ?? "not_yet_computed";
    const reason =
      input.modificationsBlock?.reason ??
      "CT Schedule 1 additions and subtractions (bonus / Section 179 add-backs, US-obligation interest, state refunds) are not final and none are stated.";
    lines.push(
      input.additions === null
        ? blockedLine("ct1040.additions", "CT Schedule 1 additions", "Sch 1", status, reason)
        : amountLine("ct1040.additions", "CT Schedule 1 additions", "Sch 1", roundLine(input.additions)),
      input.subtractions === null
        ? blockedLine("ct1040.subtractions", "CT Schedule 1 subtractions", "Sch 1", status, reason)
        : amountLine("ct1040.subtractions", "CT Schedule 1 subtractions", "Sch 1", roundLine(input.subtractions)),
      input.additions === null
        ? blockedLine("ct1040.3", L3, "3", status, reason)
        : amountLine("ct1040.3", L3, "3", fedAgi.plus(roundLine(input.additions))),
      blockedLine("ct1040.ctAgi", "Connecticut adjusted gross income", "CT AGI", status, reason),
      blockedLine("ct1040.6", "Connecticut income tax", "6", status, "CT AGI is not final until the Schedule 1 modifications are computed."),
      blockedLine("ct1040.8", L8, "8", status, "CT AGI is not final."),
      blockedLine("ct1040.9", "Connecticut alternative minimum tax", "9", status, "CT AGI is not final."),
      blockedLine("ct1040.10", "Connecticut income tax before credits", "10", status, "CT AGI is not final.")
    );
    return { ...base, status, lines, reasons: [reason], inputsMissing: ["CT Schedule 1 modifications"] };
  }
  const additions = roundLine(input.additions!);
  const subtractions = roundLine(input.subtractions!);
  const line3 = fedAgi.plus(additions);
  const ctAgi = line3.minus(subtractions);
  lines.push(
    amountLine("ct1040.additions", "CT Schedule 1 additions", "Sch 1", additions),
    amountLine("ct1040.subtractions", "CT Schedule 1 subtractions", "Sch 1", subtractions),
    amountLine("ct1040.3", L3, "3", line3),
    amountLine("ct1040.ctAgi", "Connecticut adjusted gross income", "CT AGI", ctAgi)
  );

  // Tax (line 6)
  let tax: Decimal | null = null;
  const tcs = computeConnecticutTax({ ctAGI: ctAgi, ctWithholdingCents: 0 });
  const zeroTaxAgi = D(K.CT_ZERO_TAX_AGI_MFJ.value);
  const tableLimit = D(K.CT_TAX_TABLE_AGI_LIMIT.value);
  if (ctAgi.lessThanOrEqualTo(zeroTaxAgi)) {
    tax = ZERO;
    lines.push(amountLine("ct1040.6", "Connecticut income tax", "6", ZERO));
    reasons.push(`CT AGI ${fmt(ctAgi)} is ${fmt(zeroTaxAgi)} or less (MFJ): no Connecticut income tax.`);
  } else if (ctAgi.lessThanOrEqualTo(tableLimit)) {
    const ref = tcs.ctTaxComputed === null ? "n/a" : fmt(roundLine(tcs.ctTaxComputed));
    const reason = `CT AGI ${fmt(ctAgi)} is ${fmt(tableLimit)} or less: the CT-1040 instructions require the printed CT tax table, which is not transcribed here. For reference only, the Tax Calculation Schedule gives ${ref}.`;
    lines.push(blockedLine("ct1040.6", "Connecticut income tax", "6", "needs_cpa_rule_unverified", reason));
    reasons.push(reason);
  } else if (tcs.ctTaxComputed === null) {
    const reason = "A Connecticut recapture / personal credit table lookup fell outside its range.";
    lines.push(blockedLine("ct1040.6", "Connecticut income tax", "6", "needs_cpa_rule_unverified", reason));
    reasons.push(reason);
  } else {
    tax = roundLine(tcs.ctTaxComputed);
    lines.push(amountLine("ct1040.6", "Connecticut income tax", "6", tax));
    reasons.push(
      `Tax Calculation Schedule at CT AGI ${fmt(ctAgi)}: exemption ${fmt(tcs.personalExemption)}, initial tax ${fmt(roundLine(tcs.initialTax))}, Table C add-back ${fmt(tcs.phaseOutAddback)}, recapture ${fmt(tcs.recapture.amount ?? ZERO)}, personal credit decimal ${tcs.personalCredit.decimal?.toString() ?? "n/a"} = ${fmt(tax)}.`
    );
  }
  const line6Status = lines.find((l) => l.key === "ct1040.6")?.status;

  // Line 8 = line 6 - line 7 ("If Line 7 is greater than Line 6, enter 0")
  let line8: Decimal | null = null;
  if (tax === null) {
    lines.push(
      blockedLine("ct1040.8", L8, "8", line6Status === "needs_cpa_rule_unverified" ? "needs_cpa_rule_unverified" : "missing_input", "Line 6 is not computed.")
    );
  } else if (input.otherJurisdictionCredit === null) {
    lines.push(
      blockedLine(
        "ct1040.8",
        L8,
        "8",
        input.otherJurisdictionBlock?.status ?? "missing_input",
        input.otherJurisdictionBlock?.reason ?? "Line 7 (credit for income taxes paid to other jurisdictions) is not final."
      )
    );
  } else {
    const line7 = roundLine(input.otherJurisdictionCredit);
    line8 = maxD(ZERO, tax.minus(line7));
    lines.push(
      amountLine(
        "ct1040.8",
        L8,
        "8",
        line8,
        "computed",
        line7.greaterThan(tax) ? `Line 7 ${fmt(line7)} is greater than line 6 ${fmt(tax)}: line 8 is 0.` : `Line 6 ${fmt(tax)} less line 7 ${fmt(line7)}.`
      )
    );
  }

  // CT AMT (line 9)
  let amtLine: Decimal | null = null;
  if (input.federalAmt === null) {
    lines.push(miss("ct1040.9", "Connecticut alternative minimum tax", "9", "The federal AMT screen has no result yet; CT-6251 is required only if there is a federal AMT."));
    missing.push("federal AMT screen");
  } else if (input.federalAmt.isZero()) {
    amtLine = ZERO;
    lines.push({
      key: "ct1040.9",
      label: "Connecticut alternative minimum tax",
      formLine: "9",
      amount: ZERO,
      exact: ZERO,
      status: "not_applicable",
      reason: "No federal AMT, so CT-6251 is not required.",
    });
  } else {
    lines.push(
      blockedLine("ct1040.9", "Connecticut alternative minimum tax", "9", "needs_cpa_rule_unverified", "A federal AMT exists, so CT-6251 is required; that form's rules are not verified here.")
    );
  }

  // Line 10 = line 8 + line 9
  if (line8 !== null && amtLine !== null) {
    lines.push(amountLine("ct1040.10", "Connecticut income tax before credits", "10", line8.plus(amtLine)));
  } else {
    const line8Line = lines.find((l) => l.key === "ct1040.8");
    // A line 8 held back by line 7 passes line 7's status on; otherwise the old rule (line 6 unverified, else missing).
    const status =
      tax !== null && line8Line?.status !== undefined && line8Line.status !== "computed" && line8Line.status !== "not_applicable"
        ? line8Line.status
        : tax === null && line6Status === "needs_cpa_rule_unverified"
          ? "needs_cpa_rule_unverified"
          : "missing_input";
    lines.push(
      blockedLine(
        "ct1040.10",
        "Connecticut income tax before credits",
        "10",
        status,
        tax !== null && line8 === null ? "Line 8 is not computed (line 7 is not final)." : "Line 6 or line 9 is not computed."
      )
    );
  }

  return { ...base, status: aggregateStatus(lines), lines, reasons, inputsMissing: missing };
}

// ── Use tax (line 15, Schedule 4 line 69b) ───────────────────────────────────

export interface CtBalanceInput {
  /** CT-1040 line 15 use tax; null = not answered. */
  useTax: Decimal | null;
  /** Plain-language "why" printed on line 15 when it has an amount (the rule or statement it came from). */
  useTaxReason?: string;
  /** When useTax is null: why (a "not sure" or an uncomputed rate is needs_cpa_judgment, not missing_input). */
  useTaxBlock?: { status: "missing_input" | "needs_cpa_judgment"; reason: string };
  /**
   * The amount came from the use tax rule (rules/ct-use-tax.ts), which only figures the 6.35% general rate, so all of it is
   * Schedule 4 line 69b. A stated total (owner / CPA) has no breakdown and leaves 69a-69d blank (advisory).
   */
  useTaxFromRule?: boolean;
}

export function computeCtBalance(input: CtBalanceInput): RuleResult {
  const base = { ruleId: "ct-balance", form: "CT-1040", citations: ["CT_USE_TAX_RATE_GENERAL"], inputsUsed: [] };
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  const missing: string[] = [];
  const L69B = "Use tax at the 6.35% general rate";

  if (input.useTax === null) {
    const status = input.useTaxBlock?.status ?? "missing_input";
    const reason = input.useTaxBlock?.reason ?? "Line 15 must be answered with 0 or an amount: say whether any 2025 out-of-state purchases were made without Connecticut sales tax.";
    lines.push(
      blockedLine("ct1040.15", "Use tax (out-of-state purchases)", "15", status, reason),
      blockedLine("ct1040.s4.69b", L69B, "Sch 4 line 69b", status, reason)
    );
    reasons.push(reason);
    missing.push("CT use tax answer");
  } else {
    const amount = roundLine(input.useTax);
    lines.push(amountLine("ct1040.15", "Use tax (out-of-state purchases)", "15", amount, "computed", input.useTaxReason ?? "Stated by the owner / CPA."));
    if (amount.isZero()) {
      lines.push(amountLine("ct1040.s4.69b", L69B, "Sch 4 line 69b", ZERO, "not_applicable", "No use tax is due, so Schedule 4 has no amount to break down."));
    } else if (input.useTaxFromRule === true) {
      lines.push(
        amountLine("ct1040.s4.69b", L69B, "Sch 4 line 69b", amount, "computed", `The rule figures only the general 6.35% rate (CT-1040 instructions, use tax worksheet Section B), so all of line 69 is line 69b. ${input.useTaxReason ?? ""}`.trim())
      );
    } else {
      lines.push({
        ...blockedLine(
          "ct1040.s4.69b",
          L69B,
          "Sch 4 line 69b",
          "not_yet_computed",
          `Use tax of ${fmt(amount)} was stated without a breakdown by rate: line 69 prints without its 69a-69d detail, so the CPA keys the breakdown.`
        ),
        informational: true,
      });
    }
  }
  return { ...base, status: aggregateStatus(lines), lines, reasons, inputsMissing: missing };
}
