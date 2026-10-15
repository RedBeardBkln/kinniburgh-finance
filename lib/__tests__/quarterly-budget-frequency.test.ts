import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Decimal } from "@prisma/client/runtime/library";
import { assessAnnualFunding, cycleMonthsFor, dueMonthsFor, isLumpSumFrequency } from "@/lib/annual-bill";
import { generateBillOccurrences } from "@/lib/forecast";
import { formatSchedule, scheduleSortKey, type ScheduleLike } from "@/lib/schedule-display";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

const sched = (over: Partial<ScheduleLike> = {}): ScheduleLike => ({
  frequency: "monthly",
  payDay: null,
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  ...over,
});

describe("quarterly is a lump-sum frequency with a three-month cycle", () => {
  it("is recognised and has a 3-month cycle", () => {
    expect(isLumpSumFrequency("quarterly")).toBe(true);
    expect(cycleMonthsFor("quarterly")).toBe(3);
    expect(cycleMonthsFor("semiannual")).toBe(6);
    expect(cycleMonthsFor("annual")).toBe(12);
  });

  it("due months are every third month from the first, ascending", () => {
    expect(dueMonthsFor(1, 3)).toEqual([1, 4, 7, 10]);
    expect(dueMonthsFor(11, 3)).toEqual([2, 5, 8, 11]);
    expect(dueMonthsFor(12, 3)).toEqual([3, 6, 9, 12]);
  });

  it("funding check: monthly set-aside vs the amount due each quarter", () => {
    // $100/mo builds to $300 per quarter; $450 due each time is $150 short and needs $150/mo.
    const a = assessAnnualFunding({
      monthlyCents: 10000,
      totalDueCents: 45000,
      cycleMonths: 3,
      dueMonth: 1,
      dueDay: 15,
      today: d("2026-10-20"),
    });
    expect(iso(a.nextDueDate)).toBe("2027-01-15");
    expect(iso(a.previousDueDate)).toBe("2026-10-15");
    expect(a.monthsElapsed).toBe(0);
    expect(a.projectedAtDueCents).toBe(30000);
    expect(a.shortfallCents).toBe(15000);
    expect(a.requiredMonthlyCents).toBe(15000);
    expect(a.isUnderfunded).toBe(true);
  });
});

describe("forecast: a quarterly bill pays four times a year", () => {
  const bill = (over: { payMonth?: number; annualBudget?: string } = {}) => ({
    id: "q1",
    accountId: "acct",
    payee: "Water",
    amountType: "static",
    expectedAmount: "100.00",
    autopayDay: 15,
    annualBudget: over.annualBudget ?? "300.00",
    payMonth: over.payMonth ?? 1,
    frequency: "quarterly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
  });

  it("emits one outflow for the full amount due on each of the four dates", () => {
    const events = generateBillOccurrences(bill(), d("2026-01-01"), d("2027-01-01"));
    expect(events.map((e) => iso(e.date))).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
    for (const e of events) expect(e.amount.equals(new Decimal(-300))).toBe(true);
  });

  it("a later first month wraps around the year", () => {
    const events = generateBillOccurrences(bill({ payMonth: 11 }), d("2026-01-01"), d("2027-01-01"));
    expect(events.map((e) => iso(e.date))).toEqual(["2026-02-15", "2026-05-15", "2026-08-15", "2026-11-15"]);
  });

  it("only the dates inside the half-open window are returned", () => {
    const events = generateBillOccurrences(bill(), d("2026-04-15"), d("2026-10-15"));
    expect(events.map((e) => iso(e.date))).toEqual(["2026-04-15", "2026-07-15"]);
  });

  it("without a due month it emits nothing instead of guessing", () => {
    const b = { ...bill(), payMonth: null as number | null };
    expect(generateBillOccurrences(b, d("2026-01-01"), d("2027-01-01"))).toEqual([]);
  });
});

describe("schedule display", () => {
  it("lists the four months with the day, in calendar order", () => {
    expect(formatSchedule(sched({ frequency: "quarterly", payMonth: 1, payDay: 15 }))).toBe(
      "Quarterly · Jan 15, Apr 15, Jul 15 & Oct 15"
    );
    expect(formatSchedule(sched({ frequency: "quarterly", payMonth: 11, payDay: 1 }))).toBe(
      "Quarterly · Feb 1, May 1, Aug 1 & Nov 1"
    );
  });

  it("shows a dash when the month or day is missing", () => {
    expect(formatSchedule(sched({ frequency: "quarterly", payMonth: null, payDay: 15 }))).toBe("Quarterly · —");
    expect(formatSchedule(sched({ frequency: "quarterly", payMonth: 3, payDay: null }))).toBe("Quarterly · —");
  });

  it("sorts with the other lump-sum lines, by its earliest month", () => {
    expect(scheduleSortKey(sched({ frequency: "quarterly", payMonth: 11, payDay: 15 }))).toEqual([2, 215]);
    expect(scheduleSortKey(sched({ frequency: "quarterly", payMonth: null, payDay: null }))).toEqual([2, 1399]);
  });
});

describe("wiring (source guards)", () => {
  it("both budget actions accept quarterly", () => {
    const src = read("actions/budgets.ts");
    const hits = src.match(/z\.enum\(\["monthly", "weekly", "biweekly", "annual", "semiannual", "quarterly"\]\)/g) ?? [];
    expect(hits).toHaveLength(2);
  });

  it("the edit dialog offers it and treats it as a lump-sum line", () => {
    const src = read("components/budgets/budget-edit-modal.tsx");
    expect(src).toContain('{ value: "quarterly", label: "Quarterly (every 3 months)" }');
    expect(src).toMatch(/type Frequency = [^;]*"quarterly"/);
  });
});
