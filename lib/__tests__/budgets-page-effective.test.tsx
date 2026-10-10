// /budgets and the dashboard show the EFFECTIVE budget (own rows plus lines carried forward) for a month with no row of
// its own, through the one shared loader. No "copy" button exists. Real pages, real client components rendered to static
// markup, over an in-memory fake of the database that has NO write verbs on the read path.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { D, budgetRow, createFakeBudgetDb, type FakeBudgetRow } from "./budget-fake-db";

(globalThis as unknown as { React: typeof React }).React = React;

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  getEntityBySlug: vi.fn(),
  accountFind: vi.fn(),
  tagFind: vi.fn(),
  recurringFind: vi.fn(),
  transferFind: vi.fn(),
  loadTxs: vi.fn(),
  current: { db: null as unknown },
  props: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error("REDIRECT:" + to);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: m.getEntityBySlug }));
vi.mock("@/lib/db", () => ({
  get db() {
    const fake = m.current.db as Record<string, unknown>;
    return {
      ...fake,
      account: { findMany: m.accountFind },
      tag: { findMany: m.tagFind },
      recurringExpense: { findMany: m.recurringFind },
      scheduledTransfer: { findMany: m.transferFind },
    };
  },
}));
vi.mock("@/components/app-shell", () => ({ AppShell: (p: { children: React.ReactNode }) => p.children }));
vi.mock("@/lib/month-spend-build", async (orig) => ({ ...(await orig<typeof import("@/lib/month-spend-build")>()), loadMonthTransactions: m.loadTxs }));
vi.mock("@/lib/own-account-masks-build", () => ({ loadOwnAccountByMask: async () => new Map() }));
vi.mock("@/actions/reports", () => ({ exportBudgetCsv: async () => "" }));
vi.mock("@/components/export-csv-button", () => ({ ExportCsvButton: () => null }));
vi.mock("@/actions/budgets", () => ({
  updateBudgetLine: async () => ({ success: true }),
  updateBudget: async () => ({ success: true }),
  updateBudgetAdditionalAmount: async () => ({ success: true }),
  deleteBudget: async () => ({ success: true, removedMonths: 1 }),
  createBudget: async () => ({ success: true }),
}));
vi.mock("@/lib/upcoming-ledger-build", () => ({ loadUpcomingLedger: vi.fn() }));
vi.mock("@/lib/upcoming-ledger-view", () => ({ toUiDetection: vi.fn(), toUiLedger: vi.fn() }));
vi.mock("@/components/upcoming/upcoming-widget", () => ({ UpcomingWidget: () => null }));
vi.mock("@/components/upcoming/upcoming-skeleton", () => ({ UpcomingWidgetSkeleton: () => null }));
vi.mock("@/components/transactions/inline-tag-cell", () => ({ InlineTagCell: () => null }));
// keep the real client component, but remember the props the server page handed it
vi.mock("@/components/budgets/budget-page-client", async (orig) => {
  const real = await orig<typeof import("@/components/budgets/budget-page-client")>();
  return {
    ...real,
    BudgetPageClient: (p: Parameters<typeof real.BudgetPageClient>[0]) => {
      m.props = p as unknown as Record<string, unknown>;
      return real.BudgetPageClient(p);
    },
  };
});

import BudgetsPage from "@/app/budgets/page";
import DashboardPage from "@/app/page";

const E_P = "ent-personal";
const E_K = "ent-ekc";
const E_M = "ent-mezzo";

const TAGS = [
  { id: "t-rent", name: "Utilities / Mortgage", shortName: "Mortgage", parentId: null },
  { id: "t-food", name: "Food & Drink / Groceries", shortName: "Groceries", parentId: null },
  { id: "t-sw", name: "Software", shortName: "Software", parentId: null },
];

