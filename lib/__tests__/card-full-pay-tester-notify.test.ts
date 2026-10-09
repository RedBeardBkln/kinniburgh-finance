import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

// TESTER-authored (pipeline task: credit-card-full-pay). Notification semantics at the function boundary: honest
// wording for paid statements, no alert storms (scopeKey / alreadyNotifiedToday), estimates gate, multi-account.

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
vi.mock("@/lib/card-next-statement-build", () => ({ loadCardProjections: vi.fn() }));
vi.mock("@/lib/account-scheduled-flows", () => ({ loadScheduledFlows: vi.fn() }));

import { db } from "@/lib/db";
import { loadCardProjections } from "@/lib/card-next-statement-build";
import { loadScheduledFlows } from "@/lib/account-scheduled-flows";
import type { CardProjection } from "@/lib/card-next-statement";
import { checkCardPaymentsDue, checkCcFundingShortfall } from "@/lib/notifications";

type Fn = ReturnType<typeof vi.fn>;
const mockDb = db as unknown as {
  account: { findMany: Fn; findFirst: Fn };
  notification: { findFirst: Fn; create: Fn; update: Fn };
  user: { findMany: Fn };
};
const mockLoad = loadCardProjections as unknown as Fn;
const mockFlows = loadScheduledFlows as unknown as Fn;

const dayOffset = (n: number): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n));
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoad.mockResolvedValue({ today: new Date(), projections: [], error: false });
  mockFlows.mockResolvedValue([]);
  mockDb.notification.findFirst.mockResolvedValue(null);
  mockDb.user.findMany.mockResolvedValue([{ id: "u1", notificationPrefs: null }]);
  mockDb.notification.create.mockResolvedValue({ id: "n1" });
  mockDb.notification.update.mockResolvedValue({});
});

function proj(over: Partial<CardProjection> & { acct?: string | null } = {}): CardProjection {
  const { acct, ...rest } = over;
  const id = acct === undefined ? "acc-cc" : acct;
  return {
    cardId: "card-1",
    nickname: "Barclay",
    entityId: "ent-p",
    funding: id === null ? null : { accountId: id, accountNickname: id, matches: 6, of: 6 },
    onFile: { dueDate: dayOffset(3), amount: new Decimal("800"), paid: null, isFuture: true },
    estimates: [],
    skipReasons: [],
    ...rest,
  };
}
const est = (confidence: "high" | "medium" | "low", amount: string, inDays: number) => ({
  kind: "cycle_to_date" as const,
  dueDate: dayOffset(inDays),
  amount: new Decimal(amount),
  confidence,
  why: "based on this cycle's charges so far",
  closeDate: null,
  daysToClose: 2,
  upTo: null,
});
const paid = { date: dayOffset(-1), amount: new Decimal("800"), rule: "payment_inflows" as const, via: "a payment received on the card" };

function fundingAccount(id: string, balance: string, nickname = id) {
  return { id, entityId: "ent-p", nickname, accountType: "checking", currentBalance: new Decimal(balance), minimumBalance: new Decimal("250"), minimumBalanceFee: new Decimal("15") };
}
const payloads = () => mockDb.notification.create.mock.calls.map((c) => (c[0] as { data: { payload: Record<string, unknown>; type: string } }).data);

