// net-income-budget-dates: the Upcoming ledger dates a Budget-linked bill by its Budget row (month by month), keeps
// the bill's AMOUNT, turns the day mismatch into an informational line (amount mismatches stay "Records disagree"),
// and shows paychecks as take-home with their basis.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  buildUpcomingLedger,
  collectModelledRefs,
  type UpcomingBillRow,
  type UpcomingBudgetRow,
  type UpcomingIncomeRow,
  type UpcomingLedger,
  type UpcomingLedgerInput,
} from "@/lib/upcoming-ledger";
import { toUiLedger, type UiContext } from "@/lib/upcoming-ledger-view";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const FROM = d("2026-10-08");
const P = "ent-personal";

function bill(over: Partial<UpcomingBillRow> & Pick<UpcomingBillRow, "id" | "payee">): UpcomingBillRow {
  return {
    accountId: "acct-main",
    entityId: P,
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
    ...over,
  };
}
function budget(over: Partial<UpcomingBudgetRow> & Pick<UpcomingBudgetRow, "id" | "period">): UpcomingBudgetRow {
  return {
    tagId: "t-sol",
    tagName: "Solar",
    entityId: P,
    accountId: "acct-main",
    budgeted: 200,
    payDay: 14,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    ...over,
  };
}
const run = (input: Partial<UpcomingLedgerInput>): UpcomingLedger => buildUpcomingLedger({ from: FROM, days: 90, ...input });
const iso = (x: Date | null) => x?.toISOString().slice(0, 10);
const billItems = (l: UpcomingLedger) => l.items.filter((i) => i.kind === "bill");

const ctx: UiContext = {
  days: 90,
  bucketSlug: "personal",
  isAggregate: false,
  entityNameById: { [P]: "Personal" },
  entitySlugById: { [P]: "personal" },
  accountNameById: { "acct-main": "Primary Checking" },
  includeTransfers: false,
};

