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
// The card projections and the funding account's scheduled flows are separate, individually tested modules;
// here they are handed in as plain data (mock at the function boundary).
vi.mock("@/lib/card-next-statement-build", () => ({ loadCardProjections: vi.fn() }));
vi.mock("@/lib/account-scheduled-flows", () => ({ loadScheduledFlows: vi.fn() }));
// Paychecks (take-home) and the Budget date index are separate, individually tested loaders: handed in as data.
vi.mock("@/lib/net-income-build", () => ({ loadNetIncomeSources: vi.fn() }));
vi.mock("@/lib/bill-dates-build", () => ({ loadBudgetScheduleIndex: vi.fn() }));

import { db } from "@/lib/db";
import { loadCardProjections } from "@/lib/card-next-statement-build";
import { loadScheduledFlows } from "@/lib/account-scheduled-flows";
import { loadNetIncomeSources } from "@/lib/net-income-build";
import { loadBudgetScheduleIndex } from "@/lib/bill-dates-build";
import { buildBudgetScheduleIndex, type BudgetScheduleRow } from "@/lib/bill-dates";
import type { CardProjection } from "@/lib/card-next-statement";
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

const mockLoadProjections = loadCardProjections as unknown as ReturnType<typeof vi.fn>;
const mockLoadFlows = loadScheduledFlows as unknown as ReturnType<typeof vi.fn>;
const mockLoadIncome = loadNetIncomeSources as unknown as ReturnType<typeof vi.fn>;
const mockLoadBudgetIndex = loadBudgetScheduleIndex as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no card projections (nothing known about payments), no scheduled flows
  mockLoadProjections.mockResolvedValue({ today: new Date(), projections: [], error: false });
  mockLoadFlows.mockResolvedValue([]);
  // Default: no paychecks, and an empty Budget date index (bills use their own records' dates)
  mockLoadIncome.mockResolvedValue([]);
  mockLoadBudgetIndex.mockResolvedValue({ index: new Map(), failed: false });
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

  it("projects paychecks with the TAKE-HOME amount from the shared loader (per account), not the gross", async () => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const day = tomorrow.getUTCDate();
    const account = {
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
          amount: new Decimal("300"),
          cadence: "monthly",
          dayRules: { dayOfMonth: day },
          purpose: "Rent",
          active: true,
        },
      ],
      scheduledTransfersTo: [],
    };
    const paycheck = (amount: string) => ({
      id: "inc-1",
      accountId: "acc-td",
      entityId: "entity-personal",
      description: "payroll (Alpine Bio Inc)",
      cadence: "monthly",
      dayRules: { dayOfMonth: day },
      amount: new Decimal(amount),
      grossAmount: new Decimal("9000"),
      amountBasis: "deposits",
      active: true,
    });
    mockDb.account.findMany.mockResolvedValue([account]);

    // take-home 100: 255 - 300 + 100 = 55, below the 250 minimum -> a low-balance notification
    mockLoadIncome.mockResolvedValue([paycheck("100")]);
    expect(await checkLowBalance()).toBe(1);
    expect(mockLoadIncome).toHaveBeenCalledWith({ where: { accountId: "acc-td" } });

    // the same source projected at 9,000 would hide the breach: this proves the loader's amount is the one used
    vi.clearAllMocks();
    mockDb.user.findMany.mockResolvedValue([{ id: "user-1", notificationPrefs: null }]);
    mockDb.notification.findFirst.mockResolvedValue(null);
    mockDb.notification.create.mockResolvedValue({ id: "n" });
    mockDb.notification.update.mockResolvedValue({});
    mockDb.account.findMany.mockResolvedValue([account]);
    mockLoadIncome.mockResolvedValue([paycheck("9000")]);
    expect(await checkLowBalance()).toBe(0);
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

/** Budget rows (monthly, the given pay day) for this month and the next, as the loader would return them. */
function budgetIndexFor(entityId: string, tagId: string, payDay: number | null) {
  const now = new Date();
  const periods = [0, 1, 2].map((k) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1)).toISOString().slice(0, 7));
  const rows: BudgetScheduleRow[] = periods.map((period) => ({
    entityId,
    tagId,
    period,
    payDay,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
  }));
  return { index: buildBudgetScheduleIndex(rows), failed: false };
}

