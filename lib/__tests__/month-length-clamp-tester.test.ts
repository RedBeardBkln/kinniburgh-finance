import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  generateTransferOccurrences,
  generateIncomeOccurrences,
  generateBillOccurrences,
  buildAccountForecast,
  type ScheduleEvent,
} from "@/lib/forecast";
import { rollupForecast } from "@/lib/forecast-rollup";

// Tester-owned. Independent oracle + fuzz + downstream-consumer checks for the
// allMonthDays clamp. allMonthDays is private, so everything goes through the
// exported generators.

const DAY = 86400000;
const d = (iso: string) => new Date(iso + "T00:00:00Z");
const iso = (x: Date) => x.toISOString().slice(0, 10);

// Independent calendar (own leap rule, no Date arithmetic for month length).
function isLeap(y: number) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
function lastDay(y: number, m0: number) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m0]!;
}

/** Oracle: for each month the window can touch, set of min(day,last), within [from,to), sorted. */
function oracle(from: Date, to: Date, days: number[]): string[] {
  const out = new Set<number>();
  let y = from.getUTCFullYear() - 0;
  let m = from.getUTCMonth();
  const ey = to.getUTCFullYear();
  const em = to.getUTCMonth();
  while (y < ey || (y === ey && m <= em)) {
    for (const day of days) {
      const dd = Math.min(day, lastDay(y, m));
      const t = Date.UTC(y, m, dd);
      if (t >= from.getTime() && t < to.getTime()) out.add(t);
    }
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return [...out].sort((a, b) => a - b).map((t) => new Date(t).toISOString());
}

// Seeded PRNG (mulberry32).
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const income = (cadence: string, dayRules: unknown) => ({
  id: "i",
  accountId: "a",
  description: "Pay",
  cadence,
  dayRules,
  amount: new Decimal("9000"),
  active: true,
});
const transfer = (cadence: string, dayRules: unknown) => ({
  id: "t",
  fromAccountId: "a",
  toAccountId: "b",
  amount: new Decimal("100"),
  cadence,
  dayRules,
  purpose: "Move",
  active: true,
});
const bill = (autopayDay: number | null, over: Record<string, unknown> = {}) => ({
  id: "b",
  accountId: "a",
  payee: "Toyota Financial",
  amountType: "static",
  expectedAmount: "420.00",
  autopayDay,
  annualBudget: null,
  payMonth: null,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  ...over,
});

const isosOf = (evs: ScheduleEvent[]) => evs.map((e) => e.date.toISOString());

describe("allMonthDays clamp: oracle fuzz (all three generators)", () => {
  it("matches the independent oracle for 3000 random day lists / windows", () => {
    const r = rng(20261008);
    for (let n = 0; n < 3000; n++) {
      const k = 1 + Math.floor(r() * 5);
      const days = Array.from({ length: k }, () => 1 + Math.floor(r() * 31));
      // windows across 1899..2101 including century years; sometimes mid-day times
      const startYear = [1899, 1900, 2024, 2026, 2027, 2028, 2099, 2100][Math.floor(r() * 8)]!;
      const from = new Date(
        Date.UTC(startYear, Math.floor(r() * 12), 1 + Math.floor(r() * 31)) +
          (r() < 0.3 ? Math.floor(r() * DAY) : 0)
      );
      const span = Math.floor(r() * 800); // days
      const to = new Date(from.getTime() + span * DAY + (r() < 0.3 ? Math.floor(r() * DAY) : 0));
      const expected = oracle(from, to, days);

      const inc = isosOf(generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: days }), from, to));
      expect(inc).toEqual(expected);

      const tr = generateTransferOccurrences(transfer("semi_monthly", { daysOfMonth: days }), from, to);
      expect(tr.filter((e) => e.type === "transfer_out").map((e) => e.date.toISOString())).toEqual(expected);
      expect(tr.filter((e) => e.type === "transfer_in").map((e) => e.date.toISOString())).toEqual(expected);

      const one = days[0]!;
      const oneExp = oracle(from, to, [one]);
      expect(isosOf(generateBillOccurrences(bill(one), from, to))).toEqual(oneExp);
      expect(isosOf(generateIncomeOccurrences(income("monthly", { dayOfMonth: one }), from, to))).toEqual(oneExp);
      expect(
        isosOf(
          generateBillOccurrences(
            bill(one, { amountType: "accrued", expectedAmount: null, annualBudget: "1200.00" }),
            from,
            to
          )
        )
      ).toEqual(oneExp);
    }
  });

  it("every output is a strictly-ascending list of unique UTC-midnight dates inside [from,to)", () => {
    const r = rng(7);
    for (let n = 0; n < 500; n++) {
      const days = Array.from({ length: 4 }, () => 25 + Math.floor(r() * 7));
      const from = new Date(Date.UTC(2026, Math.floor(r() * 12), 1 + Math.floor(r() * 28)));
      const to = new Date(from.getTime() + 400 * DAY);
      const out = generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: days }), from, to);
      let prev = -Infinity;
      for (const e of out) {
        const t = e.date.getTime();
        expect(t).toBeGreaterThan(prev);
        expect(t % DAY).toBe(0);
        expect(t).toBeGreaterThanOrEqual(from.getTime());
        expect(t).toBeLessThan(to.getTime());
        prev = t;
      }
    }
  });

  it("differential vs the OLD skip behavior: identical when every day <= 28; superset otherwise", () => {
    // Reference copy of the previous implementation (pre-change), kept here as an oracle.
    function oldAllMonthDays(from: Date, to: Date, daysOfMonth: number[]): string[] {
      const res: Date[] = [];
      const s = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
      let year = s.getUTCFullYear();
      let month = s.getUTCMonth();
      while (year < to.getUTCFullYear() || (year === to.getUTCFullYear() && month <= to.getUTCMonth())) {
        for (const day of daysOfMonth) {
          const dim = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
          if (day > dim) continue;
          const x = new Date(Date.UTC(year, month, day));
          if (x >= from && x < to) res.push(x);
        }
        month++;
        if (month > 11) {
          month = 0;
          year++;
        }
      }
      return res.sort((a, b) => a.getTime() - b.getTime()).map((x) => x.toISOString());
    }
    const r = rng(99);
    for (let n = 0; n < 1500; n++) {
      const maxDay = r() < 0.5 ? 28 : 31;
      const days = Array.from({ length: 1 + Math.floor(r() * 4) }, () => 1 + Math.floor(r() * maxDay));
      const from = new Date(Date.UTC(2025 + Math.floor(r() * 5), Math.floor(r() * 12), 1 + Math.floor(r() * 28)));
      const to = new Date(from.getTime() + Math.floor(r() * 900) * DAY);
      const o = oldAllMonthDays(from, to, days);
      const nw = isosOf(generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: days }), from, to));
      if (maxDay === 28) {
        // may still contain dup days in the rule list; old kept dups, new dedupes
        expect(nw).toEqual([...new Set(o)]);
      } else {
        for (const x of new Set(o)) expect(nw).toContain(x);
      }
    }
  });
});

