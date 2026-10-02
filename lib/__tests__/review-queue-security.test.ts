import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { NextRequest } from "next/server";

// Tester-added (Phase 2 independent verification) adversarial tests for the
// public, token-gated review-queue surface. Mocked at the db boundary; the real
// token validation, queue loading and token-gated actions run.
//
// Covers things the Coder's tests asserted only indirectly:
//   - what the public page actually READS and hands to the client (field whitelist)
//   - cross-batch isolation behaviourally (a fake assignment table, not just a
//     "where clause contains batchId" assertion)
//   - client-smuggled keys (approveConflicts, userId/changedBy) are ignored
//   - middleware look-alike / encoded / case-variant paths

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The page returns <QueueClient .../>; stub it so we can inspect the exact props
// the (unauthenticated) client receives.
vi.mock("@/components/review-queue/queue-client", () => ({ QueueClient: () => null }));

type Row = {
  id: string;
  batchId: string;
  status: string;
  transactionId: string;
  transaction: Record<string, unknown>;
};

const mockDb = vi.hoisted(() => {
  const tx = {
    transactionAssignment: { updateMany: vi.fn() },
    reviewBatch: { updateMany: vi.fn() },
    reviewLinkToken: { updateMany: vi.fn() },
  };
  return {
    entity: { findMany: vi.fn() },
    reviewLinkToken: { findUnique: vi.fn() },
    reviewBatch: { updateMany: vi.fn(), findUnique: vi.fn() },
    transactionAssignment: { findMany: vi.fn(), updateMany: vi.fn() },
    transaction: { findUnique: vi.fn(), findMany: vi.fn() },
    transactionTag: { createMany: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
    tag: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    tagRule: { findMany: vi.fn(), create: vi.fn() },
    tagGlCodeMapping: { findMany: vi.fn() },
    $transaction: vi.fn(),
    _tx: tx,
  };
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { generateReviewToken } from "@/lib/review-token";
import { saveQueue, returnToEric } from "@/actions/review-queue";
import QueuePage from "@/app/queue/[token]/page";
import { middleware } from "@/middleware";

// vitest compiles JSX with the classic runtime, so the page under test needs a global React.
(globalThis as unknown as { React: typeof React }).React = React;

const EVA = "22222222-2222-4222-8222-222222222222";
const PERSONAL = "e0000000-0000-4000-8000-000000000001";
const EKC = "e0000000-0000-4000-8000-000000000003";
const BATCH_A = "b0000000-0000-4000-8000-00000000000a";
const BATCH_B = "b0000000-0000-4000-8000-00000000000b";
const T_A = "a0000000-0000-4000-8000-0000000000aa";
const T_B = "a0000000-0000-4000-8000-0000000000bb";
const T_EKC = "a0000000-0000-4000-8000-0000000000ec";
const TAG1 = "c0000000-0000-4000-8000-000000000001";
const TAG2 = "c0000000-0000-4000-8000-000000000002";

function txBody(id: string, entityId: string) {
  return {
    id,
    postedAt: new Date("2026-09-20T12:00:00Z"),
    payeeRaw: "Shell Oil 123",
    payeeNormalized: "shell oil 123",
    amount: "-40.00",
    accountId: "acct-1",
    account: { nickname: "Checking", mask: "1234" },
    entity: { navLabel: "Personal", name: "Personal" },
    entityId,
    archivedAt: null,
    transferPairId: null,
    _count: { tags: 0 },
  };
}

let TOKEN_A = "";
let table: Row[] = [];

function liveTokenRow(batchId: string) {
  return {
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    batch: {
      id: batchId,
      status: "submitted",
      expiresAt: new Date(Date.now() + 3_600_000),
      assigneeUserId: EVA,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockDb.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (t: typeof mockDb._tx) => Promise<unknown>)(mockDb._tx)
      : Promise.all(arg as unknown[])
  );
  TOKEN_A = generateReviewToken().token;
  mockDb.reviewLinkToken.findUnique.mockResolvedValue(liveTokenRow(BATCH_A));
  mockDb.entity.findMany.mockResolvedValue([{ id: PERSONAL }]); // EKC is NOT assignable
  mockDb.tag.findMany.mockResolvedValue([{ id: TAG1 }, { id: TAG2 }]);
  mockDb.transactionAssignment.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.transactionAssignment.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.reviewBatch.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.reviewLinkToken.updateMany.mockResolvedValue({ count: 1 });
  mockDb.transactionTag.createMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.tagGlCodeMapping.findMany.mockResolvedValue([]);
  mockDb.transaction.findMany.mockResolvedValue([]);
  mockDb.tagRule.findMany.mockResolvedValue([]);
  mockDb.tagRule.create.mockResolvedValue({ id: "rule-1" });
  mockDb.transaction.findUnique.mockImplementation(async (a: { where: { id: string } }) => ({
    id: a.where.id,
    entityId: PERSONAL,
    archivedAt: null,
    tags: [],
  }));

  // A fake assignment table that actually honours batchId / status / id-in, so
  // cross-batch isolation is proven behaviourally.
  table = [
    { id: "asg-a", batchId: BATCH_A, status: "pending", transactionId: T_A, transaction: txBody(T_A, PERSONAL) },
    { id: "asg-b", batchId: BATCH_B, status: "pending", transactionId: T_B, transaction: txBody(T_B, PERSONAL) },
    { id: "asg-ekc", batchId: BATCH_A, status: "pending", transactionId: T_EKC, transaction: txBody(T_EKC, EKC) },
  ];
  mockDb.transactionAssignment.findMany.mockImplementation(
    async (args: {
      where: { batchId?: string; status?: string; transactionId?: { in: string[] } };
    }) =>
      table.filter(
        (r) =>
          (args.where.batchId === undefined || r.batchId === args.where.batchId) &&
          (args.where.status === undefined || r.status === args.where.status) &&
          (args.where.transactionId === undefined || args.where.transactionId.in.includes(r.transactionId))
      )
  );
});

describe("cross-batch / cross-entity isolation (behavioural)", () => {
  it("a token for batch A cannot tag, read or resolve a transaction that belongs to batch B", async () => {
    const res = await saveQueue(TOKEN_A, { items: [{ transactionId: T_B, tagId: TAG1 }] });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results).toEqual([{ transactionId: T_B, status: "not_in_queue", rule: "none" }]);
    expect(mockDb.transaction.findUnique).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
  });

  it("a hand-inserted EK Consulting assignment inside batch A is never written through the token", async () => {
    const res = await saveQueue(TOKEN_A, { items: [{ transactionId: T_EKC, tagId: TAG1 }] });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results[0]).toMatchObject({ transactionId: T_EKC, status: "not_in_queue" });
    expect(mockDb.transaction.findUnique).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("a mixed request tags only the item in this batch; foreign ids are reported not_in_queue", async () => {
    const res = await saveQueue(TOKEN_A, {
      items: [
        { transactionId: T_B, tagId: TAG1 },
        { transactionId: T_A, tagId: TAG1 },
        { transactionId: T_EKC, tagId: TAG1 },
      ],
    });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results.map((r) => [r.transactionId, r.status])).toEqual([
      [T_B, "not_in_queue"],
      [T_A, "saved"],
      [T_EKC, "not_in_queue"],
    ]);
    // Exactly one transaction was written, and it is the one in batch A.
    expect(mockDb.transactionTag.createMany).toHaveBeenCalledTimes(1);
    expect(mockDb.transactionTag.createMany.mock.calls[0]![0].data).toEqual([
      { transactionId: T_A, tagId: TAG1 },
    ]);
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockDb.auditLog.create.mock.calls[0]![0].data.changedBy).toBe(EVA);
  });

  it("returnToEric cannot return another batch's item (updateMany is scoped by batchId and matched nothing)", async () => {
    mockDb.transactionAssignment.updateMany.mockImplementation(
      async (args: { where: { batchId: string; transactionId: string; status: string } }) => ({
        count: table.filter(
          (r) =>
            r.batchId === args.where.batchId &&
            r.transactionId === args.where.transactionId &&
            r.status === args.where.status
        ).length,
      })
    );
    const res = await returnToEric(TOKEN_A, T_B);
    expect(res.ok).toBe(false);
    expect(mockDb._tx.reviewBatch.updateMany).not.toHaveBeenCalled(); // did not close/touch the batch
  });
});

