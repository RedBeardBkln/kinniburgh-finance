import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  getQuarterForDate,
  getQuarterBounds,
  getPriorQuarters,
  projectQuarterEndPL,
  computeTrailingQuarterlyAverages,
  computeTaxReserveEstimate,
  type QuarterlyPLPoint,
} from "../business-quarter-forecast";

const D = (s: string) => new Decimal(s);
const d = (iso: string) => new Date(iso + "T00:00:00Z");

function history(entries: [string, string, string][]): QuarterlyPLPoint[] {
  return entries.map(([quarter, totalIncome, totalExpenses]) => ({
    quarter,
    totalIncome: D(totalIncome),
    totalExpenses: D(totalExpenses),
  }));
}

describe("projectQuarterEndPL", () => {
  it("1. steady state — pace and trailing average agree exactly", () => {
    const r = projectQuarterEndPL({
      quarter: "2026-Q3",
      actualToDate: { totalIncome: D("45000"), totalExpenses: D("27000") },
      asOfDate: d("2026-08-15"),
      history: history([
        ["2025-Q3", "90000", "54000"],
        ["2025-Q4", "90000", "54000"],
        ["2026-Q1", "90000", "54000"],
        ["2026-Q2", "90000", "54000"],
      ]),
    });

    expect(r.daysInQuarter).toBe(92);
    expect(r.daysElapsed).toBe(46);
    expect(r.income.paceProjection.toString()).toBe("90000");
    expect(r.income.trailingAverage!.toString()).toBe("90000");
    expect(r.income.projectedTotal.toString()).toBe("90000");
    expect(r.expenses.paceProjection.toString()).toBe("54000");
    expect(r.expenses.trailingAverage!.toString()).toBe("54000");
    expect(r.expenses.projectedTotal.toString()).toBe("54000");
    expect(r.projectedNetIncome.toString()).toBe("36000");
    expect(r.actualNetIncomeToDate.toString()).toBe("18000");
    expect(r.method).toBe("blended");
    expect(r.confidence).toBe("high");
    expect(r.trailingQuartersUsed).toBe(4);
  });

  it("2. front-loaded income lump early in the quarter — blend damps the wild pace signal", () => {
    const r = projectQuarterEndPL({
      quarter: "2026-Q3",
      actualToDate: { totalIncome: D("9200"), totalExpenses: D("3000") },
      asOfDate: d("2026-07-10"),
      history: history([
        ["2025-Q3", "9200", "27600"],
        ["2025-Q4", "9200", "27600"],
        ["2026-Q1", "9200", "27600"],
        ["2026-Q2", "9200", "27600"],
      ]),
    });

    expect(r.daysElapsed).toBe(10);
    expect(r.income.paceProjection.toString()).toBe("84640");
    expect(r.income.trailingAverage!.toString()).toBe("9200");
    expect(r.income.projectedTotal.toString()).toBe("17400");
    expect(r.income.projectedTotal.lessThan(r.income.paceProjection)).toBe(true);
    expect(r.expenses.paceProjection.toString()).toBe("27600");
    expect(r.expenses.trailingAverage!.toString()).toBe("27600");
    expect(r.expenses.projectedTotal.toString()).toBe("27600");
    expect(r.projectedNetIncome.toString()).toBe("-10200");
    expect(r.actualNetIncomeToDate.toString()).toBe("6200");
  });

  it("3. back-loaded expenses + zero-revenue entity", () => {
    const r = projectQuarterEndPL({
      quarter: "2026-Q3",
      actualToDate: { totalIncome: D("0"), totalExpenses: D("100") },
      asOfDate: d("2026-08-15"),
      history: history([
        ["2025-Q3", "0", "27600"],
        ["2025-Q4", "0", "27600"],
        ["2026-Q1", "0", "27600"],
        ["2026-Q2", "0", "27600"],
      ]),
    });

    expect(r.daysElapsed).toBe(46);
    expect(r.income.paceProjection.toString()).toBe("0");
    expect(r.income.trailingAverage!.toString()).toBe("0");
    expect(r.income.projectedTotal.toString()).toBe("0");
    expect(r.income.projectedTotal.isNaN()).toBe(false);
    expect(r.expenses.paceProjection.toString()).toBe("200");
    expect(r.expenses.trailingAverage!.toString()).toBe("27600");
    expect(r.expenses.projectedTotal.toString()).toBe("13900");
    expect(r.projectedNetIncome.toString()).toBe("-13900");
    expect(r.confidence).toBe("high");

    const reserve = computeTaxReserveEstimate(r.projectedNetIncome, D("30"));
    expect(reserve.reserveBasis.toString()).toBe("0");
    expect(reserve.reserveAmount.toString()).toBe("0");
  });

  describe("4. no history at all — first quarter of operation", () => {
    it("projects off pace alone, flagged low confidence", () => {
      const r = projectQuarterEndPL({
        quarter: "2026-Q1",
        actualToDate: { totalIncome: D("15000"), totalExpenses: D("9000") },
        asOfDate: d("2026-01-30"),
        history: [],
      });

      expect(r.daysInQuarter).toBe(90);
      expect(r.daysElapsed).toBe(30);
      expect(r.income.trailingAverage).toBeNull();
      expect(r.income.paceProjection.toString()).toBe("45000");
      expect(r.income.projectedTotal.toString()).toBe("45000");
      expect(r.expenses.paceProjection.toString()).toBe("27000");
      expect(r.expenses.projectedTotal.toString()).toBe("27000");
      expect(r.projectedNetIncome.toString()).toBe("18000");
      expect(r.method).toBe("pace_only");
      expect(r.confidence).toBe("low");
      expect(r.trailingQuartersUsed).toBe(0);
    });

    it("zero actuals on the quarter's first day floors daysElapsed at 1, no NaN/Infinity", () => {
      const r = projectQuarterEndPL({
        quarter: "2026-Q1",
        actualToDate: { totalIncome: D("0"), totalExpenses: D("0") },
        asOfDate: d("2026-01-01"),
        history: [],
      });

      expect(r.daysElapsed).toBe(1);
      for (const dec of [
        r.income.paceProjection,
        r.income.projectedTotal,
        r.expenses.paceProjection,
        r.expenses.projectedTotal,
        r.actualNetIncomeToDate,
        r.projectedNetIncome,
      ]) {
        expect(dec.isZero()).toBe(true);
        expect(dec.isNaN()).toBe(false);
        expect(dec.isFinite()).toBe(true);
      }
    });
  });

  it("5. already-complete quarter — projected total equals the known actual", () => {
    const r = projectQuarterEndPL({
      quarter: "2025-Q4",
      actualToDate: { totalIncome: D("50000"), totalExpenses: D("30000") },
      asOfDate: d("2026-02-01"),
      history: [],
    });

    expect(r.daysElapsed).toBe(92);
    expect(r.daysInQuarter).toBe(92);
    expect(r.income.projectedTotal.toString()).toBe("50000");
    expect(r.expenses.projectedTotal.toString()).toBe("30000");
    expect(r.projectedNetIncome.toString()).toBe("20000");
  });

  it("6. invalid quarter format throws", () => {
    const base = {
      actualToDate: { totalIncome: D("0"), totalExpenses: D("0") },
      asOfDate: d("2026-01-01"),
      history: [] as QuarterlyPLPoint[],
    };
    for (const q of ["2026-Q5", "2026-05", "", "Q1 2026"]) {
      expect(() => projectQuarterEndPL({ ...base, quarter: q })).toThrow();
      expect(() => getQuarterBounds(q)).toThrow();
    }
  });

  it("7. leap-year vs. non-leap quarter lengths", () => {
    const leap = projectQuarterEndPL({
      quarter: "2028-Q1",
      actualToDate: { totalIncome: D("0"), totalExpenses: D("0") },
      asOfDate: d("2028-02-01"),
      history: [],
    });
    expect(leap.daysInQuarter).toBe(91);

    const nonLeapQ1 = projectQuarterEndPL({
      quarter: "2026-Q1",
      actualToDate: { totalIncome: D("0"), totalExpenses: D("0") },
      asOfDate: d("2026-02-01"),
      history: [],
    });
    expect(nonLeapQ1.daysInQuarter).toBe(90);

    const q2 = projectQuarterEndPL({
      quarter: "2026-Q2",
      actualToDate: { totalIncome: D("0"), totalExpenses: D("0") },
      asOfDate: d("2026-05-01"),
      history: [],
    });
    expect(q2.daysInQuarter).toBe(91);

    const q3 = projectQuarterEndPL({
      quarter: "2026-Q3",
      actualToDate: { totalIncome: D("0"), totalExpenses: D("0") },
      asOfDate: d("2026-08-01"),
      history: [],
    });
    expect(q3.daysInQuarter).toBe(92);

    const q4 = projectQuarterEndPL({
      quarter: "2026-Q4",
      actualToDate: { totalIncome: D("0"), totalExpenses: D("0") },
      asOfDate: d("2026-11-01"),
      history: [],
    });
    expect(q4.daysInQuarter).toBe(92);
  });
});

