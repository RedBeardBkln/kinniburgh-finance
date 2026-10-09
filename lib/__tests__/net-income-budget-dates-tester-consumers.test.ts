// TESTER (net-income-budget-dates): consumer-level probes with the database boundary mocked. Covers reminders,
// low-balance, loader fail-soft behaviour and ledger edge cases the Coder's tests do not pin.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    budget: { findMany: vi.fn() },
    account: { findMany: vi.fn(), findFirst: vi.fn() },
    accrualEnvelope: { findMany: vi.fn() },
    scheduledBill: { findMany: vi.fn() },
    notification: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn() },
    incomeSource: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() },
    paystub: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/web-push", () => ({ sendPushToUser: vi.fn() }));
vi.mock("@/lib/gl-code-resolver", () => ({ autoAssignGlCodes: vi.fn() }));
vi.mock("@/lib/card-next-statement-build", () => ({ loadCardProjections: vi.fn() }));
vi.mock("@/lib/account-scheduled-flows", () => ({ loadScheduledFlows: vi.fn() }));

import { db } from "@/lib/db";
import { loadCardProjections } from "@/lib/card-next-statement-build";
import { loadScheduledFlows } from "@/lib/account-scheduled-flows";
import { checkBillReminders, checkLowBalance } from "@/lib/notifications";
import { loadNetIncomeSources, loadNetIncomeSourcesSafe } from "@/lib/net-income-build";
import { loadBudgetScheduleIndex } from "@/lib/bill-dates-build";
import { buildUpcomingLedger, type UpcomingBillRow, type UpcomingBudgetRow } from "@/lib/upcoming-ledger";

type Fn = ReturnType<typeof vi.fn>;
const mdb = db as unknown as {
  budget: { findMany: Fn };
  account: { findMany: Fn };
  scheduledBill: { findMany: Fn };
  notification: { findFirst: Fn; create: Fn; update: Fn };
  user: { findMany: Fn };
  incomeSource: { findMany: Fn };
  transaction: { findMany: Fn };
  paystub: { findMany: Fn };
};

const DAY = 86400000;
const todayUtc = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};

beforeEach(() => {
  vi.clearAllMocks();
  (loadCardProjections as unknown as Fn).mockResolvedValue({ today: new Date(), projections: [], error: false });
  (loadScheduledFlows as unknown as Fn).mockResolvedValue([]);
  mdb.notification.findFirst.mockResolvedValue(null);
  mdb.notification.create.mockResolvedValue({ id: "n1" });
  mdb.notification.update.mockResolvedValue({});
  mdb.user.findMany.mockResolvedValue([{ id: "u1", notificationPrefs: null }]);
  mdb.budget.findMany.mockResolvedValue([]);
  mdb.transaction.findMany.mockResolvedValue([]);
  mdb.paystub.findMany.mockResolvedValue([]);
  mdb.incomeSource.findMany.mockResolvedValue([]);
});

// ── reminders: real loaders over a mocked db (so the Budget index is built by the real code) ────────────────

const bill = (over: Record<string, unknown> = {}) => ({
  id: "solar",
  payee: "Solar",
  entityId: "E1",
  budgetTagId: "T1",
  budgetEntityId: "E1",
  autopayDay: 17,
  frequency: "monthly",
  amountType: "static",
  expectedAmount: new Decimal("505.70"),
  annualBudget: null,
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  active: true,
  entity: { id: "E1", name: "Personal" },
  ...over,
});
const budgetRow = (period: string, payDay: number | null, over: Record<string, unknown> = {}) => ({
  entityId: "E1",
  tagId: "T1",
  period,
  payDay,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  annualAmountDue: null,
  ...over,
});
const periodsFrom = (n: number) => {
  const t = todayUtc();
  return Array.from({ length: n }, (_, k) => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + k, 1)).toISOString().slice(0, 7));
};

