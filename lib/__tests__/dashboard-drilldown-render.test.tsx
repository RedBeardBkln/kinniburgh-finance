// Render checks for the dashboard drill-down UI (static markup: structure, accessibility attributes, wording).
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/actions/budgets", () => ({ updateBudgetLine: async () => ({ success: true }) }));
vi.mock("@/components/transactions/inline-tag-cell", () => ({
  InlineTagCell: (p: { transactionId: string }) => `[tag-editor ${p.transactionId}]`,
}));

import { DrilldownDialog } from "@/components/dashboard/drilldown-dialog";
import { DrillButton } from "@/components/dashboard/drill-button";
import { DashboardClient } from "@/components/dashboard/dashboard-client";
import { DrillContext } from "@/components/dashboard/drill-context";
import { BudgetLinesTable } from "@/components/dashboard/budget-lines-table";
import { SpendCategoryCards } from "@/components/dashboard/spend-category-cards";
import { SpendingChart } from "@/components/dashboard/spending-chart";
import { buildMonthSpend, type SpendLineInput, type SpendTag, type SpendTx } from "@/lib/month-spend";
import { resolveEffectiveBudgets } from "@/lib/budget-effective";
import { buildDrillData } from "@/lib/dashboard-drill-build";
import type { DrillData } from "@/lib/dashboard-drill";
import { D, TAGS, resetSeq, septemberLines, septemberTxs } from "./month-spend-fixtures";

(globalThis as unknown as { React: typeof React }).React = React;

function makeData(): DrillData {
  resetSeq(0);
  const txs: SpendTx[] = septemberTxs();
  const lines: SpendLineInput[] = septemberLines();
  const tags: SpendTag[] = TAGS;
  const parent = new Map(tags.map((t) => [t.id, t.parentId]));
  const effective = resolveEffectiveBudgets(
    lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, budgeted: l.explicit })),
    [],
    (id) => parent.get(id)
  );
  const model = buildMonthSpend(
    txs,
    tags,
    lines.map((l) => ({ ...l, resolved: effective.resolvedById.get(l.id)!, explicit: effective.explicitById.get(l.id) ?? null }))
  );
  return buildDrillData({
    model,
    txs,
    tags: tags.map((t) => ({ ...t, shortName: t.name.split(" / ").pop()! })),
    budgets: lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, accountName: "Checking", rawBudgeted: l.explicit, rollover: D(0) })),
    effective,
    accounts: [{ id: "acc-checking", nickname: "Checking", institutionName: "Test Bank", accountType: "checking", currentBalance: D("10"), currentBalanceAt: null }],
    transfers: [],
    period: "2026-09",
    periodLabel: "September 2026",
    bucket: "personal",
    isAllEntities: false,
    periodQuery: "&period=2026-09",
  });
}

const noop = () => {};
const allTags = TAGS.map((t) => ({ ...t, shortName: t.name.split(" / ").pop()! }));

