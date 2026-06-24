import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

// ── Mock auth ─────────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

// ── Mock Prisma db ────────────────────────────────────────────────────────────
const mockDb = vi.hoisted(() => ({
  account: {
    findMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import { computeBalanceSheet } from "@/lib/reports";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeBalanceSheet", () => {
  it("places checking/savings in assets and credit_card/mortgage in liabilities, computes equity", async () => {
    mockDb.account.findMany.mockResolvedValue([
      { id: "1", nickname: "Primary Checking", mask: "1234", accountType: "checking", currentBalance: new Decimal("12500.00") },
      { id: "2", nickname: "HYSA", mask: "5678", accountType: "savings", currentBalance: new Decimal("8000.00") },
      { id: "3", nickname: "Capital One", mask: "9999", accountType: "credit_card", currentBalance: new Decimal("3200.00") },
      { id: "4", nickname: "PennyMac Mortgage", mask: "0001", accountType: "mortgage", currentBalance: new Decimal("380000.00") },
    ]);

    const result = await computeBalanceSheet("entity-1");

    // Assets: 12500 + 8000 = 20500 → 2050000 cents
    expect(result.totalAssetsCents).toBe(2_050_000);
    // Liabilities: 3200 + 380000 = 383200 → 38320000 cents
    expect(result.totalLiabilitiesCents).toBe(38_320_000);
    // Equity = assets - liabilities (negative)
    expect(result.equityCents).toBe(2_050_000 - 38_320_000);
    expect(result.assets).toHaveLength(2);
    expect(result.liabilities).toHaveLength(2);
    expect(result.assets.every((a) => !a.isLiability)).toBe(true);
    expect(result.liabilities.every((l) => l.isLiability)).toBe(true);
  });

  it("excludes accounts with null currentBalance (filtered by Prisma where clause)", async () => {
    // The where clause { currentBalance: { not: null } } filters at the DB level.
    // Simulate: only non-null rows returned.
    mockDb.account.findMany.mockResolvedValue([
      { id: "1", nickname: "Active Checking", mask: "1111", accountType: "checking", currentBalance: new Decimal("5000.00") },
    ]);

    const result = await computeBalanceSheet("entity-1");

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.label).toBe("Active Checking");
    expect(result.totalAssetsCents).toBe(500_000);
    expect(result.totalLiabilitiesCents).toBe(0);
  });

  it("returns all zeros and empty arrays when entity has no linked accounts", async () => {
    mockDb.account.findMany.mockResolvedValue([]);

    const result = await computeBalanceSheet("entity-empty");

    expect(result.assets).toHaveLength(0);
    expect(result.liabilities).toHaveLength(0);
    expect(result.totalAssetsCents).toBe(0);
    expect(result.totalLiabilitiesCents).toBe(0);
    expect(result.equityCents).toBe(0);
    expect(result.asOfDate).toBeInstanceOf(Date);
  });
});
