import { beforeEach, describe, expect, it, vi } from "vitest";

// Moving a recurring expense to another budget line: auth first, validated ids, the tag must exist, and ONLY `tagId`
// is written (so the hidden [pattern:<key>] marker in notes survives and the series stays "already recorded").

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockDb = vi.hoisted(() => ({
  recurringExpense: { findUnique: vi.fn(), update: vi.fn() },
  tag: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { moveRecurringExpenseToTag } from "@/actions/recurring-expenses";

const EXPENSE = "11111111-1111-4111-8111-111111111111";
const TAG_OLD = "33333333-3333-4333-8333-333333333333";
const TAG_NEW = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u1" } });
  mockDb.recurringExpense.findUnique.mockResolvedValue({ id: EXPENSE, tagId: TAG_OLD });
  mockDb.tag.findUnique.mockResolvedValue({ id: TAG_NEW });
  mockDb.recurringExpense.update.mockResolvedValue({});
});

describe("moveRecurringExpenseToTag", () => {
  it("refuses without a session before reading anything", async () => {
    authMock.mockResolvedValue(null);
    await expect(moveRecurringExpenseToTag({ id: EXPENSE, tagId: TAG_NEW })).rejects.toThrow("Unauthorized");
    expect(mockDb.recurringExpense.findUnique).not.toHaveBeenCalled();
  });

  it("writes only tagId", async () => {
    const res = await moveRecurringExpenseToTag({ id: EXPENSE, tagId: TAG_NEW });
    expect(res).toEqual({ success: true });
    expect(mockDb.recurringExpense.update).toHaveBeenCalledWith({ where: { id: EXPENSE }, data: { tagId: TAG_NEW } });
  });

  it("can unlink (no budget line) without a tag lookup", async () => {
    const res = await moveRecurringExpenseToTag({ id: EXPENSE, tagId: null });
    expect(res).toEqual({ success: true });
    expect(mockDb.tag.findUnique).not.toHaveBeenCalled();
    expect(mockDb.recurringExpense.update).toHaveBeenCalledWith({ where: { id: EXPENSE }, data: { tagId: null } });
  });

  it("refuses a tag that does not exist", async () => {
    mockDb.tag.findUnique.mockResolvedValue(null);
    const res = await moveRecurringExpenseToTag({ id: EXPENSE, tagId: TAG_NEW });
    expect(res).toHaveProperty("error");
    expect(mockDb.recurringExpense.update).not.toHaveBeenCalled();
  });

  it("refuses a missing expense", async () => {
    mockDb.recurringExpense.findUnique.mockResolvedValue(null);
    const res = await moveRecurringExpenseToTag({ id: EXPENSE, tagId: TAG_NEW });
    expect(res).toHaveProperty("error");
    expect(mockDb.recurringExpense.update).not.toHaveBeenCalled();
  });

  it("refuses non-uuid ids", async () => {
    const res = await moveRecurringExpenseToTag({ id: "x", tagId: "y" });
    expect(res).toHaveProperty("error");
    expect(mockDb.recurringExpense.findUnique).not.toHaveBeenCalled();
  });

  it("is a no-op when the line is unchanged", async () => {
    const res = await moveRecurringExpenseToTag({ id: EXPENSE, tagId: TAG_OLD });
    expect(res).toEqual({ success: true });
    expect(mockDb.recurringExpense.update).not.toHaveBeenCalled();
  });
});
