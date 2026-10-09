import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Decimal } from "@prisma/client/runtime/library";

// Pre-confirm notice of the inline Add step: /budgets replaces a category's stored budget with
// (sum of linked recurring monthly equivalents + additional amount), so the owner is told BEFORE Confirm.

vi.mock("@/actions/recurring-suggestions", () => ({
  addSuggestedRecurringExpense: vi.fn(),
  dismissSuggestion: vi.fn(),
  restoreSuggestion: vi.fn(),
}));

const mockDb = vi.hoisted(() => ({
  budget: { findMany: vi.fn() },
  scheduledBill: { findMany: vi.fn() },
  recurringExpense: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  BUDGET_NOTICE_GENERIC,
  approxCents,
  buildBudgetFacts,
  budgetFactsKey,
  budgetNotice,
  selectedTagNotice,
  thisMonthlyCents,
  type TagBudgetFacts,
} from "@/lib/recurring-budget-hint";
import { currentBudgetPeriod, loadBudgetHints } from "@/lib/recurring-budget-hint-build";
import { AddStep } from "@/components/upcoming/suggestion-actions";
import { RecurringSuggestions } from "@/components/upcoming/recurring-suggestions";
import { toUiDetection, type UiDetection, type UiSuggestion } from "@/lib/upcoming-ledger-view";
import { applyDismissals, type DetectResult, type Series } from "@/lib/recurring-detect";

(globalThis as unknown as { React: typeof React }).React = React;

const E = "ent-p";
const TAG = "tag-stream";
const facts = (over: Partial<TagBudgetFacts> = {}): TagBudgetFacts => ({
  hasBudget: true,
  budgetedCents: 6000,
  additionalCents: 0,
  linkedMonthlyCents: 0,
  linkedCount: 0,
  hasBill: false,
  ...over,
});

describe("the notice text and numbers", () => {
  it("a category with a $60.00 budget and nothing linked: the owner's example, with exact numbers", () => {
    expect(budgetNotice(facts(), 2870)).toBe(
      "This category has a ~$60.00/month budget. Linking recurring expenses to a category replaces the budget shown on Budgets with their monthly total " +
        "(this one ~$28.70 + your additional amount ~$0.00 = ~$28.70). You can change it on Budgets afterwards."
    );
  });

  it("includes the additional amount in the total", () => {
    const n = budgetNotice(facts({ additionalCents: 1500 }), 2870) ?? "";
    expect(n).toContain("your additional amount ~$15.00 = ~$43.70");
  });

  it("includes expenses already linked, with their count and monthly total", () => {
    const n = budgetNotice(facts({ linkedCount: 1, linkedMonthlyCents: 999, additionalCents: 100 }), 1549) ?? "";
    expect(n).toContain("(this one ~$15.49 + 1 already linked ~$9.99 + your additional amount ~$1.00 = ~$26.48)");
    const two = budgetNotice(facts({ linkedCount: 2, linkedMonthlyCents: 1998 }), 1549) ?? "";
    expect(two).toContain("2 already linked ~$19.98");
    expect(two).toContain("= ~$35.47)");
  });

  it("a budget line with no amount of its own says so instead of inventing a figure", () => {
    const n = budgetNotice(facts({ budgetedCents: null }), 2870) ?? "";
    expect(n).toContain("budget line with no amount of its own");
    expect(n).not.toContain("/month budget");
  });

  it("no budget row and no bill: nothing extra", () => {
    expect(budgetNotice(undefined, 2870)).toBeNull();
    expect(budgetNotice(facts({ hasBudget: false, budgetedCents: null }), 2870)).toBeNull();
  });

  it("a scheduled bill alone, and a budget plus a bill, add the ledger sentence", () => {
    const billOnly = budgetNotice(facts({ hasBudget: false, budgetedCents: null, hasBill: true }), 2870) ?? "";
    expect(billOnly).toContain("A scheduled bill is tied to this category");
    expect(billOnly).not.toContain("replaces the budget");
    const both = budgetNotice(facts({ hasBill: true }), 2870) ?? "";
    expect(both).toContain("replaces the budget shown on Budgets");
    expect(both).toContain("A scheduled bill is tied to this category");
  });

  it("is observational: no advice, no 'should', no account numbers", () => {
    const n = budgetNotice(facts({ linkedCount: 1, linkedMonthlyCents: 999, hasBill: true }), 2870) ?? "";
    expect(n).not.toMatch(/\bshould\b|\bmust\b|recommend|advis|\bwill\b/i);
    expect(n).not.toMatch(/\d{5,}/);
  });

  it("formats cents with thousands separators", () => {
    expect(approxCents(0)).toBe("~$0.00");
    expect(approxCents(5)).toBe("~$0.05");
    expect(approxCents(123456)).toBe("~$1,234.56");
    expect(approxCents(100000000)).toBe("~$1,000,000.00");
  });
});

describe("monthly equivalents use the Budgets page's own function", () => {
  it("weekly, biweekly, quarterly, annually and monthly", () => {
    expect(thisMonthlyCents(1000, "monthly")).toBe(1000);
    expect(thisMonthlyCents(1000, "weekly")).toBe(4333); // 1000 * 52 / 12 = 4333.33
    expect(thisMonthlyCents(1000, "biweekly")).toBe(2167); // 1000 * 26 / 12 = 2166.67
    expect(thisMonthlyCents(3000, "quarterly")).toBe(1000);
    expect(thisMonthlyCents(12000, "annually")).toBe(1000);
  });

  it("the notice total uses them for this one and for the already linked ones", () => {
    const f = buildBudgetFacts({
      budgets: [{ entityId: E, tagId: TAG, budgetedCents: 6000, additionalCents: 0 }],
      bills: [],
      recurring: [
        { entityId: E, tagId: TAG, amountCents: 1000, frequency: "weekly" }, // 4333
        { entityId: E, tagId: TAG, amountCents: 12000, frequency: "annually" }, // 1000
      ],
    });
    expect(f[budgetFactsKey(E, TAG)]).toMatchObject({ linkedMonthlyCents: 5333, linkedCount: 2 });
    // this one: 1000 biweekly = 2167; total 2167 + 5333 + 0 = 7500
    const n = budgetNotice(f[budgetFactsKey(E, TAG)], thisMonthlyCents(1000, "biweekly")) ?? "";
    expect(n).toContain("(this one ~$21.67 + 2 already linked ~$53.33 + your additional amount ~$0.00 = ~$75.00)");
  });
});

describe("building the facts from rows", () => {
  it("only categories with a budget row or a bill get an entry; linked expenses elsewhere are ignored", () => {
    const f = buildBudgetFacts({
      budgets: [{ entityId: E, tagId: "t1", budgetedCents: 5000, additionalCents: 250 }],
      bills: [{ entityId: E, budgetEntityId: null, budgetTagId: "t2" }],
      recurring: [
        { entityId: E, tagId: "t1", amountCents: 1000, frequency: "monthly" },
        { entityId: E, tagId: "t3", amountCents: 1000, frequency: "monthly" },
      ],
    });
    expect(Object.keys(f).sort()).toEqual([budgetFactsKey(E, "t1"), budgetFactsKey(E, "t2")]);
    expect(f[budgetFactsKey(E, "t1")]).toEqual({ hasBudget: true, budgetedCents: 5000, additionalCents: 250, linkedMonthlyCents: 1000, linkedCount: 1, hasBill: false });
    expect(f[budgetFactsKey(E, "t2")]).toMatchObject({ hasBudget: false, hasBill: true });
  });

  it("is per entity: the same tag in another entity is a separate record, and a bill's budgetEntityId wins", () => {
    const f = buildBudgetFacts({
      budgets: [{ entityId: "other", tagId: "t1", budgetedCents: 100, additionalCents: 0 }],
      bills: [{ entityId: E, budgetEntityId: "other", budgetTagId: "t9" }],
      recurring: [{ entityId: E, tagId: "t1", amountCents: 500, frequency: "monthly" }],
    });
    expect(f[budgetFactsKey(E, "t1")]).toBeUndefined();
    expect(f[budgetFactsKey("other", "t1")]?.linkedCount).toBe(0);
    expect(f[budgetFactsKey("other", "t9")]?.hasBill).toBe(true);
  });
});

describe("which notice the step shows for the selected category", () => {
  const all = { [budgetFactsKey(E, TAG)]: facts() };
  it("No tag: nothing", () => expect(selectedTagNotice(all, E, "", 2870, "monthly")).toBeNull());
  it("a tag with a budget: the numeric notice", () => expect(selectedTagNotice(all, E, TAG, 2870, "monthly")).toBe(budgetNotice(facts(), 2870)));
  it("a tag without a budget row: nothing", () => expect(selectedTagNotice(all, E, "t-other", 2870, "monthly")).toBeNull());
  it("a category of ANOTHER entity is not used", () => expect(selectedTagNotice(all, "other", TAG, 2870, "monthly")).toBeNull());
  it("the read failed (null): the generic line for any chosen tag, still nothing for No tag", () => {
    expect(selectedTagNotice(null, E, TAG, 2870, "monthly")).toBe(BUDGET_NOTICE_GENERIC);
    expect(selectedTagNotice(null, E, "", 2870, "monthly")).toBeNull();
  });
  it("not provided at all (undefined): nothing", () => expect(selectedTagNotice(undefined, E, TAG, 2870, "monthly")).toBeNull());
  it("facts known but the suggestion has no usable amount: the generic line, never a made-up figure", () => {
    expect(selectedTagNotice(all, E, TAG, undefined, undefined)).toBe(BUDGET_NOTICE_GENERIC);
  });
});

// ── Render ────────────────────────────────────────────────────────────────────

function step(note: string | null) {
  return renderToStaticMarkup(
    <AddStep
      idPrefix="add-x"
      defaultName="Netflix"
      tags={[{ id: TAG, label: "Bills / Streaming" }]}
      state={{ tagId: TAG, name: "Netflix" }}
      suggestedTagId={TAG}
      budgetNote={note}
      error={null}
      pending={false}
      onChange={() => undefined}
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />
  );
}

describe("the notice in the open step", () => {
  it("renders as a polite status under the category list and is referenced by the list", () => {
    const html = step(budgetNotice(facts(), 2870));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("This category has a ~$60.00/month budget.");
    expect(html).toContain("= ~$28.70). You can change it on Budgets afterwards.");
    expect(html).toContain('aria-describedby="add-x-tag-help add-x-budget-note"');
    expect(html.indexOf("add-x-tag-help")).toBeLessThan(html.indexOf("add-x-budget-note"));
  });

  it("shows nothing extra when the category has no budget", () => {
    const html = step(null);
    expect(html).not.toContain("add-x-budget-note");
    expect(html).not.toContain('role="status"');
    expect(html).toContain('aria-describedby="add-x-tag-help"');
  });

  it("the generic line renders too, and Confirm is still available", () => {
    const html = step(BUDGET_NOTICE_GENERIC);
    expect(html).toContain(BUDGET_NOTICE_GENERIC);
    expect(html).toMatch(/<button type="submit"[^>]*>Confirm<\/button>/);
  });
});

describe("the review list passes the numbers down without per-row copies", () => {
  const suggestion = (): UiSuggestion => ({
    key: `${E}|a|out|netflix`, entityId: E, entityName: "Personal", payee: "Netflix", kind: "outflow", cadence: "monthly",
    summary: "~$28.70 monthly", confidence: "high", confidenceLabel: "Strong pattern", why: "Seen 6 times.", nextLabel: null, canAdd: true,
    suggestedTagId: TAG, amountCents: 2870, recurringFrequency: "monthly",
  });
  const det: UiDetection = { suggestions: [suggestion()], deposits: [], dismissed: [], flags: [], lateCount: 0, suppressedCount: 0 };

  it("renders (closed) with budget facts, null and absent facts alike, and the facts do not appear in the markup", () => {
    for (const bf of [{ [budgetFactsKey(E, TAG)]: facts() }, null, undefined]) {
      const html = renderToStaticMarkup(<RecurringSuggestions detection={det} isAggregate={false} tagOptions={[{ id: TAG, label: "Bills / Streaming" }]} budgetFacts={bf} />);
      expect(html).toContain("Add as recurring expense");
      expect(html).not.toContain("/month budget");
    }
  });

  it("the view hands the suggestion's payment (cents) and recurring frequency to the row", () => {
    const base = {
      key: `${E}|a|out|netflix`, entityId: E, accountId: "a", kind: "outflow" as const, payee: "Netflix", baseName: "Netflix", accountName: null,
      cadence: "monthly" as const, typicalDay: 5, dayRule: "usually around the 5th", typicalAmount: new Decimal("28.70"), minAmount: new Decimal("28.70"),
      maxAmount: new Decimal("28.70"), amountMode: "fixed" as const, occurrences: 6, firstSeen: new Date("2026-04-05T00:00:00Z"), lastSeen: new Date("2026-09-05T00:00:00Z"),
      nextExpected: new Date("2026-10-05T00:00:00Z"), confidence: "high" as const, why: ["Seen 6 times"], dominantTagId: null, tagShare: 0, stale: false, suppressedBy: null,
    } as Series;
    const result: DetectResult = { suggestions: [base, { ...base, key: `${E}|a|out|insurance`, payee: "Insurance", cadence: "annual", typicalAmount: new Decimal("1200.00") }], suppressed: [], suppressedCount: 0, flags: [], staleCount: 0 };
    const ui = toUiDetection(applyDismissals(result, []), { [E]: "Personal" }, "2026-10-08");
    const byPayee = Object.fromEntries(ui.suggestions.map((s) => [s.payee, [s.amountCents, s.recurringFrequency]]));
    expect(byPayee).toEqual({ Netflix: [2870, "monthly"], Insurance: [120000, "annually"] });
  });
});

// ── The loader is read-only and fail-soft ─────────────────────────────────────

describe("loadBudgetHints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.budget.findMany.mockResolvedValue([
      { id: "b1", entityId: E, tagId: TAG, period: "2026-10", budgeted: new Decimal("60.00"), additionalAmountCents: new Decimal("1500") },
      { id: "b2", entityId: E, tagId: "t-parent", period: "2026-10", budgeted: null, additionalAmountCents: new Decimal("0") },
    ]);
    mockDb.scheduledBill.findMany.mockResolvedValue([{ entityId: E, budgetEntityId: null, budgetTagId: "t-bill" }]);
    mockDb.recurringExpense.findMany.mockResolvedValue([
      { entityId: E, tagId: TAG, amountCents: 1000, frequency: "weekly" },
      { entityId: E, tagId: "t-unrelated", amountCents: 500, frequency: "monthly" },
    ]);
  });

  it("returns plain numbers per entity|tag for the current period", async () => {
    const f = await loadBudgetHints({ entityId: E, now: new Date("2026-10-09T15:00:00Z") });
    expect(f).toEqual({
      [budgetFactsKey(E, TAG)]: { hasBudget: true, budgetedCents: 6000, additionalCents: 1500, linkedMonthlyCents: 4333, linkedCount: 1, hasBill: false },
      [budgetFactsKey(E, "t-parent")]: { hasBudget: true, budgetedCents: null, additionalCents: 0, linkedMonthlyCents: 0, linkedCount: 0, hasBill: false },
      [budgetFactsKey(E, "t-bill")]: { hasBudget: false, budgetedCents: null, additionalCents: 0, linkedMonthlyCents: 0, linkedCount: 0, hasBill: true },
    });
    expect(JSON.stringify(f)).not.toMatch(/\d{9,}/);
  });

  it("reads only: findMany with explicit selects, this period, this entity (no other db call exists on the mock)", async () => {
    await loadBudgetHints({ entityId: E, now: new Date("2026-10-09T15:00:00Z") });
    const b = mockDb.budget.findMany.mock.calls[0]?.[0];
    // carry-forward-seasonal-energy: the Budget read goes through the effective-budget loader, which reads the entity's
    // rows without a period filter (the carry needs earlier rows, the frontier needs later ones) and keeps the month.
    expect(b.where).toEqual({ entityId: E });
    expect(b.include).toBeUndefined();
    expect(b.select).toMatchObject({ entityId: true, tagId: true, period: true, budgeted: true, additionalAmountCents: true });
    expect(mockDb.scheduledBill.findMany.mock.calls[0]?.[0].where).toEqual({ active: true, budgetTagId: { not: null }, entityId: E });
    expect(mockDb.recurringExpense.findMany.mock.calls[0]?.[0].where).toEqual({ tagId: { not: null }, entityId: E });
    expect(mockDb.recurringExpense.findMany.mock.calls[0]?.[0].select).toEqual({ entityId: true, tagId: true, amountCents: true, frequency: true });
  });

  it("the all-entities view applies no entity filter", async () => {
    await loadBudgetHints({ entityId: null, now: new Date("2026-10-09T15:00:00Z") });
    expect(mockDb.budget.findMany.mock.calls[0]?.[0].where).toEqual({});
  });

  it("fail-soft: a read error gives null (never throws), so the step can show its generic line", async () => {
    mockDb.budget.findMany.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loadBudgetHints({ entityId: E, now: new Date("2026-10-09T15:00:00Z") })).resolves.toBeNull();
    // Logs the error class only, never the message.
    expect(spy.mock.calls[0]).toEqual(["Budget hints unavailable", "Error"]);
    spy.mockRestore();
  });

  it("the period is the UTC month the Budgets page opens on", () => {
    expect(currentBudgetPeriod(new Date("2026-01-31T23:59:00Z"))).toBe("2026-01");
    expect(currentBudgetPeriod(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });
});

