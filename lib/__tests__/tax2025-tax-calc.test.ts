import { describe, expect, it } from "vitest";
import { D } from "@/lib/tax2025/money";
import { computeIncomeTax, qdcgWorksheet, taxOnAmount, taxTableRow } from "@/lib/tax2025/rules/tax-calc";
import taxTable from "@/lib/__tests__/fixtures/tax-table-2025-mfj.json";
import type { RuleResult } from "@/lib/tax2025/types";

function tax(r: RuleResult): string | null {
  const l = r.lines.find((x) => x.key === "f1040.16");
  return l?.amount === null || l === undefined ? null : l.amount.toString();
}

const none = { qualifiedDividends: D(0), netCapitalGain: D(0) };

// Differential tests against the printed 2025 Tax Table (1040 instructions, MFJ column).
// A row is "at least X, less than X+50"; its tax is the tax at the midpoint, rounded.
describe("Tax Table (taxable income under $100,000)", () => {
  it("golden rows: 95,000-95,050 = $10,926 and 98,000-98,050 = $11,394 (acceptance 3)", () => {
    expect(tax(computeIncomeTax({ taxableIncome: D(95010), ...none }))).toBe("10926");
    expect(tax(computeIncomeTax({ taxableIncome: D(98030), ...none }))).toBe("11394");
    // every dollar in the row gives the same tax; the row's own start is in the row, the next row start is not
    expect(tax(computeIncomeTax({ taxableIncome: D(95000), ...none }))).toBe("10926");
    expect(tax(computeIncomeTax({ taxableIncome: D(95049), ...none }))).toBe("10926");
    expect(tax(computeIncomeTax({ taxableIncome: D(98000), ...none }))).toBe("11394");
    expect(tax(computeIncomeTax({ taxableIncome: D(98049), ...none }))).toBe("11394");
  });

  it("hand-computed midpoint values", () => {
    // midpoint 95,025: 10% x 23,850 = 2,385 + 12% x (95,025 - 23,850) = 8,541 -> 10,926.00
    // midpoint 98,025: 2,385 + 12% x 73,100 = 8,772 -> 11,157 + 22% x 1,075 = 236.50 -> 11,393.50 -> 11,394
    expect(taxOnAmount(D(95010)).tax!.toString()).toBe("10926");
    expect(taxOnAmount(D(98030)).tax!.toString()).toBe("11394");
    // 60,025: 2,385 + 12% x 36,175 = 4,341 -> 6,726
    expect(taxOnAmount(D(60000)).tax!.toString()).toBe("6726");
    // 80,025: 2,385 + 12% x 56,175 = 6,741 -> 9,126
    expect(taxOnAmount(D(80049)).tax!.toString()).toBe("9126");
    expect(taxOnAmount(D(95010)).method).toBe("tax_table");
  });

  it("$99,999 is still in the Tax Table (row 99,950-100,000, midpoint 99,975 -> 11,822.50 -> 11,823)", () => {
    const r = taxOnAmount(D(99999));
    expect(r.method).toBe("tax_table");
    expect(r.tax!.toString()).toBe("11823");
  });
});

describe("Tax Computation Worksheet (taxable income $100,000 and over)", () => {
  it("exactly $100,000 uses the worksheet: 2,385 + 8,772 + 22% x 3,050 = $11,828", () => {
    const r = taxOnAmount(D(100000));
    expect(r.method).toBe("tax_computation_worksheet");
    expect(r.tax!.toString()).toBe("11828");
  });

  it("$250,000 uses the worksheet (acceptance 3): 11,157 + 24,145 + 24% x 43,300 = $45,694", () => {
    // 10%: 2,385; 12%: 8,772; 22% x (206,700 - 96,950 = 109,750) = 24,145; 24% x (250,000 - 206,700 = 43,300) = 10,392
    const r = computeIncomeTax({ taxableIncome: D(250000), ...none });
    expect(r.status).toBe("computed");
    expect(tax(r)).toBe("45694");
    expect(r.reasons[0]).toContain("Tax Computation Worksheet");
  });

  it("rounds the result to whole dollars (tax at $501,051 has cents)", () => {
    // ... + 35% x 1 = .35: 80,398 + 34,064 = 114,462 + 0.35 -> 114,462 (rounds down)
    expect(tax(computeIncomeTax({ taxableIncome: D(501051), ...none }))).toBe("114462");
  });

  it("zero taxable income -> $0 tax (computed)", () => {
    const r = computeIncomeTax({ taxableIncome: D(0), ...none });
    expect(r.status).toBe("computed");
    expect(tax(r)).toBe("0");
  });
});

