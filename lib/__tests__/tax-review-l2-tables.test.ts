// L2 oracle: tax tables and worksheets, checked against numbers printed in the 2025 IRS and Connecticut instructions (hand-worked examples)
// and against the Tester's independent transcriptions in lib/__tests__/fixtures/tester-oracles-2025.json (2,062 Tax Table rows; CT Tables C-E).
// Nothing here calls an engine function.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { K } from "@/lib/tax2025/constants";
import { bpOf, dollarsOfCents, roundDivInt, roundMulCents, roundMulDollars } from "@/lib/tax-review/l2/money";
import {
  ctPropertyTaxDecimalHundredths,
  ctTableA,
  ctTableBHundredthsOfCents,
  ctTableC,
  ctTableD,
  ctTableEHundredths,
  ctTaxCalculationSchedule,
  federalTaxCents,
  qdcgWorksheet,
  taxTableAmount,
  wholeDollars,
} from "@/lib/tax-review/l2/tables";

interface Fixture {
  taxTable: Record<string, [number, number]>;
  ctC: [number, number | null, number][];
  ctD: [number, number | null, number][];
  ctE: [number, number | null, number][];
}
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tester-oracles-2025.json"), "utf8")) as Fixture;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("L2 money helpers", () => {
  it("rounds half away from zero, on integers (no floats)", () => {
    expect(dollarsOfCents(49)).toBe(0);
    expect(dollarsOfCents(50)).toBe(1);
    expect(dollarsOfCents(99)).toBe(1);
    expect(dollarsOfCents(150)).toBe(2);
    expect(dollarsOfCents(-49)).toBe(0);
    expect(dollarsOfCents(-50)).toBe(-1);
    expect(dollarsOfCents(-150)).toBe(-2);
    expect(roundMulDollars(1339, 5000)).toBe(670); // 669.5 -> 670
    expect(roundMulDollars(46_175, 290)).toBe(1339); // 1,339.075
    expect(roundMulCents(100_000_00, 9235)).toBe(92_350);
    expect(roundDivInt(7, 2)).toBe(4);
    expect(roundDivInt(-7, 2)).toBe(-4);
    expect(bpOf(0.9235)).toBe(9235);
    expect(bpOf(0.0145)).toBe(145);
  });
});

describe("L2 Tax Table (Form 1040 instructions, married filing jointly)", () => {
  it("matches the printed example: taxable income $25,300 reads $2,562", () => {
    expect(taxTableAmount(25_300)).toBe(2562);
    expect(taxTableAmount(25_349)).toBe(2562);
    expect(taxTableAmount(25_350)).toBe(2568);
  });

  it("the first printed rows: 0-5 = 0, 5-15 = 1, 15-25 = 2, 25-50 = 4, 50-75 = 6", () => {
    expect([0, 4, 5, 14, 15, 24, 25, 49, 50, 74].map(taxTableAmount)).toEqual([0, 0, 1, 1, 2, 2, 4, 4, 6, 6]);
  });

  it("equals the Tester's independent 2,062-row transcription at the start, middle and last dollar of every row", () => {
    const starts = Object.keys(FIXTURE.taxTable).map(Number);
    expect(starts.length).toBe(2062);
    for (const start of starts) {
      const [end, tax] = FIXTURE.taxTable[String(start)]!;
      for (const ti of [start, Math.floor((start + end) / 2), end - 1]) {
        if (taxTableAmount(ti) !== tax) throw new Error(`taxable income ${ti}: oracle ${taxTableAmount(ti)} vs printed row ${start}-${end} = ${tax}`);
      }
    }
  });

  it("rows named by the Tester: 95,000 = 10,926; 98,049 = 11,394; 99,999 = 11,823", () => {
    expect(taxTableAmount(95_000)).toBe(10_926);
    expect(taxTableAmount(98_049)).toBe(11_394);
    expect(taxTableAmount(99_999)).toBe(11_823);
  });
});

