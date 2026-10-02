import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The reminder runner, mocked at the db / server-helper / sender boundaries.
// No real email or SMS is ever sent: the sender is a fake.

const mockDb = vi.hoisted(() => ({
  reviewBatch: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const server = vi.hoisted(() => ({
  loadQueueItems: vi.fn(),
  mintReminderToken: vi.fn(),
}));
vi.mock("@/lib/review-queue-server", () => server);

import { runReviewReminders } from "@/lib/review-reminder-runner";
import type { SmsSender } from "@/lib/sms-sender";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-07-15T15:00:00Z"); // 11:00 EDT, inside the window
const TOKEN = "T".repeat(43);
const ADDRESS = "eva@example.test"; // the assignee's account email (default email delivery)

function candidate(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    status: "submitted",
    firstOpenedAt: null,
    smsStatus: "sent",
    smsSentAt: new Date(NOW.getTime() - 30 * HOUR),
    reminderStatus: null,
    expiresAt: new Date(NOW.getTime() + 5 * 24 * HOUR),
    createdBy: { name: "Eric" },
    assignee: { email: ADDRESS },
    ...over,
  };
}

let send: ReturnType<typeof vi.fn<SmsSender["send"]>>;
let sender: SmsSender;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXTAUTH_URL", "https://finance.example.test");
  vi.stubEnv("NODE_ENV", "production");
  send = vi.fn<SmsSender["send"]>().mockResolvedValue({ ok: true });
  sender = { send } as SmsSender;
  mockDb.reviewBatch.findMany.mockResolvedValue([]);
  mockDb.reviewBatch.updateMany.mockResolvedValue({ count: 1 });
  mockDb.reviewBatch.update.mockResolvedValue({});
  server.loadQueueItems.mockResolvedValue([{ transactionId: "t1" }]);
  server.mintReminderToken.mockResolvedValue({ token: TOKEN });
});

afterEach(() => vi.unstubAllEnvs());

