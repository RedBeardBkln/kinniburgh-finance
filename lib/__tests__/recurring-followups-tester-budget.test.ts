import { describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { buildBudgetFacts, budgetNotice, selectedTagNotice, thisMonthlyCents } from "@/lib/recurring-budget-hint";

// Tester: the pre-confirm Budgets notice against an independent re-implementation of what /budgets (app/budgets/page.tsx)
// computes for a budget line that has linked recurring expenses:
//   effective = (sum of linked monthlyEquivalentCents + additionalAmountCents) / 100, replacing the stored `budgeted`.
// (monthly equivalents re-derived here with Decimal ROUND_HALF_UP, not by importing the app's helper.)

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const FREQ = ["monthly", "weekly", "biweekly", "quarterly", "annually"] as const;
function monthlyOracle(cents: number, f: string): number {
  const c = new Decimal(cents);
  const m = f === "weekly" ? c.times(52).div(12) : f === "biweekly" ? c.times(26).div(12) : f === "quarterly" ? c.div(3) : f === "annually" ? c.div(12) : c;
  return m.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}
const fmt = (cents: number) => `~$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2 }).format(cents / 100)}`;

describe("tester: notice arithmetic == /budgets override logic", () => {
  it("spot values from the brief: weekly 1000 -> 4333, biweekly 1000 -> 2167, quarterly 3000 -> 1000, annual 12000 -> 1000", () => {
    expect(thisMonthlyCents(1000, "weekly")).toBe(4333);
    expect(thisMonthlyCents(1000, "biweekly")).toBe(2167);
    expect(thisMonthlyCents(3000, "quarterly")).toBe(1000);
    expect(thisMonthlyCents(12000, "annually")).toBe(1000);
    expect(thisMonthlyCents(999, "annually")).toBe(83); // 83.25 rounds down
    expect(thisMonthlyCents(1001, "quarterly")).toBe(334); // 333.67 rounds up
    expect(thisMonthlyCents(1, "weekly")).toBe(4); // 4.33
  });

  it("fuzz: the notice total equals the Budgets figure after the add, for every frequency mix", () => {
    const r = rng(2026_1010);
    const E = "E1";
    const T = "T1";
    let withBudget = 0;
    for (let round = 0; round < 3000; round++) {
      const linked = Array.from({ length: int(r, 0, 4) }, () => ({ amountCents: int(r, 1, 250000), frequency: pick(r, FREQ) }));
      const addl = pick(r, [0, 0, 1500, 1, 99999]);
      const budgeted = pick<number | null>(r, [null, 0, 6000, 12345, 100000]);
      const mine = { amountCents: int(r, 1, 250000), frequency: pick(r, FREQ) };

      // what /budgets will compute once the new expense exists (page logic, Decimal arithmetic like the page)
      const all = [...linked, mine];
      const sumMonthly = all.reduce((s, e) => s + monthlyOracle(e.amountCents, e.frequency), 0);
      const budgetsAfter = new Decimal((sumMonthly + addl) / 100);

      const facts = buildBudgetFacts({
        budgets: [{ entityId: E, tagId: T, budgetedCents: budgeted, additionalCents: addl }],
        bills: [],
        recurring: linked.map((l) => ({ entityId: E, tagId: T, ...l })),
      });
      const note = selectedTagNotice(facts, E, T, mine.amountCents, mine.frequency);
      expect(note).not.toBeNull();
      withBudget += 1;
      const total = /= (~\$[\d,]+\.\d{2})\)/.exec(note as string)?.[1];
      expect(total).toBe(fmt(Math.round(budgetsAfter.times(100).toNumber())));
      // parts shown
      expect(note).toContain(`this one ${fmt(monthlyOracle(mine.amountCents, mine.frequency))}`);
      expect(note).toContain(`your additional amount ${fmt(addl)}`);
      if (linked.length > 0) expect(note).toContain(`+ ${linked.length} already linked ${fmt(linked.reduce((s, e) => s + monthlyOracle(e.amountCents, e.frequency), 0))}`);
      else expect(note).not.toContain("already linked");
      expect(note).toContain(budgeted === null ? "no amount of its own" : `${fmt(budgeted)}/month budget`);
      // observational wording only
      expect(note).not.toMatch(/\b(should|must|recommend|advise|you need)\b/i);
    }
    expect(withBudget).toBe(3000);
  });

  it("a different entity's linked expenses or budget never leak into the notice", () => {
    const facts = buildBudgetFacts({
      budgets: [
        { entityId: "E1", tagId: "T", budgetedCents: 6000, additionalCents: 0 },
        { entityId: "E2", tagId: "T", budgetedCents: 9999, additionalCents: 500 },
      ],
      bills: [],
      recurring: [{ entityId: "E2", tagId: "T", amountCents: 70000, frequency: "monthly" }],
    });
    expect(selectedTagNotice(facts, "E1", "T", 2870, "monthly")).toContain("= ~$28.70)");
    expect(selectedTagNotice(facts, "E2", "T", 2870, "monthly")).toContain("= ~$733.70)"); // 28.70 + 700 + 5.00
  });

  it("no budget row and no bill = no notice; 'No tag' = no notice; failed read = generic only for a chosen tag", () => {
    const facts = buildBudgetFacts({ budgets: [], bills: [], recurring: [{ entityId: "E", tagId: "T", amountCents: 100, frequency: "monthly" }] });
    expect(facts).toEqual({});
    expect(selectedTagNotice(facts, "E", "T", 500, "monthly")).toBeNull();
    expect(selectedTagNotice(null, "E", "", 500, "monthly")).toBeNull();
    expect(selectedTagNotice(null, "E", "T", 500, "monthly")).toBe("Linking can change the Budgets figure for that category.");
    expect(budgetNotice(undefined, 100)).toBeNull();
  });
});