describe("wiring (source)", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

  it("the loader has no write path and no raw SQL", () => {
    const src = read("lib/recurring-budget-hint-build.ts");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
    expect(src).not.toMatch(/^"use server"/m);
    // two direct reads (bills, recurring); the Budget read is the shared effective-budget loader
    expect(src).toMatch(/loadEffectiveBudgetRows\(\{ periods: \[currentBudgetPeriod\(now\)\], entityId \}\)/);
    expect(src.match(/\.findMany\(/g)).toHaveLength(2);
    expect(src.match(/select:/g)).toHaveLength(2);
    expect(src).not.toMatch(/nickname|mask|accountNumber|notes/);
  });

  it("the Forecast page loads the facts beside the ledger and passes them to the review list", () => {
    const src = read("app/forecast/page.tsx");
    expect(src).toMatch(/import \{ loadBudgetHints \} from "@\/lib\/recurring-budget-hint-build"/);
    expect(src).toMatch(/loadBudgetHints\(\{ entityId, now \}\)/);
    expect(src).toMatch(/budgetFacts=\{await budgetFactsPromise\}/);
    // The page body (above the section component) does not read them itself.
    const body = src.slice(0, src.indexOf("async function UpcomingSections"));
    expect(body).not.toMatch(/loadBudgetHints\(/);
  });

  it("nothing in /budgets or the Budget data is touched by the step", () => {
    const action = read("actions/recurring-suggestions.ts");
    expect(action).not.toMatch(/db\.budget\.(update|create|upsert|delete)/);
    const step = read("components/upcoming/suggestion-actions.tsx");
    expect(step).toMatch(/selectedTagNotice\(budgetFacts, entityId, step\.tagId, amountCents, recurringFrequency\)/);
  });
});
