// Schedule SE (self-employment tax) and Form 8959 (Additional Medicare Tax,
// including the Part V withholding reconciliation) for TY2025, MFJ.
//
// Pure: no DB, no Date.now(). Every constant comes from lib/tax2025/constants.ts
// (verified 2026-10-03; sources Schedule SE form + instructions, Form 8959
// instructions). Every line is rounded to whole dollars (roundLine) and later
// lines use the rounded values, as a filer who rounds does (1040 instructions,
// "Rounding Off to Whole Dollars": "if you round, round ALL amounts").
//
// Fixes defect D1: the Social Security wage base is reduced by the SE owner's own
// W-2 Social Security wages and tips (Schedule SE line 8a = W-2 boxes 3 + 7).

import type { Decimal } from "@prisma/client/runtime/library";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD, roundLine } from "@/lib/tax2025/money";
import { aggregateStatus, type LineKey, type RuleLine, type RuleResult } from "@/lib/tax2025/types";

// ── Schedule SE ───────────────────────────────────────────────────────────────

export interface ScheduleSeInput {
  /** Schedule C line 31 (whole dollars) of the SE owner; null = missing. */
  netProfit: Decimal | null;
  /** The SE owner's own W-2 boxes 3 + 7 (Schedule SE line 8a); null = unknown (W-2 not read / not attributed). */
  ssWagesAndTips: Decimal | null;
  /** For messages, e.g. "Eric". */
  ownerLabel?: string;
}

const SE_CITATIONS = [
  "SE_NET_EARNINGS_FACTOR",
  "SE_FLOOR",
  "SE_WAGE_BASE",
  "SE_OASDI_RATE",
  "SE_MEDICARE_RATE",
];

const SE_LINE_META: ReadonlyArray<{ key: LineKey; label: string; formLine: string }> = [
  { key: "se.3", label: "Net profit from Schedule C", formLine: "SE 3" },
  { key: "se.4a", label: "Net profit x 92.35%", formLine: "SE 4a" },
  { key: "se.4c", label: "Net earnings from self-employment", formLine: "SE 4c" },
  { key: "se.6", label: "Net earnings subject to SE tax", formLine: "SE 6" },
  { key: "se.7", label: "Maximum earnings subject to social security tax", formLine: "SE 7" },
  { key: "se.8a", label: "Social Security wages and tips (W-2 boxes 3 + 7)", formLine: "SE 8a" },
  { key: "se.9", label: "Remaining Social Security wage base", formLine: "SE 9" },
  { key: "se.10", label: "Social Security part (12.4%)", formLine: "SE 10" },
  { key: "se.11", label: "Medicare part (2.9%)", formLine: "SE 11" },
  { key: "se.12", label: "Self-employment tax", formLine: "SE 12" },
  { key: "se.13", label: "Deductible part of self-employment tax", formLine: "SE 13" },
  { key: "sch2.4", label: "Self-employment tax (to Schedule 2)", formLine: "Sch 2 line 4" },
  { key: "sch1.15", label: "Deductible part of self-employment tax", formLine: "Sch 1 line 15" },
];

function seBlocked(
  keys: readonly LineKey[],
  status: "missing_input" | "needs_cpa_judgment",
  reason: string
): RuleLine[] {
  return SE_LINE_META.filter((m) => keys.includes(m.key)).map((m) => blockedLine(m.key, m.label, m.formLine, status, reason));
}

