// TESTER (independent) oracle tests for the TY2025 engine. Everything here is checked against numbers the
// Tester transcribed himself from the primary sources (IRS 2025 Form 1040 instructions Tax Table + worksheets,
// CT Form CT-1040 TCS Rev. 12/25 Tables A-E), stored in fixtures/tester-oracles-2025.json, or against reference
// arithmetic written from the printed forms. It deliberately does not reuse the Coder's fixture or helpers other
// than building input facts (tax2025-fixtures.ts).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { computeConnecticutTax } from "@/lib/tax-compute";
import { K } from "@/lib/tax2025/constants";
import { LINE_KEYS } from "@/lib/tax2025/line-catalog";
import { D, roundLine } from "@/lib/tax2025/money";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { ctPropertyTaxPhaseOutDecimal } from "@/lib/tax2025/rules/ct";
import { computeForm8959, computeScheduleSe } from "@/lib/tax2025/rules/se-medicare";
import { saltCapForMagi } from "@/lib/tax2025/rules/schedule-a";
import { qdcgWorksheet, taxOnAmount } from "@/lib/tax2025/rules/tax-calc";
import { hasAmount, type LineKey, type Ty2025Return } from "@/lib/tax2025/types";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { ERIC_ID, EVA_ID, bill, fullFacts, owner, w2 } from "@/lib/__tests__/tax2025-fixtures";

interface Oracles {
  taxTable: Record<string, [number, number]>;
  ctC: [number, number | null, number][];
  ctD: [number, number | null, number][];
  ctE: [number, number | null, number][];
}
const ORACLES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tester-oracles-2025.json"), "utf8")) as Oracles;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Reference federal tax (independent of lib/tax-compute.ts) ───────────────────

