// carry-forward-seasonal-energy, step 2: how a seasonal plan reaches the cash-flow generator, the Upcoming ledger, the
// assistant's forecast and budget tools, and the Category Spend Pace rule. A bill with NO plan (a gated model) is
// byte-for-byte what it was before this feature. Hand-entered accrual draws always win inside their range.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  buildBudgetScheduleIndex,
  generateBillOccurrencesBudgetDated,
  type BillDateBill,
  type BudgetScheduleRow,
  type SeasonalScheduleEvent,
} from "@/lib/bill-dates";
import { generateBillOccurrences } from "@/lib/forecast";
import { buildUpcomingLedger, type UpcomingBillRow } from "@/lib/upcoming-ledger";
import type { BillSeasonalPlan } from "@/lib/seasonal-energy";
import { buildForecastView } from "@/lib/advisor/tools/get-forecast";
import type { ForecastInputs } from "@/lib/advisor/queries/forecast";
import { shapeBudgets } from "@/lib/advisor/tools/get-budget-status";

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dec = (s: string | number) => new Decimal(String(s));

const MONTHLY = [300, 280, 250, 150, 120, 110, 110, 105, 130, 170, 230, 290];
function plan(over: Partial<BillSeasonalPlan> = {}, kind: "electric" | "oil" = "electric"): BillSeasonalPlan {
  return {
    kind,
    entityId: "ent-p",
    lineKey: kind === "electric" ? "ent-p|t-elec" : "ent-p|t-oil",
    lineLabel: kind === "electric" ? "Electric (Eversource)" : "Oil",
    monthly: kind === "electric" ? MONTHLY.map((n) => dec(n)) : Array(12).fill(dec(600)),
    confidence: "low",
    basis: "long basis text",
    shortBasis: "Seasonal estimate from 8 Eversource payments in 8 months (low confidence)",
    replaceDraws: false,
    ...over,
  };
}

const electric: BillDateBill = {
  id: "b-elec",
  accountId: "acct-main",
  entityId: "ent-p",
  payee: "Electric (Eversource)",
  amountType: "static",
  expectedAmount: "172",
  autopayDay: 20,
  annualBudget: null,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  budgetTagId: "t-elec",
  budgetEntityId: "ent-p",
};
const oil: BillDateBill = {
  ...electric,
  id: "b-oil",
  payee: "McCarthy Heating & Oil",
  amountType: "accrued",
  expectedAmount: null,
  autopayDay: null,
  annualBudget: "4000",
  budgetTagId: "t-oil",
};
const draw = (date: string, amount: string) => ({ estimatedDate: D(date), estimatedAmount: dec(amount) });
const amounts = (evs: Array<{ amount: Decimal }>) => evs.map((e) => e.amount.toFixed(2));
const dates = (evs: Array<{ date: Date }>) => evs.map((e) => iso(e.date));

const budgetRow = (period: string, payDay: number | null, over: Partial<BudgetScheduleRow> = {}): BudgetScheduleRow => ({
  entityId: "ent-p",
  tagId: "t-elec",
  period,
  payDay,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  annualAmountDue: null,
  ...over,
});