describe("checkBillReminders with the REAL Budget index loader over a mocked db", () => {
  it("a Budget day that has already passed this month does not remind for the later record day (the Budget date wins)", async () => {
    const t = todayUtc();
    // Skip the awkward calendar corners where today-2 or today+1 leaves the month.
    if (t.getUTCDate() < 4 || t.getUTCDate() > 26) return;
    const budgetDay = t.getUTCDate() - 2;
    const recordDay = t.getUTCDate() + 1; // would remind (default look-ahead 3) if the record date were used
    mdb.scheduledBill.findMany.mockResolvedValue([bill({ autopayDay: recordDay })]);
    mdb.budget.findMany.mockResolvedValue(periodsFrom(3).map((p) => budgetRow(p, budgetDay)));
    // next occurrence is next month's Budget day (> 3 days away): no reminder today
    expect(await checkBillReminders()).toBe(0);
    expect(mdb.notification.create).not.toHaveBeenCalled();
  });

  it("the look-ahead boundary: a Budget date 3 days away reminds, 4 days away does not (record day irrelevant)", async () => {
    const t = todayUtc();
    if (t.getUTCDate() > 24) return;
    for (const [ahead, expected] of [[3, 1], [4, 0]] as const) {
      mdb.notification.create.mockClear();
      const day = new Date(t.getTime() + ahead * DAY).getUTCDate();
      mdb.scheduledBill.findMany.mockResolvedValue([bill({ autopayDay: 1 })]);
      mdb.budget.findMany.mockResolvedValue(periodsFrom(3).map((p) => budgetRow(p, day)));
      expect(await checkBillReminders(), `ahead ${ahead}`).toBe(expected);
    }
  });

  it("a Budget read failure falls back to the record day and does not throw", async () => {
    const t = todayUtc();
    if (t.getUTCDate() > 24) return;
    mdb.budget.findMany.mockRejectedValue(new Error("db down"));
    mdb.scheduledBill.findMany.mockResolvedValue([bill({ autopayDay: new Date(t.getTime() + 2 * DAY).getUTCDate() })]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await checkBillReminders()).toBe(1);
    // only the error NAME is logged
    expect(spy.mock.calls.flat().join(" ")).not.toContain("db down");
    spy.mockRestore();
  });

  it("the loaded index asks the database only for the explicit schedule columns (no amounts)", async () => {
    mdb.scheduledBill.findMany.mockResolvedValue([bill()]);
    await checkBillReminders();
    const arg = mdb.budget.findMany.mock.calls[0]![0] as { select: Record<string, true> };
    expect(Object.keys(arg.select).sort()).toEqual(["annualAmountDue", "biweeklyAnchorDate", "entityId", "frequency", "payDay", "payDayOfWeek", "payMonth", "period", "tagId"]);
    expect(arg.select).not.toHaveProperty("budgeted");
  });
});

// ── low balance: paychecks use the loader's net amount, and a source-read failure matches the old behaviour ──────

describe("checkLowBalance with the REAL net-income loader over a mocked db", () => {
  const acct = (balance: string) => ({
    id: "A1",
    nickname: "Primary Checking",
    entityId: "E1",
    currentBalance: new Decimal(balance),
    minimumBalance: new Decimal("1000"),
    minimumBalanceFee: null,
    scheduledTransfersFrom: [],
    scheduledTransfersTo: [],
  });
  const source = (amount: string) => ({
    id: "s1",
    entityId: "E1",
    accountId: "A1",
    description: "payroll (Alpine Bio Inc)",
    cadence: "semi_monthly",
    dayRules: { daysOfMonth: [15, 31] },
    amount: new Decimal(amount),
    active: true,
  });
  const deposits = () =>
    [1, 16, 31, 46].map((d) => ({ postedAt: new Date(Date.now() - d * DAY), amount: new Decimal("6064.87"), payeeNormalized: "alpine bio inc payroll", accountId: "A1", entityId: "E1" }));

  it("reads income only through the loader (the account query no longer includes incomeSources)", async () => {
    mdb.account.findMany.mockResolvedValue([acct("5000")]);
    mdb.incomeSource.findMany.mockResolvedValue([source("9000")]);
    mdb.transaction.findMany.mockResolvedValue(deposits());
    await checkLowBalance();
    const accountArg = mdb.account.findMany.mock.calls[0]![0] as { include: Record<string, unknown> };
    expect(accountArg.include).not.toHaveProperty("incomeSources");
    expect(mdb.incomeSource.findMany).toHaveBeenCalledTimes(1);
    const where = (mdb.incomeSource.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ active: true, accountId: "A1" });
  });

  it("a deposit/paystub read failure does not reject (gross is used, flagged); the cron job keeps going", async () => {
    mdb.account.findMany.mockResolvedValue([acct("5000")]);
    mdb.incomeSource.findMany.mockResolvedValue([source("9000")]);
    mdb.transaction.findMany.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(checkLowBalance()).resolves.toBeTypeOf("number");
    spy.mockRestore();
  });

  it("OBSERVATION: a failure reading the income SOURCES themselves still rejects checkLowBalance (same as the old include)", async () => {
    mdb.account.findMany.mockResolvedValue([acct("5000")]);
    mdb.incomeSource.findMany.mockRejectedValue(new Error("source read"));
    await expect(checkLowBalance()).rejects.toThrow("source read");
  });
});