describe("DrilldownDialog", () => {
  const data = makeData();

  it("is a modal dialog with a title, a close button and the reconciliation footer", () => {
    const html = renderToStaticMarkup(<DrilldownDialog data={data} target={{ kind: "spent" }} allTags={allTags} returnFocusTo={null} onClose={noop} />);
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/aria-labelledby="drilldown-title"/);
    expect(html).toMatch(/aria-label="Close"/);
    expect(html).toContain("Spent in September 2026");
    expect(html).toContain("$17,162.22");
    expect(html).toContain("Rows add up to $17,162.22 = the number you clicked.");
  });

  it("explains every excluded class and shows untagged rows", () => {
    const html = renderToStaticMarkup(<DrilldownDialog data={data} target={{ kind: "spent" }} allTags={allTags} returnFocusTo={null} onClose={noop} />);
    expect(html).toContain("Not counted in Spent, and why");
    for (const label of ["Transfers between your own accounts", "Credit card payments", "Mortgage and loan account entries", "Income"]) expect(html).toContain(label);
    expect(html).toContain("Untagged transactions");
    expect(html).toContain("Not in any budget line");
    expect(html).toContain("Net of 3 refunds");
  });

  it("shows a visible warning, never a quiet pass, when the rows do not add up", () => {
    const broken: DrillData = { ...data, spentCents: data.spentCents + 100 };
    const html = renderToStaticMarkup(<DrilldownDialog data={broken} target={{ kind: "spent" }} allTags={allTags} returnFocusTo={null} onClose={noop} />);
    expect(html).toContain("Warning: rows add up to $17,162.22 but the number you clicked is $17,163.22");
  });

  it("a line view has the editable budget (blank for an auto-sum parent) and tag editors on its rows", () => {
    const html = renderToStaticMarkup(<DrilldownDialog data={data} target={{ kind: "line", lineId: "L-food" }} allTags={allTags} returnFocusTo={null} onClose={noop} />);
    expect(html).toContain("Auto ($700.00)");
    expect(html).toContain("[tag-editor ");
    expect(html).toContain("Groceries");
    expect(html).toContain("Open Budgets");
    expect(html).toContain("/budgets?bucket=personal&amp;period=2026-09");
  });

  it("the overspent view counts lines, not dollars", () => {
    const html = renderToStaticMarkup(<DrilldownDialog data={data} target={{ kind: "overspent" }} allTags={allTags} returnFocusTo={null} onClose={noop} />);
    expect(html).toMatch(/lines? listed = the number you clicked\./);
  });

  it("an account view carries a link to the Transactions page for that account with all dates", () => {
    const html = renderToStaticMarkup(<DrilldownDialog data={data} target={{ kind: "account", accountId: "acc-checking" }} allTags={allTags} returnFocusTo={null} onClose={noop} />);
    expect(html).toContain("/transactions?bucket=personal&amp;accountId=acc-checking&amp;tab=all");
    expect(html).toContain("Net activity in September 2026");
  });

  it("dates are shown as the calendar day (Sep 10), not shifted by a time zone", () => {
    const html = renderToStaticMarkup(<DrilldownDialog data={data} target={{ kind: "spent" }} allTags={allTags} returnFocusTo={null} onClose={noop} />);
    expect(html).toContain("Sep 10");
    expect(html).not.toContain("Sep 9");
  });

  it("layout survives a narrow screen: a bottom sheet with scrolling and wrapped rows", () => {
    const html = renderToStaticMarkup(<DrilldownDialog data={data} target={{ kind: "spent" }} allTags={allTags} returnFocusTo={null} onClose={noop} />);
    expect(html).toMatch(/items-end/);
    expect(html).toMatch(/max-h-\[90vh\]/);
    expect(html).toMatch(/overflow-y-auto/);
    expect(html).toMatch(/break-words/);
  });
});

describe("DrillButton", () => {
  const data = makeData();
  it("renders a real button when the numbers are available", () => {
    const html = renderToStaticMarkup(
      <DrillContext.Provider value={{ data, open: noop }}>
        <DrillButton target={{ kind: "spent" }} label="Show what makes up Spent">$1</DrillButton>
      </DrillContext.Provider>
    );
    expect(html).toMatch(/<button type="button"/);
    expect(html).toMatch(/aria-label="Show what makes up Spent"/);
    expect(html).toMatch(/aria-haspopup="dialog"/);
    expect(html).toMatch(/focus-visible:ring-2/);
  });
  it("renders plain content, not a dead button, when the numbers could not be loaded", () => {
    const html = renderToStaticMarkup(
      <DrillContext.Provider value={{ data: null, open: noop }}>
        <DrillButton target={{ kind: "spent" }} label="x">Unavailable</DrillButton>
      </DrillContext.Provider>
    );
    expect(html).not.toContain("<button");
    expect(html).toContain("Unavailable");
  });
});

describe("BudgetLinesTable", () => {
  const data = makeData();
  const html = renderToStaticMarkup(
    <DrillContext.Provider value={{ data, open: noop }}>
      <BudgetLinesTable budgetsHref="/budgets?bucket=personal&period=2026-09" />
    </DrillContext.Provider>
  );

  it("shows the parent above its indented children with the tree connector and a collapse toggle", () => {
    const food = html.indexOf("Food &amp; Drink");
    const groceries = html.indexOf(">Groceries<");
    const restaurants = html.indexOf(">Restaurants<");
    expect(food).toBeGreaterThan(-1);
    expect(groceries).toBeGreaterThan(food);
    expect(restaurants).toBeGreaterThan(groceries);
    expect(html).toContain("└");
    expect(html).toMatch(/aria-expanded="true"/);
    expect(html).toContain("Collapse Food &amp; Drink");
    expect(html).toContain("Expand all");
    expect(html).toContain("Collapse all");
  });

  it("parent totals include the children (Food & Drink spent = Groceries + Restaurants + Farmers Market) and each line is a button", () => {
    expect(html).toContain("$1,497.36");
    expect(html).toMatch(/aria-label="Show what makes up Food &amp; Drink"/);
    expect(html).toMatch(/aria-label="Show what makes up Food &amp; Drink \/ Groceries"/);
  });

  it("the account header counts top-level lines only", () => {
    // 700 + 4700 + 200 + 300 budgeted across the account's top-level lines
    expect(html).toContain("$5,900.00 budgeted");
  });

  it("keeps the link to the full report", () => {
    expect(html).toContain("/budgets?bucket=personal&amp;period=2026-09");
  });

  it("says so, quietly, when the numbers are unavailable", () => {
    const failed = renderToStaticMarkup(
      <DrillContext.Provider value={{ data: null, open: noop }}>
        <BudgetLinesTable budgetsHref="/budgets?bucket=personal" />
      </DrillContext.Provider>
    );
    expect(failed).toContain("unavailable right now");
    expect(failed).not.toContain("<table");
  });
});