describe("generateBillOccurrencesBudgetDated with a plan: a static monthly bill (Electric)", () => {
  it("no plan: exactly the previous behaviour (the flat amount)", () => {
    const a = generateBillOccurrencesBudgetDated(electric, new Map(), D("2026-10-10"), D("2027-01-10"));
    const b = generateBillOccurrencesBudgetDated(electric, new Map(), D("2026-10-10"), D("2027-01-10"), [], null);
    expect(amounts(a)).toEqual(["-172.00", "-172.00", "-172.00"]);
    expect(b).toEqual(a);
  });

  it("with a plan: the plan's amount for each calendar month, same dates, labelled and marked as an estimate", () => {
    const evs = generateBillOccurrencesBudgetDated(electric, new Map(), D("2026-10-10"), D("2027-01-10"), [], plan());
    expect(dates(evs)).toEqual(["2026-10-20", "2026-11-20", "2026-12-20"]);
    expect(amounts(evs)).toEqual(["-170.00", "-230.00", "-290.00"]);
    for (const e of evs as SeasonalScheduleEvent[]) {
      expect(e.description).toBe("Electric (Eversource) (estimate)");
      expect(e.estimate).toMatchObject({ kind: "electric", confidence: "low" });
      expect(e.type).toBe("bill");
      expect(e.accountId).toBe("acct-main");
    }
  });

  it("the date still comes from the Budget row (carried or own), only the amount is the plan's", () => {
    const index = buildBudgetScheduleIndex([budgetRow("2026-11", 17), budgetRow("2026-12", 17, { carriedFrom: "2026-11" })]);
    const evs = generateBillOccurrencesBudgetDated(electric, index, D("2026-11-01"), D("2027-01-01"), [], plan());
    expect(dates(evs)).toEqual(["2026-11-17", "2026-12-17"]);
    expect(amounts(evs)).toEqual(["-230.00", "-290.00"]);
  });

  it("a month with no outflow estimate (a net credit) produces no event; the others still do", () => {
    const monthly = MONTHLY.map((n) => dec(n)) as Array<Decimal | null>;
    monthly[10] = null; // November
    const evs = generateBillOccurrencesBudgetDated(electric, new Map(), D("2026-10-10"), D("2027-01-10"), [], plan({ monthly }));
    expect(dates(evs)).toEqual(["2026-10-20", "2026-12-20"]);
  });

  it("a bill with no expected amount still gets the plan's dated events", () => {
    const evs = generateBillOccurrencesBudgetDated({ ...electric, expectedAmount: null }, new Map(), D("2026-10-10"), D("2026-12-01"), [], plan());
    expect(amounts(evs)).toEqual(["-170.00", "-230.00"]);
  });

  it("weekly, biweekly and annual bills are never re-amounted", () => {
    for (const bill of [
      { ...electric, frequency: "weekly", payDayOfWeek: 1 },
      { ...electric, frequency: "biweekly", biweeklyAnchorDate: D("2026-10-01") },
      { ...electric, frequency: "annual", payMonth: 11, annualBudget: "900" },
    ]) {
      const withPlan = generateBillOccurrencesBudgetDated(bill, new Map(), D("2026-10-10"), D("2027-01-10"), [], plan());
      const without = generateBillOccurrencesBudgetDated(bill, new Map(), D("2026-10-10"), D("2027-01-10"));
      expect(withPlan).toEqual(without);
    }
  });

  it("an empty window is empty", () => {
    expect(generateBillOccurrencesBudgetDated(electric, new Map(), D("2026-10-10"), D("2026-10-10"), [], plan())).toEqual([]);
  });
});