describe("client-smuggled keys are ignored", () => {
  it("approveConflicts in a rule payload cannot override a conflicting rule", async () => {
    mockDb.tagRule.findMany.mockResolvedValue([
      { id: "r-old", payeePattern: "shell oil", tagId: TAG2, amountMin: null, amountMax: null, accountId: null, accountIds: null },
    ]);
    mockDb.tag.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id, name: "Gas" }))
    );
    const res = await saveQueue(TOKEN_A, {
      items: [
        {
          transactionId: T_A,
          tagId: TAG1,
          // Runtime-only smuggling (not in the declared input type).
          rule: { payeePattern: "shell oil", approveConflicts: true } as unknown as { payeePattern: string },
        },
      ],
    });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results[0]).toMatchObject({ status: "saved", rule: "skipped_conflict" });
    expect(mockDb.tagRule.create).not.toHaveBeenCalled();
  });

  it("a client-supplied userId / changedBy / amountMin / accountId never reaches the audit row or the rule", async () => {
    const res = await saveQueue(TOKEN_A, {
      items: [
        {
          transactionId: T_A,
          tagId: TAG1,
          userId: "11111111-1111-4111-8111-111111111111",
          changedBy: "11111111-1111-4111-8111-111111111111",
          rule: { payeePattern: "shell oil", accountId: "acct-x", amountMin: "1", approveConflicts: true },
        } as unknown as { transactionId: string; tagId: string },
      ],
    });
    if (!res.ok) throw new Error("unexpected");
    expect(mockDb.auditLog.create.mock.calls[0]![0].data.changedBy).toBe(EVA);
    expect(mockDb.tagRule.create.mock.calls[0]![0].data).toMatchObject({
      accountId: null,
      amountMin: null,
      amountMax: null,
    });
  });
});

