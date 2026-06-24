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
      { glCodeId: glId, _sum: { amount: new Prisma.Decimal("5000.00") } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: glId, code: "4000", name: "Consulting Revenue", type: "income" },
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
      { glCodeId: glId, _sum: { amount: new Prisma.Decimal("-1200.00") } },
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
      { glCodeId: glIncome, _sum: { amount: new Prisma.Decimal("8000.00") } },
      { glCodeId: glExp, _sum: { amount: new Prisma.Decimal("-3000.00") } },
    ]);
    mockGlFind.mockResolvedValue([
      { id: glIncome, code: "4000", name: "Revenue", type: "income" },
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
      { glCodeId: glAsset, _sum: { amount: new Prisma.Decimal("10000.00") } },
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
