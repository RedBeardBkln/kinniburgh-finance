import { describe, it, expect, vi, beforeEach } from "vitest";

// Action-level tests (mocked at the db/auth boundary) proving eligibility is
// enforced SERVER-SIDE in actions/review-assignments.ts, not only in the UI.

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockDb = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    reviewBatch: { findFirst: vi.fn(), create: vi.fn() },
    // findMany is the in-lock "already assigned" check (Phase 2: moved inside the transaction).
    transactionAssignment: { upsert: vi.fn(), findMany: vi.fn() },
  };
  return {
    entity: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() },
    transactionAssignment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    _tx: tx,
  };
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  assignTransactions,
  unassignTransaction,
  getDraftBatchSummary,
} from "@/actions/review-assignments";

const ERIC = "11111111-1111-4111-8111-111111111111";
const EVA = "22222222-2222-4222-8222-222222222222";
const PERSONAL = "e0000000-0000-4000-8000-000000000001";
const SV = "e0000000-0000-4000-8000-000000000002";
const EKC = "e0000000-0000-4000-8000-000000000003";
const MEZZO = "e0000000-0000-4000-8000-000000000004";

const T1 = "a0000000-0000-4000-8000-000000000001";
const T2 = "a0000000-0000-4000-8000-000000000002";
const T3 = "a0000000-0000-4000-8000-000000000003";
const T4 = "a0000000-0000-4000-8000-000000000004";
const T5 = "a0000000-0000-4000-8000-000000000005";

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    entityId: PERSONAL,
    archivedAt: null,
    transferPairId: null,
    pending: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: ERIC } });
  // The entity query is filtered to the assignable slugs by the implementation;
  // the mock simply returns what a correct DB would: only Personal + Sudden Valley.
  mockDb.entity.findMany.mockResolvedValue([{ id: PERSONAL }, { id: SV }]);
  mockDb.user.findMany.mockResolvedValue([
    { id: ERIC, name: "Eric" },
    { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" },
  ]);
  mockDb._tx.$executeRaw.mockResolvedValue(1);
  mockDb._tx.transactionAssignment.findMany.mockResolvedValue([]);
  mockDb._tx.reviewBatch.findFirst.mockResolvedValue(null);
  mockDb._tx.reviewBatch.create.mockResolvedValue({ id: "batch-1" });
  mockDb._tx.transactionAssignment.upsert.mockResolvedValue({});
});

