// Connecticut Form CT-1040 pieces for TY2025, MFJ: CT AGI, CT income tax (TCS
// Tables A-E via lib/tax-compute.ts, Table C corrected, defect D7), the CT AMT
// trigger, the property tax credit, use tax, late-payment items and the balance.
//
// What is NOT guessed (specs/09 "Not verified"):
//   - CT AGI up to $102,000: the instructions send the filer to the printed CT tax
//     table, which is not transcribed; the TCS figure is shown in the reason only
//     -> needs_cpa_rule_unverified. CT AGI of $24,000 or less (MFJ): no tax (verified).
//   - CT-6251 (CT AMT) when there is a federal AMT -> needs_cpa_rule_unverified.
//   - The CT late-payment minimum and month-counting rules -> informational,
//     needs_cpa_rule_unverified (the 10% and 1%/month rates are verified).
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
import { aggregateStatus, type LineKey, type RuleLine, type RuleResult } from "@/lib/tax2025/types";

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

export function computeCtPropertyTaxCredit(input: CtPropertyTaxCreditInput): RuleResult {
  const base = { ruleId: "ct-property-tax-credit", form: "CT-1040 Schedule 3", citations: CREDIT_CITATIONS, inputsUsed: [] };
  const label = "Property tax credit";
  if (input.ctAgi === null) {
    const reason = "CT AGI is not available, so the property tax credit phase-out cannot be applied.";
    return {
      ...base,
      status: "missing_input",
      lines: [blockedLine("ct1040.11", label, "11", "missing_input", reason)],
      reasons: [reason],
      inputsMissing: ["CT AGI"],
    };
  }
  const ctAgi = roundLine(input.ctAgi);
  const decimal = ctPropertyTaxPhaseOutDecimal(ctAgi);
  if (decimal.greaterThanOrEqualTo(1)) {
    return {
      ...base,
      status: "computed",
      conclusion: "ineligible",
      lines: [amountLine("ct1040.11", label, "11", ZERO)],
      reasons: [
        `No property tax credit: CT AGI ${fmt(ctAgi)} is above ${fmt(D(fullyPhasedOutAbove()))}, where the credit is fully phased out (decimal 1.00).`,
      ],
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
    const reason = `The property tax credit cannot be figured until you ${parts.join(" and ")}.`;
    return {
      ...base,
      status: "missing_input",
      lines: [blockedLine("ct1040.11", label, "11", "missing_input", reason)],
      reasons: [reason],
      inputsMissing: ["property tax bill classification / paid amounts"],
    };
  }
  const primary = input.bills.filter((b) => b.kind === "primary_residence").map((b) => b.paid ?? ZERO);
  const vehicles = input.bills
    .filter((b) => b.kind === "motor_vehicle")
    .map((b) => b.paid ?? ZERO)
    .sort((a, b) => b.comparedTo(a))
    .slice(0, K.CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ.value);
  const excluded = input.bills.filter((b) => b.kind === "other_real_estate" || b.kind === "other_personal_property");
  const qualifying = sumThenRound([...primary, ...vehicles]);
  const tentative = minD(qualifying, D(K.CT_PROPERTY_TAX_CREDIT_MAX.value));
  let credit = roundLine(tentative.times(D(1).minus(decimal)));
  const reasons: string[] = [
    `Qualifying property tax paid in 2025 ${fmt(qualifying)} (primary residence + up to ${K.CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ.value} motor vehicles); tentative credit ${fmt(tentative)}; CT AGI ${fmt(ctAgi)} phase-out decimal ${decimal.toString()}.`,
  ];
  if (excluded.length > 0) {
    reasons.push(`Excluded from the credit (not a primary residence or motor vehicle): ${excluded.map((b) => b.label).join(", ")}.`);
  }
  if (input.ctTaxBeforeCredits === null) {
    const reason = "The credit cannot exceed the CT income tax (line 10), which is not available yet.";
    return {
      ...base,
      status: "missing_input",
      lines: [blockedLine("ct1040.11", label, "11", "missing_input", reason)],
      reasons: [...reasons, reason],
      inputsMissing: ["CT income tax (line 10)"],
    };
  }
  if (credit.greaterThan(input.ctTaxBeforeCredits)) {
    credit = maxD(ZERO, roundLine(input.ctTaxBeforeCredits));
    reasons.push(`Limited to the CT income tax of ${fmt(credit)} (the credit is not refundable).`);
  }
  return {
    ...base,
    status: "computed",
    conclusion: credit.isZero() ? "ineligible" : decimal.isZero() ? "eligible" : "partial",
    lines: [amountLine("ct1040.11", label, "11", credit)],
    reasons,
    inputsMissing: [],
  };
}

// ── CT AGI, tax, AMT trigger, balance ────────────────────────────────────────

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
  /** A W-2 shows withholding for a state other than CT (credit for taxes paid to other jurisdictions would be needed). */
  otherStateWithholdingPresent: boolean;
}

const CT_TAX_CITATIONS = ["CT_TAX_TABLE_AGI_LIMIT", "CT_ZERO_TAX_AGI_MFJ", "CT_TABLE_C"];

