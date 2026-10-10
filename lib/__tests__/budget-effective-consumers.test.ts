// The monthly review and the budget CSV export read the EFFECTIVE budget (own rows plus lines carried forward) through
// the shared loader, for every month, past ones included; they never read the Budget table themselves.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { D, budgetRow, createFakeBudgetDb } from "./budget-fake-db";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  queryRaw: vi.fn(),
  current: { db: null as unknown },
}));

vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({
  get db() {
    const fake = m.current.db as Record<string, unknown>;
    return {
      ...fake,
      $queryRaw: m.queryRaw,
      entity: { findFirst: async () => null },
      account: { findMany: async () => [] },
      scheduledBill: { findMany: async () => [] },
      accrualEnvelope: { findMany: async () => [] },
    };
  },
}));

import { buildMonthlyReviewData } from "@/lib/monthly-review-build";
import { exportBudgetCsv } from "@/actions/reports";

const E_P = "ent-personal";
const E_K = "ent-ekc";
const TAGS = [
  { id: "t-rent", name: "Utilities / Mortgage", shortName: "Mortgage", parentId: null },
  { id: "t-food", name: "Food & Drink / Groceries", shortName: "Groceries", parentId: null },
  { id: "t-sw", name: "Software", shortName: "Software", parentId: null },
];

function arrange(extraRows = [] as ReturnType<typeof budgetRow>[]) {
  const fake = createFakeBudgetDb({
    rows: [
      budgetRow({ entityId: E_P, tagId: "t-rent", period: "2026-12", accountId: "a1", budgeted: D("1234.56") }),
      budgetRow({ entityId: E_P, tagId: "t-food", period: "2026-12", accountId: "a1", budgeted: D("876.54") }),
      budgetRow({ entityId: E_K, tagId: "t-sw", period: "2026-09", accountId: "a2", budgeted: D("75") }),
      ...extraRows,
    ],
    tags: TAGS,
    entities: [
      { id: E_P, name: "Personal", slug: "personal" },
      { id: E_K, name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting" },
    ],
    accounts: [
      { id: "a1", nickname: "Checking", entityId: E_P },
      { id: "a2", nickname: "EKC Operating", entityId: E_K },
    ],
  });
  m.current.db = fake.db;
  return fake;
}

beforeEach(() => {
  m.auth.mockReset();
  m.auth.mockResolvedValue({ user: { id: "u1" } });
  m.queryRaw.mockReset();
  m.queryRaw.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("monthly review", () => {
  it("a month with no row of its own reviews the carried lines against the month's spending", async () => {
    arrange();
    // first raw query = this month's spend per entity + tag
    m.queryRaw.mockResolvedValueOnce([{ entityId: E_P, tagId: "t-rent", total: "-1000.00" }]);
    const data = await buildMonthlyReviewData("2027-01");
    const byTag = new Map(data.budgetHealth.map((b) => [b.tagName + "|" + b.entityName, b]));
    // every entity is reviewed (each on its own frontier): Personal's two lines and EK Consulting's September line
    expect([...byTag.keys()].sort()).toEqual(["Groceries|Personal", "Mortgage|Personal", "Software|Eric Kinniburgh Consulting, LLC"]);
    expect(byTag.get("Software|Eric Kinniburgh Consulting, LLC")!.budgetedCents).toBe(7500);
    expect(byTag.get("Mortgage|Personal")!.budgetedCents).toBe(123456);
    expect(byTag.get("Mortgage|Personal")!.actualCents).toBe(100000);
    expect(byTag.get("Groceries|Personal")!.budgetedCents).toBe(87654);
    expect(byTag.get("Groceries|Personal")!.actualCents).toBe(0);
  });

  it("a month with its own row uses that row, not the carried one", async () => {
    arrange([budgetRow({ entityId: E_P, tagId: "t-rent", period: "2027-01", accountId: "a1", budgeted: D("999") }), budgetRow({ entityId: E_P, tagId: "t-food", period: "2027-01", accountId: "a1", budgeted: D("1") })]);
    const data = await buildMonthlyReviewData("2027-01");
    expect(data.budgetHealth.find((b) => b.tagName === "Mortgage")!.budgetedCents).toBe(99900);
  });

  it("forecast accuracy for the prior period also covers a prior month that was never saved (it carries)", async () => {
    arrange();
    const data = await buildMonthlyReviewData("2027-02"); // prior month 2027-01 has no rows of its own
    expect(data.forecastAccuracyPeriod).toBe("2027-01");
  });

  it("a month before the entity's first row has no budget lines and no prior period to evaluate", async () => {
    arrange();
    const data = await buildMonthlyReviewData("2026-03");
    expect(data.budgetHealth).toEqual([]);
    expect(data.forecastAccuracyPeriod).toBeNull();
  });

  it("reads the Budget table only through the loader's single read per call (no direct include read)", async () => {
    const fake = arrange();
    const spy = vi.spyOn(fake.db.budget, "findMany");
    await buildMonthlyReviewData("2027-01");
    expect(spy).toHaveBeenCalledTimes(2); // this month and the prior month, both via the loader
    for (const call of spy.mock.calls) {
      const arg = call[0] as { include?: unknown; select?: unknown };
      expect(arg.include).toBeUndefined();
      expect(arg.select).toBeDefined();
    }
  });
});

describe("exportBudgetCsv", () => {
  it("exports the carried lines of every entity for a month with no row, in the same columns, no extra marker", async () => {
    arrange();
    const csv = await exportBudgetCsv("2027-01");
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Period,Entity,Tag,Budgeted,Actual,% Used,Remaining");
    expect(lines.slice(1)).toEqual([
      "2027-01,Eric Kinniburgh Consulting,Software,75.00,0.00,0%,75.00",
      "2027-01,Personal,Groceries,876.54,0.00,0%,876.54",
      "2027-01,Personal,Mortgage,1234.56,0.00,0%,1234.56",
    ]);
  });

  it("uses the month's actual spending and an own row when there is one", async () => {
    arrange([budgetRow({ entityId: E_P, tagId: "t-rent", period: "2027-01", accountId: "a1", budgeted: D("2000") }), budgetRow({ entityId: E_P, tagId: "t-food", period: "2027-01", accountId: "a1", budgeted: D("876.54") })]);
    m.queryRaw.mockResolvedValue([{ tagId: "t-rent", entityId: E_P, total: "-500" }]);
    const csv = await exportBudgetCsv("2027-01");
    expect(csv).toContain("2027-01,Personal,Mortgage,2000.00,500.00,25%,1500.00");
    expect(csv).not.toContain("1234.56");
  });

  it("requires a session first and reads nothing without one; a bad period is refused", async () => {
    const fake = arrange();
    const spy = vi.spyOn(fake.db.budget, "findMany");
    m.auth.mockResolvedValue(null);
    await expect(exportBudgetCsv("2027-01")).rejects.toThrow("Unauthorized");
    expect(spy).not.toHaveBeenCalled();
    m.auth.mockResolvedValue({ user: { id: "u1" } });
    await expect(exportBudgetCsv("2027-1")).rejects.toThrow();
  });
});
