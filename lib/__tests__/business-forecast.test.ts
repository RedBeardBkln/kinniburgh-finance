import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { capForecastHorizon, prorateExpensesAcrossHorizon } from "../business-forecast";

const D = (s: string) => new Decimal(s);
const d = (iso: string) => new Date(iso + "T00:00:00Z");

describe("capForecastHorizon", () => {
  it("1. no revenue data at all — uncapped, returns requestedDays unchanged", () => {
    const r = capForecastHorizon(90, null, d("2026-09-16"));
    expect(r).toEqual({ days: 90, wasCapped: false });
  });

  it("2. revenue exactly at the horizon boundary — not capped", () => {
    // 30 days out from 2026-09-16 is exactly 2026-10-16.
    const r = capForecastHorizon(30, d("2026-10-16"), d("2026-09-16"));
    expect(r).toEqual({ days: 30, wasCapped: false });
  });

  it("3. all revenue dates in the past — capped to 0", () => {
    const r = capForecastHorizon(90, d("2026-09-06"), d("2026-09-16"));
    expect(r).toEqual({ days: 0, wasCapped: true });
  });

  it("4. revenue extends beyond the requested horizon — not capped, requestedDays unchanged", () => {
    // Revenue confirmed 45 days out, but only a 30-day horizon was requested.
    const r = capForecastHorizon(30, d("2026-10-31"), d("2026-09-16"));
    expect(r).toEqual({ days: 30, wasCapped: false });
  });

  it("revenue short of the requested horizon — capped to the shorter value", () => {
    // Revenue confirmed only 45 days out; a 90-day horizon was requested.
    const r = capForecastHorizon(90, d("2026-10-31"), d("2026-09-16"));
    expect(r).toEqual({ days: 45, wasCapped: true });
  });
});

describe("prorateExpensesAcrossHorizon", () => {
  it("5. a single full calendar month present", () => {
    const periodTotals = new Map([["2026-09", D("1399")]]);
    const total = prorateExpensesAcrossHorizon(periodTotals, d("2026-09-01"), d("2026-10-01"));
    expect(total.toString()).toBe("1399");
  });

  it("6. a missing period contributes $0", () => {
    const periodTotals = new Map([["2026-08", D("100")]]);
    const total = prorateExpensesAcrossHorizon(periodTotals, d("2026-09-01"), d("2026-10-01"));
    expect(total.toString()).toBe("0");
  });

  it("7. a horizon spanning 2 months of different lengths", () => {
    // 2026-09-16 -> 2026-10-16: 15 days of September (30-day month) + 15 days
    // of October (31-day month). $300/30 * 15 = $150; $310/31 * 15 = $150.
    const periodTotals = new Map([
      ["2026-09", D("300")],
      ["2026-10", D("310")],
    ]);
    const total = prorateExpensesAcrossHorizon(periodTotals, d("2026-09-16"), d("2026-10-16"));
    expect(total.toString()).toBe("300");
  });

  it("8. an empty periodTotals map — all $0 (the EK Consulting case)", () => {
    const total = prorateExpensesAcrossHorizon(new Map(), d("2026-09-01"), d("2026-12-01"));
    expect(total.toString()).toBe("0");
  });

  it("an empty [from, to) window returns $0", () => {
    const periodTotals = new Map([["2026-09", D("1399")]]);
    const total = prorateExpensesAcrossHorizon(periodTotals, d("2026-09-16"), d("2026-09-16"));
    expect(total.toString()).toBe("0");
  });
});
