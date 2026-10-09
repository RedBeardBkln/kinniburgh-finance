import { afterEach, describe, expect, it, vi } from "vitest";

// Round 1 (D4): loadScheduledFlows is FAIL-SOFT. A database error must not reject (it runs inside the cron route's
// Promise.all, where a rejection would skip dispatchPending()); it returns null = "flows unknown" and logs err.name only.

vi.mock("@/lib/db", () => {
  const failing = () => Promise.reject(Object.assign(new Error("secret connection detail 4111111111111111"), { name: "PrismaClientInitializationError" }));
  return {
    db: {
      scheduledTransfer: { findMany: vi.fn(failing) },
      incomeSource: { findMany: vi.fn(async () => []) },
      scheduledBill: { findMany: vi.fn(async () => []) },
      budget: { findMany: vi.fn(async () => []) },
      appSetting: { findUnique: vi.fn(async () => null) },
    },
  };
});

import { loadScheduledFlows } from "@/lib/account-scheduled-flows";

afterEach(() => vi.restoreAllMocks());

describe("loadScheduledFlows fail-soft", () => {
  it("returns null instead of rejecting, and logs only the error name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const from = new Date("2026-10-09T00:00:00Z");
    await expect(loadScheduledFlows("acct", from, new Date("2026-11-08T00:00:00Z"))).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(["Scheduled flows unavailable", "PrismaClientInitializationError"]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
  });
});