describe("bills are dated by the Budget row", () => {
  const budgets = [budget({ id: "b10", period: "2026-10" }), budget({ id: "b11", period: "2026-11" }), budget({ id: "b12", period: "2026-12" })];

  it("Solar: record day 17, Budget day 14 -> the 14th in each month that has a Budget row; amount is the bill's", () => {
    const l = run({ bills: [bill({ id: "sol", payee: "Solar" })], budgets });
    expect(billItems(l).map((i) => iso(i.date))).toEqual(["2026-10-14", "2026-11-14", "2026-12-14"]);
    for (const i of billItems(l)) expect(i.amount!.toFixed(2)).toBe("-200.00");
  });

  it("a month without a Budget row keeps the record's day (and the existing 'No budget line' note)", () => {
    const l = run({ days: 120, bills: [bill({ id: "sol", payee: "Solar" })], budgets: budgets.slice(0, 2) });
    const items = billItems(l);
    expect(items.map((i) => iso(i.date))).toEqual(["2026-10-14", "2026-11-14", "2026-12-17", "2027-01-17"]);
    expect(items[2]!.notes).toContain("No budget line for 2026-12");
    expect(items[2]!.dateNote).toBeUndefined();
  });

  it("a Budget row with no schedule (the Sep-style row: no pay day, monthly) falls back to the record's day, with no date note", () => {
    const l = run({ bills: [bill({ id: "sol", payee: "Solar" })], budgets: [budget({ id: "b10", period: "2026-10", payDay: null }), budgets[1]!] });
    const items = billItems(l);
    expect(items.map((i) => iso(i.date)).slice(0, 2)).toEqual(["2026-10-17", "2026-11-14"]);
    expect(items[0]!.dateNote).toBeUndefined();
    expect(items[1]!.dateNote).toBeDefined();
  });

  it("the info line states that the budget date is used and why, and is NOT a discrepancy", () => {
    const l = run({ bills: [bill({ id: "sol", payee: "Solar" })], budgets });
    const first = billItems(l)[0]!;
    expect(first.discrepancies).toEqual([]);
    expect(first.dateNote).toBe(
      "Dated by the budget (day 14) because the money has to be in the account then. The bill record says day 17. The bank may take a few days to clear it."
    );
    const ui = toUiLedger(l, ctx);
    const uiFirst = ui.items.find((i) => i.dateIso === "2026-10-14")!;
    expect(uiFirst.disagreements).toEqual([]);
    expect(uiFirst.dateNote).toContain("Dated by the budget (day 14)");
    expect(JSON.stringify(ui)).not.toContain("Records disagree");
  });

  it("an AMOUNT mismatch is still a discrepancy and still renders 'Records disagree'", () => {
    const l = run({ bills: [bill({ id: "sol", payee: "Solar" })], budgets: [budget({ id: "b10", period: "2026-10", budgeted: 1500 })] });
    const first = billItems(l)[0]!;
    expect(first.discrepancies).toMatchObject([{ kind: "monthly_amount" }]);
    expect(first.amount!.toFixed(2)).toBe("-200.00"); // amount precedence unchanged: the bill's amount
    const ui = toUiLedger(l, ctx);
    expect(ui.items[0]!.disagreements[0]).toMatch(/^Records disagree: .*a month/);
    expect(ui.items[0]!.dateNote).toBeDefined(); // the date info line is independent of the amount
  });

  it("equal days give no date note", () => {
    const l = run({ bills: [bill({ id: "sol", payee: "Solar", autopayDay: 14 })], budgets });
    for (const i of billItems(l)) expect(i.dateNote).toBeUndefined();
  });

  it("a tagged bill with no day of its own is dated by its Budget row instead of landing in 'Day not set'", () => {
    const l = run({ bills: [bill({ id: "sol", payee: "Solar", autopayDay: null })], budgets });
    expect(billItems(l).map((i) => iso(i.date))).toEqual(["2026-10-14", "2026-11-14", "2026-12-14"]);
    expect(l.undated).toEqual([]);
  });

  it("a tagged bill with no day anywhere is still 'Day not set' (never a fabricated date)", () => {
    const l = run({ bills: [bill({ id: "sol", payee: "Solar", autopayDay: null })], budgets: [budget({ id: "b10", period: "2026-10", payDay: null })] });
    expect(billItems(l)).toEqual([]);
    expect(l.undated).toHaveLength(1);
  });

  it("weekly: Budget Wednesday vs record Monday -> Wednesdays", () => {
    const l = run({
      days: 30,
      bills: [bill({ id: "dd", payee: "Doggy Daycare", frequency: "weekly", payDayOfWeek: 1, autopayDay: null, expectedAmount: 310.56, budgetTagId: "t-dd" })],
      budgets: [
        budget({ id: "d10", period: "2026-10", tagId: "t-dd", tagName: "Doggy", frequency: "weekly", payDay: null, payDayOfWeek: 3, budgeted: 310.56 }),
        budget({ id: "d11", period: "2026-11", tagId: "t-dd", tagName: "Doggy", frequency: "weekly", payDay: null, payDayOfWeek: 3, budgeted: 310.56 }),
      ],
    });
    const dow = new Set(billItems(l).map((i) => i.date!.getUTCDay()));
    expect([...dow]).toEqual([3]);
  });

  it("without any Budget rows the output is exactly the bill record's dates", () => {
    const l = run({ bills: [bill({ id: "sol", payee: "Solar" })], budgets: [] });
    expect(billItems(l).map((i) => iso(i.date))).toEqual(["2026-10-17", "2026-11-17", "2026-12-17"]);
  });

  it("an entity with the same tag id elsewhere does not lend its Budget row", () => {
    const l = run({ bills: [bill({ id: "sol", payee: "Solar" })], budgets: [budget({ id: "x", period: "2026-10", entityId: "ent-other" })] });
    // (the other entity's Budget row forms its own item for THAT entity; ours keeps the record's day)
    expect(billItems(l).filter((i) => i.entityId === P).map((i) => iso(i.date))[0]).toBe("2026-10-17");
  });
});

