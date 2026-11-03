import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DrillData, DrillLine, DrillTx } from "@/lib/dashboard-drill";
import {
  buildMonthlyReport,
  buildWeeklyReport,
  daysInPeriod,
  firstWeekdayOf,
  nyCalendarDay,
  shiftPeriod,
  splitColumns,
} from "@/lib/personal-reports";

function line(over: Partial<DrillLine> & { id: string }): DrillLine {
  return {
    entityId: "e1",
    carriedFrom: null,
    tagId: `tag-${over.id}`,
    label: over.shortName ?? over.id,
    shortName: over.id,
    accountId: "a1",
    accountName: "Checking",
    parentId: null,
    ancestorIds: [],
    depth: 0,
    hasChildren: false,
    childIds: [],
    budgetCents: 0,
    rolloverCents: 0,
    effectiveCents: 0,
    rawCents: 0,
    recurringLinked: false,
    ownCents: 0,
    rolledCents: 0,
    remainingCents: 0,
    percentUsed: 0,
    overspent: false,
    countsAsOverspent: false,
    overByCents: 0,
    txIds: [],
    ...over,
  };
}

function tx(id: string, day: string, cents: number, cls: DrillTx["cls"] = "spending", tagIds: string[] = []): DrillTx {
  return { id, day, payee: `Payee ${id}`, account: "Checking", accountId: "a1", entity: "Personal", cents, cls, reason: "", pending: false, tagIds, tagPaths: [], targets: [] };
}

function data(over: Partial<DrillData> = {}): DrillData {
  return {
    period: "2026-11",
    periodLabel: "November 2026",
    isCurrentPeriod: true,
    isAllEntities: false,
    bucket: "personal",
    hrefs: { budgets: "", envelope: "", transactions: "" },
    txs: [],
    lines: [],
    groups: [],
    rootLineIds: [],
    notInLine: [],
    untagged: { cents: 0, txIds: [] },
    duplicateCents: 0,
    excluded: [],
    spentCents: 0,
    outflowCents: 0,
    refundsCents: 0,
    refundCount: 0,
    incomeCents: 0,
    pendingCount: 0,
    businessCents: 0,
    totalBudgetedCents: 0,
    overspentCount: 0,
    entityBreakdown: null,
    firstEditMonths: null,
    accounts: [],
    transfers: [],
    ...over,
  };
}

describe("period helpers", () => {
  it("counts days, weekdays and shifts across a year", () => {
    expect(daysInPeriod("2026-02")).toBe(28);
    expect(daysInPeriod("2028-02")).toBe(29);
    expect(firstWeekdayOf("2026-11")).toBe(0); // Nov 1 2026 is a Sunday
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(shiftPeriod("2026-12", 1)).toBe("2027-01");
  });
  it("uses the New York calendar day, not UTC", () => {
    // 01:30 UTC on Nov 4 is still Nov 3 in New York
    expect(nyCalendarDay(new Date("2026-11-04T01:30:00Z"))).toBe("2026-11-03");
  });
});

