// TESTER (carry-forward-seasonal-energy, step 1): consumer-level behaviour of the effective Budget view that the
// Coder's tests do not pin: error propagation per consumer (a Budget read error must NOT silently become "no budget
// lines" where it used to propagate), variable / ended lines in the notification checks, the overview context,
// the pace check against a carried budget, loader call shape and idempotence. db mocked at the function boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

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
  financialGoal: { findMany: vi.fn() },
  netWorthSnapshot: { findFirst: vi.fn() },
  transaction: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/web-push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/gl-code-resolver", () => ({ autoAssignGlCodes: vi.fn() }));
vi.mock("@/lib/card-next-statement-build", () => ({ loadCardProjections: vi.fn() }));
vi.mock("@/lib/account-scheduled-flows", () => ({ loadScheduledFlows: vi.fn() }));
vi.mock("@/lib/net-income-build", () => ({ loadNetIncomeSources: vi.fn().mockResolvedValue([]) }));
const spend = vi.hoisted(() => ({ loadTagSpendForPeriod: vi.fn() }));
vi.mock("@/lib/advisor/queries/spend", () => spend);

import { checkBudgetOverspend, checkBudgetPace } from "@/lib/notifications";
import { loadBudgetFacts } from "@/lib/advisor/queries/budgets";
import { loadUpcomingLedgerInput } from "@/lib/upcoming-ledger-input";
import { loadBudgetHints } from "@/lib/recurring-budget-hint-build";
import { loadBudgetScheduleIndex } from "@/lib/bill-dates-build";
import { buildAdvisorContext } from "@/lib/advisor-context";
import { loadEffectiveBudgetRows, loadEffectiveBudgetRowsSafe, loadEffectiveScheduleRows } from "@/lib/budget-carry-forward-build";

const P = "ent-personal";
const E = "ent-ekc";
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

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
    entity: { id: entityId, name: entityId === P ? "Personal" : "EK Consulting", slug: entityId === P ? "personal" : "ek-consulting" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appSetting.findUnique.mockResolvedValue(null);
  mockDb.budget.findMany.mockResolvedValue([]);
  mockDb.user.findMany.mockResolvedValue([{ id: "u1", notificationPrefs: null }]);
  mockDb.notification.findFirst.mockResolvedValue(null);
  mockDb.notification.create.mockResolvedValue({ id: "n1" });
  mockDb.notification.update.mockResolvedValue({});
  mockDb.$queryRaw.mockResolvedValue([]);
  spend.loadTagSpendForPeriod.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("TESTER: a Budget read error propagates exactly where it used to (never silently 'no budget lines')", () => {
  beforeEach(() => {
    mockDb.budget.findMany.mockRejectedValue(new Error("db down"));
  });

  it("checkBudgetOverspend and checkBudgetPace reject (cron sees the failure)", async () => {
    await expect(checkBudgetOverspend("2027-01")).rejects.toThrow("db down");
    await expect(checkBudgetPace("2027-01")).rejects.toThrow("db down");
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("the advisor budget read and the ledger input reject", async () => {
    await expect(loadBudgetFacts("2027-01", { start: D("2027-01-01"), end: D("2027-02-01") }, null)).rejects.toThrow("db down");
    for (const k of ["scheduledBill", "recurringExpense", "accrualEnvelope", "account", "scheduledTransfer", "rentalBooking", "projectedRevenue", "taxDeadline", "insurancePolicy", "entity"] as const) {
      mockDb[k].findMany.mockResolvedValue([]);
    }
    await expect(loadUpcomingLedgerInput({ entityId: null, days: 30, now: new Date("2027-01-05T15:00:00Z") })).rejects.toThrow("db down");
  });

  it("the date index and the recurring hint stay fail-soft (index empty + failed, hint null) and log the error name only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const idx = await loadBudgetScheduleIndex({ from: D("2027-01-01"), to: D("2027-02-01") });
    expect(idx).toEqual({ index: new Map(), failed: true });
    mockDb.scheduledBill.findMany.mockResolvedValue([]);
    mockDb.recurringExpense.findMany.mockResolvedValue([]);
    expect(await loadBudgetHints({ entityId: P, now: new Date("2027-01-09T12:00:00Z") })).toBeNull();
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toMatch(/db down/);
    spy.mockRestore();
  });

  it("the Safe variant never rejects", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await loadEffectiveBudgetRowsSafe({ periods: ["2027-01"] })).toEqual({ rows: [], failed: true });
    spy.mockRestore();
  });

  it("the strict loaders reject (the second read, the setting, being fine)", async () => {
    await expect(loadEffectiveBudgetRows({ periods: ["2027-01"] })).rejects.toThrow("db down");
    await expect(loadEffectiveScheduleRows({ periods: ["2027-01"] })).rejects.toThrow("db down");
  });
});

