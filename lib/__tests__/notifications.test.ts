import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

// Mock DB and web-push before importing the module under test
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    budget: { findMany: vi.fn() },
    account: { findMany: vi.fn(), findFirst: vi.fn() },
    accrualEnvelope: { findMany: vi.fn() },
    scheduledBill: { findMany: vi.fn() },
    notification: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    notificationUser: {},
    user: { findMany: vi.fn() },
    tag: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    transaction: { findFirst: vi.fn(), create: vi.fn() },
    entity: { findFirst: vi.fn() },
    transactionTag: { create: vi.fn() },
  },
}));
vi.mock("@/lib/web-push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/gl-code-resolver", () => ({ autoAssignGlCodes: vi.fn() }));

import { db } from "@/lib/db";
import {
  checkBudgetOverspend,
  checkLowBalance,
  checkAccrualShortfall,
  checkBillReminders,
  checkAnomalies,
  checkCardPaymentsDue,
  checkCcFundingShortfall,
} from "@/lib/notifications";

const mockDb = db as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>;
  budget: { findMany: ReturnType<typeof vi.fn> };
  account: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  accrualEnvelope: { findMany: ReturnType<typeof vi.fn> };
  scheduledBill: { findMany: ReturnType<typeof vi.fn> };
  notification: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  user: { findMany: ReturnType<typeof vi.fn> };
  tag: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  transaction: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  entity: { findFirst: ReturnType<typeof vi.fn> };
  transactionTag: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no existing notifications today (no duplicates)
  mockDb.notification.findFirst.mockResolvedValue(null);
  // Default: two users, no saved prefs (everything defaults to enabled)
  mockDb.user.findMany.mockResolvedValue([
    { id: "user-1", notificationPrefs: null },
    { id: "user-2", notificationPrefs: null },
  ]);
  // Default: notification create returns an object with id
  mockDb.notification.create.mockResolvedValue({ id: "notif-1" });
  mockDb.notification.update.mockResolvedValue({});
});

