import { describe, it, expect, vi, beforeEach } from "vitest";

// submitToEva / getShareLink (Eric-side, requireAuth-gated) and the DB-aware
// submit logic in lib/review-queue-server.ts, mocked at the db/auth boundary.

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockDb = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    reviewBatch: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    transactionAssignment: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    reviewLinkToken: { create: vi.fn() },
  };
  return {
    user: { findMany: vi.fn() },
    $transaction: vi.fn(),
    _tx: tx,
  };
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

// Texting is mocked at its own boundary: no real email/SMS is ever sent here.
const smsMock = vi.hoisted(() => ({ sendBatchText: vi.fn() }));
vi.mock("@/lib/review-sms-server", () => smsMock);

import { getShareLink, resendText, submitToEva } from "@/actions/review-assignments";
import { hashReviewToken } from "@/lib/review-token";

const ERIC = "11111111-1111-4111-8111-111111111111";
const EVA = "22222222-2222-4222-8222-222222222222";
const DRAFT = "d0000000-0000-4000-8000-000000000001";
const OPEN = "d0000000-0000-4000-8000-000000000002";
const T1 = "a0000000-0000-4000-8000-000000000001";
const T2 = "a0000000-0000-4000-8000-000000000002";

function tokenFromPath(path: string): string {
  expect(path).toMatch(/^\/queue\/[A-Za-z0-9_-]{43}$/);
  return path.slice("/queue/".length);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockDb.$transaction.mockImplementation(async (fn: (t: typeof mockDb._tx) => Promise<unknown>) =>
    fn(mockDb._tx)
  );
  authMock.mockResolvedValue({ user: { id: ERIC } });
  mockDb.user.findMany.mockResolvedValue([
    { id: ERIC, name: "Eric" },
    { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" },
  ]);
  mockDb._tx.$executeRaw.mockResolvedValue(1);
  mockDb._tx.reviewBatch.findFirst.mockResolvedValue(null);
  mockDb._tx.reviewBatch.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.reviewBatch.update.mockResolvedValue({});
  mockDb._tx.transactionAssignment.findMany.mockResolvedValue([]);
  mockDb._tx.transactionAssignment.updateMany.mockResolvedValue({ count: 1 });
  mockDb._tx.transactionAssignment.update.mockResolvedValue({});
  mockDb._tx.reviewLinkToken.create.mockResolvedValue({});
  smsMock.sendBatchText.mockResolvedValue({ ok: true });
});

