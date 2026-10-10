// TESTER (independent): the dashboard page end to end with mocked reads -- auth first, fail-soft per widget, no secret in
// logs, links keep bucket and period -- plus the month loader's query shape (read-only, explicit select, bounds).
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Decimal } from "@prisma/client/runtime/library";

(globalThis as unknown as { React: typeof React }).React = React;

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error("REDIRECT:" + to);
  }),
  getEntityBySlug: vi.fn(),
  budgetFind: vi.fn(),
  tagFind: vi.fn(),
  accountFind: vi.fn(),
  transferFind: vi.fn(),
  recurringFind: vi.fn(),
  loadTxs: vi.fn(),
  txFind: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("next/navigation", () => ({ redirect: m.redirect, useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: m.getEntityBySlug }));
vi.mock("@/lib/db", () => ({
  db: {
    budget: { findMany: m.budgetFind },
    tag: { findMany: m.tagFind },
    account: { findMany: m.accountFind },
    scheduledTransfer: { findMany: m.transferFind },
    recurringExpense: { findMany: m.recurringFind },
    transaction: { findMany: m.txFind },
  },
}));
vi.mock("@/components/app-shell", () => ({ AppShell: (p: { children: React.ReactNode }) => p.children }));
vi.mock("@/lib/upcoming-ledger-build", () => ({ loadUpcomingLedger: vi.fn() }));
vi.mock("@/lib/upcoming-ledger-view", () => ({ toUiDetection: vi.fn(), toUiLedger: vi.fn() }));
vi.mock("@/components/upcoming/upcoming-widget", () => ({ UpcomingWidget: () => null }));
vi.mock("@/components/upcoming/upcoming-skeleton", () => ({ UpcomingWidgetSkeleton: () => null }));
vi.mock("@/actions/budgets", () => ({ updateBudgetLine: async () => ({ success: true }) }));
vi.mock("@/components/transactions/inline-tag-cell", () => ({ InlineTagCell: () => null }));
vi.mock("@/lib/month-spend-build", async (orig) => ({ ...(await orig<typeof import("@/lib/month-spend-build")>()), loadMonthTransactions: m.loadTxs }));

import DashboardPage from "@/app/page";
import { loadMonthTransactions } from "@/lib/month-spend-build";
import type { SpendTx } from "@/lib/month-spend";

const tag = (id: string, name: string, parentId: string | null) => ({ id, name, shortName: name.split(" / ").pop()!, parentId });
const TAGS = [tag("t-food", "Food & Drink", null), tag("t-groc", "Food & Drink / Groceries", "t-food"), tag("t-ccp", "Credit Cards / Credit card payment", null)];
const tx = (id: string, amount: string, tags: string[], over: Partial<SpendTx> = {}): SpendTx => ({
  id,
  day: "2026-01-10",
  amount: new Decimal(amount),
  payee: "Payee " + id,
  accountId: "acc1",
  accountNickname: "Checking",
  accountType: "checking",
  entityId: "e1",
  entityName: "Personal",
  pending: false,
  transferPairId: null,
  tagIds: tags,
  ...over,
});

function arrange() {
  m.auth.mockResolvedValue({ user: { name: "Eric" } });
  m.getEntityBySlug.mockResolvedValue({ id: "e1", name: "Personal", slug: "personal", navLabel: "Personal", type: "personal" });
  m.budgetFind.mockResolvedValue([
    { id: "b-food", tagId: "t-food", accountId: "acc1", budgeted: null, additionalAmountCents: new Decimal(0), rolloverAmount: null, account: { nickname: "Checking", entity: { name: "Personal" } } },
    { id: "b-groc", tagId: "t-groc", accountId: "acc1", budgeted: new Decimal("400.00"), additionalAmountCents: new Decimal(0), rolloverAmount: null, account: { nickname: "Checking", entity: { name: "Personal" } } },
  ]);
  m.tagFind.mockResolvedValue(TAGS);
  m.accountFind.mockResolvedValue([
    { id: "acc1", nickname: "Checking", mask: "1234", accountType: "checking", currentBalance: new Decimal("1000.50"), currentBalanceAt: new Date("2026-01-11T15:00:00Z"), institution: { name: "Test Bank" }, entity: { name: "Personal" } },
  ]);
  m.transferFind.mockResolvedValue([
    { id: "st1", amount: new Decimal("50"), cadence: "weekly", dayRules: { dayOfWeek: 5 }, purpose: "Savings", fromAccount: { nickname: "Checking" }, toAccount: { nickname: "Savings" } },
  ]);
  m.recurringFind.mockResolvedValue([]);
  m.loadTxs.mockResolvedValue([tx("1", "-120.00", ["t-groc"]), tx("2", "-30.00", []), tx("3", "-500.00", ["t-ccp"]), tx("4", "20.00", [])]);
}