describe("runReviewReminders", () => {
  it("outside the send window: does nothing at all (no DB read, no send)", async () => {
    const night = new Date("2026-07-15T08:00:00Z"); // 04:00 EDT
    const res = await runReviewReminders(night, sender);
    expect(res).toMatchObject({ outsideWindow: true, sent: 0, failed: 0 });
    expect(mockDb.reviewBatch.findMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("queries only submitted, never-opened, text-sent, 24h-old, unexpired batches without a reminder", async () => {
    await runReviewReminders(NOW, sender);
    const where = mockDb.reviewBatch.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      status: "submitted",
      firstOpenedAt: null,
      reminderStatus: null,
      smsStatus: "sent",
    });
    expect(where.smsSentAt.lte.getTime()).toBe(NOW.getTime() - 24 * HOUR);
    expect(where.expiresAt.gt.getTime()).toBe(NOW.getTime());
  });

  it("sends exactly one reminder with a NEW token, claim first, and records sent", async () => {
    mockDb.reviewBatch.findMany.mockResolvedValue([candidate("b1")]);
    const order: string[] = [];
    mockDb.reviewBatch.updateMany.mockImplementation(async () => {
      order.push("claim");
      return { count: 1 };
    });
    server.mintReminderToken.mockImplementation(async () => {
      order.push("mint");
      return { token: TOKEN };
    });
    send.mockImplementation(async () => {
      order.push("send");
      return { ok: true };
    });

    const res = await runReviewReminders(NOW, sender);
    expect(res).toMatchObject({ sent: 1, failed: 0, skipped: 0 });
    expect(order).toEqual(["claim", "mint", "send"]);

    // The claim is conditional on the batch still being eligible.
    expect(mockDb.reviewBatch.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: "b1", status: "submitted", firstOpenedAt: null, reminderStatus: null },
      data: { reminderStatus: "sending" },
    });
    // New token for the batch, expiring with the batch (not extended).
    expect(server.mintReminderToken).toHaveBeenCalledWith("b1", expect.any(Date));
    expect(server.mintReminderToken.mock.calls[0]![1].getTime()).toBe(NOW.getTime() + 5 * 24 * HOUR);

    expect(send).toHaveBeenCalledTimes(1);
    const [to, body] = send.mock.calls[0]!;
    expect(to).toBe(ADDRESS);
    expect(body).toContain(`https://finance.example.test/queue/${TOKEN}`);
    expect(body).toMatch(/^Reminder:/);
    expect(mockDb.reviewBatch.update.mock.calls[0]![0]).toEqual({
      where: { id: "b1" },
      data: { reminderStatus: "sent", reminderSentAt: NOW, reminderError: null },
    });
  });

  it("running it again (or a concurrent run) cannot double-send: a lost claim sends nothing", async () => {
    mockDb.reviewBatch.findMany.mockResolvedValue([candidate("b1")]);
    mockDb.reviewBatch.updateMany.mockResolvedValue({ count: 0 }); // another run already claimed it
    const res = await runReviewReminders(NOW, sender);
    expect(res).toMatchObject({ sent: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(server.mintReminderToken).not.toHaveBeenCalled();
    expect(mockDb.reviewBatch.update).not.toHaveBeenCalled();
  });

  it("a batch the DB pre-filter returned but the pure rule rejects is skipped before any claim", async () => {
    mockDb.reviewBatch.findMany.mockResolvedValue([
      candidate("opened", { firstOpenedAt: new Date(NOW.getTime() - HOUR) }),
      candidate("young", { smsSentAt: new Date(NOW.getTime() - 2 * HOUR) }),
      candidate("handled", { reminderStatus: "failed" }),
    ]);
    const res = await runReviewReminders(NOW, sender);
    expect(res).toMatchObject({ considered: 3, sent: 0, skipped: 3 });
    expect(mockDb.reviewBatch.updateMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not nag when nothing is left for her to tag", async () => {
    mockDb.reviewBatch.findMany.mockResolvedValue([candidate("b1")]);
    server.loadQueueItems.mockResolvedValue([]);
    const res = await runReviewReminders(NOW, sender);
    expect(res).toMatchObject({ sent: 0, skipped: 1 });
    expect(mockDb.reviewBatch.updateMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed send is recorded as failed with a sanitized message and is not retried in the same run", async () => {
    mockDb.reviewBatch.findMany.mockResolvedValue([candidate("b1")]);
    send.mockResolvedValue({ ok: false, error: "gateway rejected" });
    const res = await runReviewReminders(NOW, sender);
    expect(res).toMatchObject({ sent: 0, failed: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(mockDb.reviewBatch.update.mock.calls[0]![0]).toEqual({
      where: { id: "b1" },
      data: { reminderStatus: "failed", reminderError: "gateway rejected" },
    });
  });

  it("an assignee with no email is a recorded failure (not a throw) and nothing is sent", async () => {
    mockDb.reviewBatch.findMany.mockResolvedValue([candidate("b1", { assignee: { email: "" } })]);
    const res = await runReviewReminders(NOW, sender);
    expect(res).toMatchObject({ failed: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(mockDb.reviewBatch.update.mock.calls[0]![0].data).toMatchObject({
      reminderStatus: "failed",
      reminderError: expect.stringContaining("No delivery address"),
    });
  });

  it("an error after the claim (token mint fails) ends as failed, never left sending, and doesn't abort other batches", async () => {
    mockDb.reviewBatch.findMany.mockResolvedValue([candidate("b1"), candidate("b2")]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    server.mintReminderToken
      .mockRejectedValueOnce(new Error(`db down ${TOKEN}`))
      .mockResolvedValueOnce({ token: TOKEN });
    const res = await runReviewReminders(NOW, sender);
    expect(res).toMatchObject({ sent: 1, failed: 1 });
    const updates = mockDb.reviewBatch.update.mock.calls.map((c) => c[0]);
    expect(updates[0]).toMatchObject({ where: { id: "b1" }, data: { reminderStatus: "failed" } });
    expect(JSON.stringify(updates)).not.toContain(TOKEN);
    expect(updates[1]).toMatchObject({ where: { id: "b2" }, data: { reminderStatus: "sent" } });
  });

  it("never logs tokens, addresses or links", async () => {
    mockDb.reviewBatch.findMany.mockResolvedValue([candidate("b1")]);
    server.mintReminderToken.mockRejectedValue(new Error(`boom ${TOKEN} ${ADDRESS}`));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runReviewReminders(NOW, sender);
    const logged = JSON.stringify([...err.mock.calls, ...log.mock.calls]);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(ADDRESS);
    expect(logged).not.toContain("finance.example.test");
  });
});
