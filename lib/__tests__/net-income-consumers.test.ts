// net-income-budget-dates: the consumers of the shared take-home resolver and the Budget-date wrapper.
// Mocks sit at the function boundary (db, loaders); no test here touches a real database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { flowDb, loadIncome } = vi.hoisted(() => ({
  flowDb: {
    scheduledTransfer: { findMany: vi.fn() },
    scheduledBill: { findMany: vi.fn() },
    budget: { findMany: vi.fn() },
  },
  loadIncome: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: flowDb }));
vi.mock("@/lib/net-income-build", () => ({ loadNetIncomeSources: (...a: unknown[]) => loadIncome(...a) }));

import { buildForecastView } from "@/lib/advisor/tools/get-forecast";
import type { ForecastInputs } from "@/lib/advisor/queries/forecast";
import { loadScheduledFlows } from "@/lib/account-scheduled-flows";
import { buildBudgetScheduleIndex, type BudgetScheduleRow } from "@/lib/bill-dates";
import { loadBudgetScheduleIndex } from "@/lib/bill-dates-build";

const dec = (s: string) => new Decimal(s);
const D = (s: string) => new Date(`${s}T00:00:00Z`);

const budgetRow = (period: string, payDay: number | null, over: Partial<BudgetScheduleRow> = {}): BudgetScheduleRow => ({
  entityId: "ent-p",
  tagId: "tag-solar",
  period,
  payDay,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  annualAmountDue: null,
  ...over,
});

const solarBill = {
  id: "b-solar",
  accountId: "a1",
  entityId: "ent-p",
  budgetTagId: "tag-solar",
  budgetEntityId: "ent-p",
  payee: "Solar",
  amountType: "static",
  expectedAmount: dec("200"),
  autopayDay: 17,
  annualBudget: null,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  accrualEnvelope: null,
};

function forecastInputs(over: Partial<ForecastInputs> = {}): ForecastInputs {
  return {
    accounts: [
      { id: "a1", entityId: "ent-p", nickname: "Primary Checking", mask: "1234", currentBalance: dec("5000.00"), currentBalanceAt: new Date("2026-10-01T10:00:00Z"), minimumBalance: dec("250.00") },
    ],
    transfers: [],
    incomes: [],
    bills: [],
    cardProjections: [],
    cardProjectionsFailed: false,
    entityNameById: { "ent-p": "Personal" },
    ...over,
  };
}
type View = { events: { date: string; description: string; amount: number; type: string }[]; notes: string[] };
const FNOW = new Date("2026-10-09T12:00:00Z");

describe("advisor get_forecast", () => {
  const eric = {
    id: "i1",
    accountId: "a1",
    description: "payroll (Alpine Bio Inc)",
    cadence: "semi_monthly",
    dayRules: { daysOfMonth: [15, 31] },
    amount: dec("6064.86"), // take-home (what the loader returns in `amount`)
    grossAmount: dec("9000"),
    amountBasis: "deposits" as const,
    active: true,
  };

  it("projects paychecks with the take-home amount, never the gross", () => {
    const d = buildForecastView(forecastInputs({ incomes: [eric] }), FNOW, 30).data as unknown as View;
    const pays = d.events.filter((e) => e.type === "income");
    expect(pays.map((e) => [e.date, e.amount])).toEqual([
      ["2026-10-15", 6064.86],
      ["2026-10-31", 6064.86],
    ]);
    expect(JSON.stringify(d)).not.toContain("9000");
  });

  it("marks a paycheck whose take-home is unknown (gross used) and says so in the notes", () => {
    const unknown = { ...eric, amount: dec("9000"), amountBasis: "gross_unknown" as const };
    const d = buildForecastView(forecastInputs({ incomes: [unknown] }), FNOW, 30).data as unknown as View;
    const pays = d.events.filter((e) => e.type === "income");
    expect(pays[0]!.description).toBe("payroll (Alpine Bio Inc) (gross, take-home unknown)");
    expect(pays[0]!.amount).toBe(9000);
    expect(d.notes.some((n) => n.includes("1 income source(s) use the gross amount because take-home is unknown"))).toBe(true);
  });

  it("states the take-home and budget-date rules in the notes", () => {
    const d = buildForecastView(forecastInputs({ incomes: [eric] }), FNOW, 30).data as unknown as View;
    expect(d.notes.some((n) => n.includes("Paychecks are take-home pay"))).toBe(true);
    expect(d.notes.some((n) => n.includes("Bills are dated by their budget line"))).toBe(true);
  });

  it("dates a budget-linked bill by its Budget row (Solar: record 17th, budget 14th); a month without a row keeps the record day; amounts unchanged", () => {
    const budgetIndex = buildBudgetScheduleIndex([budgetRow("2026-10", 14)]);
    const d = buildForecastView(forecastInputs({ bills: [solarBill], budgetIndex }), FNOW, 60).data as unknown as View;
    const bills = d.events.filter((e) => e.type === "bill");
    expect(bills.map((e) => [e.date, e.amount])).toEqual([
      ["2026-10-14", -200],
      ["2026-11-17", -200],
    ]);
  });

  it("a Budget row with no schedule (the Sep-style row) falls back to the record day", () => {
    const budgetIndex = buildBudgetScheduleIndex([budgetRow("2026-10", null)]);
    const d = buildForecastView(forecastInputs({ bills: [solarBill], budgetIndex }), FNOW, 30).data as unknown as View;
    expect(d.events.filter((e) => e.type === "bill").map((e) => e.date)).toEqual(["2026-10-17"]);
  });

  it("without a budget index the bill record's dates are used (exactly as before)", () => {
    const d = buildForecastView(forecastInputs({ bills: [solarBill] }), FNOW, 30).data as unknown as View;
    expect(d.events.filter((e) => e.type === "bill").map((e) => e.date)).toEqual(["2026-10-17"]);
  });
});