async function render(search: { bucket?: string; period?: string } = { bucket: "personal", period: "2026-01" }): Promise<string> {
  const el = await DashboardPage({ searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(el as React.ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  arrange();
});

describe("tester: dashboard page", () => {
  it("renders the numbers, accounts with balance, transfers; Spent = 120 + 30 - 20 refund = 130.00 (card payment excluded)", async () => {
    const html = await render();
    expect(html).toContain("$130.00");
    expect(html).toContain("Net of $20.00 refunds");
    expect(html).toContain("Total Budgeted");
    expect(html).toContain("$400.00"); // budget (child counted once under its auto-sum parent)
    expect(html).toContain("Test Bank");
    expect(html).toContain("$1,000.50");
    expect(html).toContain("Checking");
    expect(html).toContain("Savings");
    expect(html).not.toContain("Unavailable");
    expect(m.budgetFind.mock.calls[0]![0].select).toBeDefined(); // explicit select on the allow-listed Budget read
  });

  it("auth() first: no session means a redirect and no database read at all", async () => {
    m.auth.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("REDIRECT:/login");
    for (const f of [m.budgetFind, m.tagFind, m.accountFind, m.transferFind, m.recurringFind, m.loadTxs, m.getEntityBySlug]) expect(f).not.toHaveBeenCalled();
  });

  const widgets: [string, () => void, RegExp, string[]][] = [
    ["budget lines", () => m.budgetFind.mockRejectedValue(new Error("boom postgres://user:pw@host")), /Budget lines are unavailable/, ["Test Bank", "Savings"]],
    ["month transactions", () => m.loadTxs.mockRejectedValue(new Error("boom")), /Budget lines are unavailable/, ["Test Bank", "Savings"]],
    ["tags", () => m.tagFind.mockRejectedValue(new Error("boom")), /Budget lines are unavailable/, ["Test Bank", "Savings"]],
    ["recurring", () => m.recurringFind.mockRejectedValue(new Error("boom")), /Budget lines are unavailable/, ["Test Bank", "Savings"]],
    // Once: the own-account mask read uses the same account mock and must not fail with the widget read
    ["accounts", () => m.accountFind.mockRejectedValueOnce(new Error("boom")), /Accounts are unavailable right now/, ["$130.00", "Savings"]],
    // the own-account mask read (second account read) failing makes the money numbers unavailable, never a wrong total
    ["own account masks", () => {
      const ok = m.accountFind.getMockImplementation()!;
      let calls = 0;
      m.accountFind.mockImplementation((...args: unknown[]) => (++calls === 2 ? Promise.reject(new Error("boom")) : ok(...args)));
    }, /Budget lines are unavailable/, ["Test Bank", "Savings"]],
    ["transfers", () => m.transferFind.mockRejectedValue(new Error("boom")), /Scheduled transfers are unavailable right now/, ["$130.00", "Test Bank"]],
  ];
  it.each(widgets)("one failing read (%s) blanks only its own widget, never the page, and logs no message text", async (_name, breakIt, expectText, stillThere) => {
    breakIt();
    const html = await render();
    expect(html).toMatch(expectText);
    for (const s of stillThere) expect(html).toContain(s);
    expect(html).toContain("Total Budgeted");
    expect(html).toContain("Month navigation");
    // logged with the error NAME only, never the message (a connection string, a value)
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).not.toContain("postgres://");
    expect(logged).not.toContain("boom");
    expect(logged).toContain("Error");
  });

  it("when the month numbers cannot be built the summary cards say Unavailable (not 0)", async () => {
    m.loadTxs.mockRejectedValue(new Error("x"));
    const html = await render();
    expect((html.match(/Unavailable/g) ?? []).length).toBe(3);
    expect(html).not.toMatch(/\$0\.00/);
  });

  it("links keep the bucket and period; the current month drops ?period", async () => {
    const html = await render({ bucket: "personal", period: "2026-01" });
    expect(html).toContain('href="/?bucket=personal&amp;period=2025-12"');
    expect(html).toContain('href="/?bucket=personal&amp;period=2026-02"');
    expect(html).toContain('href="/budgets?bucket=personal&amp;period=2026-01"');
    // an invalid or future period falls back to the current month, never a crash
    for (const bad of ["2999-01", "garbage", "2026-13", "2026-00", ""]) {
      const h = await render({ bucket: "personal", period: bad });
      expect(h).toContain("Month navigation");
      expect(h).toContain('href="/budgets?bucket=personal"');
    }
  });

  it("all-entities view (no entity) reads every entity and says 'all entities combined'", async () => {
    m.getEntityBySlug.mockResolvedValue(null);
    const html = await render({ bucket: "all", period: "2026-01" });
    expect(html).toContain("all entities combined");
    expect(m.budgetFind.mock.calls[0]![0].where.entityId).toBeUndefined();
    expect(m.transferFind.mock.calls[0]![0].where.fromAccount).toBeUndefined();
  });

  it("a per-entity bucket scopes budgets, accounts, scheduled transfers and recurring to that entity", async () => {
    await render();
    expect(m.budgetFind.mock.calls[0]![0].where).toEqual({ entityId: "e1", period: "2026-01" });
    expect(m.accountFind.mock.calls[0]![0].where).toEqual({ entityId: "e1", archivedAt: null });
    expect(m.transferFind.mock.calls[0]![0].where).toEqual({ active: true, fromAccount: { entityId: "e1" } });
    expect(m.recurringFind.mock.calls[0]![0].where).toEqual({ entityId: "e1" });
    expect(m.loadTxs).toHaveBeenCalledWith({ entityId: "e1", period: "2026-01" });
  });

  it("no account number leaks into the page HTML (last-4 mask only, as before)", async () => {
    m.accountFind.mockResolvedValue([
      { id: "acc1", nickname: "Checking", mask: "1234", accountType: "checking", currentBalance: null, currentBalanceAt: null, institution: { name: "Test Bank" }, entity: { name: "Personal" } },
    ]);
    const html = await render();
    expect(html).toContain("···1234");
    expect(html).not.toMatch(/\d{9,}/);
  });

  it("more than 10 scheduled transfers: 10 rows, an 'and N more' button, nothing silently cut", async () => {
    m.transferFind.mockResolvedValue(
      Array.from({ length: 13 }, (_, i) => ({ id: "s" + i, amount: new Decimal(10 + i), cadence: "monthly", dayRules: {}, purpose: null, fromAccount: { nickname: "From" + i }, toAccount: { nickname: "To" + i } }))
    );
    const html = await render();
    expect(html).toContain("and 3 more");
    expect(html).toContain("From9");
    expect(html).not.toContain(">From10");
  });
});

describe("tester: loadMonthTransactions query shape", () => {
  it("is read-only, bounded to [first, next first) UTC, archivedAt null, entity filter optional, explicit select without sensitive columns", async () => {
    const real = await vi.importActual<typeof import("@/lib/month-spend-build")>("@/lib/month-spend-build");
    m.txFind.mockResolvedValue([
      {
        id: "t1",
        postedAt: new Date("2026-09-30T00:00:00.000Z"),
        amount: new Decimal("-4335.69"),
        payeeRaw: null,
        payeeNormalized: "pennymac",
        pending: false,
        transferPairId: null,
        accountId: "a1",
        entityId: "e1",
        account: { nickname: "Primary", accountType: "checking" },
        entity: { name: "Personal" },
        tags: [{ tagId: "x" }],
      },
      {
        id: "t2",
        postedAt: new Date("2026-09-01T08:29:44.937Z"),
        amount: new Decimal("0.10"),
        payeeRaw: "RAW",
        payeeNormalized: "raw",
        pending: true,
        transferPairId: "p",
        accountId: "a1",
        entityId: "e1",
        account: { nickname: "Primary", accountType: "checking" },
        entity: { name: "Personal" },
        tags: [],
      },
      {
        id: "t3",
        postedAt: new Date("2026-09-02T00:00:00.000Z"),
        amount: new Decimal("1"),
        payeeRaw: null,
        payeeNormalized: null,
        pending: false,
        transferPairId: null,
        accountId: "a1",
        entityId: "e1",
        account: { nickname: "Primary", accountType: "checking" },
        entity: { name: "Personal" },
        tags: [],
      },
    ]);
    const out = await real.loadMonthTransactions({ entityId: "e1", period: "2026-09" });
    const arg = m.txFind.mock.calls[0]![0];
    expect(arg.where.archivedAt).toBeNull();
    expect(arg.where.entityId).toBe("e1");
    expect(arg.where.postedAt.gte).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(arg.where.postedAt.lt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    const sel = JSON.stringify(arg.select);
    for (const forbidden of ["description", "notes", "mask", "accessToken", "rawJson", "plaid", "memo"]) expect(sel.toLowerCase()).not.toContain(forbidden.toLowerCase());
    expect(Object.keys(arg)).toEqual(expect.not.arrayContaining(["include", "data"]));
    expect(out.map((t) => t.day)).toEqual(["2026-09-30", "2026-09-01", "2026-09-02"]);
    expect(out[0]!.payee).toBe("pennymac");
    expect(out[1]!.payee).toBe("RAW");
    expect(out[2]!.payee).toBe("(no payee)");
    expect(out[0]!.amount.toFixed(2)).toBe("-4335.69");
    expect(out[1]!.transferPairId).toBe("p");
    // all-entities: no entity key at all
    await real.loadMonthTransactions({ entityId: null, period: "2026-12" });
    const arg2 = m.txFind.mock.calls[1]![0];
    expect("entityId" in arg2.where).toBe(false);
    expect(arg2.where.postedAt.lt).toEqual(new Date("2027-01-01T00:00:00.000Z"));
    // sanity: the mocked wrapper used by the page tests is a different function
    expect(loadMonthTransactions).toBe(m.loadTxs);
  });
});