describe("L2 Tax Computation Worksheet, Section B (married filing jointly)", () => {
  it("(a) x (b) - (d) at $100,000: 22% x 100,000 - 10,172 = 11,828", () => {
    expect(federalTaxCents(100_000)).toBe(1_182_800);
  });

  it("is continuous at every printed bracket edge and equals the progressive brackets (hand-worked)", () => {
    // 10% of 23,850 + 12% of (96,950 - 23,850) + 22% of (206,700 - 96,950) = 2,385 + 8,772 + 24,145 = 35,302
    expect(federalTaxCents(206_700)).toBe(3_530_200);
    expect(federalTaxCents(206_701)).toBe(3_530_224); // 24% x 206,701 - 14,306.00 = 35,302.24
    // + 24% of (394,600 - 206,700) = 45,096 -> 80,398
    expect(federalTaxCents(394_600)).toBe(8_039_800);
    // + 32% of (501,050 - 394,600) = 34,064 -> 114,462
    expect(federalTaxCents(501_050)).toBe(11_446_200);
    // + 35% of (751,600 - 501,050) = 87,692.50 -> 202,154.50
    expect(federalTaxCents(751_600)).toBe(20_215_450);
    // the 37% row: 37% x 751,601 - 75,937.50 = 202,154.87 (continuous: 202,154.50 + 37% of $1)
    expect(federalTaxCents(751_601)).toBe(20_215_487);
  });

  it("uses the Tax Table below $100,000 and the worksheet from $100,000", () => {
    expect(federalTaxCents(99_999)).toBe(1_182_300);
    expect(wholeDollars(federalTaxCents(100_000))).toBe(11_828);
  });

  it("agrees with the progressive brackets at random points above $100,000", () => {
    const r = mulberry32(5);
    const edges = K.FEDERAL_BRACKETS_MFJ.value;
    for (let i = 0; i < 2000; i++) {
      const ti = 100_000 + Math.floor(r() * 1_400_000);
      let cents = 0;
      for (const b of edges) {
        if (ti <= b.min) break;
        const top = b.max === null ? ti : Math.min(ti, b.max);
        cents += ((top - b.min) * bpOf(b.rate)) / 100;
      }
      expect(federalTaxCents(ti), `ti ${ti}`).toBe(cents);
    }
  });
});

