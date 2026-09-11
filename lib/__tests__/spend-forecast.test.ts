import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  computeTrailingAverage,
  projectPeriodEndSpend,
  type MonthlySpendPoint,
} from "../spend-forecast";

const D = (s: string) => new Decimal(s);
const d = (iso: string) => new Date(iso + "T00:00:00Z");

function history(entries: [string, string][]): MonthlySpendPoint[] {
  return entries.map(([period, total]) => ({ period, total: D(total) }));
}

describe("projectPeriodEndSpend", () => {
  it("1. steady/level spending — pace and trailing average agree exactly", () => {
    const r = projectPeriodEndSpend({
      period: "2026-09",
      spendToDate: D("-300"),
      asOfDate: d("2026-09-15"),
      history: history([
        ["2026-06", "-600"],
        ["2026-07", "-580"],
        ["2026-08", "-620"],
      ]),
    });
    expect(r.trailingAverage!.toString()).toBe("-600");
    expect(r.paceProjection.toString()).toBe("-600");
    expect(r.projectedTotal.toString()).toBe("-600");
    expect(r.method).toBe("blended");
    expect(r.confidence).toBe("high");
  });

  it("2. front-loaded spending (rent day 1) — blend damps the wild pace signal", () => {
    const r = projectPeriodEndSpend({
      period: "2026-09",
      spendToDate: D("-1500"),
      asOfDate: d("2026-09-03"),
      history: history([
        ["2026-06", "-1500"],
        ["2026-07", "-1500"],
        ["2026-08", "-1500"],
      ]),
    });
    expect(r.paceProjection.toString()).toBe("-15000");
    expect(r.trailingAverage!.toString()).toBe("-1500");
    expect(r.projectedTotal.toString()).toBe("-2850");
    expect(r.projectedTotal.abs().lessThan(r.paceProjection.abs())).toBe(true);
  });

  it("3. back-loaded spending (bill due late in month) — known under-projection risk", () => {
    const r = projectPeriodEndSpend({
      period: "2026-09",
      spendToDate: D("-20"),
      asOfDate: d("2026-09-25"),
      history: history([
        ["2026-06", "-200"],
        ["2026-07", "-200"],
        ["2026-08", "-200"],
      ]),
    });
    expect(r.paceProjection.toString()).toBe("-24");
    expect(r.trailingAverage!.toString()).toBe("-200");
    expect(r.projectedTotal.toNumber()).toBeCloseTo(-53.33, 2);
    expect(r.projectedTotal.abs().lessThan(r.trailingAverage!.abs())).toBe(true);
  });

  describe("4. no history (new tag) — must not crash or wildly extrapolate from nothing", () => {
    it("projects off the single data point, flagged low confidence", () => {
      const r = projectPeriodEndSpend({
        period: "2026-09",
        spendToDate: D("-45"),
        asOfDate: d("2026-09-05"),
        history: [],
      });
      expect(r.trailingAverage).toBeNull();
      expect(r.method).toBe("pace_only");
      expect(r.confidence).toBe("low");
      expect(r.projectedTotal.toString()).toBe("-270");
    });

    it("zero spend-to-date does not throw or produce NaN/Infinity", () => {
      const r = projectPeriodEndSpend({
        period: "2026-09",
        spendToDate: D("0"),
        asOfDate: d("2026-09-05"),
        history: [],
      });
      expect(r.projectedTotal.isZero()).toBe(true);
      expect(r.projectedTotal.isNaN()).toBe(false);
      expect(r.projectedTotal.isFinite()).toBe(true);
    });

    it("asOfDate before the target period floors daysElapsed at 1, no divide-by-zero", () => {
      const r = projectPeriodEndSpend({
        period: "2026-09",
        spendToDate: D("-45"),
        asOfDate: d("2026-08-15"),
        history: [],
      });
      expect(r.daysElapsed).toBe(1);
    });
  });

  it("5. tag already over its historical norm — signals worse-than-normal trajectory", () => {
    const r = projectPeriodEndSpend({
      period: "2026-09",
      spendToDate: D("-500"),
      asOfDate: d("2026-09-10"),
      history: history([
        ["2026-06", "-300"],
        ["2026-07", "-280"],
        ["2026-08", "-320"],
      ]),
    });
    expect(r.trailingAverage!.toString()).toBe("-300");
    expect(r.paceProjection.toString()).toBe("-1500");
    expect(r.projectedTotal.toString()).toBe("-700");
    expect(r.projectedTotal.abs().greaterThan(r.trailingAverage!.abs())).toBe(true);
    expect(r.projectedTotal.abs().lessThan(r.paceProjection.abs())).toBe(true);
    expect(r.confidence).toBe("high");
  });

  it("6. period already complete — projected total equals the known actual", () => {
    const r = projectPeriodEndSpend({
      period: "2026-08",
      spendToDate: D("-950"),
      asOfDate: d("2026-09-15"),
      history: history([
        ["2026-06", "-900"],
        ["2026-07", "-1000"],
      ]),
    });
    expect(r.daysElapsed).toBe(31);
    expect(r.daysInPeriod).toBe(31);
    expect(r.projectedTotal.toString()).toBe("-950");
  });

  it("7. invalid period throws", () => {
    const base = {
      spendToDate: D("-100"),
      asOfDate: d("2026-09-10"),
      history: [],
    };
    expect(() => projectPeriodEndSpend({ ...base, period: "2026-9" })).toThrow();
    expect(() => projectPeriodEndSpend({ ...base, period: "September 2026" })).toThrow();
    expect(() => projectPeriodEndSpend({ ...base, period: "" })).toThrow();
  });

  it("8. leap-year / month-length boundary — Feb 2026 has 28 days", () => {
    const r = projectPeriodEndSpend({
      period: "2026-02",
      spendToDate: D("-100"),
      asOfDate: d("2026-02-28"),
      history: [],
    });
    expect(r.daysInPeriod).toBe(28);
    expect(r.daysElapsed).toBe(28);
  });

  // Gap in the plan's own test list: "medium" confidence (0 < monthsUsed <
  // trailingMonths) is never exercised — Tests 1/2/3/5 all use exactly 3 of 3
  // prior months (high), Test 4 uses 0 (low). Test 6 has 2 prior months with
  // the default trailingMonths=3 but never asserts on `confidence` at all.
  it("9. partial trailing history (2 of default 3 months) yields medium confidence", () => {
    const r = projectPeriodEndSpend({
      period: "2026-09",
      spendToDate: D("-300"),
      asOfDate: d("2026-09-15"),
      history: history([
        ["2026-07", "-580"],
        ["2026-08", "-620"],
      ]),
    });
    expect(r.trailingMonthsUsed).toBe(2);
    expect(r.confidence).toBe("medium");
    expect(r.method).toBe("blended");
  });

  // The plan's `trailingMonths` option is only exercised directly against
  // computeTrailingAverage in the existing suite; confirm it actually threads
  // through projectPeriodEndSpend end-to-end (both the blend and the
  // confidence bucketing depend on it).
  it("10. custom trailingMonths threads through to blend weighting and confidence", () => {
    const r = projectPeriodEndSpend({
      period: "2026-09",
      spendToDate: D("-300"),
      asOfDate: d("2026-09-15"),
      trailingMonths: 1,
      history: history([
        ["2026-06", "-9999"], // outside the 1-month window — must not be used
        ["2026-07", "-9999"], // outside the 1-month window — must not be used
        ["2026-08", "-620"],
      ]),
    });
    expect(r.trailingMonthsUsed).toBe(1);
    expect(r.trailingAverage!.toString()).toBe("-620");
    expect(r.confidence).toBe("high"); // monthsUsed (1) === trailingMonths (1)
    // Blend: pace(-600)*0.5 + avg(-620)*0.5 = -610
    expect(r.paceProjection.toString()).toBe("-600");
    expect(r.projectedTotal.toString()).toBe("-610");
  });

  // trailingMonths: 0 explicitly disables the trailing baseline even with
  // ample history available — must fall back to pace_only, not throw or
  // silently use the plan's default of 3.
  it("11. trailingMonths: 0 disables the trailing baseline entirely", () => {
    const r = projectPeriodEndSpend({
      period: "2026-09",
      spendToDate: D("-300"),
      asOfDate: d("2026-09-15"),
      trailingMonths: 0,
      history: history([
        ["2026-06", "-600"],
        ["2026-07", "-600"],
        ["2026-08", "-600"],
      ]),
    });
    expect(r.trailingAverage).toBeNull();
    expect(r.trailingMonthsUsed).toBe(0);
    expect(r.method).toBe("pace_only");
    expect(r.confidence).toBe("low");
    expect(r.projectedTotal.toString()).toBe("-600");
  });
});