const TAXTABLE_STARTS = Object.keys(ORACLES.taxTable).map(Number).sort((a, b) => a - b);
function refTableTax(x: number): number {
  let lo = 0;
  let hi = TAXTABLE_STARTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (TAXTABLE_STARTS[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  const row = ORACLES.taxTable[String(TAXTABLE_STARTS[lo]!)]!;
  return row[1];
}
/** Printed Tax Computation Worksheet, Section B (MFJ): (a) x (b) - (d). */
function refWorksheetTax(x: Decimal): Decimal {
  if (x.lessThanOrEqualTo(206700)) return x.times("0.22").minus("10172");
  if (x.lessThanOrEqualTo(394600)) return x.times("0.24").minus("14306");
  if (x.lessThanOrEqualTo(501050)) return x.times("0.32").minus("45874");
  if (x.lessThanOrEqualTo(751600)) return x.times("0.35").minus("60905.50");
  return x.times("0.37").minus("75937.50");
}
/** Tax on an amount per the 1040 instructions: Tax Table under $100,000, worksheet at/above (cents kept for worksheet). */
function refTax(x: Decimal): Decimal {
  if (x.lessThanOrEqualTo(0)) return D(0);
  if (x.lessThan(100000)) return D(refTableTax(x.floor().toNumber()));
  return refWorksheetTax(x);
}
const rd = (x: Decimal): Decimal => x.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

describe("Tester oracle: 2025 MFJ Tax Table, Tax Computation Worksheet, QDCG worksheet", () => {
  it("the Tester's independent parse has 2,062 contiguous rows from 0 to 100,000 and matches the Coder's fixture", () => {
    expect(TAXTABLE_STARTS.length).toBe(2062);
    const coder = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tax-table-2025-mfj.json"), "utf8")) as [number, number, number][];
    expect(coder.length).toBe(2062);
    for (const [a, b, t] of coder) {
      const mine = ORACLES.taxTable[String(a)];
      expect(mine, `row ${a}`).toBeDefined();
      expect(mine![0]).toBe(b);
      expect(mine![1], `row ${a}-${b}`).toBe(t);
    }
  });

  it("the printed rows named in the brief", () => {
    expect(refTableTax(95000)).toBe(10926);
    expect(refTableTax(95049)).toBe(10926);
    expect(refTableTax(98000)).toBe(11394);
    expect(refTableTax(98049)).toBe(11394);
    expect(refTableTax(99950)).toBe(11823);
    expect(refTableTax(99999)).toBe(11823);
    expect(taxOnAmount(D(95000)).tax.toNumber()).toBe(10926);
    expect(taxOnAmount(D(98049)).tax.toNumber()).toBe(11394);
    expect(taxOnAmount(D(99999)).tax.toNumber()).toBe(11823);
    expect(taxOnAmount(D(100000)).tax.toString()).toBe("11828");
  });

  it("engine Tax Table equals the Tester's table at EVERY whole dollar from 0 to 99,999", () => {
    for (let x = 0; x < 100000; x++) {
      const got = taxOnAmount(D(x)).tax.toNumber();
      if (got !== refTableTax(x)) throw new Error(`taxable income ${x}: engine ${got}, table ${refTableTax(x)}`);
    }
  });

  it("worksheet at/above 100,000 equals the printed (a) x (b) - (d) formulas at every bracket edge and 5,000 random points", () => {
    const edges = [100000, 100001, 206700, 206701, 394600, 394601, 501050, 501051, 751600, 751601, 1000000, 5000000];
    const rnd = mulberry32(7);
    const pts = [...edges];
    for (let i = 0; i < 5000; i++) pts.push(100000 + Math.floor(rnd() * 1_500_000));
    for (const x of pts) {
      const got = taxOnAmount(D(x)).tax;
      const want = refWorksheetTax(D(x));
      if (!got.equals(want)) throw new Error(`at ${x}: engine ${got.toString()} vs worksheet ${want.toString()}`);
    }
  });

  it("QDCG worksheet equals an independent line-by-line reference on 30,000 random cases (incl. gains, 0%/15%/20% splits)", () => {
    const rnd = mulberry32(2025);
    for (let i = 0; i < 30000; i++) {
      const ti = Math.floor(rnd() * (i % 3 === 0 ? 150000 : 1_300_000));
      const qd = Math.floor(rnd() * (i % 2 === 0 ? 5000 : 400000));
      const gain = i % 4 === 0 ? 0 : Math.floor(rnd() * 600000);
      // printed 2025 Qualified Dividends and Capital Gain Tax Worksheet, lines 1-25
      const l1 = ti, l2 = qd, l3 = gain;
      const l4 = l2 + l3;
      const l5 = Math.max(0, l1 - l4);
      const l6 = 96700;
      const l7 = Math.min(l1, l6);
      const l8 = Math.min(l5, l7);
      const l9 = l7 - l8;
      const l10 = Math.min(l1, l4);
      const l11 = l9;
      const l12 = l10 - l11;
      const l13 = 600050;
      const l14 = Math.min(l1, l13);
      const l15 = l5 + l9;
      const l16 = Math.max(0, l14 - l15);
      const l17 = Math.min(l12, l16);
      const l18 = D(l17).times("0.15");
      const l19 = l9 + l17;
      const l20 = l10 - l19;
      const l21 = D(l20).times("0.20");
      const l22 = refTax(D(l5));
      const l23 = rd(l18.plus(l21).plus(l22));
      const l24 = rd(refTax(D(l1)));
      const want = Decimal.min(l23, l24);
      const got = qdcgWorksheet(D(ti), D(qd), D(gain)).tax;
      if (!got.equals(want)) throw new Error(`TI ${ti} QD ${qd} gain ${gain}: engine ${got.toString()} vs reference ${want.toString()}`);
    }
  });

  it("hand-computed QDCG case: TI 137,174, QD 800 -> line 22 19,830.28 + 120 = 19,950 vs 20,006", () => {
    const ws = qdcgWorksheet(D(137174), D(800), D(0));
    expect(ws.line[23]!.toNumber()).toBe(19950);
    expect(ws.line[24]!.toNumber()).toBe(20006);
    expect(ws.tax.toNumber()).toBe(19950);
  });
});

// ── CT oracle ───────────────────────────────────────────────────────────────────

function tableLookup(rows: [number, number | null, number][], agi: number): number {
  for (const [from, to, v] of rows) if (agi > from && (to === null || agi <= to)) return v;
  if (agi <= rows[0]![0]) return rows[0]![2];
  throw new Error(`no row for ${agi}`);
}
/** CT TCS, MFJ, from the printed tables (exemption: $24,000 to $48,000, -$1,000 per $1,000 to $0 above $71,000). */
function refCtTax(agi: number): Decimal {
  const exemption = agi <= 48000 ? 24000 : Math.max(0, 24000 - Math.ceil((agi - 48000) / 1000) * 1000);
  const ti = Math.max(0, agi - exemption);
  let initial: Decimal;
  if (ti <= 20000) initial = D(ti).times("0.02");
  else if (ti <= 100000) initial = D(400).plus(D(ti - 20000).times("0.045"));
  else if (ti <= 200000) initial = D(4000).plus(D(ti - 100000).times("0.055"));
  else if (ti <= 400000) initial = D(9500).plus(D(ti - 200000).times("0.06"));
  else if (ti <= 500000) initial = D(21500).plus(D(ti - 400000).times("0.065"));
  else if (ti <= 1000000) initial = D(28000).plus(D(ti - 500000).times("0.069"));
  else initial = D(62500).plus(D(ti - 1000000).times("0.0699"));
  const c = tableLookup(ORACLES.ctC, agi);
  const d = tableLookup(ORACLES.ctD, agi);
  const e = tableLookup(ORACLES.ctE, Math.max(agi, 24001));
  const line7 = initial.plus(c).plus(d);
  return line7.minus(line7.times(e));
}

describe("Tester oracle: CT Tax Calculation Schedule (MFJ) Tables A-E", () => {
  it("Table C at the band edges: 100,500 -> 0, 100,501 -> 50, 105,500 -> 50, 105,501 -> 100, 145,500 -> 450, 145,501 -> 500", () => {
    const pairs: [number, number][] = [[100500, 0], [100501, 50], [105500, 50], [105501, 100], [110500, 100], [110501, 150], [140500, 400], [140501, 450], [145500, 450], [145501, 500], [900000, 500]];
    for (const [agi, want] of pairs) {
      expect(tableLookup(ORACLES.ctC, agi), `oracle ${agi}`).toBe(want);
      expect(computeConnecticutTax({ ctAGI: D(agi), ctWithholdingCents: 0 }).phaseOutAddback.toNumber(), `engine ${agi}`).toBe(want);
    }
  });

  it("whole CT tax equals the Tester's Tables A-E calculation at every band edge and on 60,000 AGIs from 24,001 to 1,300,000", () => {
    const pts = new Set<number>();
    for (const t of [ORACLES.ctC, ORACLES.ctD, ORACLES.ctE]) for (const [from] of t) { pts.add(from); pts.add(from + 1); pts.add(from - 1); }
    for (let a = 48000; a <= 72000; a += 1) pts.add(a); // Table A fence posts
    for (const b of [20000, 100000, 200000, 400000, 500000, 1000000]) for (const dlt of [-1, 0, 1, 24000, 23999, 24001]) pts.add(b + dlt);
    const rnd = mulberry32(99);
    for (let i = 0; i < 60000; i++) pts.add(24001 + Math.floor(rnd() * 1_300_000));
    for (const agi of pts) {
      if (agi <= 24000) continue;
      const got = computeConnecticutTax({ ctAGI: D(agi), ctWithholdingCents: 0 }).ctTaxComputed;
      if (got === null) throw new Error(`engine returned null at ${agi}`);
      const want = refCtTax(agi);
      if (!got.equals(want)) throw new Error(`CT AGI ${agi}: engine ${got.toString()} vs reference ${want.toString()}`);
    }
  });

  it("property tax credit decimal at every printed edge (MFJ) and the credit formula", () => {
    const table: [number, number][] = [[70500, 0], [70501, 0.15], [80500, 0.15], [80501, 0.3], [90500, 0.3], [90501, 0.45], [100500, 0.45], [100501, 0.6], [110500, 0.6], [110501, 0.75], [120500, 0.75], [120501, 0.9], [130500, 0.9], [130501, 1]];
    for (const [agi, dec] of table) expect(ctPropertyTaxPhaseOutDecimal(D(agi)).toNumber(), `agi ${agi}`).toBe(dec);
  });
});

// ── SALT worksheet ──────────────────────────────────────────────────────────────

describe("Tester oracle: Schedule A SALT worksheet (2025)", () => {
  it("cap = max(40,000 - 30% x (MAGI - 500,000), 10,000), whole dollars", () => {
    const cases: [number, number][] = [[0, 40000], [500000, 40000], [500001, 40000], [500002, 39999], [500004, 39999], [510000, 37000], [520000, 34000], [600000, 10000], [599999, 10000], [566666, 20000], [900000, 10000]];
    for (const [magi, want] of cases) {
      const ref = Math.max(40000 - Math.round(Math.max(0, magi - 500000) * 0.3), 10000);
      expect(ref, `ref sanity ${magi}`).toBe(want);
      expect(saltCapForMagi(D(magi)).toNumber(), `magi ${magi}`).toBe(want);
    }
  });
});

// ── Reference constants (read independently from the IRS / CT primary sources by the Tester) ─────────────────

describe("Tester oracle: constants registry equals the Tester's independent reading of the primary sources", () => {
  it("matches", () => {
    const v = (id: keyof typeof K): unknown => K[id].value;
    expect(v("STANDARD_DEDUCTION_MFJ")).toBe(31500);
    expect(v("TAX_TABLE_MAX_TAXABLE_INCOME")).toBe(100000);
    expect(v("QDCG_ZERO_RATE_LIMIT_MFJ")).toBe(96700);
    expect(v("QDCG_FIFTEEN_RATE_LIMIT_MFJ")).toBe(600050);
    expect(v("SE_WAGE_BASE")).toBe(176100);
    expect(v("SE_NET_EARNINGS_FACTOR")).toBe(0.9235);
    expect(v("SE_FLOOR")).toBe(400);
    expect(v("SE_OASDI_RATE")).toBe(0.124);
    expect(v("SE_MEDICARE_RATE")).toBe(0.029);
    expect(v("ADDL_MEDICARE_RATE")).toBe(0.009);
    expect(v("ADDL_MEDICARE_THRESHOLD_MFJ")).toBe(250000);
    expect(v("ADDL_MEDICARE_W2_TRIGGER")).toBe(200000);
    expect(v("MEDICARE_EMPLOYEE_RATE")).toBe(0.0145);
    expect(v("NIIT_RATE")).toBe(0.038);
    expect(v("NIIT_THRESHOLD_MFJ")).toBe(250000);
    expect(v("QBI_RATE")).toBe(0.2);
    expect(v("QBI_8995_THRESHOLD_MFJ")).toBe(394600);
    expect(v("QBI_PHASE_IN_END_MFJ")).toBe(494600);
    expect(v("SALT_CAP_MFJ")).toBe(40000);
    expect(v("SALT_PHASE_DOWN_THRESHOLD_MFJ")).toBe(500000);
    expect(v("SALT_PHASE_DOWN_RATE")).toBe(0.3);
    expect(v("SALT_FLOOR")).toBe(10000);
    expect(v("MORTGAGE_DEBT_LIMIT")).toBe(750000);
    expect(v("FORM_8283_NONCASH_THRESHOLD")).toBe(500);
    expect(v("SCH_B_THRESHOLD")).toBe(1500);
    expect(v("AMT_EXEMPTION_MFJ")).toBe(137000);
    expect(v("AMT_PHASEOUT_START_MFJ")).toBe(1252700);
    expect(v("AMT_28_PERCENT_THRESHOLD")).toBe(239100);
    expect(v("SCH1A_TIPS_MAX")).toBe(25000);
    expect(v("SCH1A_TIPS_MAGI_START_MFJ")).toBe(300000);
    expect(v("SCH1A_OVERTIME_MAX_MFJ")).toBe(25000);
    expect(v("SCH1A_CAR_LOAN_MAX")).toBe(10000);
    expect(v("SCH1A_CAR_LOAN_MAGI_START_MFJ")).toBe(200000);
    expect(v("SCH1A_SENIOR_AMOUNT")).toBe(6000);
    expect(v("SCH1A_SENIOR_MAGI_START_MFJ")).toBe(150000);
    expect(v("SCH1A_SENIOR_REDUCTION_RATE")).toBe(0.06);
    expect(v("HSA_LIMIT_SELF_ONLY")).toBe(4300);
    expect(v("HSA_LIMIT_FAMILY")).toBe(8550);
    expect(v("HSA_CATCH_UP_55")).toBe(1000);
    expect(v("IRA_LIMIT")).toBe(7000);
    expect(v("IRA_LIMIT_AGE_50")).toBe(8000);
    expect(v("IRA_PHASEOUT_COVERED_MFJ")).toEqual({ start: 126000, end: 146000 });
    expect(v("IRA_PHASEOUT_SPOUSE_COVERED_MFJ")).toEqual({ start: 236000, end: 246000 });
    expect(v("SAVERS_CONTRIBUTION_CAP")).toBe(2000);
    expect(v("FOREIGN_TAX_DIRECT_LIMIT_MFJ")).toBe(600);
    expect(v("MILEAGE_RATE")).toBe(0.7);
    expect(v("HOME_OFFICE_RATE_PER_SQFT")).toBe(5);
    expect(v("HOME_OFFICE_MAX_SQFT")).toBe(300);
    expect(v("SECTION_179_MAX")).toBe(2500000);
    expect(v("SECTION_179_PHASEOUT_START")).toBe(4000000);
    expect(v("SECTION_179_SUV_CAP")).toBe(31300);
    expect(v("MACRS_39_YEAR_JULY_FIRST_YEAR_PCT")).toBe(1.177);
    expect(v("MACRS_39_YEAR_LATER_YEAR_PCT")).toBe(2.564);
    expect(v("SAFE_HARBOR_HIGH_AGI_THRESHOLD")).toBe(150000);
    expect(v("CT_TAX_TABLE_AGI_LIMIT")).toBe(102000);
    expect(v("CT_ZERO_TAX_AGI_MFJ")).toBe(24000);
    expect(v("CT_PROPERTY_TAX_CREDIT_MAX")).toBe(300);
    expect(v("CT_PROPERTY_TAX_CREDIT_FULL_AGI_MFJ")).toBe(70500);
    expect(v("CT_PROPERTY_TAX_CREDIT_MAX_VEHICLES_MFJ")).toBe(2);
    expect(v("CT_LATE_PAYMENT_PENALTY_RATE")).toBe(0.1);
    expect(v("CT_INTEREST_RATE_PER_MONTH")).toBe(0.01);
    expect(v("CT_TABLE_C")).toEqual({ threshold: 100500, stepSize: 5000, stepAmount: 50, maxSteps: 10 });
    expect(v("SAVERS_RATE_BANDS_MFJ")).toEqual([{ upTo: 47500, value: 0.5 }, { upTo: 51000, value: 0.2 }, { upTo: 79000, value: 0.1 }, { upTo: null, value: 0 }]);
    expect(v("UNDERPAYMENT_INTEREST_RATES")).toEqual({ "2025": [7, 7, 7, 7], "2026": [7, 6, 7, 7] });
    const br = K.FEDERAL_BRACKETS_MFJ.value.map((b) => [b.min, b.max, b.rate]);
    expect(br).toEqual([[0, 23850, 0.1], [23850, 96950, 0.12], [96950, 206700, 0.22], [206700, 394600, 0.24], [394600, 501050, 0.32], [501050, 751600, 0.35], [751600, null, 0.37]]);
  });
});

// ── Schedule SE and Form 8959 reference ────────────────────────────────────────

describe("Tester oracle: Schedule SE and Form 8959 against line-by-line reference (rounded line by line)", () => {
  it("SE tax lines for 20,000 random (profit, W-2 SS wages) pairs incl. the $400 floor and the wage-base edge", () => {
    const rnd = mulberry32(11);
    for (let i = 0; i < 20000; i++) {
      const profit = i % 5 === 0 ? Math.floor(rnd() * 1000) - 200 : Math.floor(rnd() * 500000) - 20000;
      const ss = i % 7 === 0 ? 176100 + Math.floor(rnd() * 50000) * (i % 2) : Math.floor(rnd() * 200000);
      const r = computeScheduleSe({ netProfit: D(profit), ssWagesAndTips: D(ss) });
      const l4a = profit > 0 ? rd(D(profit).times("0.9235")) : D(profit);
      const byKey = new Map(r.lines.map((l) => [l.key, l]));
      if (l4a.lessThan(400)) {
        expect(byKey.get("se.12")!.amount!.toNumber(), `profit ${profit}`).toBe(0);
        continue;
      }
      const l9 = Decimal.max(0, D(176100).minus(ss));
      const l10 = l9.lessThanOrEqualTo(0) ? D(0) : rd(Decimal.min(l4a, l9).times("0.124"));
      const l11 = rd(l4a.times("0.029"));
      const l12 = l10.plus(l11);
      const l13 = rd(l12.div(2));
      expect(byKey.get("se.12")!.amount!.toNumber(), `se.12 profit ${profit} ss ${ss}`).toBe(l12.toNumber());
      expect(byKey.get("se.13")!.amount!.toNumber(), `se.13 profit ${profit} ss ${ss}`).toBe(l13.toNumber());
      // within $1 of the all-exact (no per-line rounding) computation
      const exact = Decimal.min(D(profit).times("0.9235"), l9.lessThanOrEqualTo(0) ? D(0) : l9).times("0.124").plus(D(profit).times("0.9235").times("0.029"));
      expect(Math.abs(l12.minus(exact).toNumber())).toBeLessThanOrEqual(2);
    }
  });

  it("Form 8959 Parts I, II, V on random MFJ wage/SE combos (per-spouse W-2 trigger and combined $250,000)", () => {
    const rnd = mulberry32(31);
    for (let i = 0; i < 20000; i++) {
      const w = Math.floor(rnd() * 600000);
      const big = Math.floor(rnd() * 350000);
      const se = i % 3 === 0 ? 0 : Math.floor(rnd() * 300000);
      const wages = w + big;
      const withheld = rd(D(wages).times("0.0145").plus(D(Math.max(0, big - 200000)).times("0.009")));
      const r = computeForm8959({ medicareWages: D(wages), largestBox5: D(Math.max(w, big)), medicareWithheld: withheld, seNetEarnings: D(se) });
      const l6 = Math.max(0, wages - 250000);
      const l7 = rd(D(l6).times("0.009"));
      const l11 = Math.max(0, 250000 - wages);
      const l12 = Math.max(0, se - l11);
      const l13 = rd(D(l12).times("0.009"));
      const required = Math.max(w, big) > 200000 || wages + se > 250000;
      const get = (k: LineKey) => r.lines.find((l) => l.key === k);
      if (!required) {
        expect(r.status).toBe("not_applicable");
        continue;
      }
      expect(get("f8959.18")!.amount!.toNumber(), `8959 line 18 wages ${wages} se ${se}`).toBe(l7.plus(l13).toNumber());
      const l22 = Decimal.max(0, withheld.minus(rd(D(wages).times("0.0145"))));
      expect(get("f8959.24")!.amount!.toNumber(), `8959 line 24 wages ${wages}`).toBe(l22.toNumber());
    }
  });
});

// ── End-to-end differential: the whole return vs a reference written from the printed forms ────────────────

interface Scenario {
  ericW1: number; // box 1 = box 3 = box 5, first employer
  ericW2nd: number; // second Eric employer (0 = none)
  evaW: number;
  interest: number;
  ordDiv: number;
  qualDiv: number;
  revenue: number;
  softwareExp: number;
  mealsExp: number;
  mortgageInterest: number;
  propTaxPaid: number;
}

function w2For(
  docId: string,
  person: string,
  wages: number
): ReturnType<typeof w2> {
  const ss = Math.min(wages, 176100);
  const med6 = rd(D(wages).times("0.0145").plus(D(Math.max(0, wages - 200000)).times("0.009"))).toNumber();
  return w2({
    docId,
    // distinct employer per document: the excess Social Security credit needs distinct employers (round 2, D6)
    employer: `Employer ${docId}`,
    personUserId: person,
    wagesCents: wages * 100,
    fedWithheldCents: Math.round(wages * 0.15) * 100,
    socialSecurityWagesCents: ss * 100,
    socialSecurityWithheldCents: Math.round(ss * 0.062 * 100),
    medicareWagesCents: wages * 100,
    medicareWithheldCents: med6 * 100,
    ctWithheldCents: Math.round(wages * 0.03) * 100,
  });
}

function buildFacts(s: Scenario): Ty2025Facts {
  const f = fullFacts();
  f.income.w2s = [w2For("e1", ERIC_ID, s.ericW1), w2For("v1", EVA_ID, s.evaW)];
  if (s.ericW2nd > 0) f.income.w2s.push(w2For("e2", ERIC_ID, s.ericW2nd));
  f.income.interest = s.interest > 0 ? [{ ...fullFacts().income.interest[0]!, box1Cents: s.interest * 100 }] : [];
  f.income.noInterestConfirmed = s.interest > 0 ? { value: null, basis: null, refs: [] } : owner(true);
  f.income.dividends =
    s.ordDiv > 0
      ? [{ ...fullFacts().income.dividends[0]!, box1aCents: s.ordDiv * 100, box1bCents: s.qualDiv * 100 }]
      : [];
  f.income.noDividendsConfirmed = s.ordDiv > 0 ? { value: null, basis: null, refs: [] } : owner(true);
  const gl = fullFacts().income.scheduleC.glLines;
  f.income.scheduleC.glLines = [
    { ...gl[0]!, totalCents: s.revenue * 100 },
    { ...gl[1]!, totalCents: s.softwareExp * 100 },
    { glCodeId: "id-meals", code: "5900", name: "Meals", glType: "expense", totalCents: s.mealsExp * 100 },
  ];
  f.deductions.mortgages[0]!.interestCents = s.mortgageInterest * 100;
  f.deductions.propertyTaxBills = [bill({ docId: "pt-1", label: "Town", address: "27 Old Barry Rd", paidInYearCents: s.propTaxPaid * 100, kind: "primary_residence" })];
  return f;
}

interface RefOut {
  skip: string | null;
  agi: number;
  ti: number;
  totalTax: number;
  totalPayments: number;
  balance: number; // positive = owe
  ctAgi: number;
  ctTax: number | null; // null = CT AGI <= 102,000 (engine defers)
  ctBalance: number | null;
}

function reference(s: Scenario): RefOut {
  const R = rd;
  const wagesAll = s.ericW1 + s.ericW2nd + s.evaW;
  const interest = s.interest;
  const ordDiv = s.ordDiv;
  const qd = s.qualDiv;
  const meals = R(D(s.mealsExp).times("0.5")).toNumber();
  const netProfit = s.revenue - s.softwareExp - meals;
  // Schedule SE (owner Eric, SS wages = box 3 of his W-2s)
  const ericSs = Math.min(s.ericW1, 176100) + (s.ericW2nd > 0 ? Math.min(s.ericW2nd, 176100) : 0);
  let seTax = D(0);
  let se6 = D(0);
  const l4a = netProfit > 0 ? R(D(netProfit).times("0.9235")) : D(netProfit);
  if (l4a.greaterThanOrEqualTo(400)) {
    se6 = l4a;
    const l9 = Decimal.max(0, D(176100).minus(ericSs));
    const l10 = l9.lessThanOrEqualTo(0) ? D(0) : R(Decimal.min(l4a, l9).times("0.124"));
    seTax = l10.plus(R(l4a.times("0.029")));
  }
  const half = R(seTax.div(2));
  // Form 8959
  const box5 = [s.ericW1, ...(s.ericW2nd > 0 ? [s.ericW2nd] : []), s.evaW];
  const largest = Math.max(...box5);
  const l1 = wagesAll;
  const l7 = R(D(Math.max(0, l1 - 250000)).times("0.009"));
  const l11 = Math.max(0, 250000 - l1);
  const l13 = R(D(Math.max(0, se6.toNumber() - l11)).times("0.009"));
  const req8959 = largest > 200000 || l1 + se6.toNumber() > 250000;
  const addl = req8959 ? l7.plus(l13) : D(0);
  const med6 = box5.reduce((a, w) => a + R(D(w).times("0.0145").plus(D(Math.max(0, w - 200000)).times("0.009"))).toNumber(), 0);
  const addlWithheld = req8959 ? Decimal.max(0, D(med6).minus(R(D(l1).times("0.0145")))) : D(0);
  // AGI
  const totalIncome = wagesAll + interest + ordDiv + netProfit;
  const agi = totalIncome - half.toNumber();
  // Schedule A
  const ctWh = [s.ericW1, ...(s.ericW2nd > 0 ? [s.ericW2nd] : []), s.evaW].reduce((a, w) => a + Math.round(w * 0.03), 0);
  const cap = Math.max(40000 - R(D(Math.max(0, agi - 500000)).times("0.3")).toNumber(), 10000);
  const salt = Math.min(ctWh + s.propTaxPaid, cap);
  const itemized = salt + s.mortgageInterest;
  const itemizes = itemized > 31500;
  const ded = itemizes ? itemized : 31500;
  const tiBefore = Math.max(0, agi - ded);
  // QBI
  if (tiBefore > 394600) return { skip: "QBI 8995-A territory", agi, ti: 0, totalTax: 0, totalPayments: 0, balance: 0, ctAgi: agi, ctTax: null, ctBalance: null };
  const qbiBase = netProfit - half.toNumber();
  const l5 = R(D(Math.max(0, qbiBase)).times("0.2"));
  const l14 = R(D(Math.max(0, tiBefore - qd)).times("0.2"));
  const qbi = Decimal.min(l5, l14).toNumber();
  const ti = Math.max(0, agi - ded - qbi);
  // tax
  let tax: Decimal;
  if (qd > 0) {
    // QDCG worksheet (reference)
    const l5w = Math.max(0, ti - qd);
    const l7w = Math.min(ti, 96700);
    const l8w = Math.min(l5w, l7w);
    const l9w = l7w - l8w;
    const l10w = Math.min(ti, qd);
    const l12w = l10w - l9w;
    const l14w = Math.min(ti, 600050);
    const l16w = Math.max(0, l14w - (l5w + l9w));
    const l17w = Math.min(l12w, l16w);
    const l20w = l10w - (l9w + l17w);
    const l23 = R(D(l17w).times("0.15").plus(D(l20w).times("0.2")).plus(refTax(D(l5w))));
    tax = Decimal.min(l23, R(refTax(D(ti))));
  } else {
    tax = R(refTax(D(ti)));
  }
  // NIIT (Form 8960) and the AMT screen. Part II line 9b (itemizers): the state income tax deducted on Schedule A (CT withholding) is allocated
  // to investment income by the ratio of line 8 to AGI (the Form 8960 instructions' example method); when the SALT cap binds the instructions do
  // not say how to split it, so the engine hands line 9b to the CPA and the case is skipped.
  const nii = interest + ordDiv;
  if (agi > 250000 && itemizes && nii > 0 && ctWh + s.propTaxPaid > cap) return { skip: "NIIT line 9b under the SALT cap", agi, ti: 0, totalTax: 0, totalPayments: 0, balance: 0, ctAgi: agi, ctTax: null, ctBalance: null };
  const l9b = agi > 250000 && itemizes && nii > 0 ? R(D(ctWh).times(Math.min(nii, agi)).div(agi)).toNumber() : 0;
  const niit = agi > 250000 ? R(D(Math.min(Math.max(0, nii - l9b), agi - 250000)).times("0.038")) : D(0);
  const amti = ti + (itemizes ? salt : 31500);
  if (amti > 1252700) return { skip: "AMT phase-out", agi, ti, totalTax: 0, totalPayments: 0, balance: 0, ctAgi: agi, ctTax: null, ctBalance: null };
  const ex = amti - 137000 > 0 ? amti - 137000 : 0;
  const tmt = R(D(Math.min(ex, 239100)).times("0.26").plus(D(Math.max(0, ex - 239100)).times("0.28")));
  if (tmt.greaterThan(tax)) return { skip: "AMT applies", agi, ti, totalTax: 0, totalPayments: 0, balance: 0, ctAgi: agi, ctTax: null, ctBalance: null };
  const totalTax = tax.plus(seTax).plus(addl).plus(niit);
  // payments
  const fedWh = box5.reduce((a, w) => a + Math.round(w * 0.15), 0);
  let excessSs = D(0);
  const maxSs = D("10918.20");
  if (s.ericW2nd > 0) {
    const wh = Math.round(Math.min(s.ericW1, 176100) * 0.062 * 100) / 100 + Math.round(Math.min(s.ericW2nd, 176100) * 0.062 * 100) / 100;
    excessSs = excessSs.plus(Decimal.max(0, D(wh).minus(maxSs)));
  }
  const payments = D(fedWh).plus(addlWithheld).plus(R(excessSs));
  // CT
  const ctAgi = agi;
  let ctTax: number | null = null;
  let ctBalance: number | null = null;
  if (ctAgi > 102000) {
    ctTax = R(refCtTax(ctAgi)).toNumber();
    const decimal = ctAgi <= 70500 ? 0 : ctAgi <= 80500 ? 0.15 : ctAgi <= 90500 ? 0.3 : ctAgi <= 100500 ? 0.45 : ctAgi <= 110500 ? 0.6 : ctAgi <= 120500 ? 0.75 : ctAgi <= 130500 ? 0.9 : 1;
    let credit = decimal >= 1 ? D(0) : R(D(Math.min(s.propTaxPaid, 300)).times(D(1).minus(decimal)));
    credit = Decimal.min(credit, ctTax);
    ctBalance = D(ctTax).minus(credit).minus(ctWh).toNumber();
  }
  return {
    skip: null,
    agi,
    ti,
    totalTax: totalTax.toNumber(),
    totalPayments: payments.toNumber(),
    balance: totalTax.minus(payments).toNumber(),
    ctAgi,
    ctTax,
    ctBalance,
  };
}

function num(r: Ty2025Return, k: LineKey): number | null {
  const l = r.lines[k];
  return l && hasAmount(l.status) ? l.amount : null;
}

describe("Tester oracle: end-to-end differential vs a reference written from the printed forms", () => {
  it("hand-computed golden fixture (fullFacts): AGI 177,967, taxable income 137,174, total tax 27,015, CT tax 8,788", () => {
    const r = computeTy2025Return(fullFacts());
    expect(r.headline.complete).toBe(true);
    expect(r.headline.federal.agi.amount).toBe(177967);
    expect(r.headline.federal.taxableIncome.amount).toBe(137174);
    expect(r.headline.federal.totalTax.amount).toBe(27015);
    expect(r.headline.connecticut.tax.amount).toBe(8788);
  });

  it("matches the reference on 1,500 random MFJ households (SE, 8959, NIIT, SALT cap, itemize-or-standard, QBI, QDCG, excess SS, CT)", () => {
    const rnd = mulberry32(4242);
    let compared = 0;
    let skipped = 0;
    const pick = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo));
    for (let i = 0; i < 1500; i++) {
      const hi = i % 4 === 0;
      const s: Scenario = {
        ericW1: pick(0, hi ? 450000 : 160000),
        ericW2nd: i % 5 === 0 ? pick(5000, 120000) : 0,
        evaW: pick(0, hi ? 300000 : 120000),
        interest: i % 3 === 0 ? 0 : pick(0, 20000),
        ordDiv: i % 2 === 0 ? 0 : pick(1, 30000),
        qualDiv: 0,
        revenue: pick(0, hi ? 400000 : 150000),
        softwareExp: pick(0, 30000),
        mealsExp: pick(0, 6000),
        mortgageInterest: pick(0, 45000),
        propTaxPaid: pick(1000, 25000),
      };
      s.qualDiv = s.ordDiv > 0 ? pick(0, s.ordDiv + 1) : 0;
      if (s.ericW1 === 0) s.ericW1 = 1000; // keep a W-2 with wages
      const ref = reference(s);
      const ret = computeTy2025Return(buildFacts(s));
      if (ref.skip !== null) {
        skipped++;
        expect(ret.headline.complete, `scenario ${i} (${ref.skip}) must not claim a complete return`).toBe(false);
        continue;
      }
      compared++;
      const ctx = JSON.stringify(s);
      expect(num(ret, "f1040.11a"), `AGI ${ctx}`).toBe(ref.agi);
      expect(num(ret, "f1040.15"), `TI ${ctx}`).toBe(ref.ti);
      expect(num(ret, "f1040.24"), `total tax ${ctx}`).toBe(ref.totalTax);
      expect(num(ret, "f1040.33"), `payments ${ctx}`).toBe(ref.totalPayments);
      const owe = num(ret, "f1040.37");
      const over = num(ret, "f1040.34");
      expect(owe! - over!, `balance ${ctx}`).toBe(ref.balance);
      if (ref.ctTax !== null) {
        expect(num(ret, "ct1040.6"), `CT tax ${ctx}`).toBe(ref.ctTax);
        expect(num(ret, "ct1040.balance"), `CT balance ${ctx}`).toBe(ref.ctBalance);
        expect(ret.headline.complete, `complete ${ctx}`).toBe(true);
      }
    }
    expect(compared).toBeGreaterThan(900);
    expect(skipped + compared).toBe(1500);
  });
});