describe("checkCcFundingShortfall: alert storms and account separation", () => {
  it("two paying accounts that both fall short produce two notifications with DIFFERENT scope keys", async () => {
    mockDb.account.findFirst.mockImplementation(async (a: { where: { id: string } }) => fundingAccount(a.where.id, "100"));
    mockLoad.mockResolvedValue({
      today: new Date(),
      error: false,
      projections: [proj({ cardId: "c1", nickname: "Barclay", acct: "acc-cc" }), proj({ cardId: "c2", nickname: "jetBlue", acct: "acc-pc" })],
    });
    expect(await checkCcFundingShortfall()).toBe(2);
    const keys = payloads().map((p) => p.payload["scopeKey"]);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain("cc_funding:acc-cc:short");
    expect(keys).toContain("cc_funding:acc-pc:short");
    // each message names only its own card
    const byKey = Object.fromEntries(payloads().map((p) => [p.payload["scopeKey"] as string, p.payload["body"] as string]));
    expect(byKey["cc_funding:acc-cc:short"]).toContain("Barclay");
    expect(byKey["cc_funding:acc-cc:short"]).not.toContain("jetBlue");
    expect(byKey["cc_funding:acc-pc:short"]).toContain("jetBlue");
    expect(byKey["cc_funding:acc-pc:short"]).not.toContain("Barclay");
  });

  it("an alert already sent today for the scope key is not repeated (and the lookup uses that exact key)", async () => {
    mockDb.account.findFirst.mockResolvedValue(fundingAccount("acc-cc", "100"));
    mockLoad.mockResolvedValue({ today: new Date(), error: false, projections: [proj()] });
    mockDb.notification.findFirst.mockResolvedValue({ id: "old" });
    expect(await checkCcFundingShortfall()).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
    const where = (mockDb.notification.findFirst.mock.calls[0]![0] as { where: { payload: { equals: string } } }).where;
    expect(where.payload.equals).toBe("cc_funding:acc-cc:short");
  });

  it("the deeper second dip (on-file Capital One now, high Barclay estimate later) is reported with the whole amount, not only the first dip", async () => {
    mockDb.account.findFirst.mockResolvedValue(fundingAccount("acc-cc", "499.09"));
    mockLoad.mockResolvedValue({
      today: new Date(),
      error: false,
      projections: [
        proj({ cardId: "cap", nickname: "Capital One", entityId: "ent-ek", onFile: { dueDate: dayOffset(3), amount: new Decimal("792.68"), paid: null, isFuture: true } }),
        proj({ cardId: "bar", nickname: "Barclay", onFile: null, estimates: [est("high", "2914.91", 27)] }),
      ],
    });
    expect(await checkCcFundingShortfall()).toBe(1);
    const body = payloads()[0]!.payload["body"] as string;
    expect(body).toContain("Please transfer $543.59");
    expect(body).toContain("keeps falling");
    expect(body).toContain("$3,458.50");
    expect(body).toContain("Estimated amounts are not final");
    expect(body).not.toMatch(/unpaid|minimum payment|accru/i);
  });

  it("a low estimate beside an on-file statement: only the on-file statement is analysed and described", async () => {
    mockDb.account.findFirst.mockResolvedValue(fundingAccount("acc-cc", "800"));
    mockLoad.mockResolvedValue({
      today: new Date(),
      error: false,
      projections: [proj({ onFile: { dueDate: dayOffset(3), amount: new Decimal("400"), paid: null, isFuture: true }, estimates: [est("low", "9000", 20)] })],
    });
    expect(await checkCcFundingShortfall()).toBe(0); // 800-400 = 400 is covered; the 9,000 low estimate is ignored
  });

  it("a low estimate alone cannot make the account short, and does not appear in the payload of an alert caused by something else", async () => {
    mockDb.account.findFirst.mockResolvedValue(fundingAccount("acc-cc", "300"));
    mockLoad.mockResolvedValue({
      today: new Date(),
      error: false,
      projections: [proj({ onFile: { dueDate: dayOffset(3), amount: new Decimal("200"), paid: null, isFuture: true }, estimates: [est("low", "9000", 20)] })],
    });
    expect(await checkCcFundingShortfall()).toBe(1); // 300-200=100 below the 250 minimum (the on-file statement alone)
    const p = payloads()[0]!.payload;
    expect(p["estimatedTotalDue"]).toBe("0.00");
    expect(JSON.stringify(p)).not.toContain("9000");
    expect(p["status"]).toBe("shortfall");
  });

  it("a funding account that is not a checking account with a minimum (the lookup finds none) sends nothing", async () => {
    mockDb.account.findFirst.mockResolvedValue(null);
    mockLoad.mockResolvedValue({ today: new Date(), error: false, projections: [proj()] });
    expect(await checkCcFundingShortfall()).toBe(0);
    const where = (mockDb.account.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ accountType: "checking", archivedAt: null, minimumBalance: { not: null } });
  });

  it("estimate on the dates after the 30-day horizon never counts", async () => {
    mockDb.account.findFirst.mockResolvedValue(fundingAccount("acc-cc", "300"));
    mockLoad.mockResolvedValue({ today: new Date(), error: false, projections: [proj({ onFile: null, estimates: [est("high", "9000", 30)] })] });
    expect(await checkCcFundingShortfall()).toBe(0);
    mockLoad.mockResolvedValue({ today: new Date(), error: false, projections: [proj({ onFile: null, estimates: [est("high", "9000", 29)] })] });
    expect(await checkCcFundingShortfall()).toBe(1);
  });

  it("the load flag `error: true` sends nothing even when projections are present", async () => {
    mockDb.account.findFirst.mockResolvedValue(fundingAccount("acc-cc", "10"));
    mockLoad.mockResolvedValue({ today: new Date(), error: true, projections: [proj()] });
    expect(await checkCcFundingShortfall()).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });
});