describe("allMonthDays clamp: leap / century years", () => {
  const feb = (day: number, y: number) =>
    isosOf(generateBillOccurrences(bill(day), d(`${y}-02-01`), d(`${y}-03-01`))).map((s) => s.slice(0, 10));
  it("2024/2028/2000/2400 are leap; 1900/2100/2027/2026 are not", () => {
    for (const y of [2024, 2028, 2000, 2400]) expect(feb(31, y)).toEqual([`${y}-02-29`]);
    for (const y of [1900, 2100, 2027, 2026, 2200]) expect(feb(31, y)).toEqual([`${y}-02-28`]);
    expect(feb(29, 2100)).toEqual(["2100-02-28"]);
    expect(feb(28, 2028)).toEqual(["2028-02-28"]);
  });
  it("[28,29,30,31] gives 28 only (non-leap) vs 28,29 (leap)", () => {
    const r = (y: number) =>
      generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: [28, 29, 30, 31] }), d(`${y}-02-01`), d(`${y}-03-01`)).map((e) => iso(e.date));
    expect(r(2027)).toEqual(["2027-02-28"]);
    expect(r(2028)).toEqual(["2028-02-28", "2028-02-29"]);
    expect(r(2100)).toEqual(["2100-02-28"]);
  });
  it("year-boundary window Dec 31 -> Jan 31 and clamped Jan 31 / Dec 31", () => {
    expect(isosOf(generateBillOccurrences(bill(31), d("2026-12-31"), d("2027-02-01"))).map((s) => s.slice(0, 10))).toEqual([
      "2026-12-31",
      "2027-01-31",
    ]);
  });
});

