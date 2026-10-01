import { vi, describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/db", () => ({
  db: {
    transaction: { groupBy: vi.fn() },
    glCode: { findMany: vi.fn() },
    account: { findMany: vi.fn() },
  },
}));

import { computePL, computeBalanceSheet } from "@/lib/reports";
import { db } from "@/lib/db";

const mockGroupBy = db.transaction.groupBy as ReturnType<typeof vi.fn>;
const mockGlFind = db.glCode.findMany as ReturnType<typeof vi.fn>;
const mockAccFind = db.account.findMany as ReturnType<typeof vi.fn>;

const ENTITY_ID = "entity-1";
const FROM = new Date("2026-01-01T00:00:00Z");
const TO = new Date("2026-12-31T23:59:59Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computePL", () => {
  it("returns zero totals when no GL-coded transactions exist", async () => {
    mockGroupBy.mockResolvedValue([]);
    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.totalIncome.toNumber()).toBe(0);
    expect(pl.totalExpenses.toNumber()).toBe(0);
    expect(pl.netIncome.toNumber()).toBe(0);
    expect(pl.incomeLines).toHaveLength(0);
    expect(pl.expenseLines).toHaveLength(0);
  });

  it("sums income lines correctly", async () => {
    const glId = "gl-income-1";
    mockGroupBy.mockResolvedValue([
      { glCodeId: glId, _sum: { amount: new Prisma.Decimal("5000.00") }, _count: { _all: 1 } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: glId, code: "4000", name: "Consulting Revenue", type: "revenue" },
    ]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.incomeLines).toHaveLength(1);
    expect(pl.incomeLines[0]!.total.toNumber()).toBe(5000);
    expect(pl.totalIncome.toNumber()).toBe(5000);
    expect(pl.totalExpenses.toNumber()).toBe(0);
  });

  it("converts negative expense amounts to positive for display", async () => {
    const glId = "gl-exp-1";
    mockGroupBy.mockResolvedValue([
      { glCodeId: glId, _sum: { amount: new Prisma.Decimal("-1200.00") }, _count: { _all: 1 } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: glId, code: "5010", name: "Software", type: "expense" },
    ]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.expenseLines).toHaveLength(1);
    expect(pl.expenseLines[0]!.total.toNumber()).toBe(1200);
    expect(pl.totalExpenses.toNumber()).toBe(1200);
  });

  it("computes net income as totalIncome minus totalExpenses", async () => {
    const glIncome = "gl-inc";
    const glExp = "gl-exp";
    mockGroupBy.mockResolvedValue([
      { glCodeId: glIncome, _sum: { amount: new Prisma.Decimal("8000.00") }, _count: { _all: 1 } },
      { glCodeId: glExp, _sum: { amount: new Prisma.Decimal("-3000.00") }, _count: { _all: 1 } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: glIncome, code: "4000", name: "Revenue", type: "revenue" },
      { id: glExp, code: "5000", name: "Expenses", type: "expense" },
    ]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.totalIncome.toNumber()).toBe(8000);
    expect(pl.totalExpenses.toNumber()).toBe(3000);
    expect(pl.netIncome.toNumber()).toBe(5000);
  });

  it("excludes GL codes of type asset/liability/equity from P&L lines", async () => {
    const glAsset = "gl-asset";
    mockGroupBy.mockResolvedValue([
      { glCodeId: glAsset, _sum: { amount: new Prisma.Decimal("10000.00") }, _count: { _all: 1 } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: glAsset, code: "1000", name: "Cash", type: "asset" },
    ]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.incomeLines).toHaveLength(0);
    expect(pl.expenseLines).toHaveLength(0);
    expect(pl.netIncome.toNumber()).toBe(0);
  });
});

