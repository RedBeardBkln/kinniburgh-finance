// L2 oracle: the tax tables, written from the printed 2025 forms and instructions with plain integer arithmetic.
// Sources (read for this file):
//  - 2025 Form 1040 instructions: the Tax Table row structure (rows of $5, $10, $25 and $50, each priced at its midpoint and rounded),
//    "2025 Tax Computation Worksheet, Section B" (married filing jointly, taxable income of $100,000 or more), and the
//    "Qualified Dividends and Capital Gain Tax Worksheet" lines 1-25.
//  - Form CT-1040 TCS (Rev. 12/25): Tax Calculation Schedule lines 1-10 and Tables A-E (married filing jointly / qualifying surviving spouse).
// Numeric constants that the registry already carries (brackets, QDCG limits, the Table C step) come from lib/tax2025/constants.ts;
// everything else here is transcribed from the printed tables and pinned against the printed rows by lib/__tests__/tax-review-l2-tables.test.ts.
// Nothing in this file calls an engine function.

import { K } from "@/lib/tax2025/constants";
import { bpOf, ceilDiv, type Cents, type Dollars } from "@/lib/tax-review/l2/money";

// ── Federal tax ───────────────────────────────────────────────────────────────

interface Bracket {
  bp: number;
  min: number;
  max: number | null;
}

const BRACKETS: readonly Bracket[] = K.FEDERAL_BRACKETS_MFJ.value.map((b) => ({ bp: bpOf(b.rate), min: b.min, max: b.max }));

/** Tax Table rows, from the registry's printed row structure: { from, width }. */
const ROW_BANDS = K.TAX_TABLE_ROW_BANDS.value;

/**
 * sum(bp x portion) with the income given in HALF dollars (so a row midpoint is an integer); tax in dollars = N / 20,000.
 */
function progressiveNumerator(x2: number): number {
  let n = 0;
  for (const b of BRACKETS) {
    const lo = 2 * b.min;
    if (x2 <= lo) break;
    const hi = b.max === null ? x2 : Math.min(x2, 2 * b.max);
    n += b.bp * (hi - lo);
  }
  return n;
}

/** The printed Tax Table amount (whole dollars) for taxable income `ti` (a whole-dollar amount under the table limit). */
export function taxTableAmount(ti: Dollars): Dollars {
  if (ti <= 0) return 0;
  let band = ROW_BANDS[0];
  for (const b of ROW_BANDS) if (ti >= b.from) band = b;
  if (band === undefined) return 0;
  const start = band.from + Math.floor((ti - band.from) / band.width) * band.width;
  const x2 = 2 * start + band.width; // twice the row midpoint
  const n = progressiveNumerator(x2);
  return Math.floor((n + 10_000) / 20_000); // round half up to whole dollars
}

/** Tax Computation Worksheet, Section B (MFJ): row = (a) x (b) - (d), as printed. d is in cents. */
interface WorksheetRow {
  upTo: number | null;
  bp: number;
  subtractCents: Cents;
}

const WORKSHEET_B: readonly WorksheetRow[] = [
  { upTo: 206_700, bp: 2200, subtractCents: 1_017_200 }, // x 22%  - $10,172.00
  { upTo: 394_600, bp: 2400, subtractCents: 1_430_600 }, // x 24%  - $14,306.00
  { upTo: 501_050, bp: 3200, subtractCents: 4_587_400 }, // x 32%  - $45,874.00
  { upTo: 751_600, bp: 3500, subtractCents: 6_090_550 }, // x 35%  - $60,905.50
  { upTo: null, bp: 3700, subtractCents: 7_593_750 }, //    x 37%  - $75,937.50
];

/** Tax in exact cents for taxable income `ti` (whole dollars): the Tax Table (whole dollars) under $100,000, else the worksheet. */
export function federalTaxCents(ti: Dollars): Cents {
  if (ti <= 0) return 0;
  if (ti < K.TAX_TABLE_MAX_TAXABLE_INCOME.value) return taxTableAmount(ti) * 100;
  for (const row of WORKSHEET_B) {
    if (row.upTo === null || ti <= row.upTo) return (ti * row.bp) / 100 - row.subtractCents;
  }
  return 0;
}

