// carry-forward-seasonal-energy, step 1: every forward-month consumer of Budget rows reads the effective (carried
// forward) view. The db is mocked at the function boundary; nothing touches a real database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mockDb = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  budget: { findMany: vi.fn() },
  appSetting: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
  notification: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  scheduledBill: { findMany: vi.fn() },
  recurringExpense: { findMany: vi.fn() },
  accrualEnvelope: { findMany: vi.fn() },
  account: { findMany: vi.fn() },
  scheduledTransfer: { findMany: vi.fn() },
  rentalBooking: { findMany: vi.fn() },
  projectedRevenue: { findMany: vi.fn() },
  taxDeadline: { findMany: vi.fn() },
  insurancePolicy: { findMany: vi.fn() },
  entity: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/web-push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/gl-code-resolver", () => ({ autoAssignGlCodes: vi.fn() }));
vi.mock("@/lib/card-next-statement-build", () => ({ loadCardProjections: vi.fn() }));
vi.mock("@/lib/account-scheduled-flows", () => ({ loadScheduledFlows: vi.fn() }));
vi.mock("@/lib/net-income-build", () => ({ loadNetIncomeSources: vi.fn().mockResolvedValue([]) }));
const spend = vi.hoisted(() => ({ loadTagSpendForPeriod: vi.fn() }));
vi.mock("@/lib/advisor/queries/spend", () => spend);

import { loadBudgetScheduleIndex } from "@/lib/bill-dates-build";
import { effectiveSchedule, generateBillOccurrencesBudgetDated } from "@/lib/bill-dates";
import { loadUpcomingLedgerInput } from "@/lib/upcoming-ledger-input";
import { buildUpcomingLedger, type UpcomingBillRow, type UpcomingBudgetRow } from "@/lib/upcoming-ledger";
import { loadBudgetFacts } from "@/lib/advisor/queries/budgets";
import { shapeBudgets } from "@/lib/advisor/tools/get-budget-status";
import { checkBudgetOverspend } from "@/lib/notifications";
import { loadBudgetHints } from "@/lib/recurring-budget-hint-build";

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const P = "ent-personal";
const SV = "ent-sv";
const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

function dbRow(entityId: string, tagId: string, tagName: string, period: string, over: Record<string, unknown> = {}) {
  return {
    id: `row-${tagId}-${period}`,
    entityId,
    tagId,
    accountId: "acct-1",
    period,
    budgeted: new Decimal("200"),
    additionalAmountCents: new Decimal("0"),
    payDay: 14,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    rolloverEnabled: false,
    rolloverAmount: null,
    tag: { id: tagId, name: tagName, shortName: tagName.split(" / ").pop(), parentId: null },
    entity: { id: entityId, name: entityId === P ? "Personal" : "Sudden Valley", slug: entityId === P ? "personal" : "sudden-valley" },
    ...over,
  };
}

const solarBill = {
  id: "bill-solar",
  accountId: "acct-1",
  payee: "Solar",
  amountType: "static",
  expectedAmount: 505.7,
  autopayDay: 17,
  annualBudget: null,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  entityId: P,
  budgetTagId: "t-sol",
  budgetEntityId: P,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appSetting.findUnique.mockResolvedValue(null);
  mockDb.budget.findMany.mockResolvedValue([]);
});

// ── 1. The date index (lib/bill-dates-build.ts + lib/bill-dates.ts) ───────────────────────────────────────