describe("category cards and chart", () => {
  it("every card is a labelled button", () => {
    const html = renderToStaticMarkup(
      <SpendCategoryCards
        cards={[{ lineId: "L1", name: "Groceries", budgeted: 400, spent: 812.4, percentUsed: 200, isOverspent: true }]}
        onSelect={noop}
      />
    );
    expect(html).toMatch(/<button type="button"/);
    expect(html).toMatch(/aria-label="Show what makes up Groceries"/);
  });
  it("the header row wraps and the click hint sits on its own line, so the title and legend cannot overlap at 375 px", () => {
    const html = renderToStaticMarkup(<SpendingChart data={[{ lineId: "L1", name: "Groceries", budget: 400, actual: 812 }]} onBarClick={noop} />);
    expect(html).toMatch(/class="flex flex-wrap items-center justify-between gap-2"/);
    const title = html.indexOf("Spending this month");
    const hint = html.indexOf("(click a bar or a name below to drill in)");
    expect(hint).toBeGreaterThan(title);
    expect(html).toMatch(/<p class="text-xs text-muted-foreground">\(click a bar/);
    // the hint is no longer inside the title element
    expect(html.slice(title, hint)).toContain("</h3>");
  });
  it("every bar also has a real button underneath (the bars themselves are not keyboard reachable)", () => {
    const html = renderToStaticMarkup(
      <SpendingChart data={[{ lineId: "L1", name: "Groceries", budget: 400, actual: 812 }, { lineId: "L2", name: "Mortgage", budget: 4700, actual: 4335 }]} onBarClick={noop} />
    );
    expect((html.match(/<button type="button"/g) ?? []).length).toBe(2);
    expect(html).toContain("Open the details behind each bar");
  });
});

describe("browser-check fixes: layout and labels", () => {
  const data = makeData();

  it("the page title and month navigation render ABOVE the category cards and the chart", () => {
    const html = renderToStaticMarkup(
      <DashboardClient data={data} allTags={allTags} header={<h1>Personal TITLE-MARKER</h1>}>
        <p>CHILDREN-MARKER</p>
      </DashboardClient>
    );
    const title = html.indexOf("TITLE-MARKER");
    const cards = html.indexOf("Show what makes up");
    const chart = html.indexOf("Spending this month");
    const children = html.indexOf("CHILDREN-MARKER");
    expect(title).toBeGreaterThan(-1);
    expect(title).toBeLessThan(cards);
    expect(cards).toBeLessThan(chart);
    expect(chart).toBeLessThan(children);
  });

  it("the Excluded groups explain their signs: money in, money out and net", () => {
    const html = renderToStaticMarkup(<DrilldownDialog data={data} target={{ kind: "spent" }} allTags={allTags} returnFocusTo={null} onClose={noop} />);
    expect(html).toContain("Money in +$566.82, money out -$734.75, net");
    expect(html).toContain("(+ in, - out, as the bank records it)");
  });

  it("the All Entities table labels every account group with its entity", () => {
    const all: DrillData = { ...data, isAllEntities: true, groups: data.groups.map((g) => ({ ...g, entityName: "Personal" })) };
    const html = renderToStaticMarkup(
      <DrillContext.Provider value={{ data: all, open: noop }}>
        <BudgetLinesTable budgetsHref="/budgets?bucket=all" />
      </DrillContext.Provider>
    );
    expect(html).toContain("Checking · Personal");
  });

  it("the Spent dialog title matches the card for the current month", () => {
    const current: DrillData = { ...data, isCurrentPeriod: true };
    const html = renderToStaticMarkup(<DrilldownDialog data={current} target={{ kind: "spent" }} allTags={allTags} returnFocusTo={null} onClose={noop} />);
    expect(html).toContain("Spent This Month");
    expect(html).not.toContain("Spent in September 2026");
  });
});
