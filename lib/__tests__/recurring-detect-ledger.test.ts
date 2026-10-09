import { describe, expect, it } from "vitest";
import {
  buildUpcomingLedger,
  collectModelledRefs,
  type LearnedSeriesRow,
  type UpcomingBillRow,
  type UpcomingLedgerInput,
} from "@/lib/upcoming-ledger";
import { toUiDetection, toUiLedger, type UiContext } from "@/lib/upcoming-ledger-view";
import { detectRecurring } from "@/lib/recurring-detect";
import { Decimal } from "@prisma/client/runtime/library";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const FROM = d("2026-10-08");
const P = "ent-personal";
const SV = "ent-sv";

function bill(over: Partial<UpcomingBillRow> & Pick<UpcomingBillRow, "id" | "payee">): UpcomingBillRow {
  return {
    accountId: "acct-main",
    entityId: P,
    amountType: "static",
    expectedAmount: 100,
    autopayDay: 10,
    annualBudget: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    active: true,
    budgetTagId: null,
    budgetEntityId: null,
    ...over,
  };
}

function learnedRow(over: Partial<LearnedSeriesRow> = {}): LearnedSeriesRow {
  return {
    key: `${P}|acct-main|out|gym club`,
    entityId: P,
    accountId: "acct-main",
    payee: "Gym Club",
    kind: "outflow",
    cadence: "monthly",
    amount: 40,
    minAmount: 40,
    maxAmount: 40,
    amountMode: "fixed",
    confidence: "high",
    why: "Seen 6 times, 30-31 days apart, always about $40.00, usually around the 14th.",
    dates: [d("2026-10-14"), d("2026-11-14")],
    ...over,
  };
}

const base = (over: Partial<UpcomingLedgerInput> = {}): UpcomingLedgerInput => ({
  from: FROM,
  days: 30,
  bills: [bill({ id: "b1", payee: "Mortgage", expectedAmount: 1250, autopayDay: 1 }), bill({ id: "b2", payee: "Electric", expectedAmount: 80, autopayDay: 20 })],
  ...over,
});