describe("checkCardPaymentsDue: paid evidence and wording", () => {
  const cardRow = (dueOffset: number, over: Record<string, unknown> = {}) => ({
    id: "card-1",
    nickname: "Barclay",
    entityId: "ent-p",
    ccDueDate: dayOffset(dueOffset),
    ccStatementBalance: new Decimal("623.19"),
    entity: { id: "ent-p", name: "Personal" },
    ...over,
  });

  it("a paid statement sends neither the reminder (due in 2 days) nor the past-due alert (due 4 days ago)", async () => {
    for (const off of [2, 1, 0, -1, -4, -10]) {
      mockDb.account.findMany.mockResolvedValue([cardRow(off)]);
      mockLoad.mockResolvedValue({ today: new Date(), error: false, projections: [proj({ onFile: { dueDate: dayOffset(off), amount: new Decimal("623.19"), paid, isFuture: off >= 0 } })] });
      expect(await checkCardPaymentsDue()).toBe(0);
    }
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("an unpaid past-due statement alerts once with honest 'no payment found' wording (never 'unpaid' or 'interest')", async () => {
    mockDb.account.findMany.mockResolvedValue([cardRow(-4)]);
    mockLoad.mockResolvedValue({ today: new Date(), error: false, projections: [proj({ onFile: { dueDate: dayOffset(-4), amount: new Decimal("623.19"), paid: null, isFuture: false } })] });
    expect(await checkCardPaymentsDue()).toBe(1);
    const p = payloads()[0]!.payload;
    expect(`${p["title"]} ${p["body"]}`).not.toMatch(/unpaid|interest|accru|minimum/i);
    expect(String(p["body"])).toContain("no matching payment was found");
    expect(String(p["scopeKey"])).toMatch(/^card_overdue:card-1:\d{4}-\d{2}-\d{2}$/);
  });

  it("the past-due alert is not repeated when already sent today (same scope key)", async () => {
    mockDb.account.findMany.mockResolvedValue([cardRow(-4)]);
    mockDb.notification.findFirst.mockResolvedValue({ id: "old" });
    expect(await checkCardPaymentsDue()).toBe(0);
    expect(mockDb.notification.create).not.toHaveBeenCalled();
  });

  it("a projection for ANOTHER card never suppresses this card's alert", async () => {
    mockDb.account.findMany.mockResolvedValue([cardRow(-4)]);
    mockLoad.mockResolvedValue({ today: new Date(), error: false, projections: [proj({ cardId: "someone-else", onFile: { dueDate: dayOffset(-4), amount: new Decimal("623.19"), paid, isFuture: false } })] });
    expect(await checkCardPaymentsDue()).toBe(1);
  });
});

describe("checkCcFundingShortfall: tight cushion, payload flags and entity (survivors of the first mutation pass)", () => {
  it("a tight cushion (under $50 above the minimum after the payments) alerts with the 'risk' scope key", async () => {
    // 700 - 400 = 300, which is 50 above the 250 minimum: not tight. 690 - 400 = 290: 40 above: tight.
    mockDb.account.findFirst.mockResolvedValue(fundingAccount("acc-cc", "700"));
    mockLoad.mockResolvedValue({ today: new Date(), error: false, projections: [proj({ onFile: { dueDate: dayOffset(3), amount: new Decimal("400"), paid: null, isFuture: true } })] });
    expect(await checkCcFundingShortfall()).toBe(0);
    mockDb.account.findFirst.mockResolvedValue(fundingAccount("acc-cc", "690"));
    expect(await checkCcFundingShortfall()).toBe(1);
    const p = payloads()[0]!.payload;
    expect(p["status"]).toBe("at_risk");
    expect(p["scopeKey"]).toBe("cc_funding:acc-cc:risk");
    expect(String(p["body"])).toContain("less than $50 of cushion");
  });

  it("payload marks which cards are estimates, and the notification belongs to the FUNDING account's entity (not the card's)", async () => {
    mockDb.account.findFirst.mockResolvedValue({ ...fundingAccount("acc-cc", "100"), entityId: "ent-personal-funding" });
    mockLoad.mockResolvedValue({
      today: new Date(),
      error: false,
      projections: [
        proj({ cardId: "cap", nickname: "Capital One", entityId: "ent-ek", onFile: { dueDate: dayOffset(3), amount: new Decimal("792.68"), paid: null, isFuture: true }, estimates: [est("medium", "72.56", 25)] }),
      ],
    });
    expect(await checkCcFundingShortfall()).toBe(1);
    const call = mockDb.notification.create.mock.calls[0]![0] as { data: { entity?: unknown; entityId?: string; payload: { cards: { nickname: string; estimated: boolean; statementBalance: string }[] } } };
    expect(JSON.stringify(call.data)).toContain("ent-personal-funding");
    expect(JSON.stringify(call.data)).not.toContain("ent-ek");
    const cards = call.data.payload.cards;
    expect(cards.map((c) => [c.statementBalance, c.estimated])).toEqual([["792.68", false], ["72.56", true]]);
  });
});
