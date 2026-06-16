import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  incomeSource: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

import { createIncomeSource, toggleIncomeSource } from "@/actions/income-sources";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createIncomeSource", () => {
  it("returns error when semi_monthly cadence is given biweekly-style dayRules", async () => {
    const result = await createIncomeSource({
      entityId: "entity-1",
      accountId: "account-1",
      description: "Eric payroll",
      cadence: "semi_monthly",
      amount: "5500.00",
      // biweekly-style rules — wrong for semi_monthly
      dayRules: { intervalDays: 14, anchorDate: "2026-01-01" },
    });

    expect(result).toMatchObject({ error: expect.stringContaining("semi_monthly") });
    expect(mockDb.incomeSource.create).not.toHaveBeenCalled();
  });

  it("creates income source when semi_monthly cadence has correct dayRules", async () => {
    mockDb.incomeSource.create.mockResolvedValue({ id: "new-id" });

    const result = await createIncomeSource({
      entityId: "entity-1",
      accountId: "account-1",
      description: "Eric payroll",
      cadence: "semi_monthly",
      amount: "5500.00",
      dayRules: { daysOfMonth: [15, 30] },
    });

    expect(result).toMatchObject({ success: true, id: "new-id" });
    expect(mockDb.incomeSource.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cadence: "semi_monthly",
          dayRules: { daysOfMonth: [15, 30] },
          amount: "5500.00",
          active: true,
        }),
      })
    );
  });
});

describe("toggleIncomeSource", () => {
  it("calls update with the correct active flag", async () => {
    mockDb.incomeSource.update.mockResolvedValue({});

    await toggleIncomeSource("source-1", false);

    expect(mockDb.incomeSource.update).toHaveBeenCalledWith({
      where: { id: "source-1" },
      data: { active: false },
    });
  });
});