describe("checkBillReminders - dated by the Budget row", () => {
  const taggedBill = (autopayDay: number | null) => ({
    id: "bill-solar",
    payee: "Solar",
    entityId: "entity-personal",
    budgetTagId: "tag-solar",
    budgetEntityId: "entity-personal",
    autopayDay,
    frequency: "monthly",
    amountType: "static",
    expectedAmount: new Decimal("200"),
    annualBudget: null,
    active: true,
    entity: { id: "entity-personal", name: "Personal" },
  });

  it("the query includes bills tied to a Budget line (so a bill with no day of its own can be dated by its Budget row)", async () => {
    mockDb.scheduledBill.findMany.mockResolvedValue([]);
    await checkBillReminders();
    const where = (mockDb.scheduledBill.findMany.mock.calls[0]![0] as { where: { OR: unknown[] } }).where;
    expect(where.OR).toContainEqual({ budgetTagId: { not: null } });
  });

  it("fires relative to the BUDGET date, not the bill record's later day", async () => {
    const budgetDay = new Date();
    budgetDay.setUTCDate(budgetDay.getUTCDate() + 2); // due in 2 days by the budget
    const recordDay = new Date();
    recordDay.setUTCDate(recordDay.getUTCDate() + 6); // the record says 6 days out: would NOT remind (default 3)
    mockLoadBudgetIndex.mockResolvedValue(budgetIndexFor("entity-personal", "tag-solar", budgetDay.getUTCDate()));
    mockDb.scheduledBill.findMany.mockResolvedValue([taggedBill(recordDay.getUTCDate())]);

    expect(await checkBillReminders()).toBe(1);
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { payload: Record<string, unknown> } };
    expect(String(call.data.payload.dueDate).slice(0, 10)).toBe(budgetDay.toISOString().slice(0, 10));
    expect(call.data.payload.amount).toBe("200.00");
  });

  it("with no Budget row the bill record's own day is used (unchanged behaviour)", async () => {
    const recordDay = new Date();
    recordDay.setUTCDate(recordDay.getUTCDate() + 2);
    mockDb.scheduledBill.findMany.mockResolvedValue([taggedBill(recordDay.getUTCDate())]);
    expect(await checkBillReminders()).toBe(1);
  });

  it("a tagged bill whose own day is empty is dated by its Budget row", async () => {
    const budgetDay = new Date();
    budgetDay.setUTCDate(budgetDay.getUTCDate() + 2);
    mockLoadBudgetIndex.mockResolvedValue(budgetIndexFor("entity-personal", "tag-solar", budgetDay.getUTCDate()));
    mockDb.scheduledBill.findMany.mockResolvedValue([taggedBill(null)]);
    expect(await checkBillReminders()).toBe(1);
  });

  it("no reminder when no date can be resolved (no fabricated day 1), whether the index is empty, failed or the row has no day", async () => {
    mockDb.scheduledBill.findMany.mockResolvedValue([taggedBill(null)]);
    expect(await checkBillReminders()).toBe(0);
    mockLoadBudgetIndex.mockResolvedValue({ index: new Map(), failed: true });
    expect(await checkBillReminders()).toBe(0);
    mockLoadBudgetIndex.mockResolvedValue(budgetIndexFor("entity-personal", "tag-solar", null));
    expect(await checkBillReminders()).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });
});


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

  // ── paid-statement evidence (the already-paid Barclay statement must stop alerting) ──
  const paidEvidence = { date: new Date(), amount: new Decimal("500"), rule: "payment_inflows" as const, via: "a payment received on the card" };
  const cardProjection = (over: Partial<CardProjection>): CardProjection => ({
    cardId: "card-1",
    nickname: "Barclay Card",
    entityId: "entity-personal",
    funding: null,
    onFile: { dueDate: new Date(), amount: new Decimal("500"), paid: null, isFuture: false },
    estimates: [],
    skipReasons: [],
    ...over,
  });
  const barclayRow = (dueDate: Date) => ({
    id: "card-1",
    nickname: "Barclay Card",
    ccDueDate: dueDate,
    ccStatementBalance: new Decimal("500"),
    entity: { id: "entity-personal" },
  });

  it("sends NO past-due alert for a statement the card's own payments show as paid", async () => {
    const overdueDate = new Date();
    overdueDate.setUTCDate(overdueDate.getUTCDate() - 4);
    mockDb.account.findMany.mockResolvedValue([barclayRow(overdueDate)]);
    mockLoadProjections.mockResolvedValue({
      today: new Date(),
      projections: [cardProjection({ onFile: { dueDate: overdueDate, amount: new Decimal("500"), paid: paidEvidence, isFuture: false } })],
      error: false,
    });
    expect(await checkCardPaymentsDue()).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("sends no due-soon reminder either once the statement is found paid early", async () => {
    const dueDate = new Date();
    dueDate.setUTCDate(dueDate.getUTCDate() + 2);
    mockDb.account.findMany.mockResolvedValue([barclayRow(dueDate)]);
    mockLoadProjections.mockResolvedValue({
      today: new Date(),
      projections: [cardProjection({ onFile: { dueDate, amount: new Decimal("500"), paid: paidEvidence, isFuture: true } })],
      error: false,
    });
    expect(await checkCardPaymentsDue()).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("with no payment found the past-due text says so, and never claims 'unpaid' or interest accruing", async () => {
    const overdueDate = new Date();
    overdueDate.setUTCDate(overdueDate.getUTCDate() - 4);
    mockDb.account.findMany.mockResolvedValue([barclayRow(overdueDate)]);
    mockLoadProjections.mockResolvedValue({
      today: new Date(),
      projections: [cardProjection({ onFile: { dueDate: overdueDate, amount: new Decimal("500"), paid: null, isFuture: false } })],
      error: false,
    });
    expect(await checkCardPaymentsDue()).toBe(1);
    const payload = (mockDb.notification.create.mock.calls[0]![0] as { data: { payload: { title: string; body: string } } }).data.payload;
    expect(payload.body).toContain("no matching payment was found in your synced transactions");
    expect(payload.body).toContain("$500");
    expect(`${payload.title} ${payload.body}`).not.toMatch(/unpaid|accruing|minimum/i);
  });

  it("a card with no projection because the evidence could not be loaded says it could not check, not that none was found", async () => {
    const overdueDate = new Date();
    overdueDate.setUTCDate(overdueDate.getUTCDate() - 4);
    mockDb.account.findMany.mockResolvedValue([barclayRow(overdueDate)]);
    mockLoadProjections.mockResolvedValue({ today: new Date(), projections: [], error: true });
    expect(await checkCardPaymentsDue()).toBe(1);
    const body = (mockDb.notification.create.mock.calls[0]![0] as { data: { payload: { body: string } } }).data.payload.body;
    // no search ran: it must NOT say none was found
    expect(body).toContain("payments could not be checked just now");
    expect(body).not.toContain("no matching payment was found");
    expect(body).not.toMatch(/unpaid|accruing/i);
    const title = (mockDb.notification.create.mock.calls[0]![0] as { data: { payload: { title: string } } }).data.payload.title;
    expect(title).not.toContain("no payment found");
  });
});

// ── 7. Credit card funding shortfall (Tester-added) ──────────────────────────
//
// The paying account is INFERRED (CardProjection.funding), never assumed by nickname; paid statements and rough
// estimates never notify; the account's scheduled flows are applied.

const dayOffset = (n: number): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n));
};

