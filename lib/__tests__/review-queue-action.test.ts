import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Token-gated actions (actions/review-queue.ts). Mocked at the db boundary, but
// the REAL token validation (lib/review-queue-server.ts -> lib/review-token.ts)
// and the real tagging core run, so these tests exercise the actual security
// claim: no export works without a valid token, the actor is derived from the
// token's batch, and an invalid/foreign transaction id can never be written.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockDb = vi.hoisted(() => {
  const tx = {
    transactionAssignment: { updateMany: vi.fn() },
    reviewBatch: { updateMany: vi.fn() },
    reviewLinkToken: { updateMany: vi.fn() },
  };
  return {
    entity: { findMany: vi.fn() },
    reviewLinkToken: { findUnique: vi.fn() },
    reviewBatch: { updateMany: vi.fn() },
    transactionAssignment: { findMany: vi.fn(), updateMany: vi.fn() },
    transaction: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    transactionTag: { createMany: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
    tag: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    tagRule: { findMany: vi.fn(), create: vi.fn() },
    tagGlCodeMapping: { findMany: vi.fn() },
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === "function" ? (arg as (t: typeof tx) => Promise<unknown>)(tx) : Promise.all(arg as unknown[])
    ),
    _tx: tx,
  };
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { generateReviewToken, hashReviewToken } from "@/lib/review-token";
import {
  createTagForQueue,
  markOpened,
  returnToEric,
  saveQueue,
} from "@/actions/review-queue";

const EVA = "22222222-2222-4222-8222-222222222222";
const PERSONAL = "e0000000-0000-4000-8000-000000000001";
const EKC = "e0000000-0000-4000-8000-000000000003";
const BATCH = "b0000000-0000-4000-8000-000000000001";
const T1 = "a0000000-0000-4000-8000-000000000001";
const T2 = "a0000000-0000-4000-8000-000000000002";
const TAG1 = "c0000000-0000-4000-8000-000000000001";
const TAG2 = "c0000000-0000-4000-8000-000000000002";

let TOKEN = "";

function liveTokenRow(over: Record<string, unknown> = {}) {
  return {
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    batch: {
      id: BATCH,
      status: "submitted",
      expiresAt: new Date(Date.now() + 3_600_000),
      assigneeUserId: EVA,
    },
    ...over,
  };
}

function assignmentRow(txId: string, over: Record<string, unknown> = {}) {
  return {
    id: `asg-${txId}`,
    status: "pending",
    transactionId: txId,
    transaction: {
      id: txId,
      postedAt: new Date("2026-09-20T12:00:00Z"),
      payeeRaw: "Shell Oil 123",
      payeeNormalized: "shell oil 123",
      amount: "-40.00",
      accountId: "acct-1",
      account: { nickname: "Checking", mask: "1234" },
      entity: { navLabel: "Personal", name: "Personal" },
      entityId: PERSONAL,
      archivedAt: null,
      transferPairId: null,
      _count: { tags: 0 },
    },
    ...over,
  };
}

function txRow(id: string, over: Record<string, unknown> = {}) {
  return { id, entityId: PERSONAL, archivedAt: null, tags: [], ...over };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockDb.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (t: typeof mockDb._tx) => Promise<unknown>)(mockDb._tx)
      : Promise.all(arg as unknown[])
  );
  TOKEN = generateReviewToken().token;
  mockDb.reviewLinkToken.findUnique.mockResolvedValue(liveTokenRow());
  mockDb.entity.findMany.mockResolvedValue([{ id: PERSONAL }]);
  mockDb.tag.findMany.mockResolvedValue([{ id: TAG1 }, { id: TAG2 }]);
  mockDb.transactionAssignment.findMany.mockResolvedValue([]);
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
});

// ── The gate itself ────────────────────────────────────────────────────────────

describe("every export of actions/review-queue.ts starts with requireReviewAccess", () => {
  const src = readFileSync(resolve(__dirname, "../../actions/review-queue.ts"), "utf8");

  it("has no export that skips the token gate", () => {
    // Split into one chunk per exported async function. In each chunk the first
    // "{" followed by a newline is the function body's opening brace (inline type
    // literals in signatures are never followed directly by a newline), and the
    // first non-comment statement after it must be the token gate.
    const chunks = src.split(/^export async function /m).slice(1);
    const names: string[] = [];
    for (const chunk of chunks) {
      const name = /^(\w+)/.exec(chunk)![1]!;
      names.push(name);
      const body = chunk.slice(chunk.indexOf("{\n") + 2);
      const firstStatement = body
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("//"));
      expect(firstStatement, `export ${name} must start with requireReviewAccess(token)`).toMatch(
        /^(const \w+ = )?await requireReviewAccess\(token\);$/
      );
    }
    expect(names.sort()).toEqual(["createTagForQueue", "markOpened", "returnToEric", "saveQueue"]);
    // And nothing else is exported as a runtime value that could bypass the gate.
    expect(src.match(/^export (?!async function|type |interface )/gm)).toBeNull();
  });

  it("does not import or call requireAuth/NextAuth (token is the only credential)", () => {
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/requireAuth|@\/lib\/auth/);
  });

  it("never logs a token (only static console.error tags)", () => {
    const logs = src.match(/console\.\w+\([^)]*\)/g) ?? [];
    for (const l of logs) expect(l).toMatch(/console\.error\("\[review-queue\] [a-z ]+"\)/);
  });
});

