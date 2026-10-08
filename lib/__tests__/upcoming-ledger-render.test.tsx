import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildUpcomingLedger, type UpcomingLedgerInput } from "@/lib/upcoming-ledger";
import { toUiLedger, type UiContext } from "@/lib/upcoming-ledger-view";
import { UpcomingWidget } from "@/components/upcoming/upcoming-widget";
import { UpcomingAgenda } from "@/components/upcoming/upcoming-agenda";

// Static renders of the presentational pieces (the repo has no DOM test infra).
(globalThis as unknown as { React: typeof React }).React = React;

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const P = "ent-p";
const SV = "ent-sv";

const ctx = (over: Partial<UiContext> = {}): UiContext => ({
  days: 30,
  bucketSlug: "personal",
  isAggregate: false,
  entityNameById: { [P]: "Personal", [SV]: "Sudden Valley" },
  entitySlugById: { [P]: "personal", [SV]: "sudden-valley" },
  accountNameById: { "acct-main": "Primary Checking" },
  includeTransfers: false,
  ...over,
});

const bill = (over: Record<string, unknown>) => ({
  accountId: "acct-main",
  entityId: P,
  amountType: "static",
  expectedAmount: 100,
  autopayDay: 12,
  annualBudget: null,
  active: true,
  budgetTagId: null,
  budgetEntityId: null,
  ...over,
});

function ui(input: Partial<UpcomingLedgerInput>, c: Partial<UiContext> = {}) {
  return toUiLedger(buildUpcomingLedger({ from: d("2026-10-08"), days: 30, ...input }), ctx(c));
}

const widget = (l: ReturnType<typeof ui> | null) => renderToStaticMarkup(<UpcomingWidget ledger={l} bucketSlug="personal" />);

