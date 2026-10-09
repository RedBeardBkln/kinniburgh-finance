import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The client leaf imports the server actions; static markup never calls them.
vi.mock("@/actions/recurring-suggestions", () => ({
  addSuggestedRecurringExpense: vi.fn(),
  dismissSuggestion: vi.fn(),
  restoreSuggestion: vi.fn(),
}));

import { buildUpcomingLedger, type LearnedSeriesRow } from "@/lib/upcoming-ledger";
import { RECURRING_UNAVAILABLE, toUiLedger, type UiContext, type UiDetection, type UiSuggestion } from "@/lib/upcoming-ledger-view";
import { RecurringSuggestions } from "@/components/upcoming/recurring-suggestions";
import { RecurringHint } from "@/components/upcoming/recurring-hint";
import { UpcomingAgenda } from "@/components/upcoming/upcoming-agenda";
import { UpcomingWidget } from "@/components/upcoming/upcoming-widget";

(globalThis as unknown as { React: typeof React }).React = React;

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const P = "ent-p";

function suggestion(over: Partial<UiSuggestion> = {}): UiSuggestion {
  return {
    key: `${P}|acct|out|netflix`,
    entityId: P,
    entityName: "Personal",
    payee: "Netflix",
    kind: "outflow",
    cadence: "monthly",
    summary: "~$28.70 monthly, usually around the 5th",
    confidence: "high",
    confidenceLabel: "Strong pattern",
    why: "Seen 6 times, 30-31 days apart, always about $28.70, usually around the 5th.",
    nextLabel: "Next expected around Oct 5",
    canAdd: true,
    ...over,
  };
}

function detection(over: Partial<UiDetection> = {}): UiDetection {
  return { suggestions: [], deposits: [], dismissed: [], flags: [], lateCount: 0, suppressedCount: 0, ...over };
}

const render = (det: UiDetection | null | undefined, isAggregate = false) =>
  renderToStaticMarkup(<RecurringSuggestions detection={det} isAggregate={isAggregate} />);

describe("RecurringSuggestions", () => {
  it("renders nothing when the page has nothing to say, one muted line when detection failed", () => {
    expect(render(undefined)).toBe("");
    const html = render(null);
    expect(html).toContain(RECURRING_UNAVAILABLE);
    expect(html).toContain('id="looks-recurring"');
    expect(html).not.toContain("Add as recurring expense");
  });

  it("empty state has no money and no buttons", () => {
    const html = render(detection());
    expect(html).toContain("No new recurring patterns found");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("<button");
    expect(html).toContain("not included in the totals above");
  });

  it("lists suggestions with the facts, the confidence and both buttons", () => {
    const html = render(detection({ suggestions: [suggestion(), suggestion({ key: "k2", payee: "Gym Club", confidence: "low", confidenceLabel: "Weak pattern, 3 times", nextLabel: null })] }));
    expect(html).toContain("Looks recurring, not in your budget");
    expect(html).toContain("Netflix");
    expect(html).toContain("~$28.70 monthly, usually around the 5th");
    expect(html).toContain("Strong pattern");
    expect(html).toContain("Weak pattern, 3 times");
    expect(html).toContain("Seen 6 times");
    expect(html).toContain("Next expected around Oct 5");
    expect(html.match(/Add as recurring expense/g)).toHaveLength(2);
    expect(html.match(/Not a bill/g)).toHaveLength(2);
  });

  it("heads-up lines use observational wording", () => {
    const html = render(
      detection({
        flags: [
          { type: "late", text: "Mortgage usually posts around the 3rd; none seen yet this month.", entityId: P, entityName: "Personal" },
          { type: "amount_change", text: "Netflix: was about $19.13, latest was $22.99.", entityId: P, entityName: "Personal" },
          { type: "history_differs", text: "Lexus Financial: your records say $250.00 monthly; history shows about $250.00 every week.", entityId: P, entityName: "Personal" },
        ],
      })
    );
    expect(html).toContain("Heads up");
    expect(html).toContain("Mortgage usually posts around the 3rd; none seen yet this month.");
    expect(html).toContain("was about $19.13, latest was $22.99.");
    expect(html).toContain("history shows about $250.00 every week.");
  });

  it("regular deposits have no buttons; dismissed is collapsed with Show again", () => {
    const html = render(
      detection({
        deposits: [suggestion({ key: "d1", payee: "Acme Consulting", kind: "inflow", canAdd: false })],
        dismissed: [suggestion({ key: "x1", payee: "Old Thing" })],
      })
    );
    expect(html).toContain("Regular deposits");
    expect(html).toContain("never placed on the calendar");
    expect(html).toContain("Dismissed (1)");
    expect(html).toContain("Show again");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    const depositSection = html.slice(html.indexOf("Regular deposits"), html.indexOf("Dismissed (1)"));
    expect(depositSection).not.toContain("<button");
  });

  it("the all-entities view shows an entity chip; the hidden count is stated", () => {
    const html = render(detection({ suggestions: [suggestion()], suppressedCount: 2 }), true);
    expect(html).toContain("Personal");
    expect(html).toContain("2 more look already recorded");
  });

  it("never gives advice or claims certainty", () => {
    const html = render(
      detection({
        suggestions: [suggestion()],
        flags: [{ type: "late", text: "Mortgage usually posts around the 3rd; none seen yet this month.", entityId: P, entityName: "Personal" }],
        deposits: [suggestion({ key: "d1", kind: "inflow" })],
      })
    );
    expect(html).not.toMatch(/you should|CPA|guarantee|will definitely/i);
  });
});