describe("buildUpcomingLedger with learned series", () => {
  it("without learned input the ledger is as before, with an empty learned block", () => {
    const l = buildUpcomingLedger(base());
    expect(l.learned).toEqual([]);
    expect(l.learnedTotals.count).toBe(0);
    expect(l.learnedTotals.outflow.toFixed(2)).toBe("0.00");
    expect(l.learnedDropped).toBe(0);
  });

  it("a learned row appears only in `learned`, never in items, undated, pastDue, totals or biggest", () => {
    const without = buildUpcomingLedger(base());
    const withLearned = buildUpcomingLedger(base({ learned: [learnedRow({ amount: 9999, minAmount: 9999, maxAmount: 9999 })] }));
    expect(withLearned.learned).toHaveLength(1); // only Oct 14 is inside the 30-day window
    const item = withLearned.learned[0];
    expect(item).toMatchObject({ tier: "learned", source: "learned_history", kind: "bill", amountStatus: "known" });
    expect(item?.amount?.toFixed(2)).toBe("-9999.00");
    expect(item?.tierNote).toContain("Seen 6 times");
    expect(item?.notes).toContain("Looks recurring from your history, not in your budget");
    expect(item?.link).toEqual({ page: "forecast", anchor: "looks-recurring" });
    expect(withLearned.items.map((i) => i.id)).toEqual(without.items.map((i) => i.id));
    expect(withLearned.undated).toEqual(without.undated);
    expect(withLearned.pastDue).toEqual(without.pastDue);
    expect(withLearned.totals.outflow.toFixed(2)).toBe(without.totals.outflow.toFixed(2));
    expect(withLearned.totalsByEntity[P]?.outflow.toFixed(2)).toBe(without.totalsByEntity[P]?.outflow.toFixed(2));
    expect(withLearned.biggest?.id).toBe(without.biggest?.id);
    expect(withLearned.learnedTotals.outflow.toFixed(2)).toBe("9999.00");
    expect(withLearned.learnedTotals.count).toBe(1);
  });

  it("only high and medium outflow series with a date inside the window are placed", () => {
    const l = buildUpcomingLedger(
      base({
        learned: [
          learnedRow({ key: "k-medium", payee: "Medium Co", confidence: "medium" }),
          learnedRow({ key: "k-low", payee: "Low Co", confidence: "low" }),
          learnedRow({ key: "k-annual", payee: "Annual Co", cadence: "annual", confidence: "high" }),
          learnedRow({ key: "k-in", payee: "Deposit Co", kind: "inflow" }),
          learnedRow({ key: "k-out", payee: "Outside Co", dates: [d("2026-12-14")] }),
          learnedRow({ key: "k-nodate", payee: "Nodate Co", dates: [] }),
          learnedRow({ key: "k-zero", payee: "Zero Co", amount: 0 }),
        ],
      })
    );
    expect(l.learned.map((i) => i.label)).toEqual(["Medium Co"]);
  });

  it("a weekly series places every date in the window", () => {
    const dates = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"].map(d);
    const l = buildUpcomingLedger(base({ learned: [learnedRow({ cadence: "weekly", amount: 31, minAmount: 31, maxAmount: 31, dates })] }));
    expect(l.learned.map((i) => i.date?.toISOString().slice(0, 10))).toEqual(["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
    expect(l.learnedTotals.outflow.toFixed(2)).toBe("124.00");
    expect(new Set(l.learned.map((i) => i.id)).size).toBe(4);
  });

  it("a row that looks like a kept obligation is dropped and counted", () => {
    const l = buildUpcomingLedger(
      base({
        bills: [bill({ id: "b1", payee: "Gym Club membership", expectedAmount: 40, autopayDay: 14 })],
        learned: [learnedRow()],
      })
    );
    expect(l.learned).toHaveLength(0);
    expect(l.learnedDropped).toBe(1);
    // Same money and day under a different name is also the same obligation.
    const sameMoney = buildUpcomingLedger(
      base({ bills: [bill({ id: "b1", payee: "Fitness", expectedAmount: 40, autopayDay: 14 })], learned: [learnedRow()] })
    );
    expect(sameMoney.learnedDropped).toBe(1);
  });

  it("respects the entity scope", () => {
    const row = learnedRow({ entityId: SV, key: `${SV}|a|out|gym club` });
    expect(buildUpcomingLedger(base({ entityId: P, learned: [row] })).learned).toHaveLength(0);
    expect(buildUpcomingLedger(base({ entityId: SV, bills: [], learned: [row] })).learned).toHaveLength(1);
    expect(buildUpcomingLedger(base({ entityId: null, learned: [row] })).learned).toHaveLength(1);
  });

  it("'varies' series say so in a note; learned never feeds the UI summary totals", () => {
    const l = buildUpcomingLedger(
      base({ learned: [learnedRow({ amountMode: "varies", amount: 60, minAmount: 41, maxAmount: 90 })] })
    );
    expect(l.learned[0]?.notes).toContain("Amount varies, about $41.00 to $90.00");
    const ctx: UiContext = {
      days: 30,
      bucketSlug: "personal",
      isAggregate: false,
      entityNameById: { [P]: "Personal" },
      entitySlugById: { [P]: "personal" },
      accountNameById: {},
      includeTransfers: false,
    };
    const ui = toUiLedger(l, ctx);
    expect(ui.learned).toHaveLength(1);
    expect(ui.learned[0]?.sourceLabel).toBe("Learned from history");
    expect(ui.learned[0]?.estimate).toBe(false);
    expect(ui.learnedTotal).toBe("60.00");
    expect(ui.totals.outflow).toBe(buildUpcomingLedger(base()).totals.outflow.toFixed(2));
  });
});

describe("collectModelledRefs", () => {
  it("applies the ledger's filters and one-record-per-category rule", () => {
    const refs = collectModelledRefs({
      from: FROM,
      days: 30,
      bills: [
        bill({ id: "b1", payee: "Mortgage", budgetTagId: "T1", budgetEntityId: P, expectedAmount: 1250, autopayDay: 1 }),
        bill({ id: "b2", payee: "Inactive", active: false }),
        bill({ id: "b3", payee: "Firewood", amountType: "accrued", expectedAmount: 83.33 }),
      ],
      budgets: [
        // same category as the bill: the bill wins
        { id: "bu1", tagId: "T1", tagName: "Mortgage", entityId: P, accountId: "a", period: "2026-10", budgeted: 1250, payDay: 1, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null },
        // no schedule: not modelled
        { id: "bu2", tagId: "T2", tagName: "Dining", entityId: P, accountId: "a", period: "2026-10", budgeted: 300, payDay: null, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null },
        { id: "bu3", tagId: "T3", tagName: "Solar", entityId: P, accountId: "a", period: "2026-10", budgeted: 505.7, payDay: 14, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null },
      ],
      recurring: [
        { id: "r1", entityId: P, name: "Eversource", amountCents: 20000, frequency: "monthly", dueDay: 20, nextDueDate: null, tagId: null },
        { id: "r2", entityId: P, name: "Mortgage again", amountCents: 125000, frequency: "monthly", dueDay: 1, nextDueDate: null, tagId: "T1" },
        { id: "r3", entityId: SV, name: "Other entity", amountCents: 100, frequency: "annually", dueDay: null, nextDueDate: null, tagId: null },
      ],
      incomeSources: [{ id: "i1", accountId: "a", entityId: P, description: "Alpine pay", cadence: "biweekly", dayRules: {}, amount: 2555, active: true }],
      entityId: P,
    });
    expect(refs.map((r) => `${r.source}:${r.label}`).sort()).toEqual([
      "budget_line:Solar",
      "income_source:Alpine pay",
      "recurring_expense:Eversource",
      "scheduled_bill:Firewood",
      "scheduled_bill:Mortgage",
    ]);
    const mortgage = refs.find((r) => r.label === "Mortgage");
    expect(mortgage).toMatchObject({ tagKey: `${P}|T1`, day: 1, cadence: "monthly", direction: "outflow" });
    expect(mortgage?.expectedAmount?.toFixed(2)).toBe("1250.00");
    expect(refs.find((r) => r.label === "Firewood")?.cadence).toBeNull(); // accrued set-asides are never "late"
    // A weekly bill stores a MONTHLY total (the generators' convention): one payment is that x 12 / 52.
    const weekly = collectModelledRefs({
      from: FROM,
      days: 30,
      bills: [bill({ id: "w1", payee: "Doggy Daycare", frequency: "weekly", expectedAmount: "310.56", autopayDay: null, payDayOfWeek: 3 })],
    });
    expect(weekly[0]?.expectedAmount?.toFixed(2)).toBe("71.67");
    expect(weekly[0]?.monthly?.toFixed(2)).toBe("310.56");
    expect(refs.find((r) => r.label === "Alpine pay")).toMatchObject({ direction: "inflow", cadence: "biweekly" });
  });
});

describe("detector output through the view", () => {
  it("toUiDetection returns plain strings with observational wording", () => {
    const rows = ["2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"].map((date) => ({
      entityId: P,
      accountId: "acct-main",
      accountType: "checking",
      payee: "netflix",
      amount: new Decimal(-28.7),
      postedAt: d(date),
      tagIds: [],
    }));
    const result = detectRecurring({ rows, modelled: [], today: FROM });
    const ui = toUiDetection(
      { suggestions: result.suggestions, dismissed: [], flags: result.flags, suppressed: result.suppressed, suppressedCount: 0, staleCount: 0 },
      { [P]: "Personal" }
    );
    expect(ui.suggestions).toHaveLength(1);
    const s = ui.suggestions[0];
    expect(s?.summary).toBe("~$28.70 monthly, usually around the 5th");
    expect(s?.confidenceLabel).toBe("Strong pattern");
    expect(s?.nextLabel).toBe("Next expected around Oct 5");
    expect(JSON.stringify(ui)).not.toMatch(/you should|CPA/i);
  });
});
