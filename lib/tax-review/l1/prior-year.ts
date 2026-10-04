// L1.E1: comparison with the 2024 return (plan section 5.3). Uses only what is verified to exist: the 2024 return document's
// extraction carries the filing status, AGI and total tax (facts.priorYear). Anything richer (wages, Schedule C, itemized
// deductions, carryovers) needs a richer 2024 extraction and is NOT checked here; the findings say so.
//   - the filing status is unchanged (or the change is explained);
//   - AGI and total tax moved by no more than the (heuristic) thresholds, or the move is explained.
// Medium at most, never a blocker: a large change can be perfectly right (a new business, a sale), and the owner explains it by
// accepting the finding with a written reason. The thresholds are heuristics, not law.

import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { lineState, usd } from "@/lib/tax-review/l1/helpers";
import { THRESHOLDS } from "@/lib/tax-review/l1/thresholds";

const HEURISTIC = { sources: [{ kind: "heuristic" as const, id: "l1/thresholds" }], sourceStatus: "not_applicable" as const };

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export const priorYearCheck: L1Check = {
  id: "L1.E1",
  description: "Comparison with the 2024 return: filing status, AGI and total tax (heuristic thresholds)",
  run(ctx: L1Context): Finding[] {
    const out: Finding[] = [];
    const py = ctx.facts.priorYear;
    const priorAgi = py.agiCents.value === null ? null : Math.round(py.agiCents.value / 100);
    const priorTax = py.totalTaxCents.value === null ? null : Math.round(py.totalTaxCents.value / 100);
    const priorStatus = py.filingStatus.value;
    if (priorAgi === null && priorTax === null && priorStatus === null) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.E1.missing",
          severity: "low",
          area: "process",
          message: "No 2024 return is on file with a readable AGI, total tax and filing status, so the year-over-year comparison was skipped. Nothing richer than those three figures is compared even when it is on file.",
          evidence: [{ ref: "check:prior-year", amount: null, status: "missing" }],
          citation: HEURISTIC,
          recommendedAction: "Upload and verify last year's return if you want the comparison, and compare the two returns yourself for large changes.",
          acceptable: true,
        })
      );
      return out;
    }
    if (priorStatus !== null && priorStatus !== ctx.ret.filingStatus) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.E1.filing-status",
          severity: "medium",
          area: "process",
          message: `The 2024 return was filed as "${priorStatus}" but this return is computed as "${ctx.ret.filingStatus}". A change of filing status is legitimate (marriage, divorce) but it changes almost every figure.`,
          evidence: [{ ref: "check:prior-year.filing-status", amount: null, status: priorStatus }],
          citation: HEURISTIC,
          recommendedAction: "Confirm the filing status is right for 2025, then accept this finding with the reason.",
          acceptable: true,
        })
      );
    }
    const agi = lineState(ctx, "f1040.11a").amount;
    if (priorAgi !== null && agi !== null && priorAgi !== 0) {
      const v = Math.abs(agi - priorAgi) / Math.abs(priorAgi);
      if (v > THRESHOLDS.priorAgiVariance) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.E1.agi",
            severity: "medium",
            area: "income",
            lineKey: "f1040.11a",
            message: `Adjusted gross income is ${usd(agi)} against ${usd(priorAgi)} on the 2024 return, a change of ${pct(v)} (more than the ${pct(THRESHOLDS.priorAgiVariance)} that this review asks you to explain). This is a heuristic, not a rule of law.`,
            evidence: [{ ref: "f1040.11a", amount: agi, status: "computed" }, { ref: "check:prior-year.agi", amount: priorAgi, status: "2024" }],
            citation: HEURISTIC,
            recommendedAction: "Write down what changed (a raise, a new business, a sale of shares) and accept this finding with that reason.",
            acceptable: true,
          })
        );
      }
    }
    const tax = lineState(ctx, "f1040.24").amount;
    if (priorTax !== null && tax !== null && priorTax !== 0) {
      const v = Math.abs(tax - priorTax) / Math.abs(priorTax);
      if (v > THRESHOLDS.priorTaxVariance) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.E1.tax",
            severity: "medium",
            area: "tax",
            lineKey: "f1040.24",
            message: `Total tax is ${usd(tax)} against ${usd(priorTax)} on the 2024 return, a change of ${pct(v)} (more than the ${pct(THRESHOLDS.priorTaxVariance)} that this review asks you to explain). This is a heuristic, not a rule of law.`,
            evidence: [{ ref: "f1040.24", amount: tax, status: "computed" }, { ref: "check:prior-year.tax", amount: priorTax, status: "2024" }],
            citation: HEURISTIC,
            recommendedAction: "Explain the change (income, deductions, credits) and accept this finding with that reason.",
            acceptable: true,
          })
        );
      }
    }
    return out;
  },
};