describe("weekly check-in", () => {
  const groceries = line({ id: "Groceries", effectiveCents: 60000, rolledCents: 45000, tagId: "t-g" });
  const dining = line({ id: "Dining", effectiveCents: 20000, rolledCents: 26000, tagId: "t-d", countsAsOverspent: true });
  const d = data({
    lines: [groceries, dining],
    txs: [
      tx("1", "2026-11-02", -10000, "spending", ["t-g"]),
      tx("2", "2026-11-09", -35000, "spending", ["t-g"]),
      tx("3", "2026-11-12", -30000, "spending", ["t-d"]),
      tx("4", "2026-11-13", 4000, "refund", ["t-d"]),
      tx("5", "2026-11-13", 250000, "income"),
      tx("6", "2026-11-13", -50000, "own_transfer"),
    ],
    spentCents: 71000,
    totalBudgetedCents: 80000,
    overspentCount: 1,
  });

  it("splits Spent into the weeks of the month and reconciles", () => {
    const r = buildWeeklyReport(d, null, "2026-11-14");
    expect(r.weeks.map((w) => w.label)).toEqual(["Nov 1-7", "Nov 8-14", "Nov 15-21", "Nov 22-28", "Nov 29-30"]);
    expect(r.weeks.map((w) => w.spentCents)).toEqual([10000, 61000, 0, 0, 0]);
    expect(r.weeks[1]?.current).toBe(true);
    expect(r.weeks[2]?.future).toBe(true);
    expect(r.reconciles).toBe(true);
  });

  it("reports the last seven days net of refunds, the biggest purchases first, and ignores transfers and income", () => {
    const r = buildWeeklyReport(d, null, "2026-11-14");
    expect(r.lastSeven).toEqual({ fromDay: "Nov 8", toDay: "Nov 14", spentCents: 61000, count: 2 });
    expect(r.biggest.map((b) => [b.id, b.cents, b.category])).toEqual([
      ["2", 35000, "Groceries"],
      ["3", 30000, "Dining"],
    ]);
  });

  it("computes pace, what is left per day and a straight-line projection only from a quarter of the month", () => {
    const r = buildWeeklyReport(d, null, "2026-11-15");
    expect(r.elapsedPct).toBe(50);
    expect(r.usedPct).toBe(89);
    expect(r.leftCents).toBe(9000);
    expect(r.perDayLeftCents).toBe(600); // 9000 over 15 days left
    expect(r.projectedCents).toBe(142000);
    expect(buildWeeklyReport(d, null, "2026-11-05").projectedCents).toBeNull();
  });

  it("marks an over-budget category and folds lines beyond the chart size", () => {
    const many = Array.from({ length: 14 }, (_, i) => line({ id: `L${i}`, effectiveCents: (20 - i) * 1000, rolledCents: 500 }));
    const r = buildWeeklyReport(data({ lines: [dining, ...many] }), null, "2026-11-14");
    expect(r.categories).toHaveLength(10);
    expect(r.categories.find((c) => c.key === "Dining")?.over).toBe(true);
    const rest = r.categories[r.categories.length - 1];
    expect(rest?.folded).toBe(true);
    // every line is in the chart once: shown + folded add up
    const shownSpent = r.categories.reduce((s, c) => s + c.spentCents, 0);
    expect(shownSpent).toBe(26000 + 14 * 500);
  });

  it("adds a bar for money outside any line so the bars add up to Spent", () => {
    const r = buildWeeklyReport(data({ lines: [groceries], notInLine: [{ key: "tag:x", label: "Gifts", cents: 3000, txIds: [] }], untagged: { cents: 2000, txIds: [] } }), null, "2026-11-14");
    expect(r.categories.map((c) => [c.key, c.spentCents])).toEqual([
      ["Groceries", 45000],
      ["outside", 5000],
    ]);
  });

  it("a past month is shown complete", () => {
    const r = buildWeeklyReport(data({ period: "2026-10", isCurrentPeriod: false }), null, "2026-11-14");
    expect(r.dayOfMonth).toBe(31);
    expect(r.elapsedPct).toBe(100);
    expect(r.projectedCents).toBeNull();
  });
});