describe("tester: loader reads and period", () => {
  const mocks = vi.hoisted(() => ({ budget: vi.fn(), bill: vi.fn(), rec: vi.fn() }));
  vi.mock("@/lib/db", () => ({ db: { budget: { findMany: mocks.budget }, scheduledBill: { findMany: mocks.bill }, recurringExpense: { findMany: mocks.rec }, appSetting: { findUnique: async () => null } } }));

  it("period is the UTC month of now (same as /budgets), at the New York evening edge too", async () => {
    const { currentBudgetPeriod, loadBudgetHints } = await import("@/lib/recurring-budget-hint-build");
    // 2026-11-01T02:00Z is still Oct 31 in New York, but /budgets uses getUTCMonth() => "2026-11"
    expect(currentBudgetPeriod(new Date("2026-11-01T02:00:00Z"))).toBe("2026-11");
    expect(currentBudgetPeriod(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    // carry-forward-seasonal-energy: the loader reads every period of the entity and the resolver keeps the month, so
    // the month is proved through the output: only the 2026-11 row of a line in the latest month is returned.
    mocks.budget.mockResolvedValue([
      { id: "b-nov", entityId: "E", tagId: "A", period: "2026-11", budgeted: new Decimal("10.00"), additionalAmountCents: new Decimal("0") },
      { id: "b-oct", entityId: "E", tagId: "B", period: "2026-10", budgeted: new Decimal("99.00"), additionalAmountCents: new Decimal("0") },
    ]);
    mocks.bill.mockResolvedValue([]);
    mocks.rec.mockResolvedValue([]);
    const facts = await loadBudgetHints({ entityId: null, now: new Date("2026-11-01T02:00:00Z") });
    expect(Object.keys(facts ?? {})).toEqual(["E|A"]); // B ended (not in the latest month) and is not the current period
  });

  it("explicit selects, cents conversion of a Decimal budget, weekly 10.00 -> 4333, fail-soft null with the error class only", async () => {
    const { loadBudgetHints } = await import("@/lib/recurring-budget-hint-build");
    mocks.budget.mockResolvedValue([{ id: "b1", entityId: "E", tagId: "T", period: "2026-10", budgeted: new Decimal("60.00"), additionalAmountCents: new Decimal("1500.00") }]);
    mocks.bill.mockResolvedValue([]);
    mocks.rec.mockResolvedValue([{ entityId: "E", tagId: "T", amountCents: 1000, frequency: "weekly" }]);
    const facts = await loadBudgetHints({ entityId: "E", now: new Date("2026-10-09T12:00:00Z") });
    expect(facts?.["E|T"]).toEqual({ hasBudget: true, budgetedCents: 6000, additionalCents: 1500, linkedMonthlyCents: 4333, linkedCount: 1, hasBill: false });
    for (const m of [mocks.budget, mocks.bill, mocks.rec]) {
      const arg = m.mock.calls.at(-1)?.[0];
      expect(arg.select).toBeTruthy();
      expect(arg.include).toBeUndefined();
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.rec.mockRejectedValue(Object.assign(new Error("secret connection string postgres://u:p@h"), { name: "PrismaClientKnownRequestError" }));
    expect(await loadBudgetHints({ entityId: "E", now: new Date() })).toBeNull();
    expect(JSON.stringify(spy.mock.calls)).toBe(JSON.stringify([["Budget hints unavailable", "PrismaClientKnownRequestError"]]));
    spy.mockRestore();
  });
});
