import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { evaluateBudgetPace, type MonthlySpendPoint } from "../budget-pace";

const D = (s: string) => new Decimal(s);
const d = (iso: string) => new Date(iso + "T00:00:00Z");

function history(entries: [string, string][]): MonthlySpendPoint[] {
  return entries.map(([period, total]) => ({ period, total: D(total) }));
}

describe("evaluateBudgetPace", () => {
  it("1. fires — high confidence (3/3 trailing months), below 80% used, projection > 105% of budget", () => {
    const r = evaluateBudgetPace({
      period: "2026-09",
      effectiveBudget: D("600"),
      actualSpend: D("-200"),
      percentUsed: (200 / 600) * 100, // 33.3%
      asOfDate: d("2026-09-10"), // daysElapsed = 10, daysInPeriod = 30
      history: history([
        ["2026-06", "-900"],
        ["2026-07", "-900"],
        ["2026-08", "-900"],
      ]),
    });
    // paceProjection = -200 * 30/10 = -600; trailingAverage = -900
    // blended = (-600*10 + -900*20)/30 = -800
    expect(r.forecast.confidence).toBe("high");
    expect(r.forecast.projectedTotal.toString()).toBe("-800");
    expect(r.fire).toBe(true);
    expect(r.projectedOverageAbs!.toString()).toBe("200");
  });

  it("2. fires — medium confidence (2/3 trailing months) is not suppressed", () => {
    const r = evaluateBudgetPace({
      period: "2026-09",
      effectiveBudget: D("500"),
      actualSpend: D("-300"),
      percentUsed: (300 / 500) * 100, // 60%
      asOfDate: d("2026-09-15"), // daysElapsed = 15, daysInPeriod = 30
      history: history([
        ["2026-07", "-580"],
        ["2026-08", "-620"],
      ]),
    });
    // paceProjection = -300 * 30/15 = -600; trailingAverage = -600
    // blended = -600 (pace and average agree)
    expect(r.forecast.confidence).toBe("medium");
    expect(r.forecast.trailingMonthsUsed).toBe(2);
    expect(r.forecast.projectedTotal.toString()).toBe("-600");
    expect(r.fire).toBe(true);
    expect(r.projectedOverageAbs!.toString()).toBe("100");
  });

  it("3. does not fire — confidence is low (no history), even though the bare pace projection alone would exceed budget", () => {
    const r = evaluateBudgetPace({
      period: "2026-09",
      effectiveBudget: D("400"),
      actualSpend: D("-100"),
      percentUsed: (100 / 400) * 100, // 25%
      asOfDate: d("2026-09-05"), // daysElapsed = 5, daysInPeriod = 30
      history: [],
    });
    // paceProjection = -100 * 30/5 = -600, which alone is > 400*1.05 = 420
    expect(r.forecast.confidence).toBe("low");
    expect(r.forecast.paceProjection.abs().greaterThan(D("420"))).toBe(true);
    expect(r.fire).toBe(false);
    expect(r.projectedOverageAbs).toBeNull();
  });

  it("4. does not fire — percentUsed >= 80, even with a wide-margin overage projected", () => {
    const wideMarginHistory = history([
      ["2026-06", "-2000"],
      ["2026-07", "-2000"],
      ["2026-08", "-2000"],
    ]);

    const above = evaluateBudgetPace({
      period: "2026-09",
      effectiveBudget: D("1000"),
      actualSpend: D("-850"),
      percentUsed: 85,
      asOfDate: d("2026-09-15"),
      history: wideMarginHistory,
    });
    expect(above.fire).toBe(false);
    expect(above.projectedOverageAbs).toBeNull();

    // Boundary: exactly 80 is suppressed too (>=, not >)
    const boundary = evaluateBudgetPace({
      period: "2026-09",
      effectiveBudget: D("1000"),
      actualSpend: D("-800"),
      percentUsed: 80,
      asOfDate: d("2026-09-15"),
      history: wideMarginHistory,
    });
    expect(boundary.fire).toBe(false);
    expect(boundary.projectedOverageAbs).toBeNull();
  });

  it("5. does not fire — projection is under budget (healthy, on pace), high confidence", () => {
    const r = evaluateBudgetPace({
      period: "2026-09",
      effectiveBudget: D("1000"),
      actualSpend: D("-200"),
      percentUsed: 20,
      asOfDate: d("2026-09-10"), // daysElapsed = 10, daysInPeriod = 30
      history: history([
        ["2026-06", "-300"],
        ["2026-07", "-300"],
        ["2026-08", "-300"],
      ]),
    });
    // paceProjection = -600; trailingAverage = -300
    // blended = (-600*10 + -300*20)/30 = -400 (well under 1000)
    expect(r.forecast.confidence).toBe("high");
    expect(r.forecast.projectedTotal.toString()).toBe("-400");
    expect(r.fire).toBe(false);
    expect(r.projectedOverageAbs).toBeNull();
  });

  it("6. materiality margin — does not fire within 5%, fires just past it", () => {
    // Steady-state fixture: paceProjection === trailingAverage regardless of
    // day-count weighting, so projectedTotal always equals the chosen X.
    const steady = (x: string, spendToDate: string, percentUsed: number) =>
      evaluateBudgetPace({
        period: "2026-09",
        effectiveBudget: D("1000"),
        actualSpend: D(spendToDate),
        percentUsed,
        asOfDate: d("2026-09-15"), // daysElapsed = 15, daysInPeriod = 30
        history: history([
          ["2026-06", x],
          ["2026-07", x],
          ["2026-08", x],
        ]),
      });

    // Exactly 2% over — does not fire.
    const twoPercentOver = steady("-1020", "-510", 51);
    expect(twoPercentOver.forecast.projectedTotal.toString()).toBe("-1020");
    expect(twoPercentOver.fire).toBe(false);
    expect(twoPercentOver.projectedOverageAbs).toBeNull();

    // Exactly at the 5% boundary (105% of budget) — still does not fire (> required, not >=).
    const exactlyFivePercentOver = steady("-1050", "-525", 52.5);
    expect(exactlyFivePercentOver.forecast.projectedTotal.toString()).toBe("-1050");
    expect(exactlyFivePercentOver.fire).toBe(false);
    expect(exactlyFivePercentOver.projectedOverageAbs).toBeNull();

    // 6% over — fires, pinning the exact cutoff.
    const sixPercentOver = steady("-1060", "-530", 53);
    expect(sixPercentOver.forecast.projectedTotal.toString()).toBe("-1060");
    expect(sixPercentOver.fire).toBe(true);
    expect(sixPercentOver.projectedOverageAbs!.toString()).toBe("60");
  });

  it("7. does not fire — effectiveBudget is zero, no throw, no NaN/Infinity", () => {
    const r = evaluateBudgetPace({
      period: "2026-09",
      effectiveBudget: D("0"),
      actualSpend: D("-100"),
      percentUsed: 0,
      asOfDate: d("2026-09-10"),
      history: history([
        ["2026-06", "-600"],
        ["2026-07", "-600"],
        ["2026-08", "-600"],
      ]),
    });
    expect(r.fire).toBe(false);
    expect(r.projectedOverageAbs).toBeNull();
    expect(r.forecast.projectedTotal.isNaN()).toBe(false);
    expect(r.forecast.projectedTotal.isFinite()).toBe(true);
  });

  it("8. does not fire — effectiveBudget is negative (defensive case), no throw or nonsensical fire", () => {
    const r = evaluateBudgetPace({
      period: "2026-09",
      effectiveBudget: D("-500"),
      actualSpend: D("-100"),
      percentUsed: 0,
      asOfDate: d("2026-09-10"),
      history: history([
        ["2026-06", "-600"],
        ["2026-07", "-600"],
        ["2026-08", "-600"],
      ]),
    });
    expect(r.fire).toBe(false);
    expect(r.projectedOverageAbs).toBeNull();
    expect(r.forecast.projectedTotal.isNaN()).toBe(false);
    expect(r.forecast.projectedTotal.isFinite()).toBe(true);
  });

  it("9. forecast is always populated, even across suppressed cases (tests 3-6)", () => {
    const cases = [
      // low confidence (test 3 shape)
      evaluateBudgetPace({
        period: "2026-09",
        effectiveBudget: D("400"),
        actualSpend: D("-100"),
        percentUsed: 25,
        asOfDate: d("2026-09-05"),
        history: [],
      }),
      // percentUsed >= 80 (test 4 shape)
      evaluateBudgetPace({
        period: "2026-09",
        effectiveBudget: D("1000"),
        actualSpend: D("-850"),
        percentUsed: 85,
        asOfDate: d("2026-09-15"),
        history: history([["2026-08", "-2000"]]),
      }),
      // healthy/under budget (test 5 shape)
      evaluateBudgetPace({
        period: "2026-09",
        effectiveBudget: D("1000"),
        actualSpend: D("-200"),
        percentUsed: 20,
        asOfDate: d("2026-09-10"),
        history: history([["2026-08", "-300"]]),
      }),
      // within materiality margin (test 6 shape)
      evaluateBudgetPace({
        period: "2026-09",
        effectiveBudget: D("1000"),
        actualSpend: D("-510"),
        percentUsed: 51,
        asOfDate: d("2026-09-15"),
        history: history([["2026-08", "-1020"]]),
      }),
    ];

    for (const c of cases) {
      expect(c.fire).toBe(false);
      expect(c.forecast).toBeDefined();
      expect(c.forecast.period).toBe("2026-09");
      expect(typeof c.forecast.daysInPeriod).toBe("number");
      expect(typeof c.forecast.daysElapsed).toBe("number");
      expect(c.forecast.projectedTotal).toBeInstanceOf(Decimal);
      expect(c.forecast.projectedTotal.isNaN()).toBe(false);
    }
  });

  it("10. trailingMonths override threads through and can flip the fire outcome", () => {
    const fixtureHistory = history([
      ["2026-06", "-9999"], // outside a 1-month window — must not be used when overridden
      ["2026-07", "-9999"], // outside a 1-month window — must not be used when overridden
      ["2026-08", "-620"],
    ]);

    const withDefault = evaluateBudgetPace({
      period: "2026-09",
      effectiveBudget: D("700"),
      actualSpend: D("-300"),
      percentUsed: (300 / 700) * 100,
      asOfDate: d("2026-09-15"), // daysElapsed = 15, daysInPeriod = 30
      history: fixtureHistory,
      // trailingMonths defaults to 3 — pulls in the -9999 months
    });
    expect(withDefault.forecast.trailingMonthsUsed).toBe(3);
    expect(withDefault.fire).toBe(true);

    const withOverride = evaluateBudgetPace({
      period: "2026-09",
      effectiveBudget: D("700"),
      actualSpend: D("-300"),
      percentUsed: (300 / 700) * 100,
      asOfDate: d("2026-09-15"),
      history: fixtureHistory,
      trailingMonths: 1,
    });
    // Only the most recent month (-620) is used.
    expect(withOverride.forecast.trailingMonthsUsed).toBe(1);
    expect(withOverride.forecast.trailingAverage!.toString()).toBe("-620");
    // paceProjection = -600; blended with trailingAverage -620 over equal weight = -610
    expect(withOverride.forecast.projectedTotal.toString()).toBe("-610");
    expect(withOverride.fire).toBe(false);
  });
});
