import { describe, expect, it } from "vitest";
import { buildUpcomingLedger, type UpcomingLedgerInput } from "@/lib/upcoming-ledger";
import {
  approx,
  formatDay,
  formatMoney,
  groupByDate,
  groupByWeek,
  hrefFor,
  mondayOf,
  parseHorizon,
  parseTransfersFlag,
  toUiLedger,
  truncateItems,
  weekSubtotalText,
  type UiContext,
} from "@/lib/upcoming-ledger-view";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const P = "ent-p";
const SV = "ent-sv";

const ctx = (over: Partial<UiContext> = {}): UiContext => ({
  days: 90,
  bucketSlug: "personal",
  isAggregate: false,
  entityNameById: { [P]: "Personal", [SV]: "Sudden Valley" },
  entitySlugById: { [P]: "personal", [SV]: "sudden-valley" },
  accountNameById: { "acct-main": "Primary Checking" },
  includeTransfers: false,
  ...over,
});

function sample(input: Partial<UpcomingLedgerInput> = {}) {
  return buildUpcomingLedger({
    from: d("2026-10-08"),
    days: 90,
    bills: [
      {
        id: "toy",
        accountId: "acct-main",
        entityId: P,
        payee: "Toyota (Tacoma)",
        amountType: "static",
        expectedAmount: 420,
        autopayDay: 30,
        annualBudget: null,
        active: true,
        budgetTagId: "t-toy",
        budgetEntityId: P,
      },
      {
        id: "ev",
        accountId: "acct-main",
        entityId: P,
        payee: "Electric (Eversource)",
        amountType: "fluctuating",
        expectedAmount: 172,
        autopayDay: 20,
        annualBudget: null,
        active: true,
        budgetTagId: "t-ev",
        budgetEntityId: P,
      },
      {
        id: "lex",
        accountId: "acct-main",
        entityId: P,
        payee: "Lexus Financial",
        amountType: "static",
        expectedAmount: 250,
        autopayDay: null,
        annualBudget: null,
        active: true,
        budgetTagId: null,
        budgetEntityId: null,
      },
      {
        id: "unk",
        accountId: "acct-main",
        entityId: P,
        payee: "No amount bill",
        amountType: "static",
        expectedAmount: null,
        autopayDay: 12,
        annualBudget: null,
        active: true,
        budgetTagId: null,
        budgetEntityId: null,
      },
    ],
    budgets: [
      {
        id: "b-toy-11",
        tagId: "t-toy",
        tagName: "Toyota (Tacoma)",
        entityId: P,
        accountId: "acct-main",
        period: "2026-11",
        budgeted: 1500,
        payDay: 30,
        frequency: "monthly",
        payDayOfWeek: null,
        biweeklyAnchorDate: null,
        payMonth: null,
        annualAmountDue: null,
      },
    ],
    incomeSources: [
      { id: "pay", accountId: "acct-main", entityId: P, description: "Eva pay", cadence: "biweekly", dayRules: { intervalDays: 14, anchorDate: "2026-08-28" }, amount: 2555, active: true },
    ],
    rentalBookings: [{ id: "r", entityId: SV, payoutDate: d("2026-10-19"), guest: "Pat", grossEarnings: 1075 }],
    taxDeadlines: [{ id: "td", entityId: SV, label: "Schedule E", dueDate: d("2026-10-15"), status: "upcoming" }],
    transfers: [
      { id: "t", fromAccountId: "acct-main", toAccountId: "e", fromEntityId: P, amount: 256, cadence: "weekly", dayRules: { dayOfWeek: 1 }, active: true },
    ],
    ...input,
  });
}

describe("money and date formatting", () => {
  it("formats approximate money, never a bare $0.00 for unknown", () => {
    expect(formatMoney("1234.5")).toBe("1,234.50");
    expect(formatMoney("-71.67")).toBe("71.67");
    expect(formatMoney("5")).toBe("5.00");
    expect(approx("1234.56")).toBe("~$1,234.56");
    const ui = toUiLedger(sample(), ctx());
    const unknown = ui.items.find((i) => i.label === "No amount bill")!;
    expect(unknown.amountText).toBe("amount not set");
    expect(unknown.amountText).not.toContain("$0.00");
  });

  it("shows a Jan 1 UTC-midnight date as Jan 1 and Oct 12 as Oct 12 (no off-by-one)", () => {
    expect(formatDay("2027-01-01")).toBe("Fri, Jan 1");
    expect(formatDay("2026-10-12")).toBe("Mon, Oct 12");
    expect(formatDay("2026-10-12", true)).toBe("Mon, Oct 12, 2026");
    const ui = toUiLedger(
      buildUpcomingLedger({
        from: d("2026-10-08"),
        days: 30,
        cards: [{ id: "jb", nickname: "jetBlue", entityId: P, ccDueDate: d("2026-10-12"), ccStatementBalance: "51.26" }],
      }),
      ctx()
    );
    expect(ui.items[0]!.dateLabel).toBe("Mon, Oct 12");
  });

  it("mondayOf finds the Monday on or before", () => {
    expect(mondayOf("2026-10-08")).toBe("2026-10-05");
    expect(mondayOf("2026-10-05")).toBe("2026-10-05");
    expect(mondayOf("2026-10-11")).toBe("2026-10-05");
    expect(mondayOf("2027-01-01")).toBe("2026-12-28");
  });
});