describe("assign actions require auth first", () => {
  it("assignTransactions rejects without a session and touches no DB", async () => {
    authMock.mockResolvedValue(null);
    await expect(assignTransactions([T1])).rejects.toThrow("Unauthorized");
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
  it("unassignTransaction rejects without a session", async () => {
    authMock.mockResolvedValue({ user: {} });
    await expect(unassignTransaction(T1)).rejects.toThrow("Unauthorized");
    expect(mockDb.transactionAssignment.findFirst).not.toHaveBeenCalled();
  });
  it("getDraftBatchSummary rejects without a session", async () => {
    authMock.mockResolvedValue(null);
    await expect(getDraftBatchSummary()).rejects.toThrow("Unauthorized");
  });
});

describe("assignTransactions server-side eligibility", () => {
  it("rejects EK Consulting and Mezzo transactions and creates no rows", async () => {
    mockDb.transaction.findMany.mockResolvedValue([
      row(T1, { entityId: EKC }),
      row(T2, { entityId: MEZZO }),
    ]);
    const res = await assignTransactions([T1, T2]);
    expect(res).toMatchObject({ ok: true, assigned: [] });
    if (!res.ok) throw new Error("unexpected");
    expect(res.rejected.map((r) => r.reason)).toEqual(["wrong_entity", "wrong_entity"]);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb._tx.transactionAssignment.upsert).not.toHaveBeenCalled();
    expect(mockDb._tx.reviewBatch.create).not.toHaveBeenCalled();
  });

  it("rejects transfer / pending / already-assigned / not-found (archived filtered by query) and assigns only the eligible one", async () => {
    // T5 is absent from findMany (archived rows are excluded by archivedAt: null)
    mockDb.transaction.findMany.mockResolvedValue([
      row(T1),
      row(T2, { transferPairId: "pair-1" }),
      row(T3, { pending: true }),
      row(T4),
    ]);
    mockDb._tx.transactionAssignment.findMany.mockResolvedValue([{ transactionId: T4 }]);
    const res = await assignTransactions([T1, T2, T3, T4, T5]);
    if (!res.ok) throw new Error("unexpected");
    expect(res.assigned).toEqual([T1]);
    expect(Object.fromEntries(res.rejected.map((r) => [r.transactionId, r.reason]))).toEqual({
      [T2]: "transfer_leg",
      [T3]: "pending",
      [T4]: "already_assigned",
      [T5]: "not_found",
    });
    expect(mockDb._tx.transactionAssignment.upsert).toHaveBeenCalledTimes(1);
    expect(mockDb._tx.transactionAssignment.upsert.mock.calls[0]![0].create).toMatchObject({
      transactionId: T1,
      status: "pending",
    });
  });

  it("queries transactions with archivedAt: null and active-assignment lookup restricted to draft/submitted batches", async () => {
    mockDb.transaction.findMany.mockResolvedValue([row(T1)]);
    await assignTransactions([T1]);
    expect(mockDb.transaction.findMany.mock.calls[0]![0].where).toMatchObject({ archivedAt: null });
    expect(mockDb._tx.transactionAssignment.findMany.mock.calls[0]![0].where).toMatchObject({
      status: "pending",
      batch: { status: { in: ["draft", "submitted"] } },
    });
  });

  it("takes the (creator, assignee) advisory lock BEFORE the in-transaction already-assigned check and any write", async () => {
    mockDb.transaction.findMany.mockResolvedValue([row(T1)]);
    const order: string[] = [];
    mockDb._tx.$executeRaw.mockImplementation(async () => {
      order.push("lock");
      return 1;
    });
    mockDb._tx.transactionAssignment.findMany.mockImplementation(async () => {
      order.push("active-check");
      return [];
    });
    mockDb._tx.reviewBatch.findFirst.mockImplementation(async () => {
      order.push("find-draft");
      return null;
    });
    mockDb._tx.transactionAssignment.upsert.mockImplementation(async () => {
      order.push("upsert");
      return {};
    });
    await assignTransactions([T1]);
    expect(order).toEqual(["lock", "active-check", "find-draft", "upsert"]);
    // The lock key is derived from the (creator, assignee) pair.
    const [strings, key] = mockDb._tx.$executeRaw.mock.calls[0]!;
    expect((strings as readonly string[]).join("?")).toContain("pg_advisory_xact_lock");
    expect(key).toBe(`review-assign:${ERIC}:${EVA}`);
  });

  it("when every candidate is already assigned (found in-lock) it creates no draft batch and reports already_assigned", async () => {
    mockDb.transaction.findMany.mockResolvedValue([row(T1)]);
    mockDb._tx.transactionAssignment.findMany.mockResolvedValue([{ transactionId: T1 }]);
    const res = await assignTransactions([T1]);
    if (!res.ok) throw new Error("unexpected");
    expect(res.assigned).toEqual([]);
    expect(res.rejected).toEqual([
      expect.objectContaining({ transactionId: T1, reason: "already_assigned" }),
    ]);
    expect(mockDb._tx.reviewBatch.create).not.toHaveBeenCalled();
    expect(mockDb._tx.transactionAssignment.upsert).not.toHaveBeenCalled();
  });

  it("fails closed when no assignable entities resolve", async () => {
    mockDb.entity.findMany.mockResolvedValue([]);
    mockDb.transaction.findMany.mockResolvedValue([row(T1)]);
    const res = await assignTransactions([T1]);
    if (!res.ok) throw new Error("unexpected");
    expect(res.assigned).toEqual([]);
    expect(res.rejected[0]!.reason).toBe("wrong_entity");
  });

  it("dedupes ids so a duplicated id is processed once", async () => {
    mockDb.transaction.findMany.mockResolvedValue([row(T1)]);
    const res = await assignTransactions([T1, T1, T1]);
    if (!res.ok) throw new Error("unexpected");
    expect(res.assigned).toEqual([T1]);
    expect(mockDb._tx.transactionAssignment.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed ids, empty and oversized input before any DB access", async () => {
    expect((await assignTransactions(["not-a-uuid"])).ok).toBe(false);
    expect((await assignTransactions([])).ok).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) =>
      `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );
    expect((await assignTransactions(many)).ok).toBe(false);
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
  });

  it("refuses to guess when there is no single other household user", async () => {
    mockDb.user.findMany.mockResolvedValue([{ id: ERIC, name: "Eric" }]);
    expect((await assignTransactions([T1])).ok).toBe(false);
    mockDb.user.findMany.mockResolvedValue([
      { id: ERIC, name: "Eric" },
      { id: EVA, name: "Eva" },
      { id: "33333333-3333-4333-8333-333333333333", name: "Other" },
    ]);
    expect((await assignTransactions([T1])).ok).toBe(false);
    expect(mockDb.transaction.findMany).not.toHaveBeenCalled();
  });

  it("reuses the caller's existing draft batch instead of creating a second", async () => {
    mockDb.transaction.findMany.mockResolvedValue([row(T1)]);
    mockDb._tx.reviewBatch.findFirst.mockResolvedValue({ id: "existing-draft" });
    await assignTransactions([T1]);
    expect(mockDb._tx.reviewBatch.create).not.toHaveBeenCalled();
    expect(mockDb._tx.transactionAssignment.upsert.mock.calls[0]![0].create.batchId).toBe(
      "existing-draft"
    );
  });
});

describe("unassignTransaction scoping", () => {
  it("only looks for pending assignments in the caller's own DRAFT batch", async () => {
    mockDb.transactionAssignment.findFirst.mockResolvedValue(null);
    const res = await unassignTransaction(T1);
    expect(res.ok).toBe(false);
    expect(mockDb.transactionAssignment.findFirst.mock.calls[0]![0].where).toMatchObject({
      transactionId: T1,
      status: "pending",
      batch: { createdByUserId: ERIC, status: "draft" },
    });
    expect(mockDb.transactionAssignment.updateMany).not.toHaveBeenCalled();
  });

  it("marks the matched assignment removed", async () => {
    mockDb.transactionAssignment.findFirst.mockResolvedValue({ id: "asg-1" });
    mockDb.transactionAssignment.updateMany.mockResolvedValue({ count: 1 });
    expect(await unassignTransaction(T1)).toEqual({ ok: true });
    expect(mockDb.transactionAssignment.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: "asg-1", status: "pending" },
      data: { status: "removed" },
    });
  });

  it("reports a lost race (count 0) as an error", async () => {
    mockDb.transactionAssignment.findFirst.mockResolvedValue({ id: "asg-1" });
    mockDb.transactionAssignment.updateMany.mockResolvedValue({ count: 0 });
    expect((await unassignTransaction(T1)).ok).toBe(false);
  });

  it("rejects a malformed id", async () => {
    expect((await unassignTransaction("nope")).ok).toBe(false);
    expect(mockDb.transactionAssignment.findFirst).not.toHaveBeenCalled();
  });
});