export function computeScheduleSe(input: ScheduleSeInput): RuleResult {
  const owner = input.ownerLabel ?? "the Schedule C owner";
  const base: Omit<RuleResult, "status" | "lines" | "reasons" | "inputsMissing"> = {
    ruleId: "schedule-se",
    form: "Schedule SE",
    citations: SE_CITATIONS,
    inputsUsed: [],
  };

  if (input.netProfit === null) {
    const reason = "Schedule C net profit is not available (books not fully coded / Schedule C owner unknown).";
    const lines = seBlocked(SE_LINE_META.map((m) => m.key), "missing_input", reason);
    return { ...base, status: "missing_input", lines, reasons: [reason], inputsMissing: ["Schedule C net profit (line 31)"] };
  }

  const line3 = roundLine(input.netProfit);
  const line4a = line3.greaterThan(0) ? roundLine(line3.times(K.SE_NET_EARNINGS_FACTOR.value)) : line3;
  const line4c = line4a;
  const lines: RuleLine[] = [
    amountLine("se.3", "Net profit from Schedule C", "SE 3", line3),
    amountLine("se.4a", "Net profit x 92.35%", "SE 4a", line4a),
    amountLine("se.4c", "Net earnings from self-employment", "SE 4c", line4c),
  ];
  const reasons: string[] = [];

  if (line4c.lessThan(K.SE_FLOOR.value)) {
    const why = `Net earnings from self-employment are ${fmt(line4c)}, under the ${fmt(D(K.SE_FLOOR.value))} floor (Schedule SE line 4c): no self-employment tax.`;
    reasons.push(why);
    for (const m of SE_LINE_META) {
      if (["se.3", "se.4a", "se.4c"].includes(m.key)) continue;
      if (["se.12", "se.13", "sch2.4", "sch1.15"].includes(m.key)) {
        lines.push(amountLine(m.key, m.label, m.formLine, ZERO, "computed", why));
      } else {
        lines.push({ key: m.key, label: m.label, formLine: m.formLine, amount: ZERO, exact: ZERO, status: "not_applicable", reason: why });
      }
    }
    return { ...base, status: "computed", lines, reasons, inputsMissing: [] };
  }

  const line6 = line4c;
  lines.push(amountLine("se.6", "Net earnings subject to SE tax", "SE 6", line6));
  lines.push(amountLine("se.7", "Maximum earnings subject to social security tax", "SE 7", D(K.SE_WAGE_BASE.value)));
  const line11 = roundLine(line6.times(K.SE_MEDICARE_RATE.value));
  lines.push(amountLine("se.11", "Medicare part (2.9%)", "SE 11", line11));

  if (input.ssWagesAndTips === null) {
    const reason = `Social Security wages (W-2 boxes 3 + 7) for ${owner} are unknown, so the Social Security wage base left for self-employment income cannot be figured (Schedule SE line 8a).`;
    lines.push(
      ...seBlocked(["se.8a", "se.9", "se.10", "se.12", "se.13", "sch2.4", "sch1.15"], "missing_input", reason)
    );
    return {
      ...base,
      status: "missing_input",
      lines,
      reasons: [reason],
      inputsMissing: [`Social Security wages (W-2 box 3 + 7) of ${owner}`],
    };
  }

  const line8a = roundLine(input.ssWagesAndTips);
  const line9 = maxD(ZERO, D(K.SE_WAGE_BASE.value).minus(line8a));
  const line10 = line9.lessThanOrEqualTo(0)
    ? ZERO
    : roundLine(minD(line6, line9).times(K.SE_OASDI_RATE.value));
  const line12 = line10.plus(line11);
  const line13 = roundLine(line12.div(2));
  lines.push(
    amountLine("se.8a", "Social Security wages and tips (W-2 boxes 3 + 7)", "SE 8a", line8a),
    amountLine("se.9", "Remaining Social Security wage base", "SE 9", line9),
    amountLine("se.10", "Social Security part (12.4%)", "SE 10", line10),
    amountLine("se.12", "Self-employment tax", "SE 12", line12),
    amountLine("se.13", "Deductible part of self-employment tax", "SE 13", line13),
    amountLine("sch2.4", "Self-employment tax (to Schedule 2)", "Sch 2 line 4", line12),
    amountLine("sch1.15", "Deductible part of self-employment tax", "Sch 1 line 15", line13)
  );
  if (line9.lessThanOrEqualTo(0)) {
    reasons.push(
      `${owner}'s W-2 Social Security wages (${fmt(line8a)}) use up the ${fmt(D(K.SE_WAGE_BASE.value))} wage base: only the 2.9% Medicare part applies to the ${fmt(line6)} of net earnings.`
    );
  } else {
    reasons.push(
      `${owner}'s W-2 Social Security wages (${fmt(line8a)}) leave ${fmt(line9)} of the ${fmt(D(K.SE_WAGE_BASE.value))} wage base; Social Security tax applies to the smaller of net earnings (${fmt(line6)}) or that remainder.`
    );
  }
  return { ...base, status: aggregateStatus(lines), lines, reasons, inputsMissing: [] };
}