function userIdsFromCreateCall(callIndex = 0): string[] {
  const call = mockDb.notification.create.mock.calls[callIndex]![0] as {
    data: { users: { create: { userId: string }[] } };
  };
  return call.data.users.create.map((u) => u.userId);
}

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

  it("excludes a user who opted out of overspend alerts", async () => {
    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { overspend: { enabled: false, threshold: 80 } } },
      { id: "user-2", notificationPrefs: null },
    ]);
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
    mockDb.$queryRaw.mockResolvedValue([{ tagId: "tag-groceries", total: "-1020" }]);

    const count = await checkBudgetOverspend("2026-06");
    expect(count).toBe(1);
    expect(userIdsFromCreateCall()).toEqual(["user-2"]);
  });

  it("respects each user's individually configured threshold", async () => {
    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { overspend: { enabled: true, threshold: 90 } } }, // not met at 85%
      { id: "user-2", notificationPrefs: null }, // default threshold 80, met at 85%
    ]);
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
    mockDb.$queryRaw.mockResolvedValue([{ tagId: "tag-groceries", total: "-1020" }]);

    const count = await checkBudgetOverspend("2026-06");
    expect(count).toBe(1);
    expect(userIdsFromCreateCall()).toEqual(["user-2"]);
  });

  it("does not create a notification when every user's threshold is unmet", async () => {
    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { overspend: { enabled: false, threshold: 80 } } },
      { id: "user-2", notificationPrefs: { overspend: { enabled: true, threshold: 95 } } },
    ]);
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
    mockDb.$queryRaw.mockResolvedValue([{ tagId: "tag-groceries", total: "-1020" }]); // 85%

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

  it("excludes a user who opted out of low-balance alerts", async () => {
    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { low_balance: { enabled: false } } },
      { id: "user-2", notificationPrefs: null },
    ]);
    mockDb.account.findMany.mockResolvedValue([
      {
        id: "acc-td",
        entityId: "entity-personal",
        nickname: "TD Checking x4821",
        accountType: "checking",
        minimumBalance: new Decimal("250"),
        currentBalance: new Decimal("255"),
        currentBalanceAt: new Date(),
        minimumBalanceFee: null,
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
    expect(userIdsFromCreateCall()).toEqual(["user-2"]);
  });

  it("still creates the $15 minimum-balance fee transaction even when every user is opted out of the notification", async () => {
    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { low_balance: { enabled: false } } },
      { id: "user-2", notificationPrefs: { low_balance: { enabled: false } } },
    ]);
    mockDb.account.findMany.mockResolvedValue([
      {
        id: "acc-td",
        entityId: "entity-personal",
        nickname: "TD Checking x4821",
        accountType: "checking",
        minimumBalance: new Decimal("250"),
        currentBalance: new Decimal("200"), // already below minimum
        currentBalanceAt: new Date(),
        minimumBalanceFee: new Decimal("15"),
        scheduledTransfersFrom: [],
        scheduledTransfersTo: [],
        incomeSources: [],
      },
    ]);
    mockDb.transaction.findFirst.mockResolvedValue(null); // no existing fee this month
    mockDb.tag.findFirst.mockResolvedValue({ id: "tag-fees", name: "Bank Fees", shortName: "Bank Fees" });
    mockDb.entity.findFirst.mockResolvedValue({ id: "entity-personal" });
    mockDb.transaction.create.mockResolvedValue({ id: "tx-fee" });
    mockDb.transactionTag.create.mockResolvedValue({ id: "tt-1" });

    const count = await checkLowBalance();

    expect(mockDb.transaction.create).toHaveBeenCalledOnce();
    expect(mockDb.notification.create).not.toHaveBeenCalled();
    expect(count).toBe(0);
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

  it("excludes a user who opted out of accrual shortfall alerts", async () => {
    const now = new Date();
    const currentMonth = now.getUTCMonth() + 1;
    const drawMonth = (currentMonth % 12) + 1;

    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { accrual_shortfall: { enabled: false } } },
      { id: "user-2", notificationPrefs: null },
    ]);
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
    expect(count).toBe(1);
    expect(userIdsFromCreateCall()).toEqual(["user-2"]);
  });

  it("does not create a notification when every user opted out", async () => {
    const now = new Date();
    const currentMonth = now.getUTCMonth() + 1;
    const drawMonth = (currentMonth % 12) + 1;

    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { accrual_shortfall: { enabled: false } } },
      { id: "user-2", notificationPrefs: { accrual_shortfall: { enabled: false } } },
    ]);
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
    expect(mockDb.notification.create).not.toHaveBeenCalled();
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
    // Regression check: an ordinary monthly bill's reminder amount is
    // unaffected by the generateBillOccurrences-based rewrite.
    expect(call.data.payload.amount).toBe("167.90");
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

  it("excludes a user who opted out of bill reminders", async () => {
    const dueDay = new Date();
    dueDay.setUTCDate(dueDay.getUTCDate() + 2);

    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { bill_due: { enabled: false, daysAhead: 3 } } },
      { id: "user-2", notificationPrefs: null },
    ]);
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
    expect(userIdsFromCreateCall()).toEqual(["user-2"]);
  });

  it("respects each user's individually configured daysAhead", async () => {
    const dueDay = new Date();
    dueDay.setUTCDate(dueDay.getUTCDate() + 5);

    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { bill_due: { enabled: true, daysAhead: 7 } } }, // 5 <= 7, met
      { id: "user-2", notificationPrefs: null }, // default daysAhead 3, 5 > 3, unmet
    ]);
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
    expect(userIdsFromCreateCall()).toEqual(["user-1"]);
  });

  it("does not create a notification when every user's daysAhead is unmet", async () => {
    const dueDay = new Date();
    dueDay.setUTCDate(dueDay.getUTCDate() + 10);

    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { bill_due: { enabled: true, daysAhead: 3 } } },
      { id: "user-2", notificationPrefs: null },
    ]);
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
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("weekly bill reminder uses the per-occurrence amount, not the monthly total", async () => {
    // Derive a payDayOfWeek exactly 2 calendar days from "now" — this works
    // for any run date via modular weekday arithmetic (see generateBillOccurrences).
    const dueDate = new Date();
    dueDate.setUTCDate(dueDate.getUTCDate() + 2);
    const dayOfWeek = dueDate.getUTCDay();

    mockDb.scheduledBill.findMany.mockResolvedValue([
      {
        id: "bill-lexus",
        payee: "Lexus Payment",
        entityId: "entity-personal",
        amountType: "static",
        autopayDay: null,
        expectedAmount: new Decimal("1083.33"), // monthly total (spec 07 item 1)
        annualBudget: null,
        frequency: "weekly",
        payDayOfWeek: dayOfWeek,
        biweeklyAnchorDate: null,
        active: true,
        entity: { id: "entity-personal", name: "Personal" },
      },
    ]);

    const count = await checkBillReminders();
    expect(count).toBe(1);
    const call = mockDb.notification.create.mock.calls[0]![0] as {
      data: { payload: Record<string, unknown> };
    };
    const amount = parseFloat(call.data.payload.amount as string);
    // 1083.33 × 12/52 ≈ 250.00 — NOT the $1,083.33 monthly total.
    expect(amount).toBeCloseTo(250.0, 1);
    expect(amount).toBeLessThan(300);
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

  it("excludes a user who opted out of anomaly alerts", async () => {
    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { anomaly: { enabled: false, multiplier: 1.5 } } },
      { id: "user-2", notificationPrefs: null },
    ]);
    mockDb.tag.findMany.mockResolvedValue([{ id: "tag-dining", shortName: "Dining Out" }]);
    mockDb.$queryRaw
      .mockResolvedValueOnce([{ tagId: "tag-dining", entityId: "entity-personal", total: "-300" }])
      .mockResolvedValueOnce([{ tagId: "tag-dining", entityId: "entity-personal", total: "-300" }]); // avg $100

    const count = await checkAnomalies("2026-06");
    expect(count).toBe(1);
    expect(userIdsFromCreateCall()).toEqual(["user-2"]);
  });

  it("respects each user's individually configured multiplier", async () => {
    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { anomaly: { enabled: true, multiplier: 2.5 } } }, // current ($300) is 3x avg ($100), met at 2.5x
      { id: "user-2", notificationPrefs: { anomaly: { enabled: true, multiplier: 3.5 } } }, // 3x < 3.5x, unmet
    ]);
    mockDb.tag.findMany.mockResolvedValue([{ id: "tag-dining", shortName: "Dining Out" }]);
    mockDb.$queryRaw
      .mockResolvedValueOnce([{ tagId: "tag-dining", entityId: "entity-personal", total: "-300" }])
      .mockResolvedValueOnce([{ tagId: "tag-dining", entityId: "entity-personal", total: "-300" }]); // avg $100 (300/3)

    const count = await checkAnomalies("2026-06");
    expect(count).toBe(1);
    expect(userIdsFromCreateCall()).toEqual(["user-1"]);
  });

  it("does not create a notification when every user's multiplier is unmet", async () => {
    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { anomaly: { enabled: true, multiplier: 5 } } },
      { id: "user-2", notificationPrefs: { anomaly: { enabled: false, multiplier: 1.5 } } },
    ]);
    mockDb.tag.findMany.mockResolvedValue([{ id: "tag-dining", shortName: "Dining Out" }]);
    mockDb.$queryRaw
      .mockResolvedValueOnce([{ tagId: "tag-dining", entityId: "entity-personal", total: "-300" }])
      .mockResolvedValueOnce([{ tagId: "tag-dining", entityId: "entity-personal", total: "-300" }]); // avg $100

    const count = await checkAnomalies("2026-06");
    expect(count).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });
});