describe("links", () => {
  it("builds the documented hrefs", () => {
    expect(hrefFor({ page: "budgets", period: "2026-11" }, "personal")).toBe("/budgets?bucket=personal&period=2026-11");
    expect(hrefFor({ page: "forecast", anchor: "rental-bookings" }, "sudden-valley")).toBe("/forecast?bucket=sudden-valley#rental-bookings");
    expect(hrefFor({ page: "revenue" }, "sudden-valley")).toBe("/business/sudden-valley/revenue");
    expect(hrefFor({ page: "envelope" }, "personal")).toBe("/envelope");
    expect(hrefFor({ page: "accounts" }, "personal")).toBe("/accounts");
    expect(hrefFor({ page: "tax" }, "personal")).toBe("/tax");
    expect(hrefFor({ page: "vault" }, "personal")).toBe("/vault");
  });

  it("uses each row's own entity slug, falling back to the active bucket", () => {
    const ui = toUiLedger(sample(), ctx({ bucketSlug: "taxes", isAggregate: true }));
    const rental = ui.items.find((i) => i.label.includes("Airbnb"))!;
    expect(rental.href).toBe("/forecast?bucket=sudden-valley#rental-bookings");
    const noSlug = toUiLedger(sample(), ctx({ bucketSlug: "taxes", entitySlugById: {} }));
    expect(noSlug.items.find((i) => i.label.includes("Airbnb"))!.href).toBe("/forecast?bucket=taxes#rental-bookings");
  });
});

