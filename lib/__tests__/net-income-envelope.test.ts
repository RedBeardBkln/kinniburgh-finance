// net-income-budget-dates: actions/envelope.ts getEnvelopeForecastData uses take-home paychecks (per account, from the
// shared loader) and Budget-dated bills; `dueDay` in billsThisMonth is the day the bill is paid THIS month (the
// budget's when it has a usable one). Mocks at the function boundary: no real database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const { envDb, loadIncome, loadIndex } = vi.hoisted(() => ({
  envDb: {
    account: { findMany: vi.fn() },
    transaction: { findFirst: vi.fn() },
  },
  loadIncome: vi.fn(),
  loadIndex: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: envDb }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn(async () => null) }));
vi.mock("@/lib/net-income-build", () => ({ loadNetIncomeSources: (...a: unknown[]) => loadIncome(...a) }));
vi.mock("@/lib/bill-dates-build", () => ({ loadBudgetScheduleIndex: (...a: unknown[]) => loadIndex(...a) }));

import { getEnvelopeForecastData } from "@/actions/envelope";
import { buildBudgetScheduleIndex } from "@/lib/bill-dates";

const now = new Date();
const periodOfMonth = (k: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1)).toISOString().slice(0, 7);

const solar = {
  id: "b1",
  accountId: "acc1",
  entityId: "ent",
  budgetTagId: "tag",
  budgetEntityId: "ent",
  payee: "Solar",
  amountType: "static",
  expectedAmount: new Decimal("200"),
  autopayDay: 17,
  annualBudget: null,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  accrualEnvelope: null,
};
const account = (balance: string) => ({
  id: "acc1",
  nickname: "Primary Checking",
  mask: "1234",
  minimumBalance: new Decimal("250"),
  minimumBalanceFee: null,
  currentBalance: new Decimal(balance),
  scheduledTransfersTo: [],
  scheduledTransfersFrom: [],
  scheduledBills: [solar],
});

beforeEach(() => {
  envDb.account.findMany.mockReset();
  envDb.transaction.findFirst.mockReset().mockResolvedValue(null);
  loadIncome.mockReset().mockResolvedValue([]);
  loadIndex.mockReset().mockResolvedValue({ index: new Map(), failed: false });
});

describe("getEnvelopeForecastData", () => {
  it("reads paychecks per account from the shared take-home loader and no longer includes incomeSources on the account", async () => {
    envDb.account.findMany.mockResolvedValue([account("5000")]);
    await getEnvelopeForecastData("taxes");
    expect(loadIncome).toHaveBeenCalledWith({ where: { accountId: "acc1" } });
    const include = (envDb.account.findMany.mock.calls[0]![0] as { include: Record<string, unknown> }).include;
    expect(include).not.toHaveProperty("incomeSources");
  });

  it("uses the loader's amount (take-home) for the projection", async () => {
    // balance 255, minimum 250: a paycheck of the loader's amount lands today-ish; a 200 bill follows. With the
    // take-home 100 the account breaches; the worst balance proves which amount was used.
    const today = new Date();
    loadIncome.mockResolvedValue([
      {
        id: "i1",
        accountId: "acc1",
        entityId: "ent",
        description: "payroll",
        cadence: "monthly",
        dayRules: { dayOfMonth: today.getUTCDate() },
        amount: new Decimal("100"),
        active: true,
      },
    ]);
    envDb.account.findMany.mockResolvedValue([{ ...account("255"), scheduledBills: [] }]);
    const [r] = await getEnvelopeForecastData("taxes");
    expect(r!.worstBalance).toBe(355); // 255 + the loader's 100 (a gross figure such as 9,000 would give 9,255)
    expect(r!.currentBalance).toBe(255);
  });

  it("bills this month: dueDay is the Budget's day when its row is usable, else the record's", async () => {
    envDb.account.findMany.mockResolvedValue([account("5000")]);
    loadIndex.mockResolvedValue({
      index: buildBudgetScheduleIndex([
        { entityId: "ent", tagId: "tag", period: periodOfMonth(0), payDay: 14, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null },
      ]),
      failed: false,
    });
    const [dated] = await getEnvelopeForecastData("taxes");
    expect(dated!.billsThisMonth[0]).toMatchObject({ payee: "Solar", dueDay: 14 });

    loadIndex.mockResolvedValue({ index: new Map(), failed: true });
    const [fallback] = await getEnvelopeForecastData("taxes");
    expect(fallback!.billsThisMonth[0]).toMatchObject({ payee: "Solar", dueDay: 17 });
  });

  it("a bill is dated by its Budget row in the projection (the breach falls on the budget day, not the record day)", async () => {
    const day = (offset: number) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
      return d;
    };
    const budgetDate = day(3);
    envDb.account.findMany.mockResolvedValue([{ ...account("300"), scheduledBills: [{ ...solar, autopayDay: day(20).getUTCDate() }] }]);
    loadIndex.mockResolvedValue({
      index: buildBudgetScheduleIndex(
        [0, 1, 2].map((k) => ({ entityId: "ent", tagId: "tag", period: periodOfMonth(k), payDay: budgetDate.getUTCDate(), frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null }))
      ),
      failed: false,
    });
    const [r] = await getEnvelopeForecastData("taxes");
    // 300 - 200 = 100, below the 250 minimum, from the first day the bill is paid
    expect(r!.firstBreachDate).toBe(budgetDate.toISOString().slice(0, 10));
  });
});