describe("UpcomingWidget", () => {
  it("empty state", () => {
    const html = widget(ui({}));
    expect(html).toContain("Nothing due in the next 30 days.");
    expect(html).toContain("Next 30 days");
  });

  it("error state renders a small notice and nothing else", () => {
    const html = widget(null);
    expect(html).toContain("Upcoming items are unavailable right now.");
    expect(html).not.toContain("Next 30 days");
  });

  it("shows an estimate badge with its reason, and 'amount not set' for an unknown amount", () => {
    const html = widget(
      ui({
        bills: [
          bill({ id: "ev", payee: "Electric (Eversource)", amountType: "fluctuating", expectedAmount: 172, autopayDay: 20 }),
          bill({ id: "unk", payee: "Mystery bill", expectedAmount: null, autopayDay: 14 }),
        ] as UpcomingLedgerInput["bills"],
      })
    );
    expect(html).toContain("estimate");
    expect(html).toContain("amount varies from month to month");
    expect(html).toContain("~$172.00");
    expect(html).toContain("amount not set");
    expect(html).not.toContain("$0.00");
    expect(html).toContain("1 item has no amount set");
  });

  it("a zero-amount paycheck, payout, projected revenue or transfer shows 'amount not set', never $0.00", () => {
    const html = widget(
      ui({
        incomeSources: [{ id: "z", accountId: "acct-main", entityId: P, description: "Zero pay", cadence: "monthly", dayRules: { dayOfMonth: 15 }, amount: 0, active: true }],
        rentalBookings: [{ id: "r0", entityId: P, payoutDate: d("2026-10-19"), guest: "Zero", grossEarnings: 0 }],
        projectedRevenue: [{ id: "p0", entityId: P, description: "Zero invoice", expectedDate: d("2026-10-25"), amountCents: 0 }],
      })
    );
    expect(html).toContain("Zero pay");
    expect(html).toContain("Airbnb payout (gross): Zero");
    expect(html).toContain("Zero invoice");
    expect(html.match(/amount not set/g)?.length).toBeGreaterThanOrEqual(3);
    // no row shows a known zero: the only "~$0.00" is the summary strip's counted-bills total
    expect(html.match(/~\$0\.00/g)).toHaveLength(1);
    expect(html).toContain("3 items have no amount set");
  });

  it("a records disagreement shows both figures", () => {
    const html = widget(
      ui({
        bills: [bill({ id: "toy", payee: "Toyota (Tacoma)", expectedAmount: 420, autopayDay: 30, budgetTagId: "t", budgetEntityId: P })] as UpcomingLedgerInput["bills"],
        budgets: [
          { id: "b", tagId: "t", tagName: "Toyota", entityId: P, accountId: "acct-main", period: "2026-10", budgeted: 1500, payDay: 30, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null },
        ],
      })
    );
    expect(html).toContain("Records disagree");
    expect(html).toContain("~$1,500.00");
    expect(html).toContain("~$420.00");
  });

  it("does not list envelope transfers, but summarizes them as not counted", () => {
    const html = widget(
      ui({
        transfers: [{ id: "t", fromAccountId: "acct-main", toAccountId: "e", fromEntityId: P, amount: 256, cadence: "weekly", dayRules: { dayOfWeek: 1 }, purpose: "Groceries envelope top-up", active: true }],
      })
    );
    expect(html).not.toContain("Groceries envelope top-up");
    expect(html).toContain("4 envelope transfers");
    expect(html).toContain("not counted");
  });

  it("lists undated, past-due and held-back records in collapsed disclosures", () => {
    const html = widget(
      ui({
        bills: [
          bill({ id: "lex", payee: "Lexus Financial", expectedAmount: 250, autopayDay: null }),
          bill({ id: "ev", payee: "Electric (Eversource)", expectedAmount: 172, autopayDay: 20, budgetTagId: "t-ev", budgetEntityId: P }),
          bill({ id: "ev-old", payee: "Eversource", expectedAmount: 184, autopayDay: 20 }),
        ] as UpcomingLedgerInput["bills"],
        cards: [{ id: "b", nickname: "Barclay", entityId: P, ccDueDate: d("2026-10-05"), ccStatementBalance: "623.19" }],
      })
    );
    expect(html).toContain("Day not set (1)");
    expect(html).toContain("Past due date, may already be paid (1)");
    expect(html).toContain("Possible duplicates held back (1)");
    expect(html).not.toMatch(/<details open/);
  });

  it("the aggregate variant shows one line per entity and no blended total", () => {
    const html = widget(
      ui(
        {
          bills: [
            bill({ id: "p", payee: "Personal bill", expectedAmount: 100, autopayDay: 12 }),
            bill({ id: "s", payee: "SV bill", entityId: SV, expectedAmount: 40, autopayDay: 13 }),
          ] as UpcomingLedgerInput["bills"],
        },
        { isAggregate: true, bucketSlug: "taxes" }
      )
    );
    expect(html).toContain("Personal");
    expect(html).toContain("Sudden Valley");
    expect(html).toContain("~$100.00");
    expect(html).toContain("~$40.00");
    expect(html).not.toContain("~$140.00");
  });

  it("links rows to their underlying page and the footer states estimates are marked", () => {
    const html = widget(ui({ bills: [bill({ id: "m", payee: "Mortgage", autopayDay: 9, budgetTagId: "t", budgetEntityId: P })] as UpcomingLedgerInput["bills"] }));
    expect(html).toContain('href="/budgets?bucket=personal&amp;period=2026-10"');
    expect(html).toContain('href="/forecast?bucket=personal#upcoming"');
    expect(html).toContain("Estimates are marked. Not financial advice.");
  });

  it("truncates to 12 rows with a '+N more' pointer", () => {
    const html = widget(
      ui({
        incomeSources: [{ id: "w", accountId: "acct-main", entityId: P, description: "Daily pay", cadence: "weekly", dayRules: { dayOfWeek: 1 }, amount: 1, active: true }],
        bills: Array.from({ length: 12 }, (_, i) => bill({ id: `b${i}`, payee: `Bill ${i}`, autopayDay: 9 + (i % 12) })) as UpcomingLedgerInput["bills"],
      })
    );
    expect(html).toMatch(/\+\d+ more in the/);
  });
});