// ── No silent zero ──────────────────────────────────────────────────────────────

function assertExplicit(ret: Ty2025Return, label: string): void {
  for (const k of LINE_KEYS) {
    const l = ret.lines[k];
    if (!l) throw new Error(`${label}: LineKey ${k} has no line`);
    if (typeof l.status !== "string") throw new Error(`${label}: ${k} has no status`);
    if (hasAmount(l.status)) {
      if (l.amount === null || !Number.isInteger(l.amount)) throw new Error(`${label}: ${k} ${l.status} without an integer amount (${String(l.amount)})`);
      if (l.status === "not_applicable" && !l.reason) throw new Error(`${label}: ${k} not_applicable without a reason`);
    } else {
      if (l.amount !== null) throw new Error(`${label}: ${k} blocked (${l.status}) but has an amount`);
      if (!l.reason || l.reason.trim() === "") throw new Error(`${label}: ${k} blocked (${l.status}) without a reason`);
    }
  }
}

type Mutator = [string, (f: Ty2025Facts) => void];
const MUTATORS: Mutator[] = [
  ["filing status missing", (f) => { f.household.filingStatus = { value: null, basis: null, refs: [] }; }],
  ["no dependents unknown", (f) => { f.household.noDependents = { value: null, basis: null, refs: [] }; }],
  ["dependents exist", (f) => { f.household.noDependents = owner(false); }],
  ["all W-2s removed", (f) => { f.income.w2s = []; }],
  ["W-2 without person", (f) => { f.income.w2s[0]!.personUserId = null; }],
  ["W-2 box 3 unread", (f) => { f.income.w2s[0]!.socialSecurityWagesCents = null; }],
  ["W-2 box 5 unread", (f) => { f.income.w2s[1]!.medicareWagesCents = null; }],
  ["W-2 box 6 unread", (f) => { f.income.w2s[1]!.medicareWithheldCents = null; }],
  ["W-2 box 2 unread", (f) => { f.income.w2s[0]!.fedWithheldCents = null; }],
  ["W-2 box 17 unread", (f) => { f.income.w2s[1]!.ctWithheldCents = null; }],
  ["W-2 box 4 unread w/ 2 employers", (f) => { if (f.income.w2s.length === 0) return; f.income.w2s.push({ ...f.income.w2s[0]!, docId: "x", employer: "A second employer", employerEin: "99-9999999", socialSecurityWithheldCents: null }); }],
  ["other-state withholding", (f) => { f.income.w2s[0]!.stateLines = [{ stateCode: "NY", wagesCents: 100, withheldCents: 500 }]; }],
  ["interest docs removed, none not confirmed", (f) => { f.income.interest = []; f.income.noInterestConfirmed = { value: null, basis: null, refs: [] }; }],
  ["dividend docs removed", (f) => { f.income.dividends = []; f.income.noDividendsConfirmed = { value: null, basis: null, refs: [] }; }],
  ["dividend box 1b unread", (f) => { f.income.dividends[0]!.box1bCents = null; }],
  ["1099-B present", (f) => { f.income.otherIncomeBoxes = [{ docId: "b", payer: "Broker", basis: "doc_verified", variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 100000 }]; }],
  ["1099-R present", (f) => { f.income.otherIncomeBoxes = [{ docId: "r", payer: "Plan", basis: "doc_verified", variant: "1099-R", box: "2a", label: "Taxable", amountCents: 100000 }]; }],
  ["unmapped GL account", (f) => { f.income.scheduleC.glLines.push({ glCodeId: "z", code: "9", name: "Totally Unknown Acct", glType: "expense", totalCents: 12345 }); }],
  ["needs-CPA GL account", (f) => { f.income.scheduleC.glLines.push({ glCodeId: "z", code: "9", name: "Uncategorized Income", glType: "revenue", totalCents: 12345 }); }],
  ["COGS balance", (f) => { f.income.scheduleC.glLines.push({ glCodeId: "z", code: "9", name: "Cost of goods sold", glType: "expense", totalCents: 5000 }); }],
  ["books empty", (f) => { f.income.scheduleC.glLines = []; f.income.scheduleC.booksEmpty = true; }],
  ["owner unknown", (f) => { f.income.scheduleC.ownerUserId = { value: null, basis: null, refs: [] }; }],
  ["mileage none unconfirmed", (f) => { f.income.scheduleC.mileageNoneConfirmed = { value: null, basis: null, refs: [] }; }],
  ["mileage entries + none answer", (f) => { f.income.scheduleC.mileage = [{ miles: 100, ratePerMile: "0.700", dateIso: "2025-03-01" }]; }],
  ["vehicle expenses booked", (f) => { f.income.scheduleC.glLines.push({ glCodeId: "z", code: "9", name: "Vehicle expenses:Vehicle gas & fuel", glType: "expense", totalCents: 5000 }); }],
  ["fixed assets unconfirmed", (f) => { f.income.scheduleC.fixedAssetsNoneConfirmed = false; }],
  ["fixed asset on register", (f) => { f.income.scheduleC.fixedAssets = [{ id: "a", description: "Laptop", placedInServiceIso: "2025-05-01", costBasisCents: 200000, isRealProperty: false, landValueCents: null, businessUsePercent: 100 }]; }],
  ["home office unanswered", (f) => { f.income.scheduleC.homeOfficeEligibility = { value: null, basis: null, refs: [] }; }],
  ["home office yes, sqft missing", (f) => { f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive"); }],
  ["stated none: se_other missing", (f) => { delete f.statedNone.se_other; }],
  ["stated none: qbi_carryforwards missing", (f) => { delete f.statedNone.qbi_carryforwards; }],
  ["stated none: medical_expenses missing", (f) => { delete f.statedNone.medical_expenses; }],
  ["stated none: all missing", (f) => { f.statedNone = {}; }],
  ["sch1a unstated", (f) => { f.adjustments.sch1a = { value: null, basis: null, refs: [] }; }],
  ["se health unstated", (f) => { f.adjustments.seHealthInsurance = { value: null, basis: null, refs: [] }; }],
  ["se retirement unstated", (f) => { f.adjustments.seRetirement = { value: null, basis: null, refs: [] }; }],
  ["se health 5,000 stated", (f) => { f.adjustments.seHealthInsurance = owner(500000); }],
  ["foreign tax unstated", (f) => { f.credits.foreignTax = { value: null, basis: null, refs: [] }; }],
  ["no 1098", (f) => { f.deductions.mortgages = []; }],
  ["1098 points", (f) => { f.deductions.mortgages[0]!.pointsCents = 100000; }],
  ["1098 box 2 > 750k", (f) => { f.deductions.mortgages[0]!.principalCents = 80_000_000; }],
  ["1098 interest unread", (f) => { f.deductions.mortgages[0]!.interestCents = null; }],
  ["no property bills, none unconfirmed", (f) => { f.deductions.propertyTaxBills = []; }],
  ["property bill unpaid", (f) => { f.deductions.propertyTaxBills[0]!.paidInYearCents = null; }],
  ["property bill unclassified", (f) => { f.deductions.propertyTaxBills[0]!.kind = "unclassified"; }],
  ["Arbor Rd bill unpaid", (f) => { f.deductions.propertyTaxBills.push(bill({ docId: "arb", label: "56 Arbor Rd", address: "56 Arbor Rd", paidInYearCents: null, kind: "other_real_estate" })); }],
  ["Arbor Rd bill paid", (f) => { f.deductions.propertyTaxBills.push(bill({ docId: "arb", label: "56 Arbor Rd", address: "56 Arbor Rd", paidInYearCents: 900000, kind: "other_real_estate" })); }],
  ["donations unconfirmed", (f) => { f.deductions.noDonationsConfirmed = { value: null, basis: null, refs: [] }; }],
  ["big donation", (f) => { f.deductions.noDonationsConfirmed = { value: null, basis: null, refs: [] }; f.deductions.donations = [{ id: "d", dateIso: "2025-01-01", recipient: "X", kind: "cash", amountCents: 9_000_000, substantiation: "none", receiptDocumentId: null }]; }],
  ["noncash donation over 500", (f) => { f.deductions.noDonationsConfirmed = { value: null, basis: null, refs: [] }; f.deductions.donations = [{ id: "d", dateIso: "2025-01-01", recipient: "X", kind: "noncash", amountCents: 80_000, substantiation: "none", receiptDocumentId: null }]; }],
  ["fed estimates unknown", (f) => { f.payments.federalEstimates = { value: null, basis: null, refs: [] }; }],
  ["fed extension unknown", (f) => { f.payments.federalExtensionPayment = { value: null, basis: null, refs: [] }; }],
  ["ct estimates unknown", (f) => { f.payments.ctEstimates = { value: null, basis: null, refs: [] }; }],
  ["ct extension unknown", (f) => { f.payments.ctExtensionPayment = { value: null, basis: null, refs: [] }; }],
  ["ct prior balance unknown", (f) => { f.payments.ctPriorYearBalancePaidIn2025 = { value: null, basis: null, refs: [] }; }],
  ["combined estimates answer only", (f) => { f.payments.federalEstimates = { value: null, basis: null, refs: [] }; f.payments.ctEstimates = { value: null, basis: null, refs: [] }; f.payments.combinedEstimatesAnswer = owner(500000); }],
  ["use tax unanswered", (f) => { f.ct.useTax = { value: null, basis: null, refs: [] }; }],
  ["ct additions unknown", (f) => { f.ct.additions = { value: null, basis: null, refs: [] }; }],
  ["ct additions 5,000", (f) => { f.ct.additions = owner(500000); }],
];

describe("Tester: no silent zero / never throws", () => {
  it("empty-ish facts: never throws and every catalog LineKey has an explicit status with a reason when blocked", () => {
    const f = fullFacts();
    f.income.w2s = [];
    f.income.interest = [];
    f.income.dividends = [];
    f.income.scheduleC.glLines = [];
    f.income.scheduleC.booksEmpty = true;
    f.deductions.mortgages = [];
    f.deductions.propertyTaxBills = [];
    f.statedNone = {};
    const ret = computeTy2025Return(f);
    assertExplicit(ret, "emptied");
    expect(ret.headline.complete).toBe(false);
  });

  it("each single mutation of a complete return: no throw, all keys explicit, and never 'complete' with different headline numbers", () => {
    const base = computeTy2025Return(fullFacts());
    expect(base.headline.complete).toBe(true);
    const keyNumbers = (r: Ty2025Return) => JSON.stringify([r.headline.federal, r.headline.connecticut].map((h) => Object.values(h).map((x) => (typeof x === "object" && x ? (x as { amount: number | null }).amount : x))));
    const baseNums = keyNumbers(base);
    const silent: string[] = [];
    for (const [name, mut] of MUTATORS) {
      const f = structuredClone(fullFacts());
      mut(f);
      let ret: Ty2025Return;
      try {
        ret = computeTy2025Return(f);
      } catch (e) {
        throw new Error(`mutation "${name}" threw: ${(e as Error).message}`);
      }
      assertExplicit(ret, name);
      const nums = keyNumbers(ret);
      if (ret.headline.complete && nums !== baseNums) silent.push(`${name}: complete with changed numbers`);
      // a change in what the owner told us can only be reflected as blocked lines or different, fully computed numbers
      if (!ret.headline.complete) {
        for (const h of [...Object.values(ret.headline.federal), ...Object.values(ret.headline.connecticut)]) {
          if (h.amount === null && !(h.reason && h.reason.length > 0)) silent.push(`${name}: blocked headline amount without reason`);
        }
      }
    }
    // Mutations that legitimately change the numbers while staying complete (the engine had the data to compute them)
    const legit = ["se health 5,000 stated: complete with changed numbers", "ct additions 5,000: complete with changed numbers", "Arbor Rd bill paid: complete with changed numbers", "dependents exist: complete with changed numbers"];
    const unexpected = silent.filter((s) => !legit.includes(s));
    expect(unexpected).toEqual([]);
  });

  it("2,000 random multi-mutation facts: never throws; every key explicit", () => {
    const rnd = mulberry32(555);
    for (let i = 0; i < 2000; i++) {
      const f = structuredClone(fullFacts());
      const n = 1 + Math.floor(rnd() * 5);
      const names: string[] = [];
      for (let k = 0; k < n; k++) {
        const [name, mut] = MUTATORS[Math.floor(rnd() * MUTATORS.length)]!;
        names.push(name);
        try {
          mut(f);
        } catch {
          // a mutator that indexes a list an earlier mutator emptied is skipped
        }
      }
      let ret: Ty2025Return;
      try {
        ret = computeTy2025Return(f);
      } catch (e) {
        throw new Error(`mutations [${names.join(" | ")}] threw: ${(e as Error).message}`);
      }
      assertExplicit(ret, names.join(" | "));
    }
  });

  it("non-MFJ filing status is refused with explicit lines, not computed", () => {
    const f = fullFacts();
    f.household.filingStatus = owner("single");
    const ret = computeTy2025Return(f);
    assertExplicit(ret, "single");
    expect(ret.headline.complete).toBe(false);
    expect(ret.headline.federal.totalTax.amount).toBeNull();
  });

  it("every emitted amount is an integer across the random differential scenarios (floats never leak)", () => {
    const rnd = mulberry32(8);
    for (let i = 0; i < 200; i++) {
      const s: Scenario = { ericW1: 1000 + Math.floor(rnd() * 400000), ericW2nd: i % 3 === 0 ? 20000 : 0, evaW: Math.floor(rnd() * 200000), interest: Math.floor(rnd() * 3000), ordDiv: Math.floor(rnd() * 3000), qualDiv: 0, revenue: Math.floor(rnd() * 200000), softwareExp: 777, mealsExp: 1235, mortgageInterest: 18883, propTaxPaid: 6001 };
      const ret = computeTy2025Return(buildFacts(s));
      for (const l of Object.values(ret.lines)) if (l && hasAmount(l.status)) expect(Number.isInteger(l.amount), `${l.key}`).toBe(true);
      expect(roundLine(D("1.5")).toNumber()).toBe(2);
    }
  });
});

// ── Purity: transitive import graph of lib/tax2025 ──────────────────────────────
//
// Scope decision (T9): the purity guarantee is about the RULES: the engine that computes the return must
// stay free of db / fs / network / server modules and must never depend on the PDF layer. The PDF layer
// (lib/tax2025/pdf/**) is a separate, one-way consumer of the engine: it legitimately imports pdf-lib and
// fflate and, in exactly two files, node:fs / node:path / node:crypto (blank-form registry + fingerprint).
// So there are two walks with two allowlists. The rules walk is NOT weakened: it starts from every
// lib/tax2025 file outside pdf/, may not enter lib/tax2025/pdf/** at all, and its external set is still
// exactly {@prisma/client/runtime/library, zod}. The PDF walk keeps the db / network / server bans and
// pins the node built-ins to the files that need them.

describe("Tester: lib/tax2025 transitive import graph is free of db / fs / network / server modules", () => {
  const ROOT = path.resolve(__dirname, "..", "..");
  const FORBIDDEN = [/^@\/lib\/db$/, /^@prisma\/client$/, /^next(\/|$)/, /^node:/, /^(fs|path|http|https|net|child_process|crypto)$/, /^@supabase\//, /^@anthropic-ai\//, /^plaid/, /^axios$/, /^@\/lib\/(reports|entity|auth|supabase|plaid|encrypt|tax-compute-build|tax-extraction-policy|fixed-assets)/];
  const PDF_DIR = path.join(ROOT, "lib", "tax2025", "pdf") + path.sep;
  function resolveImport(from: string, spec: string): string | null {
    const base = spec.startsWith("@/") ? path.join(ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (base === null) return null;
    if (spec.endsWith(".json")) return base;
    // a directory import resolves to its index.ts (e.g. "@/lib/tax2025/pdf/maps")
    return fs.existsSync(`${base}.ts`) || !fs.existsSync(path.join(base, "index.ts")) ? `${base}.ts` : path.join(base, "index.ts");
  }
  function listTs(d: string, skip: (p: string) => boolean): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (skip(p)) continue;
      if (e.isDirectory()) out.push(...listTs(p, skip));
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  }
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  }
  /** Every file reachable from `roots` (static, dynamic, require), plus the external specifiers met on the way. */
  function walkImports(roots: string[]): { seen: Set<string>; external: Set<string>; edges: Map<string, string[]> } {
    const seen = new Set<string>();
    const external = new Set<string>();
    const edges = new Map<string, string[]>();
    const stack = [...roots];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (f.endsWith(".json")) continue;
      const src = stripComments(fs.readFileSync(f, "utf8"));
      const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const s of specs) {
        const r = resolveImport(f, s);
        if (r !== null) {
          if (!fs.existsSync(r)) throw new Error(`unresolvable import ${s} in ${f}`);
          const list = edges.get(f) ?? [];
          list.push(r);
          edges.set(f, list);
          stack.push(r);
        } else external.add(s);
      }
    }
    return { seen, external, edges };
  }

  it("rules: walks every import (static, dynamic, require) reachable from lib/tax2025/** outside pdf/**", () => {
    const roots = listTs(path.join(ROOT, "lib", "tax2025"), (p) => (p + path.sep).startsWith(PDF_DIR));
    expect(roots.length).toBeGreaterThan(10);
    const { seen, external } = walkImports(roots);
    // One-way dependency: the rules never reach the PDF layer.
    for (const f of seen) expect(f.startsWith(PDF_DIR), `rules reach the PDF layer: ${f}`).toBe(false);
    for (const e of external) for (const re of FORBIDDEN) expect(re.test(e), `forbidden external import ${e}`).toBe(false);
    for (const f of seen) {
      const rel = path.relative(ROOT, f).replace(/\\/g, "/");
      expect(/lib\/(db|reports|entity|auth|tax-compute-build|tax-extraction-policy)\.ts$/.test(rel), `engine reaches ${rel}`).toBe(false);
    }
    expect([...external].sort()).toEqual(["@prisma/client/runtime/library", "zod"]);
    // no floating-point money idioms anywhere in the engine
    for (const f of seen.values()) {
      if (!f.includes(`${path.sep}tax2025${path.sep}`)) continue;
      const src = stripComments(fs.readFileSync(f, "utf8"));
      expect(/parseFloat\s*\(|Number\s*\(\s*["'`]|Math\.(round|floor|ceil|trunc)\s*\(/.test(src), `float idiom in ${path.basename(f)}`).toBe(false);
    }
  });

  it("pdf layer: no db / network / server modules; node built-ins only in the two files that need them", () => {
    const roots = listTs(PDF_DIR, () => false);
    expect(roots.length).toBeGreaterThan(10);
    const { seen, external } = walkImports(roots);
    for (const f of seen) {
      const rel = path.relative(ROOT, f).replace(/\\/g, "/");
      expect(/lib\/(db|reports|entity|auth|tax-compute-build|tax-extraction-policy)\.ts$/.test(rel), `pdf layer reaches ${rel}`).toBe(false);
      expect(rel.startsWith("lib/tax2025-pdf-"), `pdf layer reaches the DB wiring ${rel}`).toBe(false);
    }
    const NODE_BUILTIN = /^(node:|fs$|path$|crypto$)/;
    const NETWORK_OR_SERVER = [/^@\/lib\/db$/, /^@prisma\/client$/, /^next(\/|$)/, /^(http|https|net|child_process)$/, /^node:(http|https|net|child_process|dns|tls)$/, /^@supabase\//, /^@anthropic-ai\//, /^plaid/, /^axios$/, /^@\/lib\/(reports|entity|auth|supabase|plaid|encrypt|tax-compute-build|tax-extraction-policy|fixed-assets)/];
    for (const e of external) for (const re of NETWORK_OR_SERVER) expect(re.test(e), `forbidden external import ${e} in the PDF layer`).toBe(false);
    expect([...external].filter((e) => !NODE_BUILTIN.test(e)).sort()).toEqual(["@prisma/client/runtime/library", "fflate", "pdf-lib", "zod"]);
    // node:fs / node:path / node:crypto are pinned to the files that need them.
    const allowedBuiltins: Record<string, string[]> = {
      "lib/tax2025/pdf/registry.ts": ["node:crypto", "node:fs", "node:path"],
      "lib/tax2025/pdf/format.ts": ["node:crypto"],
    };
    for (const f of seen) {
      if (f.endsWith(".json")) continue;
      const rel = path.relative(ROOT, f).replace(/\\/g, "/");
      const src = stripComments(fs.readFileSync(f, "utf8"));
      const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!).filter((s) => NODE_BUILTIN.test(s));
      expect(specs.sort(), `node built-ins in ${rel}`).toEqual((allowedBuiltins[rel] ?? []).slice().sort());
    }
  });
});

// ── resolveFacts: conflicts, per-person split, precedence ───────────────────────

import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";

function rawInputs(docs: RawDocument[], planning: Partial<RawTy2025Inputs["planning"]> = {}): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people: [{ userId: ERIC_ID, name: "Eric" }, { userId: EVA_ID, name: "Eva" }],
    scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "name match" },
    documents: docs,
    planning: {
      filingStatus: "mfj", householdMembers: "none", evVehicle: "no", businessMileage: "no", homeOfficeEligibility: "no", homeOfficeSqft: null,
      solarCredit: "claimed_already", donationsNone: true, fixedAssetsEkcNone: true, retirementContributionCents: null, estimatedPaymentsCombinedCents: null,
      ...planning,
    },
    primaryResidence: { address: "27 Old Barry Rd", basis: "answer_owner" },
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  };
}
function w2Doc(id: string, person: string | null, over: Record<string, unknown> = {}, verified = true): RawDocument {
  return {
    id, docType: "w2", taxYear: 2025, extractionStatus: "complete", verified, legacyFormat: false,
    subjectType: person === null ? "joint" : "person", subjectUserId: person,
    extractionData: { data: { wagesCents: 9_000_000, federalWithheldCents: 1_000_000, employerName: `Emp ${id}`, socialSecurityWagesCents: 9_000_000, socialSecurityWithheldCents: 558_000, medicareWagesCents: 9_000_000, medicareWithheldCents: 130_500, stateLines: [], ...over } },
  };
}

describe("Tester: resolveFacts", () => {
  it("acceptance 10: a $5,000 retirement answer vs W-2 box 12 codes totalling $23,000 is a conflict listing both values (nothing silently chosen)", () => {
    const r = resolveFacts(rawInputs([w2Doc("a", ERIC_ID, { box12: [{ code: "D", amountCents: 2_000_000 }, { code: "W", amountCents: 300_000 }] })], { retirementContributionCents: 500_000 }));
    const c = r.conflicts.find((x) => x.factKey === "adjustments.retirementContributions");
    expect(c).toBeDefined();
    expect(c!.candidates.map((x) => x.value).sort()).toEqual([500_000, 2_300_000].sort());
    expect(c!.chosen).toBeNull();
  });

  it("acceptance 9: the combined federal+state estimate answer is never used for either side and raises a blocking item", () => {
    const r = resolveFacts(rawInputs([], { estimatedPaymentsCombinedCents: 800_000 }));
    expect(r.openItems.find((o) => o.id === "estimates-combined-unsplittable")?.severity).toBe("blocking");
    expect(r.facts.payments.federalEstimates.value).toBeNull();
    expect(r.facts.payments.ctEstimates.value).toBeNull();
    const ret = computeTy2025Return(r.facts, {}, { conflicts: r.conflicts, openItems: r.openItems });
    expect(ret.lines["f1040.26"]?.status).toBe("missing_input");
    expect(ret.lines["ct1040.19"]?.status).toBe("missing_input");
  });

  it("per-person W-2 split drives SE: Eva's W-2s never reduce Eric's wage base, a joint (unassigned) W-2 blocks SE and the excess credit", () => {
    const base = fullFacts();
    base.income.w2s = [];
    const facts = resolveFacts(rawInputs([w2Doc("e", ERIC_ID, { socialSecurityWagesCents: 17_610_000, wagesCents: 17_610_000, medicareWagesCents: 17_610_000 }), w2Doc("v", EVA_ID)])).facts;
    expect(facts.income.w2s.find((w) => w.docId === "e")!.personUserId).toBe(ERIC_ID);
    expect(facts.income.w2s.find((w) => w.docId === "v")!.personUserId).toBe(EVA_ID);
    const unassigned = resolveFacts(rawInputs([w2Doc("j", null)]));
    expect(unassigned.openItems.find((o) => o.id === "w2-no-person:j")?.severity).toBe("blocking");
    const ret = computeTy2025Return(unassigned.facts, {}, { openItems: unassigned.openItems });
    expect(ret.lines["sch3.11"]?.status).toBe("missing_input");
    expect(ret.lines["se.12"]?.status).not.toBe("computed");
  });

  it("wages equal to the wage base: Medicare-only SE tax (acceptance 2); $150,000: base 26,100 (acceptance 2)", () => {
    const run = (ss: number) => {
      const f = fullFacts();
      f.income.w2s[0] = w2For("e1", ERIC_ID, ss);
      return computeTy2025Return(f);
    };
    const full = run(176100);
    expect(num(full, "se.9")).toBe(0);
    expect(num(full, "se.10")).toBe(0);
    expect(num(full, "se.12")).toBe(1339); // 46,175 x 2.9% = 1,339.08
    const part = run(150000);
    expect(num(part, "se.9")).toBe(26100);
    expect(num(part, "se.10")).toBe(3236); // 26,100 x 12.4% = 3,236.40
  });
});

describe("Tester: numeric extremes never throw and stay explicit", () => {
  it("1,500 random perturbations of every *Cents leaf (negative, zero, huge, odd cents) of a complete return", () => {
    const rnd = mulberry32(777);
    const values = [0, 1, -1, 99, 100, 12345, -500_000, 17_610_000, 99_999_999_999, 4_000_000_000_000, -4_000_000_000_000];
    const perturb = (o: unknown): void => {
      if (Array.isArray(o)) { o.forEach(perturb); return; }
      if (typeof o !== "object" || o === null) return;
      const rec = o as Record<string, unknown>;
      for (const k of Object.keys(rec)) {
        const v = rec[k];
        if (typeof v === "number" && Number.isInteger(v) && /Cents$/.test(k) && rnd() < 0.15) rec[k] = values[Math.floor(rnd() * values.length)]!;
        else if (typeof v === "object") perturb(v);
      }
    };
    for (let i = 0; i < 1500; i++) {
      const f = structuredClone(fullFacts());
      perturb(f);
      let ret: Ty2025Return;
      try {
        ret = computeTy2025Return(f);
      } catch (e) {
        throw new Error(`iteration ${i} threw: ${(e as Error).message}`);
      }
      assertExplicit(ret, `perturb ${i}`);
    }
  });
});

describe("Tester: resolveFacts + engine on junk extraction data", () => {
  it("2,000 documents with random junk extractionData (wrong types, NaN, floats, nulls, deep nesting) never throw, and every key stays explicit", () => {
    const rnd = mulberry32(31337);
    const junk = (depth = 0): unknown => {
      const r = rnd();
      if (r < 0.1) return null;
      if (r < 0.2) return "abc";
      if (r < 0.3) return [];
      if (r < 0.4) return Number.NaN;
      if (r < 0.5) return 12.5;
      if (r < 0.6) return Math.floor(rnd() * 10_000_000) * (rnd() < 0.2 ? -1 : 1);
      if (r < 0.7 || depth > 3) return rnd() < 0.5;
      if (r < 0.85) return Array.from({ length: Math.floor(rnd() * 3) }, () => junk(depth + 1));
      const o: Record<string, unknown> = {};
      for (const k of ["wagesCents", "federalWithheldCents", "socialSecurityWagesCents", "medicareWagesCents", "stateLines", "box12", "int_box1Cents", "div_box1aCents", "div_box1bCents", "otherBoxes", "interestCents", "principalBalanceCents", "paidInTaxYearCents", "propertyAddress", "taxType", "formVariant", "amountCents", "formType", "totalTaxCents", "agiCents"]) {
        if (rnd() < 0.5) o[k] = junk(depth + 1);
      }
      return o;
    };
    const types = ["w2", "1099", "mortgage_interest", "form_1098", "property_tax", "tax_return", "k1", "donation_receipt", "other"];
    for (let i = 0; i < 2000; i++) {
      const docs: RawDocument[] = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, j) => ({
        id: `d${i}-${j}`,
        docType: types[Math.floor(rnd() * types.length)]!,
        taxYear: rnd() < 0.8 ? 2025 : 2024,
        extractionStatus: "complete",
        verified: rnd() < 0.5,
        legacyFormat: rnd() < 0.3,
        subjectType: rnd() < 0.5 ? "person" : "joint",
        subjectUserId: rnd() < 0.5 ? ERIC_ID : null,
        extractionData: rnd() < 0.8 ? { data: junk() } : junk(),
      }));
      let ret: Ty2025Return;
      try {
        const r = resolveFacts(rawInputs(docs));
        ret = computeTy2025Return(r.facts, {}, { conflicts: r.conflicts, openItems: r.openItems });
      } catch (e) {
        throw new Error(`junk iteration ${i} threw: ${(e as Error).message}`);
      }
      assertExplicit(ret, `junk ${i}`);
    }
  });
});