/** Whole dollars of an exact-cents tax (half up; the tax is never negative). */
export function wholeDollars(cents: Cents): Dollars {
  return Math.floor((cents + 50) / 100);
}

export interface QdcgLines {
  l1: Dollars;
  l2: Dollars;
  l3: Dollars;
  l4: Dollars;
  l5: Dollars;
  l6: Dollars;
  l7: Dollars;
  l8: Dollars;
  l9: Dollars;
  l10: Dollars;
  l11: Dollars;
  l12: Dollars;
  l13: Dollars;
  l14: Dollars;
  l15: Dollars;
  l16: Dollars;
  l17: Dollars;
  l18Cents: Cents;
  l19: Dollars;
  l20: Dollars;
  l21Cents: Cents;
  l22Cents: Cents;
  l23: Dollars;
  l24: Dollars;
  /** Line 25: the smaller of lines 23 and 24. */
  l25: Dollars;
}

/** Qualified Dividends and Capital Gain Tax Worksheet, lines 1-25, married filing jointly. */
export function qdcgWorksheet(taxableIncome: Dollars, qualifiedDividends: Dollars, capitalGain: Dollars): QdcgLines {
  const l1 = taxableIncome;
  const l2 = qualifiedDividends;
  const l3 = capitalGain; // the caller applies "smaller of Schedule D 15 or 16, loss or blank = 0" (or 7a without Schedule D)
  const l4 = l2 + l3;
  const l5 = Math.max(0, l1 - l4);
  const l6 = K.QDCG_ZERO_RATE_LIMIT_MFJ.value;
  const l7 = Math.min(l1, l6);
  const l8 = Math.min(l5, l7);
  const l9 = l7 - l8;
  const l10 = Math.min(l1, l4);
  const l11 = l9;
  const l12 = l10 - l11;
  const l13 = K.QDCG_FIFTEEN_RATE_LIMIT_MFJ.value;
  const l14 = Math.min(l1, l13);
  const l15 = l5 + l9;
  const l16 = Math.max(0, l14 - l15);
  const l17 = Math.min(l12, l16);
  const l18Cents = (l17 * bpOf(K.QDCG_FIFTEEN_RATE.value)) / 100;
  const l19 = l9 + l17;
  const l20 = l10 - l19;
  const l21Cents = (l20 * bpOf(K.QDCG_TWENTY_RATE.value)) / 100;
  const l22Cents = federalTaxCents(l5);
  const l23 = wholeDollars(l18Cents + l21Cents + l22Cents);
  const l24 = wholeDollars(federalTaxCents(l1));
  return { l1, l2, l3, l4, l5, l6, l7, l8, l9, l10, l11, l12, l13, l14, l15, l16, l17, l18Cents, l19, l20, l21Cents, l22Cents, l23, l24, l25: Math.min(l23, l24) };
}

// ── Connecticut: Tax Calculation Schedule (MFJ) ───────────────────────────────

/** Table A, Personal Exemptions (MFJ): $24,000, less $1,000 for each $1,000 (or part) of Connecticut AGI over $48,000; $0 above $71,000. */
export function ctTableA(agi: Dollars): Dollars {
  if (agi <= 48_000) return 24_000;
  return Math.max(0, 24_000 - 1_000 * ceilDiv(agi - 48_000, 1_000));
}

/**
 * Table B, Initial Tax Calculation (MFJ), in hundredths of a cent (so every printed rate, down to 6.99%, is an integer
 * multiplier): the line 3 amount is a whole-dollar figure.
 */
export function ctTableBHundredthsOfCents(taxableIncome: Dollars): number {
  const x = taxableIncome;
  if (x <= 20_000) return x * 200; // 2.00%
  if (x <= 100_000) return 4_000_000 + (x - 20_000) * 450; // $400 + 4.5% of the excess over $20,000
  if (x <= 200_000) return 40_000_000 + (x - 100_000) * 550; // $4,000 + 5.5%
  if (x <= 400_000) return 95_000_000 + (x - 200_000) * 600; // $9,500 + 6.0%
  if (x <= 500_000) return 215_000_000 + (x - 400_000) * 650; // $21,500 + 6.5%
  if (x <= 1_000_000) return 280_000_000 + (x - 500_000) * 690; // $28,000 + 6.9%
  return 625_000_000 + (x - 1_000_000) * 699; // $62,500 + 6.99%
}

