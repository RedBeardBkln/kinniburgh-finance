// Federal income tax on taxable income (Form 1040 line 16), TY2025, MFJ.
//
//   - Taxable income under $100,000: the IRS Tax Table (1040 instructions: "must
//     use the Tax Table"). A row's tax is the tax at the row midpoint, rounded to
//     whole dollars; rows are 5 / 10 / 25 / 50 dollars wide by range (constant
//     TAX_TABLE_ROW_BANDS). Every one of the 2,062 printed MFJ rows is checked in
//     the tests, including 95,000-95,050 = $10,926 and 98,000-98,050 = $11,394
//     (fixes defect D3).
//   - $100,000 and over: the Tax Computation Worksheet (identical to the
//     bracket formula in lib/tax-compute.ts computeFederalBracketTax).
//   - Qualified dividends or capital gain on the return: the Qualified Dividends
//     and Capital Gain Tax Worksheet (fixes defect D4); lines 1-25 of that
//     worksheet are reproduced below with their printed numbers.
//
// Pure. Constants from lib/tax2025/constants.ts only.

import type { Decimal } from "@prisma/client/runtime/library";
import { computeFederalBracketTax } from "@/lib/tax-compute";
import { K } from "@/lib/tax2025/constants";
import { D, ZERO, amountLine, blockedLine, fmt, maxD, minD, roundLine } from "@/lib/tax2025/money";
import type { RuleLine, RuleResult } from "@/lib/tax2025/types";

export type TaxMethod = "zero" | "tax_table" | "tax_computation_worksheet";

export interface TaxOnAmount {
  tax: Decimal;
  method: TaxMethod;
}

/** The printed Tax Table row containing `amount` (0 < amount < the table maximum): start and width. */
export function taxTableRow(amount: Decimal): { start: Decimal; width: Decimal } {
  const bands = K.TAX_TABLE_ROW_BANDS.value;
  let band = bands[0]!;
  for (const b of bands) if (amount.greaterThanOrEqualTo(b.from)) band = b;
  const width = D(band.width);
  const start = D(band.from).plus(amount.minus(band.from).div(width).floor().times(width));
  return { start, width };
}

/**
 * Tax on a whole-dollar amount of taxable income using the method the 1040
 * instructions require for that amount.
 */
export function taxOnAmount(amount: Decimal): TaxOnAmount {
  if (amount.lessThanOrEqualTo(0)) return { tax: ZERO, method: "zero" };
  if (amount.greaterThanOrEqualTo(K.TAX_TABLE_MAX_TAXABLE_INCOME.value)) {
    return { tax: computeFederalBracketTax(amount), method: "tax_computation_worksheet" };
  }
  const { start, width } = taxTableRow(amount);
  const midpoint = start.plus(width.div(2));
  return { tax: roundLine(computeFederalBracketTax(midpoint)), method: "tax_table" };
}

export interface IncomeTaxInput {
  /** 1040 line 15, whole dollars; null = missing. */
  taxableIncome: Decimal | null;
  /** 1040 line 3a qualified dividends (whole dollars, 0 if none); null = missing. */
  qualifiedDividends: Decimal | null;
  /**
   * Net capital gain for the QDCG worksheet line 3: capital gain distributions
   * (1040 line 7) when no Schedule D is required. 0 if none; null = missing.
   */
  netCapitalGain: Decimal | null;
}

export interface QdcgWorksheet {
  line: Record<number, Decimal>;
  tax: Decimal;
}

const CITATIONS = [
  "TAX_TABLE_MAX_TAXABLE_INCOME",
  "TAX_TABLE_ROW_BANDS",
  "FEDERAL_BRACKETS_MFJ",
  "QDCG_ZERO_RATE_LIMIT_MFJ",
  "QDCG_FIFTEEN_RATE_LIMIT_MFJ",
  "QDCG_FIFTEEN_RATE",
  "QDCG_TWENTY_RATE",
];

/**
 * Qualified Dividends and Capital Gain Tax Worksheet (1040 instructions), MFJ.
 * Line numbers match the printed worksheet.
 */
