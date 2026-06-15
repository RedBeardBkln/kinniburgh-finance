import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock auth ─────────────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

// ── Mock next/cache ───────────────────────────────────────────────────────────
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── Mock Prisma db ────────────────────────────────────────────────────────────
const mockDb = vi.hoisted(() => ({
  account: {
    findMany: vi.fn(),
  },
  manualAsset: {
    findMany: vi.fn(),
  },
  insurancePolicy: {
    findMany: vi.fn(),
  },
  netWorthSnapshot: {
    upsert: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import { computeNetWorth, snapshotNetWorth } from "@/actions/net-worth";
import { Decimal } from "@prisma/client/runtime/library";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.manualAsset.findMany.mockResolvedValue([]);
  mockDb.insurancePolicy.findMany.mockResolvedValue([]);
  mockDb.netWorthSnapshot.upsert.mockResolvedValue({});
});

describe("computeNetWorth", () => {
  it("aggregates asset accounts vs liability accounts correctly", async () => {
    mockDb.account.findMany.mockResolvedValue([
      { id: "1", nickname: "Primary Checking", accountType: "checking", currentBalance: new Decimal("12500.00") },
      { id: "2", nickname: "Savings", accountType: "savings", currentBalance: new Decimal("8000.00") },
      { id: "3", nickname: "PennyMac Mortgage", accountType: "mortgage", currentBalance: new Decimal("380000.00") },
    ]);

    const result = await computeNetWorth();

    expect(result.totalAssetsCents).toBe(2_050_000); // 12500 + 8000 = 20500 → 2050000 cents
    expect(result.totalLiabilitiesCents).toBe(38_000_000); // 380000 → 38000000 cents
    expect(result.netWorthCents).toBe(2_050_000 - 38_000_000); // negative
  });

  it("treats credit_card and loan balances as liabilities, investment as asset", async () => {
    mockDb.account.findMany.mockResolvedValue([
      { id: "1", nickname: "Betterment IRA", accountType: "investment", currentBalance: new Decimal("45000.00") },
      { id: "2", nickname: "Capital One", accountType: "credit_card", currentBalance: new Decimal("3200.00") },
      { id: "3", nickname: "Solar Loan", accountType: "loan", currentBalance: new Decimal("41000.00") },
    ]);

    const result = await computeNetWorth();

    expect(result.accounts.find((a) => a.accountType === "investment")?.isLiability).toBe(false);
    expect(result.accounts.find((a) => a.accountType === "credit_card")?.isLiability).toBe(true);
    expect(result.accounts.find((a) => a.accountType === "loan")?.isLiability).toBe(true);
    expect(result.totalAssetsCents).toBe(4_500_000);
    expect(result.totalLiabilitiesCents).toBe(3_200 * 100 + 41_000 * 100);
  });

  it("includes manual assets and insurance cash values in total assets", async () => {
    mockDb.account.findMany.mockResolvedValue([
      { id: "1", nickname: "Checking", accountType: "checking", currentBalance: new Decimal("5000.00") },
    ]);
    mockDb.manualAsset.findMany.mockResolvedValue([
      { name: "Sudden Valley property", category: "real_estate", valueCents: 45_000_000 },
    ]);
    mockDb.insurancePolicy.findMany.mockResolvedValue([
      {
        id: "pol-1",
        insurer: "Northwestern Mutual",
        policyType: "whole",
        cashValueEntries: [{ cashValueCents: 2_500_000, asOf: new Date() }],
      },
    ]);

    const result = await computeNetWorth();

    // checking 5000 + property 450000 + cash value 25000 = 480000 → 48000000 cents
    expect(result.totalAssetsCents).toBe(500_000 + 45_000_000 + 2_500_000);
    expect(result.manualAssets).toHaveLength(1);
    expect(result.cashValues).toHaveLength(1);
    expect(result.cashValues[0]?.cashValueCents).toBe(2_500_000);
  });

  it("excludes accounts with null balance and lists them in missingBalances", async () => {
    mockDb.account.findMany.mockResolvedValue([
      { id: "1", nickname: "Checking", accountType: "checking", currentBalance: new Decimal("1000.00") },
      { id: "2", nickname: "Old Account", accountType: "savings", currentBalance: null },
    ]);

    const result = await computeNetWorth();

    expect(result.missingBalances).toContain("Old Account");
    expect(result.accounts).toHaveLength(1);
  });
});

describe("snapshotNetWorth", () => {
  it("upserts a snapshot for today and returns the net worth breakdown", async () => {
    mockDb.account.findMany.mockResolvedValue([
      { id: "1", nickname: "Checking", accountType: "checking", currentBalance: new Decimal("10000.00") },
    ]);

    const result = await snapshotNetWorth();

    expect(mockDb.netWorthSnapshot.upsert).toHaveBeenCalledOnce();
    const call = mockDb.netWorthSnapshot.upsert.mock.calls[0]![0] as {
      where: { date: Date };
      create: { totalAssetsCents: number };
      update: { totalAssetsCents: number };
    };
    expect(call.where.date).toBeInstanceOf(Date);
    expect(call.create.totalAssetsCents).toBe(1_000_000);
    expect(call.update.totalAssetsCents).toBe(1_000_000);
    expect(result.totalAssetsCents).toBe(1_000_000);
  });
});
