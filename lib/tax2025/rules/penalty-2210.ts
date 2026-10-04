// Form 2210 underpayment of estimated tax: a REGULAR-METHOD ESTIMATE, informational.
//
// The IRS figures this penalty itself and bills it; Form 2210 is only attached to
// request a waiver or to use the annualized income / actual-withholding-dates
// methods (the 2025 Form 2210 and its instructions, verified 2026-10-03). So the
// result is flagged `informational`: when an input is missing it is an advisory open
// item, never blocking, and the estimate is never a number the return depends on.
//
// Part I (required annual payment), per the form and instructions:
//   line 1 = Form 1040 line 22; line 2 = the listed Schedule 2 lines (self-employment
//   tax, Additional Medicare Tax, net investment income tax ...); line 3 = refundable
//   credits (shown as a deduction); line 4 = 1 + 2 - 3; if line 4 is under $1,000 no
//   penalty. line 5 = 90% of line 4. line 6 = withholding (Form 1040 line 25d plus
//   Schedule 3 line 11); line 7 = 4 - 6, under $1,000 no penalty. line 8 = the prior
//   year's tax (100%, or 110% when the prior-year AGI is more than $150,000);
//   line 9 = the smaller of line 5 and line 8; line 6 at least line 9: no penalty.
// Prior-year tax (instructions, line 8) is Form 1040 line 22 plus Schedule 2 lines 4,
// 17e-17j, 17l, 17z, 19, minus refundable credits; it does NOT include the 2024
// Additional Medicare Tax or net investment income tax. The extracted figure is the
// 2024 TOTAL TAX (line 24), so it equals the instruction's figure only when the 2024
// return had none of those items: the owner answers that, and a "yes" / "not sure"
// is needs_cpa_judgment.
// Part III (regular method): each of the four installments is 25% of line 9; withholding
// is treated as paid one quarter on each due date (instructions, line 11); a 2024
// overpayment applied is treated as paid April 15, 2025; estimated payments are
// applied in date order, first to the oldest unpaid installment; the penalty is the
// underpayment x days / 365 x the rate (7% in every 2025 rate period) from each due
// date until the date it is paid or April 15, 2026 (rate period 4 ends there).
// Estimated payments carry the date the owner gave (the questionnaire records the
// payment window: each window's due date, or December 31, 2025 / January 15, 2026
// for the last two). Payments made after January 15, 2026 are not Form 2210 payments.
// Not modeled: the annualized income method (box C), actual withholding dates (box D),
// waivers (boxes A, B), box E (joint return in only one of the two years: a prior
// filing status other than joint is needs_cpa_judgment).
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import type { Ans } from "@/lib/tax2025/answer-state";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, minD, roundLine } from "@/lib/tax2025/money";
import { aggregateStatus, type RuleLine, type RuleResult, type RuleStatus } from "@/lib/tax2025/types";

export interface Payment2210 {
  /** YYYY-MM-DD */
  paidOn: string;
  amount: Decimal;
}

export interface Penalty2210Input {
  /** Form 1040 line 22. */
  line1: Decimal | null;
  /** The Schedule 2 lines named by Form 2210 line 2. */
  line2: Decimal | null;
  /** Refundable credits named by Form 2210 line 3. */
  line3: Decimal | null;
  /** Form 1040 line 25d plus Schedule 3 line 11. */
  line6: Decimal | null;
  prior: {
    totalTax: Decimal | null;
    agi: Decimal | null;
    /** Filing status printed on the 2024 return ("mfj", ...), when read. */
    filingStatus: string | null;
    filedJoint: Ans<boolean>;
    hadExcludedTaxOrRefundable: Ans<boolean>;
  };
  /** Estimated payments applying to 2025 (federal); null = not answered. */
  estimates: Payment2210[] | null;
  /** 2024 overpayment applied to 2025 (treated as paid on the first due date); null = not answered. */
  priorYearOverpaymentApplied: Decimal | null;
}

type Blocked = Exclude<RuleStatus, "computed" | "not_applicable">;