describe("invalid tokens are rejected before touching any data", () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["markOpened", () => markOpened(TOKEN)],
    ["createTagForQueue", () => createTagForQueue(TOKEN, { shortName: "X" })],
    ["saveQueue", () => saveQueue(TOKEN, { items: [{ transactionId: T1, tagId: TAG1 }] })],
    ["returnToEric", () => returnToEric(TOKEN, T1)],
  ];

  for (const [name, call] of cases) {
    it(`${name}: unknown token (no row) throws and writes nothing`, async () => {
      mockDb.reviewLinkToken.findUnique.mockResolvedValue(null);
      await expect(call()).rejects.toThrow("no longer valid");
      expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
      expect(mockDb.auditLog.create).not.toHaveBeenCalled();
      expect(mockDb.tag.create).not.toHaveBeenCalled();
      expect(mockDb.tagRule.create).not.toHaveBeenCalled();
      expect(mockDb.transactionAssignment.updateMany).not.toHaveBeenCalled();
      expect(mockDb.reviewBatch.updateMany).not.toHaveBeenCalled();
    });
    it(`${name}: revoked / expired / completed-batch tokens throw`, async () => {
      mockDb.reviewLinkToken.findUnique.mockResolvedValue(liveTokenRow({ revokedAt: new Date() }));
      await expect(call()).rejects.toThrow("no longer valid");
      mockDb.reviewLinkToken.findUnique.mockResolvedValue(
        liveTokenRow({ expiresAt: new Date(Date.now() - 1) })
      );
      await expect(call()).rejects.toThrow("no longer valid");
      mockDb.reviewLinkToken.findUnique.mockResolvedValue(
        liveTokenRow({
          batch: { id: BATCH, status: "completed", expiresAt: null, assigneeUserId: EVA },
        })
      );
      await expect(call()).rejects.toThrow("no longer valid");
    });
  }

  it("a malformed token never reaches the DB at all", async () => {
    await expect(markOpened("short")).rejects.toThrow("no longer valid");
    await expect(saveQueue("x".repeat(43) + "!", { items: [] })).rejects.toThrow("no longer valid");
    expect(mockDb.reviewLinkToken.findUnique).not.toHaveBeenCalled();
  });

  it("looks the token up by its SHA-256 hash, never by the raw token", async () => {
    await markOpened(TOKEN);
    const where = mockDb.reviewLinkToken.findUnique.mock.calls[0]![0].where;
    expect(where).toEqual({ tokenHash: hashReviewToken(TOKEN) });
    expect(JSON.stringify(where)).not.toContain(TOKEN);
  });
});

// ── markOpened ─────────────────────────────────────────────────────────────────

describe("markOpened", () => {
  it("sets firstOpenedAt only if still null (idempotent), scoped to the token's batch", async () => {
    mockDb.reviewBatch.updateMany.mockResolvedValue({ count: 1 });
    await expect(markOpened(TOKEN)).resolves.toEqual({ ok: true });
    expect(mockDb.reviewBatch.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: BATCH, firstOpenedAt: null },
    });
  });
});

// ── saveQueue ──────────────────────────────────────────────────────────────────