// ── net-income loader: query shape and degradation matrix ──────────────────────────────────────────────────

describe("loadNetIncomeSources degradation matrix", () => {
  const src = {
    id: "s1",
    entityId: "E1",
    accountId: "A1",
    description: "payroll (Alpine Bio Inc)",
    cadence: "semi_monthly",
    dayRules: {},
    amount: new Decimal("9000"),
    active: true,
  };
  const dep = (n: number) => ({ postedAt: new Date(Date.now() - n * DAY), amount: new Decimal("6064.87"), payeeNormalized: "alpine bio inc payroll", accountId: "A1", entityId: "E1" });

  it("deposits fine + paystub read fails -> flagged gross (observed: deposits are NOT used when the stub read fails)", async () => {
    mdb.incomeSource.findMany.mockResolvedValue([src]);
    mdb.transaction.findMany.mockResolvedValue([dep(1), dep(16), dep(31)]);
    mdb.paystub.findMany.mockRejectedValue(new Error("stub table"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const [row] = await loadNetIncomeSources();
    spy.mockRestore();
    expect(row!.amountBasis).toBe("gross_unknown");
    expect(row!.netInfo.assumption).toBe(true);
    expect(row!.netInfo.label).toContain("take-home could not be read");
    expect(row!.amount.toFixed(2)).toBe("9000.00");
    expect(row!.grossAmount.toFixed(2)).toBe("9000.00");
  });

  it("stored gross never changes; amount is replaced only on the returned row", async () => {
    mdb.incomeSource.findMany.mockResolvedValue([src]);
    mdb.transaction.findMany.mockResolvedValue([dep(1), dep(16), dep(31)]);
    const [row] = await loadNetIncomeSources();
    expect(row!.amount.toFixed(2)).toBe("6064.87");
    expect(row!.grossAmount.toFixed(2)).toBe("9000.00");
    expect(src.amount.toFixed(2)).toBe("9000.00");
  });

  it("only read calls are made on the db", async () => {
    mdb.incomeSource.findMany.mockResolvedValue([src]);
    await loadNetIncomeSources({ withAccount: true, withEntity: true });
    const names = Object.keys(mdb.incomeSource).concat(Object.keys(mdb.transaction), Object.keys(mdb.paystub));
    expect(names.every((n) => n === "findMany")).toBe(true);
    const sel = (mdb.incomeSource.findMany.mock.calls[0]![0] as { select: Record<string, unknown> }).select;
    expect(Object.keys(sel).sort()).toEqual(["account", "accountId", "active", "amount", "cadence", "dayRules", "description", "entity", "entityId", "id"]);
    const acctSel = (sel.account as { select: Record<string, true> }).select;
    expect(Object.keys(acctSel).sort()).toEqual(["mask", "nickname"]); // mask only (the last 4), never an account number
  });

  it("the safe variant returns failed:true and logs only the error name", async () => {
    mdb.incomeSource.findMany.mockRejectedValue(new Error("secret detail 4111111111111111"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await loadNetIncomeSourcesSafe();
    expect(out).toEqual({ sources: [], failed: true });
    expect(spy.mock.calls.flat().join(" ")).not.toContain("4111");
    spy.mockRestore();
  });

  it("the Budget index loader never rejects and reports failure", async () => {
    mdb.budget.findMany.mockRejectedValue(new Error("nope"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await loadBudgetScheduleIndex({ from: new Date(Date.UTC(2026, 9, 1)), to: new Date(Date.UTC(2026, 11, 1)) });
    spy.mockRestore();
    expect(out.failed).toBe(true);
    expect(out.index.size).toBe(0);
  });
});

// ── ledger edge probes ──────────────────────────────────────────────────────────────────────────────────────

describe("ledger: Budget-dated bills, edge cases", () => {
  const FROM = new Date(Date.UTC(2026, 9, 8));
  const P = "E1";
  const mkBill = (over: Partial<UpcomingBillRow> = {}): UpcomingBillRow => ({
    id: "b1",
    accountId: "a1",
    entityId: P,
    payee: "Solar",
    amountType: "static",
    expectedAmount: 200,
    autopayDay: 17,
    annualBudget: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    active: true,
    budgetTagId: "T1",
    budgetEntityId: P,
    ...over,
  });
  const mkBudget = (period: string, over: Partial<UpcomingBudgetRow> = {}): UpcomingBudgetRow => ({
    id: `bg-${period}`,
    period,
    tagId: "T1",
    tagName: "Solar",
    entityId: P,
    accountId: "a1",
    budgeted: 200,
    payDay: 14,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    ...over,
  });
  const iso = (d: Date | null) => d?.toISOString().slice(0, 10);

  it("every dated bill item date equals what the Budget-dated generator says (no stray date moves), item amounts equal the bill's", () => {
    const l = buildUpcomingLedger({ from: FROM, days: 90, bills: [mkBill()], budgets: [mkBudget("2026-10"), mkBudget("2026-11", { payDay: 20 }), mkBudget("2026-12", { payDay: null })] });
    const items = l.items.filter((i) => i.kind === "bill");
    expect(items.map((i) => iso(i.date))).toEqual(["2026-10-14", "2026-11-20", "2026-12-17"]);
    for (const i of items) expect(i.amount!.toFixed(2)).toBe("-200.00");
  });

  it("a Budget row of another frequency (annual) does not move a monthly bill; no 'Records disagree' DAY line is lost silently without a note (observation)", () => {
    const l = buildUpcomingLedger({
      from: FROM,
      days: 60,
      bills: [mkBill()],
      budgets: [mkBudget("2026-10", { frequency: "annual", payDay: 14, payMonth: 5, annualAmountDue: 2400, budgeted: 200 }), mkBudget("2026-11", { frequency: "annual", payDay: 14, payMonth: 5, annualAmountDue: 2400, budgeted: 200 })],
    });
    const items = l.items.filter((i) => i.kind === "bill");
    // the bill's own day is used
    expect(items.map((i) => iso(i.date))).toEqual(["2026-10-17", "2026-11-17"]);
    // no budget-date info line (the Budget date was NOT used)
    for (const i of items) expect(i.dateNote).toBeUndefined();
  });

  it("OBSERVATION: a bill with no day of its own, dated only by Budget rows, silently has no item for a month beyond the Budget rows (no 'Day not set' line)", () => {
    const noDay = mkBill({ autopayDay: null });
    const l = buildUpcomingLedger({ from: FROM, days: 120, bills: [noDay], budgets: [mkBudget("2026-10"), mkBudget("2026-11")] });
    const items = l.items.filter((i) => i.kind === "bill");
    expect(items.map((i) => iso(i.date))).toEqual(["2026-10-14", "2026-11-14"]);
    expect(l.undated.filter((u) => u.label === "Solar")).toEqual([]);
  });

  it("a weekly bill dated by a weekly Budget row of another weekday keeps the bill's amount per occurrence", () => {
    const wk = mkBill({ frequency: "weekly", payDayOfWeek: 1, expectedAmount: 260, autopayDay: null });
    const l = buildUpcomingLedger({ from: FROM, days: 21, bills: [wk], budgets: [mkBudget("2026-10", { frequency: "weekly", payDayOfWeek: 3, payDay: null, budgeted: 260 })] });
    const items = l.items.filter((i) => i.kind === "bill");
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const i of items) {
      expect(i.date!.getUTCDay()).toBe(3);
      expect(i.amount!.toFixed(2)).toBe("-60.00"); // 260 * 12 / 52, the generator's per-occurrence rule
    }
  });
});