const CITES = [
  "SAFE_HARBOR_CURRENT_YEAR_FRACTION",
  "SAFE_HARBOR_PRIOR_YEAR_FRACTION",
  "SAFE_HARBOR_PRIOR_YEAR_HIGH_AGI_FRACTION",
  "SAFE_HARBOR_HIGH_AGI_THRESHOLD",
  "UNDERPAYMENT_NO_PENALTY_BELOW",
  "FORM_2210_DUE_DATES",
  "FORM_2210_PENALTY_END",
  "FORM_2210_RATE_PERIODS",
  "FORM_2210_DAYS_IN_YEAR",
  "FORM_2210_INSTALLMENT_FRACTION",
  "FORM_2210_LINE2_SCH2_LINES",
  "FORM_2210_LINE3_LINES",
  "FORM_2210_PRIOR_YEAR_TAX_NOTE",
];

const EST_NOTE = "The IRS figures this penalty itself (leave Form 1040 line 38 blank to let it); this is a regular-method estimate. The annualized income and actual-withholding-dates methods can lower it.";

/** Whole days since 1970-01-01 (UTC) for a YYYY-MM-DD string. */
export function dayNumber(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`Bad date ${iso}`);
  // UTC midnights are exact multiples of 86,400,000 ms, so the quotient is already an integer
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

/** Penalty (before rounding) on `amount` unpaid from `fromIso` (exclusive) through `toIso` (inclusive), by rate period. */
export function penaltyForPeriod(amount: Decimal, fromIso: string, toIso: string): Decimal {
  const from = dayNumber(fromIso);
  const to = dayNumber(toIso);
  let total = ZERO;
  for (const rp of K.FORM_2210_RATE_PERIODS.value) {
    const startDay = dayNumber(rp.start) - 1; // period covers days after (start - 1) through end
    const endDay = dayNumber(rp.end);
    const days = Math.max(0, Math.min(to, endDay) - Math.max(from, startDay));
    // one final division (amount x days x percent / (365 x 100)) so exact cases stay exact
    if (days > 0) total = total.plus(amount.times(days).times(rp.ratePercent).div(D(K.FORM_2210_DAYS_IN_YEAR.value).times(100)));
  }
  return total;
}

interface OpenUnder {
  due: string;
  remaining: Decimal;
}

/**
 * Part III Section A + the penalty worksheet. `installments` is the 4 due dates in
 * order; `payments` are dated payments (withholding already split by quarter).
 * Returns the unrounded penalty and the unpaid amounts per installment.
 */
export function figurePenalty(requiredInstallment: Decimal, payments: Payment2210[], dueDates: readonly string[], endIso: string): { penalty: Decimal; underpayments: Decimal[] } {
  const open: OpenUnder[] = [];
  const underpayments: Decimal[] = [];
  let penalty = ZERO;
  let carry = ZERO; // overpayment carried forward (line 18 -> line 12)
  for (let k = 0; k < dueDates.length; k++) {
    const due = dueDates[k] as string;
    const prevDue = k === 0 ? null : (dueDates[k - 1] as string);
    const inWindow = payments
      .filter((p) => dayNumber(p.paidOn) <= dayNumber(due) && (prevDue === null || dayNumber(p.paidOn) > dayNumber(prevDue)))
      .sort((a, b) => dayNumber(a.paidOn) - dayNumber(b.paidOn));
    let pool = carry;
    for (const pay of inWindow) {
      let left = pay.amount;
      for (const u of open) {
        if (left.lessThanOrEqualTo(0)) break;
        if (u.remaining.lessThanOrEqualTo(0)) continue;
        const applied = minD(left, u.remaining);
        penalty = penalty.plus(penaltyForPeriod(applied, u.due, pay.paidOn));
        u.remaining = u.remaining.minus(applied);
        left = left.minus(applied);
      }
      pool = pool.plus(left);
    }
    if (pool.greaterThanOrEqualTo(requiredInstallment)) {
      carry = pool.minus(requiredInstallment);
      underpayments.push(ZERO);
    } else {
      carry = ZERO;
      const under = requiredInstallment.minus(pool);
      open.push({ due, remaining: under });
      underpayments.push(under);
    }
  }
  for (const u of open) if (u.remaining.greaterThan(0)) penalty = penalty.plus(penaltyForPeriod(u.remaining, u.due, endIso));
  return { penalty, underpayments };
}