describe("L2 Qualified Dividends and Capital Gain Tax Worksheet", () => {
  it("hand-worked: taxable income 137,174 with 800 of qualified dividends -> line 23 = 19,950, line 24 = 20,006, tax 19,950", () => {
    // line 5 = 136,374; tax on it = 22% x 136,374 - 10,172 = 19,830.28; line 17 = 800 at 15% = 120.00; 23 = round(19,950.28)
    const w = qdcgWorksheet(137_174, 800, 0);
    expect(w.l5).toBe(136_374);
    expect(w.l9).toBe(0);
    expect(w.l22Cents).toBe(1_983_028);
    expect(w.l18Cents).toBe(12_000);
    expect(w.l23).toBe(19_950);
    expect(w.l24).toBe(20_006); // 22% x 137,174 - 10,172 = 20,006.28
    expect(w.l25).toBe(19_950);
  });

  it("hand-worked: all three bands: taxable income 700,000, qualified dividends 100,000, capital gain 200,000", () => {
    // 4 = 300,000; 5 = 400,000; 9 = 0; 10 = 300,000; 12 = 300,000; 14 = 600,050; 15 = 400,000; 16 = 200,050; 17 = 200,050 (15% = 30,007.50);
    // 19 = 200,050; 20 = 99,950 (20% = 19,990.00); 22 = 32% x 400,000 - 45,874 = 82,126; 23 = 132,123.50 -> 132,124; 24 = 35% x 700,000 - 60,905.50 = 184,094.50 -> 184,095
    const w = qdcgWorksheet(700_000, 100_000, 200_000);
    expect(w.l17).toBe(200_050);
    expect(w.l18Cents).toBe(3_000_750);
    expect(w.l20).toBe(99_950);
    expect(w.l21Cents).toBe(1_999_000);
    expect(w.l22Cents).toBe(8_212_600);
    expect(w.l23).toBe(132_124);
    expect(w.l24).toBe(184_095);
    expect(w.l25).toBe(132_124);
  });

  it("the 0% band: taxable income 60,000 with 10,000 of qualified dividends is taxed at 0% on the dividends (line 9)", () => {
    // 5 = 50,000; 7 = 60,000; 8 = 50,000; 9 = 10,000 (0%); the tax is the Tax Table amount on 50,000
    const w = qdcgWorksheet(60_000, 10_000, 0);
    expect(w.l9).toBe(10_000);
    expect(w.l22Cents).toBe(taxTableAmount(50_000) * 100);
    expect(w.l25).toBe(taxTableAmount(50_000));
  });

  it("never exceeds the regular tax (line 25 is the smaller of 23 and 24)", () => {
    const r = mulberry32(11);
    for (let i = 0; i < 3000; i++) {
      const ti = Math.floor(r() * 900_000);
      const w = qdcgWorksheet(ti, Math.floor(r() * 200_000), Math.floor(r() * 400_000));
      expect(w.l25).toBeLessThanOrEqual(wholeDollars(federalTaxCents(ti)));
      expect(w.l25).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("L2 Connecticut Tax Calculation Schedule (CT-1040 TCS Rev. 12/25, married filing jointly)", () => {
  it("Table B printed examples: line 3 of $22,500 gives $513; $1,100,000 gives $69,490", () => {
    expect(Math.floor((ctTableBHundredthsOfCents(22_500) + 5_000) / 10_000)).toBe(513); // 400 + 4.5% of 2,500 = 512.50
    expect(Math.floor((ctTableBHundredthsOfCents(1_100_000) + 5_000) / 10_000)).toBe(69_490); // 62,500 + 6.99% of 100,000
  });

  it("Table B at every printed band edge (hand-worked)", () => {
    const line4 = (x: number) => Math.floor((ctTableBHundredthsOfCents(x) + 5_000) / 10_000);
    expect(line4(20_000)).toBe(400); // 2% of 20,000
    expect(line4(100_000)).toBe(4_000); // 400 + 4.5% x 80,000
    expect(line4(200_000)).toBe(9_500); // 4,000 + 5.5% x 100,000
    expect(line4(400_000)).toBe(21_500); // 9,500 + 6% x 200,000
    expect(line4(500_000)).toBe(28_000); // 21,500 + 6.5% x 100,000
    expect(line4(1_000_000)).toBe(62_500); // 28,000 + 6.9% x 500,000
  });

  it("Table A exemption: $24,000 to $48,000, then $1,000 less per $1,000, $0 above $71,000", () => {
    expect([24_000, 48_000, 48_001, 49_000, 49_001, 70_000, 70_001, 71_000, 71_001, 200_000].map(ctTableA)).toEqual([24_000, 24_000, 23_000, 23_000, 22_000, 2_000, 1_000, 1_000, 0, 0]);
  });

  it("Table C add-back: $50 per $5,000 above $100,500, at most $500 (printed rows)", () => {
    const pairs: [number, number][] = [[100_500, 0], [100_501, 50], [105_500, 50], [105_501, 100], [110_500, 100], [110_501, 150], [140_500, 400], [140_501, 450], [145_500, 450], [145_501, 500], [900_000, 500]];
    for (const [agi, want] of pairs) expect(ctTableC(agi), `agi ${agi}`).toBe(want);
  });

  it("Table D recapture (printed rows): $0 to $210,000, then $50 per $10,000 to $450 at $300,000, $500 to $400,000, $680 ... $6,800", () => {
    const pairs: [number, number][] = [
      [210_000, 0], [210_001, 50], [220_000, 50], [220_001, 100], [290_001, 450], [300_000, 450], [300_001, 500], [400_000, 500],
      [400_001, 680], [410_000, 680], [410_001, 860], [680_001, 5_720], [690_000, 5_720], [690_001, 5_900], [1_000_000, 5_900],
      [1_000_001, 6_000], [1_010_001, 6_100], [1_070_001, 6_700], [1_080_000, 6_700], [1_080_001, 6_800], [5_000_000, 6_800],
    ];
    for (const [agi, want] of pairs) expect(ctTableD(agi), `agi ${agi}`).toBe(want);
  });

  it("Table E decimal (printed rows): .75 to $30,000, steps of .05 per $500, .35 to $40,000, .15 to $50,000, .10 to $96,000, .01 at $100,500, 0 above", () => {
    const pairs: [number, number][] = [
      [24_001, 75], [30_000, 75], [30_001, 70], [30_500, 70], [30_501, 65], [33_000, 45], [33_001, 40], [33_500, 40], [33_501, 35], [40_000, 35],
      [40_001, 30], [40_500, 30], [40_501, 25], [41_000, 25], [41_001, 20], [41_500, 20], [41_501, 15], [50_000, 15], [50_001, 14], [51_501, 11],
      [52_000, 11], [52_001, 10], [96_000, 10], [96_001, 9], [99_500, 3], [99_501, 2], [100_000, 2], [100_001, 1], [100_500, 1], [100_501, 0],
    ];
    for (const [agi, want] of pairs) expect(ctTableEHundredths(agi), `agi ${agi}`).toBe(want);
  });

  it("Tables C, D and E agree with the Tester's independent transcription at every printed edge and one dollar either side", () => {
    const lookup = (rows: [number, number | null, number][], agi: number): number => {
      for (const [from, to, v] of rows) if (agi > from && (to === null || agi <= to)) return v;
      return rows[0]![2];
    };
    const pts = new Set<number>();
    for (const t of [FIXTURE.ctC, FIXTURE.ctD, FIXTURE.ctE]) for (const [from] of t) for (const d of [-1, 0, 1]) pts.add(from + d);
    for (const agi of pts) {
      if (agi <= 24_000) continue;
      expect(ctTableC(agi), `C ${agi}`).toBe(lookup(FIXTURE.ctC, agi));
      expect(ctTableD(agi), `D ${agi}`).toBe(lookup(FIXTURE.ctD, agi));
      expect(ctTableEHundredths(agi) / 100, `E ${agi}`).toBe(lookup(FIXTURE.ctE, Math.max(agi, 24_001)));
    }
  });

  it("hand-worked line 10: Connecticut AGI 353,388 -> 9,500 + 6% x 153,388 = 18,703 (+ 500 + 500) = 19,703", () => {
    const t = ctTaxCalculationSchedule(353_388);
    expect([t.l2, t.l3, t.l4, t.l5, t.l6, t.l7, t.l8Hundredths, t.l9, t.l10]).toEqual([0, 353_388, 18_703, 500, 500, 19_703, 0, 0, 19_703]);
  });

  it("a Connecticut AGI just above $102,000 uses decimal .00 (Table E ends at $100,500)", () => {
    const t = ctTaxCalculationSchedule(102_001);
    expect(t.l8Hundredths).toBe(0);
    expect(t.l9).toBe(0);
    expect(t.l10).toBe(t.l7);
  });

  it("property tax credit decimal at every printed edge (married filing jointly)", () => {
    const table: [number, number][] = [[70_500, 0], [70_501, 15], [80_500, 15], [80_501, 30], [90_500, 30], [90_501, 45], [100_500, 45], [100_501, 60], [110_500, 60], [110_501, 75], [120_500, 75], [120_501, 90], [130_500, 90], [130_501, 100]];
    for (const [agi, want] of table) expect(ctPropertyTaxDecimalHundredths(agi), `agi ${agi}`).toBe(want);
  });
});
