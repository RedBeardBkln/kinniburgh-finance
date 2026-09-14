import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import webpush, { WebPushError } from "web-push";

// Mock only the DB — sendNotification itself is stubbed directly on the real
// `web-push` module below so that `err instanceof webpush.WebPushError`
// checks against the genuine class rather than a hand-rolled mock with a
// fragile prototype chain. (vi.mock("web-push", ...) + vi.spyOn both run into
// TS constraint issues against @types/web-push's synthetic default-import
// shape, so this test mutates the shared module object directly instead.)
vi.mock("@/lib/db", () => ({
  db: {
    pushSubscription: {
      findMany: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { db } from "@/lib/db";
import { sendPushToUser } from "@/lib/web-push";

const mockDb = db as unknown as {
  pushSubscription: { findMany: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
};

const SUB = { endpoint: "https://push.example.com/abc", p256dh: "p256dh-key", auth: "auth-secret" };

const webpushHost = webpush as unknown as Record<string, unknown>;
const originalSendNotification = webpushHost["sendNotification"];
const sendNotificationMock = vi.fn();

describe("sendPushToUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    webpushHost["sendNotification"] = sendNotificationMock;
    mockDb.pushSubscription.findMany.mockResolvedValue([SUB]);
    mockDb.pushSubscription.delete.mockResolvedValue({});
  });

  afterAll(() => {
    webpushHost["sendNotification"] = originalSendNotification;
  });

  it("deletes the subscription when sendNotification rejects with a 410 WebPushError", async () => {
    sendNotificationMock.mockRejectedValue(new WebPushError("Gone", 410, {}, "", SUB.endpoint));

    await sendPushToUser("user-1", { title: "Hi", body: "There" });

    expect(mockDb.pushSubscription.delete).toHaveBeenCalledOnce();
    expect(mockDb.pushSubscription.delete).toHaveBeenCalledWith({ where: { endpoint: SUB.endpoint } });
  });

  it("deletes the subscription when sendNotification rejects with a 404 WebPushError", async () => {
    sendNotificationMock.mockRejectedValue(new WebPushError("Not Found", 404, {}, "", SUB.endpoint));

    await sendPushToUser("user-1", { title: "Hi", body: "There" });

    expect(mockDb.pushSubscription.delete).toHaveBeenCalledOnce();
    expect(mockDb.pushSubscription.delete).toHaveBeenCalledWith({ where: { endpoint: SUB.endpoint } });
  });

  it("does not delete the subscription on a 500 WebPushError", async () => {
    sendNotificationMock.mockRejectedValue(new WebPushError("Server Error", 500, {}, "", SUB.endpoint));

    await sendPushToUser("user-1", { title: "Hi", body: "There" });

    expect(mockDb.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it("does not delete the subscription on a non-WebPushError (e.g. network failure)", async () => {
    sendNotificationMock.mockRejectedValue(new Error("socket hang up"));

    await sendPushToUser("user-1", { title: "Hi", body: "There" });

    expect(mockDb.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it("does not delete the subscription and does not throw on success", async () => {
    sendNotificationMock.mockResolvedValue({ statusCode: 201, body: "", headers: {} });

    await expect(sendPushToUser("user-1", { title: "Hi", body: "There" })).resolves.toBeUndefined();

    expect(mockDb.pushSubscription.delete).not.toHaveBeenCalled();
  });
});