function arrange(extra: FakeBudgetRow[] = []) {
  const rows = [
    budgetRow({ entityId: E_P, tagId: "t-rent", period: "2026-08", accountId: "acct-chk", budgeted: D("1234.56"), payDay: 3, rolloverAmount: D("50") }),
    budgetRow({ entityId: E_P, tagId: "t-food", period: "2026-08", accountId: "acct-chk", budgeted: D("876.54") }),
    budgetRow({ entityId: E_K, tagId: "t-sw", period: "2026-09", accountId: "acct-ekc", budgeted: D("75") }),
    ...extra,
  ];
  const fake = createFakeBudgetDb({
    rows,
    tags: TAGS,
    entities: [
      { id: E_P, name: "Personal", slug: "personal" },
      { id: E_K, name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting" },
      { id: E_M, name: "Mezzo", slug: "mezzo" },
    ],
    accounts: [
      { id: "acct-chk", nickname: "Primary Checking", entityId: E_P },
      { id: "acct-ekc", nickname: "EKC Operating", entityId: E_K },
    ],
  });
  m.current.db = fake.db;
  m.auth.mockResolvedValue({ user: { name: "Eric", id: "u1" } });
  m.getEntityBySlug.mockImplementation(async (slug: string) => {
    if (slug === "personal") return { id: E_P, name: "Personal", slug, navLabel: "Personal" };
    if (slug === "ek-consulting") return { id: E_K, name: "Eric Kinniburgh Consulting, LLC", slug, navLabel: "EK Consulting" };
    if (slug === "mezzo") return { id: E_M, name: "Mezzo", slug, navLabel: "Mezzo" };
    return null;
  });
  m.accountFind.mockResolvedValue([
    { id: "acct-chk", nickname: "Primary Checking", mask: "1234", accountType: "checking", currentBalance: D("1000"), currentBalanceAt: null, institution: { name: "TD" }, entity: { name: "Personal" } },
  ]);
  m.tagFind.mockResolvedValue(TAGS);
  m.recurringFind.mockResolvedValue([]);
  m.transferFind.mockResolvedValue([]);
  m.loadTxs.mockResolvedValue([]);
  return fake;
}

async function renderBudgets(search: { bucket?: string; period?: string }): Promise<string> {
  const el = await BudgetsPage({ searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(el as React.ReactElement);
}
async function renderDashboard(search: { bucket?: string; period?: string }): Promise<string> {
  const el = await DashboardPage({ searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(el as React.ReactElement);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  arrange();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("/budgets for a month with no row of its own", () => {
  it("shows the carried lines, each labelled with where it came from, plus one quiet notice, and no copy button", async () => {
    const html = await renderBudgets({ bucket: "personal", period: "2027-01" });
    expect(html).toContain("Mortgage");
    expect(html).toContain("Groceries");
    expect((html.match(/Carried from August 2026/g) ?? []).length).toBe(2);
    expect(html).toContain('data-testid="carried-notice"');
    expect(html).toContain("This month has no saved budget of its own yet.");
    expect(html).toContain("copied from August 2026");
    // S1: the notice says HOW MANY months the first change saves: the rows end in August, so 2027-01 also saves the four
    // empty months in between (September to December), and those months then stop following earlier amount edits
    expect(html).toContain("the list is saved for 5 months (September 2026 to January 2027): this month and every empty month before it.");
    expect(html).toContain("no longer follow later changes made to earlier months");
    expect(html).not.toContain("No budget lines found");
    // no button of any kind to copy last month's lines
    expect(html.toLowerCase()).not.toMatch(/copy last month|copy lines|copy forward|copy budget/);
    expect(html.match(/<button[^>]*>[^<]*[Cc]opy/g)).toBeNull();
  });

  it("the first empty month after the latest saved one saves just that month, and says so", async () => {
    const html = await renderBudgets({ bucket: "personal", period: "2026-09" });
    expect(html).toContain("The first time you change something here, the whole list is saved for this month.");
    expect(html).not.toContain("saved for 2 months");
  });

  it("S3: every line carries the count of saved later months, for the End line confirm", async () => {
    const fake = arrange([
      budgetRow({ entityId: E_P, tagId: "t-rent", period: "2026-09", accountId: "acct-chk", budgeted: D("1") }),
      budgetRow({ entityId: E_P, tagId: "t-food", period: "2026-09", accountId: "acct-chk", budgeted: D("1") }),
      budgetRow({ entityId: E_P, tagId: "t-rent", period: "2026-10", accountId: "acct-chk", budgeted: D("1") }),
      budgetRow({ entityId: E_P, tagId: "t-food", period: "2026-10", accountId: "acct-chk", budgeted: D("1") }),
    ]);
    void fake;
    await renderBudgets({ bucket: "personal", period: "2026-08" });
    const props = m.props as unknown as { budgets: Array<{ tagName: string; laterSavedMonths: number | null }> };
    expect(props.budgets.map((b) => b.laterSavedMonths)).toEqual([2, 2]); // 2026-09 and 2026-10 already have each line
  });

  it("totals come from the same resolver as the dashboard and rollover/additional are not carried (rollover shows a dash)", async () => {
    const html = await renderBudgets({ bucket: "personal", period: "2027-01" });
    expect(html).toContain("$2,111.10"); // 1,234.56 + 876.54
    // the source row's rollover (50) is not carried: no "$50.00" rollover cell
    expect(html).not.toContain("$50.00");
  });

  it("a month with its own rows shows neither the notice nor any 'Carried from' label", async () => {
    const html = await renderBudgets({ bucket: "personal", period: "2026-08" });
    expect(html).not.toContain("carried-notice");
    expect(html).not.toContain("Carried from");
    expect(html).toContain("$2,111.10");
  });

  it("a partly filled month labels only the carried lines and says how many", async () => {
    arrange([budgetRow({ entityId: E_P, tagId: "t-rent", period: "2026-10", accountId: "acct-chk", budgeted: D("1") })]);
    // 2026-10 is now the entity's latest month holding only the mortgage line: groceries has ended, so nothing is carried
    const html = await renderBudgets({ bucket: "personal", period: "2026-10" });
    expect(html).not.toContain("Carried from");
    expect(html).not.toContain("Groceries");
  });

  it("an entity's lines stay in its own bucket: EK Consulting carries into the current month, Personal's list is not mixed in", async () => {
    const html = await renderBudgets({ bucket: "ek-consulting" });
    expect(html).toContain("Software");
    expect(html).toContain("Carried from September 2026");
    expect(html).not.toContain("Mortgage");
    expect(html).toContain("$75.00");
  });

  it("the All Entities view lists each entity's lines", async () => {
    const html = await renderBudgets({ bucket: "all", period: "2026-10" });
    for (const t of ["Mortgage", "Groceries", "Software"]) expect(html).toContain(t);
  });

  it("an entity with no budget at all keeps the empty state (nothing to carry, nothing invented)", async () => {
    const html = await renderBudgets({ bucket: "mezzo", period: "2027-01" });
    expect(html).toContain("No budget lines found for January 2027.");
    expect(html).not.toContain("carried-notice");
  });

  it("a month before the entity's first row shows nothing (a line is never carried backwards)", async () => {
    const html = await renderBudgets({ bucket: "personal", period: "2026-05" });
    expect(html).toContain("No budget lines found for May 2026.");
  });

  it("the page only reads: it never saves the carried lines by itself", async () => {
    const fake = arrange();
    const before = fake.state.committed.length;
    await renderBudgets({ bucket: "personal", period: "2027-01" });
    await renderBudgets({ bucket: "personal", period: "2027-01" });
    expect(fake.state.committed).toHaveLength(before);
    expect(fake.state.audit).toEqual([]);
    expect(fake.state.transactions).toBe(0);
  });

  it("the month picker runs from 12 months back to 12 months ahead across the year boundary, plus the month in the URL when outside", async () => {
    const html = await renderBudgets({ bucket: "personal", period: "2026-10" });
    const values = [...html.matchAll(/<option value="(\d{4}-\d{2})"/g)].map((x) => x[1]);
    expect(values[0]).toBe("2025-10");
    expect(values[values.length - 1]).toBe("2027-10");
    expect(values).toHaveLength(25);
    expect(values).toContain("2027-01");
    expect(html).toContain("January 2027");
    const far = await renderBudgets({ bucket: "personal", period: "2030-05" });
    const farValues = [...far.matchAll(/<option value="(\d{4}-\d{2})"/g)].map((x) => x[1]);
    expect(farValues).toContain("2030-05");
    expect(farValues).toHaveLength(26);
    expect(farValues).toEqual([...farValues].sort());
  });

  it("the Add Budget Line list hides tags used by ANY entity this month, carried or not", async () => {
    await renderBudgets({ bucket: "personal", period: "2027-01" });
    const props = m.props as unknown as { budgetedTagIdsAllEntities: string[]; budgets: Array<{ id: string; entityId: string; source: string; carriedFrom: string | null; carriedFromLabel: string | null }> };
    // Personal's own carried lines AND EK Consulting's carried Software line are off the table for every entity
    expect([...props.budgetedTagIdsAllEntities].sort()).toEqual(["t-food", "t-rent", "t-sw"]);
    // the page hands the client only its own bucket's lines; a carried line has a synthetic key and says where it came from
    expect(props.budgets.map((b) => b.entityId)).toEqual([E_P, E_P]);
    for (const b of props.budgets) {
      expect(b.source).toBe("carried");
      expect(b.id.startsWith("carried:")).toBe(true);
      expect(b.carriedFrom).toBe("2026-08");
      expect(b.carriedFromLabel).toBe("August 2026");
    }
  });

  it("a month of its own rows hands over real ids and source 'own'", async () => {
    await renderBudgets({ bucket: "personal", period: "2026-08" });
    const props = m.props as unknown as { budgets: Array<{ id: string; source: string; carriedFrom: string | null }> };
    expect(props.budgets.every((b) => b.source === "own" && b.carriedFrom === null && !b.id.startsWith("carried:"))).toBe(true);
  });
});

describe("the dashboard reads the same rows", () => {
  it("Total Budgeted on the dashboard equals /budgets for the same bucket and month, for a month that is only carried", async () => {
    const dash = await renderDashboard({ bucket: "personal" }); // current month 2026-10: no row of its own
    const page = await renderBudgets({ bucket: "personal" });
    expect(dash).toContain("$2,111.10");
    expect(page).toContain("$2,111.10");
    expect(dash).not.toContain("Budget lines are unavailable");
  });

  it("EK Consulting, whose only row is September, shows its carried lines for October instead of 'no budgets'", async () => {
    const dash = await renderDashboard({ bucket: "ek-consulting" });
    expect(dash).toContain("$75.00");
  });

  it("a failing budget read blanks only that widget (unchanged behaviour)", async () => {
    const fake = arrange();
    vi.spyOn(fake.db.budget, "findMany").mockRejectedValue(new Error("boom postgres://x:y@h/z"));
    const dash = await renderDashboard({ bucket: "personal" });
    expect(dash).toMatch(/Budget lines are unavailable/);
    expect(JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls)).not.toContain("postgres://");
  });
});
