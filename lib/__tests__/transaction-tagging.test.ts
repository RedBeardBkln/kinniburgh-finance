import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared tag-write / create-tag / rule-screening cores (lib/transaction-tagging.ts),
// mocked at the db boundary. These back BOTH the session-gated actions
// (actions/transactions.ts, tags.ts, tag-rules.ts) and Eva's token-gated queue.

const mockDb = vi.hoisted(() => ({
  transaction: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  transactionTag: { createMany: vi.fn(), deleteMany: vi.fn() },
  auditLog: { create: vi.fn() },
  tagGlCodeMapping: { findMany: vi.fn() },
  tag: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  tagRule: { findMany: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  createTagCore,
  createTagRuleWithScreening,
  screenTagRuleCore,
  setTransactionTags,
} from "@/lib/transaction-tagging";

const USER = "22222222-2222-4222-8222-222222222222";
const TX = "a0000000-0000-4000-8000-000000000001";
const TAG1 = "c0000000-0000-4000-8000-000000000001";
const TAG2 = "c0000000-0000-4000-8000-000000000002";
const ENTITY = "e0000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.resetAllMocks();
  mockDb.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  mockDb.auditLog.create.mockImplementation((args: unknown) => Promise.resolve(args));
  mockDb.transactionTag.createMany.mockResolvedValue({ count: 1 });
  mockDb.transactionTag.deleteMany.mockResolvedValue({ count: 1 });
  mockDb.tagGlCodeMapping.findMany.mockResolvedValue([]);
  mockDb.transaction.findMany.mockResolvedValue([]);
  mockDb.tagRule.findMany.mockResolvedValue([]);
});

describe("setTransactionTags (replace mode: the existing actions' behavior)", () => {
  it("looks the transaction up with archivedAt: null and throws 'Transaction not found' if missing", async () => {
    mockDb.transaction.findUnique.mockResolvedValue(null);
    await expect(setTransactionTags(TX, [TAG1], { userId: USER })).rejects.toThrow("Transaction not found");
    expect(mockDb.transaction.findUnique.mock.calls[0]![0].where).toEqual({ id: TX, archivedAt: null });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes a tag_change audit row attributed to the passed user, replaces tags (delete then create)", async () => {
    mockDb.transaction.findUnique.mockResolvedValue({ id: TX, entityId: ENTITY, tags: [{ tagId: TAG2 }] });
    const res = await setTransactionTags(TX, [TAG1], { userId: USER });
    expect(res).toEqual({ status: "tagged" });
    expect(mockDb.auditLog.create.mock.calls[0]![0].data).toEqual({
      transactionId: TX,
      changedBy: USER,
      changeType: "tag_change",
      before: { tagIds: [TAG2] },
      after: { tagIds: [TAG1] }, // no `source` key unless one is passed
    });
    expect(mockDb.transactionTag.deleteMany).toHaveBeenCalledWith({ where: { transactionId: TX } });
    expect(mockDb.transactionTag.createMany.mock.calls[0]![0]).toEqual({
      data: [{ transactionId: TX, tagId: TAG1 }],
    });
  });

  it("an empty tag list just clears tags (no createMany)", async () => {
    mockDb.transaction.findUnique.mockResolvedValue({ id: TX, entityId: ENTITY, tags: [{ tagId: TAG2 }] });
    await setTransactionTags(TX, [], { userId: USER });
    expect(mockDb.transactionTag.deleteMany).toHaveBeenCalled();
    expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
  });

  it("records source in the audit `after` JSON when given", async () => {
    mockDb.transaction.findUnique.mockResolvedValue({ id: TX, entityId: ENTITY, tags: [] });
    await setTransactionTags(TX, [TAG1], { userId: USER, source: "review_queue" });
    expect(mockDb.auditLog.create.mock.calls[0]![0].data.after).toEqual({
      tagIds: [TAG1],
      source: "review_queue",
    });
  });

  it("audit row and tag writes are in ONE database transaction", async () => {
    mockDb.transaction.findUnique.mockResolvedValue({ id: TX, entityId: ENTITY, tags: [] });
    await setTransactionTags(TX, [TAG1], { userId: USER });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect((mockDb.$transaction.mock.calls[0]![0] as unknown[]).length).toBe(3); // audit, delete, create
  });
});

describe("setTransactionTags (onlyIfUntagged: the review queue)", () => {
  it("is a no-op returning already_tagged when the transaction has any tag", async () => {
    mockDb.transaction.findUnique.mockResolvedValue({ id: TX, entityId: ENTITY, tags: [{ tagId: TAG2 }] });
    const res = await setTransactionTags(TX, [TAG1], { userId: USER, onlyIfUntagged: true });
    expect(res).toEqual({ status: "already_tagged" });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.deleteMany).not.toHaveBeenCalled();
  });

  it("when untagged, only ADDS tags (never a delete step) with skipDuplicates", async () => {
    mockDb.transaction.findUnique.mockResolvedValue({ id: TX, entityId: ENTITY, tags: [] });
    const res = await setTransactionTags(TX, [TAG1], { userId: USER, onlyIfUntagged: true, source: "review_queue" });
    expect(res).toEqual({ status: "tagged" });
    expect(mockDb.transactionTag.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.createMany.mock.calls[0]![0]).toEqual({
      data: [{ transactionId: TX, tagId: TAG1 }],
      skipDuplicates: true,
    });
  });

  it("auto-assigns a GL code via the entity's tag mapping, attributed to the same user", async () => {
    mockDb.transaction.findUnique.mockResolvedValue({ id: TX, entityId: ENTITY, tags: [] });
    mockDb.tagGlCodeMapping.findMany.mockResolvedValue([{ entityId: ENTITY, tagId: TAG1, glCodeId: "gl-1" }]);
    mockDb.transaction.findMany.mockResolvedValue([{ id: TX, glCodeId: null }]);
    mockDb.transaction.update.mockImplementation((args: unknown) => Promise.resolve(args));
    // autoAssignGlCodes uses db.$transaction(ops[]) too.
    await setTransactionTags(TX, [TAG1], { userId: USER, onlyIfUntagged: true });
    expect(mockDb.transaction.update.mock.calls[0]![0]).toEqual({
      where: { id: TX },
      data: { glCodeId: "gl-1" },
    });
    const glAudit = mockDb.auditLog.create.mock.calls.map((c) => c[0].data).find((d) => d.changeType === "gl_code_auto_assigned");
    expect(glAudit).toMatchObject({ changedBy: USER, transactionId: TX });
  });
});