export function computePenalty2210(input: Penalty2210Input): RuleResult {
  const base = { ruleId: "penalty-2210-estimate", form: "Form 2210", citations: CITES, inputsUsed: [], informational: true as const };
  const lines: RuleLine[] = [];
  const reasons: string[] = [EST_NOTE];
  const stopAll = (status: Blocked, reason: string, missing: string): RuleResult => {
    const out: RuleLine[] = [...lines];
    if (!out.some((l) => l.key === "f2210.19")) out.push(blockedLine("f2210.19", "Estimated penalty (regular method estimate)", "19", status, reason));
    return { ...base, status, lines: out, reasons: [reason, ...reasons], inputsMissing: [missing] };
  };
  const noPenalty = (why: string): RuleResult => {
    const fill = (key: RuleLine["key"], label: string, n: string): void => {
      if (!lines.some((l) => l.key === key)) lines.push(amountLine(key, label, n, ZERO, "not_applicable", "Not needed: no penalty applies."));
    };
    fill("f2210.5", "90% of the current year tax", "5");
    fill("f2210.6", "Withholding taxes", "6");
    fill("f2210.7", "Current year tax minus withholding", "7");
    fill("f2210.8", "Maximum required annual payment based on the prior year's tax", "8");
    fill("f2210.9", "Required annual payment", "9");
    lines.push(amountLine("f2210.19", "Estimated penalty (regular method estimate)", "19", ZERO, "computed", `No underpayment penalty: ${why}`));
    return { ...base, status: aggregateStatus(lines, "computed"), lines, reasons: [`No underpayment penalty: ${why}`, ...reasons], inputsMissing: [] };
  };

  // Part I
  if (input.line1 === null || input.line2 === null || input.line3 === null) {
    return stopAll("missing_input", "The Form 2210 estimate waits for Form 1040 line 22, the Schedule 2 taxes and the refundable credits, which are not all computed yet.", "Form 1040 line 22 / Schedule 2 / refundable credits");
  }
  const line4 = input.line1.plus(input.line2).minus(input.line3);
  lines.push(amountLine("f2210.4", "Current year tax", "4", line4, "computed", `Line 1 ${fmt(input.line1)} + other taxes ${fmt(input.line2)} - refundable credits ${fmt(input.line3)}.`));
  const below = D(K.UNDERPAYMENT_NO_PENALTY_BELOW.value);
  if (line4.lessThan(below)) return noPenalty(`current year tax ${fmt(line4)} is under ${fmt(below)}.`);
  const line5 = line4.times(D(K.SAFE_HARBOR_CURRENT_YEAR_FRACTION.value));
  lines.push(amountLine("f2210.5", "90% of the current year tax", "5", line5, "computed"));
  if (input.line6 === null) return stopAll("missing_input", "Withholding (Form 1040 line 25d plus Schedule 3 line 11) is not computed yet.", "Form 1040 line 25d");
  const line6 = input.line6;
  lines.push(amountLine("f2210.6", "Withholding taxes", "6", line6, "computed"));
  const line7 = line4.minus(line6);
  lines.push(amountLine("f2210.7", "Current year tax minus withholding", "7", line7, "computed"));
  if (line7.lessThan(below)) return noPenalty(`the tax after withholding, ${fmt(line7)}, is under ${fmt(below)}.`);

  // Line 8: the prior year
  const pr = input.prior;
  const joint = pr.filedJoint;
  if (joint.state === "unsure") return stopAll("needs_cpa_judgment", "The owner is not sure whether the 2024 return was a joint return (Form 2210 box E / combined 2024 tax); the CPA decides.", "2024 filing status");
  if (joint.state === "answered" && joint.value === false) return stopAll("needs_cpa_judgment", "The 2024 return was not a joint return: line 8 combines both spouses' 2024 tax and box E may apply; the CPA figures it.", "2024 filing status");
  if (joint.state === "missing" && pr.filingStatus !== null && pr.filingStatus !== "mfj") {
    return stopAll("needs_cpa_judgment", `The 2024 return shows filing status "${pr.filingStatus}", not joint: line 8 and box E are the CPA's.`, "2024 filing status");
  }
  if (pr.hadExcludedTaxOrRefundable.state === "missing") return stopAll("missing_input", "Whether the 2024 return had Additional Medicare Tax, net investment income tax or a refundable credit has not been answered (they change the 2024 tax used on line 8).", "2024 return: Additional Medicare Tax / NIIT / refundable credits");
  if (pr.hadExcludedTaxOrRefundable.state === "unsure" || (pr.hadExcludedTaxOrRefundable.state === "answered" && pr.hadExcludedTaxOrRefundable.value)) {
    return stopAll("needs_cpa_judgment", "The 2024 return had (or may have had) Additional Medicare Tax, net investment income tax or a refundable credit: the instruction's 2024 tax cannot be read from the extracted total tax; the CPA figures line 8.", "2024 tax for Form 2210 line 8");
  }
  if (pr.totalTax === null || pr.agi === null) {
    return stopAll("missing_input", "The 2024 total tax and AGI are not available (upload the 2024 federal return and confirm its extraction): the prior-year safe harbor cannot be figured.", "2024 total tax and AGI");
  }
  const high = pr.agi.greaterThan(K.SAFE_HARBOR_HIGH_AGI_THRESHOLD.value);
  const fraction = D(high ? K.SAFE_HARBOR_PRIOR_YEAR_HIGH_AGI_FRACTION.value : K.SAFE_HARBOR_PRIOR_YEAR_FRACTION.value);
  const line8 = pr.totalTax.times(fraction);
  lines.push(amountLine("f2210.8", "Maximum required annual payment based on the prior year's tax", "8", line8, "computed", `2024 tax ${fmt(pr.totalTax)} x ${fraction.times(100).toString()}% (2024 AGI ${fmt(pr.agi)} ${high ? "is over" : "is not over"} the high-income threshold).`));
  const line9 = minD(line5, line8);
  lines.push(amountLine("f2210.9", "Required annual payment", "9", line9, "computed", `Smaller of line 5 (${fmt(line5)}) and line 8 (${fmt(line8)}).`));
  if (line6.greaterThanOrEqualTo(line9)) return noPenalty(`withholding ${fmt(line6)} is at least the required annual payment ${fmt(line9)}.`);

  // Part III
  if (input.estimates === null) return stopAll("missing_input", "Federal estimated payments (dates and amounts) have not been answered, so the penalty cannot be estimated.", "federal estimated payments");
  if (input.priorYearOverpaymentApplied === null) return stopAll("missing_input", "The 2024 overpayment applied to 2025 has not been answered.", "2024 overpayment applied");
  const due = K.FORM_2210_DUE_DATES.value;
  const quarterly = line6.div(due.length);
  const payments: Payment2210[] = due.map((d) => ({ paidOn: d, amount: quarterly }));
  if (input.priorYearOverpaymentApplied.greaterThan(0)) payments.push({ paidOn: due[0] as string, amount: input.priorYearOverpaymentApplied });
  let ignored = ZERO;
  for (const e of input.estimates) {
    if (dayNumber(e.paidOn) > dayNumber(due[due.length - 1] as string)) ignored = ignored.plus(e.amount);
    else payments.push(e);
  }
  const required = line9.times(D(K.FORM_2210_INSTALLMENT_FRACTION.value));
  const { penalty, underpayments } = figurePenalty(required, payments, due, K.FORM_2210_PENALTY_END.value);
  const rounded = roundLine(penalty);
  const tags = underpayments.map((u, i) => `installment ${i + 1} (due ${due[i]}) underpaid ${fmt(u)}`).join("; ");
  lines.push(amountLine("f2210.19", "Estimated penalty (regular method estimate)", "19", penalty, "computed", `Estimated ${fmt(rounded)} through ${K.FORM_2210_PENALTY_END.value}: required installments ${fmt(required)} each; ${tags}.`));
  reasons.unshift(`Estimated underpayment penalty ${fmt(rounded)} (regular method): required annual payment ${fmt(line9)}, withholding treated as paid evenly on the due dates.`);
  if (ignored.greaterThan(0)) reasons.push(`${fmt(ignored)} of estimated payments were dated after ${due[due.length - 1]} and are not Form 2210 payments.`);
  return { ...base, status: "computed", lines, reasons, inputsMissing: [] };
}