/** Table C, 2% Tax Rate Phase-Out Add-Back (MFJ): $50 per $5,000 (or part) of Connecticut AGI over $100,500, at most $500. */
export function ctTableC(agi: Dollars): Dollars {
  const c = K.CT_TABLE_C.value;
  if (agi <= c.threshold) return 0;
  return Math.min(c.stepAmount * c.maxSteps, c.stepAmount * ceilDiv(agi - c.threshold, c.stepSize));
}

/** Table D, Tax Recapture (MFJ), from the printed rows. */
export function ctTableD(agi: Dollars): Dollars {
  if (agi <= 210_000) return 0;
  if (agi <= 300_000) return 50 * ceilDiv(agi - 210_000, 10_000); // $210,000-$220,000 = 50 ... $290,000-$300,000 = 450
  if (agi <= 400_000) return 500;
  if (agi <= 690_000) return 680 + 180 * (ceilDiv(agi - 400_000, 10_000) - 1); // $400,000-$410,000 = 680 ... $680,000-$690,000 = 5,720
  if (agi <= 1_000_000) return 5_900;
  if (agi <= 1_080_000) return 6_000 + 100 * (ceilDiv(agi - 1_000_000, 10_000) - 1); // $1,000,000-$1,010,000 = 6,000 ... $1,070,000-$1,080,000 = 6,700
  return 6_800; // $1,080,000 and up
}

/** Table E, Personal Tax Credits (MFJ): the decimal in hundredths (75 = .75). Not used below $24,000 (the tax is zero there). */
export function ctTableEHundredths(agi: Dollars): number {
  if (agi <= 24_000) return 75; // outside the printed table; the whole tax is 0 there
  if (agi <= 30_000) return 75;
  if (agi <= 33_500) return 70 - 5 * Math.max(0, ceilDiv(agi - 30_000, 500) - 1); // 30,000-30,500 = .70 ... 33,000-33,500 = .40
  if (agi <= 40_000) return 35;
  if (agi <= 41_500) return 30 - 5 * (ceilDiv(agi - 40_000, 500) - 1); // 40,000-40,500 = .30, .25, .20
  if (agi <= 50_000) return 15;
  if (agi <= 52_000) return 14 - (ceilDiv(agi - 50_000, 500) - 1); // 50,000-50,500 = .14 ... 51,500-52,000 = .11
  if (agi <= 96_000) return 10;
  if (agi <= 100_500) return 9 - (ceilDiv(agi - 96_000, 500) - 1); // 96,000-96,500 = .09 ... 100,000-100,500 = .01
  return 0;
}

export interface CtTcsLines {
  l1: Dollars;
  l2: Dollars;
  l3: Dollars;
  l4: Dollars;
  l5: Dollars;
  l6: Dollars;
  l7: Dollars;
  l8Hundredths: number;
  l9: Dollars;
  /** Line 10: the Connecticut income tax (goes on CT-1040 line 6). */
  l10: Dollars;
}

/** CT-1040 TCS lines 1-10. Every printed line is a whole-dollar amount ("00" cents), so each is rounded as it is entered. */
export function ctTaxCalculationSchedule(ctAgi: Dollars): CtTcsLines {
  const l1 = ctAgi;
  const l2 = ctTableA(l1);
  const l3 = Math.max(0, l1 - l2);
  const l4 = Math.floor((ctTableBHundredthsOfCents(l3) + 5_000) / 10_000);
  const l5 = ctTableC(l1);
  const l6 = ctTableD(l1);
  const l7 = l4 + l5 + l6;
  const l8Hundredths = ctTableEHundredths(Math.max(l1, 24_001));
  const l9 = Math.floor((l7 * l8Hundredths + 50) / 100);
  return { l1, l2, l3, l4, l5, l6, l7, l8Hundredths, l9, l10: l7 - l9 };
}

/** The "decimal" of the Property Tax Credit Table (MFJ), in hundredths: the part of the (up to $300) credit that is NOT allowed. */
export function ctPropertyTaxDecimalHundredths(ctAgi: Dollars): number {
  for (const band of K.CT_PROPERTY_TAX_CREDIT_PHASEOUT_MFJ.value) {
    if (band.upTo === null || ctAgi <= band.upTo) return Math.round(band.value * 100);
  }
  return 100;
}