describe("createTagCore", () => {
  it("creates a top-level tag", async () => {
    mockDb.tag.findUnique.mockResolvedValue(null);
    mockDb.tag.create.mockResolvedValue({ id: TAG1 });
    expect(await createTagCore({ shortName: " Gifts " })).toEqual({ id: TAG1 });
    expect(mockDb.tag.create.mock.calls[0]![0].data).toEqual({ name: "Gifts", shortName: "Gifts", parentId: null });
  });
  it("builds 'Parent / Child' and keeps the existing error messages", async () => {
    mockDb.tag.findUnique.mockResolvedValueOnce({ id: TAG2, name: "Food" }).mockResolvedValueOnce(null);
    mockDb.tag.create.mockResolvedValue({ id: TAG1 });
    await createTagCore({ shortName: "Snacks", parentId: TAG2 });
    expect(mockDb.tag.create.mock.calls[0]![0].data).toEqual({ name: "Food / Snacks", shortName: "Snacks", parentId: TAG2 });

    mockDb.tag.findUnique.mockReset();
    mockDb.tag.findUnique.mockResolvedValueOnce(null);
    await expect(createTagCore({ shortName: "X", parentId: TAG2 })).rejects.toThrow("Parent tag not found");

    mockDb.tag.findUnique.mockReset();
    mockDb.tag.findUnique.mockResolvedValue({ id: TAG1 });
    await expect(createTagCore({ shortName: "Gifts" })).rejects.toThrow('A tag named "Gifts" already exists.');
  });
});

describe("createTagRuleWithScreening", () => {
  const existing = {
    id: "r-old",
    payeePattern: "shell oil",
    tagId: TAG2,
    amountMin: null,
    amountMax: null,
    accountId: null,
    accountIds: null,
  };

  it("saves a clean rule with a normalized pattern", async () => {
    mockDb.tagRule.create.mockResolvedValue({ id: "r-new" });
    const res = await createTagRuleWithScreening({ payeePattern: "  Shell  OIL ", tagId: TAG1 });
    expect(res).toEqual({ status: "saved", id: "r-new" });
    expect(mockDb.tagRule.create.mock.calls[0]![0].data.payeePattern).toBe("shell oil");
  });

  it("returns needs_approval (and saves nothing) on a conflict, unless approveConflicts is set", async () => {
    mockDb.tagRule.findMany.mockResolvedValue([existing]);
    mockDb.tag.findMany.mockResolvedValue([{ id: TAG2, name: "Gas" }]);
    const res = await createTagRuleWithScreening({ payeePattern: "shell oil", tagId: TAG1 });
    expect(res.status).toBe("needs_approval");
    if (res.status !== "needs_approval") throw new Error("unexpected");
    expect(res.conflicts[0]).toMatchObject({ kind: "competing", tagName: "Gas" });
    expect(mockDb.tagRule.create).not.toHaveBeenCalled();

    mockDb.tagRule.create.mockResolvedValue({ id: "r-new" });
    const forced = await createTagRuleWithScreening({ payeePattern: "shell oil", tagId: TAG1, approveConflicts: true });
    expect(forced).toEqual({ status: "saved", id: "r-new" });
  });

  it("surfaces the first validation message (existing behavior)", async () => {
    await expect(createTagRuleWithScreening({ payeePattern: "", tagId: TAG1 })).rejects.toThrow();
    await expect(createTagRuleWithScreening({ payeePattern: "x", tagId: "not-a-uuid" })).rejects.toThrow();
  });
});

describe("screenTagRuleCore", () => {
  it("only counts conflicts an edit introduces when a baseline is given", async () => {
    const pre = {
      id: "r-pre",
      payeePattern: "shell",
      tagId: TAG2,
      amountMin: null,
      amountMax: null,
      accountId: null,
      accountIds: null,
    };
    mockDb.tagRule.findMany.mockResolvedValue([pre]);
    mockDb.tag.findMany.mockResolvedValue([{ id: TAG2, name: "Gas" }]);
    const rule = { id: "me", payeePattern: "shell", tagId: TAG1, amountMin: null, amountMax: null, accountId: null };
    // Same shape before and after: the pre-existing overlap is not "introduced".
    expect(await screenTagRuleCore(rule, "me", rule)).toEqual([]);
    // Without a baseline the overlap is reported.
    expect(await screenTagRuleCore(rule, "me")).toHaveLength(1);
  });
});
