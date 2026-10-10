// TESTER (carry-forward-seasonal-energy, step 2): property fuzz for generateBillOccurrencesBudgetDated with and without
// a seasonal plan. Pins: no plan = the previous behaviour (also against the plain generator), hand draws always win in
// their date range, the model fills only months AFTER the last draw's month so no month holds both, only monthly bills
// are re-amounted, labels and marks, replaceDraws, deterministic order.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { generateBillOccurrences, type AccrualDrawLike } from "@/lib/forecast";
import {
  generateBillOccurrencesBudgetDated,
  type BillDateBill,
  type BudgetScheduleIndex,
  type BudgetScheduleRow,
  type SeasonalScheduleEvent,
} from "@/lib/bill-dates";
import type { BillSeasonalPlan } from "@/lib/seasonal-energy";

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
const ri = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const per = (d: Date) => d.toISOString().slice(0, 7);
const key = (e: { date: Date; amount: Decimal; description: string; accountId: string }) => `${e.date.toISOString()}|${e.amount.toString()}|${e.description}|${e.accountId}`;

function plan(r: () => number, over: Partial<BillSeasonalPlan> = {}): BillSeasonalPlan {
  const monthly = Array.from({ length: 12 }, () => (r() < 0.2 ? null : new Decimal(ri(r, 1, 90000)).div(100)));
  return {
    kind: "electric",
    entityId: "E",
    lineKey: "E|T",
    lineLabel: "Electric",
    monthly,
    confidence: "low",
    basis: "basis text",
    shortBasis: "short basis",
    replaceDraws: false,
    ...over,
  };
}

function bill(r: () => number, over: Partial<BillDateBill> = {}): BillDateBill {
  const accrued = r() < 0.4;
  return {
    id: "b1",
    accountId: "A1",
    payee: "Electric (Eversource)",
    amountType: accrued ? "accrued" : r() < 0.5 ? "static" : "fluctuating",
    expectedAmount: r() < 0.2 ? null : ri(r, 10, 900),
    autopayDay: r() < 0.2 ? null : ri(r, 1, 31),
    annualBudget: r() < 0.3 ? null : ri(r, 100, 9000),
    frequency: "monthly",
    entityId: "E",
    budgetTagId: r() < 0.5 ? "T" : null,
    budgetEntityId: "E",
    ...over,
  };
}

function index(r: () => number): BudgetScheduleIndex {
  const idx: BudgetScheduleIndex = new Map();
  if (r() < 0.4) return idx;
  const rows = new Map<string, BudgetScheduleRow>();
  for (let i = 0; i < 30; i++) {
    const y = 2026 + Math.floor((9 + i) / 12);
    const mo = ((9 + i) % 12) + 1;
    const p = `${y}-${String(mo).padStart(2, "0")}`;
    if (r() < 0.3) continue;
    rows.set(p, { entityId: "E", tagId: "T", period: p, payDay: r() < 0.2 ? null : ri(r, 1, 31), frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null, carriedFrom: null });
  }
  idx.set("E|T", rows);
  return idx;
}

function drawsFor(r: () => number, from: Date): AccrualDrawLike[] {
  const n = ri(r, 0, 5);
  return Array.from({ length: n }, () => ({
    estimatedDate: new Date(from.getTime() + ri(r, -60, 500) * 86_400_000),
    estimatedAmount: r() < 0.1 ? 0 : ri(r, 100, 300000) / 100,
  }));
}

describe("no plan: byte-for-byte the previous behaviour", () => {
  it("2500 random bills / indexes / draws / windows: plan null, undefined and {} options equal each other, and equal the plain generator wherever the old code did", () => {
    const r = rng(31337);
    for (let w = 0; w < 2500; w++) {
      const from = D(`2026-${String(ri(r, 9, 12)).padStart(2, "0")}-${String(ri(r, 1, 28)).padStart(2, "0")}`);
      const to = new Date(from.getTime() + ri(r, 0, 520) * 86_400_000);
      const b = bill(r, r() < 0.2 ? { frequency: ["weekly", "biweekly", "annual", "quarterly"][ri(r, 0, 3)]!, payDayOfWeek: ri(r, 0, 6), payMonth: ri(r, 1, 12), biweeklyAnchorDate: D("2026-10-02") } : {});
      const idx = index(r);
      const draws = drawsFor(r, from);
      const a = generateBillOccurrencesBudgetDated(b, idx, from, to, draws);
      const bb = generateBillOccurrencesBudgetDated(b, idx, from, to, draws, null, {});
      const c = generateBillOccurrencesBudgetDated(b, idx, from, to, draws, undefined);
      expect(bb.map(key), `world ${w}`).toEqual(a.map(key));
      expect(c.map(key)).toEqual(a.map(key));
      expect(a.every((e) => !("estimate" in e) && !e.description.endsWith("(estimate)"))).toBe(true);
      if (idx.size === 0 || !b.budgetTagId) expect(a.map(key), `world ${w} (plain)`).toEqual(generateBillOccurrences(b, from, to, draws).map(key));
    }
  });
});

