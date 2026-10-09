import { describe, expect, it, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

// TESTER-authored (pipeline task: credit-card-full-pay). The DB-aware loaders at the db boundary: read-only calls,
// explicit selects, scoping, the Barclay / jetBlue shapes end to end, and fail-soft behaviour.

vi.mock("@/lib/db", () => ({
  db: {
    account: { findMany: vi.fn() },
    transaction: { findMany: vi.fn() },
    scheduledTransfer: { findMany: vi.fn() },
    incomeSource: { findMany: vi.fn() },
    scheduledBill: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { loadCardProjections } from "@/lib/card-next-statement-build";
import { loadScheduledFlows } from "@/lib/account-scheduled-flows";

type Fn = ReturnType<typeof vi.fn>;
const mdb = db as unknown as {
  account: { findMany: Fn };
  transaction: { findMany: Fn };
  scheduledTransfer: { findMany: Fn };
  incomeSource: { findMany: Fn };
  scheduledBill: { findMany: Fn };
};

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const D = (s: string) => new Decimal(s);
// 2026-10-09 15:00 UTC = 11:00 in New York, the same calendar day
const NOW = new Date("2026-10-09T15:00:00Z");

function cardTx(accountId: string, date: string, amount: string, payee: string, pending = false) {
  return { accountId, postedAt: d(date), amount: D(amount), payeeNormalized: payee, payeeRaw: payee.toUpperCase(), pending };
}

function barclayRows() {
  const pays = [["2026-05-04", "1534.00"], ["2026-06-04", "2038.00"], ["2026-07-04", "1525.00"], ["2026-08-04", "521.40"], ["2026-09-04", "521.40"], ["2026-10-04", "623.19"]] as const;
  const card = [
    ...pays.map(([dt, a]) => cardTx("card-b", dt, a, "payment received")),
    cardTx("card-b", "2026-03-30", "-20.00", "coffee"),
    cardTx("card-b", "2026-09-28", "-2291.72", "uk trip"),
    cardTx("card-b", "2026-10-07", "-100.00", "pending shop", true),
  ];
  const bank = pays.map(([dt, a]) => ({
    accountId: "acct-cc",
    postedAt: new Date(d(dt).getTime() + 86_400_000),
    amount: D(a).negated(),
    payeeNormalized: "barclays",
    payeeRaw: "Barclays",
    account: { nickname: "Credit Cards" },
  }));
  return { card, bank };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("loadCardProjections", () => {
  it("end to end on a Barclay-shaped history: paid on-file statement, funding account inferred, open cycle estimated; reads only, with explicit selects", async () => {
    const { card, bank } = barclayRows();
    mdb.account.findMany.mockResolvedValue([
      { id: "card-b", nickname: "Barclay", entityId: "ent-p", currentBalance: D("2914.91"), currentBalanceAt: NOW, ccDueDate: d("2026-10-05"), ccStatementBalance: D("623.19") },
    ]);
    mdb.transaction.findMany.mockResolvedValueOnce(card).mockResolvedValueOnce(bank);
    const r = await loadCardProjections({ now: NOW });
    expect(r.error).toBe(false);
    expect(r.today.toISOString().slice(0, 10)).toBe("2026-10-09");
    const p = r.projections[0]!;
    expect(p.funding).toMatchObject({ accountId: "acct-cc", accountNickname: "Credit Cards" });
    expect(p.onFile?.paid?.rule).toBe("payment_inflows");
    const cycle = p.estimates.find((e) => e.kind === "cycle_to_date")!;
    expect(cycle.amount.toFixed(2)).toBe("2914.91");
    expect(cycle.dueDate.toISOString().slice(0, 10)).toBe("2026-11-05");
    expect(cycle.confidence).toBe("medium"); // this fixture's history cannot pin the close lag, so the 25-day assumption caps it at medium (D3)

    // read-only: only findMany was ever available/used, with explicit selects and the soft-delete guards
    const acctArgs = mdb.account.findMany.mock.calls[0]![0] as { where: Record<string, unknown>; select: Record<string, boolean> };
    expect(acctArgs.where).toMatchObject({ accountType: "credit_card", archivedAt: null });
    expect(Object.keys(acctArgs.select).sort()).toEqual(["ccDueDate", "ccStatementBalance", "currentBalance", "currentBalanceAt", "entityId", "id", "nickname"]);
    const txArgs = mdb.transaction.findMany.mock.calls[0]![0] as { where: Record<string, unknown>; select: Record<string, unknown> };
    expect(txArgs.where).toMatchObject({ archivedAt: null });
    expect(txArgs.select).toBeDefined();
    const bankArgs = mdb.transaction.findMany.mock.calls[1]![0] as { where: Record<string, unknown>; select: Record<string, unknown> };
    expect(bankArgs.where).toMatchObject({ archivedAt: null, pending: false, account: { archivedAt: null, accountType: { in: ["checking", "savings"] } } });
    expect(bankArgs.select).toBeDefined();
    // the history window is 200 days back from the New York calendar date
    const since = (txArgs.where["postedAt"] as { gte: Date }).gte;
    expect(since.toISOString().slice(0, 10)).toBe("2026-03-23");
  });

  it("jetBlue is funded from Primary Checking when that is where the same-cent payments left", async () => {
    const pays = [["2026-05-12", "282.00"], ["2026-06-12", "81.00"], ["2026-07-12", "21.00"], ["2026-08-12", "46.00"]] as const;
    mdb.account.findMany.mockResolvedValue([
      { id: "card-j", nickname: "jetBlue", entityId: "ent-p", currentBalance: D("72.52"), currentBalanceAt: NOW, ccDueDate: d("2026-10-12"), ccStatementBalance: D("51.26") },
    ]);
    mdb.transaction.findMany
      .mockResolvedValueOnce([...pays.map(([dt, a]) => cardTx("card-j", dt, a, "payment received")), cardTx("card-j", "2026-04-12", "-5.00", "x")])
      .mockResolvedValueOnce(pays.map(([dt, a]) => ({ accountId: "acct-pc", postedAt: d(dt), amount: D(a).negated(), payeeNormalized: "barclays", payeeRaw: "Barclays", account: { nickname: "Primary Checking" } })));
    const r = await loadCardProjections({ now: NOW });
    expect(r.projections[0]!.funding?.accountNickname).toBe("Primary Checking");
    expect(r.projections[0]!.onFile?.paid).toBeNull(); // unpaid, due Oct 12
    expect(r.projections[0]!.estimates.find((e) => e.kind === "cycle_to_date")?.amount.toFixed(2)).toBe("21.26");
  });

  it("no cards: no projections, no transaction reads at all", async () => {
    mdb.account.findMany.mockResolvedValue([]);
    const r = await loadCardProjections({ now: NOW });
    expect(r).toMatchObject({ projections: [], error: false });
    expect(mdb.transaction.findMany).not.toHaveBeenCalled();
  });

  it("any database error is fail-soft: empty projections, error flag, and the log carries the error NAME only", async () => {
    const boom = new Error("password authentication failed for user postgres at 10.0.0.1 account 1234567890");
    boom.name = "PrismaClientKnownRequestError";
    mdb.account.findMany.mockRejectedValue(boom);
    const r = await loadCardProjections({ now: NOW });
    expect(r).toMatchObject({ projections: [], error: true });
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).toContain("PrismaClientKnownRequestError");
    expect(logged).not.toContain("password");
    expect(logged).not.toContain("1234567890");
    // a rejected second read is also contained
    mdb.account.findMany.mockResolvedValue([{ id: "c", nickname: "C", entityId: "e", currentBalance: null, currentBalanceAt: null, ccDueDate: null, ccStatementBalance: null }]);
    mdb.transaction.findMany.mockRejectedValue(new Error("x"));
    expect((await loadCardProjections({ now: NOW })).error).toBe(true);
  });

  it("a card with no balance, no due date and no rows yields reasons and no numbers (nothing fabricated)", async () => {
    mdb.account.findMany.mockResolvedValue([{ id: "c", nickname: "New Card", entityId: "e", currentBalance: null, currentBalanceAt: null, ccDueDate: null, ccStatementBalance: null }]);
    mdb.transaction.findMany.mockResolvedValue([]);
    const r = await loadCardProjections({ now: NOW });
    const p = r.projections[0]!;
    expect(p.estimates).toEqual([]);
    expect(p.onFile).toBeNull();
    expect(p.funding).toBeNull();
    expect(p.skipReasons.length).toBeGreaterThan(0);
  });

  it("cards of different entities stay on their own entity id", async () => {
    mdb.account.findMany.mockResolvedValue([
      { id: "c1", nickname: "A", entityId: "ent-p", currentBalance: D("10"), currentBalanceAt: NOW, ccDueDate: d("2026-10-12"), ccStatementBalance: D("10") },
      { id: "c2", nickname: "B", entityId: "ent-ek", currentBalance: D("20"), currentBalanceAt: NOW, ccDueDate: d("2026-10-12"), ccStatementBalance: D("20") },
    ]);
    mdb.transaction.findMany.mockResolvedValue([]);
    const r = await loadCardProjections({ now: NOW });
    expect(r.projections.map((p) => [p.nickname, p.entityId])).toEqual([["A", "ent-p"], ["B", "ent-ek"]]);
  });
});

describe("loadScheduledFlows", () => {
  it("is read-only, filters to the one account, and signs inflows positive / outflows negative", async () => {
    mdb.scheduledTransfer.findMany.mockResolvedValue([
      { id: "t1", fromAccountId: "acct-pc", toAccountId: "acct-cc", amount: D("500"), cadence: "monthly", dayRules: { dayOfMonth: 20 }, purpose: "Top-up", active: true },
      { id: "t2", fromAccountId: "acct-x", toAccountId: "acct-y", amount: D("999"), cadence: "monthly", dayRules: { dayOfMonth: 20 }, purpose: "Other", active: true },
    ]);
    mdb.incomeSource.findMany.mockResolvedValue([]);
    mdb.scheduledBill.findMany.mockResolvedValue([]);
    const flowsCc = await loadScheduledFlows("acct-cc", d("2026-10-09"), d("2026-11-09"));
    expect(flowsCc!.map((f) => [f.date.toISOString().slice(0, 10), f.amount.toFixed(2)])).toEqual([["2026-10-20", "500.00"]]);
    const flowsPc = await loadScheduledFlows("acct-pc", d("2026-10-09"), d("2026-11-09"));
    expect(flowsPc!.map((f) => f.amount.toFixed(2))).toEqual(["-500.00"]);
    // explicit selects on every read
    for (const m of [mdb.scheduledTransfer, mdb.incomeSource, mdb.scheduledBill]) {
      expect((m.findMany.mock.calls[0]![0] as { select?: unknown }).select).toBeDefined();
    }
  });
});