describe("toUiLedger", () => {
  it("hides transfers unless asked, but always reports the summary", () => {
    const hidden = toUiLedger(sample(), ctx());
    expect(hidden.items.some((i) => i.kind === "transfer")).toBe(false);
    expect(hidden.transferSummary.count).toBeGreaterThan(0);
    const shown = toUiLedger(sample(), ctx({ includeTransfers: true }));
    expect(shown.items.some((i) => i.kind === "transfer")).toBe(true);
  });

  it("describes a records disagreement with both figures", () => {
    const ui = toUiLedger(sample(), ctx());
    const nov = ui.items.find((i) => i.label === "Toyota (Tacoma)" && i.dateIso === "2026-11-30")!;
    expect(nov.disagreements).toEqual(["Records disagree: budget says ~$1,500.00 a month, bill record says ~$420.00"]);
  });

  it("marks estimates and carries the plain reason", () => {
    const ui = toUiLedger(sample(), ctx());
    const ev = ui.items.find((i) => i.label === "Electric (Eversource)")!;
    expect(ev.estimate).toBe(true);
    expect(ev.tierNote).toBe("amount varies from month to month");
    expect(ui.items.find((i) => i.label === "Toyota (Tacoma)")!.estimate).toBe(false);
  });

  it("keeps per-entity totals (sorted by name) and plain strings only", () => {
    const ui = toUiLedger(sample(), ctx({ isAggregate: true }));
    expect(ui.entityTotals.map((e) => e.entityName)).toEqual(["Personal", "Sudden Valley"]);
    expect(JSON.stringify(ui)).not.toContain("[object");
    expect(typeof ui.totals.outflow).toBe("string");
  });

  it("generated text avoids certainty and advice phrasing", () => {
    const ui = toUiLedger(sample(), ctx());
    const text = JSON.stringify(ui).toLowerCase();
    for (const banned of ["guarantee", "will be charged", "you should", "we recommend", "will pay"]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("grouping and truncation", () => {
  it("groups by date", () => {
    const ui = toUiLedger(sample(), ctx());
    const groups = groupByDate(ui.items);
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) expect(g.items.every((i) => i.dateIso === g.dateIso)).toBe(true);
    expect(groups.flatMap((g) => g.items)).toHaveLength(ui.items.filter((i) => i.dateIso).length);
  });

  it("groups by Monday-start week with counted subtotals", () => {
    const ledger = buildUpcomingLedger({
      from: d("2026-10-08"),
      days: 14,
      bills: [
        { id: "a", accountId: "x", entityId: P, payee: "A", amountType: "static", expectedAmount: 100.5, autopayDay: 9, annualBudget: null, active: true, budgetTagId: null, budgetEntityId: null },
        { id: "b", accountId: "x", entityId: P, payee: "B", amountType: "static", expectedAmount: 20.25, autopayDay: 12, annualBudget: null, active: true, budgetTagId: null, budgetEntityId: null },
      ],
      incomeSources: [{ id: "i", accountId: "x", entityId: P, description: "Pay", cadence: "monthly", dayRules: { dayOfMonth: 10 }, amount: 1000, active: true }],
    });
    const weeks = groupByWeek(toUiLedger(ledger, ctx()).items);
    expect(weeks.map((w) => w.weekStartIso)).toEqual(["2026-10-05", "2026-10-12"]);
    expect(weeks[0]).toMatchObject({ label: "Week of Oct 5", outflow: "100.50", inflow: "1000.00" });
    expect(weeks[1]).toMatchObject({ outflow: "20.25", inflow: "0.00" });
  });

  it("counts unknown-amount items per week and builds the week subtotal text from non-zero segments only", () => {
    const ledger = buildUpcomingLedger({
      from: d("2026-10-08"),
      days: 21,
      bills: [
        { id: "k", accountId: "x", entityId: P, payee: "Known", amountType: "static", expectedAmount: 100.5, autopayDay: 9, annualBudget: null, active: true, budgetTagId: null, budgetEntityId: null },
        { id: "u", accountId: "x", entityId: P, payee: "Unknown", amountType: "static", expectedAmount: null, autopayDay: 14, annualBudget: null, active: true, budgetTagId: null, budgetEntityId: null },
        { id: "u2", accountId: "x", entityId: P, payee: "Unknown 2", amountType: "static", expectedAmount: 0, autopayDay: 21, annualBudget: null, active: true, budgetTagId: null, budgetEntityId: null },
        { id: "u3", accountId: "x", entityId: P, payee: "Unknown 3", amountType: "static", expectedAmount: 0, autopayDay: 22, annualBudget: null, active: true, budgetTagId: null, budgetEntityId: null },
      ],
    });
    const weeks = groupByWeek(toUiLedger(ledger, ctx()).items);
    expect(weeks.map((w) => [w.weekStartIso, w.outflow, w.inflow, w.unknownCount])).toEqual([
      ["2026-10-05", "100.50", "0.00", 0],
      ["2026-10-12", "0.00", "0.00", 1],
      ["2026-10-19", "0.00", "0.00", 2],
    ]);
    expect(weekSubtotalText(weeks[0]!, true)).toBe("~$100.50 due");
    expect(weekSubtotalText(weeks[1]!, true)).toBe("1 without an amount");
    expect(weekSubtotalText(weeks[2]!, true)).toBe("2 without an amount");
    // the all-entities view never shows a money subtotal, only the count
    expect(weekSubtotalText(weeks[0]!, false)).toBe("");
    expect(weekSubtotalText(weeks[1]!, false)).toBe("1 without an amount");
    // nothing to report: empty string, never "~$0.00"
    expect(weekSubtotalText({ ...weeks[0]!, outflow: "0.00", inflow: "0.00", unknownCount: 0 }, true)).toBe("");
    expect(weekSubtotalText({ ...weeks[0]!, outflow: "0.00", inflow: "50.00", unknownCount: 0 }, true)).toBe("~$50.00 expected in");
    expect(weekSubtotalText({ ...weeks[0]!, outflow: "10.00", inflow: "50.00", unknownCount: 3 }, true)).toBe(
      "~$10.00 due, ~$50.00 expected in, 3 without an amount"
    );
  });

  it("truncates with a hidden count", () => {
    expect(truncateItems([1, 2, 3], 5)).toEqual({ shown: [1, 2, 3], hiddenCount: 0 });
    expect(truncateItems([1, 2, 3, 4, 5], 2)).toEqual({ shown: [1, 2], hiddenCount: 3 });
  });
});

describe("query-string helpers", () => {
  it("falls back to the defaults on invalid values", () => {
    expect(parseHorizon(undefined)).toBe(90);
    expect(parseHorizon("45")).toBe(90);
    expect(parseHorizon("abc")).toBe(90);
    expect(parseHorizon("30")).toBe(30);
    expect(parseHorizon("60")).toBe(60);
    expect(parseTransfersFlag("1")).toBe(true);
    expect(parseTransfersFlag("yes")).toBe(false);
    expect(parseTransfersFlag(undefined)).toBe(false);
  });
});