describe("TESTER: loader call shape", () => {
  it("exactly one Budget read and one setting read per call; reads are entity-scoped only when asked", async () => {
    mockDb.budget.findMany.mockResolvedValue([dbRow(P, "t1", "Utilities / Solar", "2026-12")]);
    await loadEffectiveBudgetRows({ periods: ["2027-01", "2027-02", "2027-03"] });
    expect(mockDb.budget.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.appSetting.findUnique).toHaveBeenCalledTimes(1);
    expect(mockDb.appSetting.findUnique.mock.calls[0]![0]).toEqual({ where: { key: "seasonal_budget_lines" }, select: { value: true } });
    await loadEffectiveBudgetRows({ periods: ["2027-01"], entityId: "" });
    expect(mockDb.budget.findMany.mock.calls[1]![0].where).toEqual({}); // empty string = no entity filter
  });

  it("no period at all, or only invalid ones, reads nothing (no DB call)", async () => {
    expect(await loadEffectiveBudgetRows({ periods: [] })).toEqual([]);
    expect(await loadEffectiveBudgetRows({ periods: ["2027-13", "x"] })).toEqual([]);
    expect(await loadEffectiveScheduleRows({ periods: [] })).toEqual([]);
    expect(mockDb.budget.findMany).not.toHaveBeenCalled();
    expect(mockDb.appSetting.findUnique).not.toHaveBeenCalled();
  });

  it("DB row order does not matter (rows arrive newest-first in production, oldest-first here)", async () => {
    const rows = [dbRow(P, "t1", "Utilities / Solar", "2026-10"), dbRow(P, "t1", "Utilities / Solar", "2026-12", { budgeted: new Decimal("999") }), dbRow(P, "t1", "Utilities / Solar", "2026-11")];
    mockDb.budget.findMany.mockResolvedValue(rows);
    const asc = await loadEffectiveBudgetRows({ periods: ["2027-01"] });
    mockDb.budget.findMany.mockResolvedValue([...rows].reverse());
    const desc = await loadEffectiveBudgetRows({ periods: ["2027-01"] });
    expect(asc.map((r) => [r.carriedFrom, r.budgeted?.toString()])).toEqual([["2026-12", "999"]]);
    expect(desc.map((r) => [r.carriedFrom, r.budgeted?.toString()])).toEqual([["2026-12", "999"]]);
  });

  it("a setting row with a null / non-JSON / non-array value falls back to the default (Oil is the variable line; both carry in step 2)", async () => {
    mockDb.budget.findMany.mockResolvedValue([dbRow(P, "oil", "Utilities / Oil", "2026-12"), dbRow(P, "sol", "Utilities / Solar", "2026-12")]);
    for (const value of [null, "", "garbage", "{}", "42"]) {
      mockDb.appSetting.findUnique.mockResolvedValue({ value });
      const r = await loadEffectiveBudgetRows({ periods: ["2027-01"] });
      expect(r.map((x) => [x.tag.name, x.variable]).sort(), String(value)).toEqual([["Utilities / Oil", true], ["Utilities / Solar", false]]);
    }
  });

  it("an empty-array setting means NO variable lines: Oil carries flat like any other line", async () => {
    mockDb.budget.findMany.mockResolvedValue([dbRow(P, "oil", "Utilities / Oil", "2026-12")]);
    mockDb.appSetting.findUnique.mockResolvedValue({ value: "[]" });
    const r = await loadEffectiveBudgetRows({ periods: ["2027-01"] });
    expect(r.map((x) => [x.tag.name, x.source])).toEqual([["Utilities / Oil", "carried"]]);
  });

  it("a thrown setting read (e.g. table missing) FAILS the read (step 2): the owner's set is never silently swapped for the default", async () => {
    mockDb.appSetting.findUnique.mockRejectedValue(new Error("relation does not exist"));
    mockDb.budget.findMany.mockResolvedValue([dbRow(P, "sol", "Utilities / Solar", "2026-12")]);
    await expect(loadEffectiveBudgetRows({ periods: ["2027-01"] })).rejects.toThrow("relation does not exist");
  });

  it("the schedule-only read (date index) has NO period filter and is not entity-scoped: the frontier needs later rows, the carry needs earlier ones", async () => {
    mockDb.budget.findMany.mockResolvedValue([]);
    await loadEffectiveScheduleRows({ periods: ["2027-01", "2027-02"] });
    const arg = mockDb.budget.findMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("where");
    expect(arg.take).toBe(5000);
    expect(arg.orderBy).toEqual([{ period: "desc" }]);
    const sel = arg.select as Record<string, unknown>;
    expect(sel).not.toHaveProperty("budgeted");
    expect(sel).not.toHaveProperty("accountId");
    expect(sel).not.toHaveProperty("rolloverAmount");
  });

  it("the loader never selects account numbers, notes or any column outside its explicit list; relations are narrow selects", async () => {
    mockDb.budget.findMany.mockResolvedValue([]);
    await loadEffectiveBudgetRows({ periods: ["2027-01"] });
    const arg = mockDb.budget.findMany.mock.calls[0]![0] as { select: Record<string, unknown>; take: number; orderBy: unknown };
    expect(Object.keys(arg.select).sort()).toEqual(
      ["accountId", "additionalAmountCents", "annualAmountDue", "biweeklyAnchorDate", "budgeted", "entity", "entityId", "frequency", "id", "payDay", "payDayOfWeek", "payMonth", "period", "rolloverAmount", "rolloverEnabled", "tag", "tagId"]
    );
    expect(arg.take).toBe(5000);
    expect(arg.select.entity).toEqual({ select: { id: true, name: true, slug: true } });
    expect(arg.select.tag).toEqual({ select: { id: true, name: true, shortName: true, parentId: true } });
    expect(arg.orderBy).toEqual([{ period: "desc" }]);
  });
});