describe("RecurringHint (dashboard)", () => {
  const hint = (det: UiDetection | null | undefined) => renderToStaticMarkup(<RecurringHint detection={det} bucketSlug="personal" />);

  it("nothing when empty or not provided; a muted notice when detection failed", () => {
    expect(hint(undefined)).toBe("");
    expect(hint(detection())).toBe("");
    expect(hint(null)).toContain(RECURRING_UNAVAILABLE);
  });

  it("counts suggestions and late bills, links to the review list, lists at most 5 late lines", () => {
    const flags = Array.from({ length: 7 }, (_, i) => ({
      type: "late" as const,
      text: `Bill ${i} usually posts around the 3rd; none seen yet this month.`,
      entityId: P,
      entityName: "Personal",
    }));
    const html = hint(detection({ suggestions: [suggestion(), suggestion({ key: "k2" }), suggestion({ key: "k3" })], flags, lateCount: 7 }));
    expect(html).toContain("3 items look recurring but are not in your budget, 7 expected bills have not posted.");
    expect(html).toContain('href="/forecast?bucket=personal#looks-recurring"');
    expect(html.match(/Bill \d usually/g)).toHaveLength(5);
  });

  it("singular wording", () => {
    const html = hint(
      detection({
        suggestions: [suggestion()],
        flags: [{ type: "late", text: "Mortgage usually posts around the 3rd; none seen yet this month.", entityId: P, entityName: "Personal" }],
      })
    );
    expect(html).toContain("1 item looks recurring but is not in your budget, 1 expected bill has not posted.");
  });

  it("an amount change alone does not trigger the dashboard line", () => {
    expect(hint(detection({ flags: [{ type: "amount_change", text: "x", entityId: P, entityName: "Personal" }] }))).toBe("");
  });
});

describe("learned block in the agenda and the widget", () => {
  const ctx = (over: Partial<UiContext> = {}): UiContext => ({
    days: 30,
    bucketSlug: "personal",
    isAggregate: false,
    entityNameById: { [P]: "Personal" },
    entitySlugById: { [P]: "personal" },
    accountNameById: {},
    includeTransfers: false,
    ...over,
  });
  const learned: LearnedSeriesRow = {
    key: `${P}|acct|out|gym club`,
    entityId: P,
    accountId: null,
    payee: "Gym Club",
    kind: "outflow",
    cadence: "monthly",
    amount: 40,
    minAmount: 40,
    maxAmount: 40,
    amountMode: "fixed",
    confidence: "high",
    why: "Seen 6 times, always about $40.00.",
    dates: [d("2026-10-14")],
  };
  const ui = (rows: LearnedSeriesRow[], c: Partial<UiContext> = {}) =>
    toUiLedger(
      buildUpcomingLedger({
        from: d("2026-10-08"),
        days: 30,
        bills: [{ id: "b", accountId: "a", entityId: P, payee: "Mortgage", amountType: "static", expectedAmount: 1250, autopayDay: 12, annualBudget: null, active: true, budgetTagId: null, budgetEntityId: null }],
        learned: rows,
      }),
      ctx(c)
    );

  it("agenda: a labelled block outside the counted total", () => {
    const html = renderToStaticMarkup(<UpcomingAgenda ledger={ui([learned])} bucketSlug="personal" horizon={30} showTransfers={false} />);
    expect(html).toContain("Looks recurring, not counted (1 pattern, ~$40.00 a month)");
    expect(html).toContain("Learned from history");
    expect(html).toContain("Gym Club");
    expect(html).toContain("not in the totals above");
    // The counted summary is the mortgage alone.
    expect(html).toContain("~$1,250.00");
    expect(html).not.toContain("~$1,290.00");
  });

  it("agenda: no block, no heading when there is nothing learned", () => {
    const html = renderToStaticMarkup(<UpcomingAgenda ledger={ui([])} bucketSlug="personal" horizon={30} showTransfers={false} />);
    expect(html).not.toContain("Looks recurring, not counted");
  });

  it("agenda: the all-entities view shows the count but no blended money", () => {
    const html = renderToStaticMarkup(<UpcomingAgenda ledger={ui([learned], { isAggregate: true })} bucketSlug="taxes" horizon={30} showTransfers={false} />);
    expect(html).toContain("Looks recurring, not counted (1 pattern)");
  });

  it("widget never lists learned rows; it shows the one-line hint when given a detection", () => {
    const html = renderToStaticMarkup(
      <UpcomingWidget ledger={ui([learned])} bucketSlug="personal" detection={detection({ suggestions: [suggestion()] })} />
    );
    expect(html).not.toContain("Gym Club");
    expect(html).toContain("1 item looks recurring but is not in your budget.");
  });

  it("widget: omitting detection leaves the card exactly as before", () => {
    const html = renderToStaticMarkup(<UpcomingWidget ledger={ui([])} bucketSlug="personal" />);
    expect(html).not.toContain("recurring");
  });
});
