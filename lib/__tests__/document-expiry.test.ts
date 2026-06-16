import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  insurancePolicy: {
    findMany: vi.fn(),
  },
  notification: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/web-push", () => ({
  sendPushToUser: vi.fn().mockResolvedValue(undefined),
}));

import { checkDocumentExpiry } from "@/lib/notifications";

const USER = { id: "user-1", notificationPrefs: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.user.findMany.mockResolvedValue([USER]);
  mockDb.notification.create.mockResolvedValue({ id: "notif-1" });
  mockDb.notification.update.mockResolvedValue({});
});

function policyDaysOut(days: number) {
  return {
    id: "policy-1",
    insurer: "MetLife",
    policyType: "term",
    expiryDate: new Date(Date.now() + days * 86400000),
    archivedAt: null,
  };
}

describe("checkDocumentExpiry", () => {
  it("creates a notification for a policy expiring in 25 days", async () => {
    mockDb.insurancePolicy.findMany.mockResolvedValue([policyDaysOut(25)]);
    mockDb.notification.findFirst.mockResolvedValue(null);

    const count = await checkDocumentExpiry();

    expect(count).toBe(1);
    expect(mockDb.notification.create).toHaveBeenCalledOnce();
  });

  it("does not create a notification for a policy expiring in 45 days", async () => {
    mockDb.insurancePolicy.findMany.mockResolvedValue([policyDaysOut(45)]);

    const count = await checkDocumentExpiry();

    expect(count).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("suppresses duplicate notifications for an already-alerted policy", async () => {
    mockDb.insurancePolicy.findMany.mockResolvedValue([policyDaysOut(20)]);
    mockDb.notification.findFirst.mockResolvedValue({ id: "existing-notif" });

    const count = await checkDocumentExpiry();

    expect(count).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });
});
