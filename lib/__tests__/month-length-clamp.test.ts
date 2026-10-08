import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  generateTransferOccurrences,
  generateIncomeOccurrences,
  generateBillOccurrences,
  type ScheduleEvent,
} from "@/lib/forecast";

// A day-of-month a month is too short to have means that month's LAST day, and
// days that collapse onto one date in a month yield one date (allMonthDays).

function d(iso: string) {
  return new Date(iso + "T00:00:00Z");
}
function iso(date: Date) {
  return date.toISOString().slice(0, 10);
}
function isos(events: ScheduleEvent[]) {
  return events.map((e) => iso(e.date));
}

function income(cadence: string, dayRules: unknown) {
  return {
    id: "i1",
    accountId: "acct-a",
    description: "Pay",
    cadence,
    dayRules,
    amount: new Decimal("9000"),
    active: true,
  };
}

function transfer(cadence: string, dayRules: unknown) {
  return {
    id: "t1",
    fromAccountId: "acct-a",
    toAccountId: "acct-b",
    amount: new Decimal("100"),
    cadence,
    dayRules,
    purpose: "Move",
    active: true,
  };
}

function staticBill(autopayDay: number | null, overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    accountId: "acct-a",
    payee: "Toyota Financial",
    amountType: "static",
    expectedAmount: "420.00",
    autopayDay,
    annualBudget: null,
    payMonth: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    ...overrides,
  };
}

function monthlyBillDates(day: number, from: string, to: string) {
  return isos(generateBillOccurrences(staticBill(day), d(from), d(to)));
}

describe("month-length day clamp: monthly bill", () => {
  it("day 31 across 2027 lands on each month's last day", () => {
    expect(monthlyBillDates(31, "2027-01-01", "2028-01-01")).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
      "2027-07-31",
      "2027-08-31",
      "2027-09-30",
      "2027-10-31",
      "2027-11-30",
      "2027-12-31",
    ]);
  });

  it("February: day 29/30/31 -> 28 in 2027 (non-leap), 29 in 2028 (leap)", () => {
    for (const day of [29, 30, 31]) {
      expect(monthlyBillDates(day, "2027-02-01", "2027-03-01")).toEqual(["2027-02-28"]);
      expect(monthlyBillDates(day, "2028-02-01", "2028-03-01")).toEqual(["2028-02-29"]);
    }
  });

  it("30-day months: day 31 -> the 30th; day 30 stays the 30th", () => {
    for (const month of ["2027-04", "2027-06", "2027-09", "2027-11"]) {
      const next = month.endsWith("11") ? "2027-12-01" : `2027-${String(Number(month.slice(5)) + 1).padStart(2, "0")}-01`;
      expect(monthlyBillDates(31, `${month}-01`, next)).toEqual([`${month}-30`]);
      expect(monthlyBillDates(30, `${month}-01`, next)).toEqual([`${month}-30`]);
    }
  });

  it("Toyota day 30: Oct-Jan unchanged, February 2027 now present", () => {
    expect(monthlyBillDates(30, "2026-10-01", "2027-03-31")).toEqual([
      "2026-10-30",
      "2026-11-30",
      "2026-12-30",
      "2027-01-30",
      "2027-02-28",
      "2027-03-30",
    ]);
  });

  it("day 15 and day 1 are unaffected", () => {
    expect(monthlyBillDates(15, "2027-01-01", "2027-04-01")).toEqual([
      "2027-01-15",
      "2027-02-15",
      "2027-03-15",
    ]);
    expect(monthlyBillDates(1, "2027-02-01", "2027-04-01")).toEqual(["2027-02-01", "2027-03-01"]);
  });

  it("accrued bill with no draws clamps like a static bill", () => {
    const accrued = {
      id: "b3",
      accountId: "acct-a",
      payee: "Oil",
      amountType: "accrued",
      expectedAmount: null,
      autopayDay: 31,
      annualBudget: "1200.00",
      frequency: "monthly",
      payDayOfWeek: null,
      biweeklyAnchorDate: null,
    };
    const dates = isos(generateBillOccurrences(accrued, d("2027-01-01"), d("2027-04-01")));
    expect(dates).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
  });

  it("annual bill with day 30 in February still lands on Feb 28 (already clamped, unchanged)", () => {
    const annual = staticBill(30, {
      frequency: "annual",
      annualBudget: "1200.00",
      payMonth: 2,
      expectedAmount: "100.00",
    });
    const events = generateBillOccurrences(annual, d("2027-01-01"), d("2028-01-01"));
    expect(isos(events)).toEqual(["2027-02-28"]);
  });
});