describe("accrued bill (Oil) with hand-entered draws", () => {
  const draws = [draw("2026-10-02", "2000"), draw("2026-12-16", "2000"), draw("2027-02-08", "2000"), draw("2027-03-25", "2000")];
  const oilPlan = () => plan({}, "oil");

  it("no plan: only the draws, nothing after the last one (the previous behaviour, and the bug the plan noted)", () => {
    const evs = generateBillOccurrencesBudgetDated(oil, new Map(), D("2026-10-10"), D("2027-09-01"), draws);
    expect(dates(evs)).toEqual(["2026-12-16", "2027-02-08", "2027-03-25"]);
    expect(generateBillOccurrencesBudgetDated(oil, new Map(), D("2026-10-10"), D("2027-09-01"), draws, null)).toEqual(evs);
    expect(generateBillOccurrences(oil, D("2026-10-10"), D("2027-09-01"), draws)).toEqual(evs);
  });

  it("with a plan: the draws win inside their range, the model fills from the month AFTER the last draw, and no month holds both", () => {
    const evs = generateBillOccurrencesBudgetDated(oil, new Map(), D("2026-10-10"), D("2027-09-01"), draws, oilPlan());
    const draws3 = evs.filter((e) => !(e as SeasonalScheduleEvent).estimate);
    const model = evs.filter((e) => (e as SeasonalScheduleEvent).estimate);
    expect(dates(draws3)).toEqual(["2026-12-16", "2027-02-08", "2027-03-25"]);
    expect(amounts(draws3)).toEqual(["-2000.00", "-2000.00", "-2000.00"]);
    // April 2027 is the first month after the last draw (March 25); the engine's own fallback day is the 1st
    expect(dates(model)).toEqual(["2027-04-01", "2027-05-01", "2027-06-01", "2027-07-01", "2027-08-01"]);
    expect(amounts(model)).toEqual(Array(5).fill("-600.00"));
    expect(model[0]!.description).toBe("McCarthy Heating & Oil (estimate)");
    expect(draws3[0]!.description).toBe("McCarthy Heating & Oil");
    const months = evs.map((e) => iso(e.date).slice(0, 7));
    expect(new Set(months.filter((m) => m === "2027-03")).size).toBe(1);
    expect(months.filter((m) => m === "2027-03")).toHaveLength(1); // March: the draw only, no model event
  });

  it("a draw dated in the past still counts as the last draw when it is the latest", () => {
    const evs = generateBillOccurrencesBudgetDated(oil, new Map(), D("2026-10-10"), D("2027-01-10"), [draw("2026-10-02", "2000")], oilPlan());
    // the only draw (Oct 2) is before the window: nothing in October (same month), the model starts in November
    expect(dates(evs)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"].filter((d) => d < "2027-01-10"));
    expect(evs.every((e) => (e as SeasonalScheduleEvent).estimate)).toBe(true);
  });

  it("the tail uses the Budget day when there is one", () => {
    const index = buildBudgetScheduleIndex([budgetRow("2027-04", 12, { tagId: "t-oil" }), budgetRow("2027-05", 12, { tagId: "t-oil", carriedFrom: "2027-04" })]);
    const evs = generateBillOccurrencesBudgetDated(oil, index, D("2027-04-01"), D("2027-06-01"), draws, oilPlan());
    expect(dates(evs)).toEqual(["2027-04-12", "2027-05-12"]);
  });

  it("requireTailDay (the Upcoming ledger): a month with no pay day gets no tail event, a dated month does", () => {
    const none = generateBillOccurrencesBudgetDated(oil, new Map(), D("2027-04-01"), D("2027-07-01"), draws, oilPlan(), { requireTailDay: true });
    expect(none).toEqual([]);
    const withDay = generateBillOccurrencesBudgetDated({ ...oil, autopayDay: 15 }, new Map(), D("2027-04-01"), D("2027-07-01"), draws, oilPlan(), { requireTailDay: true });
    expect(dates(withDay)).toEqual(["2027-04-15", "2027-05-15", "2027-06-15"]);
  });

  it("replaceDraws (the owner's opt-in): the estimate replaces the draws for the whole window; the draws are not touched", () => {
    const evs = generateBillOccurrencesBudgetDated(oil, new Map(), D("2026-10-10"), D("2027-01-10"), draws, plan({ replaceDraws: true }, "oil"));
    expect(evs.every((e) => (e as SeasonalScheduleEvent).estimate)).toBe(true);
    expect(dates(evs)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"].filter((d) => d < "2027-01-10"));
    expect(draws).toHaveLength(4);
  });

  it("an accrued bill with no draws: the plan replaces annualBudget / 12 month by month; no annual budget is needed", () => {
    const withBudget = generateBillOccurrencesBudgetDated({ ...oil, autopayDay: 10 }, new Map(), D("2026-10-01"), D("2026-12-31"), [], oilPlan());
    expect(amounts(withBudget)).toEqual(["-600.00", "-600.00", "-600.00"]);
    const noBudget = generateBillOccurrencesBudgetDated({ ...oil, autopayDay: 10, annualBudget: null }, new Map(), D("2026-10-01"), D("2026-12-31"), [], oilPlan());
    expect(amounts(noBudget)).toEqual(["-600.00", "-600.00", "-600.00"]);
    const flat = generateBillOccurrencesBudgetDated({ ...oil, autopayDay: 10 }, new Map(), D("2026-10-01"), D("2026-12-31"), []);
    expect(amounts(flat)).toEqual(["-333.33", "-333.33", "-333.33"]);
  });
});

// ── Upcoming ledger ─────────────────────────────────────────────────────────────

function ledgerBill(b: BillDateBill, draws?: UpcomingBillRow["draws"]): UpcomingBillRow {
  return {
    id: b.id,
    accountId: b.accountId,
    entityId: b.entityId ?? "ent-p",
    payee: b.payee,
    amountType: b.amountType,
    expectedAmount: b.expectedAmount,
    autopayDay: b.autopayDay,
    annualBudget: b.annualBudget,
    frequency: b.frequency ?? "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    active: true,
    budgetTagId: b.budgetTagId ?? null,
    budgetEntityId: b.budgetEntityId ?? null,
    ...(draws ? { draws } : {}),
  };
}

describe("Upcoming ledger", () => {
  const FROM = D("2026-10-10");

  it("no plan: the flat bill figure, tier scheduled (unchanged)", () => {
    const l = buildUpcomingLedger({ from: FROM, days: 90, entityId: "ent-p", bills: [ledgerBill(electric)] });
    expect(l.items.map((i) => [iso(i.date!), i.amount!.toFixed(2), i.tier])).toEqual([
      ["2026-10-20", "-172.00", "scheduled"],
      ["2026-11-20", "-172.00", "scheduled"],
      ["2026-12-20", "-172.00", "scheduled"],
    ]);
  });

  it("with a plan: the plan's amounts, tier estimated, the short basis as a note, counted in the estimated totals", () => {
    const l = buildUpcomingLedger({ from: FROM, days: 90, entityId: "ent-p", bills: [ledgerBill(electric)], seasonal: [plan()] });
    expect(l.items.map((i) => [iso(i.date!), i.amount!.toFixed(2), i.tier])).toEqual([
      ["2026-10-20", "-170.00", "estimated"],
      ["2026-11-20", "-230.00", "estimated"],
      ["2026-12-20", "-290.00", "estimated"],
    ]);
    for (const i of l.items) {
      expect(i.tierNote).toBe("seasonal estimate, low confidence");
      expect(i.notes).toContain(plan().shortBasis);
      expect(i.amountStatus).toBe("known");
    }
    expect(l.totals.outflow.toFixed(2)).toBe("690.00");
    expect(l.totals.outflowEstimated.toFixed(2)).toBe("690.00");
  });

  it("a bill with no expected amount is known (not 'Amount not set') once a plan covers it", () => {
    const l = buildUpcomingLedger({ from: FROM, days: 45, entityId: "ent-p", bills: [ledgerBill({ ...electric, expectedAmount: null })], seasonal: [plan()] });
    expect(l.items.map((i) => i.amountStatus)).toEqual(["known", "known"]);
    const none = buildUpcomingLedger({ from: FROM, days: 45, entityId: "ent-p", bills: [ledgerBill({ ...electric, expectedAmount: null })] });
    expect(none.items.map((i) => i.amountStatus)).toEqual(["unknown", "unknown"]);
  });

  it("a plan for another entity's line never touches this bill", () => {
    const l = buildUpcomingLedger({ from: FROM, days: 40, entityId: "ent-p", bills: [ledgerBill(electric)], seasonal: [plan({ lineKey: "ent-sv|t-elec", entityId: "ent-sv" })] });
    expect(l.items.every((i) => i.tier === "scheduled" && i.amount!.toFixed(2) === "-172.00")).toBe(true);
  });

  it("oil with hand draws: the draws keep their tier and amounts; the tail after the last draw is a labelled estimate (dated bills only)", () => {
    const draws = [draw("2026-12-16", "2000"), draw("2027-01-20", "2000")];
    const l = buildUpcomingLedger({ from: FROM, days: 250, entityId: "ent-p", bills: [ledgerBill({ ...oil, autopayDay: 12 }, draws)], seasonal: [plan({}, "oil")] });
    const draw3 = l.items.filter((i) => i.tier === "estimated" && !i.notes.includes(plan({}, "oil").shortBasis));
    expect(draw3.map((i) => [iso(i.date!), i.amount!.toFixed(2)])).toEqual([
      ["2026-12-16", "-2000.00"],
      ["2027-01-20", "-2000.00"],
    ]);
    const tail = l.items.filter((i) => i.notes.includes(plan({}, "oil").shortBasis));
    expect(tail.map((i) => iso(i.date!))).toEqual(["2027-02-12", "2027-03-12", "2027-04-12", "2027-05-12", "2027-06-12"]);
    expect(tail.every((i) => i.amount!.toFixed(2) === "-600.00")).toBe(true);
  });

  it("oil with hand draws and NO pay day: the ledger never guesses a date for the tail", () => {
    const draws = [draw("2026-12-16", "2000")];
    const l = buildUpcomingLedger({ from: FROM, days: 240, entityId: "ent-p", bills: [ledgerBill(oil, draws)], seasonal: [plan({}, "oil")] });
    expect(l.items.map((i) => iso(i.date!))).toEqual(["2026-12-16"]);
  });

  it("oil with no draws and no day: the undated monthly figure is this month's estimate, labelled", () => {
    const l = buildUpcomingLedger({ from: FROM, days: 30, entityId: "ent-p", bills: [ledgerBill(oil)], seasonal: [plan({}, "oil")] });
    expect(l.undated).toHaveLength(1);
    expect(l.undated[0]!.amount!.toFixed(2)).toBe("-600.00");
    expect(l.undated[0]!.tier).toBe("estimated");
    expect(l.undated[0]!.notes).toContain("Amount shown is this month's seasonal estimate");
    const flat = buildUpcomingLedger({ from: FROM, days: 30, entityId: "ent-p", bills: [ledgerBill(oil)] });
    expect(flat.undated[0]!.amount!.toFixed(2)).toBe("-333.33");
  });

  it("Sudden Valley's unlinked bills match by entity and payee", () => {
    const svBill = ledgerBill({ ...electric, id: "b-sv", entityId: "ent-sv", payee: "Eversource (Arbor Retreat)", budgetTagId: null, budgetEntityId: null, amountType: "fluctuating", expectedAmount: "83", autopayDay: 14 });
    const svPlan = plan({ entityId: "ent-sv", lineKey: "ent-sv|t-sv-elec" });
    const l = buildUpcomingLedger({ from: FROM, days: 30, entityId: "ent-sv", bills: [svBill], seasonal: [svPlan] });
    expect(l.items.map((i) => [i.amount!.toFixed(2), i.tier])).toEqual([["-170.00", "estimated"], ["-230.00", "estimated"]].slice(0, l.items.length));
  });
});

// ── Assistant ───────────────────────────────────────────────────────────────────

function forecastInputs(over: Partial<ForecastInputs> = {}): ForecastInputs {
  return {
    accounts: [{ id: "acct-main", entityId: "ent-p", nickname: "Primary Checking", mask: "1234", currentBalance: dec("5000"), currentBalanceAt: D("2026-10-09"), minimumBalance: dec("250") }],
    transfers: [],
    incomes: [],
    bills: [
      {
        id: "b-elec",
        accountId: "acct-main",
        entityId: "ent-p",
        budgetTagId: "t-elec",
        budgetEntityId: "ent-p",
        payee: "Electric (Eversource)",
        amountType: "static",
        expectedAmount: dec("172"),
        autopayDay: 20,
        annualBudget: null,
        frequency: "monthly",
        payDayOfWeek: null,
        biweeklyAnchorDate: null,
        payMonth: null,
        accrualEnvelope: null,
      },
    ],
    cardProjections: [],
    cardProjectionsFailed: false,
    entityNameById: { "ent-p": "Personal" },
    ...over,
  };
}

describe("assistant get_forecast", () => {
  it("an estimated bill event is marked estimate: true and a note carries its basis; without plans nothing changes", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    const withPlan = buildForecastView(forecastInputs({ seasonalPlans: [plan()] }), now, 30);
    const data = withPlan.data as { events: Array<Record<string, unknown>>; notes: string[] };
    const ev = data.events.find((e) => e.type === "bill")!;
    expect(ev).toMatchObject({ date: "2026-10-20", amount: -170, estimate: true, description: "Electric (Eversource) (estimate)" });
    expect(data.notes.join(" ")).toMatch(/Electric \(Eversource\): events marked estimate: true use a seasonal estimate/);
    expect(data.notes.join(" ")).toMatch(/hand-entered draw always wins/);
    const without = buildForecastView(forecastInputs(), now, 30);
    const d2 = without.data as { events: Array<Record<string, unknown>>; notes: string[] };
    expect(d2.events.find((e) => e.type === "bill")).toMatchObject({ amount: -172 });
    expect(d2.events.find((e) => e.type === "bill")).not.toHaveProperty("estimate");
    expect(d2.notes.join(" ")).not.toMatch(/seasonal estimate/);
  });
});

describe("assistant get_budget_status", () => {
  const line = (over: Record<string, unknown> = {}) => ({
    tagPath: "Utilities / Electric (Eversource)",
    shortName: "Electric (Eversource)",
    entity: "Personal",
    frequency: "monthly",
    budgeted: "172.00",
    autoSummed: false,
    rolloverEnabled: false,
    rolloverAmount: "0.00",
    spent: "50.00",
    isRoot: true,
    ...over,
  });
  it("a row with a seasonal estimate shows it BESIDE the budget figure, with confidence and basis, plus one note", () => {
    const out = shapeBudgets("2026-11", [line({ seasonalEstimate: { amount: "230.00", confidence: "low", basis: "Seasonal estimate from 8 Eversource payments in 8 months (low confidence)" } }), line({ shortName: "Groceries", tagPath: "Food & Drink / Groceries" })]);
    const data = out.data as { rows: Array<Record<string, unknown>>; notes: string[] };
    expect(data.rows[0]).toMatchObject({ budgeted: 172, seasonal_estimate: { amount: 230, confidence: "low" } });
    expect(data.rows[1]).not.toHaveProperty("seasonal_estimate");
    expect(data.notes.join(" ")).toMatch(/seasonal_estimate carry the seasonal model's ESTIMATE/);
    expect(data.notes.join(" ")).toMatch(/does not replace budgeted/);
    const plain = shapeBudgets("2026-11", [line()]);
    expect((plain.data as { notes: string[] }).notes.join(" ")).not.toMatch(/seasonal_estimate/);
  });
});