function projection(over: Partial<CardProjection> & { fundingAccountId?: string | null } = {}): CardProjection {
  const { fundingAccountId, ...rest } = over;
  const id = fundingAccountId === undefined ? "acc-funding" : fundingAccountId;
  return {
    cardId: "card-1",
    nickname: "Barclay Card",
    entityId: "entity-personal",
    funding: id === null ? null : { accountId: id, accountNickname: "Credit Cards", matches: 5, of: 5 },
    onFile: { dueDate: dayOffset(5), amount: new Decimal("400"), paid: null, isFuture: true },
    estimates: [],
    skipReasons: [],
    ...rest,
  };
}

const estimateRow = (confidence: "high" | "medium" | "low", amount: string, inDays = 20) => ({
  kind: "cycle_to_date" as const,
  dueDate: dayOffset(inDays),
  amount: new Decimal(amount),
  confidence,
  why: "estimated from this cycle's charges so far; the statement closes in about 2 days",
  closeDate: null,
  daysToClose: 2,
  upTo: null,
});

describe("checkCcFundingShortfall", () => {
  function mockFunding(balance = "100") {
    mockDb.account.findFirst.mockResolvedValue({
      id: "acc-funding",
      entityId: "entity-personal",
      nickname: "Credit Cards",
      currentBalance: new Decimal(balance),
      minimumBalance: new Decimal("250"),
      minimumBalanceFee: new Decimal("15"),
    });
  }
  function mockProjections(projections: CardProjection[]) {
    mockLoadProjections.mockResolvedValue({ today: new Date(), projections, error: false });
  }
  const createdBody = (): string => {
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { payload: { body: string } } };
    return call.data.payload.body;
  };

  function mockFundingScenario() {
    mockFunding("100");
    mockProjections([projection()]);
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

  it("looks up the INFERRED funding account by id, not a hard-coded nickname", async () => {
    mockFundingScenario();
    await checkCcFundingShortfall();
    const where = (mockDb.account.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where["id"]).toBe("acc-funding");
    expect(where).not.toHaveProperty("nickname");
  });

  it("a card of another entity that the account pays (Capital One) is included", async () => {
    mockFunding("500");
    mockProjections([
      projection({ cardId: "card-b", nickname: "Barclay Card", onFile: { dueDate: dayOffset(40), amount: new Decimal("1"), paid: null, isFuture: true } }),
      projection({
        cardId: "card-c",
        nickname: "Capital One",
        entityId: "entity-ekc",
        onFile: { dueDate: dayOffset(3), amount: new Decimal("792.68"), paid: null, isFuture: true },
      }),
    ]);
    expect(await checkCcFundingShortfall()).toBe(1);
    expect(createdBody()).toContain("Capital One");
    expect(createdBody()).toContain("$792.68");
  });

  it("a card whose funding account is not determined is left out entirely", async () => {
    mockFunding("100");
    mockProjections([projection({ fundingAccountId: null })]);
    expect(await checkCcFundingShortfall()).toBe(0);
    expect(mockDb.account.findFirst).not.toHaveBeenCalled();
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("a statement already found paid is not counted", async () => {
    mockFunding("100");
    mockProjections([
      projection({ onFile: { dueDate: dayOffset(2), amount: new Decimal("623.19"), paid: { date: dayOffset(-1), amount: new Decimal("623.19"), rule: "payment_inflows", via: "x" }, isFuture: true } }),
    ]);
    expect(await checkCcFundingShortfall()).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("a high-confidence estimate can trigger the alert and is described as an estimate", async () => {
    mockFunding("500");
    mockProjections([projection({ onFile: null, estimates: [estimateRow("high", "2914.91")] })]);
    expect(await checkCcFundingShortfall()).toBe(1);
    const body = createdBody();
    expect(body).toContain("expected statement payment of about $2,914.91");
    expect(body).toContain("an estimate");
    expect(body).not.toContain("statement due balance");
    const payload = (mockDb.notification.create.mock.calls[0]![0] as { data: { payload: Record<string, unknown> } }).data.payload;
    expect(payload["estimatedTotalDue"]).toBe("2914.91");
  });

  it("a rough (low-confidence) estimate never triggers a notification", async () => {
    mockFunding("500");
    mockProjections([projection({ onFile: null, estimates: [estimateRow("low", "2914.91")] })]);
    expect(await checkCcFundingShortfall()).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("scheduled money moving into the account is applied, so a planned transfer is not a shortfall", async () => {
    mockFunding("500");
    mockProjections([projection({ onFile: null, estimates: [estimateRow("medium", "2000", 10)] })]);
    mockLoadFlows.mockResolvedValue([{ date: dayOffset(5), amount: new Decimal("3000") }]);
    expect(await checkCcFundingShortfall()).toBe(0);
    expect(mockLoadFlows).toHaveBeenCalledWith("acc-funding", expect.any(Date), expect.any(Date));
  });

  it("nothing is sent when the projections could not be loaded", async () => {
    mockFunding("100");
    mockLoadProjections.mockResolvedValue({ today: new Date(), projections: [], error: true });
    expect(await checkCcFundingShortfall()).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("no notification text mentions a minimum payment", async () => {
    mockFundingScenario();
    await checkCcFundingShortfall();
    expect(createdBody().toLowerCase()).not.toContain("minimum payment");
  });

  it("when the scheduled flows cannot be read the alert is SKIPPED for that account (it could over-report), and nothing throws", async () => {
    mockFunding("500");
    mockProjections([projection({ onFile: null, estimates: [estimateRow("high", "2914.91")] })]);
    mockLoadFlows.mockResolvedValue(null);
    await expect(checkCcFundingShortfall()).resolves.toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("an account whose flows are unavailable does not stop another account's alert", async () => {
    mockDb.account.findFirst.mockImplementation(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      entityId: "entity-personal",
      nickname: args.where.id === "acc-a" ? "Account A" : "Account B",
      currentBalance: new Decimal("100"),
      minimumBalance: new Decimal("250"),
      minimumBalanceFee: new Decimal("15"),
    }));
    mockProjections([
      projection({ cardId: "c-a", nickname: "Card A", fundingAccountId: "acc-a" }),
      projection({ cardId: "c-b", nickname: "Card B", fundingAccountId: "acc-b" }),
    ]);
    mockLoadFlows.mockImplementation(async (id: string) => (id === "acc-a" ? null : []));
    expect(await checkCcFundingShortfall()).toBe(1);
    const payload = (mockDb.notification.create.mock.calls[0]![0] as { data: { payload: { fundingAccountNickname: string } } }).data.payload;
    expect(payload.fundingAccountNickname).toBe("Account B");
  });
});