describe("month-end summary", () => {
  const parent = line({ id: "Home", hasChildren: true, childIds: ["Electric"], effectiveCents: 30000, rolledCents: 32000, remainingCents: -2000 });
  const child = line({ id: "Electric", parentId: "Home", depth: 1, ancestorIds: ["Home"], effectiveCents: 20000, rolledCents: 25000, remainingCents: -5000, countsAsOverspent: true, overByCents: 5000 });
  const food = line({ id: "Food", accountId: "a2", accountName: "Card", effectiveCents: 50000, rolledCents: 40000, remainingCents: 10000 });
  const d = data({
    period: "2026-10",
    periodLabel: "October 2026",
    isCurrentPeriod: false,
    lines: [parent, child, food],
    groups: [
      { accountId: "a1", accountName: "Checking", entityName: "Personal", budgetCents: 30000, spentCents: 32000, lineIds: ["Home", "Electric"] },
      { accountId: "a2", accountName: "Card", entityName: "Personal", budgetCents: 50000, spentCents: 40000, lineIds: ["Food"] },
    ],
    notInLine: [{ key: "tag:g", label: "Gifts", cents: 3000, txIds: [] }],
    untagged: { cents: 1500, txIds: [] },
    duplicateCents: 500,
    spentCents: 76000,
    totalBudgetedCents: 80000,
    overspentCount: 1,
  });

  it("lists every line under its account with budget, spent and left, and reconciles to Spent", () => {
    const r = buildMonthlyReport(d);
    expect(r.sections.map((s) => s.rows.map((x) => [x.label, x.depth, x.budgetCents, x.spentCents, x.remainingCents]))).toEqual([
      [
        ["Home", 0, 30000, 32000, -2000],
        ["Electric", 1, 20000, 25000, -5000],
      ],
      [["Food", 0, 50000, 40000, 10000]],
    ]);
    expect(r.outside.map((x) => [x.label, x.spentCents])).toEqual([
      ["Gifts", 3000],
      ["Untagged", 1500],
      ["Counted under two lines (correction)", -500],
    ]);
    expect(r.reconciles).toBe(true);
    expect(r.remainingCents).toBe(4000);
    expect(r.partial).toBe(false);
  });

  it("names the biggest overrun and counts lines under budget", () => {
    const r = buildMonthlyReport(d);
    expect(r.topOver).toEqual([{ key: "Electric", label: "Electric", overCents: 5000, budgetCents: 20000, spentCents: 25000 }]);
    expect(r.underCount).toBe(1);
  });

  it("flags a mismatch instead of hiding it", () => {
    expect(buildMonthlyReport({ ...d, spentCents: 99999 }).reconciles).toBe(false);
  });

  it("balances sections over two columns, keeping order", () => {
    const sec = (key: string, n: number) => ({ key, title: key, budgetCents: 0, spentCents: 0, rows: Array.from({ length: n }, () => buildMonthlyReport(d).sections[1]!.rows[0]!) });
    const [l, r] = splitColumns([sec("a", 10), sec("b", 3), sec("c", 8), sec("d", 2)], 0);
    expect(l.map((s) => s.key)).toEqual(["a", "b"]);
    expect(r.map((s) => s.key)).toEqual(["c", "d"]);
    const [l2, r2] = splitColumns([sec("a", 4), sec("b", 4), sec("c", 4), sec("d", 4)], 0);
    expect([l2.length, r2.length]).toEqual([2, 2]);
  });
});

describe("source guards", () => {
  const root = process.cwd();
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  it("the report model is pure and client-safe", () => {
    const src = read("lib/personal-reports.ts");
    expect(src).not.toMatch(/from "@\/lib\/db"|from "next\/|import[^;]*Decimal|new Date\(\)|Date\.now\(/);
  });
  it("the loader is read-only", () => {
    expect(read("lib/month-report-build.ts")).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw/);
  });
  it.each(["app/personal/reports/page.tsx", "app/personal/reports/weekly/page.tsx", "app/personal/reports/monthly/page.tsx"])(
    "%s runs auth() and redirects before reading anything",
    (file) => {
      const src = read(file);
      const authAt = src.indexOf("await auth()");
      const redirectAt = src.indexOf('redirect("/login"');
      expect(authAt).toBeGreaterThan(0);
      expect(redirectAt).toBeGreaterThan(authAt);
      for (const call of ["loadMonthReport(", "loadUpcomingLedger(", "getEntityBySlug("]) {
        const at = src.indexOf(call, src.indexOf("export default"));
        if (at >= 0) expect(at).toBeGreaterThan(redirectAt);
      }
    }
  );
});