describe("the Budget date index carries forward", () => {
  beforeEach(() => {
    mockDb.budget.findMany.mockResolvedValue([
      dbRow(P, "t-sol", "Utilities / Solar", "2026-12", { payDay: 14 }),
      dbRow(P, "t-gone", "Utilities / Old Gym", "2026-11", { payDay: 3 }), // dropped from 2026-12: ended
      dbRow(P, "t-elec", "Utilities / Electric (Eversource)", "2026-12", { payDay: 20 }), // variable: not carried yet
    ]);
  });

  it("a 2027 window holds the 2026-12 Solar row for each month, marked carriedFrom; ended and variable lines are absent", async () => {
    const r = await loadBudgetScheduleIndex({ from: D("2027-01-01"), to: D("2027-04-01") });
    expect(r.failed).toBe(false);
    const solar = r.index.get(`${P}|t-sol`)!;
    expect([...solar.keys()].sort()).toEqual(["2027-01", "2027-02", "2027-03"]);
    expect(solar.get("2027-02")).toMatchObject({ payDay: 14, carriedFrom: "2026-12" });
    expect(r.index.has(`${P}|t-gone`)).toBe(false);
    expect(r.index.has(`${P}|t-elec`)).toBe(false);
  });

  it("the bill is dated by the carried Budget day in 2027 (the record says 17)", async () => {
    const { index } = await loadBudgetScheduleIndex({ from: D("2027-01-01"), to: D("2027-04-01") });
    const events = generateBillOccurrencesBudgetDated(solarBill, index, D("2027-01-01"), D("2027-04-01"));
    expect(events.map((e) => e.date.toISOString().slice(0, 10))).toEqual(["2027-01-14", "2027-02-14", "2027-03-14"]);
    for (const e of events) expect(e.amount.abs().toFixed(2)).toBe("505.70"); // amounts are still the bill's
    const eff = effectiveSchedule(solarBill, index, "2027-02");
    expect(eff).toMatchObject({ basis: "budget", budgetDay: 14, recordDay: 17, carriedFrom: "2026-12" });
  });

  it("an own row reports carriedFrom null", async () => {
    const { index } = await loadBudgetScheduleIndex({ from: D("2026-12-01"), to: D("2027-01-01") });
    expect(effectiveSchedule(solarBill, index, "2026-12")).toMatchObject({ basis: "budget", carriedFrom: null });
  });

  it("a variable line keeps the bill record's own day (current behaviour) in 2027", async () => {
    const { index } = await loadBudgetScheduleIndex({ from: D("2027-01-01"), to: D("2027-02-01") });
    const elec = { ...solarBill, id: "bill-elec", payee: "Electric (Eversource)", autopayDay: 20, budgetTagId: "t-elec" };
    expect(effectiveSchedule(elec, index, "2027-01")).toMatchObject({ basis: "bill", carriedFrom: null });
  });

  it("a Budget read error is fail-soft: empty index, failed true", async () => {
    mockDb.budget.findMany.mockRejectedValue(new Error("down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await loadBudgetScheduleIndex({ from: D("2027-01-01"), to: D("2027-02-01") });
    expect(r).toEqual({ index: new Map(), failed: true });
    spy.mockRestore();
  });
});

// ── 2. The Upcoming ledger ───────────────────────────────────────────────────────────────────────────────

describe("the Upcoming ledger note", () => {
  const FROM = D("2027-01-05");
  const bill = (over: Partial<UpcomingBillRow> = {}): UpcomingBillRow => ({
    id: "bill-solar",
    accountId: "acct-1",
    entityId: P,
    payee: "Solar",
    amountType: "static",
    expectedAmount: 200,
    autopayDay: 17,
    annualBudget: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    active: true,
    budgetTagId: "t-sol",
    budgetEntityId: P,
    ...over,
  });
  const budget = (over: Partial<UpcomingBudgetRow> & Pick<UpcomingBudgetRow, "id" | "period">): UpcomingBudgetRow => ({
    tagId: "t-sol",
    tagName: "Solar",
    entityId: P,
    accountId: "acct-1",
    budgeted: 200,
    payDay: 14,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    ...over,
  });
  const billItems = (l: ReturnType<typeof buildUpcomingLedger>) => l.items.filter((i) => i.kind === "bill");

  it("a carried row shows the quiet note naming the source period, and no 'No budget line' note", () => {
    const l = buildUpcomingLedger({
      from: FROM,
      days: 60,
      bills: [bill()],
      budgets: [
        budget({ id: "carried:b12:2027-01", period: "2027-01", carriedFrom: "2026-12" }),
        budget({ id: "carried:b12:2027-02", period: "2027-02", carriedFrom: "2026-12" }),
      ],
    });
    const items = billItems(l);
    expect(items.map((i) => i.date?.toISOString().slice(0, 10))).toEqual(["2027-01-14", "2027-02-14"]);
    for (const i of items) {
      expect(i.notes).toContain("Budget figure carried forward from 2026-12");
      expect(i.notes.some((n) => n.startsWith("No budget line"))).toBe(false);
    }
  });

  it("an own row has no carried note", () => {
    const l = buildUpcomingLedger({ from: FROM, days: 30, bills: [bill()], budgets: [budget({ id: "b1", period: "2027-01" })] });
    for (const i of billItems(l)) expect(i.notes.some((n) => /carried forward/.test(n))).toBe(false);
  });

  it("'No budget line for <period>' remains when nothing exists to carry (a month with no row at all)", () => {
    const l = buildUpcomingLedger({ from: FROM, days: 60, bills: [bill()], budgets: [budget({ id: "b1", period: "2027-01" })] });
    const feb = billItems(l).find((i) => i.date?.toISOString().startsWith("2027-02"));
    expect(feb?.notes).toContain("No budget line for 2027-02");
  });

  it("a budget-only line (no bill) with a schedule gets the note too", () => {
    const l = buildUpcomingLedger({
      from: FROM,
      days: 30,
      budgets: [budget({ id: "carried:bx:2027-01", period: "2027-01", tagId: "t-gym", tagName: "Gym", carriedFrom: "2026-12" })],
    });
    const gym = billItems(l).filter((i) => i.label === "Gym");
    expect(gym.length).toBeGreaterThan(0);
    for (const i of gym) expect(i.notes).toContain("Budget figure carried forward from 2026-12");
  });
});

describe("loadUpcomingLedgerInput reads the effective rows", () => {
  beforeEach(() => {
    for (const k of ["scheduledBill", "recurringExpense", "accrualEnvelope", "account", "scheduledTransfer", "rentalBooking", "projectedRevenue", "taxDeadline", "insurancePolicy", "entity"] as const) {
      mockDb[k].findMany.mockResolvedValue([]);
    }
    mockDb.budget.findMany.mockResolvedValue([dbRow(P, "t-sol", "Utilities / Solar", "2026-12"), dbRow(SV, "t-ins", "Arbor Retreat / Insurance", "2026-12")]);
  });

  it("a 2027 window maps carried rows with carriedFrom and a synthetic id; the entity filter is passed to the read", async () => {
    mockDb.budget.findMany.mockResolvedValue([dbRow(P, "t-sol", "Utilities / Solar", "2026-12")]); // the DB applies the entity filter
    const r = await loadUpcomingLedgerInput({ entityId: P, days: 40, now: new Date("2027-01-05T15:00:00Z") });
    const budgets = r.input.budgets ?? [];
    expect(budgets.map((b) => [b.period, b.carriedFrom, b.id])).toEqual([
      ["2027-01", "2026-12", "carried:row-t-sol-2026-12:2027-01"],
      ["2027-02", "2026-12", "carried:row-t-sol-2026-12:2027-02"],
    ]);
    // the Budget read is the shared loader: explicit select, entity-scoped, no period filter
    const arg = mockDb.budget.findMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ entityId: P });
    expect(arg.select).toBeTruthy();
    expect(arg.include).toBeUndefined();
  });

  it("an all-entities view carries each entity on its own frontier", async () => {
    const r = await loadUpcomingLedgerInput({ entityId: null, days: 10, now: new Date("2027-01-05T15:00:00Z") });
    expect((r.input.budgets ?? []).map((b) => [b.entityId, b.period]).sort()).toEqual([[P, "2027-01"], [SV, "2027-01"]]);
  });
});