// ── Form 8959 ─────────────────────────────────────────────────────────────────

export interface Form8959Input {
  /** Sum of W-2 box 5 for BOTH spouses (MFJ, line 1); null = unknown. */
  medicareWages: Decimal | null;
  /** Largest single W-2 box 5, for the "must file" test; null when medicareWages is null. */
  largestBox5: Decimal | null;
  /** Sum of W-2 box 6; null = at least one W-2 did not read box 6. */
  medicareWithheld: Decimal | null;
  /** Schedule SE line 6 (net earnings), 0 when there is a loss or SE tax does not apply; null = SE not computable. */
  seNetEarnings: Decimal | null;
}

const F8959_CITATIONS = ["ADDL_MEDICARE_RATE", "ADDL_MEDICARE_THRESHOLD_MFJ", "ADDL_MEDICARE_W2_TRIGGER", "MEDICARE_EMPLOYEE_RATE"];

export function computeForm8959(input: Form8959Input): RuleResult {
  const base: Omit<RuleResult, "status" | "lines" | "reasons" | "inputsMissing"> = {
    ruleId: "addl-medicare-8959",
    form: "Form 8959",
    citations: F8959_CITATIONS,
    inputsUsed: [],
  };
  const labels = {
    tax: "Additional Medicare Tax (Form 8959 line 18, to Schedule 2 line 11)",
    credit: "Additional Medicare Tax withheld (Form 8959 line 24, to 1040 line 25c)",
  };

  if (input.medicareWages === null || input.largestBox5 === null) {
    const reason = "W-2 Medicare wages (box 5) are not available for every W-2, so Form 8959 cannot be figured.";
    return {
      ...base,
      status: "missing_input",
      lines: [
        blockedLine("f8959.18", labels.tax, "8959 line 18", "missing_input", reason),
        blockedLine("sch2.11", "Additional Medicare Tax", "Sch 2 line 11", "missing_input", reason),
        blockedLine("f8959.24", labels.credit, "8959 line 24", "missing_input", reason),
        blockedLine("f1040.25c", "Additional Medicare Tax withheld", "25c", "missing_input", reason),
      ],
      reasons: [reason],
      inputsMissing: ["W-2 Medicare wages (box 5)"],
    };
  }

  const line1 = roundLine(input.medicareWages);
  const line4 = line1; // unreported tips (Form 4137) and Form 8919 wages: none stated
  const threshold = D(K.ADDL_MEDICARE_THRESHOLD_MFJ.value);
  const line6 = maxD(ZERO, line4.minus(threshold));
  const line7 = roundLine(line6.times(K.ADDL_MEDICARE_RATE.value));

  // Part III needs the SE net earnings.
  if (input.seNetEarnings === null) {
    const reason = "Self-employment net earnings (Schedule SE line 6) are not available, so Part III cannot be figured.";
    return {
      ...base,
      status: "missing_input",
      lines: [
        amountLine("f8959.7", "Additional Medicare Tax on Medicare wages", "8959 line 7", line7),
        blockedLine("f8959.18", labels.tax, "8959 line 18", "missing_input", reason),
        blockedLine("sch2.11", "Additional Medicare Tax", "Sch 2 line 11", "missing_input", reason),
        blockedLine("f8959.24", labels.credit, "8959 line 24", "missing_input", reason),
        blockedLine("f1040.25c", "Additional Medicare Tax withheld", "25c", "missing_input", reason),
      ],
      reasons: [reason],
      inputsMissing: ["Schedule SE net earnings"],
    };
  }

  const line8 = maxD(ZERO, roundLine(input.seNetEarnings));
  const line10 = line4;
  const line11 = maxD(ZERO, threshold.minus(line10));
  const line12 = maxD(ZERO, line8.minus(line11));
  const line13 = roundLine(line12.times(K.ADDL_MEDICARE_RATE.value));
  const line18 = line7.plus(line13);

  const required =
    input.largestBox5.greaterThan(K.ADDL_MEDICARE_W2_TRIGGER.value) || line1.plus(line8).greaterThan(threshold);

  const reasons: string[] = [];
  if (!required) {
    const why = `Form 8959 is not required: no single W-2 box 5 is over ${fmt(D(K.ADDL_MEDICARE_W2_TRIGGER.value))} and wages plus self-employment earnings (${fmt(line1.plus(line8))}) do not exceed ${fmt(threshold)}.`;
    return {
      ...base,
      status: "not_applicable",
      lines: [
        { key: "f8959.18", label: labels.tax, formLine: "8959 line 18", amount: ZERO, exact: ZERO, status: "not_applicable", reason: why },
        { key: "sch2.11", label: "Additional Medicare Tax", formLine: "Sch 2 line 11", amount: ZERO, exact: ZERO, status: "not_applicable", reason: why },
        { key: "f8959.24", label: labels.credit, formLine: "8959 line 24", amount: ZERO, exact: ZERO, status: "not_applicable", reason: why },
        { key: "f1040.25c", label: "Additional Medicare Tax withheld", formLine: "25c", amount: ZERO, exact: ZERO, status: "not_applicable", reason: why },
      ],
      reasons: [why],
      inputsMissing: [],
    };
  }

  reasons.push(
    `Form 8959 is required (wages ${fmt(line1)} + self-employment earnings ${fmt(line8)}, threshold ${fmt(threshold)}; largest single W-2 box 5 ${fmt(input.largestBox5)}).`
  );

  const lines: RuleLine[] = [
    amountLine("f8959.1", "Medicare wages and tips (W-2 box 5)", "8959 line 1", line1),
    amountLine("f8959.4", "Total Medicare wages and tips", "8959 line 4", line4),
    amountLine("f8959.5", "Filing status threshold", "8959 line 5", threshold),
    amountLine("f8959.6", "Excess over the threshold", "8959 line 6", line6),
    amountLine("f8959.7", "Additional Medicare Tax on Medicare wages", "8959 line 7", line7),
    amountLine("f8959.8", "Self-employment income", "8959 line 8", line8),
    amountLine("f8959.9", "Filing status threshold", "8959 line 9", threshold),
    amountLine("f8959.10", "Amount from line 4", "8959 line 10", line10),
    amountLine("f8959.11", "Threshold remaining after wages", "8959 line 11", line11),
    amountLine("f8959.12", "Self-employment income over the remaining threshold", "8959 line 12", line12),
    amountLine("f8959.13", "Additional Medicare Tax on self-employment income", "8959 line 13", line13),
    amountLine("f8959.18", labels.tax, "8959 line 18", line18),
    amountLine("sch2.11", "Additional Medicare Tax", "Sch 2 line 11", line18),
  ];

  // Part V: withholding reconciliation.
  if (input.medicareWithheld === null) {
    const reason = "W-2 Medicare tax withheld (box 6) is not available for every W-2, so the Part V reconciliation cannot be figured.";
    lines.push(
      blockedLine("f8959.24", labels.credit, "8959 line 24", "missing_input", reason),
      blockedLine("f1040.25c", "Additional Medicare Tax withheld", "25c", "missing_input", reason)
    );
    reasons.push(reason);
    return { ...base, status: "missing_input", lines, reasons, inputsMissing: ["W-2 Medicare tax withheld (box 6)"] };
  }
  const line19 = roundLine(input.medicareWithheld);
  const line20 = line1;
  const line21 = roundLine(line20.times(K.MEDICARE_EMPLOYEE_RATE.value));
  const line22 = maxD(ZERO, line19.minus(line21));
  lines.push(
    amountLine("f8959.19", "Medicare tax withheld (W-2 box 6)", "8959 line 19", line19),
    amountLine("f8959.20", "Medicare wages and tips (from line 1)", "8959 line 20", line20),
    amountLine("f8959.21", "Regular Medicare tax withholding (1.45% of line 20)", "8959 line 21", line21),
    amountLine("f8959.22", "Additional Medicare Tax withheld (line 19 minus 1.45% of wages)", "8959 line 22", line22),
    amountLine("f8959.24", labels.credit, "8959 line 24", line22),
    amountLine("f1040.25c", "Additional Medicare Tax withheld", "25c", line22)
  );
  reasons.push(
    `Part V: Medicare tax withheld ${fmt(line19)} minus 1.45% of Medicare wages (${fmt(line21)}) = ${fmt(line22)} of Additional Medicare Tax withheld, credited on 1040 line 25c.`
  );
  return { ...base, status: aggregateStatus(lines), lines, reasons, inputsMissing: [] };
}