describe("with a plan: random monthly bills", () => {
  it("2500 worlds: draws win in range, the model starts the month after the last draw, no month holds both, amounts = plan, labels, order", () => {
    const r = rng(424242);
    let withDraws = 0;
    let modelTail = 0;
    let replaced = 0;
    for (let w = 0; w < 2500; w++) {
      const from = D(`2026-${String(ri(r, 9, 12)).padStart(2, "0")}-${String(ri(r, 1, 28)).padStart(2, "0")}`);
      const to = new Date(from.getTime() + ri(r, 1, 700) * 86_400_000);
      const b = bill(r);
      const idx = index(r);
      const draws = b.amountType === "accrued" ? drawsFor(r, from) : [];
      const p = plan(r, { replaceDraws: r() < 0.15 });
      const out = generateBillOccurrencesBudgetDated(b, idx, from, to, draws, p, { requireTailDay: r() < 0.3 }) as SeasonalScheduleEvent[];
      const model = out.filter((e) => e.estimate);
      const hand = out.filter((e) => !e.estimate);
      // sorted
      for (let i = 1; i < out.length; i++) expect(out[i]!.date.getTime() >= out[i - 1]!.date.getTime(), `world ${w} order`).toBe(true);
      // every model event: plan amount, label, mark
      for (const e of model) {
        const amt = p.monthly[e.date.getUTCMonth()];
        expect(amt, `world ${w} model event in a month the plan has no outflow for`).not.toBeNull();
        expect(e.amount.toString()).toBe(amt!.negated().toString());
        expect(e.description).toBe(`${b.payee} (estimate)`);
        expect(e.estimate).toMatchObject({ kind: "electric", basis: "short basis", confidence: "low" });
        expect(e.date >= from && e.date < to).toBe(true);
      }
      const useDraws = b.amountType === "accrued" && draws.length > 0 && !p.replaceDraws;
      if (useDraws) {
        withDraws++;
        // hand events are exactly the plain generator's draw events
        expect(hand.map(key), `world ${w} hand draws`).toEqual(generateBillOccurrences(b, from, to, draws).map(key));
        const lastDrawMs = Math.max(...draws.map((d) => new Date(d.estimatedDate).getTime()));
        const ld = new Date(lastDrawMs);
        const afterMonth = new Date(Date.UTC(ld.getUTCFullYear(), ld.getUTCMonth() + 1, 1));
        for (const e of model) expect(e.date >= afterMonth, `world ${w} model event ${e.date.toISOString()} not after the last draw's month`).toBe(true);
        // no month holds both
        const handMonths = new Set(hand.map((e) => per(e.date)));
        for (const e of model) expect(handMonths.has(per(e.date)), `world ${w} month holds both`).toBe(false);
        if (model.length > 0) modelTail++;
      } else {
        expect(hand.length, `world ${w}: no hand events without draws in force`).toBe(0);
        if (b.amountType === "accrued" && draws.length > 0 && p.replaceDraws) replaced++;
      }
    }
    expect(withDraws).toBeGreaterThan(300);
    expect(modelTail).toBeGreaterThan(100);
    expect(replaced).toBeGreaterThan(20);
  });

  it("weekly, biweekly, quarterly and annual STATIC bills are never re-amounted even when a plan matches", () => {
    const r = rng(5);
    for (const frequency of ["weekly", "biweekly", "quarterly", "annual", "semiannual"]) {
      const b = bill(r, { amountType: "static", frequency, expectedAmount: 100, autopayDay: 15, annualBudget: 1200, payDayOfWeek: 2, payMonth: 3, biweeklyAnchorDate: D("2026-10-02"), budgetTagId: null });
      const p = plan(r);
      const from = D("2026-10-10");
      const to = D("2027-10-10");
      const a = generateBillOccurrencesBudgetDated(b, new Map(), from, to, []);
      const withPlan = generateBillOccurrencesBudgetDated(b, new Map(), from, to, [], p);
      expect(withPlan.map(key), frequency).toEqual(a.map(key));
    }
  });

  it("an accrued bill with no draws gets one model event per month (plan months with an outflow), from the first window month", () => {
    const r = rng(11);
    const b = bill(r, { amountType: "accrued", autopayDay: 12, annualBudget: null, expectedAmount: null, budgetTagId: null });
    const p = plan(r, { monthly: Array.from({ length: 12 }, (_, i) => new Decimal(100 + i)) });
    const out = generateBillOccurrencesBudgetDated(b, new Map(), D("2026-10-01"), D("2027-10-01"), [], p) as SeasonalScheduleEvent[];
    expect(out).toHaveLength(12);
    expect(out.map((e) => e.amount.negated().toString())).toEqual(["109", "110", "111", "100", "101", "102", "103", "104", "105", "106", "107", "108"]);
    expect(new Set(out.map((e) => per(e.date))).size).toBe(12);
  });

  it("a draw dated on the last day of a month blocks that month only; the next month is a model month", () => {
    const r = rng(2);
    const b = bill(r, { amountType: "accrued", autopayDay: 5, budgetTagId: null });
    const p = plan(r, { monthly: new Array(12).fill(new Decimal(50)) });
    const draws: AccrualDrawLike[] = [{ estimatedDate: D("2026-12-31"), estimatedAmount: 2000 }];
    const out = generateBillOccurrencesBudgetDated(b, new Map(), D("2026-10-10"), D("2027-03-01"), draws, p) as SeasonalScheduleEvent[];
    expect(out.map((e) => [e.date.toISOString().slice(0, 10), Boolean(e.estimate)])).toEqual([
      ["2026-12-31", false],
      ["2027-01-05", true],
      ["2027-02-05", true],
    ]);
  });

  it("a ZERO-amount draw still marks the end of the hand range (documented edge): the model starts after its month", () => {
    const r = rng(3);
    const b = bill(r, { amountType: "accrued", autopayDay: 5, budgetTagId: null });
    const p = plan(r, { monthly: new Array(12).fill(new Decimal(50)) });
    const draws: AccrualDrawLike[] = [{ estimatedDate: D("2027-02-10"), estimatedAmount: 0 }];
    const out = generateBillOccurrencesBudgetDated(b, new Map(), D("2026-10-10"), D("2027-06-01"), draws, p) as SeasonalScheduleEvent[];
    // no hand events at all (the zero draw is skipped), and no model event before March 2027
    expect(out.every((e) => Boolean(e.estimate))).toBe(true);
    expect(out.every((e) => e.date >= D("2027-03-01"))).toBe(true);
  });
});

