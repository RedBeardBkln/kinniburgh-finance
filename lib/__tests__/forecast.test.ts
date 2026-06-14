import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  generateTransferOccurrences,
  generateIncomeOccurrences,
  buildAccountForecast,
  findBreachDays,
} from "@/lib/forecast";

// ── Helpers ───────────────────────────────────────────────────────────────────

function d(iso: string) {
  return new Date(iso + "T00:00:00Z");
}
function dec(n: string | number) {
  return new Decimal(String(n));
}

const ACCT_A = "acct-a";
const ACCT_B = "acct-b";

function makeTransfer(
  cadence: string,
  dayRules: unknown,
  amount = "256.00"
) {
  return {
    id: "t1",
    fromAccountId: ACCT_A,
    toAccountId: ACCT_B,
    amount: dec(amount),
    cadence,
    dayRules,
    purpose: "Test transfer",
    active: true,
  };
}

function makeIncome(
  cadence: string,
  dayRules: unknown,
  amount = "2000.00"
) {
  return {
    id: "i1",
    accountId: ACCT_A,
    description: "Test income",
    cadence,
    dayRules,
    amount: dec(amount),
    active: true,
  };
}

// ── generateTransferOccurrences ───────────────────────────────────────────────

describe("generateTransferOccurrences", () => {
  it("weekly Monday: 4 events in 28 days (Mon–Sun window)", () => {
    // 2026-06-01 is a Monday
    const from = d("2026-06-01");
    const to = d("2026-06-29"); // 28 days
    const transfer = makeTransfer("weekly", { dayOfWeek: 1 }); // Monday
    const events = generateTransferOccurrences(transfer, from, to);
    // 4 Mondays: Jun 1, 8, 15, 22 → 4 out + 4 in = 8 events
    expect(events).toHaveLength(8);
    const outs = events.filter((e) => e.type === "transfer_out");
    const ins = events.filter((e) => e.type === "transfer_in");
    expect(outs).toHaveLength(4);
    expect(ins).toHaveLength(4);
    // All out-legs are on Mondays (UTC dayOfWeek = 1)
    for (const ev of outs) {
      expect(ev.date.getUTCDay()).toBe(1);
    }
  });

  it("weekly: excluded end date", () => {
    // to is exclusive — the Monday ON to should not appear
    const from = d("2026-06-01");
    const to = d("2026-06-08"); // 7 days; only Jun 1
    const events = generateTransferOccurrences(
      makeTransfer("weekly", { dayOfWeek: 1 }),
      from,
      to
    );
    expect(events.filter((e) => e.type === "transfer_out")).toHaveLength(1);
    expect(events[0]!.date.toISOString().slice(0, 10)).toBe("2026-06-01");
  });

  it("semi_monthly 1st+15th: 4 occurrences in 60 days", () => {
    const from = d("2026-06-01");
    const to = d("2026-07-31");
    const events = generateTransferOccurrences(
      makeTransfer("semi_monthly", { daysOfMonth: [1, 15] }),
      from,
      to
    );
    const outs = events.filter((e) => e.type === "transfer_out");
    // Jun 1, Jun 15, Jul 1, Jul 15
    expect(outs).toHaveLength(4);
    const dates = outs.map((e) => e.date.toISOString().slice(0, 10));
    expect(dates).toContain("2026-06-01");
    expect(dates).toContain("2026-06-15");
    expect(dates).toContain("2026-07-01");
    expect(dates).toContain("2026-07-15");
  });

  it("inactive transfer produces no events", () => {
    const t = { ...makeTransfer("weekly", { dayOfWeek: 1 }), active: false };
    const events = generateTransferOccurrences(t, d("2026-06-01"), d("2026-06-30"));
    expect(events).toHaveLength(0);
  });

  it("amounts: out-leg is negative, in-leg is positive", () => {
    const events = generateTransferOccurrences(
      makeTransfer("weekly", { dayOfWeek: 1 }, "400.00"),
      d("2026-06-01"),
      d("2026-06-09")
    );
    const out = events.find((e) => e.type === "transfer_out");
    const inEv = events.find((e) => e.type === "transfer_in");
    expect(out!.amount.equals(dec("-400.00"))).toBe(true);
    expect(inEv!.amount.equals(dec("400.00"))).toBe(true);
  });
});