describe("computePL excludedFromPL", () => {
  const D = (v: string) => new Prisma.Decimal(v);

  it("reports an asset-coded row with count, net amount and line details", async () => {
    mockGroupBy.mockResolvedValue([
      { glCodeId: "gl-asset", _sum: { amount: D("6000.00") }, _count: { _all: 2 } },
    ]);
    mockGlFind.mockResolvedValue([{ id: "gl-asset", code: "1020", name: "Accounts Receivable", type: "asset" }]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.incomeLines).toHaveLength(0);
    expect(pl.expenseLines).toHaveLength(0);
    expect(pl.netIncome.toNumber()).toBe(0);
    expect(pl.excludedFromPL.transactionCount).toBe(2);
    expect(pl.excludedFromPL.netAmount.toString()).toBe("6000");
    expect(pl.excludedFromPL.lines).toHaveLength(1);
    expect(pl.excludedFromPL.lines[0]).toMatchObject({
      glCodeId: "gl-asset",
      code: "1020",
      name: "Accounts Receivable",
      type: "asset",
      transactionCount: 2,
    });
  });

  it("excludes and lists liability and equity types", async () => {
    mockGroupBy.mockResolvedValue([
      { glCodeId: "gl-liab", _sum: { amount: D("-500.00") }, _count: { _all: 1 } },
      { glCodeId: "gl-eq", _sum: { amount: D("2500.00") }, _count: { _all: 3 } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: "gl-liab", code: "2000", name: "Loan", type: "liability" },
      { id: "gl-eq", code: "3000", name: "Owner Contributions", type: "equity" },
    ]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.excludedFromPL.lines.map((l) => l.type)).toEqual(["liability", "equity"]);
    expect(pl.excludedFromPL.transactionCount).toBe(4);
    expect(pl.excludedFromPL.netAmount.toString()).toBe("2000");
    expect(pl.totalIncome.toNumber()).toBe(0);
    expect(pl.totalExpenses.toNumber()).toBe(0);
  });

  it("leaves P&L totals unchanged for a mixed set and only counts non-P&L rows as excluded", async () => {
    mockGroupBy.mockResolvedValue([
      { glCodeId: "gl-rev", _sum: { amount: D("8000.00") }, _count: { _all: 4 } },
      { glCodeId: "gl-exp", _sum: { amount: D("-3000.00") }, _count: { _all: 5 } },
      { glCodeId: "gl-asset", _sum: { amount: D("-100.00") }, _count: { _all: 1 } },
      { glCodeId: "gl-eq", _sum: { amount: D("250.00") }, _count: { _all: 2 } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: "gl-rev", code: "4000", name: "Revenue", type: "revenue" },
      { id: "gl-exp", code: "5000", name: "Expenses", type: "expense" },
      { id: "gl-asset", code: "1000", name: "Cash", type: "asset" },
      { id: "gl-eq", code: "3000", name: "Equity", type: "equity" },
    ]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.totalIncome.toNumber()).toBe(8000);
    expect(pl.totalExpenses.toNumber()).toBe(3000);
    expect(pl.netIncome.toNumber()).toBe(5000);
    expect(pl.excludedFromPL.transactionCount).toBe(3);
    expect(pl.excludedFromPL.netAmount.toString()).toBe("150");
    expect(pl.excludedFromPL.lines).toHaveLength(2);
  });

  it("preserves sign: a negative asset-coded sum stays negative (owner draw)", async () => {
    mockGroupBy.mockResolvedValue([
      { glCodeId: "gl-asset", _sum: { amount: D("-1200.00") }, _count: { _all: 1 } },
    ]);
    mockGlFind.mockResolvedValue([{ id: "gl-asset", code: "1000", name: "Cash", type: "asset" }]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.excludedFromPL.lines[0]!.total.toString()).toBe("-1200");
    expect(pl.excludedFromPL.netAmount.toString()).toBe("-1200");
  });

  it("nets opposite-signed codes in netAmount", async () => {
    mockGroupBy.mockResolvedValue([
      { glCodeId: "gl-a", _sum: { amount: D("3000.00") }, _count: { _all: 1 } },
      { glCodeId: "gl-b", _sum: { amount: D("-3000.00") }, _count: { _all: 1 } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: "gl-a", code: "1000", name: "Cash", type: "asset" },
      { id: "gl-b", code: "2000", name: "Loan", type: "liability" },
    ]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.excludedFromPL.netAmount.isZero()).toBe(true);
    expect(pl.excludedFromPL.transactionCount).toBe(2);
  });

  it("sums cents exactly with Decimal (0.10 + 0.20 = 0.30)", async () => {
    mockGroupBy.mockResolvedValue([
      { glCodeId: "gl-a", _sum: { amount: D("0.10") }, _count: { _all: 1 } },
      { glCodeId: "gl-b", _sum: { amount: D("0.20") }, _count: { _all: 1 } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: "gl-a", code: "1000", name: "Cash", type: "asset" },
      { id: "gl-b", code: "1010", name: "Savings", type: "asset" },
    ]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.excludedFromPL.netAmount.equals(D("0.30"))).toBe(true);
    expect(pl.excludedFromPL.netAmount.toString()).toBe("0.3");
  });

  it("sorts excluded lines by code", async () => {
    mockGroupBy.mockResolvedValue([
      { glCodeId: "gl-c", _sum: { amount: D("1.00") }, _count: { _all: 1 } },
      { glCodeId: "gl-a", _sum: { amount: D("1.00") }, _count: { _all: 1 } },
      { glCodeId: "gl-b", _sum: { amount: D("1.00") }, _count: { _all: 1 } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: "gl-c", code: "3000", name: "Equity", type: "equity" },
      { id: "gl-a", code: "1000", name: "Cash", type: "asset" },
      { id: "gl-b", code: "2000", name: "Loan", type: "liability" },
    ]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.excludedFromPL.lines.map((l) => l.code)).toEqual(["1000", "2000", "3000"]);
  });

  it("returns zeros and an empty array for an empty period", async () => {
    mockGroupBy.mockResolvedValue([]);
    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.excludedFromPL.lines).toEqual([]);
    expect(pl.excludedFromPL.transactionCount).toBe(0);
    expect(pl.excludedFromPL.netAmount.isZero()).toBe(true);
  });

  it("reports an unexpected type string (e.g. 'income') as excluded rather than dropping it silently", async () => {
    mockGroupBy.mockResolvedValue([
      { glCodeId: "gl-odd", _sum: { amount: D("700.00") }, _count: { _all: 1 } },
    ]);
    mockGlFind.mockResolvedValue([{ id: "gl-odd", code: "4999", name: "Legacy", type: "income" }]);

    const pl = await computePL(ENTITY_ID, FROM, TO);
    expect(pl.incomeLines).toHaveLength(0);
    expect(pl.totalIncome.toNumber()).toBe(0);
    expect(pl.excludedFromPL.transactionCount).toBe(1);
    expect(pl.excludedFromPL.lines[0]!.type).toBe("income");
  });

  it("queries only non-archived, non-transfer, GL-coded transactions and requests a count", async () => {
    mockGroupBy.mockResolvedValue([]);
    await computePL(ENTITY_ID, FROM, TO);

    const arg = mockGroupBy.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      _count: unknown;
    };
    expect(arg.where.entityId).toBe(ENTITY_ID);
    expect(arg.where.archivedAt).toBeNull();
    expect(arg.where.transferPairId).toBeNull();
    expect(arg.where.glCodeId).toEqual({ not: null });
    expect(arg._count).toEqual({ _all: true });
  });
});

describe("computeBalanceSheet", () => {
  it("sums checking/savings into assets with totalAssetsCents", async () => {
    mockAccFind.mockResolvedValue([
      { id: "acc-1", nickname: "Checking", mask: "0626", accountType: "checking", currentBalance: new Prisma.Decimal("12500.00") },
      { id: "acc-2", nickname: "Savings", mask: "3950", accountType: "savings", currentBalance: new Prisma.Decimal("7500.00") },
    ]);

    const bs = await computeBalanceSheet(ENTITY_ID);
    expect(bs.assets).toHaveLength(2);
    expect(bs.totalAssetsCents).toBe(2_000_000); // 12500 + 7500 = 20000 → 2000000 cents
  });

  it("excludes accounts with null currentBalance (filtered at DB level)", async () => {
    mockAccFind.mockResolvedValue([
      { id: "acc-1", nickname: "Checking", mask: "0001", accountType: "checking", currentBalance: new Prisma.Decimal("5000.00") },
    ]);

    const bs = await computeBalanceSheet(ENTITY_ID);
    expect(bs.assets).toHaveLength(1);
    expect(bs.totalAssetsCents).toBe(500_000); // 5000 → 500000 cents
  });
});
