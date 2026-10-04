// L1.E2: reasonableness ratios (plan section 5.3). A handful of ratios that are almost never outside a normal range; when one
// is, the return deserves a second look. Heuristics only (thresholds.ts): severity is medium at most, the citation kind is
// "heuristic", and the finding says so. A ratio is evaluated only when both of its lines carry an amount.

import { makeFinding, type Finding, type Severity } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { lineState, lineTitle, usd } from "@/lib/tax-review/l1/helpers";
import { THRESHOLDS } from "@/lib/tax-review/l1/thresholds";
import type { LineKey } from "@/lib/tax2025/line-catalog";

const HEURISTIC = { sources: [{ kind: "heuristic" as const, id: "l1/thresholds" }], sourceStatus: "not_applicable" as const };

interface RatioSpec {
  id: string;
  num: LineKey;
  den: LineKey;
  /** The ratio is flagged when num / den > limit. */
  limit: number;
  severity: Severity;
  area: "income" | "tax" | "deductions" | "payments" | "state";
  describe: string;
  /** Only when the denominator is above this many dollars (a tiny base gives a meaningless ratio). */
  minDen: number;
}

const RATIOS: readonly RatioSpec[] = [
  { id: "effective-rate", num: "f1040.24", den: "f1040.9", limit: THRESHOLDS.effectiveRateHigh, severity: "medium", area: "tax", describe: "total tax as a share of total income", minDen: 1000 },
  { id: "se-ratio", num: "se.12", den: "schc.31", limit: THRESHOLDS.seTaxRatioHigh, severity: "medium", area: "tax", describe: "self-employment tax as a share of Schedule C net profit", minDen: 1000 },
  { id: "expense-ratio", num: "schc.28", den: "schc.7", limit: THRESHOLDS.schCExpenseRatioHigh, severity: "medium", area: "income", describe: "Schedule C expenses as a share of its gross income", minDen: 1000 },
  { id: "meals-ratio", num: "schc.24b", den: "schc.7", limit: THRESHOLDS.mealsRatioHigh, severity: "low", area: "income", describe: "deductible meals as a share of Schedule C gross income", minDen: 1000 },
  { id: "charity-ratio", num: "scha.14", den: "f1040.11a", limit: THRESHOLDS.charityRatioHigh, severity: "medium", area: "deductions", describe: "gifts to charity as a share of adjusted gross income", minDen: 1000 },
  { id: "withholding-ratio", num: "f1040.25d", den: "f1040.24", limit: THRESHOLDS.withholdingMultipleHigh, severity: "low", area: "payments", describe: "federal withholding as a multiple of total tax", minDen: 1000 },
  { id: "ct-ratio", num: "ct1040.6", den: "f1040.11a", limit: THRESHOLDS.ctTaxToAgiHigh, severity: "medium", area: "state", describe: "Connecticut income tax as a share of federal adjusted gross income", minDen: 1000 },
  { id: "niit-ratio", num: "f8960.niit", den: "f8960.nii", limit: THRESHOLDS.niitRatioHigh, severity: "medium", area: "tax", describe: "net investment income tax as a share of net investment income", minDen: 1 },
];

export const reasonablenessCheck: L1Check = {
  id: "L1.E2",
  description: "Reasonableness ratios (effective rate, SE tax, expenses, meals, charity, withholding, CT tax, NIIT)",
  run(ctx: L1Context): Finding[] {
    const out: Finding[] = [];
    for (const r of RATIOS) {
      const n = lineState(ctx, r.num).amount;
      const d = lineState(ctx, r.den).amount;
      if (n === null || d === null || d < r.minDen || n < 0) continue;
      const ratio = n / d;
      if (ratio <= r.limit) continue;
      out.push(
        makeFinding({
          layer: "L1",
          check: `L1.E2.${r.id}`,
          severity: r.severity,
          area: r.area,
          lineKey: r.num,
          message: `${lineTitle(r.num)} is ${usd(n)}, which is ${(ratio * 100).toFixed(1)}% of ${lineTitle(r.den)} (${usd(d)}): ${r.describe}. This review asks you to look again above ${(r.limit * 100).toFixed(1)}%. It is a heuristic, not a rule of law.`,
          evidence: [{ ref: r.num, amount: n, status: "computed" }, { ref: r.den, amount: d, status: "computed" }],
          citation: HEURISTIC,
          recommendedAction: "Check the inputs behind both lines. If the ratio is right for your year, accept this finding with the reason.",
          acceptable: true,
        })
      );
    }
    // itemized vs standard: a close call
    const std = lineState(ctx, "std.total").amount;
    const item = lineState(ctx, "scha.17").amount;
    if (std !== null && item !== null && std > 0 && item > 0) {
      const margin = Math.abs(item - std) / std;
      if (margin < THRESHOLDS.itemizeMarginClose) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.E2.itemize-margin",
            severity: "low",
            area: "deductions",
            lineKey: "scha.17",
            message: `Itemized deductions (${usd(item)}) and the standard deduction (${usd(std)}) are within ${(THRESHOLDS.itemizeMarginClose * 100).toFixed(0)}% of each other, so a small error in either choice flips which one the return uses.`,
            evidence: [{ ref: "scha.17", amount: item, status: "computed" }, { ref: "std.total", amount: std, status: "computed" }],
            citation: HEURISTIC,
            recommendedAction: "Double-check the largest itemized amounts (property tax, mortgage interest, gifts).",
            acceptable: true,
          })
        );
      }
    }
    return out;
  },
};