// ── generateIncomeOccurrences ─────────────────────────────────────────────────

describe("generateIncomeOccurrences", () => {
  it("semi_monthly 15th+30th: 4 occurrences in 2 months", () => {
    const from = d("2026-06-01");
    const to = d("2026-08-01");
    const events = generateIncomeOccurrences(
      makeIncome("semi_monthly", { daysOfMonth: [15, 30] }),
      from,
      to
    );
    expect(events).toHaveLength(4);
    const dates = events.map((e) => e.date.toISOString().slice(0, 10));
    expect(dates).toContain("2026-06-15");
    expect(dates).toContain("2026-06-30");
    expect(dates).toContain("2026-07-15");
    expect(dates).toContain("2026-07-30");
  });

  it("biweekly: 6–7 occurrences in 90 days", () => {
    const anchor = d("2026-01-03"); // Saturday
    const from = d("2026-06-01");
    const to = d("2026-08-30"); // ~90 days
    const events = generateIncomeOccurrences(
      makeIncome("biweekly", { intervalDays: 14, anchorDate: "2026-01-03" }),
      from,
      to
    );
    // 90 days / 14 = ~6.4 → expect 6 or 7
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(events.length).toBeLessThanOrEqual(7);
    // Consecutive events should be exactly 14 days apart
    for (let i = 1; i < events.length; i++) {
      const gap = events[i]!.date.getTime() - events[i - 1]!.date.getTime();
      expect(gap).toBe(14 * 86400000);
    }
  });

  it("biweekly: all events land on correct days relative to anchor", () => {
    // Anchor 2026-01-03. Verify every date is anchor + N*14 days.
    const anchor = d("2026-01-03");
    const from = d("2026-06-01");
    const to = d("2026-07-01");
    const events = generateIncomeOccurrences(
      makeIncome("biweekly", { intervalDays: 14, anchorDate: "2026-01-03" }),
      from,
      to
    );
    for (const ev of events) {
      const diff = ev.date.getTime() - anchor.getTime();
      expect(diff % (14 * 86400000)).toBe(0);
    }
  });

  it("inactive income source produces no events", () => {
    const s = { ...makeIncome("semi_monthly", { daysOfMonth: [15, 30] }), active: false };
    const events = generateIncomeOccurrences(s, d("2026-06-01"), d("2026-08-01"));
    expect(events).toHaveLength(0);
  });
});

// ── buildAccountForecast ─────────────────────────────────────────────────────