describe("getPriorQuarters", () => {
  it("rolls over a year boundary", () => {
    expect(getPriorQuarters("2026-Q1", 4)).toEqual([
      "2025-Q4",
      "2025-Q3",
      "2025-Q2",
      "2025-Q1",
    ]);
  });

  it("stays within a year when no rollover is needed", () => {
    expect(getPriorQuarters("2026-Q3", 2)).toEqual(["2026-Q2", "2026-Q1"]);
  });
});

describe("getQuarterForDate", () => {
  it("maps dates to the correct quarter", () => {
    expect(getQuarterForDate(d("2026-09-12"))).toBe("2026-Q3");
    expect(getQuarterForDate(d("2026-01-01"))).toBe("2026-Q1");
    expect(getQuarterForDate(d("2026-12-31"))).toBe("2026-Q4");
    expect(getQuarterForDate(d("2026-03-31"))).toBe("2026-Q1");
    expect(getQuarterForDate(d("2026-04-01"))).toBe("2026-Q2");
  });
});

describe("computeTrailingQuarterlyAverages", () => {
  it("dedupes a repeated quarter entry (last one wins)", () => {
    const h = history([
      ["2026-Q1", "100", "50"],
      ["2026-Q1", "500", "250"],
    ]);
    const { incomeAverage, expenseAverage, quartersUsed } = computeTrailingQuarterlyAverages(
      h,
      "2026-Q3",
      4
    );
    expect(quartersUsed).toBe(1);
    expect(incomeAverage!.toString()).toBe("500");
    expect(expenseAverage!.toString()).toBe("250");
  });

  it("excludes the current/target quarter and any future quarters", () => {
    const h = history([
      ["2026-Q2", "200", "100"],
      ["2026-Q3", "9999", "9999"], // current quarter — must be excluded
      ["2026-Q4", "9999", "9999"], // future quarter — must be excluded
    ]);
    const { incomeAverage, expenseAverage, quartersUsed } = computeTrailingQuarterlyAverages(
      h,
      "2026-Q3",
      4
    );
    expect(quartersUsed).toBe(1);
    expect(incomeAverage!.toString()).toBe("200");
    expect(expenseAverage!.toString()).toBe("100");
  });

  it("caps at trailingQuarters, keeping the most recent qualifying entries", () => {
    const h = history([
      ["2025-Q1", "100", "10"],
      ["2025-Q2", "200", "20"],
      ["2025-Q3", "300", "30"],
      ["2025-Q4", "400", "40"],
      ["2026-Q1", "500", "50"],
    ]);
    const { incomeAverage, expenseAverage, quartersUsed } = computeTrailingQuarterlyAverages(
      h,
      "2026-Q3",
      3
    );
    // Most recent 3 prior quarters: 2025-Q3, 2025-Q4, 2026-Q1 → avg income 400, avg expense 40
    expect(quartersUsed).toBe(3);
    expect(incomeAverage!.toString()).toBe("400");
    expect(expenseAverage!.toString()).toBe("40");
  });

  it("returns null/0 for empty input", () => {
    const { incomeAverage, expenseAverage, quartersUsed } = computeTrailingQuarterlyAverages(
      [],
      "2026-Q3",
      4
    );
    expect(incomeAverage).toBeNull();
    expect(expenseAverage).toBeNull();
    expect(quartersUsed).toBe(0);
  });

  it("returns null/0 when trailingQuarters <= 0", () => {
    const h = history([["2026-Q2", "200", "100"]]);
    const { incomeAverage, expenseAverage, quartersUsed } = computeTrailingQuarterlyAverages(
      h,
      "2026-Q3",
      0
    );
    expect(incomeAverage).toBeNull();
    expect(expenseAverage).toBeNull();
    expect(quartersUsed).toBe(0);
  });
});

