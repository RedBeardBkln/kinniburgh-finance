import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The agenda imports no server action; this mock only guards the transitive import of the suggestion buttons.
vi.mock("@/actions/recurring-suggestions", () => ({
  addSuggestedRecurringExpense: vi.fn(),
  dismissSuggestion: vi.fn(),
  restoreSuggestion: vi.fn(),
}));

import { buildUpcomingLedger, type LearnedSeriesRow } from "@/lib/upcoming-ledger";
import { toUiLedger, type UiContext } from "@/lib/upcoming-ledger-view";
import { UpcomingAgenda } from "@/components/upcoming/upcoming-agenda";
import { UpcomingAgendaSkeleton, UpcomingWidgetSkeleton } from "@/components/upcoming/upcoming-skeleton";

(globalThis as unknown as { React: typeof React }).React = React;

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const P = "ent-p";
const S = "ent-s";

const ctx = (over: Partial<UiContext> = {}): UiContext => ({
  days: 90,
  bucketSlug: "personal",
  isAggregate: false,
  entityNameById: { [P]: "Personal", [S]: "Sudden Valley" },
  entitySlugById: { [P]: "personal", [S]: "sudden-valley" },
  accountNameById: {},
  includeTransfers: false,
  ...over,
});

function row(over: Partial<LearnedSeriesRow>): LearnedSeriesRow {
  return {
    key: `${P}|a|out|ring`,
    entityId: P,
    accountId: null,
    payee: "Ring",
    kind: "outflow",
    cadence: "monthly",
    amount: 21.26,
    minAmount: 21.26,
    maxAmount: 21.26,
    amountMode: "fixed",
    confidence: "high",
    why: "Seen 6 times, always about $21.26.",
    dates: [d("2026-11-06"), d("2026-12-06")],
    ...over,
  };
}

const agenda = (learned: LearnedSeriesRow[], c: Partial<UiContext> = {}) =>
  renderToStaticMarkup(
    <UpcomingAgenda
      ledger={toUiLedger(buildUpcomingLedger({ from: d("2026-10-08"), days: 90, learned }), ctx(c))}
      bucketSlug="personal"
      horizon={90}
      showTransfers={false}
    />
  );

describe("agenda: the learned block shows one row per series", () => {
  it("a series with many dates in the window is one list item with the cadence phrase", () => {
    const html = agenda([row({})]);
    expect(html.match(/<li /g) ?? []).toHaveLength(1);
    expect(html).toContain("monthly, ~$21.26, next Nov 6");
    expect(html).toContain("Looks recurring, not counted (1 pattern, ~$21.26 a month)");
    // 'Dec 6' (the second date) is not listed as a row of its own.
    expect(html).not.toContain("Dec 6");
    expect(html).toContain("Learned from history");
    expect(html).toContain("not in the totals above");
  });

  it("the heading count equals the rows and the figure is labelled as a monthly pattern figure, not an amount due", () => {
    const html = agenda([
      row({ key: "w", payee: "Weekly Co", cadence: "weekly", amount: 31, minAmount: 31, maxAmount: 31, dates: [d("2026-10-12"), d("2026-10-19"), d("2026-10-26")] }),
      row({ key: "m", payee: "Monthly Co", dates: [d("2026-10-30")] }),
    ]);
    expect(html.match(/data-testid="learned-block"[\s\S]*?<\/section>/)?.[0].match(/<li /g)).toHaveLength(2);
    expect(html).toContain("Looks recurring, not counted (2 patterns, ~$155.59 a month)");
    expect(html).toContain("it is not an amount due");
    expect(html).toContain("weekly, ~$31.00, next Oct 12");
    // The counted summary is untouched by the learned patterns: nothing is due.
    expect(html).toContain("~$0.00</span> due");
  });

  it("all-entities view: entity chip per row, per-entity counts, and no blended money", () => {
    const html = agenda(
      [row({ key: "p", payee: "P Co", dates: [d("2026-10-20")] }), row({ key: "s", payee: "S Co", entityId: S, dates: [d("2026-10-21")] })],
      { isAggregate: true, bucketSlug: "taxes" }
    );
    expect(html).toContain("Looks recurring, not counted (2 patterns)");
    expect(html).not.toContain("a month)");
    expect(html).toContain("Personal: 1, Sudden Valley: 1");
    expect(html).toContain("Sudden Valley");
    expect(html).not.toContain("it is not an amount due");
  });

  it("nothing learned: no block", () => {
    expect(agenda([])).not.toContain("Looks recurring, not counted");
  });

  it("no advice wording and no row amounts presented as due", () => {
    const html = agenda([row({})]).replace(/<[^>]+>/g, " ");
    expect(html).not.toMatch(/\b(you should|we recommend|will be charged|guarantee)/i);
  });
});

describe("skeletons (Suspense fallbacks)", () => {
  it("the dashboard skeleton is an accessible polite status with hidden-from-AT bars and no data", () => {
    const html = renderToStaticMarkup(<UpcomingWidgetSkeleton days={30} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("sr-only");
    expect(html).toContain("Loading upcoming items");
    expect(html).toContain("Next 30 days");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("motion-safe:animate-pulse");
    expect(html).not.toContain("$");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });

  it("the forecast skeleton keeps the #upcoming and #looks-recurring anchors from the first paint", () => {
    const html = renderToStaticMarkup(<UpcomingAgendaSkeleton horizon={60} />);
    expect(html).toContain('id="upcoming"');
    expect(html).toContain('id="looks-recurring"');
    expect(html).toContain("Upcoming - next 60 days");
    expect(html).toContain("Loading recurring patterns");
    expect(html.match(/role="status"/g)).toHaveLength(2);
    expect(html).not.toContain("$");
  });
});