describe("modelled refs for the detector", () => {
  it("a Budget-dated bill's ref carries the budget day as `day` and the record's day as `altDay`", () => {
    const refs = collectModelledRefs({
      from: FROM,
      days: 90,
      bills: [bill({ id: "sol", payee: "Solar" })],
      budgets: [budget({ id: "b10", period: "2026-10" })],
    });
    const solar = refs.find((r) => r.sourceId === "sol")!;
    expect(solar.day).toBe(14);
    expect(solar.altDay).toBe(17);
  });
  it("a bill without a usable Budget row keeps its own day and has no altDay", () => {
    const refs = collectModelledRefs({ from: FROM, days: 90, bills: [bill({ id: "sol", payee: "Solar" })], budgets: [] });
    const solar = refs.find((r) => r.sourceId === "sol")!;
    expect(solar.day).toBe(17);
    expect(solar.altDay).toBeUndefined();
  });
});

describe("paychecks are take-home with their basis", () => {
  const src = (over: Partial<UpcomingIncomeRow> = {}): UpcomingIncomeRow => ({
    id: "inc",
    accountId: "acct-main",
    entityId: P,
    description: "payroll (Alpine Bio Inc)",
    cadence: "semi_monthly",
    dayRules: { daysOfMonth: [15, 31] },
    amount: new Decimal("6064.86"),
    active: true,
    ...over,
  });
  const incomeItems = (l: UpcomingLedger) => l.items.filter((i) => i.kind === "income");

  it("exact take-home: counted as scheduled at the net amount, the label in the notes", () => {
    const l = run({
      days: 30,
      incomeSources: [src({ grossAmount: new Decimal("9000"), amountBasis: "deposits", netLabel: "take-home $6,064.86, from your last 6 deposits", netVariable: false })],
    });
    const first = incomeItems(l)[0]!;
    expect(first.amount!.toFixed(2)).toBe("6064.86");
    expect(first.tier).toBe("scheduled");
    expect(first.notes).toEqual(["take-home $6,064.86, from your last 6 deposits"]);
    expect(l.totals.inflow.toFixed(2)).toBe("12129.72");
    expect(l.totals.inflowEstimated.toFixed(2)).toBe("0.00");
  });
  it("variable take-home is an estimate with the reason", () => {
    const l = run({
      days: 30,
      incomeSources: [
        src({
          description: "payroll (Seacoast)",
          cadence: "biweekly",
          dayRules: { intervalDays: 14, anchorDate: "2026-08-28" },
          amount: new Decimal("2066.52"),
          amountBasis: "deposits",
          netVariable: true,
          netLabel: "about $2,066.52 take-home (usually $1,700.68 to $2,259.28), median of your last 6 deposits",
        }),
      ],
    });
    const first = incomeItems(l)[0]!;
    expect(first.tier).toBe("estimated");
    expect(first.tierNote).toBe("take-home varies from paycheck to paycheck");
    expect(first.notes[0]).toContain("usually $1,700.68 to $2,259.28");
  });
  it("take-home unknown: gross used, flagged as an estimate", () => {
    const l = run({
      days: 30,
      incomeSources: [src({ amount: new Decimal("9000"), amountBasis: "gross_unknown", netLabel: "gross $9,000.00 used, take-home unknown: confirm a paystub on the Income page" })],
    });
    const first = incomeItems(l)[0]!;
    expect(first.amount!.toFixed(2)).toBe("9000.00");
    expect(first.tier).toBe("estimated");
    expect(first.tierNote).toBe("gross amount used, take-home unknown");
    expect(first.notes[0]).toContain("take-home unknown");
  });
  it("callers that pass no basis (older callers) get exactly the old behaviour", () => {
    const l = run({ days: 30, incomeSources: [src({ amount: new Decimal("9000") })] });
    const first = incomeItems(l)[0]!;
    expect(first.tier).toBe("scheduled");
    expect(first.notes).toEqual([]);
  });
  it("the modelled income ref carries the amount it was given (take-home)", () => {
    const refs = collectModelledRefs({ from: FROM, days: 30, incomeSources: [src()] });
    expect(refs.find((r) => r.source === "income_source")!.expectedAmount!.toFixed(2)).toBe("6064.86");
  });
});