describe("buildAccountForecast", () => {
  it("returns one DayForecast per day in [from, to)", () => {
    const from = d("2026-06-01");
    const to = d("2026-06-08"); // 7 days
    const result = buildAccountForecast(dec("1000"), [], null, from, to);
    expect(result).toHaveLength(7);
    expect(result[0]!.date.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(result[6]!.date.toISOString().slice(0, 10)).toBe("2026-06-07");
  });

  it("balance accumulates correctly over days", () => {
    const from = d("2026-06-01");
    const to = d("2026-06-04"); // 3 days
    const events = [
      { date: d("2026-06-01"), amount: dec("-100"), description: "bill", accountId: ACCT_A, type: "bill" as const },
      { date: d("2026-06-02"), amount: dec("500"), description: "income", accountId: ACCT_A, type: "income" as const },
      { date: d("2026-06-03"), amount: dec("-50"), description: "xfer", accountId: ACCT_A, type: "transfer_out" as const },
    ];
    const result = buildAccountForecast(dec("1000"), events, null, from, to);
    expect(result[0]!.balanceAfter.equals(dec("900"))).toBe(true);
    expect(result[1]!.balanceAfter.equals(dec("1400"))).toBe(true);
    expect(result[2]!.balanceAfter.equals(dec("1350"))).toBe(true);
  });

  it("breach detection: marks days below TD minimum ($250)", () => {
    // Start $800, weekly $300 outflows on Jun 1 and Jun 8
    // After Jun 1: $500 (ok), after Jun 8: $200 (breach)
    const events = [
      { date: d("2026-06-01"), amount: dec("-300"), description: "transfer", accountId: ACCT_A, type: "transfer_out" as const },
      { date: d("2026-06-08"), amount: dec("-300"), description: "transfer", accountId: ACCT_A, type: "transfer_out" as const },
    ];
    const result = buildAccountForecast(dec("800"), events, dec("250"), d("2026-06-01"), d("2026-06-10"));
    expect(result[0]!.isBreachDay).toBe(false); // $500
    expect(result[6]!.isBreachDay).toBe(false); // still $500 before Jun 8
    expect(result[7]!.isBreachDay).toBe(true);  // $200 < $250
  });

  it("no breach when minimumBalance is null (JCSB)", () => {
    const events = [
      { date: d("2026-06-01"), amount: dec("-9999"), description: "drain", accountId: ACCT_A, type: "bill" as const },
    ];
    const result = buildAccountForecast(dec("100"), events, null, d("2026-06-01"), d("2026-06-03"));
    expect(result[0]!.isBreachDay).toBe(false); // no minimum rule
    expect(result[0]!.balanceAfter.equals(dec("-9899"))).toBe(true);
  });

  it("exactly at minimum ($250) is NOT a breach", () => {
    const events = [
      { date: d("2026-06-01"), amount: dec("-256"), description: "transfer", accountId: ACCT_A, type: "transfer_out" as const },
    ];
    // 506 - 256 = 250 exactly → not a breach
    const result = buildAccountForecast(dec("506"), events, dec("250"), d("2026-06-01"), d("2026-06-02"));
    expect(result[0]!.isBreachDay).toBe(false);
    expect(result[0]!.balanceAfter.equals(dec("250"))).toBe(true);
  });
});

// ── findBreachDays ───────────────────────────────────────────────────────────

describe("findBreachDays", () => {
  it("returns only breach days", () => {
    const from = d("2026-06-01");
    const to = d("2026-06-06");
    // Start $800; drain $300 on Jun 1 → $500 (ok), drain $300 on Jun 3 → $200 (breach)
    const events = [
      { date: from, amount: dec("-300"), description: "t", accountId: ACCT_A, type: "transfer_out" as const },
      { date: d("2026-06-03"), amount: dec("-300"), description: "t", accountId: ACCT_A, type: "transfer_out" as const },
    ];
    const forecast = buildAccountForecast(dec("800"), events, dec("250"), from, to);
    const breaches = findBreachDays(forecast);
    // Jun 3, 4, 5 are breaches ($200 stays)
    expect(breaches).toHaveLength(3);
    expect(breaches[0]!.date.toISOString().slice(0, 10)).toBe("2026-06-03");
  });

  it("returns empty array when no breaches", () => {
    const from = d("2026-06-01");
    const to = d("2026-06-08");
    const forecast = buildAccountForecast(dec("5000"), [], dec("250"), from, to);
    expect(findBreachDays(forecast)).toHaveLength(0);
  });
});

// ── Full x2566 weekly schedule ───────────────────────────────────────────────

describe("x2566 weekly schedule (integration)", () => {
  it("net weekly outflow from x2566 matches expected seeded values", () => {
    // Seeded: $256/wk to x2540, $400/wk to x2558, $250/wk Lexus (bill from x2566)
    // Net weekly outflow = $256 + $400 + $250 = $906/wk
    // Semi-monthly $2350 adds $4700/mo inflow to x2558 (not x2566)
    // This test checks x2566 outflows over one week (Monday-only window)
    const from = d("2026-06-01"); // Monday
    const to = d("2026-06-08");   // next Monday excluded

    const transfers = [
      makeTransfer("weekly", { dayOfWeek: 1 }, "256.00"),   // x2566 → x2540
      { ...makeTransfer("weekly", { dayOfWeek: 1 }, "400.00"), fromAccountId: ACCT_A, toAccountId: "acct-c" },  // x2566 → x2558
    ];

    let events = transfers.flatMap((t) =>
      generateTransferOccurrences(t, from, to)
    );

    // Add Lexus bill as an extra outflow from ACCT_A
    events = [
      ...events,
      { date: d("2026-06-01"), amount: dec("-250"), description: "Lexus", accountId: ACCT_A, type: "bill" as const },
    ];

    const x2566Events = events.filter((e) => e.accountId === ACCT_A);
    const netOutflow = x2566Events.reduce(
      (sum, e) => sum.plus(e.amount),
      dec("0")
    );

    // $256 out + $400 out + $250 out = -$906 from x2566 this week
    expect(netOutflow.equals(dec("-906"))).toBe(true);
  });
});