describe("computeTaxReserveEstimate", () => {
  it("computes a flat percentage of a positive projected net income", () => {
    const r = computeTaxReserveEstimate(D("40000"), D("30"));
    expect(r.reserveBasis.toString()).toBe("40000");
    expect(r.reserveAmount.toString()).toBe("12000");
  });

  it("clamps the basis to 0 for a projected loss — never reserves against a loss", () => {
    const r = computeTaxReserveEstimate(D("-5000"), D("30"));
    expect(r.reserveBasis.toString()).toBe("0");
    expect(r.reserveAmount.toString()).toBe("0");
  });

  it("returns 0 reserve amount for a 0% rate", () => {
    const r = computeTaxReserveEstimate(D("40000"), D("0"));
    expect(r.reserveAmount.toString()).toBe("0");
  });

  it("throws on a negative reservePct", () => {
    expect(() => computeTaxReserveEstimate(D("40000"), D("-5"))).toThrow();
  });

  // Tester-added: exact-zero boundary — plan requires "never returns a
  // positive reserve amount when projectedNetIncome is negative OR ZERO",
  // which the existing tests only cover for a strictly negative value.
  it("clamps the basis to 0 for an exactly-zero projected net income (boundary, not just negative)", () => {
    const r = computeTaxReserveEstimate(D("0"), D("30"));
    expect(r.reserveBasis.toString()).toBe("0");
    expect(r.reserveAmount.toString()).toBe("0");
  });

  // Tester-added: a fractional percentage (the UI form allows step="0.1")
  // should not round or lose precision through the Decimal math.
  it("handles a fractional reserve percentage without precision loss", () => {
    const r = computeTaxReserveEstimate(D("10000"), D("27.5"));
    expect(r.reserveAmount.toString()).toBe("2750");
  });
});