describe("auth", () => {
  it("submitToEva and getShareLink reject without a session and touch no DB", async () => {
    authMock.mockResolvedValue(null);
    await expect(submitToEva()).rejects.toThrow("Unauthorized");
    await expect(getShareLink(DRAFT)).rejects.toThrow("Unauthorized");
    await expect(resendText(OPEN)).rejects.toThrow("Unauthorized");
    expect(smsMock.sendBatchText).not.toHaveBeenCalled();
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe("submitToEva", () => {
  function draftWith(...txIds: string[]) {
    mockDb._tx.reviewBatch.findFirst.mockResolvedValueOnce({ id: DRAFT });
    mockDb._tx.transactionAssignment.findMany.mockResolvedValueOnce(
      txIds.map((transactionId) => ({ id: `asg-${transactionId}`, transactionId }))
    );
  }

  it("submits the draft: status submitted, submittedAt, +7d expiry, one token stored only as a hash", async () => {
    draftWith(T1, T2);
    // no open batch (second findFirst -> null by default)
    const before = Date.now();
    const res = await submitToEva();
    if (!res.ok) throw new Error(`unexpected: ${res.error}`);

    expect(res.batchId).toBe(DRAFT);
    expect(res.appended).toBe(false);
    expect(res.itemCount).toBe(2);

    const upd = mockDb._tx.reviewBatch.updateMany.mock.calls[0]![0];
    expect(upd.where).toEqual({ id: DRAFT, status: "draft" }); // atomic guard
    expect(upd.data.status).toBe("submitted");
    expect(upd.data.submittedAt).toBeInstanceOf(Date);
    const ttl = (upd.data.expiresAt as Date).getTime() - (upd.data.submittedAt as Date).getTime();
    expect(ttl).toBe(7 * 24 * 60 * 60 * 1000);
    expect((upd.data.submittedAt as Date).getTime()).toBeGreaterThanOrEqual(before);

    expect(mockDb._tx.reviewLinkToken.create).toHaveBeenCalledTimes(1);
    const stored = mockDb._tx.reviewLinkToken.create.mock.calls[0]![0].data;
    const token = tokenFromPath(res.path);
    expect(stored).toMatchObject({ batchId: DRAFT, kind: "initial" });
    expect(stored.tokenHash).toBe(hashReviewToken(token));
    // The raw token is nowhere in what was persisted.
    expect(JSON.stringify(mockDb._tx.reviewLinkToken.create.mock.calls)).not.toContain(token);
    expect(JSON.stringify(mockDb._tx.reviewBatch.updateMany.mock.calls)).not.toContain(token);
  });

  it("takes the pair advisory lock first, inside the transaction", async () => {
    draftWith(T1);
    const order: string[] = [];
    mockDb._tx.$executeRaw.mockImplementation(async () => {
      order.push("lock");
      return 1;
    });
    mockDb._tx.reviewBatch.findFirst.mockReset();
    mockDb._tx.reviewBatch.findFirst.mockImplementation(async () => {
      order.push("find");
      return order.length === 2 ? { id: DRAFT } : null;
    });
    mockDb._tx.transactionAssignment.findMany.mockReset();
    mockDb._tx.transactionAssignment.findMany.mockResolvedValue([{ id: "x", transactionId: T1 }]);
    await submitToEva();
    expect(order[0]).toBe("lock");
  });

  it("refuses with nothing to submit (no draft, or an empty draft) and mints no token", async () => {
    let res = await submitToEva(); // no draft
    expect(res).toEqual({ ok: false, error: "Nothing to submit." });

    mockDb._tx.reviewBatch.findFirst.mockResolvedValueOnce({ id: DRAFT });
    mockDb._tx.transactionAssignment.findMany.mockResolvedValueOnce([]);
    res = await submitToEva(); // draft with no pending items
    expect(res).toEqual({ ok: false, error: "Nothing to submit." });
    expect(mockDb._tx.reviewLinkToken.create).not.toHaveBeenCalled();
    expect(mockDb._tx.reviewBatch.updateMany).not.toHaveBeenCalled();
  });

  it("a double submit that loses the draft->submitted race mints no second token", async () => {
    draftWith(T1);
    mockDb._tx.reviewBatch.updateMany.mockResolvedValue({ count: 0 });
    const res = await submitToEva();
    expect(res).toEqual({ ok: false, error: "This batch was already submitted." });
    expect(mockDb._tx.reviewLinkToken.create).not.toHaveBeenCalled();
  });

  it("refuses to guess when there is no single other household user", async () => {
    mockDb.user.findMany.mockResolvedValue([{ id: ERIC, name: "Eric" }]);
    expect((await submitToEva()).ok).toBe(false);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("appends to the assignee's open batch instead of starting a second one", async () => {
    draftWith(T1, T2);
    mockDb._tx.reviewBatch.findFirst.mockResolvedValueOnce({ id: OPEN }); // the open batch
    // none of the transactions already has a row in the open batch
    mockDb._tx.transactionAssignment.findMany.mockResolvedValueOnce([]);
    const res = await submitToEva();
    if (!res.ok) throw new Error(`unexpected: ${res.error}`);

    expect(res.batchId).toBe(OPEN);
    expect(res.appended).toBe(true);
    // Items are re-pointed in one bulk update; the draft batch is NOT submitted.
    expect(mockDb._tx.transactionAssignment.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: { in: [`asg-${T1}`, `asg-${T2}`] } },
      data: { batchId: OPEN },
    });
    expect(mockDb._tx.reviewBatch.updateMany).not.toHaveBeenCalled();
    // Expiry extended on the open batch; a fresh token minted for it.
    expect(mockDb._tx.reviewBatch.update.mock.calls[0]![0]).toMatchObject({ where: { id: OPEN } });
    const stored = mockDb._tx.reviewLinkToken.create.mock.calls[0]![0].data;
    expect(stored).toMatchObject({ batchId: OPEN, kind: "resend" });
    expect(stored.tokenHash).toBe(hashReviewToken(tokenFromPath(res.path)));
  });

  it("append: an item that already has a row in the open batch revives that row and retires the draft row", async () => {
    draftWith(T1, T2);
    mockDb._tx.reviewBatch.findFirst.mockResolvedValueOnce({ id: OPEN });
    mockDb._tx.transactionAssignment.findMany.mockResolvedValueOnce([
      { id: "old-row", transactionId: T1 }, // e.g. Eva sent T1 back earlier
    ]);
    const res = await submitToEva();
    expect(res.ok).toBe(true);
    expect(mockDb._tx.transactionAssignment.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: { in: [`asg-${T2}`] } },
      data: { batchId: OPEN },
    });
    const updates = mockDb._tx.transactionAssignment.update.mock.calls.map((c) => c[0]);
    expect(updates).toContainEqual({
      where: { id: "old-row" },
      data: { status: "pending", resolvedAt: null },
    });
    expect(updates).toContainEqual({ where: { id: `asg-${T1}` }, data: { status: "removed" } });
  });
});

describe("submitToEva texting (Phase 3)", () => {
  function draftWith(...txIds: string[]) {
    mockDb._tx.reviewBatch.findFirst.mockResolvedValueOnce({ id: DRAFT });
    mockDb._tx.transactionAssignment.findMany.mockResolvedValueOnce(
      txIds.map((transactionId) => ({ id: `asg-${transactionId}`, transactionId }))
    );
  }

  it("texts the freshly minted token AFTER the submit committed, as an initial text", async () => {
    draftWith(T1);
    const res = await submitToEva();
    if (!res.ok) throw new Error(`unexpected: ${res.error}`);
    expect(res.text).toEqual({ sent: true });
    expect(smsMock.sendBatchText).toHaveBeenCalledTimes(1);
    const [batchId, token, kind] = smsMock.sendBatchText.mock.calls[0]!;
    expect(batchId).toBe(DRAFT);
    expect(kind).toBe("initial");
    expect(res.path).toBe(`/queue/${token}`);
    // The transaction (the submit) was done before the text was attempted.
    expect(mockDb.$transaction.mock.invocationCallOrder[0]!).toBeLessThan(
      smsMock.sendBatchText.mock.invocationCallOrder[0]!
    );
  });

  it("a failed text never rolls back the submit: ok:true, the batch/token were written, and the failure + link are returned", async () => {
    draftWith(T1, T2);
    smsMock.sendBatchText.mockResolvedValue({ ok: false, error: "SMS gateway address is not configured" });
    const res = await submitToEva();
    if (!res.ok) throw new Error(`unexpected: ${res.error}`);
    expect(res.text).toEqual({ sent: false, error: "SMS gateway address is not configured" });
    expect(res.path).toMatch(/^\/queue\/[A-Za-z0-9_-]{43}$/); // manual-share fallback still available
    expect(mockDb._tx.reviewBatch.updateMany.mock.calls[0]![0].data.status).toBe("submitted");
    expect(mockDb._tx.reviewLinkToken.create).toHaveBeenCalledTimes(1);
  });

  it("an append to an open batch texts as a resend (fresh token, one new text)", async () => {
    draftWith(T1);
    mockDb._tx.reviewBatch.findFirst.mockResolvedValueOnce({ id: OPEN });
    mockDb._tx.transactionAssignment.findMany.mockResolvedValueOnce([]);
    const res = await submitToEva();
    expect(res.ok).toBe(true);
    expect(smsMock.sendBatchText.mock.calls[0]![0]).toBe(OPEN);
    expect(smsMock.sendBatchText.mock.calls[0]![2]).toBe("resend");
  });

  it("sends nothing when there was nothing to submit", async () => {
    const res = await submitToEva();
    expect(res).toEqual({ ok: false, error: "Nothing to submit." });
    expect(smsMock.sendBatchText).not.toHaveBeenCalled();
  });
});

describe("resendText", () => {
  it("mints a NEW token for the open batch, texts it as a resend, and returns the outcome and link", async () => {
    const res = await resendText(OPEN);
    if (!res.ok) throw new Error(`unexpected: ${res.error}`);
    expect(res.text).toEqual({ sent: true });
    const stored = mockDb._tx.reviewLinkToken.create.mock.calls[0]![0].data;
    expect(stored).toMatchObject({ batchId: OPEN, kind: "resend" });
    expect(stored.tokenHash).toBe(hashReviewToken(tokenFromPath(res.path)));
    expect(smsMock.sendBatchText).toHaveBeenCalledWith(OPEN, tokenFromPath(res.path), "resend");
  });

  it("reports a failed resend without throwing; the link is still returned", async () => {
    smsMock.sendBatchText.mockResolvedValue({ ok: false, error: "gateway down" });
    const res = await resendText(OPEN);
    if (!res.ok) throw new Error(`unexpected: ${res.error}`);
    expect(res.text).toEqual({ sent: false, error: "gateway down" });
    expect(res.path).toMatch(/^\/queue\//);
  });

  it("does not consume or touch the reminder (no reminder columns are written)", async () => {
    await resendText(OPEN);
    expect(JSON.stringify(mockDb._tx.reviewBatch.updateMany.mock.calls)).not.toContain("reminder");
  });

  it("refuses a batch that is not open (no token, no text) and a malformed id", async () => {
    mockDb._tx.reviewBatch.updateMany.mockResolvedValue({ count: 0 });
    expect((await resendText(OPEN)).ok).toBe(false);
    expect((await resendText("nope")).ok).toBe(false);
    expect(mockDb._tx.reviewLinkToken.create).not.toHaveBeenCalled();
    expect(smsMock.sendBatchText).not.toHaveBeenCalled();
  });
});

describe("getShareLink", () => {
  it("mints a fresh token for an open batch and extends its expiry", async () => {
    const res = await getShareLink(OPEN);
    if (!res.ok) throw new Error(`unexpected: ${res.error}`);
    expect(mockDb._tx.reviewBatch.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: OPEN, status: "submitted" },
    });
    const stored = mockDb._tx.reviewLinkToken.create.mock.calls[0]![0].data;
    expect(stored.tokenHash).toBe(hashReviewToken(tokenFromPath(res.path)));
    expect(stored.batchId).toBe(OPEN);
  });
  it("refuses a batch that is not open (no token minted) and a malformed id", async () => {
    mockDb._tx.reviewBatch.updateMany.mockResolvedValue({ count: 0 });
    expect((await getShareLink(OPEN)).ok).toBe(false);
    expect(mockDb._tx.reviewLinkToken.create).not.toHaveBeenCalled();
    expect((await getShareLink("nope")).ok).toBe(false);
  });
  it("two calls mint two different tokens", async () => {
    const a = await getShareLink(OPEN);
    const b = await getShareLink(OPEN);
    if (!a.ok || !b.ok) throw new Error("unexpected");
    expect(a.path).not.toBe(b.path);
  });
});