describe("computeTrailingAverage", () => {
  it("dedupes a repeated period entry (last one wins)", () => {
    const h = history([
      ["2026-07", "-100"],
      ["2026-07", "-500"],
    ]);
    const { average, monthsUsed } = computeTrailingAverage(h, "2026-09", 3);
    expect(monthsUsed).toBe(1);
    expect(average!.toString()).toBe("-500");
  });

  it("excludes the current/target period and any future periods", () => {
    const h = history([
      ["2026-08", "-200"],
      ["2026-09", "-9999"], // current period — must be excluded
      ["2026-10", "-9999"], // future period — must be excluded
    ]);
    const { average, monthsUsed } = computeTrailingAverage(h, "2026-09", 3);
    expect(monthsUsed).toBe(1);
    expect(average!.toString()).toBe("-200");
  });

  it("caps at trailingMonths, keeping the most recent qualifying entries", () => {
    const h = history([
      ["2026-01", "-100"],
      ["2026-02", "-200"],
      ["2026-03", "-300"],
      ["2026-04", "-400"],
      ["2026-05", "-500"],
    ]);
    const { average, monthsUsed } = computeTrailingAverage(h, "2026-09", 3);
    // Most recent 3 prior periods: 03, 04, 05 → avg = -400
    expect(monthsUsed).toBe(3);
    expect(average!.toString()).toBe("-400");
  });

  it("returns null/0 for empty input", () => {
    const { average, monthsUsed } = computeTrailingAverage([], "2026-09", 3);
    expect(average).toBeNull();
    expect(monthsUsed).toBe(0);
  });

  it("returns null/0 when trailingMonths <= 0", () => {
    const h = history([["2026-08", "-200"]]);
    const { average, monthsUsed } = computeTrailingAverage(h, "2026-09", 0);
    expect(average).toBeNull();
    expect(monthsUsed).toBe(0);
  });
});