describe("month-length day clamp: semi-monthly income", () => {
  const rule = { daysOfMonth: [15, 31] };

  it("Eric [15,31] Oct 2026 - Jan 2027 includes Nov 30 and Dec 31, exactly 2 per month", () => {
    const dates = isos(generateIncomeOccurrences(income("semi_monthly", rule), d("2026-10-01"), d("2027-02-01")));
    expect(dates).toEqual([
      "2026-10-15",
      "2026-10-31",
      "2026-11-15",
      "2026-11-30",
      "2026-12-15",
      "2026-12-31",
      "2027-01-15",
      "2027-01-31",
    ]);
  });

  it("a calendar year yields 24 dates, including Nov 30, Feb 28, Apr 30, Jun 30, Sep 30", () => {
    const dates = isos(generateIncomeOccurrences(income("semi_monthly", rule), d("2027-01-01"), d("2028-01-01")));
    expect(dates).toHaveLength(24);
    expect(new Set(dates).size).toBe(24);
    for (const expected of ["2027-02-28", "2027-04-30", "2027-06-30", "2027-09-30", "2027-11-30"]) {
      expect(dates).toContain(expected);
    }
    expect(dates).toEqual([...dates].sort());
  });

  it("[1,15] is unchanged", () => {
    const dates = isos(
      generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: [1, 15] }), d("2027-02-01"), d("2027-04-01"))
    );
    expect(dates).toEqual(["2027-02-01", "2027-02-15", "2027-03-01", "2027-03-15"]);
  });

  it("[30,31] gives one date in Nov and two in Dec", () => {
    const rules = { daysOfMonth: [30, 31] };
    const nov = isos(generateIncomeOccurrences(income("semi_monthly", rules), d("2026-11-01"), d("2026-12-01")));
    expect(nov).toEqual(["2026-11-30"]);
    const dec = isos(generateIncomeOccurrences(income("semi_monthly", rules), d("2026-12-01"), d("2027-01-01")));
    expect(dec).toEqual(["2026-12-30", "2026-12-31"]);
  });

  it("[15,30,31] in February gives Feb 15 and a single Feb 28; [28,29,30,31] gives one date", () => {
    const a = isos(
      generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: [15, 30, 31] }), d("2027-02-01"), d("2027-03-01"))
    );
    expect(a).toEqual(["2027-02-15", "2027-02-28"]);
    const b = isos(
      generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: [28, 29, 30, 31] }), d("2027-02-01"), d("2027-03-01"))
    );
    expect(b).toEqual(["2027-02-28"]);
    const leap = isos(
      generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: [28, 29, 30, 31] }), d("2028-02-01"), d("2028-03-01"))
    );
    expect(leap).toEqual(["2028-02-28", "2028-02-29"]);
  });

  it("output is ascending even when the rule lists days out of order", () => {
    const dates = isos(
      generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: [31, 15] }), d("2027-01-01"), d("2027-04-01"))
    );
    expect(dates).toEqual([...dates].sort());
    expect(dates).toEqual(["2027-01-15", "2027-01-31", "2027-02-15", "2027-02-28", "2027-03-15", "2027-03-31"]);
  });

  it("monthly income on day 31 clamps", () => {
    const dates = isos(
      generateIncomeOccurrences(income("monthly", { dayOfMonth: 31 }), d("2027-02-01"), d("2027-05-01"))
    );
    expect(dates).toEqual(["2027-02-28", "2027-03-31", "2027-04-30"]);
  });
});

describe("month-length day clamp: transfers", () => {
  it("[30,31] in November: one out + one in on a single date; December has two dates", () => {
    const rules = { daysOfMonth: [30, 31] };
    const nov = generateTransferOccurrences(transfer("semi_monthly", rules), d("2026-11-01"), d("2026-12-01"));
    expect(nov).toHaveLength(2);
    expect(nov.map((e) => e.type).sort()).toEqual(["transfer_in", "transfer_out"]);
    expect(isos(nov)).toEqual(["2026-11-30", "2026-11-30"]);
    const dec = generateTransferOccurrences(transfer("semi_monthly", rules), d("2026-12-01"), d("2027-01-01"));
    expect(dec).toHaveLength(4);
    expect(dec.filter((e) => e.type === "transfer_out")).toHaveLength(2);
    expect(dec.filter((e) => e.type === "transfer_in")).toHaveLength(2);
  });

  it("monthly transfer day 31 lands on Feb 28", () => {
    const events = generateTransferOccurrences(transfer("monthly", { dayOfMonth: 31 }), d("2027-02-01"), d("2027-03-01"));
    expect(isos(events)).toEqual(["2027-02-28", "2027-02-28"]);
  });
});

describe("month-length day clamp: window edges and UTC", () => {
  const rule = { dayOfMonth: 30 };

  it("`from` equal to the clamped date is included (day-30 rule, window starts Feb 28)", () => {
    const dates = isos(generateIncomeOccurrences(income("monthly", rule), d("2027-02-28"), d("2027-03-15")));
    expect(dates).toEqual(["2027-02-28"]);
  });

  it("`to` equal to the clamped date is excluded", () => {
    const dates = isos(generateIncomeOccurrences(income("monthly", rule), d("2027-02-01"), d("2027-02-28")));
    expect(dates).toEqual([]);
  });

  it("`from` after the clamped date in the same month excludes it", () => {
    const dates = isos(generateIncomeOccurrences(income("monthly", rule), d("2027-03-01"), d("2027-03-15")));
    expect(dates).toEqual([]);
  });

  it("a window ending Mar 1 00:00Z includes Feb 28", () => {
    const dates = isos(generateIncomeOccurrences(income("monthly", rule), d("2027-02-10"), d("2027-03-01")));
    expect(dates).toEqual(["2027-02-28"]);
  });

  it("emits midnight-UTC dates and tolerates a non-midnight `from` instant", () => {
    const from = new Date("2027-02-27T23:30:00Z");
    const events = generateIncomeOccurrences(income("monthly", rule), from, d("2027-03-05"));
    expect(events.map((e) => e.date.toISOString())).toEqual(["2027-02-28T00:00:00.000Z"]);
    // A from instant later on Feb 28 is after the 00:00Z occurrence, so it is excluded.
    const later = generateIncomeOccurrences(income("monthly", rule), new Date("2027-02-28T05:00:00Z"), d("2027-03-05"));
    expect(later).toEqual([]);
  });
});
