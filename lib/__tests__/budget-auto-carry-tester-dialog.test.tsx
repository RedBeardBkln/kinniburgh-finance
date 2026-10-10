// TESTER round 1 (S2): the dashboard line dialog tells the owner, under the Budget amount, that changing a carried line saves
// the carried budget (and for how many months). Real dialog + real drill builder, static markup.
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/actions/budgets", () => ({ updateBudgetLine: async () => ({ success: true }) }));
vi.mock("@/components/transactions/inline-tag-cell", () => ({ InlineTagCell: () => null }));

import { DrilldownDialog } from "@/components/dashboard/drilldown-dialog";
import { buildMonthSpend, type SpendLineInput, type SpendTag, type SpendTx } from "@/lib/month-spend";
import { resolveEffectiveBudgets } from "@/lib/budget-effective";
import { buildDrillData } from "@/lib/dashboard-drill-build";
import type { DrillData } from "@/lib/dashboard-drill";
import { D, TAGS, resetSeq, septemberLines, septemberTxs } from "./month-spend-fixtures";

(globalThis as unknown as { React: typeof React }).React = React;

function data(carried: boolean, months: string[] | null): DrillData {
  resetSeq(0);
  const txs: SpendTx[] = septemberTxs();
  const lines: SpendLineInput[] = septemberLines();
  const tags: SpendTag[] = TAGS;
  const parent = new Map(tags.map((t) => [t.id, t.parentId]));
  const effective = resolveEffectiveBudgets(lines.map((l) => ({ id: l.id, tagId: l.tagId, accountId: l.accountId, budgeted: l.explicit })), [], (id) => parent.get(id));
  const model = buildMonthSpend(txs, tags, lines.map((l) => ({ ...l, resolved: effective.resolvedById.get(l.id)!, explicit: effective.explicitById.get(l.id) ?? null })));
  return buildDrillData({
    model,
    txs,
    tags: tags.map((t) => ({ ...t, shortName: t.name.split(" / ").pop()! })),
    budgets: lines.map((l) => ({ id: carried ? "carried:" + l.id + ":2026-09" : l.id, entityId: "ent-1", carriedFrom: carried ? "2026-08" : null, tagId: l.tagId, accountId: l.accountId, accountName: "Checking", rawBudgeted: l.explicit, rollover: D(0) })),
    effective,
    accounts: [{ id: "acc-checking", nickname: "Checking", institutionName: "Test Bank", accountType: "checking", currentBalance: D("10"), currentBalanceAt: null }],
    transfers: [],
    period: "2026-09",
    periodLabel: "September 2026",
    bucket: "personal",
    isAllEntities: false,
    periodQuery: "&period=2026-09",
    firstEditMonths: months === null ? null : { "ent-1": months },
  });
}
const allTags = TAGS.map((t) => ({ ...t, shortName: t.name.split(" / ").pop()! }));
const render = (d: DrillData, lineId: string) =>
  renderToStaticMarkup(<DrilldownDialog data={d} target={{ kind: "line", lineId }} allTags={allTags} returnFocusTo={null} onClose={() => {}} />);

describe("TESTER: dashboard line dialog, carried-line note", () => {
  it("a carried line shows the note once (single month, several months, unknown); an own line shows none", () => {
    const one = data(true, ["2026-09"]);
    const id = one.lines.find((l) => l.label.endsWith("Mortgage"))!.id;
    const html = render(one, id);
    expect(html).toContain('data-testid="carried-edit-note"');
    expect(html).toContain("Carried from August 2026: this month has no saved budget of its own yet. Changing the amount saves the carried budget for this month.");
    expect((html.match(/carried-edit-note/g) ?? []).length).toBe(1);

    const many = render(data(true, ["2026-07", "2026-08", "2026-09"]), id);
    expect(many).toContain("saves the carried budget for 3 months (July 2026 to September 2026)");
    const unknown = render(data(true, null), id);
    expect(unknown).toContain("and for any empty month before it");

    const own = data(false, ["2026-09"]);
    const ownHtml = render(own, own.lines.find((l) => l.label.endsWith("Mortgage"))!.id);
    expect(ownHtml).not.toContain("carried-edit-note");
    expect(ownHtml).not.toContain("Carried from");
  });
});