describe("loadScheduledFlows (account funding flows)", () => {
  beforeEach(() => {
    flowDb.scheduledTransfer.findMany.mockReset().mockResolvedValue([]);
    flowDb.scheduledBill.findMany.mockReset().mockResolvedValue([solarBill]);
    flowDb.budget.findMany.mockReset().mockResolvedValue([
      { entityId: "ent-p", tagId: "tag-solar", period: "2026-10", payDay: 14, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null },
    ]);
    loadIncome.mockReset().mockResolvedValue([
      { id: "i1", accountId: "a1", entityId: "ent-p", description: "payroll", cadence: "monthly", dayRules: { dayOfMonth: 15 }, amount: dec("6064.86"), active: true },
    ]);
  });

  it("uses take-home paychecks (the loader, scoped to the account) and Budget-dated bills", async () => {
    const flows = await loadScheduledFlows("a1", D("2026-10-09"), D("2026-10-31"));
    expect(loadIncome).toHaveBeenCalledWith({ where: { accountId: "a1" } });
    expect(flows).not.toBeNull();
    const byDate = Object.fromEntries(flows!.map((f) => [f.date.toISOString().slice(0, 10), f.amount.toFixed(2)]));
    expect(byDate).toEqual({ "2026-10-14": "-200.00", "2026-10-15": "6064.86" });
  });

  it("reads Budget rows with an explicit select of the schedule fields only", async () => {
    await loadScheduledFlows("a1", D("2026-10-09"), D("2026-10-31"));
    const arg = flowDb.budget.findMany.mock.calls[0]![0] as { select: Record<string, unknown>; where: Record<string, unknown> };
    // carry-forward-seasonal-energy: no period filter any more (the entity's latest month decides whether a line has
    // ended, and the latest earlier row is what a month without a row carries); the resolver keeps only the window.
    expect(arg.where).toBeUndefined();
    expect(Object.keys(arg.select).sort()).toEqual(
      ["annualAmountDue", "biweeklyAnchorDate", "entityId", "frequency", "id", "payDay", "payDayOfWeek", "payMonth", "period", "tag", "tagId"]
    );
    expect(arg.select.tag).toEqual({ select: { name: true } });
    expect(arg.select).not.toHaveProperty("budgeted");
  });

  it("falls back to the bill record's day when the Budget read fails (fail-soft)", async () => {
    flowDb.budget.findMany.mockRejectedValue(Object.assign(new Error("secret 4111111111111111"), { name: "PrismaClientKnownRequestError" }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const flows = await loadScheduledFlows("a1", D("2026-10-09"), D("2026-10-31"));
    expect(flows!.some((f) => f.date.toISOString().slice(0, 10) === "2026-10-17" && f.amount.toFixed(2) === "-200.00")).toBe(true);
    expect(spy.mock.calls[0]).toEqual(["Budget schedule index unavailable", "PrismaClientKnownRequestError"]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
    spy.mockRestore();
  });
});

describe("loadBudgetScheduleIndex", () => {
  beforeEach(() => {
    flowDb.budget.findMany.mockReset();
  });

  it("builds the index by entity|tag and period", async () => {
    flowDb.budget.findMany.mockResolvedValue([
      { id: "b1", entityId: "e", tagId: "t", period: "2026-10", payDay: 14, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null },
    ]);
    const r = await loadBudgetScheduleIndex({ from: D("2026-10-09"), to: D("2026-11-15") });
    expect(r.failed).toBe(false);
    expect(r.index.get("e|t")?.get("2026-10")?.payDay).toBe(14);
    // the window is applied by the resolver: 2026-11 has no row, so it carries 2026-10 (the line is in the latest month)
    expect(r.index.get("e|t")?.get("2026-11")).toMatchObject({ payDay: 14, carriedFrom: "2026-10" });
  });
  it("never rejects: an error gives an empty index and failed: true", async () => {
    flowDb.budget.findMany.mockRejectedValue(new Error("down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await loadBudgetScheduleIndex({ from: D("2026-10-09"), to: D("2026-11-15") });
    expect(r).toEqual({ index: new Map(), failed: true });
    spy.mockRestore();
  });
  it("an empty window reads nothing", async () => {
    const r = await loadBudgetScheduleIndex({ from: D("2026-10-09"), to: D("2026-10-09") });
    expect(r.index.size).toBe(0);
    expect(flowDb.budget.findMany).not.toHaveBeenCalled();
  });
});
