import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  previousPeriod,
  periodMidpointDate,
  reconstructForecastAccuracy,
  selectNotableAccuracyRows,
  MAX_ACCURACY_ROWS,
  MIN_NOTABLE_MISS_AMOUNT,
  type TaggedForecastAccuracy,
} from "../review-forecast";
import type { MonthlySpendPoint } from "../spend-forecast";

const D = (s: string) => new Decimal(s);
const d = (iso: string) => new Date(iso + "T00:00:00Z");

function history(entries: [string, string][]): MonthlySpendPoint[] {
  return entries.map(([period, total]) => ({ period, total: D(total) }));
}

describe("previousPeriod", () => {
  it("1. regular month", () => {
    expect(previousPeriod("2026-09")).toBe("2026-08");
  });

  it("2. year rollover", () => {
    expect(previousPeriod("2026-01")).toBe("2025-12");
  });

  it("3. December stays within the year", () => {
    expect(previousPeriod("2026-12")).toBe("2026-11");
  });

  it("4. invalid formats throw", () => {
    expect(() => previousPeriod("26-09")).toThrow();
    expect(() => previousPeriod("2026-9")).toThrow();
    expect(() => previousPeriod("")).toThrow();
  });
});

describe("periodMidpointDate", () => {
  it("1. 30-day month", () => {
    expect(periodMidpointDate("2026-09").toISOString()).toBe(
      d("2026-09-15").toISOString()
    );
  });

  it("2. 31-day month", () => {
    expect(periodMidpointDate("2026-08").toISOString()).toBe(
      d("2026-08-16").toISOString()
    );
  });

  it("3. 28-day (non-leap) February", () => {
    expect(periodMidpointDate("2026-02").toISOString()).toBe(
      d("2026-02-14").toISOString()
    );
  });

  it("4. 29-day leap-year February", () => {
    expect(periodMidpointDate("2028-02").toISOString()).toBe(
      d("2028-02-15").toISOString()
    );
  });

  it("5. invalid format throws", () => {
    expect(() => periodMidpointDate("2026/09")).toThrow();
  });
});

describe("reconstructForecastAccuracy", () => {
  it("1. exact match, high confidence", () => {
    const r = reconstructForecastAccuracy({
      period: "2026-09",
      spendAtMidpoint: D("-300"),
      actualFinal: D("-600"),
      history: history([
        ["2026-06", "-600"],
        ["2026-07", "-580"],
        ["2026-08", "-620"],
      ]),
    });
    expect(r.projected.toString()).toBe("600");
    expect(r.actual.toString()).toBe("600");
    expect(r.missAbs.toString()).toBe("0");
    expect(r.percentOff).toBe(0);
    expect(r.direction).toBe("exact");
    expect(r.confidence).toBe("high");
  });

  it("2. under-projection", () => {
    const r = reconstructForecastAccuracy({
      period: "2026-09",
      spendAtMidpoint: D("-500"),
      actualFinal: D("-800"),
      history: history([
        ["2026-06", "-300"],
        ["2026-07", "-280"],
        ["2026-08", "-320"],
      ]),
    });
    expect(r.projected.toString()).toBe("650");
    expect(r.actual.toString()).toBe("800");
    expect(r.missAbs.toString()).toBe("150");
    expect(r.percentOff).toBe(19);
    expect(r.direction).toBe("under");
    expect(r.confidence).toBe("high");
  });

  it("3. over-projection", () => {
    const r = reconstructForecastAccuracy({
      period: "2026-09",
      spendAtMidpoint: D("-1000"),
      actualFinal: D("-700"),
      history: history([
        ["2026-06", "-300"],
        ["2026-07", "-280"],
        ["2026-08", "-320"],
      ]),
    });
    expect(r.projected.toString()).toBe("1150");
    expect(r.actual.toString()).toBe("700");
    expect(r.missAbs.toString()).toBe("450");
    expect(r.percentOff).toBe(64);
    expect(r.direction).toBe("over");
    expect(r.confidence).toBe("high");
  });

  it("4. low confidence (no trailing history)", () => {
    const r = reconstructForecastAccuracy({
      period: "2026-09",
      spendAtMidpoint: D("-200"),
      actualFinal: D("-380"),
      history: [],
    });
    expect(r.projected.toString()).toBe("400");
    expect(r.missAbs.toString()).toBe("20");
    expect(r.percentOff).toBe(5);
    expect(r.direction).toBe("over");
    expect(r.confidence).toBe("low");
    expect(r.reconstructedForecast.method).toBe("pace_only");
  });

  it("5. actualFinal is zero — percentOff div-by-zero guard", () => {
    const r = reconstructForecastAccuracy({
      period: "2026-09",
      spendAtMidpoint: D("-100"),
      actualFinal: D("0"),
      history: [],
    });
    expect(r.projected.toString()).toBe("200");
    expect(r.actual.toString()).toBe("0");
    expect(r.missAbs.toString()).toBe("200");
    expect(r.percentOff).toBeNull();
    expect(r.direction).toBe("over");
  });
});