describe("allMonthDays clamp: window edges and unchanged branches", () => {
  it("[from,to): from == clamped date included, to == clamped date excluded, to == next day included", () => {
    expect(isosOf(generateBillOccurrences(bill(30), d("2027-02-28"), d("2027-03-01"))).map((s) => s.slice(0, 10))).toEqual(["2027-02-28"]);
    expect(generateBillOccurrences(bill(30), d("2027-02-01"), d("2027-02-28"))).toEqual([]);
    expect(isosOf(generateBillOccurrences(bill(30), d("2027-02-01"), d("2027-03-01"))).length).toBe(1);
    expect(generateBillOccurrences(bill(30), d("2027-03-01"), d("2027-03-30"))).toEqual([]);
    expect(generateBillOccurrences(bill(30), d("2027-02-28"), d("2027-02-28"))).toEqual([]);
  });

  it("day < 1 behavior unchanged (day 0 = previous month's last day, as before)", () => {
    const out = isosOf(generateBillOccurrences(bill(0), d("2027-03-01"), d("2027-05-01"))).map((s) => s.slice(0, 10));
    expect(out).toEqual(["2027-03-31", "2027-04-30"]);
    const neg = isosOf(generateBillOccurrences(bill(-1), d("2027-03-01"), d("2027-05-01"))).map((s) => s.slice(0, 10));
    expect(neg).toEqual(["2027-03-30", "2027-04-29"]);
  });

  it("weekly / biweekly cadences ignore the clamp (unchanged)", () => {
    const wk = generateBillOccurrences(bill(31, { frequency: "weekly", payDayOfWeek: 1 }), d("2027-02-01"), d("2027-03-01"));
    expect(wk.map((e) => iso(e.date))).toEqual(["2027-02-01", "2027-02-08", "2027-02-15", "2027-02-22"]);
    const bw = generateBillOccurrences(
      bill(31, { frequency: "biweekly", biweeklyAnchorDate: "2027-01-04" }),
      d("2027-02-01"),
      d("2027-03-01")
    );
    expect(bw.map((e) => iso(e.date))).toEqual(["2027-02-01", "2027-02-15"]);
  });

  it("annual / semiannual lump sums unchanged: day 31 in Feb pay month still Feb 28", () => {
    const ann = bill(31, { frequency: "annual", annualBudget: "1200.00", payMonth: 2 });
    expect(generateBillOccurrences(ann, d("2027-01-01"), d("2028-01-01")).map((e) => iso(e.date))).toEqual(["2027-02-28"]);
    const semi = bill(31, { frequency: "semiannual", annualBudget: "600.00", payMonth: 2 });
    expect(generateBillOccurrences(semi, d("2027-01-01"), d("2028-01-01")).map((e) => iso(e.date))).toEqual([
      "2027-02-28",
      "2027-08-31",
    ]);
  });

  it("accrued WITH draws ignores allMonthDays entirely (draw dates win)", () => {
    const acc = bill(31, { amountType: "accrued", expectedAmount: null, annualBudget: "1200.00" });
    const out = generateBillOccurrences(acc, d("2027-01-01"), d("2027-06-01"), [
      { estimatedDate: "2027-02-10", estimatedAmount: "100" },
    ]);
    expect(out.map((e) => iso(e.date))).toEqual(["2027-02-10"]);
  });

  it("monthly bill with null autopayDay defaults to day 1 (unchanged)", () => {
    expect(generateBillOccurrences(bill(null), d("2027-02-01"), d("2027-04-01")).map((e) => iso(e.date))).toEqual([
      "2027-02-01",
      "2027-03-01",
    ]);
  });

  it("duplicate listed days [30,30,31] in a 31-day month give 2 dates, in Nov 1", () => {
    const f = (a: string, b: string) =>
      generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: [30, 30, 31] }), d(a), d(b)).map((e) => iso(e.date));
    expect(f("2026-12-01", "2027-01-01")).toEqual(["2026-12-30", "2026-12-31"]);
    expect(f("2026-11-01", "2026-12-01")).toEqual(["2026-11-30"]);
  });

  it("empty and default day lists", () => {
    expect(generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: [] }), d("2027-01-01"), d("2027-06-01"))).toEqual([]);
    // default [15,30] when rules lack daysOfMonth: Feb -> 15 and (now clamped) 28
    expect(generateIncomeOccurrences(income("semi_monthly", {}), d("2027-02-01"), d("2027-03-01")).map((e) => iso(e.date))).toEqual([
      "2027-02-15",
      "2027-02-28",
    ]);
  });
});

