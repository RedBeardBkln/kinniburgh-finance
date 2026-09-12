import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { rollupForecast } from "../forecast-rollup";
import type { DayForecast } from "../forecast";

const D = (s: string) => new Decimal(s);
const d = (iso: string) => new Date(iso + "T00:00:00Z");

function makeDay(iso: string, balance: string, isBreachDay = false): DayForecast {
  return { date: d(iso), balanceAfter: D(balance), events: [], isBreachDay };
}

function addDays(iso: string, n: number): string {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

describe("rollupForecast", () => {
  it("1. daily passthrough", () => {
    const forecast = [
      makeDay("2026-09-01", "1000"),
      makeDay("2026-09-02", "900"),
      makeDay("2026-09-03", "950"),
    ];
    const buckets = rollupForecast(forecast, "daily");
    expect(buckets).toHaveLength(3);
    buckets.forEach((b, i) => {
      expect(b.periodStart).toEqual(forecast[i]!.date);
      expect(b.periodEnd).toEqual(forecast[i]!.date);
      expect(b.daysIncluded).toBe(1);
      expect(b.isPartial).toBe(false);
      expect(b.endingBalance.toString()).toBe(forecast[i]!.balanceAfter.toString());
      expect(b.minBalance.toString()).toBe(forecast[i]!.balanceAfter.toString());
      expect(b.hasBreach).toBe(false);
      expect(b.firstBreachDate).toBeNull();
    });
  });

  it("2. weekly, exact multiple of 7", () => {
    const forecast: DayForecast[] = [];
    for (let i = 0; i < 14; i++) {
      forecast.push(makeDay(addDays("2026-09-01", i), String(1000 + 10 * i)));
    }
    const buckets = rollupForecast(forecast, "weekly");
    expect(buckets).toHaveLength(2);

    expect(buckets[0]!.periodStart).toEqual(d("2026-09-01"));
    expect(buckets[0]!.periodEnd).toEqual(d("2026-09-07"));
    expect(buckets[0]!.daysIncluded).toBe(7);
    expect(buckets[0]!.isPartial).toBe(false);
    expect(buckets[0]!.endingBalance.toString()).toBe("1060");
    expect(buckets[0]!.minBalance.toString()).toBe("1000");

    expect(buckets[1]!.periodStart).toEqual(d("2026-09-08"));
    expect(buckets[1]!.periodEnd).toEqual(d("2026-09-14"));
    expect(buckets[1]!.daysIncluded).toBe(7);
    expect(buckets[1]!.isPartial).toBe(false);
    expect(buckets[1]!.endingBalance.toString()).toBe("1130");
    expect(buckets[1]!.minBalance.toString()).toBe("1070");
  });

  it("3. weekly, breach mid-bucket not on the ending day", () => {
    const balances = ["500", "400", "100", "600", "650", "700", "750", "800", "820", "830"];
    const forecast: DayForecast[] = balances.map((bal, i) =>
      makeDay(addDays("2026-09-01", i), bal, i === 2)
    );
    const buckets = rollupForecast(forecast, "weekly");
    expect(buckets).toHaveLength(2);

    expect(buckets[0]!.periodStart).toEqual(d("2026-09-01"));
    expect(buckets[0]!.periodEnd).toEqual(d("2026-09-07"));
    expect(buckets[0]!.daysIncluded).toBe(7);
    expect(buckets[0]!.isPartial).toBe(false);
    expect(buckets[0]!.endingBalance.toString()).toBe("750");
    expect(buckets[0]!.minBalance.toString()).toBe("100");
    expect(buckets[0]!.hasBreach).toBe(true);
    expect(buckets[0]!.firstBreachDate).toEqual(d("2026-09-03"));

    expect(buckets[1]!.periodStart).toEqual(d("2026-09-08"));
    expect(buckets[1]!.periodEnd).toEqual(d("2026-09-10"));
    expect(buckets[1]!.daysIncluded).toBe(3);
    expect(buckets[1]!.isPartial).toBe(true);
    expect(buckets[1]!.endingBalance.toString()).toBe("830");
    expect(buckets[1]!.minBalance.toString()).toBe("800");
    expect(buckets[1]!.hasBreach).toBe(false);
    expect(buckets[1]!.firstBreachDate).toBeNull();
  });

  it("4. weekly, firstBreachDate picks the earliest breach, not the last", () => {
    const forecast = [
      makeDay("2026-09-01", "100", true),
      makeDay("2026-09-02", "110", true),
      makeDay("2026-09-03", "120", false),
    ];
    const buckets = rollupForecast(forecast, "weekly");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.daysIncluded).toBe(3);
    expect(buckets[0]!.isPartial).toBe(true);
    expect(buckets[0]!.hasBreach).toBe(true);
    expect(buckets[0]!.firstBreachDate).toEqual(d("2026-09-01"));
  });

  it("5. monthly, spans a month boundary, both ends partial", () => {
    const balances = ["100", "110", "120", "130", "140", "150", "160"];
    const forecast: DayForecast[] = balances.map((bal, i) =>
      makeDay(addDays("2026-01-28", i), bal)
    );
    const buckets = rollupForecast(forecast, "monthly");
    expect(buckets).toHaveLength(2);

    expect(buckets[0]!.periodStart).toEqual(d("2026-01-28"));
    expect(buckets[0]!.periodEnd).toEqual(d("2026-01-31"));
    expect(buckets[0]!.daysIncluded).toBe(4);
    expect(buckets[0]!.isPartial).toBe(true);
    expect(buckets[0]!.endingBalance.toString()).toBe("130");
    expect(buckets[0]!.minBalance.toString()).toBe("100");

    expect(buckets[1]!.periodStart).toEqual(d("2026-02-01"));
    expect(buckets[1]!.periodEnd).toEqual(d("2026-02-03"));
    expect(buckets[1]!.daysIncluded).toBe(3);
    expect(buckets[1]!.isPartial).toBe(true);
    expect(buckets[1]!.endingBalance.toString()).toBe("160");
    expect(buckets[1]!.minBalance.toString()).toBe("140");
  });

  it("6. monthly, exact full calendar month", () => {
    const forecast: DayForecast[] = [];
    for (let i = 0; i < 28; i++) {
      forecast.push(makeDay(addDays("2026-02-01", i), "500"));
    }
    const buckets = rollupForecast(forecast, "monthly");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.periodStart).toEqual(d("2026-02-01"));
    expect(buckets[0]!.periodEnd).toEqual(d("2026-02-28"));
    expect(buckets[0]!.daysIncluded).toBe(28);
    expect(buckets[0]!.isPartial).toBe(false);
    expect(buckets[0]!.endingBalance.toString()).toBe("500");
    expect(buckets[0]!.minBalance.toString()).toBe("500");
    expect(buckets[0]!.hasBreach).toBe(false);
  });

  it("7. quarterly, spans a quarter boundary", () => {
    const forecast: DayForecast[] = [];
    for (let i = 0; i <= 10; i++) {
      forecast.push(makeDay(addDays("2026-03-26", i), String(10 * i)));
    }
    const buckets = rollupForecast(forecast, "quarterly");
    expect(buckets).toHaveLength(2);

    expect(buckets[0]!.periodStart).toEqual(d("2026-03-26"));
    expect(buckets[0]!.periodEnd).toEqual(d("2026-03-31"));
    expect(buckets[0]!.daysIncluded).toBe(6);
    expect(buckets[0]!.isPartial).toBe(true);
    expect(buckets[0]!.endingBalance.toString()).toBe("50");
    expect(buckets[0]!.minBalance.toString()).toBe("0");

    expect(buckets[1]!.periodStart).toEqual(d("2026-04-01"));
    expect(buckets[1]!.periodEnd).toEqual(d("2026-04-05"));
    expect(buckets[1]!.daysIncluded).toBe(5);
    expect(buckets[1]!.isPartial).toBe(true);
    expect(buckets[1]!.endingBalance.toString()).toBe("100");
    expect(buckets[1]!.minBalance.toString()).toBe("60");
  });

  it("8. quarterly, exact full calendar quarter", () => {
    const forecast: DayForecast[] = [];
    for (let i = 0; i < 91; i++) {
      forecast.push(makeDay(addDays("2026-04-01", i), "1"));
    }
    const buckets = rollupForecast(forecast, "quarterly");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.periodStart).toEqual(d("2026-04-01"));
    expect(buckets[0]!.periodEnd).toEqual(d("2026-06-30"));
    expect(buckets[0]!.daysIncluded).toBe(91);
    expect(buckets[0]!.isPartial).toBe(false);
  });

  it("9. empty input returns [] for every horizon", () => {
    expect(rollupForecast([], "daily")).toEqual([]);
    expect(rollupForecast([], "weekly")).toEqual([]);
    expect(rollupForecast([], "monthly")).toEqual([]);
    expect(rollupForecast([], "quarterly")).toEqual([]);
  });

  it("10. single-day input, weekly horizon", () => {
    const forecast = [makeDay("2026-09-01", "500")];
    const buckets = rollupForecast(forecast, "weekly");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.daysIncluded).toBe(1);
    expect(buckets[0]!.isPartial).toBe(true);
    expect(buckets[0]!.periodStart).toEqual(d("2026-09-01"));
    expect(buckets[0]!.periodEnd).toEqual(d("2026-09-01"));
    expect(buckets[0]!.endingBalance.toString()).toBe("500");
    expect(buckets[0]!.minBalance.toString()).toBe("500");
  });

  // ── Tester-added: edge cases not in the plan's 10 specified cases ──────────

  it("11. monthly rollup spans a year boundary (Dec -> Jan)", () => {
    const balances = ["100", "110", "120", "130"];
    const forecast: DayForecast[] = balances.map((bal, i) =>
      makeDay(addDays("2026-12-30", i), bal)
    );
    const buckets = rollupForecast(forecast, "monthly");
    expect(buckets).toHaveLength(2);

    expect(buckets[0]!.periodStart).toEqual(d("2026-12-30"));
    expect(buckets[0]!.periodEnd).toEqual(d("2026-12-31"));
    expect(buckets[0]!.daysIncluded).toBe(2);
    expect(buckets[0]!.isPartial).toBe(true);
    expect(buckets[0]!.endingBalance.toString()).toBe("110");

    expect(buckets[1]!.periodStart).toEqual(d("2027-01-01"));
    expect(buckets[1]!.periodEnd).toEqual(d("2027-01-02"));
    expect(buckets[1]!.daysIncluded).toBe(2);
    expect(buckets[1]!.isPartial).toBe(true);
    expect(buckets[1]!.endingBalance.toString()).toBe("130");
  });

  it("12. quarterly rollup spans a year boundary (Q4 -> Q1)", () => {
    const balances = ["10", "20", "30", "40"];
    const forecast: DayForecast[] = balances.map((bal, i) =>
      makeDay(addDays("2026-12-30", i), bal)
    );
    const buckets = rollupForecast(forecast, "quarterly");
    expect(buckets).toHaveLength(2);

    expect(buckets[0]!.periodStart).toEqual(d("2026-12-30"));
    expect(buckets[0]!.periodEnd).toEqual(d("2026-12-31"));
    expect(buckets[0]!.daysIncluded).toBe(2);
    expect(buckets[0]!.isPartial).toBe(true);

    expect(buckets[1]!.periodStart).toEqual(d("2027-01-01"));
    expect(buckets[1]!.periodEnd).toEqual(d("2027-01-02"));
    expect(buckets[1]!.daysIncluded).toBe(2);
    expect(buckets[1]!.isPartial).toBe(true);
  });

  it("13. quarterly rollup, exact full quarter starting mid-year (Q3)", () => {
    const forecast: DayForecast[] = [];
    // Jul (31) + Aug (31) + Sep (30) = 92 days
    for (let i = 0; i < 92; i++) {
      forecast.push(makeDay(addDays("2026-07-01", i), "1"));
    }
    const buckets = rollupForecast(forecast, "quarterly");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.periodStart).toEqual(d("2026-07-01"));
    expect(buckets[0]!.periodEnd).toEqual(d("2026-09-30"));
    expect(buckets[0]!.daysIncluded).toBe(92);
    expect(buckets[0]!.isPartial).toBe(false);
  });

  it("14. rollupForecast does not mutate the input array", () => {
    const forecast = [
      makeDay("2026-09-01", "1000"),
      makeDay("2026-09-02", "900"),
    ];
    const snapshot = forecast.map((d) => ({ ...d }));
    rollupForecast(forecast, "weekly");
    expect(forecast).toEqual(snapshot);
  });
});