describe("selectNotableAccuracyRows", () => {
  function row(overrides: {
    tagName: string;
    entityName?: string;
    missAbs: string;
    confidence: "low" | "medium" | "high";
  }): TaggedForecastAccuracy {
    return {
      tagName: overrides.tagName,
      entityName: overrides.entityName ?? "Personal",
      result: {
        projected: D("0"),
        actual: D("0"),
        missAbs: D(overrides.missAbs),
        percentOff: 0,
        direction: "over",
        confidence: overrides.confidence,
        reconstructedForecast: {
          period: "2026-09",
          daysElapsed: 15,
          daysInPeriod: 30,
          spendToDate: D("0"),
          paceProjection: D("0"),
          trailingAverage: null,
          trailingMonthsUsed: 0,
          projectedTotal: D("0"),
          method: "pace_only",
          confidence: overrides.confidence,
        },
      },
    };
  }

  it("1. drops a low-confidence row even though missAbs clears the floor", () => {
    const rows = [row({ tagName: "Groceries", missAbs: "20", confidence: "low" })];
    expect(selectNotableAccuracyRows(rows)).toEqual([]);
  });

  it("2. drops a row at/below MIN_NOTABLE_MISS_AMOUNT even at high confidence", () => {
    const rows = [row({ tagName: "Groceries", missAbs: "5", confidence: "high" })];
    expect(selectNotableAccuracyRows(rows)).toEqual([]);
  });

  it("3. caps to MAX_ACCURACY_ROWS, keeping the largest misses sorted descending", () => {
    const rows: TaggedForecastAccuracy[] = [
      row({ tagName: "A", missAbs: "50", confidence: "high" }),
      row({ tagName: "B", missAbs: "200", confidence: "high" }),
      row({ tagName: "C", missAbs: "20", confidence: "high" }),
      row({ tagName: "D", missAbs: "150", confidence: "high" }),
      row({ tagName: "E", missAbs: "100", confidence: "high" }),
      row({ tagName: "F", missAbs: "75", confidence: "high" }),
    ];
    const result = selectNotableAccuracyRows(rows);
    expect(result).toHaveLength(MAX_ACCURACY_ROWS);
    expect(result.map((r) => r.tagName)).toEqual(["B", "D", "E", "F", "A"]);
  });

  it("4. returns [] for empty input and for input where nothing clears the filters", () => {
    expect(selectNotableAccuracyRows([])).toEqual([]);
    const rows = [
      row({ tagName: "A", missAbs: "1", confidence: "high" }),
      row({ tagName: "B", missAbs: "100", confidence: "low" }),
    ];
    expect(selectNotableAccuracyRows(rows)).toEqual([]);
  });

  it("5. custom opts.maxRows/minMissAmount override the defaults", () => {
    const rows: TaggedForecastAccuracy[] = [
      row({ tagName: "A", missAbs: "50", confidence: "high" }),
      row({ tagName: "B", missAbs: "20", confidence: "high" }),
      row({ tagName: "C", missAbs: "5", confidence: "high" }),
    ];
    const result = selectNotableAccuracyRows(rows, { maxRows: 1, minMissAmount: D("15") });
    expect(result).toHaveLength(1);
    expect(result[0]!.tagName).toBe("A");
    expect(MIN_NOTABLE_MISS_AMOUNT.toString()).toBe("10"); // sanity check on the default constant
  });
});
