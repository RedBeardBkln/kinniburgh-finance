// Tester (stripe-ach-pending-hide-pay, plan D-6 / step 6): a failure of ONLY the processing-bank-payment sub-read sets
// `bankPendingFailed` on the Online payments overview; the rest of the overview (flags, fee unknown, payouts, unmatched) still loads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});

import { db } from "@/lib/db";
import { loadOnlinePaymentsOverview } from "@/lib/invoicing/pay-build";

const fake = db as unknown as FakeDb;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("tester: Online payments overview isolates the bank-pending read", () => {
  it("control: with nothing stored the overview is ok, bankPending empty, not failed", async () => {
    const o = await loadOnlinePaymentsOverview("e1", { mode: "test", today: new Date("2026-10-23T00:00:00Z") });
    expect(o.status).toBe("ok");
    if (o.status !== "ok") return;
    expect(o.bankPending).toEqual([]);
    expect(o.bankPendingFailed).toBe(false);
  });

  it("a thrown bank-pending read only sets bankPendingFailed; the overview is still ok", async () => {
    const original = fake.billingEvent.findMany.bind(fake.billingEvent);
    vi.spyOn(fake.billingEvent, "findMany").mockImplementation(((args: { where?: { kind?: unknown } }) => {
      const k = args?.where?.kind as { in?: string[] } | string | undefined;
      if (typeof k === "object" && k?.in?.includes("bank_payment_pending")) return Promise.reject(new Error("connection reset"));
      return original(args as never);
    }) as never);
    const o = await loadOnlinePaymentsOverview("e1", { mode: "test", today: new Date("2026-10-23T00:00:00Z") });
    expect(o.status).toBe("ok");
    if (o.status !== "ok") return;
    expect(o.bankPendingFailed).toBe(true);
    expect(o.bankPending).toEqual([]);
    expect(Array.isArray(o.flags)).toBe(true);
  });
});