describe("downstream consumers", () => {
  it("buildAccountForecast: Nov 30 paycheck lands on its own day, balance steps once", () => {
    const from = d("2026-10-08");
    const to = d("2027-01-06");
    const evs = generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: [15, 31] }), from, to);
    const fc = buildAccountForecast(new Decimal("1000"), evs, new Decimal("250"), from, to);
    const nov30 = fc.find((x) => iso(x.date) === "2026-11-30")!;
    const nov29 = fc.find((x) => iso(x.date) === "2026-11-29")!;
    expect(nov30.events.length).toBe(1);
    expect(nov30.events[0]!.amount.toString()).toBe("9000");
    expect(nov30.balanceAfter.minus(nov29.balanceAfter).toString()).toBe("9000");
    // total number of paychecks Oct 8 -> Jan 5: Oct15 Oct31 Nov15 Nov30 Dec15 Dec31 Jan? (Jan 15 > to) => 6
    expect(evs.length).toBe(6);
    expect(fc[fc.length - 1]!.balanceAfter.toString()).toBe(new Decimal(1000).plus(9000 * 6).toString());
  });

  it("forecast-rollup monthly: November bucket gets both paychecks; Feb 2027 gets both", () => {
    const from = d("2026-10-01");
    const to = d("2027-04-01");
    const evs = generateIncomeOccurrences(income("semi_monthly", { daysOfMonth: [15, 31] }), from, to);
    const fc = buildAccountForecast(new Decimal("0"), evs, null, from, to);
    const buckets = rollupForecast(fc, "monthly");
    // ending balance after each month = cumulative paychecks (2 per month)
    expect(buckets.map((b) => b.endingBalance.toString())).toEqual(
      [18000, 36000, 54000, 72000, 90000, 108000].map(String)
    );
    // The per-month totals the rollup implies must be exactly 2 paychecks even in short months.
    const perMonth = fc.reduce<Record<string, number>>((acc, day) => {
      const k = iso(day.date).slice(0, 7);
      acc[k] = (acc[k] ?? 0) + day.events.length;
      return acc;
    }, {});
    expect(perMonth).toEqual({
      "2026-10": 2,
      "2026-11": 2,
      "2026-12": 2,
      "2027-01": 2,
      "2027-02": 2,
      "2027-03": 2,
    });
  });

  it("live-like Toyota day-30 bill from 2027-01-10 for 90 days contains Feb 28 (and Mar 30)", () => {
    const from = d("2027-01-10");
    const to = new Date(from.getTime() + 90 * DAY);
    const out = generateBillOccurrences(bill(30), from, to).map((e) => iso(e.date));
    expect(out).toEqual(["2027-01-30", "2027-02-28", "2027-03-30"]);
  });

  it("checkBillReminders-style 65-day lookahead is never empty for a monthly day 29-31 bill (every start day over 4 years incl. leap)", () => {
    const start = d("2026-01-01").getTime();
    let maxGap = 0;
    for (let day = 29; day <= 31; day++) {
      for (let off = 0; off < 365 * 4 + 1; off++) {
        const today = new Date(start + off * DAY);
        const horizon = new Date(today.getTime() + 65 * DAY);
        const evs = generateBillOccurrences(bill(day), today, horizon);
        expect(evs.length).toBeGreaterThan(0);
        maxGap = Math.max(maxGap, Math.round((evs[0]!.date.getTime() - today.getTime()) / DAY));
      }
    }
    // next occurrence is never further than 31 days away now (was up to ~58 with the skip)
    expect(maxGap).toBeLessThanOrEqual(31);
  });

  it("transfers: [30,31] leg pairing stays 1:1 in every month of 2027", () => {
    const evs = generateTransferOccurrences(transfer("semi_monthly", { daysOfMonth: [30, 31] }), d("2027-01-01"), d("2028-01-01"));
    const outs = evs.filter((e) => e.type === "transfer_out").map((e) => e.date.toISOString());
    const ins = evs.filter((e) => e.type === "transfer_in").map((e) => e.date.toISOString());
    expect(outs).toEqual(ins);
    expect(new Set(outs).size).toBe(outs.length);
    // 7 months with 31 days -> 2 dates; 4 with 30 -> 1; Feb -> 1  => 14 + 4 + 1
    expect(outs.length).toBe(19);
  });
});