// ── 6. Card payments due (Tester-added: shared cc_payment_due toggle) ────────
//
// checkCardPaymentsDue computes `eligibleUserIds` once, outside the per-card
// loop, and reuses it across both the "due soon" and "overdue" branches. That
// shape is different enough from the other batch-filter functions (which
// recompute per-item) that it's worth its own direct coverage rather than
// relying on code-reading alone, even though the plan scoped it out as a
// "pure-decision-module" pass-through.

describe("checkCardPaymentsDue", () => {
  it("excludes a user who opted out of cc_payment_due for the standard due-soon reminder", async () => {
    const dueDate = new Date();
    dueDate.setUTCDate(dueDate.getUTCDate() + 2);

    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { cc_payment_due: { enabled: false } } },
      { id: "user-2", notificationPrefs: null },
    ]);
    mockDb.account.findMany.mockResolvedValue([
      {
        id: "card-1",
        nickname: "Barclay Card",
        ccDueDate: dueDate,
        ccStatementBalance: new Decimal("500"),
        entity: { id: "entity-personal" },
      },
    ]);

    const count = await checkCardPaymentsDue();
    expect(count).toBe(1);
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { type: string } };
    expect(call.data.type).toBe("cc_payment_due");
    expect(userIdsFromCreateCall()).toEqual(["user-2"]);
  });

  it("applies the same shared toggle to the overdue escalation branch", async () => {
    const overdueDate = new Date();
    overdueDate.setUTCDate(overdueDate.getUTCDate() - 5);

    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { cc_payment_due: { enabled: false } } },
      { id: "user-2", notificationPrefs: null },
    ]);
    mockDb.account.findMany.mockResolvedValue([
      {
        id: "card-1",
        nickname: "Barclay Card",
        ccDueDate: overdueDate,
        ccStatementBalance: new Decimal("500"),
        entity: { id: "entity-personal" },
      },
    ]);

    const count = await checkCardPaymentsDue();
    expect(count).toBe(1);
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { type: string } };
    expect(call.data.type).toBe("cc_payment_overdue");
    expect(userIdsFromCreateCall()).toEqual(["user-2"]);
  });

  it("does not create any notification (due-soon or overdue) when every user opts out", async () => {
    const dueDate = new Date();
    dueDate.setUTCDate(dueDate.getUTCDate() + 2);

    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { cc_payment_due: { enabled: false } } },
      { id: "user-2", notificationPrefs: { cc_payment_due: { enabled: false } } },
    ]);
    mockDb.account.findMany.mockResolvedValue([
      {
        id: "card-1",
        nickname: "Barclay Card",
        ccDueDate: dueDate,
        ccStatementBalance: new Decimal("500"),
        entity: { id: "entity-personal" },
      },
    ]);

    const count = await checkCardPaymentsDue();
    expect(count).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });
});