describe("UpcomingAgenda", () => {
  const agenda = (l: ReturnType<typeof ui> | null, horizon: 30 | 60 | 90 = 90, showTransfers = false) =>
    renderToStaticMarkup(<UpcomingAgenda ledger={l} bucketSlug="sudden-valley" horizon={horizon} showTransfers={showTransfers} />);

  it("marks the active horizon tab and keeps the bucket in every tab link", () => {
    const html = agenda(ui({}, { days: 60 }), 60);
    expect(html).toContain('id="upcoming"');
    expect(html).toMatch(/aria-current="page"[^>]*>60 days/);
    for (const n of [30, 60, 90]) {
      expect(html).toContain(`href="/forecast?bucket=sudden-valley&amp;horizon=${n}#upcoming"`);
    }
  });

  it("groups rows by week, with week subtotals, a confidence column and notes", () => {
    const html = agenda(
      ui({
        bills: [
          bill({ id: "fl", payee: "Eversource", amountType: "fluctuating", expectedAmount: 83, autopayDay: 12, entityId: SV }),
        ] as UpcomingLedgerInput["bills"],
      }),
      30
    );
    expect(html).toContain("Week of Oct 12");
    expect(html).toContain("~$83.00 due");
    expect(html).toContain("Confidence");
    expect(html).toContain("estimate");
  });

  it("week header: only non-zero segments, 'N without an amount' for unknowns, nothing when nothing to report", () => {
    // week of Oct 12: a known bill (due) and an unknown bill; week of Oct 19: only an unknown bill; week of Oct 26: only a paycheck
    const html = agenda(
      ui({
        bills: [
          bill({ id: "k", payee: "Known bill", expectedAmount: 83, autopayDay: 12, entityId: SV }),
          bill({ id: "u1", payee: "Unknown A", expectedAmount: null, autopayDay: 13, entityId: SV }),
          bill({ id: "u2", payee: "Unknown B", expectedAmount: null, autopayDay: 21, entityId: SV }),
        ] as UpcomingLedgerInput["bills"],
        incomeSources: [{ id: "w", accountId: "acct-main", entityId: SV, description: "Pay", cadence: "monthly", dayRules: { dayOfMonth: 28 }, amount: 50, active: true }],
      }),
      30
    );
    expect(html).toContain("~$83.00 due, 1 without an amount");
    expect(html).not.toContain("expected in, ");
    expect(html).toContain("~$50.00 expected in");
    expect(html).toMatch(/Week of Oct 19<\/h3><span[^>]*>1 without an amount<\/span>/);
    expect(html).not.toContain("~$0.00");
  });

  it("week header renders no subtotal text for a week with only an informational item", () => {
    const html = agenda(
      ui({ taxDeadlines: [{ id: "x", entityId: SV, label: "Schedule E", dueDate: d("2026-10-15"), status: "upcoming" }] }),
      30
    );
    expect(html).toContain("Week of Oct 12</h3></div>");
    // the week heading has no subtotal span; the only "~$0.00" left is the summary strip's counted total
    expect(html.match(/~\$0\.00/g)).toHaveLength(1);
    expect(html.match(/ due</g)).toHaveLength(1);
  });

  it("a zero-amount transfer, when transfers are shown in the agenda, reads 'amount not set'", () => {
    const html = renderToStaticMarkup(
      <UpcomingAgenda
        ledger={ui(
          { transfers: [{ id: "t", fromAccountId: "a", toAccountId: "b", fromEntityId: P, amount: 0, cadence: "weekly", dayRules: { dayOfWeek: 1 }, purpose: "Zero top-up", active: true }] },
          { includeTransfers: true }
        )}
        bucketSlug="personal"
        horizon={30}
        showTransfers
      />
    );
    expect(html).toContain("Zero top-up");
    expect(html).toContain("amount not set");
    // only the summary strip's "~$0.00 due"; the transfer note no longer prints a zero total
    expect(html.match(/~\$0\.00/g)).toHaveLength(1);
    expect(html).toContain("4 envelope transfers, not counted");
  });

  it("offers a transfers toggle that flips the flag", () => {
    const withTransfers = ui({
      transfers: [{ id: "t", fromAccountId: "a", toAccountId: "b", fromEntityId: P, amount: 5, cadence: "weekly", dayRules: { dayOfWeek: 1 }, active: true }],
    });
    expect(agenda(withTransfers)).toContain("Show envelope transfers");
    expect(agenda(withTransfers)).toContain("horizon=90&amp;transfers=1#upcoming");
    expect(agenda(ui({ transfers: withTransfers.items.length ? [{ id: "t", fromAccountId: "a", toAccountId: "b", fromEntityId: P, amount: 5, cadence: "weekly", dayRules: { dayOfWeek: 1 }, active: true }] : [] }, { includeTransfers: true }), 90, true)).toContain("Hide envelope transfers");
  });

  it("error state shows the notice inside the card", () => {
    expect(agenda(null)).toContain("Upcoming items are unavailable right now.");
  });

  it("expands the disclosures by default", () => {
    const html = agenda(ui({ bills: [bill({ id: "lex", payee: "Lexus Financial", autopayDay: null })] as UpcomingLedgerInput["bills"] }));
    expect(html).toMatch(/<details open=""/);
    expect(html).toContain("Day not set (1)");
  });
});