describe("TESTER: notifications on a month with no row", () => {
  it("overspend: an ended line produces NO alert; a variable line (Oil) alerts against its carried figure like any other (step 2)", async () => {
    mockDb.budget.findMany.mockResolvedValue([
      dbRow(P, "oil", "Utilities / Oil", "2026-12", { budgeted: new Decimal("100") }),
      dbRow(P, "gone", "Utilities / Old Gym", "2026-11", { budgeted: new Decimal("100") }),
      dbRow(P, "keep", "Utilities / Solar", "2026-12", { budgeted: new Decimal("100") }),
    ]);
    mockDb.$queryRaw.mockResolvedValue([
      { tagId: "oil", total: "-200" },
      { tagId: "gone", total: "-200" },
      { tagId: "keep", total: "-95" },
    ]);
    expect(await checkBudgetOverspend("2027-01")).toBe(2);
    const tagNames = mockDb.notification.create.mock.calls.map((c) => (c[0] as { data: { payload: { tagName: string } } }).data.payload.tagName).sort();
    expect(tagNames).toEqual(["Oil", "Solar"]); // the ended "Old Gym" never alerts
  });

  it("overspend for the source month itself is unchanged: own rows only, own rollover", async () => {
    mockDb.budget.findMany.mockResolvedValue([
      dbRow(P, "oil", "Utilities / Oil", "2026-12", { budgeted: new Decimal("100") }),
      dbRow(P, "gone", "Utilities / Old Gym", "2026-11", { budgeted: new Decimal("100") }),
    ]);
    mockDb.$queryRaw.mockResolvedValue([{ tagId: "oil", total: "-200" }, { tagId: "gone", total: "-200" }]);
    expect(await checkBudgetOverspend("2026-12")).toBe(1); // Oil has its own row in 2026-12 and is over; the ended 2026-11 line is not in 2026-12
    expect(await checkBudgetOverspend("2026-11")).toBe(1); // only the 2026-11 own row: Old Gym (Oil has no 2026-11 row: variable and no carry)
  });

  it("an entity with ONE curated month (EK Consulting) carries every line into later months, so today it alerts", async () => {
    mockDb.budget.findMany.mockResolvedValue([dbRow(E, "sw", "Business Expenses / Software Subscriptions", "2026-09", { budgeted: new Decimal("75") })]);
    mockDb.$queryRaw.mockResolvedValue([{ tagId: "sw", total: "-90" }]);
    expect(await checkBudgetOverspend("2026-10")).toBe(1);
  });

  it("pace: a carried line is evaluated against the CARRIED budget, not the source month rollover (fires at 800, not at 3000)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-20T12:00:00Z"));
    const setup = (budgeted: string, roll: string) => {
      mockDb.notification.create.mockClear();
      mockDb.budget.findMany.mockResolvedValue([dbRow(P, "g", "Food & Drink / Groceries", "2026-12", { budgeted: new Decimal(budgeted), rolloverEnabled: true, rolloverAmount: new Decimal(roll) })]);
      mockDb.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        if (sql.includes("to_char")) return ["2026-09", "2026-10", "2026-11", "2026-12"].map((p) => ({ tagId: "g", period: p, total: "-900" }));
        return [{ tagId: "g", total: "-600" }];
      });
    };
    setup("800", "500");
    expect(await checkBudgetPace("2027-01")).toBe(1);
    expect((mockDb.notification.create.mock.calls[0]![0] as { data: { payload: { effectiveBudget: string } } }).data.payload.effectiveBudget).toBe("800.00");
    setup("3000", "0");
    expect(await checkBudgetPace("2027-01")).toBe(0);
  });
});

