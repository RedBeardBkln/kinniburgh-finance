import { describe, it, expect } from "vitest";
import {
  annualDueDate,
  isValidAnnualDay,
  nextAnnualDueDate,
  assessAnnualFunding,
  assessAccountReserve,
} from "@/lib/annual-bill";

function d(iso: string) {
  return new Date(iso + "T00:00:00Z");
}
function iso(date: Date) {
  return date.toISOString().slice(0, 10);
}

describe("annualDueDate", () => {
  it("builds the date in the given year", () => {
    expect(iso(annualDueDate(2026, 10, 15))).toBe("2026-10-15");
  });

  it("clamps a day past the end of the month (Feb 29 in a non-leap year → Feb 28)", () => {
    expect(iso(annualDueDate(2026, 2, 29))).toBe("2026-02-28");
    expect(iso(annualDueDate(2028, 2, 29))).toBe("2028-02-29");
  });
});

describe("isValidAnnualDay", () => {
  it("accepts real dates, including Feb 29", () => {
    expect(isValidAnnualDay(10, 15)).toBe(true);
    expect(isValidAnnualDay(1, 31)).toBe(true);
    expect(isValidAnnualDay(2, 29)).toBe(true);
  });

  it("rejects days that never exist in the month, and out-of-range values", () => {
    expect(isValidAnnualDay(2, 30)).toBe(false);
    expect(isValidAnnualDay(4, 31)).toBe(false);
    expect(isValidAnnualDay(13, 1)).toBe(false);
    expect(isValidAnnualDay(0, 1)).toBe(false);
    expect(isValidAnnualDay(6, 0)).toBe(false);
    expect(isValidAnnualDay(6, 1.5)).toBe(false);
  });
});

describe("nextAnnualDueDate", () => {
  it("returns this year's date when it is still ahead", () => {
    expect(iso(nextAnnualDueDate(d("2026-10-03"), 10, 15))).toBe("2026-10-15");
  });

  it("counts today as due (on or after)", () => {
    expect(iso(nextAnnualDueDate(d("2026-10-15"), 10, 15))).toBe("2026-10-15");
  });

  it("rolls to next year once the date has passed", () => {
    expect(iso(nextAnnualDueDate(d("2026-10-16"), 10, 15))).toBe("2027-10-15");
  });
});

describe("assessAnnualFunding", () => {
  // $4,200 property tax due Oct 15; $350/mo × 12 = exactly $4,200.
  const base = { totalDueCents: 420000, dueMonth: 10, dueDay: 15 };

  it("exactly funded: total due / 12 is not underfunded", () => {
    const a = assessAnnualFunding({ ...base, monthlyCents: 35000, today: d("2026-10-03") });
    expect(a.projectedAtDueCents).toBe(420000);
    expect(a.shortfallCents).toBe(0);
    expect(a.isUnderfunded).toBe(false);
    expect(a.requiredMonthlyCents).toBe(35000);
  });

  it("underfunded: reports the shortfall and the monthly amount that fixes it", () => {
    const a = assessAnnualFunding({ ...base, monthlyCents: 30000, today: d("2026-10-03") });
    expect(a.projectedAtDueCents).toBe(360000);
    expect(a.shortfallCents).toBe(60000);
    expect(a.isUnderfunded).toBe(true);
    expect(a.requiredMonthlyCents).toBe(35000);
  });

  it("overfunded: no shortfall", () => {
    const a = assessAnnualFunding({ ...base, monthlyCents: 40000, today: d("2026-10-03") });
    expect(a.shortfallCents).toBe(0);
    expect(a.isUnderfunded).toBe(false);
  });

  it("required monthly rounds UP to the cent so the bill is never short by a fraction", () => {
    // $1,000 / 12 = 83.333… → 83.34
    const a = assessAnnualFunding({
      monthlyCents: 8333,
      totalDueCents: 100000,
      dueMonth: 3,
      dueDay: 1,
      today: d("2026-01-15"),
    });
    expect(a.requiredMonthlyCents).toBe(8334);
    // 8333 × 12 = 99,996 — 4 cents short, still flagged
    expect(a.shortfallCents).toBe(4);
    expect(a.isUnderfunded).toBe(true);
  });

  it("accrued-to-date counts whole months since the previous due date", () => {
    // previous due 2025-10-15; on 2026-03-20 → 5 whole months elapsed
    const a = assessAnnualFunding({ ...base, monthlyCents: 35000, today: d("2026-03-20") });
    expect(iso(a.previousDueDate)).toBe("2025-10-15");
    expect(iso(a.nextDueDate)).toBe("2026-10-15");
    expect(a.monthsElapsed).toBe(5);
    expect(a.accruedToDateCents).toBe(5 * 35000);
  });

  it("does not count a month until its day-of-month has been reached", () => {
    // 2026-03-14 is one day short of the 5th monthly mark (prev due 2025-10-15)
    const a = assessAnnualFunding({ ...base, monthlyCents: 35000, today: d("2026-03-14") });
    expect(a.monthsElapsed).toBe(4);
  });

  it("on the due date itself a full cycle has accrued", () => {
    const a = assessAnnualFunding({ ...base, monthlyCents: 35000, today: d("2026-10-15") });
    expect(a.monthsElapsed).toBe(12);
    expect(a.accruedToDateCents).toBe(420000);
  });

  it("the day after the due date a new cycle starts at zero", () => {
    const a = assessAnnualFunding({ ...base, monthlyCents: 35000, today: d("2026-10-16") });
    expect(iso(a.nextDueDate)).toBe("2027-10-15");
    expect(a.monthsElapsed).toBe(0);
    expect(a.accruedToDateCents).toBe(0);
  });
});

describe("assessAccountReserve", () => {
  it("returns null when the balance is unknown", () => {
    expect(assessAccountReserve(null, [100000])).toBeNull();
  });

  it("covered: balance at or above the accrued reserve", () => {
    const r = assessAccountReserve(500000, [200000, 300000]);
    expect(r).toEqual({ reservedCents: 500000, shortfallCents: 0, isShort: false });
  });

  it("short: balance below the accrued reserve reports how much is missing", () => {
    const r = assessAccountReserve(350000, [200000, 300000]);
    expect(r).toEqual({ reservedCents: 500000, shortfallCents: 150000, isShort: true });
  });

  it("no annual bills accrued yet is trivially covered", () => {
    expect(assessAccountReserve(0, [])).toEqual({ reservedCents: 0, shortfallCents: 0, isShort: false });
  });
});
