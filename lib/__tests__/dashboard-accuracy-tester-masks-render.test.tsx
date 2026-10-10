// TESTER (independent, re-test of the browser-check fixes): rendered DOM text never carries a statement mask or a digit
// run of one, exclusion groups show money in / out / net that add up, entity labels in the All Entities view, line
// subtitle, dialog titles, cadence labels, header above the cards. Real components, static markup.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Decimal } from "@prisma/client/runtime/library";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/actions/budgets", () => ({ updateBudgetLine: async () => ({ success: true }) }));
vi.mock("@/components/transactions/inline-tag-cell", () => ({ InlineTagCell: () => null }));

(globalThis as unknown as { React: typeof React }).React = React;

import { DrilldownDialog } from "@/components/dashboard/drilldown-dialog";
import { BudgetLinesTable } from "@/components/dashboard/budget-lines-table";
import { DashboardClient } from "@/components/dashboard/dashboard-client";
import { DrillContext } from "@/components/dashboard/drill-context";
import { buildMonthSpend, type SpendLineInput, type SpendTag, type SpendTx } from "@/lib/month-spend";
import { resolveEffectiveBudgets } from "@/lib/budget-effective";
import { buildDrillData } from "@/lib/dashboard-drill-build";
import { buildDrillView, cadenceText, groupLabel, type DrillData, type DrillTarget } from "@/lib/dashboard-drill";

const T = (id: string, name: string, parentId: string | null): SpendTag => ({ id, name, parentId });
const TAGS = [T("groc", "Food & Drink / Groceries", null), T("ccp", "Credit Cards / Credit card payment", null), T("home", "Home", null)];
const shortTags = TAGS.map((t) => ({ ...t, shortName: t.name.split(" / ").pop()! }));

let n = 0;
const tx = (over: Omit<Partial<SpendTx>, "amount"> & { amount: string }): SpendTx => ({
  id: "r" + ++n,
  day: "2026-10-09",
  payee: "Merchant",
  accountId: "a-chk",
  accountNickname: "Primary Checking",
  accountType: "checking",
  entityId: "e1",
  entityName: "Personal",
  pending: false,
  transferPairId: null,
  tagIds: [],
  ...over,
  amount: new Decimal(over.amount),
});

function build(opts: { all: boolean; current: boolean }): DrillData {
  n = 0;
  const masks = new Map([
    ["1111", "a-chk"],
    ["2222", "a-sav"],
  ]);
  const txs: SpendTx[] = [
    tx({ amount: "-400.00", payee: "Online Xfer Transfer to CK x2222", pending: true }),
    tx({ amount: "150.00", payee: "Online Xfer Transfer from CK x2222", pending: true, accountId: "a-chk" }),
    tx({ amount: "-25.00", payee: "Online Xfer Transfer to SV x8815", tagIds: ["x"] }), // foreign mask, stays classed by nothing -> spending
    tx({ amount: "-120.00", payee: "Corner Grocer", tagIds: ["groc"] }),
    tx({ amount: "-500.00", payee: "Card payment", tagIds: ["ccp"] }),
    tx({ amount: "200.00", payee: "Card refund payment in", tagIds: ["ccp"], accountId: "a-cc", accountNickname: "Barclay", accountType: "credit_card" }),
    tx({ amount: "-60.00", payee: "Hardware", accountId: "a-cc", accountNickname: "Barclay", accountType: "credit_card", tagIds: ["home"], entityId: "e2", entityName: "Sudden Valley" }),
  ];
  const lines: SpendLineInput[] = [
    { id: "L1", tagId: "groc", accountId: "a-chk", resolved: new Decimal(400), explicit: new Decimal(400), rollover: new Decimal(0) },
    { id: "L2", tagId: "home", accountId: "a-chk", resolved: new Decimal(100), explicit: new Decimal(100), rollover: new Decimal(0) },
  ];
  const parent = new Map(TAGS.map((t) => [t.id, t.parentId]));
  const eff = resolveEffectiveBudgets(lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, budgeted: l.explicit })), [], (id) => parent.get(id));
  const model = buildMonthSpend(txs, TAGS, lines, { ownAccountByMask: masks });
  return buildDrillData({
    model,
    txs,
    tags: shortTags,
    budgets: lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, accountName: "Primary Checking", entityName: "Personal", rawBudgeted: l.explicit, rollover: new Decimal(0) })),
    effective: eff,
    accounts: [
      { id: "a-chk", nickname: "Primary Checking", institutionName: "TD", entityName: "Personal", accountType: "checking", currentBalance: null, currentBalanceAt: null },
      { id: "a-sav", nickname: "Slush Funds", institutionName: "TD", entityName: "Personal", accountType: "checking", currentBalance: null, currentBalanceAt: null },
      { id: "a-cc", nickname: "Barclay", institutionName: "Barclays", entityName: "Sudden Valley", accountType: "credit_card", currentBalance: null, currentBalanceAt: null },
    ],
    transfers: [],
    period: "2026-10",
    periodLabel: "October 2026",
    isCurrentPeriod: opts.current,
    bucket: opts.all ? "all" : "personal",
    isAllEntities: opts.all,
    periodQuery: "",
    ownAccountByMask: masks,
  });
}

const dlg = (data: DrillData, target: DrillTarget) =>
  renderToStaticMarkup(<DrilldownDialog data={data} target={target} allTags={shortTags} returnFocusTo={null} onClose={() => {}} />);