// ── 7. Credit card funding shortfall (Tester-added) ──────────────────────────

describe("checkCcFundingShortfall", () => {
  const dueDate = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 5);
    return d;
  };

  function mockFundingScenario() {
    mockDb.account.findFirst.mockResolvedValue({
      id: "acc-funding",
      entityId: "entity-personal",
      nickname: "Credit Cards",
      currentBalance: new Decimal("100"),
      minimumBalance: new Decimal("250"),
      minimumBalanceFee: new Decimal("15"),
    });
    mockDb.account.findMany.mockResolvedValue([
      {
        id: "card-1",
        nickname: "Barclay Card",
        ccDueDate: dueDate(),
        ccStatementBalance: new Decimal("400"),
        ccMinimumPayment: null,
      },
    ]);
  }

  it("excludes a user who opted out of cc_funding_shortfall alerts", async () => {
    mockFundingScenario();
    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { cc_funding_shortfall: { enabled: false } } },
      { id: "user-2", notificationPrefs: null },
    ]);

    const count = await checkCcFundingShortfall();
    expect(count).toBe(1);
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { type: string } };
    expect(call.data.type).toBe("cc_funding_shortfall");
    expect(userIdsFromCreateCall()).toEqual(["user-2"]);
  });

  it("does not create a notification when every user opted out", async () => {
    mockFundingScenario();
    mockDb.user.findMany.mockResolvedValue([
      { id: "user-1", notificationPrefs: { cc_funding_shortfall: { enabled: false } } },
      { id: "user-2", notificationPrefs: { cc_funding_shortfall: { enabled: false } } },
    ]);

    const count = await checkCcFundingShortfall();
    expect(count).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });
});