// Differential test against the FULL printed 2025 Tax Table, MFJ column: 2,062 contiguous rows from $0 to $100,000
// (text of the 1040 instructions, fixture lib/__tests__/fixtures/tax-table-2025-mfj.json as [from, to, tax]).
describe("Tax Table: every printed MFJ row", () => {
  const rows = taxTable as [number, number, number][];

  it("the fixture is the whole table: contiguous rows 0 to 100,000 with 5/10/25/50-dollar widths", () => {
    expect(rows).toHaveLength(2062);
    expect(rows[0]).toEqual([0, 5, 0]);
    expect(rows[rows.length - 1]![1]).toBe(100000);
    const widths = new Set(rows.map((r) => r[1] - r[0]));
    expect([...widths].sort((a, b) => a - b)).toEqual([5, 10, 25, 50]);
  });

  it("the row structure in the constants (taxTableRow) reproduces every printed row start and width", () => {
    for (const [from, to] of rows) {
      for (const probe of [from, to - 1].filter((v) => v > 0)) {
        const row = taxTableRow(D(probe));
        expect([row.start.toNumber(), row.start.plus(row.width).toNumber()], `probe ${probe}`).toEqual([from, to]);
      }
    }
  });

  it("taxOnAmount equals the printed tax for the first dollar, the last dollar and the midpoint of every row", () => {
    const bad: string[] = [];
    for (const [from, to, tax] of rows) {
      const probes = new Set([from, to - 1, Math.floor((from + to) / 2)].filter((v) => v > 0 || from > 0));
      for (const probe of probes) {
        if (probe <= 0) continue;
        const got = taxOnAmount(D(probe)).tax.toNumber();
        if (got !== tax) bad.push(`${probe}: got ${got}, printed ${tax}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("incomes at the top of a row belong to the NEXT row (a dollar at 'to' is not in [from, to))", () => {
    expect(taxOnAmount(D(95050)).tax.toString()).toBe(String(rows.find((r) => r[0] === 95050)![2]));
    expect(taxOnAmount(D(95049)).tax.toString()).toBe("10926");
  });
});

describe("small taxable incomes now come from the printed rows (no longer unverified)", () => {
  it("$1,000 is in the 25-wide row 1,000-1,025 = $101; $10,000 is in row 10,000-10,050 = $1,003", () => {
    expect(taxOnAmount(D(1000)).tax.toString()).toBe("101");
    expect(taxOnAmount(D(10000)).tax.toString()).toBe("1003");
    expect(computeIncomeTax({ taxableIncome: D(1000), ...none }).status).toBe("computed");
    expect(tax(computeIncomeTax({ taxableIncome: D(1000), ...none }))).toBe("101");
  });
  it("the first printed rows: 0-5 = 0, 5-15 = 1, 15-25 = 2, 25-50 = 4", () => {
    expect([1, 5, 14, 15, 24, 25, 49].map((v) => taxOnAmount(D(v)).tax.toNumber())).toEqual([0, 1, 1, 2, 2, 4, 4]);
  });
});

describe("missing inputs", () => {
  it("missing taxable income -> missing_input", () => {
    const r = computeIncomeTax({ taxableIncome: null, ...none });
    expect(r.status).toBe("missing_input");
    expect(tax(r)).toBeNull();
    expect(r.inputsMissing[0]).toContain("taxable income");
  });
  it("missing qualified dividends / capital gain -> missing_input", () => {
    expect(computeIncomeTax({ taxableIncome: D(100000), qualifiedDividends: null, netCapitalGain: D(0) }).status).toBe("missing_input");
    expect(computeIncomeTax({ taxableIncome: D(100000), qualifiedDividends: D(0), netCapitalGain: null }).status).toBe("missing_input");
  });
});

// Qualified Dividends and Capital Gain Tax Worksheet (1040 instructions), hand-worked line by line.
describe("Qualified Dividends and Capital Gain Tax Worksheet", () => {
  it("example A: taxable income 150,000, qualified dividends 10,000 -> $22,128", () => {
    // L1 150,000; L2 10,000; L3 0; L4 10,000; L6 10,000; L7 140,000; L8 min(150,000, 96,700) = 96,700;
    // L9 min(140,000, 96,700) = 96,700; L10 0; L11 min(150,000, 10,000) = 10,000; L12 10,000; L13 600,050;
    // L14 150,000; L15 140,000; L16 10,000; L17 10,000; L18 1,500; L19 10,000; L20 0; L21 0;
    // L22 tax on 140,000 = 11,157 + 22% x 43,050 = 9,471 -> 20,628; L23 = 22,128;
    // L24 tax on 150,000 = 11,157 + 22% x 53,050 = 11,671 -> 22,828; L25 = min = 22,128
    const ws = qdcgWorksheet(D(150000), D(10000), D(0))!;
    expect(ws.line[10]!.toString()).toBe("0");
    expect(ws.line[17]!.toString()).toBe("10000");
    expect(ws.line[18]!.toString()).toBe("1500");
    expect(ws.line[22]!.toString()).toBe("20628");
    expect(ws.line[23]!.toString()).toBe("22128");
    expect(ws.line[24]!.toString()).toBe("22828");
    expect(ws.tax.toString()).toBe("22128");
    const r = computeIncomeTax({ taxableIncome: D(150000), qualifiedDividends: D(10000), netCapitalGain: D(0) });
    expect(tax(r)).toBe("22128");
    expect(r.lines.some((l) => l.key === "qdcg.25")).toBe(true);
  });

  it("example B: 0% band. Taxable income 80,000, qualified dividends 20,000 -> $6,726", () => {
    // L7 60,000; L8 80,000; L9 60,000; L10 20,000 (taxed at 0%); L11 min(80,000, 20,000) = 20,000; L12 0;
    // L15 80,000; L16 0; L17 0; L18 0; L19 20,000; L20 0; L22 Tax Table on 60,000 = 6,726; L23 6,726;
    // L24 Tax Table on 80,000 = 9,126; L25 = 6,726
    const ws = qdcgWorksheet(D(80000), D(20000), D(0))!;
    expect(ws.line[10]!.toString()).toBe("20000");
    expect(ws.line[17]!.toString()).toBe("0");
    expect(ws.line[22]!.toString()).toBe("6726");
    expect(ws.line[24]!.toString()).toBe("9126");
    expect(ws.tax.toString()).toBe("6726");
  });

  it("example C: part 0%, part 15% with capital gain distributions. TI 120,000, QD 10,000, gain 20,000 -> $13,821", () => {
    // L3 20,000; L4 30,000; L6 30,000; L7 90,000; L8 96,700; L9 90,000; L10 6,700; L11 30,000; L12 23,300;
    // L14 120,000; L15 96,700; L16 23,300; L17 23,300; L18 3,495; L19 30,000; L20 0; L21 0;
    // L22 Tax Table on 90,000 (midpoint 90,025) = 2,385 + 12% x 66,175 (7,941) = 10,326; L23 = 13,821;
    // L24 tax on 120,000 = 11,157 + 22% x 23,050 (5,071) = 16,228 -> L25 = 13,821
    const ws = qdcgWorksheet(D(120000), D(10000), D(20000))!;
    expect(ws.line[10]!.toString()).toBe("6700");
    expect(ws.line[17]!.toString()).toBe("23300");
    expect(ws.line[18]!.toString()).toBe("3495");
    expect(ws.line[22]!.toString()).toBe("10326");
    expect(ws.line[23]!.toString()).toBe("13821");
    expect(ws.line[24]!.toString()).toBe("16228");
    expect(ws.tax.toString()).toBe("13821");
  });

  it("example D: reaches the 20% band. TI 700,000, QD 650,000 -> $101,019", () => {
    // L7 50,000; L8 96,700; L9 50,000; L10 46,700; L11 650,000; L12 603,300; L14 600,050; L15 96,700;
    // L16 503,350; L17 503,350; L18 75,502.50; L19 550,050; L20 99,950; L21 19,990; L22 Tax Table on 50,000 = 5,526;
    // L23 = 75,502.50 + 19,990 + 5,526 = 101,018.50 -> 101,019 (cents kept until the total is rounded);
    // L24 tax on 700,000 = 184,094.50 -> 184,095; L25 = 101,019
    const ws = qdcgWorksheet(D(700000), D(650000), D(0))!;
    expect(ws.line[17]!.toString()).toBe("503350");
    expect(ws.line[18]!.toString()).toBe("75502.5");
    expect(ws.line[21]!.toString()).toBe("19990");
    expect(ws.line[22]!.toString()).toBe("5526");
    expect(ws.line[23]!.toString()).toBe("101019");
    expect(ws.line[24]!.toString()).toBe("184095");
    expect(ws.tax.toString()).toBe("101019");
  });

  it("the worksheet never gives more than the regular tax (line 25 = smaller of 23 and 24)", () => {
    for (const [ti, qd, g] of [
      [100000, 1, 0],
      [250000, 5000, 3000],
      [96700, 96700, 0],
      [30000, 5000, 1000],
    ] as const) {
      const ws = qdcgWorksheet(D(ti), D(qd), D(g));
      expect(ws).not.toBeNull();
      expect(ws!.tax.lessThanOrEqualTo(ws!.line[24]!)).toBe(true);
    }
  });

  it("example E: a small ordinary-income part uses the printed small rows. TI 10,000, QD 9,000 -> $101", () => {
    // L7 = 1,000 -> row 1,000-1,025 = 101; L10 = 9,000 taxed at 0%; L23 = 101; L24 = tax on 10,000 = 1,003; L25 = 101
    const ws = qdcgWorksheet(D(10000), D(9000), D(0));
    expect(ws.line[7]!.toString()).toBe("1000");
    expect(ws.line[10]!.toString()).toBe("9000");
    expect(ws.line[22]!.toString()).toBe("101");
    expect(ws.line[24]!.toString()).toBe("1003");
    expect(ws.tax.toString()).toBe("101");
  });
});