describe("TESTER: assistant overview context", () => {
  const prime = () => {
    mockDb.financialGoal.findMany.mockResolvedValue([]);
    mockDb.account.findMany.mockResolvedValue([]);
    mockDb.netWorthSnapshot.findFirst.mockResolvedValue(null);
    mockDb.transaction.findMany.mockResolvedValue([]);
    mockDb.recurringExpense.findMany.mockResolvedValue([]);
    mockDb.rentalBooking.findMany.mockResolvedValue([]);
    mockDb.insurancePolicy.findMany.mockResolvedValue([]);
    mockDb.scheduledTransfer.findMany.mockResolvedValue([]);
  };

  it("marks a carried line and not an own line; Oil (variable) carries its flat figure in a month with no row; totals use the carried figures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
    prime();
    mockDb.budget.findMany.mockResolvedValue([
      dbRow(P, "sol", "Utilities / Solar", "2026-12", { budgeted: new Decimal("506") }),
      dbRow(P, "oil", "Utilities / Oil", "2026-12", { budgeted: new Decimal("308") }),
    ]);
    const text = await buildAdvisorContext();
    expect(text).toMatch(/Solar \(Personal\): budgeted \$506\.00, spent \$0\.00 .* \[carried forward from 2026-12\]/);
    expect(text).toMatch(/Oil \(Personal\): budgeted \$308\.00.* \[carried forward from 2026-12\]/);
    expect(text).toMatch(/Total budgeted: \$814\.00/);
  });

  it("an own month has no marker at all", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-15T12:00:00Z"));
    prime();
    mockDb.budget.findMany.mockResolvedValue([dbRow(P, "sol", "Utilities / Solar", "2026-12", { budgeted: new Decimal("506") })]);
    const text = await buildAdvisorContext();
    expect(text).toMatch(/Solar \(Personal\): budgeted \$506\.00/);
    expect(text).not.toMatch(/carried forward/);
  });
});