describe("saveQueue", () => {
  it("tags an item as Eva (token's assignee), writes the audit row with source review_queue, resolves it", async () => {
    mockDb.transactionAssignment.findMany
      .mockResolvedValueOnce([assignmentRow(T1)]) // the batch's requested assignments
      .mockResolvedValue([]); // closeBatchIfDone: nothing pending afterwards
    mockDb.transaction.findUnique.mockResolvedValue(txRow(T1));

    const res = await saveQueue(TOKEN, { items: [{ transactionId: T1, tagId: TAG1 }] });
    expect(res).toMatchObject({ ok: true, completed: true });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results).toEqual([{ transactionId: T1, status: "saved", rule: "none" }]);

    const audit = mockDb.auditLog.create.mock.calls[0]![0].data;
    expect(audit).toMatchObject({
      transactionId: T1,
      changedBy: EVA, // derived from the token's batch, never client input
      changeType: "tag_change",
      before: { tagIds: [] },
      after: { tagIds: [TAG1], source: "review_queue" },
    });
    expect(mockDb.transactionTag.createMany.mock.calls[0]![0]).toMatchObject({
      data: [{ transactionId: T1, tagId: TAG1 }],
    });
    expect(mockDb.transactionTag.deleteMany).not.toHaveBeenCalled(); // never destroys others' tags
    expect(mockDb.transactionAssignment.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: `asg-${T1}`, status: "pending" },
      data: { status: "resolved" },
    });
  });

  it("looks up assignments only in THIS batch and only pending ones (tampered ids are not_in_queue)", async () => {
    mockDb.transactionAssignment.findMany.mockResolvedValueOnce([]);
    const res = await saveQueue(TOKEN, { items: [{ transactionId: T2, tagId: TAG1 }] });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results).toEqual([{ transactionId: T2, status: "not_in_queue", rule: "none" }]);
    expect(mockDb.transactionAssignment.findMany.mock.calls[0]![0].where).toMatchObject({
      batchId: BATCH,
      status: "pending",
      transactionId: { in: [T2] },
    });
    expect(mockDb.transaction.findUnique).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
  });

  it("never writes to a transaction outside the assignable entities, even if an assignment exists", async () => {
    mockDb.transactionAssignment.findMany
      .mockResolvedValueOnce([
        assignmentRow(T1, { transaction: { entityId: EKC, archivedAt: null, transferPairId: null, _count: { tags: 0 } } }),
      ])
      .mockResolvedValue([]);
    const res = await saveQueue(TOKEN, { items: [{ transactionId: T1, tagId: TAG1 }] });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results[0]).toMatchObject({ status: "not_in_queue" });
    expect(mockDb.transaction.findUnique).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
  });

  it("skips (never overwrites) a transaction tagged since page load, and does not save its rule", async () => {
    mockDb.transactionAssignment.findMany
      .mockResolvedValueOnce([
        assignmentRow(T1, { transaction: { entityId: PERSONAL, archivedAt: null, transferPairId: null, _count: { tags: 1 } } }),
      ])
      .mockResolvedValue([]);
    const res = await saveQueue(TOKEN, {
      items: [{ transactionId: T1, tagId: TAG1, rule: { payeePattern: "shell oil" } }],
    });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results).toEqual([{ transactionId: T1, status: "already_tagged", rule: "none" }]);
    expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.tagRule.create).not.toHaveBeenCalled();
  });

  it("race: tagged between the check and the write is reported already_tagged and not overwritten", async () => {
    mockDb.transactionAssignment.findMany.mockResolvedValueOnce([assignmentRow(T1)]).mockResolvedValue([]);
    mockDb.transaction.findUnique.mockResolvedValue(txRow(T1, { tags: [{ tagId: TAG2 }] }));
    const res = await saveQueue(TOKEN, { items: [{ transactionId: T1, tagId: TAG1 }] });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results[0]).toMatchObject({ status: "already_tagged" });
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.deleteMany).not.toHaveBeenCalled();
  });

  it("one failing item does not abort the rest", async () => {
    mockDb.transactionAssignment.findMany
      .mockResolvedValueOnce([assignmentRow(T1), assignmentRow(T2)])
      .mockResolvedValue([]);
    mockDb.transaction.findUnique
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(txRow(T2));
    const res = await saveQueue(TOKEN, {
      items: [
        { transactionId: T1, tagId: TAG1 },
        { transactionId: T2, tagId: TAG1 },
      ],
    });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results.map((r) => r.status)).toEqual(["failed", "saved"]);
    expect(res.completed).toBe(true); // nothing left pending after the mock's empty reload
  });

  it("rejects an unknown tag id for that item (no write)", async () => {
    mockDb.tag.findMany.mockResolvedValue([]);
    mockDb.transactionAssignment.findMany.mockResolvedValueOnce([assignmentRow(T1)]).mockResolvedValue([]);
    const res = await saveQueue(TOKEN, { items: [{ transactionId: T1, tagId: TAG1 }] });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results[0]).toMatchObject({ status: "failed" });
    expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
  });

  it("validates input: empty list, bad uuids and oversize lists are rejected without writes", async () => {
    expect((await saveQueue(TOKEN, { items: [] })).ok).toBe(false);
    expect((await saveQueue(TOKEN, { items: [{ transactionId: "nope", tagId: TAG1 }] })).ok).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => ({
      transactionId: `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      tagId: TAG1,
    }));
    expect((await saveQueue(TOKEN, { items: many })).ok).toBe(false);
    expect(mockDb.transactionTag.createMany).not.toHaveBeenCalled();
  });

  it("saves a non-conflicting rule with the normalized pattern after the tag is saved", async () => {
    mockDb.transactionAssignment.findMany.mockResolvedValueOnce([assignmentRow(T1)]).mockResolvedValue([]);
    mockDb.transaction.findUnique.mockResolvedValue(txRow(T1));
    const res = await saveQueue(TOKEN, {
      items: [{ transactionId: T1, tagId: TAG1, rule: { payeePattern: "  Shell   OIL " } }],
    });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results[0]).toMatchObject({ status: "saved", rule: "saved" });
    expect(mockDb.tagRule.create.mock.calls[0]![0].data).toMatchObject({
      payeePattern: "shell oil",
      tagId: TAG1,
      amountMin: null,
      amountMax: null,
      accountId: null,
    });
  });

  it("a conflicting rule is NOT saved (never overridable), the tag still is, and a plain note is returned", async () => {
    mockDb.transactionAssignment.findMany.mockResolvedValueOnce([assignmentRow(T1)]).mockResolvedValue([]);
    mockDb.transaction.findUnique.mockResolvedValue(txRow(T1));
    // Existing rule maps the same payee to a DIFFERENT tag -> "competing".
    mockDb.tagRule.findMany.mockResolvedValue([
      { id: "r-old", payeePattern: "shell oil", tagId: TAG2, amountMin: null, amountMax: null, accountId: null, accountIds: null },
    ]);
    mockDb.tag.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id, name: "Gas" }))
    );
    const res = await saveQueue(TOKEN, {
      items: [{ transactionId: T1, tagId: TAG1, rule: { payeePattern: "shell oil" } }],
    });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results[0]).toMatchObject({ status: "saved", rule: "skipped_conflict" });
    expect(res.results[0]!.ruleNote).toMatch(/overlaps an existing rule/);
    expect(mockDb.tagRule.create).not.toHaveBeenCalled();
    expect(mockDb.transactionTag.createMany).toHaveBeenCalledTimes(1); // the tag was still saved
  });

  it("a duplicate rule is skipped with the 'already exists' note", async () => {
    mockDb.transactionAssignment.findMany.mockResolvedValueOnce([assignmentRow(T1)]).mockResolvedValue([]);
    mockDb.transaction.findUnique.mockResolvedValue(txRow(T1));
    mockDb.tagRule.findMany.mockResolvedValue([
      { id: "r-old", payeePattern: "shell oil", tagId: TAG1, amountMin: null, amountMax: null, accountId: null, accountIds: null },
    ]);
    mockDb.tag.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id, name: "Gas" }))
    );
    const res = await saveQueue(TOKEN, {
      items: [{ transactionId: T1, tagId: TAG1, rule: { payeePattern: "shell oil" } }],
    });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results[0]).toMatchObject({ rule: "skipped_conflict" });
    expect(res.results[0]!.ruleNote).toMatch(/already exists/);
    expect(mockDb.tagRule.create).not.toHaveBeenCalled();
  });

  it("refuses an unusable (punctuation-only / too short) rule pattern but still saves the tag", async () => {
    mockDb.transactionAssignment.findMany.mockResolvedValueOnce([assignmentRow(T1)]).mockResolvedValue([]);
    mockDb.transaction.findUnique.mockResolvedValue(txRow(T1));
    const res = await saveQueue(TOKEN, {
      items: [{ transactionId: T1, tagId: TAG1, rule: { payeePattern: "---" } }],
    });
    if (!res.ok) throw new Error("unexpected");
    expect(res.results[0]).toMatchObject({ status: "saved", rule: "failed" });
    expect(mockDb.tagRule.create).not.toHaveBeenCalled();
    expect(mockDb.tagRule.findMany).not.toHaveBeenCalled();
  });

  it("closes the batch and revokes every token when nothing is left; stays open otherwise", async () => {
    // Nothing left -> completed.
    mockDb.transactionAssignment.findMany.mockResolvedValueOnce([assignmentRow(T1)]).mockResolvedValue([]);
    mockDb.transaction.findUnique.mockResolvedValue(txRow(T1));
    await saveQueue(TOKEN, { items: [{ transactionId: T1, tagId: TAG1 }] });
    expect(mockDb._tx.reviewBatch.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: BATCH, status: "submitted" },
      data: { status: "completed" },
    });
    expect(mockDb._tx.reviewLinkToken.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { batchId: BATCH, revokedAt: null },
    });

    // Another untouched pending item remains -> not completed, link stays alive.
    vi.clearAllMocks();
    mockDb.reviewLinkToken.findUnique.mockResolvedValue(liveTokenRow());
    mockDb.entity.findMany.mockResolvedValue([{ id: PERSONAL }]);
    mockDb.tag.findMany.mockResolvedValue([{ id: TAG1 }]);
    mockDb.transactionAssignment.findMany
      .mockResolvedValueOnce([assignmentRow(T1)])
      .mockResolvedValue([assignmentRow(T2)]);
    mockDb.transaction.findUnique.mockResolvedValue(txRow(T1));
    mockDb.transactionAssignment.updateMany.mockResolvedValue({ count: 1 });
    mockDb.tagGlCodeMapping.findMany.mockResolvedValue([]);
    const res = await saveQueue(TOKEN, { items: [{ transactionId: T1, tagId: TAG1 }] });
    if (!res.ok) throw new Error("unexpected");
    expect(res.completed).toBe(false);
    expect(mockDb._tx.reviewBatch.updateMany).not.toHaveBeenCalled();
    expect(mockDb._tx.reviewLinkToken.updateMany).not.toHaveBeenCalled();
  });
});

// ── returnToEric ───────────────────────────────────────────────────────────────

describe("returnToEric", () => {
  it("marks only a pending assignment in THIS batch as returned", async () => {
    mockDb.transactionAssignment.findMany.mockResolvedValue([]);
    const res = await returnToEric(TOKEN, T1);
    expect(res).toEqual({ ok: true, completed: true });
    expect(mockDb.transactionAssignment.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { batchId: BATCH, transactionId: T1, status: "pending" },
      data: { status: "returned" },
    });
  });
  it("rejects an item that is not pending in this batch (count 0) without closing anything", async () => {
    mockDb.transactionAssignment.updateMany.mockResolvedValue({ count: 0 });
    const res = await returnToEric(TOKEN, T1);
    expect(res.ok).toBe(false);
    expect(mockDb._tx.reviewBatch.updateMany).not.toHaveBeenCalled();
  });
  it("rejects a malformed id", async () => {
    expect((await returnToEric(TOKEN, "nope")).ok).toBe(false);
    expect(mockDb.transactionAssignment.updateMany).not.toHaveBeenCalled();
  });
});

// ── createTagForQueue ──────────────────────────────────────────────────────────

describe("createTagForQueue", () => {
  it("creates a top-level tag and returns it", async () => {
    mockDb.tag.findUnique
      .mockResolvedValueOnce(null) // duplicate check
      .mockResolvedValueOnce({ id: TAG1, name: "Gifts", shortName: "Gifts", parentId: null });
    mockDb.tag.create.mockResolvedValue({ id: TAG1 });
    const res = await createTagForQueue(TOKEN, { shortName: "  Gifts " });
    expect(res).toEqual({ ok: true, tag: { id: TAG1, name: "Gifts", shortName: "Gifts", parentId: null } });
    expect(mockDb.tag.create.mock.calls[0]![0].data).toEqual({ name: "Gifts", shortName: "Gifts", parentId: null });
  });
  it("creates a child as 'Parent / Child'", async () => {
    mockDb.tag.findUnique
      .mockResolvedValueOnce({ id: TAG2, name: "Food", shortName: "Food", parentId: null }) // parent
      .mockResolvedValueOnce(null) // duplicate check
      .mockResolvedValueOnce({ id: TAG1, name: "Food / Snacks", shortName: "Snacks", parentId: TAG2 });
    mockDb.tag.create.mockResolvedValue({ id: TAG1 });
    const res = await createTagForQueue(TOKEN, { shortName: "Snacks", parentId: TAG2 });
    expect(res.ok).toBe(true);
    expect(mockDb.tag.create.mock.calls[0]![0].data).toMatchObject({ name: "Food / Snacks", parentId: TAG2 });
  });
  it("returns a friendly error for a duplicate name and for invalid input", async () => {
    mockDb.tag.findUnique.mockResolvedValue({ id: TAG1 });
    const dup = await createTagForQueue(TOKEN, { shortName: "Gifts" });
    expect(dup).toEqual({ ok: false, error: 'A tag named "Gifts" already exists.' });
    const empty = await createTagForQueue(TOKEN, { shortName: "   " });
    expect(empty.ok).toBe(false);
    const tooLong = await createTagForQueue(TOKEN, { shortName: "x".repeat(101) });
    expect(tooLong.ok).toBe(false);
  });
});
