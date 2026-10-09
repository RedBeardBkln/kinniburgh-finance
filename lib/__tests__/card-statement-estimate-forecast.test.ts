import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { generateCardEstimatePayments, monthlyDueDates } from "@/lib/forecast";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe("monthlyDueDates (clamped month-length helper for statement due dates)", () => {
  it("a day-31 anchor lands on the last day of short months and goes back to 31", () => {
    const dates = monthlyDueDates(31, d("2026-01-01"), d("2026-07-01")).map(iso);
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
  });

  it("November with a day-31 anchor is the 30th; a leap February is the 29th", () => {
    expect(monthlyDueDates(31, d("2026-11-01"), d("2026-12-01")).map(iso)).toEqual(["2026-11-30"]);
    expect(monthlyDueDates(30, d("2028-02-01"), d("2028-03-01")).map(iso)).toEqual(["2028-02-29"]);
  });

  it("one date per month (no duplicates) and honours the [from, to) window", () => {
    const dates = monthlyDueDates(5, d("2026-10-06"), d("2027-02-06")).map(iso);
    expect(dates).toEqual(["2026-11-05", "2026-12-05", "2027-01-05", "2027-02-05"]);
    expect(monthlyDueDates(5, d("2026-10-05"), d("2026-11-05")).map(iso)).toEqual(["2026-10-05"]); // `to` is exclusive
  });

  it("an out-of-range anchor day yields nothing instead of a wrong date", () => {
    expect(monthlyDueDates(0, d("2026-01-01"), d("2026-12-31"))).toEqual([]);
    expect(monthlyDueDates(32, d("2026-01-01"), d("2026-12-31"))).toEqual([]);
  });
});

describe("generateCardEstimatePayments", () => {
  const card = {
    nickname: "Barclay",
    fundingAccountId: "acct-cc",
    estimates: [
      { dueDate: d("2026-11-05"), amount: new Decimal("2914.91") },
      { dueDate: d("2026-12-05"), amount: new Decimal("700") },
      { dueDate: d("2026-12-20"), amount: new Decimal("0") },
    ],
  };

  it("emits one labelled outflow per estimate inside the window, into the funding account, full amount", () => {
    const events = generateCardEstimatePayments(card, d("2026-10-09"), d("2026-12-01"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accountId: "acct-cc", type: "bill", description: "Barclay statement payment (estimate)" });
    expect(events[0]!.amount.toFixed(2)).toBe("-2914.91");
    expect(iso(events[0]!.date)).toBe("2026-11-05");
  });

  it("skips zero amounts and dates outside [from, to)", () => {
    const events = generateCardEstimatePayments(card, d("2026-10-09"), d("2027-01-01"));
    expect(events.map((e) => iso(e.date))).toEqual(["2026-11-05", "2026-12-05"]);
    expect(generateCardEstimatePayments(card, d("2026-11-06"), d("2026-12-05"))).toEqual([]);
  });
});