export function computeCtTax(input: CtTaxInput): RuleResult {
  const base = { ruleId: "ct-tax", form: "CT-1040", citations: CT_TAX_CITATIONS, inputsUsed: [] };
  const lines: RuleLine[] = [];
  const reasons: string[] = [];
  const missing: string[] = [];
  const miss = (key: LineKey, lbl: string, formLine: string, reason: string) =>
    blockedLine(key, lbl, formLine, "missing_input", reason);

  if (input.federalAgi === null) {
    const reason = "Federal AGI is not available.";
    lines.push(
      miss("ct1040.1", "Federal adjusted gross income (1040 line 11a)", "1", reason),
      miss("ct1040.ctAgi", "Connecticut adjusted gross income", "CT AGI", reason),
      miss("ct1040.6", "Connecticut income tax", "6", reason),
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
      blockedLine("ct1040.ctAgi", "Connecticut adjusted gross income", "CT AGI", status, reason),
      blockedLine("ct1040.6", "Connecticut income tax", "6", status, "CT AGI is not final until the Schedule 1 modifications are computed."),
      blockedLine("ct1040.9", "Connecticut alternative minimum tax", "9", status, "CT AGI is not final."),
      blockedLine("ct1040.10", "Connecticut income tax before credits", "10", status, "CT AGI is not final.")
    );
    return { ...base, status, lines, reasons: [reason], inputsMissing: ["CT Schedule 1 modifications"] };
  }
  const additions = roundLine(input.additions!);
  const subtractions = roundLine(input.subtractions!);
  const ctAgi = fedAgi.plus(additions).minus(subtractions);
  lines.push(
    amountLine("ct1040.additions", "CT Schedule 1 additions", "Sch 1", additions),
    amountLine("ct1040.subtractions", "CT Schedule 1 subtractions", "Sch 1", subtractions),
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

  // Line 10
  if (input.otherStateWithholdingPresent) {
    lines.push(
      blockedLine(
        "ct1040.10",
        "Connecticut income tax before credits",
        "10",
        "needs_cpa_judgment",
        "A W-2 shows withholding for a state other than Connecticut: a credit for taxes paid to another jurisdiction may apply and is not modeled."
      )
    );
  } else if (tax !== null && amtLine !== null) {
    lines.push(amountLine("ct1040.10", "Connecticut income tax before credits", "10", tax.plus(amtLine)));
  } else {
    const line6Status = lines.find((l) => l.key === "ct1040.6")?.status;
    const status = tax === null && line6Status === "needs_cpa_rule_unverified" ? "needs_cpa_rule_unverified" : "missing_input";
    lines.push(blockedLine("ct1040.10", "Connecticut income tax before credits", "10", status, "Line 6 or line 9 is not computed."));
  }

  return { ...base, status: aggregateStatus(lines), lines, reasons, inputsMissing: missing };
}

export interface CtBalanceInput {
  /** CT-1040 line 10; null = not computed. */
  taxBeforeCredits: Decimal | null;
  /** CT-1040 line 11 credit; null = not computed. */
  propertyTaxCredit: Decimal | null;
  /** CT-1040 line 15 use tax; null = not answered. */
  useTax: Decimal | null;
  /** Plain-language "why" printed on line 15 when it has an amount (the rule or statement it came from). */
  useTaxReason?: string;
  /** When useTax is null: why (a "not sure" or an uncomputed rate is needs_cpa_judgment, not missing_input). */
  useTaxBlock?: { status: "missing_input" | "needs_cpa_judgment"; reason: string };
  /** Lines 18 + 19 + 20; null = not computed. */
  totalPayments: Decimal | null;
}

export function computeCtBalance(input: CtBalanceInput): RuleResult {
  const base = { ruleId: "ct-balance", form: "CT-1040", citations: ["CT_LATE_PAYMENT_PENALTY_RATE", "CT_INTEREST_RATE_PER_MONTH"], inputsUsed: [] };
  const lines: RuleLine[] = [];
  const missing: string[] = [];

  if (input.useTax === null) {
    lines.push(
      blockedLine(
        "ct1040.15",
        "Use tax (out-of-state purchases)",
        "15",
        input.useTaxBlock?.status ?? "missing_input",
        input.useTaxBlock?.reason ?? "Line 15 must be answered with 0 or an amount: say whether any 2025 out-of-state purchases were made without Connecticut sales tax."
      )
    );
    missing.push("CT use tax answer");
  } else {
    lines.push(amountLine("ct1040.15", "Use tax (out-of-state purchases)", "15", roundLine(input.useTax), "computed", input.useTaxReason ?? "Stated by the owner / CPA."));
  }
  const informational =
    "Informational: the late-payment penalty rate (10%) and interest (1% per month) are verified, but the minimum penalty, the months to count and how the extension payment is treated are not, so no amount is estimated.";
  lines.push(
    { ...blockedLine("ct1040.27", "Late payment penalty", "27", "needs_cpa_rule_unverified", informational), informational: true },
    { ...blockedLine("ct1040.28", "Interest", "28", "needs_cpa_rule_unverified", informational), informational: true }
  );

  if (input.taxBeforeCredits !== null && input.propertyTaxCredit !== null && input.useTax !== null && input.totalPayments !== null) {
    const net = input.taxBeforeCredits.minus(input.propertyTaxCredit).plus(roundLine(input.useTax));
    const balance = net.minus(input.totalPayments);
    lines.push(
      amountLine(
        "ct1040.balance",
        "Connecticut balance due (positive) or overpayment (negative), before any penalty and interest",
        "balance",
        balance
      )
    );
    return {
      ...base,
      status: aggregateStatus(lines),
      lines,
      reasons: [
        `CT tax before credits ${fmt(input.taxBeforeCredits)} - property tax credit ${fmt(input.propertyTaxCredit)} + use tax ${fmt(roundLine(input.useTax))} - payments ${fmt(input.totalPayments)} = ${fmt(balance)} (positive = balance due), before penalty and interest.`,
      ],
      inputsMissing: missing,
    };
  }
  const notFinal = "A CT tax, credit, use tax or payment line is not computed (see the CT AGI / Schedule 1, property tax credit, use tax and payment items).";
  lines.push(blockedLine("ct1040.balance", "Connecticut balance due or overpayment", "balance", "missing_input", notFinal));
  return { ...base, status: aggregateStatus(lines), lines, reasons: [notFinal], inputsMissing: missing };
}
