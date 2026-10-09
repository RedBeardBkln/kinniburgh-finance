import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildUpcomingLedger, type UpcomingBillRow, type UpcomingBudgetRow } from "@/lib/upcoming-ledger";
import { toUiLedger, type UiContext } from "@/lib/upcoming-ledger-view";
import { UpcomingAgenda } from "@/components/upcoming/upcoming-agenda";
import { applyClearingNotes } from "@/lib/recurring-detect";

(globalThis as unknown as { React: typeof React }).React = React;

// net-income-budget-dates: a bill dated by its budget while the record says another day shows a MUTED information
// line (not the amber "Records disagree" style); an amount mismatch keeps the amber style.

const P = "ent-personal";
const bill: UpcomingBillRow = {
  id: "sol",
  accountId: "acct-main",
  entityId: P,
  payee: "Solar",
  amountType: "static",
  expectedAmount: 200,
  autopayDay: 17,
  annualBudget: null,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  active: true,
  budgetTagId: "t-sol",
  budgetEntityId: P,
};
const row = (over: Partial<UpcomingBudgetRow> = {}): UpcomingBudgetRow => ({
  id: "b10",
  tagId: "t-sol",
  tagName: "Solar",
  entityId: P,
  accountId: "acct-main",
  period: "2026-10",
  budgeted: 200,
  payDay: 14,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  annualAmountDue: null,
  ...over,
});
const ctx: UiContext = {
  days: 30,
  bucketSlug: "personal",
  isAggregate: false,
  entityNameById: { [P]: "Personal" },
  entitySlugById: { [P]: "personal" },
  accountNameById: { "acct-main": "Primary Checking" },
  includeTransfers: false,
};
const html = (budgets: UpcomingBudgetRow[], withClearing = false) => {
  const ledger = buildUpcomingLedger({ from: new Date("2026-10-08T00:00:00Z"), days: 30, bills: [bill], budgets });
  if (withClearing) {
    applyClearingNotes(ledger.items, [{ source: "scheduled_bill", sourceId: "sol", typicalDay: 17, lagDays: 3, samples: 6 }]);
  }
  return renderToStaticMarkup(<UpcomingAgenda ledger={toUiLedger(ledger, ctx)} bucketSlug="personal" horizon={30} showTransfers={false} />);
};

describe("date note rendering", () => {
  it("shows the budget-date line muted, with no 'Records disagree' for the day", () => {
    const out = html([row()]);
    expect(out).toContain("Dated by the budget (day 14) because the money has to be in the account then.");
    expect(out).toContain("The bill record says day 17. The bank may take a few days to clear it.");
    expect(out).not.toContain("Records disagree");
    const noteTag = /<p class="([^"]*)">Dated by the budget/.exec(out);
    expect(noteTag?.[1]).toContain("text-muted-foreground");
    expect(noteTag?.[1]).not.toContain("amber");
  });
  it("adds 'Usually clears about the 17th.' from the clearing lag, still muted", () => {
    const out = html([row()], true);
    expect(out).toContain("Usually clears about the 17th.");
    expect(out).toContain("Dated by the budget (day 14)");
  });
  it("an amount mismatch still renders the amber 'Records disagree' line", () => {
    const out = html([row({ budgeted: 1500 })]);
    expect(out).toMatch(/<p class="[^"]*amber[^"]*">Records disagree: /);
  });
  it("no date note when the days agree", () => {
    expect(html([row({ payDay: 17 })])).not.toContain("Dated by the budget");
  });
});
