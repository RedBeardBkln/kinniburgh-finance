import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

// Mock DB and web-push before importing the module under test
vi.mock("@/lib/db", () => ({ db: { $queryRaw: vi.fn(), budget: { findMany: vi.fn() }, account: { findMany: vi.fn() }, accrualEnvelope: { findMany: vi.fn() }, scheduledBill: { findMany: vi.fn() }, notification: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() }, notificationUser: {}, user: { findMany: vi.fn() }, tag: { findMany: vi.fn() } } }));
vi.mock("@/lib/web-push", () => ({ sendPushToUser: vi.fn() }));

import { db } from "@/lib/db";
import {
  checkBudgetOverspend,
  checkLowBalance,
  checkAccrualShortfall,
  checkBillReminders,
  checkAnomalies,
} from "@/lib/notifications";

const mockDb = db as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>;
  budget: { findMany: ReturnType<typeof vi.fn> };
  account: { findMany: ReturnType<typeof vi.fn> };
  accrualEnvelope: { findMany: ReturnType<typeof vi.fn> };
  scheduledBill: { findMany: ReturnType<typeof vi.fn> };
  notification: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  user: { findMany: ReturnType<typeof vi.fn> };
  tag: { findMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no existing notifications today (no duplicates)
  mockDb.notification.findFirst.mockResolvedValue(null);
  // Default: two users
  mockDb.user.findMany.mockResolvedValue([{ id: "user-1" }, { id: "user-2" }]);
  // Default: notification create returns an object with id
  mockDb.notification.create.mockResolvedValue({ id: "notif-1" });
  mockDb.notification.update.mockResolvedValue({});
});

// ── 1. Budget overspend ───────────────────────────────────────────────────────

describe("checkBudgetOverspend", () => {
  it("generates a notification when a budget is at 85%", async () => {
    mockDb.budget.findMany.mockResolvedValue([
      {
        id: "b1",
        tagId: "tag-groceries",
        entityId: "entity-personal",
        period: "2026-06",
        budgeted: new Decimal("1200"),
        rolloverAmount: null,
        tag: { id: "tag-groceries", shortName: "Groceries" },
        entity: { id: "entity-personal", name: "Personal" },
      },
    ]);
    // actualSpend = -1020 (85% of 1200)
    mockDb.$queryRaw.mockResolvedValue([{ tagId: "tag-groceries", total: "-1020" }]);

    const count = await checkBudgetOverspend("2026-06");
    expect(count).toBe(1);
    expect(mockDb.notification.create).toHaveBeenCalledOnce();
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { type: string; payload: Record<string, unknown> } };
    expect(call.data.type).toBe("overspend");
    expect(call.data.payload.percentUsed).toBe(85);
  });

  it("does not generate a notification when budget is at 50%", async () => {
    mockDb.budget.findMany.mockResolvedValue([
      {
        id: "b1",
        tagId: "tag-groceries",
        entityId: "entity-personal",
        period: "2026-06",
        budgeted: new Decimal("1200"),
        rolloverAmount: null,
        tag: { id: "tag-groceries", shortName: "Groceries" },
        entity: { id: "entity-personal", name: "Personal" },
      },
    ]);
    mockDb.$queryRaw.mockResolvedValue([{ tagId: "tag-groceries", total: "-600" }]);

    const count = await checkBudgetOverspend("2026-06");
    expect(count).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });
});

// ── 2. Low balance ────────────────────────────────────────────────────────────

describe("checkLowBalance", () => {
  it("generates a notification when an account will breach minimum within 30 days", async () => {
    mockDb.account.findMany.mockResolvedValue([
      {
        id: "acc-td",
        entityId: "entity-personal",
        nickname: "TD Checking x4821",
        accountType: "checking",
        minimumBalance: new Decimal("250"),
        currentBalance: new Decimal("255"),
        currentBalanceAt: new Date(),
        scheduledTransfersFrom: [
          {
            id: "st-1",
            fromAccountId: "acc-td",
            toAccountId: "acc-other",
            amount: new Decimal("500"),
            cadence: "monthly",
            dayRules: { dayOfMonth: 1 },
            purpose: "Rent",
            active: true,
          },
        ],
        scheduledTransfersTo: [],
        incomeSources: [],
      },
    ]);

    const count = await checkLowBalance();
    expect(count).toBe(1);
    expect(mockDb.notification.create).toHaveBeenCalledOnce();
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { type: string } };
    expect(call.data.type).toBe("low_balance");
  });
});

// ── 3. Accrual shortfall ──────────────────────────────────────────────────────