// ── 3. The assistant ───────────────────────────────────────────────────────────────────────────────

describe("advisor budgets (get_budget_status)", () => {
  beforeEach(() => {
    spend.loadTagSpendForPeriod.mockResolvedValue([{ entityId: P, tagId: "t-groc", total: "-300.00" }]);
    mockDb.budget.findMany.mockResolvedValue([
      dbRow(P, "t-groc", "Food & Drink / Groceries", "2026-12", { budgeted: new Decimal("1200"), rolloverEnabled: true, rolloverAmount: new Decimal("55") }),
      dbRow(SV, "t-ins", "Arbor Retreat / Insurance", "2026-12", { budgeted: new Decimal("80") }),
      dbRow(P, "t-oil", "Utilities / Oil", "2026-12", { budgeted: new Decimal("308") }),
    ]);
  });
  const bounds = { start: D("2027-01-01"), end: D("2027-02-01") };

  it("a month with no rows shows the carried lines with carriedFrom; rollover is not carried; Oil (variable) is not shown", async () => {
    const facts = await loadBudgetFacts("2027-01", bounds, null);
    expect(facts.map((f) => [f.shortName, f.carriedFrom, f.budgeted])).toEqual([
      ["Groceries", "2026-12", "1200.00"],
      ["Insurance", "2026-12", "80.00"],
    ]);
    expect(facts[0]!.rolloverAmount).toBe("0.00");
    expect(facts[0]!.spent).toBe("300.00");
  });

  it("an own month is unchanged and has no carriedFrom", async () => {
    const facts = await loadBudgetFacts("2026-12", bounds, null);
    expect(facts.map((f) => [f.shortName, f.carriedFrom])).toEqual([["Groceries", null], ["Oil", null], ["Insurance", null]]);
    expect(facts.find((f) => f.shortName === "Groceries")!.rolloverAmount).toBe("55.00");
  });

  it("the entity filter matches name or slug case-insensitively", async () => {
    const byName = await loadBudgetFacts("2027-01", bounds, "sudden valley");
    const bySlug = await loadBudgetFacts("2027-01", bounds, "SUDDEN-VALLEY");
    expect(byName.map((f) => f.shortName)).toEqual(["Insurance"]);
    expect(bySlug.map((f) => f.shortName)).toEqual(["Insurance"]);
  });

  it("the tool output marks carried rows and adds one observational note; no key for own rows", async () => {
    const carried = shapeBudgets("2027-01", await loadBudgetFacts("2027-01", bounds, null));
    const data = carried.data as { rows: Array<Record<string, unknown>>; notes: string[] };
    expect(data.rows.every((r) => r.carried_from === "2026-12")).toBe(true);
    expect(data.notes.join(" ")).toMatch(/carried forward at read time/);
    const own = shapeBudgets("2026-12", await loadBudgetFacts("2026-12", bounds, null));
    const ownData = own.data as { rows: Array<Record<string, unknown>>; notes: string[] };
    expect(ownData.rows.some((r) => "carried_from" in r)).toBe(false);
    expect(ownData.notes.join(" ")).not.toMatch(/carried forward/);
  });
});