describe("the public page: what it reads and what the client receives", () => {
  function leafPaths(sel: Record<string, unknown>, prefix = ""): string[] {
    return Object.entries(sel).flatMap(([k, v]) =>
      v === true
        ? [prefix + k]
        : typeof v === "object" && v !== null
          ? leafPaths(((v as { select?: Record<string, unknown> }).select ?? v) as Record<string, unknown>, prefix + k + ".")
          : []
    );
  }

  it("an invalid token renders the generic screen and reads nothing but the token row", async () => {
    mockDb.reviewLinkToken.findUnique.mockResolvedValue(null);
    const el = (await QueuePage({ params: Promise.resolve({ token: TOKEN_A }) })) as { type: unknown; props: Record<string, unknown> };
    expect((el.type as { name: string }).name).toBe("InvalidLink");
    expect(mockDb.transactionAssignment.findMany).not.toHaveBeenCalled();
    expect(mockDb.tag.findMany).not.toHaveBeenCalled();
    expect(mockDb.reviewBatch.findUnique).not.toHaveBeenCalled();
    expect(mockDb.entity.findMany).not.toHaveBeenCalled();
  });

  it("a malformed token string never reaches the DB", async () => {
    await QueuePage({ params: Promise.resolve({ token: "../../transactions" }) });
    await QueuePage({ params: Promise.resolve({ token: "' OR 1=1 --" }) });
    expect(mockDb.reviewLinkToken.findUnique).not.toHaveBeenCalled();
  });

  it("a valid token reads only the whitelisted transaction/account/entity fields, scoped to its own batch", async () => {
    mockDb.tag.findMany.mockResolvedValue([{ id: TAG1, name: "Gas", shortName: "Gas", parentId: null }]);
    mockDb.reviewBatch.findUnique.mockResolvedValue({
      assignee: { name: "Eva-Laura Ramirez-Wisiackas" },
      createdBy: { name: "Eric Kinniburgh" },
    });

    const el = (await QueuePage({ params: Promise.resolve({ token: TOKEN_A }) })) as {
      props: { token: string; items: Array<Record<string, unknown>>; tags: unknown[]; assigneeName: string; senderName: string };
    };

    // Query shape: only this batch's pending assignments.
    const call = mockDb.transactionAssignment.findMany.mock.calls[0]![0];
    expect(call.where).toEqual({ batchId: BATCH_A, status: "pending" });
    expect(leafPaths(call.select).sort()).toEqual(
      [
        "id",
        "status",
        "transaction.id",
        "transaction.postedAt",
        "transaction.payeeRaw",
        "transaction.payeeNormalized",
        "transaction.amount",
        "transaction.accountId",
        "transaction.entityId",
        "transaction.archivedAt",
        "transaction.transferPairId",
        "transaction.account.nickname",
        "transaction.account.mask",
        "transaction.entity.navLabel",
        "transaction.entity.name",
        "transaction._count.tags",
      ].sort()
    );

    // Items handed to the client: exactly the declared QueueItem fields, nothing else.
    // (Batch A has the Personal item and the EKC item; the EKC one must be dropped.)
    expect(el.props.items).toHaveLength(1);
    expect(Object.keys(el.props.items[0]!).sort()).toEqual(
      ["accountId", "accountMask", "accountNickname", "amount", "bucketLabel", "payee", "postedAt", "transactionId"].sort()
    );
    expect(el.props.items[0]).toMatchObject({ transactionId: T_A, accountMask: "1234", amount: "-40" });
    expect(JSON.stringify(el.props.items)).not.toContain(T_B);
    expect(JSON.stringify(el.props.items)).not.toContain(T_EKC);
    expect(el.props.assigneeName).toBe("Eva");
    // Plain serializable values only (no Date / Decimal instances crossing to the client).
    expect(typeof el.props.items[0]!.postedAt).toBe("string");
    expect(typeof el.props.items[0]!.amount).toBe("string");
  });

  it("the page performs no writes on render (a link-preview bot GET must not count as 'opened')", async () => {
    mockDb.reviewBatch.findUnique.mockResolvedValue({ assignee: { name: "Eva" }, createdBy: { name: "Eric" } });
    await QueuePage({ params: Promise.resolve({ token: TOKEN_A }) });
    expect(mockDb.reviewBatch.updateMany).not.toHaveBeenCalled();
    expect(mockDb.transactionAssignment.updateMany).not.toHaveBeenCalled();
    expect(mockDb._tx.reviewBatch.updateMany).not.toHaveBeenCalled();
  });
});

describe("middleware: odd / encoded / case-variant paths around /queue", () => {
  function pass(path: string): boolean {
    const res = middleware(new NextRequest(`http://localhost${path}`));
    const loc = res.headers.get("location");
    return !(res.status >= 300 && res.status < 400 && loc && new URL(loc).pathname === "/login");
  }

  it("is public only for /queue and /queue/...", () => {
    for (const p of ["/queue", "/queue/", "/queue/abc", "/queue/abc/def"]) expect(pass(p), p).toBe(true);
  });

  it("everything that merely resembles /queue, or tries to traverse out of it, still needs a session", () => {
    for (const p of [
      "/queue/../transactions",
      "/queue/%2e%2e/transactions",
      "/queue/%2E%2E/tag-rules",
      "/QUEUE/abc",
      "/Queue/abc",
      "//transactions",
      "/queue.json",
      "/queue%20/abc",
      "/queue-admin",
      "/queuefoo",
      "/queue2/abc",
      "/api/queue",
    ]) {
      expect(pass(p), p).toBe(false);
    }
  });
});