describe("Tester: CT property tax credit through the whole return (acceptance 8)", () => {
  it("credit = min(primary + two largest vehicles, 300) x (1 - decimal); Arbor Rd excluded; vehicles beyond two ignored; $0 above $130,500", () => {
    const decimalFor = (agi: number) => (agi <= 70500 ? 0 : agi <= 80500 ? 0.15 : agi <= 90500 ? 0.3 : agi <= 100500 ? 0.45 : agi <= 110500 ? 0.6 : agi <= 120500 ? 0.75 : agi <= 130500 ? 0.9 : 1);
    for (const evaW of [40_000, 55_000, 70_000, 85_000, 100_000]) {
      const f = fullFacts();
      f.income.w2s = [w2For("e1", ERIC_ID, 20_000), w2For("v1", EVA_ID, evaW)];
      f.income.scheduleC.glLines = fullFacts().income.scheduleC.glLines.map((g, i) => (i === 0 ? { ...g, totalCents: 3_000_000 } : { ...g, totalCents: 0 }));
      f.deductions.propertyTaxBills = [
        bill({ docId: "p", label: "Home", address: "27 Old Barry Rd", paidInYearCents: 400_000, kind: "primary_residence" }),
        bill({ docId: "v1", label: "Car A", paidInYearCents: 200_000, kind: "motor_vehicle", taxType: "motor_vehicle" }),
        bill({ docId: "v2", label: "Car B", paidInYearCents: 100_000, kind: "motor_vehicle", taxType: "motor_vehicle" }),
        bill({ docId: "v3", label: "Car C", paidInYearCents: 50_000, kind: "motor_vehicle", taxType: "motor_vehicle" }),
        bill({ docId: "arb", label: "56 Arbor Rd", address: "56 Arbor Rd", paidInYearCents: 900_000, kind: "other_real_estate" }),
      ];
      const ret = computeTy2025Return(f);
      const ctAgi = num(ret, "ct1040.ctAgi")!;
      const tax = num(ret, "ct1040.10")!;
      const dec = decimalFor(ctAgi);
      const want = ctAgi > 102000 ? Math.min(Math.round(300 * (1 - dec)), tax) : null;
      if (want === null) {
        expect(num(ret, "ct1040.6")).toBeNull();
        continue;
      }
      expect(num(ret, "ct1040.11"), `credit at CT AGI ${ctAgi}`).toBe(ctAgi > 130500 ? 0 : want);
    }
  });
});