describe("tester: rendered text never carries a statement mask", () => {
  const data = build({ all: false, current: true });
  const targets: DrillTarget[] = [
    { kind: "spent" },
    { kind: "budgeted" },
    { kind: "overspent" },
    { kind: "line", lineId: "L1" },
    { kind: "line", lineId: "L2" },
    { kind: "account", accountId: "a-chk" },
    { kind: "account", accountId: "a-sav" },
    { kind: "account", accountId: "a-cc" },
  ];
  it.each(targets.map((t) => [JSON.stringify(t), t] as const))("dialog %s: no xNNNN and no mask digit token", (_n, target) => {
    const html = dlg(data, target);
    expect(html).not.toMatch(/\bx\d{4}\b/);
    for (const m of ["1111", "2222", "8815"]) expect(html, `mask ${m}`).not.toMatch(new RegExp(`(^|[^0-9])${m}([^0-9]|$)`));
  });

  it("the recognised legs read by account name, the foreign mask is starred", () => {
    const html = dlg(data, { kind: "account", accountId: "a-chk" });
    expect(html).toContain("Transfer to Slush Funds");
    expect(html).toContain("Transfer from Slush Funds");
    expect(html).toContain("Online Xfer Transfer to SV x****");
  });

  it("the whole payload JSON has no xNNNN", () => {
    expect(JSON.stringify(data)).not.toMatch(/\bx\d{4}\b/);
  });
});

describe("tester: exclusion groups, titles, labels", () => {
  it("own-transfer group: money in, money out and net are shown and add up (-400 + 150 = -250, plus the starred row)", () => {
    const data = build({ all: false, current: true });
    const view = buildDrillView(data, { kind: "spent" });
    const own = view.excludedSections.find((s) => s.key === "excluded:own_transfer")!;
    expect(own.moneyInCents).toBe(15000);
    expect(own.moneyOutCents).toBe(-40000);
    expect(own.subtotalCents).toBe((own.moneyInCents ?? 0) + (own.moneyOutCents ?? 0));
    const html = dlg(data, { kind: "spent" });
    expect(html).toContain("Money in +$150.00, money out -$400.00, net -$250.00");
    // card payments: in 200, out -500, net -300
    expect(html).toContain("Money in +$200.00, money out -$500.00, net -$300.00");
    // every excluded group: in + out == net
    for (const s of view.excludedSections) expect((s.moneyInCents ?? 0) + (s.moneyOutCents ?? 0), s.key).toBe(s.subtotalCents);
    // each excluded row says why it is not counted
    expect(html).toContain("Transfer to your own account, not counted");
    expect(html).toContain("Transfer from your own account, not counted");
    // Spent = grocer 120 + foreign-mask 25 + hardware 60 = 205 (the 400 pending and the card payments are out)
    expect(data.spentCents).toBe(20500);
  });

  it("title: 'Spent This Month' for the current month, 'Spent in <Month Year>' for a past one", () => {
    expect(buildDrillView(build({ all: false, current: true }), { kind: "spent" }).title).toBe("Spent This Month");
    expect(buildDrillView(build({ all: false, current: false }), { kind: "spent" }).title).toBe("Spent in October 2026");
  });

  it("All Entities view names the entity on every account group; a single entity does not", () => {
    const all = build({ all: true, current: true });
    const one = build({ all: false, current: true });
    expect(all.groups.every((g) => groupLabel(all, g).includes(" · "))).toBe(true);
    expect(one.groups.some((g) => groupLabel(one, g).includes(" · "))).toBe(false);
    const view = buildDrillView(all, { kind: "budgeted" });
    expect(view.sections.every((s) => s.title.includes(" · Personal"))).toBe(true);
    const tableHtml = renderToStaticMarkup(
      <DrillContext.Provider value={{ data: all, open: () => {} }}>
        <BudgetLinesTable budgetsHref="/budgets?bucket=all" />
      </DrillContext.Provider>
    );
    expect(tableHtml).toContain("Primary Checking · Personal");
    const tableOne = renderToStaticMarkup(
      <DrillContext.Provider value={{ data: one, open: () => {} }}>
        <BudgetLinesTable budgetsHref="/budgets?bucket=personal" />
      </DrillContext.Provider>
    );
    expect(tableOne).not.toContain("Primary Checking · Personal");
    // the account view subtitle names the entity only in the All Entities view
    expect(buildDrillView(all, { kind: "account", accountId: "a-cc" }).subtitle).toBe("Barclays · Sudden Valley");
    expect(buildDrillView(one, { kind: "account", accountId: "a-cc" }).subtitle).toBe("Barclays");
  });

  it("line subtitle names the budgeted account and where else the spending sits", () => {
    const data = build({ all: true, current: true });
    expect(buildDrillView(data, { kind: "line", lineId: "L2" }).subtitle).toBe("Budgeted on the Primary Checking account · spending also on Barclay");
    expect(buildDrillView(data, { kind: "line", lineId: "L1" }).subtitle).toBe("Budgeted on the Primary Checking account");
  });

  it("cadence labels", () => {
    expect(cadenceText("semi_monthly")).toBe("Semi-monthly");
    expect(cadenceText("weekly")).toBe("Weekly");
    expect(cadenceText("monthly")).toBe("Monthly");
    expect(cadenceText("biweekly")).toBe("Every two weeks");
    expect(cadenceText("every_other_odd")).toBe("Every other odd");
    expect(cadenceText("")).toBe("");
  });

  it("the header renders first, above the category cards and the chart, and the children (summary cards) come after", () => {
    const data = build({ all: false, current: true });
    const html = renderToStaticMarkup(
      <DashboardClient data={data} allTags={shortTags} header={<h1 id="hdr">HEADER</h1>}>
        <div id="kids">CHILDREN</div>
      </DashboardClient>
    );
    const h = html.indexOf("HEADER");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(html.indexOf("Show what makes up")); // first category card
    expect(h).toBeLessThan(html.indexOf("Spending this month"));
    expect(html.indexOf("Spending this month")).toBeLessThan(html.indexOf("CHILDREN"));
  });
});
