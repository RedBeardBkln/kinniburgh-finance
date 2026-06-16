import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mockDb = vi.hoisted(() => ({
  transaction: {
    findMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import { computeSavingsRecommendation } from "@/lib/savings-autopilot";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function tx(postedAt: Date, amount: string) {
  return { postedAt, amount: new Prisma.Decimal(amount) };
}

describe("computeSavingsRecommendation", () => {
  it("recommends 20% of average monthly surplus across 3 months", async () => {
    // 3 months of data: income $5000/mo, expenses $4000/mo → surplus $1000/mo
    mockDb.transaction.findMany.mockResolvedValue([
      // April
      tx(makeDate(2026, 4, 5), "5000.00"),
      tx(makeDate(2026, 4, 15), "-4000.00"),
      // May
      tx(makeDate(2026, 5, 5), "5000.00"),
      tx(makeDate(2026, 5, 15), "-4000.00"),
      // June
      tx(makeDate(2026, 6, 5), "5000.00"),
      tx(makeDate(2026, 6, 15), "-4000.00"),
    ]);

    const result = await computeSavingsRecommendation("entity-1");

    expect(result.monthsOfData).toBe(3);
    expect(result.hasEnoughData).toBe(true);
    expect(result.avgMonthlyIncomeCents).toBe(500_000);   // $5000
    expect(result.avgMonthlyExpensesCents).toBe(400_000); // $4000
    expect(result.avgMonthlySurplusCents).toBe(100_000);  // $1000
    // 20% of $1000 = $200 → 20000 cents
    expect(result.recommendedMonthlyCents).toBe(20_000);
  });

  it("sets hasEnoughData to false when all transactions fall in a single calendar month", async () => {
    mockDb.transaction.findMany.mockResolvedValue([
      tx(makeDate(2026, 6, 1), "3000.00"),
      tx(makeDate(2026, 6, 10), "-2000.00"),
      tx(makeDate(2026, 6, 20), "-500.00"),
    ]);

    const result = await computeSavingsRecommendation("entity-1");

    expect(result.monthsOfData).toBe(1);
    expect(result.hasEnoughData).toBe(false);
  });

  it("recommends 0 when average monthly expenses exceed income", async () => {
    // Spending more than earning
    mockDb.transaction.findMany.mockResolvedValue([
      tx(makeDate(2026, 4, 5), "3000.00"),
      tx(makeDate(2026, 4, 15), "-5000.00"),
      tx(makeDate(2026, 5, 5), "3000.00"),
      tx(makeDate(2026, 5, 15), "-5000.00"),
    ]);

    const result = await computeSavingsRecommendation("entity-1");

    expect(result.monthsOfData).toBe(2);
    expect(result.hasEnoughData).toBe(true);
    expect(result.avgMonthlySurplusCents).toBeLessThan(0);
    expect(result.recommendedMonthlyCents).toBe(0);
  });
});
