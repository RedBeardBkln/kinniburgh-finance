import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { generateBillOccurrences } from "@/lib/forecast";
import {
  budgetKeyOfBill,
  budgetRowUsable,
  buildBudgetScheduleIndex,
  effectiveSchedule,
  generateBillOccurrencesBudgetDated,
  periodsBetween,
  type BillDateBill,
  type BudgetScheduleRow,
} from "@/lib/bill-dates";

const ENT = "ent1";
const TAG = "tag-solar";

function bill(over: Partial<BillDateBill> = {}): BillDateBill {
  return {
    id: "b1",
    accountId: "acct",
    payee: "Solar",
    amountType: "static",
    expectedAmount: new Decimal("200"),
    autopayDay: 17,
    annualBudget: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    entityId: ENT,
    budgetTagId: TAG,
    budgetEntityId: ENT,
    ...over,
  };
}
function row(period: string, over: Partial<BudgetScheduleRow> = {}): BudgetScheduleRow {
  return {
    entityId: ENT,
    tagId: TAG,
    period,
    payDay: 14,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    ...over,
  };
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dates = (evs: { date: Date }[]) => evs.map((e) => ymd(e.date));
const D = (s: string) => new Date(`${s}T00:00:00Z`);

describe("monthly", () => {
  it("Solar: record day 17, Budget day 14 -> the 14th each month", () => {
    const idx = buildBudgetScheduleIndex(["2026-09", "2026-10", "2026-11", "2026-12"].map((p) => row(p)));
    const evs = generateBillOccurrencesBudgetDated(bill(), idx, D("2026-10-09"), D("2026-12-31"));
    expect(dates(evs)).toEqual(["2026-10-14", "2026-11-14", "2026-12-14"]);
    expect(evs[0]!.amount.toFixed(2)).toBe("-200.00");
  });
  it("a month with no Budget row uses the record day", () => {
    const idx = buildBudgetScheduleIndex([row("2026-10"), row("2026-11")]);
    const evs = generateBillOccurrencesBudgetDated(bill(), idx, D("2026-10-09"), D("2027-01-31"));
    expect(dates(evs)).toEqual(["2026-10-14", "2026-11-14", "2026-12-17", "2027-01-17"]);
  });
  it("a Sep-style row (no pay day, monthly) falls back to the record day", () => {
    const idx = buildBudgetScheduleIndex([row("2026-09", { payDay: null }), row("2026-10")]);
    const evs = generateBillOccurrencesBudgetDated(bill(), idx, D("2026-09-01"), D("2026-11-01"));
    expect(dates(evs)).toEqual(["2026-09-17", "2026-10-14"]);
  });
  it("Budget day 31 is clamped to the month end (Nov 30, Feb 28)", () => {
    const idx = buildBudgetScheduleIndex(["2026-11", "2026-12", "2027-02"].map((p) => row(p, { payDay: 31 })));
    const evs = generateBillOccurrencesBudgetDated(bill(), idx, D("2026-11-01"), D("2027-03-01"));
    expect(dates(evs)).toContain("2026-11-30");
    expect(dates(evs)).toContain("2026-12-31");
    expect(dates(evs)).toContain("2027-02-28");
  });
  it("the window boundary is respected: a Budget date before `from` is not emitted", () => {
    const idx = buildBudgetScheduleIndex([row("2026-10")]);
    expect(generateBillOccurrencesBudgetDated(bill(), idx, D("2026-10-15"), D("2026-10-31"))).toEqual([]);
    expect(dates(generateBillOccurrencesBudgetDated(bill(), idx, D("2026-10-14"), D("2026-10-15")))).toEqual(["2026-10-14"]);
  });
  it("an untagged bill is unchanged", () => {
    const idx = buildBudgetScheduleIndex([row("2026-10")]);
    const b = bill({ budgetTagId: null });
    expect(dates(generateBillOccurrencesBudgetDated(b, idx, D("2026-10-01"), D("2026-11-30")))).toEqual(["2026-10-17", "2026-11-17"]);
  });
  it("a Budget row of another entity or tag does not apply", () => {
    const idx = buildBudgetScheduleIndex([row("2026-10", { entityId: "other" }), row("2026-10", { tagId: "other-tag" })]);
    expect(dates(generateBillOccurrencesBudgetDated(bill(), idx, D("2026-10-01"), D("2026-11-01")))).toEqual(["2026-10-17"]);
  });
});

describe("weekly and biweekly", () => {
  it("weekly: Budget Wednesday vs record Monday -> Wednesdays; amount unchanged", () => {
    const b = bill({ frequency: "weekly", payDayOfWeek: 1, expectedAmount: new Decimal("520") });
    const idx = buildBudgetScheduleIndex([row("2026-10", { frequency: "weekly", payDay: null, payDayOfWeek: 3 })]);
    const evs = generateBillOccurrencesBudgetDated(b, idx, D("2026-10-01"), D("2026-11-01"));
    expect(dates(evs)).toEqual(["2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28"]);
    expect(evs[0]!.amount.toString()).toBe(generateBillOccurrences(b, D("2026-10-01"), D("2026-11-01"))[0]!.amount.toString());
  });
  it("biweekly: cycle from the month's Budget anchor; a window split mid-month has no duplicates or gaps", () => {
    const b = bill({ frequency: "biweekly", biweeklyAnchorDate: "2026-10-02" });
    const idx = buildBudgetScheduleIndex([
      row("2026-10", { frequency: "biweekly", payDay: null, biweeklyAnchorDate: new Date("2026-10-07T00:00:00Z") }),
      row("2026-11", { frequency: "biweekly", payDay: null, biweeklyAnchorDate: new Date("2026-10-07T00:00:00Z") }),
    ]);
    const whole = dates(generateBillOccurrencesBudgetDated(b, idx, D("2026-10-01"), D("2026-12-01")));
    expect(whole).toEqual(["2026-10-07", "2026-10-21", "2026-11-04", "2026-11-18"]);
    const a = dates(generateBillOccurrencesBudgetDated(b, idx, D("2026-10-01"), D("2026-10-20")));
    const c = dates(generateBillOccurrencesBudgetDated(b, idx, D("2026-10-20"), D("2026-12-01")));
    expect([...a, ...c]).toEqual(whole);
  });
  it("a Budget row of a different frequency than the bill is not used", () => {
    const b = bill({ frequency: "weekly", payDayOfWeek: 1 });
    const idx = buildBudgetScheduleIndex([row("2026-10", { frequency: "monthly", payDay: 14 })]);
    expect(dates(generateBillOccurrencesBudgetDated(b, idx, D("2026-10-01"), D("2026-10-15")))).toEqual(["2026-10-05", "2026-10-12"]);
  });
});

describe("annual and semiannual", () => {
  it("annual: Budget payDay / payMonth with the BILL's annual amount", () => {
    const b = bill({ frequency: "annual", autopayDay: 10, payMonth: 6, annualBudget: new Decimal("2400"), expectedAmount: new Decimal("200") });
    const idx = buildBudgetScheduleIndex([row("2027-03", { frequency: "annual", payDay: 20, payMonth: 3, annualAmountDue: new Decimal("9999") })]);
    const evs = generateBillOccurrencesBudgetDated(b, idx, D("2027-01-01"), D("2027-12-31"));
    // March uses the Budget row (day 20, month 3), every other month uses the bill (month 6, day 10)
    expect(dates(evs)).toEqual(["2027-03-20", "2027-06-10"]);
    expect(evs.every((e) => e.amount.toFixed(2) === "-2400.00")).toBe(true);
  });
  it("a lump-sum row with a bill lacking annualBudget falls back to the bill (no events, as before)", () => {
    const b = bill({ frequency: "annual", autopayDay: 10, payMonth: 6, annualBudget: null });
    const idx = buildBudgetScheduleIndex([row("2027-06", { frequency: "annual", payDay: 20, payMonth: 6 })]);
    expect(generateBillOccurrencesBudgetDated(b, idx, D("2027-01-01"), D("2027-12-31"))).toEqual([]);
    expect(budgetRowUsable(row("2027-06", { frequency: "annual", payDay: 20, payMonth: 6 }), b)).toBe(false);
  });
  it("semiannual: Budget day moves both payments in a month that has a row", () => {
    const b = bill({ frequency: "semiannual", autopayDay: 10, payMonth: 6, annualBudget: new Decimal("1000") });
    const idx = buildBudgetScheduleIndex([
      row("2026-12", { frequency: "semiannual", payDay: 20, payMonth: 6 }),
      row("2027-06", { frequency: "semiannual", payDay: 20, payMonth: 6 }),
    ]);
    const evs = generateBillOccurrencesBudgetDated(b, idx, D("2026-11-01"), D("2027-07-01"));
    expect(dates(evs)).toEqual(["2026-12-20", "2027-06-20"]);
  });
});

describe("unchanged paths", () => {
  it("accrued with real draws is untouched", () => {
    const b = bill({ amountType: "accrued", annualBudget: new Decimal("1200"), expectedAmount: null });
    const idx = buildBudgetScheduleIndex([row("2026-10", { payDay: 5 })]);
    const draws = [{ estimatedDate: "2026-10-25", estimatedAmount: "300" }];
    const evs = generateBillOccurrencesBudgetDated(b, idx, D("2026-10-01"), D("2026-11-01"), draws);
    expect(dates(evs)).toEqual(["2026-10-25"]);
  });
  it("accrued without draws takes the Budget day, amount stays annualBudget/12", () => {
    const b = bill({ amountType: "accrued", annualBudget: new Decimal("1200"), expectedAmount: null });
    const idx = buildBudgetScheduleIndex([row("2026-10", { payDay: 5 })]);
    const evs = generateBillOccurrencesBudgetDated(b, idx, D("2026-10-01"), D("2026-11-01"));
    expect(dates(evs)).toEqual(["2026-10-05"]);
    expect(evs[0]!.amount.toFixed(2)).toBe("-100.00");
  });
  it("empty index is a golden match of the unwrapped generator across cadences", () => {
    const cases: BillDateBill[] = [
      bill(),
      bill({ frequency: "weekly", payDayOfWeek: 2 }),
      bill({ frequency: "biweekly", biweeklyAnchorDate: "2026-10-02" }),
      bill({ frequency: "annual", payMonth: 11, autopayDay: 3, annualBudget: new Decimal("600") }),
      bill({ autopayDay: 31 }),
      bill({ autopayDay: null }),
    ];
    for (const b of cases) {
      const a = generateBillOccurrencesBudgetDated(b, new Map(), D("2026-10-01"), D("2027-06-01"));
      const o = generateBillOccurrences(b, D("2026-10-01"), D("2027-06-01"));
      expect(a.map((e) => [ymd(e.date), e.amount.toString()])).toEqual(o.map((e) => [ymd(e.date), e.amount.toString()]));
    }
  });
  it("a usable index changes only dates, never amounts (precedence unchanged)", () => {
    const b = bill({ expectedAmount: new Decimal("123.45") });
    const idx = buildBudgetScheduleIndex([row("2026-10")]);
    const a = generateBillOccurrencesBudgetDated(b, idx, D("2026-10-01"), D("2026-11-01"));
    const o = generateBillOccurrences(b, D("2026-10-01"), D("2026-11-01"));
    expect(a).toHaveLength(o.length);
    expect(a[0]!.amount.toString()).toBe(o[0]!.amount.toString());
    expect(a[0]!.description).toBe("Solar");
    expect(a[0]!.accountId).toBe("acct");
    expect(a[0]!.type).toBe("bill");
  });
});

describe("helpers", () => {
  it("budgetKeyOfBill falls back to entityId and is null when untagged", () => {
    expect(budgetKeyOfBill(bill())).toBe(`${ENT}|${TAG}`);
    expect(budgetKeyOfBill(bill({ budgetEntityId: null }))).toBe(`${ENT}|${TAG}`);
    expect(budgetKeyOfBill(bill({ budgetTagId: null }))).toBeNull();
  });
  it("effectiveSchedule reports the basis and both days", () => {
    const idx = buildBudgetScheduleIndex([row("2026-10")]);
    expect(effectiveSchedule(bill(), idx, "2026-10")).toMatchObject({ basis: "budget", budgetDay: 14, recordDay: 17 });
    expect(effectiveSchedule(bill(), idx, "2026-11")).toMatchObject({ basis: "bill", budgetDay: null, recordDay: 17 });
  });
  it("periodsBetween lists each month once", () => {
    expect(periodsBetween(D("2026-10-09"), D("2027-01-01"))).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(periodsBetween(D("2026-10-09"), D("2026-10-09"))).toEqual([]);
  });
});