describe("projectQuarterEndPL — trailingQuarters override and confidence tiers", () => {
  // Tester-added: the plan's own contract says "medium" confidence applies
  // when 0 < quartersUsed < trailingQuarters — this was never directly
  // exercised end-to-end through projectQuarterEndPL (only high/low were).
  it("reports medium confidence when some but not all trailing quarters have history", () => {
    const r = projectQuarterEndPL({
      quarter: "2026-Q3",
      actualToDate: { totalIncome: D("45000"), totalExpenses: D("27000") },
      asOfDate: d("2026-08-15"),
      history: history([
        ["2026-Q2", "90000", "54000"],
        ["2026-Q1", "90000", "54000"],
      ]),
    });
    expect(r.trailingQuartersUsed).toBe(2);
    expect(r.method).toBe("blended");
    expect(r.confidence).toBe("medium");
  });

  // Tester-added: caller-supplied trailingQuarters should flow through to
  // both the averaging window and the reported confidence tier — not just
  // exercised via computeTrailingQuarterlyAverages in isolation.
  it("honors an explicit trailingQuarters override smaller than the available history", () => {
    const r = projectQuarterEndPL({
      quarter: "2026-Q3",
      actualToDate: { totalIncome: D("45000"), totalExpenses: D("27000") },
      asOfDate: d("2026-08-15"),
      history: history([
        ["2025-Q3", "90000", "54000"],
        ["2025-Q4", "90000", "54000"],
        ["2026-Q1", "90000", "54000"],
        ["2026-Q2", "90000", "54000"],
      ]),
      trailingQuarters: 2,
    });
    expect(r.trailingQuartersUsed).toBe(2);
    expect(r.confidence).toBe("high"); // quartersUsed === trailingQuarters (2 === 2)
  });
});