describe("checkAccrualShortfall", () => {
  it("generates a notification when an envelope is underfunded near draw season", async () => {
    const now = new Date();
    const currentMonth = now.getUTCMonth() + 1;
    // Draw month is 1 month from now
    const drawMonth = (currentMonth % 12) + 1;

    mockDb.accrualEnvelope.findMany.mockResolvedValue([
      {
        id: "env-1",
        name: "Oil Heat",
        targetAnnualAmount: new Decimal("2400"),
        currentBalance: new Decimal("100"), // way underfunded
        expectedDrawMonths: [drawMonth],
        account: { entityId: "entity-personal" },
      },
    ]);

    const count = await checkAccrualShortfall();
    expect(count).toBe(1);
    expect(mockDb.notification.create).toHaveBeenCalledOnce();
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { type: string } };
    expect(call.data.type).toBe("accrual_shortfall");
  });

  it("does not notify when draw season is far away", async () => {
    const now = new Date();
    const currentMonth = now.getUTCMonth() + 1;
    // Draw month is 6 months away
    const drawMonth = ((currentMonth + 5) % 12) + 1;

    mockDb.accrualEnvelope.findMany.mockResolvedValue([
      {
        id: "env-1",
        name: "Oil Heat",
        targetAnnualAmount: new Decimal("2400"),
        currentBalance: new Decimal("100"),
        expectedDrawMonths: [drawMonth],
        account: { entityId: "entity-personal" },
      },
    ]);

    const count = await checkAccrualShortfall();
    expect(count).toBe(0);
  });
});

// ── 4. Bill reminders ─────────────────────────────────────────────────────────

describe("checkBillReminders", () => {
  it("generates a notification for a bill due in 2 days", async () => {
    const dueDay = new Date();
    dueDay.setUTCDate(dueDay.getUTCDate() + 2);

    mockDb.scheduledBill.findMany.mockResolvedValue([
      {
        id: "bill-1",
        payee: "Eversource",
        entityId: "entity-personal",
        autopayDay: dueDay.getUTCDate(),
        expectedAmount: new Decimal("167.90"),
        active: true,
        entity: { id: "entity-personal", name: "Personal" },
      },
    ]);

    const count = await checkBillReminders();
    expect(count).toBe(1);
    expect(mockDb.notification.create).toHaveBeenCalledOnce();
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { type: string; payload: Record<string, unknown> } };
    expect(call.data.type).toBe("bill_due");
    expect(call.data.payload.payee).toBe("Eversource");
  });

  it("does not notify for a bill due in 10 days", async () => {
    const dueDay = new Date();
    dueDay.setUTCDate(dueDay.getUTCDate() + 10);

    mockDb.scheduledBill.findMany.mockResolvedValue([
      {
        id: "bill-1",
        payee: "Eversource",
        entityId: "entity-personal",
        autopayDay: dueDay.getUTCDate(),
        expectedAmount: new Decimal("167.90"),
        active: true,
        entity: { id: "entity-personal", name: "Personal" },
      },
    ]);

    const count = await checkBillReminders();
    expect(count).toBe(0);
  });
});

// ── 5. Spending anomalies ─────────────────────────────────────────────────────

describe("checkAnomalies", () => {
  it("generates a notification when spending is 3x the historical average", async () => {
    mockDb.tag.findMany.mockResolvedValue([{ id: "tag-dining", shortName: "Dining Out" }]);

    // Current month spend: -$300
    mockDb.$queryRaw
      .mockResolvedValueOnce([{ tagId: "tag-dining", entityId: "entity-personal", total: "-300" }])
      // 3-month historical: -$300 total (avg $100/mo)
      .mockResolvedValueOnce([{ tagId: "tag-dining", entityId: "entity-personal", total: "-300" }]);

    const count = await checkAnomalies("2026-06");
    expect(count).toBe(1);
    expect(mockDb.notification.create).toHaveBeenCalledOnce();
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { type: string; payload: Record<string, unknown> } };
    expect(call.data.type).toBe("anomaly");
    expect(call.data.payload.tagName).toBe("Dining Out");
  });

  it("does not notify when spending is only 20% above average", async () => {
    mockDb.tag.findMany.mockResolvedValue([{ id: "tag-dining", shortName: "Dining Out" }]);

    mockDb.$queryRaw
      .mockResolvedValueOnce([{ tagId: "tag-dining", entityId: "entity-personal", total: "-120" }])
      .mockResolvedValueOnce([{ tagId: "tag-dining", entityId: "entity-personal", total: "-300" }]); // avg $100

    const count = await checkAnomalies("2026-06");
    expect(count).toBe(0);
  });
});