export function qdcgWorksheet(taxableIncome: Decimal, qualifiedDividends: Decimal, netCapitalGain: Decimal): QdcgWorksheet {
  const l1 = taxableIncome;
  const l2 = qualifiedDividends;
  const l3 = maxD(ZERO, netCapitalGain);
  const l4 = l2.plus(l3);
  const l5 = ZERO; // investment interest expense election (Form 4952): not modeled
  const l6 = maxD(ZERO, l4.minus(l5));
  const l7 = maxD(ZERO, l1.minus(l6));
  const l8 = minD(l1, D(K.QDCG_ZERO_RATE_LIMIT_MFJ.value));
  const l9 = minD(l7, l8);
  const l10 = l8.minus(l9); // taxed at 0%
  const l11 = minD(l1, l6);
  const l12 = l11.minus(l10);
  const l13 = D(K.QDCG_FIFTEEN_RATE_LIMIT_MFJ.value);
  const l14 = minD(l1, l13);
  const l15 = l7.plus(l10);
  const l16 = maxD(ZERO, l14.minus(l15));
  const l17 = minD(l12, l16);
  const l18 = l17.times(K.QDCG_FIFTEEN_RATE.value);
  const l19 = l10.plus(l17);
  const l20 = l11.minus(l19);
  const l21 = l20.times(K.QDCG_TWENTY_RATE.value);
  const l22 = taxOnAmount(l7).tax;
  // "include cents when adding the amounts and round off only the total"
  const l23 = roundLine(l18.plus(l21).plus(l22));
  const l24 = roundLine(taxOnAmount(l1).tax);
  const l25 = minD(l23, l24);
  const line: Record<number, Decimal> = {
    1: l1, 2: l2, 3: l3, 4: l4, 5: l5, 6: l6, 7: l7, 8: l8, 9: l9, 10: l10, 11: l11, 12: l12, 13: l13,
    14: l14, 15: l15, 16: l16, 17: l17, 18: l18, 19: l19, 20: l20, 21: l21, 22: l22, 23: l23, 24: l24, 25: l25,
  };
  return { line, tax: l25 };
}

export function computeIncomeTax(input: IncomeTaxInput): RuleResult {
  const base = {
    ruleId: "tax-calc",
    form: "Form 1040",
    citations: CITATIONS,
    inputsUsed: [],
  };
  const missing: string[] = [];
  if (input.taxableIncome === null) missing.push("taxable income (1040 line 15)");
  if (input.qualifiedDividends === null) missing.push("qualified dividends (1040 line 3a)");
  if (input.netCapitalGain === null) missing.push("capital gain distributions / net capital gain (1040 line 7)");
  if (missing.length > 0 || input.taxableIncome === null || input.qualifiedDividends === null || input.netCapitalGain === null) {
    const reason = `Tax cannot be figured: missing ${missing.join(", ")}.`;
    return {
      ...base,
      status: "missing_input",
      lines: [blockedLine("f1040.16", "Tax", "16", "missing_input", reason)],
      reasons: [reason],
      inputsMissing: missing,
    };
  }

  const ti = roundLine(input.taxableIncome);
  const qd = roundLine(input.qualifiedDividends);
  const gain = maxD(ZERO, roundLine(input.netCapitalGain));
  const lines: RuleLine[] = [];
  const reasons: string[] = [];

  const usesQdcg = qd.greaterThan(0) || gain.greaterThan(0);
  if (usesQdcg) {
    const ws = qdcgWorksheet(ti, qd, gain);
    lines.push(amountLine("qdcg.25", "Qualified Dividends and Capital Gain Tax Worksheet, line 25", "QDCG ws 25", ws.tax));
    lines.push(amountLine("f1040.16", "Tax", "16", ws.tax));
    reasons.push(
      `Qualified Dividends and Capital Gain Tax Worksheet used (qualified dividends ${fmt(qd)}, capital gain ${fmt(gain)}): ` +
        `line 23 ${fmt(ws.line[23]!)} versus line 24 (tax on all taxable income) ${fmt(ws.line[24]!)}; the smaller is the tax.`
    );
    return { ...base, status: "computed", lines, reasons, inputsMissing: [] };
  }

  const t = taxOnAmount(ti);
  lines.push(amountLine("f1040.16", "Tax", "16", t.tax));
  if (t.method === "tax_table") {
    reasons.push(`Taxable income ${fmt(ti)} is under ${fmt(D(K.TAX_TABLE_MAX_TAXABLE_INCOME.value))}: Tax Table (tax at the row midpoint, rounded).`);
  } else if (t.method === "tax_computation_worksheet") {
    reasons.push(`Taxable income ${fmt(ti)} is ${fmt(D(K.TAX_TABLE_MAX_TAXABLE_INCOME.value))} or more: Tax Computation Worksheet (bracket formula).`);
  } else {
    reasons.push("No taxable income: no tax.");
  }
  return { ...base, status: "computed", lines, reasons, inputsMissing: [] };
}