describe("edge semantics pinned after mutation testing", () => {
  const r = rng(77);
  it("requireTailDay applies to ACCRUED model tails only: a static bill with no pay day still gets its (day-1) estimate events", () => {
    const b = bill(r, { amountType: "static", autopayDay: null, expectedAmount: 100, budgetTagId: null });
    const p = plan(r, { monthly: new Array(12).fill(new Decimal(60)) });
    const out = generateBillOccurrencesBudgetDated(b, new Map(), D("2026-10-10"), D("2027-01-01"), [], p, { requireTailDay: true });
    expect(out.map((e) => e.date.toISOString().slice(0, 10))).toEqual(["2026-11-01", "2026-12-01"]);
  });
  it("a static bill handed a draws array never produces hand-draw events (draws are an accrued-bill concept)", () => {
    const b = bill(r, { amountType: "static", autopayDay: 15, expectedAmount: 100, budgetTagId: null });
    const p = plan(r, { monthly: new Array(12).fill(new Decimal(60)) });
    const draws: AccrualDrawLike[] = [{ estimatedDate: D("2026-11-03"), estimatedAmount: 999 }];
    const out = generateBillOccurrencesBudgetDated(b, new Map(), D("2026-10-10"), D("2027-01-01"), draws, p) as SeasonalScheduleEvent[];
    expect(out.every((e) => Boolean(e.estimate))).toBe(true);
    expect(out.map((e) => e.amount.toString())).toEqual(["-60", "-60", "-60"]);
  });
  it("a plan month holding a zero (hand-built) produces no event, only positive outflows do", () => {
    const b = bill(r, { amountType: "static", autopayDay: 15, expectedAmount: 100, budgetTagId: null });
    const monthly = new Array(12).fill(null) as Array<Decimal | null>;
    monthly[10] = new Decimal(0); // November
    monthly[11] = new Decimal(40); // December
    const out = generateBillOccurrencesBudgetDated(b, new Map(), D("2026-10-10"), D("2027-01-01"), [], plan(r, { monthly }));
    expect(out.map((e) => [e.date.toISOString().slice(0, 10), e.amount.toString()])).toEqual([["2026-12-15", "-40"]]);
  });
});