// ── 4. Notifications ─────────────────────────────────────────────────────────────────────────────

describe("notifications use the effective rows for the current period", () => {
  beforeEach(() => {
    mockDb.user.findMany.mockResolvedValue([{ id: "u1", notificationPrefs: null }]);
    mockDb.notification.findFirst.mockResolvedValue(null);
    mockDb.notification.create.mockResolvedValue({ id: "n1" });
    mockDb.notification.update.mockResolvedValue({});
    mockDb.$queryRaw.mockResolvedValue([{ tagId: "t-groc", total: "-1020" }]);
    // source month: budget 1200 WITH a +300 rollover carried in; the next month has no row
    mockDb.budget.findMany.mockResolvedValue([
      dbRow(P, "t-groc", "Food & Drink / Groceries", "2026-12", { budgeted: new Decimal("1200"), rolloverEnabled: true, rolloverAmount: new Decimal("300") }),
    ]);
  });

  it("a month with no row alerts against the carried amount, without the source month's rollover (85% of 1200, not 68% of 1500)", async () => {
    expect(await checkBudgetOverspend("2027-01")).toBe(1);
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { payload: { percentUsed: number; budgeted: string } } };
    expect(call.data.payload.percentUsed).toBe(85);
    expect(call.data.payload.budgeted).toBe("1200.00");
  });

  it("the source month itself still uses its own rollover (68% of 1500: no alert)", async () => {
    expect(await checkBudgetOverspend("2026-12")).toBe(0);
  });
});

// ── 5. Recurring-expense budget hint ───────────────────────────────────────────────────────────────

describe("the recurring budget hint (current period)", () => {
  it("a current month with no rows uses the carried budget and zero additional amount", async () => {
    mockDb.budget.findMany.mockResolvedValue([dbRow(P, "t-sol", "Utilities / Solar", "2026-12", { budgeted: new Decimal("60.00"), additionalAmountCents: new Decimal("1500") })]);
    mockDb.scheduledBill.findMany.mockResolvedValue([]);
    mockDb.recurringExpense.findMany.mockResolvedValue([]);
    const f = await loadBudgetHints({ entityId: P, now: new Date("2027-02-09T15:00:00Z") });
    expect(f?.[`${P}|t-sol`]).toMatchObject({ hasBudget: true, budgetedCents: 6000, additionalCents: 0 });
  });
});

// ── 6. Wiring (source) ───────────────────────────────────────────────────────────────────────────

describe("wiring", () => {
  it("the Forecast page reads business rows and pace rows through the loader and nests AFTER the carry", () => {
    const src = read("app/forecast/page.tsx");
    expect(src).not.toMatch(/db\.budget\./);
    expect(src.match(/loadEffectiveBudgetRows\(/g)).toHaveLength(2);
    const biz = src.indexOf("const budgetRows = await loadEffectiveBudgetRows");
    expect(biz).toBeGreaterThan(0);
    expect(src.indexOf("resolveBudgetedAmounts(resolverInput", biz)).toBeGreaterThan(biz);
    const pace = src.indexOf("const paceBudgets = await loadEffectiveBudgetRows");
    expect(pace).toBeGreaterThan(biz);
  });

  it("the assistant's overview context marks carried lines", () => {
    const src = read("lib/advisor-context.ts");
    expect(src).not.toMatch(/db\.budget\./);
    expect(src).toMatch(/loadEffectiveBudgetRows\(\{ periods: \[currentPeriod\] \}\)/);
    expect(src).toMatch(/carried forward from/);
  });

  it("notifications read both Budget checks through the loader", () => {
    const src = read("lib/notifications.ts");
    expect(src).not.toMatch(/db\.budget\./);
    expect(src.match(/loadEffectiveBudgetRows\(\{ periods: \[period\] \}\)/g)).toHaveLength(2);
  });

  it("the ledger input has no direct Budget read", () => {
    expect(read("lib/upcoming-ledger-input.ts")).not.toMatch(/db\.budget\./);
  });
});
