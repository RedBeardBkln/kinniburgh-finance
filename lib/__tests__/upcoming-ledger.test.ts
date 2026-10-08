import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildUpcomingLedger,
  nameWords,
  todayForNewYork,
  type UpcomingBillRow,
  type UpcomingBudgetRow,
  type UpcomingLedger,
  type UpcomingLedgerInput,
  type UpcomingRecurringRow,
} from "@/lib/upcoming-ledger";

// Fixtures mirror the live shapes (names, days, frequencies) read on 2026-10-08.

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const FROM = d("2026-10-08"); // a Thursday
const P = "ent-personal";
const SV = "ent-sv";
const EK = "ent-ek";

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

/** A tagged bill (the auto-created kind). */
function tagged(over: Partial<UpcomingBillRow> & Pick<UpcomingBillRow, "id" | "payee"> & { tag: string }): UpcomingBillRow {
  const { tag, ...rest } = over;
  return bill({ budgetTagId: tag, budgetEntityId: rest.entityId ?? P, ...rest });
}

function budget(over: Partial<UpcomingBudgetRow> & Pick<UpcomingBudgetRow, "id" | "tagId" | "period">): UpcomingBudgetRow {
  return {
    tagName: "Tag " + over.tagId,
    entityId: P,
    accountId: "acct-main",
    budgeted: 100,
    payDay: 10,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    ...over,
  };
}

function recurring(over: Partial<UpcomingRecurringRow> & Pick<UpcomingRecurringRow, "id" | "name">): UpcomingRecurringRow {
  return {
    entityId: P,
    amountCents: 10000,
    frequency: "monthly",
    dueDay: 10,
    nextDueDate: null,
    tagId: null,
    ...over,
  };
}

function run(input: Partial<UpcomingLedgerInput> & { days?: number }): UpcomingLedger {
  return buildUpcomingLedger({ from: FROM, days: 90, ...input });
}

const dates = (l: UpcomingLedger, source?: string) =>
  l.items.filter((i) => !source || i.source === source).map((i) => i.date!.toISOString().slice(0, 10));
const amounts = (l: UpcomingLedger) => l.items.map((i) => i.amount?.toFixed(2) ?? null);

describe("todayForNewYork / nameWords", () => {
  it("returns the New York calendar date", () => {
    expect(todayForNewYork(new Date("2026-10-09T02:00:00Z")).toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(todayForNewYork(new Date("2026-10-08T14:00:00Z")).toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(todayForNewYork(new Date("2027-01-01T03:00:00Z")).toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("drops stop words, short words and pure numbers", () => {
    expect(nameWords("Amica - Auto insurance")).toEqual(["amica"]);
    expect(nameWords("Toyota Financial")).toEqual(["toyota"]);
    expect(nameWords("Property taxes - 56 Arbor Rd")).toEqual(["property", "taxes", "arbor"]);
  });
});

describe("per-source expansion", () => {
  it("monthly static bill: negative, scheduled, entity-scoped", () => {
    const l = run({ bills: [bill({ id: "m", payee: "Mortgage", expectedAmount: 4700, autopayDay: 1 })] });
    expect(dates(l)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(l.items[0]).toMatchObject({ kind: "bill", tier: "scheduled", entityId: P, source: "scheduled_bill" });
    expect(amounts(l)).toEqual(["-4700.00", "-4700.00", "-4700.00"]);
  });

  it("weekly bill: per-occurrence amount (Doggy-shaped $310.56 monthly -> $71.67 per Wednesday)", () => {
    const l = run({
      days: 30,
      bills: [bill({ id: "dd", payee: "Doggy Daycare", expectedAmount: 310.56, frequency: "weekly", payDayOfWeek: 3, autopayDay: null })],
    });
    expect(dates(l)).toEqual(["2026-10-14", "2026-10-21", "2026-10-28", "2026-11-04"]);
    expect(new Set(amounts(l))).toEqual(new Set(["-71.67"]));
  });

  it("biweekly bill honors its anchor", () => {
    const l = run({
      days: 30,
      bills: [bill({ id: "bw", payee: "Biweekly", expectedAmount: 260, frequency: "biweekly", biweeklyAnchorDate: d("2026-10-02"), autopayDay: null })],
    });
    expect(dates(l)).toEqual(["2026-10-16", "2026-10-30"]);
    expect(amounts(l)[0]).toBe("-120.00"); // 260 * 12 / 26
  });

  it("semiannual (Amica-shaped): Dec 4 in 90 days; Jun 4 and Dec 4 in a long window", () => {
    const amica = bill({ id: "am", payee: "Amica", amountType: "static", frequency: "semiannual", payMonth: 6, autopayDay: 4, annualBudget: 1182, expectedAmount: 197 });
    expect(dates(run({ bills: [amica] }))).toEqual(["2026-12-04"]);
    expect(run({ bills: [amica] }).items[0]!.amount!.toFixed(2)).toBe("-1182.00");
    expect(dates(run({ days: 365, bills: [amica] }))).toEqual(["2026-12-04", "2027-06-04"]);
  });

  it("annual (Progressive-shaped): absent at 90 days, present when the window includes Feb 26; Jan crossing keeps the year", () => {
    const prog = bill({ id: "pr", payee: "Progressive", frequency: "annual", payMonth: 2, autopayDay: 26, annualBudget: 127, expectedAmount: 11 });
    expect(dates(run({ bills: [prog] }))).toEqual([]);
    expect(dates(run({ days: 200, bills: [prog] }))).toEqual(["2027-02-26"]);
    const jan = bill({ id: "j", payee: "January thing", frequency: "annual", payMonth: 1, autopayDay: 15, annualBudget: 50, expectedAmount: 4 });
    expect(dates(run({ bills: [jan] }))).toEqual([]);
    expect(dates(run({ days: 120, bills: [jan] }))).toEqual(["2027-01-15"]);
  });

  it("annual day 30 clamps in February", () => {
    const feb = bill({ id: "f", payee: "Feb bill", frequency: "annual", payMonth: 2, autopayDay: 30, annualBudget: 10, expectedAmount: 1 });
    expect(dates(run({ days: 200, bills: [feb] }))).toEqual(["2027-02-28"]);
  });

  it("accrued bill with draws uses draw dates only, excludes past draws, is an estimate", () => {
    const mc = bill({
      id: "mc",
      payee: "McCarthy Oil",
      amountType: "accrued",
      annualBudget: 2868,
      autopayDay: null,
      expectedAmount: 239,
      draws: [
        { estimatedDate: d("2026-10-02"), estimatedAmount: 2000 },
        { estimatedDate: d("2026-12-16"), estimatedAmount: 2000 },
        { estimatedDate: d("2027-02-08"), estimatedAmount: 800 },
      ],
    });
    const l = run({ bills: [mc] });
    expect(dates(l)).toEqual(["2026-12-16"]);
    expect(l.items[0]).toMatchObject({ tier: "estimated", tierNote: "estimated draw date and amount" });
    expect(l.undated).toHaveLength(0);
  });

  it("accrued bill without draws spreads annualBudget/12 on its day (estimate)", () => {
    const l = run({
      days: 30,
      bills: [bill({ id: "ac", payee: "Accrued", amountType: "accrued", annualBudget: 1200, autopayDay: 15, expectedAmount: 100 })],
    });
    expect(dates(l)).toEqual(["2026-10-15"]);
    expect(l.items[0]).toMatchObject({ tier: "estimated" });
    expect(l.items[0]!.amount!.toFixed(2)).toBe("-100.00");
  });

  it("fluctuating bill is an estimate", () => {
    const l = run({ days: 30, bills: [bill({ id: "fl", payee: "Eversource", amountType: "fluctuating", expectedAmount: 83, autopayDay: 12 })] });
    expect(l.items[0]).toMatchObject({ tier: "estimated" });
  });

  it("budget orphan emits only inside its own period month", () => {
    const l = run({
      budgets: [
        budget({ id: "b-nov", tagId: "t1", period: "2026-11", payDay: 5, budgeted: 50, tagName: "Gym" }),
        // no December or January row at all
      ],
    });
    expect(dates(l)).toEqual(["2026-11-05"]);
    expect(l.items[0]).toMatchObject({ source: "budget_line", label: "Gym", link: { page: "budgets", period: "2026-11" } });
  });

  it("budget with an INACTIVE bill of the same key emits from the budget", () => {
    const l = run({
      days: 30,
      bills: [tagged({ id: "old", payee: "Gym old", tag: "t1", active: false })],
      budgets: [budget({ id: "b-oct", tagId: "t1", period: "2026-10", payDay: 20, budgeted: 40 })],
    });
    expect(l.items.map((i) => i.source)).toEqual(["budget_line"]);
    expect(dates(l)).toEqual(["2026-10-20"]);
  });

  it("budget rows without a schedule produce nothing", () => {
    const l = run({ budgets: [budget({ id: "g", tagId: "gro", period: "2026-10", payDay: null, frequency: "monthly", budgeted: 800 })] });
    expect(l.items).toHaveLength(0);
    expect(l.undated).toHaveLength(0);
  });

  it("recurring monthly / weekly / biweekly / quarterly / annually", () => {
    const l = run({
      days: 120,
      recurring: [
        recurring({ id: "rm", name: "Monthly thing", dueDay: 20, amountCents: 20000 }),
        recurring({ id: "rw", name: "Weekly thing", frequency: "weekly", amountCents: 10000, nextDueDate: d("2026-10-05"), dueDay: null }),
        recurring({ id: "rb", name: "Biweekly thing", frequency: "biweekly", amountCents: 5000, nextDueDate: d("2026-10-12"), dueDay: null }),
        recurring({ id: "rq", name: "Quarterly thing", frequency: "quarterly", amountCents: 30000, nextDueDate: d("2026-07-15"), dueDay: null }),
        recurring({ id: "ra", name: "Annual thing", frequency: "annually", amountCents: 9900, nextDueDate: d("2026-11-03"), dueDay: null }),
      ],
    });
    const by = (id: string) => l.items.filter((i) => i.sourceId === id);
    expect(by("rm").map((i) => i.date!.toISOString().slice(0, 10))).toEqual(["2026-10-20", "2026-11-20", "2026-12-20", "2027-01-20"]);
    expect(by("rw").map((i) => i.date!.toISOString().slice(0, 10)).slice(0, 3)).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
    // a $100 weekly recurring expense is exactly $100.00 per occurrence
    expect(new Set(by("rw").map((i) => i.amount!.toFixed(2)))).toEqual(new Set(["-100.00"]));
    expect(by("rb").map((i) => i.date!.toISOString().slice(0, 10)).slice(0, 2)).toEqual(["2026-10-12", "2026-10-26"]);
    expect(new Set(by("rb").map((i) => i.amount!.toFixed(2)))).toEqual(new Set(["-50.00"]));
    // quarterly = Jul/Oct/Jan/Apr on the 15th
    expect(by("rq").map((i) => i.date!.toISOString().slice(0, 10))).toEqual(["2026-10-15", "2027-01-15"]);
    expect(by("rq")[0]!.amount!.toFixed(2)).toBe("-300.00");
    expect(by("ra").map((i) => i.date!.toISOString().slice(0, 10))).toEqual(["2026-11-03"]);
    expect(by("ra")[0]!.amount!.toFixed(2)).toBe("-99.00");
  });

  it("stale recurring nextDueDate adds a note and never a past-dated item", () => {
    const l = run({ recurring: [recurring({ id: "rs", name: "Stale", frequency: "annually", amountCents: 1000, nextDueDate: d("2026-07-20"), dueDay: null })] });
    expect(l.items.every((i) => i.date!.getTime() >= FROM.getTime())).toBe(true);
    const l2 = run({ days: 365, recurring: [recurring({ id: "rs", name: "Stale", frequency: "annually", amountCents: 1000, nextDueDate: d("2026-07-20"), dueDay: null })] });
    expect(l2.items[0]!.notes).toContain("Next due date on file is in the past");
  });

  it("orphan envelope draws are standalone estimates; envelopes without draws are skipped", () => {
    const l = run({
      orphanEnvelopes: [
        { id: "e1", name: "Firewood", accountId: "acct-main", entityId: P, draws: [{ estimatedDate: d("2026-12-14"), estimatedAmount: 315 }] },
        { id: "e2", name: "Empty", accountId: "acct-main", entityId: P, draws: [] },
      ],
    });
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ source: "accrual_draw", tier: "estimated", link: { page: "envelope" } });
    expect(l.items[0]!.amount!.toFixed(2)).toBe("-315.00");
  });

  it("card statements: in-window item; zero balance yields nothing", () => {
    const l = run({
      days: 30,
      cards: [
        { id: "jb", nickname: "jetBlue", entityId: P, ccDueDate: d("2026-10-12"), ccStatementBalance: "51.26" },
        { id: "z", nickname: "Zero", entityId: P, ccDueDate: d("2026-10-12"), ccStatementBalance: 0 },
        { id: "zp", nickname: "ZeroPast", entityId: P, ccDueDate: d("2026-10-03"), ccStatementBalance: 0 },
      ],
    });
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ kind: "card", source: "card_statement", label: "jetBlue statement due" });
    expect(l.items[0]!.amount!.toFixed(2)).toBe("-51.26");
    expect(l.pastDue).toHaveLength(0);
  });

  it("transfers: only the outflow leg, kind transfer, not in outflow totals", () => {
    const l = run({
      days: 30,
      transfers: [
        {
          id: "t1",
          fromAccountId: "acct-main",
          toAccountId: "acct-env",
          fromEntityId: P,
          amount: 256,
          cadence: "weekly",
          dayRules: { dayOfWeek: 1 },
          purpose: null,
          toNickname: "Groceries envelope",
          active: true,
        },
      ],
    });
    expect(dates(l)).toEqual(["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
    expect(l.items.every((i) => i.kind === "transfer" && i.amount!.isNegative())).toBe(true);
    expect(l.totals.outflow.toFixed(2)).toBe("0.00");
    expect(l.totals.transferCount).toBe(4);
    expect(l.totals.transferTotal.toFixed(2)).toBe("1024.00");
  });

  it("income: semi-monthly and biweekly anchor (Eva 2026-08-28)", () => {
    const l = run({
      days: 30,
      incomeSources: [
        { id: "eric", accountId: "acct-main", entityId: P, description: "Eric pay", cadence: "semi_monthly", dayRules: { daysOfMonth: [15, 31] }, amount: 9000, active: true },
        { id: "eva", accountId: "acct-main", entityId: P, description: "Eva pay", cadence: "biweekly", dayRules: { intervalDays: 14, anchorDate: "2026-08-28" }, amount: 2555, active: true },
        { id: "off", accountId: "acct-main", entityId: P, description: "Inactive", cadence: "monthly", dayRules: { dayOfMonth: 9 }, amount: 1, active: false },
      ],
    });
    const eric = l.items.filter((i) => i.sourceId === "eric").map((i) => i.date!.toISOString().slice(0, 10));
    expect(eric).toEqual(["2026-10-15", "2026-10-31"]);
    expect(l.items.filter((i) => i.sourceId === "eva").map((i) => i.date!.toISOString().slice(0, 10))).toEqual(["2026-10-09", "2026-10-23", "2026-11-06"]);
    expect(l.items.every((i) => i.kind === "income" && i.amount!.isPositive())).toBe(true);
    expect(l.totals.inflow.toFixed(2)).toBe((9000 * 2 + 2555 * 3).toFixed(2));
  });

  it("rental payouts (gross) and projected revenue (estimate; overdue goes to past due)", () => {
    const l = run({
      rentalBookings: [
        { id: "r1", entityId: SV, payoutDate: d("2026-10-19"), guest: "Pat", grossEarnings: "1075.00" },
        { id: "r2", entityId: SV, payoutDate: d("2027-06-10"), guest: "Later", grossEarnings: 500 },
      ],
      projectedRevenue: [
        { id: "p1", entityId: EK, description: "Consulting invoice", expectedDate: d("2026-11-01"), amountCents: 500000 },
        { id: "p2", entityId: EK, description: "Overdue invoice", expectedDate: d("2026-09-20"), amountCents: 100000 },
        { id: "p3", entityId: EK, description: "Realized", expectedDate: d("2026-11-02"), amountCents: 1, realizedAt: d("2026-11-03") },
        { id: "p4", entityId: EK, description: "Archived", expectedDate: d("2026-11-02"), amountCents: 1, archivedAt: d("2026-11-03") },
      ],
    });
    const rental = l.items.find((i) => i.source === "rental_payout")!;
    expect(rental).toMatchObject({ entityId: SV, kind: "income", tier: "scheduled", link: { page: "forecast", anchor: "rental-bookings" } });
    expect(rental.label).toContain("gross");
    expect(rental.amount!.toFixed(2)).toBe("1075.00");
    const proj = l.items.find((i) => i.source === "projected_revenue")!;
    expect(proj).toMatchObject({ tier: "estimated", entityId: EK });
    expect(proj.amount!.toFixed(2)).toBe("5000.00");
    expect(l.pastDue.map((i) => i.sourceId)).toEqual(["p2"]);
    expect(l.items.some((i) => i.sourceId === "r2" || i.sourceId === "p3" || i.sourceId === "p4")).toBe(false);
  });

  it("tax deadlines: only upcoming, unarchived, in-window; past-dated rows are ignored (not overdue)", () => {
    const l = run({
      taxDeadlines: [
        { id: "x1", entityId: EK, label: "2025 Schedule C - extended filing", dueDate: new Date("2026-10-15T04:00:00Z"), status: "upcoming" },
        { id: "x2", entityId: EK, label: "Filed", dueDate: d("2026-10-20"), status: "filed" },
        { id: "x3", entityId: EK, label: "Waived", dueDate: d("2026-10-20"), status: "waived" },
        { id: "x4", entityId: EK, label: "Archived", dueDate: d("2026-10-20"), status: "upcoming", archivedAt: d("2026-01-01") },
        { id: "x5", entityId: P, label: "Q3 estimated (stale)", dueDate: d("2026-09-15"), status: "upcoming" },
        { id: "x6", entityId: P, label: "Q4 estimated", dueDate: d("2027-01-15"), status: "upcoming" },
      ],
    });
    expect(l.items.map((i) => i.sourceId)).toEqual(["x1"]);
    expect(l.items[0]).toMatchObject({ kind: "deadline", amountStatus: "not_applicable", amount: null, link: { page: "tax" } });
    expect(l.items[0]!.date!.toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(l.pastDue).toHaveLength(0);
  });

  it("policy expiry: null expiry skipped; in-window expiry is a deadline with no amount", () => {
    const l = run({
      policies: [
        { id: "po1", entityId: P, insurer: "Northwestern Mutual", policyType: "whole", expiryDate: null },
        { id: "po2", entityId: P, insurer: "Acme", policyType: "term", expiryDate: d("2026-11-30") },
        { id: "po3", entityId: P, insurer: "Gone", policyType: "term", expiryDate: d("2026-11-30"), archivedAt: d("2026-01-01") },
      ],
    });
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ sourceId: "po2", kind: "deadline", amount: null, link: { page: "vault" } });
  });
});

describe("horizon boundaries and ordering", () => {
  const monthly = (day: number) => bill({ id: `d${day}`, payee: `Day ${day}`, autopayDay: day });

  it("includes an event on `from`, excludes one on from + days", () => {
    const l = run({ days: 30, bills: [monthly(8), monthly(7)] });
    expect(l.items.map((i) => `${i.sourceId}@${i.date!.toISOString().slice(0, 10)}`)).toEqual(["d8@2026-10-08"]);
    expect(run({ days: 31, bills: [monthly(7)] }).items).toHaveLength(1);
  });

  it("30, 60 and 90 day results are nested", () => {
    const bills = [monthly(1), monthly(15), monthly(25)];
    const ids = (n: number) => new Set(run({ days: n, bills }).items.map((i) => i.id));
    const a = ids(30), b = ids(60), c = ids(90);
    for (const id of a) expect(b.has(id)).toBe(true);
    for (const id of b) expect(c.has(id)).toBe(true);
    expect(c.size).toBeGreaterThan(a.size);
  });

  it("sorts by date, kind, label, id; ids are unique and the run is deterministic", () => {
    const input = {
      bills: [monthly(20), bill({ id: "z", payee: "A same day", autopayDay: 20 })],
      incomeSources: [{ id: "i", accountId: "a", entityId: P, description: "Pay", cadence: "monthly", dayRules: { dayOfMonth: 20 }, amount: 5, active: true }],
    };
    const a = run(input);
    const b = run(input);
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    expect(new Set(a.items.map((i) => i.id)).size).toBe(a.items.length);
    const first = a.items.filter((i) => i.date!.toISOString().startsWith("2026-10-20")).map((i) => i.label);
    expect(first).toEqual(["A same day", "Day 20", "Pay"]); // bills (by label) before income
  });

  it("never produces the reserved 'learned' tier", () => {
    const l = run({ bills: [monthly(20)], recurring: [recurring({ id: "r", name: "R" })] });
    expect([...l.items, ...l.undated].every((i) => i.tier !== "learned")).toBe(true);
  });
});

describe("unknown amount is listed, never $0 and never dropped", () => {
  it("null / zero amounts keep their dates with amountStatus unknown", () => {
    const l = run({
      days: 30,
      bills: [
        bill({ id: "n", payee: "Null amount", expectedAmount: null, autopayDay: 12 }),
        bill({ id: "z", payee: "Zero amount", expectedAmount: 0, autopayDay: 13 }),
        bill({ id: "ac", payee: "Accrued no budget", amountType: "accrued", annualBudget: null, expectedAmount: null, autopayDay: 14 }),
        bill({ id: "ls", payee: "Lump no amount", frequency: "annual", payMonth: 10, autopayDay: 25, annualBudget: null, expectedAmount: null }),
      ],
      budgets: [budget({ id: "bn", tagId: "tn", period: "2026-10", payDay: 16, budgeted: null })],
      cards: [{ id: "c", nickname: "NoBal", entityId: P, ccDueDate: d("2026-10-18"), ccStatementBalance: null }],
    });
    expect(l.items).toHaveLength(6);
    for (const i of l.items) {
      expect(i.amountStatus).toBe("unknown");
      expect(i.amount).toBeNull();
    }
    expect(l.totals.unknownAmountCount).toBe(6);
    expect(l.totals.outflow.toFixed(2)).toBe("0.00");
  });

  it("a zero-amount accrual draw keeps its date as unknown", () => {
    const l = run({
      bills: [bill({ id: "dz", payee: "Draw", amountType: "accrued", draws: [{ estimatedDate: d("2026-11-10"), estimatedAmount: 0 }], autopayDay: null, annualBudget: 100 })],
    });
    expect(l.items).toHaveLength(1);
    expect(l.items[0]!.amountStatus).toBe("unknown");
  });

  it("an unknown card past due is listed under past due, not dropped", () => {
    const l = run({ cards: [{ id: "c", nickname: "NoBal", entityId: P, ccDueDate: d("2026-10-05"), ccStatementBalance: null }] });
    expect(l.pastDue).toHaveLength(1);
    expect(l.pastDue[0]!.amountStatus).toBe("unknown");
  });
});

describe("a zero / null / negative inflow, payout, revenue or transfer amount is 'Amount not set', never a known $0.00", () => {
  it("transfers: zero amount keeps its dates, is unknown, and stays out of transferTotal", () => {
    const row = (id: string, amount: number | null) => ({
      id,
      fromAccountId: "acct-main",
      toAccountId: "acct-env",
      fromEntityId: P,
      amount: amount as unknown as number,
      cadence: "weekly",
      dayRules: { dayOfWeek: 1 },
      purpose: id,
      active: true,
    });
    for (const amt of [0, -5, null]) {
      const l = run({ days: 30, transfers: [row("t", amt)] });
      expect(dates(l)).toEqual(["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
      for (const i of l.items) {
        expect(i).toMatchObject({ kind: "transfer", amountStatus: "unknown", amount: null });
        expect(i.notes).toContain("Amount not set");
      }
      expect(l.totals.transferTotal.toFixed(2)).toBe("0.00");
      expect(l.totals.outflow.toFixed(2)).toBe("0.00");
      expect(l.totals.unknownAmountCount).toBe(4);
    }
    // a known transfer next to an unknown one: only the known one is summed
    const mixed = run({ days: 30, transfers: [row("ok", 256), row("zero", 0)] });
    expect(mixed.totals.transferTotal.toFixed(2)).toBe("1024.00");
  });

  it("income: zero amount keeps its dates, is unknown, and adds nothing to inflow", () => {
    const l = run({
      days: 30,
      incomeSources: [
        { id: "z", accountId: "acct-main", entityId: P, description: "Zero pay", cadence: "biweekly", dayRules: { intervalDays: 14, anchorDate: "2026-08-28" }, amount: 0, active: true },
        { id: "ok", accountId: "acct-main", entityId: P, description: "Real pay", cadence: "monthly", dayRules: { dayOfMonth: 20 }, amount: 100, active: true },
      ],
    });
    const zero = l.items.filter((i) => i.sourceId === "z");
    expect(zero.map((i) => i.date!.toISOString().slice(0, 10))).toEqual(["2026-10-09", "2026-10-23", "2026-11-06"]);
    for (const i of zero) {
      expect(i).toMatchObject({ kind: "income", amountStatus: "unknown", amount: null });
      expect(i.notes).toContain("Amount not set");
    }
    expect(l.totals.inflow.toFixed(2)).toBe("100.00");
    expect(l.totals.unknownAmountCount).toBe(3);
  });

  it("rental payout: zero gross keeps the payout date, is unknown, and adds nothing to inflow", () => {
    const l = run({
      rentalBookings: [
        { id: "r0", entityId: SV, payoutDate: d("2026-10-19"), guest: "Zero", grossEarnings: 0 },
        { id: "r1", entityId: SV, payoutDate: d("2026-10-20"), guest: "Real", grossEarnings: "1075.00" },
      ],
    });
    const zero = l.items.find((i) => i.sourceId === "r0")!;
    expect(zero).toMatchObject({ kind: "income", amountStatus: "unknown", amount: null });
    expect(zero.date!.toISOString().slice(0, 10)).toBe("2026-10-19");
    expect(zero.notes).toContain("Amount not set");
    expect(l.totals.inflow.toFixed(2)).toBe("1075.00");
    expect(l.totals.unknownAmountCount).toBe(1);
  });

  it("projected revenue: zero amount is unknown in the window and under past due, never in inflow", () => {
    const l = run({
      projectedRevenue: [
        { id: "p0", entityId: EK, description: "Zero invoice", expectedDate: d("2026-11-01"), amountCents: 0 },
        { id: "pn", entityId: EK, description: "Overdue zero", expectedDate: d("2026-09-20"), amountCents: 0 },
        { id: "p1", entityId: EK, description: "Real invoice", expectedDate: d("2026-11-02"), amountCents: 500000 },
      ],
    });
    const zero = l.items.find((i) => i.sourceId === "p0")!;
    expect(zero).toMatchObject({ kind: "income", tier: "estimated", amountStatus: "unknown", amount: null });
    expect(zero.date!.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(zero.notes).toContain("Amount not set");
    expect(l.pastDue.map((i) => [i.sourceId, i.amountStatus, i.amount])).toEqual([["pn", "unknown", null]]);
    expect(l.totals.inflow.toFixed(2)).toBe("5000.00");
    expect(l.totals.unknownAmountCount).toBe(1);
  });
});

describe("unknown day goes to `undated`, never guessed as the 1st", () => {
  const cases: [string, Partial<UpcomingLedgerInput>][] = [
    ["monthly null day (Lexus-shaped)", { bills: [bill({ id: "u1", payee: "Lexus Financial", expectedAmount: 250, autopayDay: null })] }],
    ["accrued spread null day", { bills: [bill({ id: "u2", payee: "Property taxes", amountType: "accrued", annualBudget: 3380.04, expectedAmount: 281.67, autopayDay: null })] }],
    ["weekly null weekday", { bills: [bill({ id: "u3", payee: "W", frequency: "weekly", payDayOfWeek: null, autopayDay: null })] }],
    ["biweekly no anchor", { bills: [bill({ id: "u4", payee: "B", frequency: "biweekly", biweeklyAnchorDate: null, autopayDay: null })] }],
    ["annual no payMonth", { bills: [bill({ id: "u5", payee: "A", frequency: "annual", payMonth: null, autopayDay: 5, annualBudget: 100 })] }],
    ["recurring monthly no dueDay", { recurring: [recurring({ id: "u6", name: "R", dueDay: null })] }],
    ["recurring weekly no nextDueDate", { recurring: [recurring({ id: "u7", name: "RW", frequency: "weekly", dueDay: null, nextDueDate: null })] }],
  ];
  for (const [name, input] of cases) {
    it(name, () => {
      const l = run(input);
      expect(l.items).toHaveLength(0);
      expect(l.undated).toHaveLength(1);
      expect(l.undated[0]!.date).toBeNull();
      expect(l.undated[0]!.tierNote).toBe("day not set");
      expect(l.totals.outflow.toFixed(2)).toBe("0.00");
    });
  }

  it("carries the monthly amount for an undated monthly bill", () => {
    const l = run({ bills: [bill({ id: "lx", payee: "Lexus Financial", expectedAmount: 250, autopayDay: null })] });
    expect(l.undated[0]!.amount!.toFixed(2)).toBe("-250.00");
    expect(l.undated[0]!.notes).toContain("Amount shown is the monthly figure");
  });
});

describe("past due cards", () => {
  it("3 days past due appears in pastDue only; 15 days past is dropped", () => {
    const l = run({
      cards: [
        { id: "b", nickname: "Barclay", entityId: P, ccDueDate: d("2026-10-05"), ccStatementBalance: "623.19" },
        { id: "old", nickname: "Old", entityId: P, ccDueDate: d("2026-09-23"), ccStatementBalance: 10 },
      ],
    });
    expect(l.items).toHaveLength(0);
    expect(l.pastDue.map((i) => i.sourceId)).toEqual(["b"]);
    expect(l.pastDue[0]!.notes[0]).toMatch(/may already be paid/);
    expect(l.totals.outflow.toFixed(2)).toBe("0.00");
  });
});

describe("de-duplication: same budget category", () => {
  const eversource = () => ({
    bills: [tagged({ id: "ev-bill", payee: "Electric (Eversource)", tag: "t-elec", expectedAmount: 172, autopayDay: 20, accountId: "acct-heat" })],
    budgets: ["2026-10", "2026-11", "2026-12", "2027-01"].map((period) =>
      budget({ id: `ev-b-${period}`, tagId: "t-elec", period, budgeted: 172, payDay: 20, accountId: "acct-heat", tagName: "Electric (Eversource)" })
    ),
    recurring: [recurring({ id: "ev-rec", name: "Eversource", amountCents: 20000, dueDay: 20, nextDueDate: d("2026-07-20"), tagId: "t-elec" })],
  });

  it("three-way Eversource: one item per month, bill wins, others recorded, one amount discrepancy", () => {
    const l = run(eversource());
    expect(dates(l)).toEqual(["2026-10-20", "2026-11-20", "2026-12-20"]);
    for (const i of l.items) {
      expect(i.source).toBe("scheduled_bill");
      expect(i.amount!.toFixed(2)).toBe("-172.00");
      expect(i.alsoRecordedAs.map((a) => a.source).sort()).toEqual(["budget_line", "recurring_expense"]);
      expect(i.discrepancies).toHaveLength(1);
      expect(i.discrepancies[0]).toMatchObject({ kind: "monthly_amount", otherSource: "recurring_expense" });
      expect(i.discrepancies.some((x) => x.kind === "day")).toBe(false);
    }
    expect(l.items.every((i) => i.date!.getTime() >= FROM.getTime())).toBe(true);
    // totals count exactly one payment per month
    expect(l.totals.outflow.toFixed(2)).toBe("516.00");
  });

  it("bill + budget with an identical schedule: no discrepancy", () => {
    const e = eversource();
    const l = run({ bills: e.bills, budgets: e.budgets });
    expect(l.items).toHaveLength(3);
    expect(l.items[0]!.alsoRecordedAs.map((a) => a.source)).toEqual(["budget_line"]);
    expect(l.items[0]!.discrepancies).toEqual([]);
  });

  it("Toyota-shaped: Oct clean, Nov and Dec flagged (per-month budget row)", () => {
    const l = run({
      bills: [tagged({ id: "toy", payee: "Toyota (Tacoma)", tag: "t-toy", expectedAmount: 420, autopayDay: 30 })],
      budgets: [
        budget({ id: "t1", tagId: "t-toy", period: "2026-10", budgeted: 420, payDay: 30 }),
        budget({ id: "t2", tagId: "t-toy", period: "2026-11", budgeted: 1500, payDay: 30 }),
        budget({ id: "t3", tagId: "t-toy", period: "2026-12", budgeted: 1500, payDay: 30 }),
      ],
    });
    expect(dates(l)).toEqual(["2026-10-30", "2026-11-30", "2026-12-30"]);
    expect(l.items[0]!.discrepancies).toEqual([]);
    expect(l.items[1]!.discrepancies).toMatchObject([{ kind: "monthly_amount" }]);
    expect(l.items[2]!.discrepancies).toMatchObject([{ kind: "monthly_amount" }]);
    expect(l.items[1]!.amount!.toFixed(2)).toBe("-420.00"); // the bill's amount is always the one shown
  });

  it("Solar-shaped: day differs, amount within $1 -> day discrepancy only", () => {
    const l = run({
      days: 30,
      bills: [tagged({ id: "sol", payee: "Solar", tag: "t-sol", expectedAmount: 505.7, autopayDay: 17 })],
      budgets: [budget({ id: "s1", tagId: "t-sol", period: "2026-10", budgeted: 506, payDay: 14 })],
    });
    expect(l.items[0]!.discrepancies).toEqual([{ kind: "day", otherSource: "budget_line", thisDay: 17, otherDay: 14 }]);
  });

  it("Doggy-shaped: weekly bill $310.56 vs budget $268 -> monthly_amount discrepancy", () => {
    const l = run({
      days: 30,
      bills: [tagged({ id: "dd", payee: "Doggy Daycare", tag: "t-dd", expectedAmount: 310.56, frequency: "weekly", payDayOfWeek: 3, autopayDay: null })],
      budgets: [budget({ id: "d1", tagId: "t-dd", period: "2026-10", budgeted: 268, payDay: null, frequency: "weekly", payDayOfWeek: 3 })],
    });
    const october = l.items.filter((i) => i.date!.toISOString().startsWith("2026-10"));
    expect(october.length).toBe(3);
    for (const i of october) expect(i.discrepancies).toMatchObject([{ kind: "monthly_amount" }]);
  });

  it("a month with no budget row gets a note (bill still wins)", () => {
    const l = run({
      bills: [tagged({ id: "b", payee: "Thing", tag: "t", expectedAmount: 50, autopayDay: 3 })],
      budgets: [budget({ id: "b1", tagId: "t", period: "2026-12", budgeted: 50, payDay: 3 })],
    });
    const jan = l.items.find((i) => i.date!.toISOString().startsWith("2027-01"))!;
    expect(jan.notes).toContain("No budget line for 2027-01");
  });

  it("the same tag id in two entities does not merge", () => {
    const l = run({
      days: 30,
      bills: [
        tagged({ id: "a", payee: "Internet", tag: "shared", entityId: P, expectedAmount: 60, autopayDay: 12 }),
        tagged({ id: "b", payee: "Internet", tag: "shared", entityId: SV, expectedAmount: 66, autopayDay: 12 }),
      ],
    });
    expect(l.items).toHaveLength(2);
    expect(new Set(l.items.map((i) => i.entityId))).toEqual(new Set([P, SV]));
  });
});

describe("de-duplication: untagged records (Stage C)", () => {
  it("historical pairs: the untagged twin is held back, only the tagged record counts", () => {
    const l = run({
      days: 30,
      bills: [
        tagged({ id: "ev", payee: "Electric (Eversource)", tag: "t-ev", expectedAmount: 172, autopayDay: 20, accountId: "acct-heat" }),
        bill({ id: "ev-old", payee: "Eversource", expectedAmount: 184, autopayDay: 20, accountId: "acct-heat" }),
        tagged({ id: "sol", payee: "Solar", tag: "t-sol", expectedAmount: 505.7, autopayDay: 17, accountId: "acct-solar" }),
        bill({ id: "sol-old", payee: "Regions/EnerBank - Solar loan", expectedAmount: 506, autopayDay: 20, accountId: "acct-solar" }),
        tagged({ id: "mtg", payee: "Mortgage", tag: "t-mtg", expectedAmount: 4700, autopayDay: 1, accountId: "acct-mtg" }),
        bill({ id: "mtg-old", payee: "PennyMac - Mortgage", expectedAmount: 4700, autopayDay: 1, accountId: "acct-mtg" }),
      ],
    });
    expect(l.items.map((i) => i.sourceId).sort()).toEqual(["ev", "mtg", "sol"]);
    expect(l.heldBack.map((i) => i.sourceId).sort()).toEqual(["ev-old", "mtg-old", "sol-old"]);
    expect(l.heldBack[0]!.notes.join(" ")).toMatch(/Not counted/);
    expect(l.totals.outflow.toFixed(2)).toBe((172 + 505.7 + 4700).toFixed(2));
  });

  it("amount + day + account alone (no shared word) also holds back", () => {
    const l = run({
      days: 30,
      bills: [
        tagged({ id: "ev", payee: "Electric (Eversource)", tag: "t-ev", expectedAmount: 172, autopayDay: 20 }),
        bill({ id: "u", payee: "Power co-op", expectedAmount: 173, autopayDay: 20 }),
      ],
    });
    expect(l.heldBack.map((i) => i.sourceId)).toEqual(["u"]);
  });

  it("negative controls stay separate", () => {
    const l = run({
      bills: [
        tagged({ id: "am-auto", payee: "Amica - Auto insurance", tag: "t-am", expectedAmount: 120, autopayDay: 5, accountId: "acct-ins" }),
        bill({ id: "prog", payee: "Progressive - Motorcycle insurance", frequency: "annual", payMonth: 2, autopayDay: 26, annualBudget: 127, expectedAmount: 11, accountId: "acct-ins" }),
        tagged({ id: "lex", payee: "Lexus Financial", tag: "t-lex", expectedAmount: 250, autopayDay: 3, accountId: "acct-car" }),
        bill({ id: "toy", payee: "Toyota Financial", expectedAmount: 420, autopayDay: 30, accountId: "acct-car" }),
        // Sudden Valley home policy vs Personal auto policy: different entity
        bill({ id: "sv-am", payee: "Amica - Home insurance (Arbor Retreat)", entityId: SV, expectedAmount: 167.9, autopayDay: 5, accountId: "acct-ins" }),
      ],
    });
    expect(l.heldBack).toHaveLength(0);
    expect(l.items.some((i) => i.sourceId === "toy")).toBe(true);
    expect(l.items.some((i) => i.sourceId === "sv-am")).toBe(true);
  });

  it("today's five untagged Sudden Valley bills vs Reimbursement: none merge, all undated; they never merge with each other", () => {
    const sv = (over: Partial<UpcomingBillRow> & Pick<UpcomingBillRow, "id" | "payee">) =>
      bill({ entityId: SV, accountId: "acct-sv", autopayDay: null, ...over });
    const l = run({
      bills: [
        tagged({ id: "reimb", payee: "Reimbursement", tag: "t-reimb", entityId: SV, accountId: "acct-sv", expectedAmount: 350, autopayDay: 24 }),
        sv({ id: "amica", payee: "Amica - Home insurance (Arbor Retreat)", expectedAmount: 167.9 }),
        sv({ id: "comcast", payee: "Comcast", expectedAmount: 65.95 }),
        sv({ id: "ever", payee: "Eversource (Arbor Retreat)", amountType: "fluctuating", expectedAmount: 83 }),
        sv({ id: "oil", payee: "McCarthy Oil (Arbor Retreat)", amountType: "accrued", annualBudget: 2868, expectedAmount: 239 }),
        sv({ id: "tax", payee: "Property taxes - 56 Arbor Rd", amountType: "accrued", annualBudget: 3380.04, expectedAmount: 281.67 }),
      ],
    });
    expect(l.heldBack).toHaveLength(0);
    expect(l.undated.map((i) => i.sourceId).sort()).toEqual(["amica", "comcast", "ever", "oil", "tax"]);
    expect(l.items.every((i) => i.sourceId === "reimb")).toBe(true);
    expect(l.items.map((i) => i.date!.toISOString().slice(0, 10))).toEqual(["2026-10-24", "2026-11-24", "2026-12-24"]);
  });

  it("untagged recurring duplicating a tagged bill by name is held back; an unrelated one stays", () => {
    const l = run({
      days: 30,
      bills: [tagged({ id: "ev", payee: "Electric (Eversource)", tag: "t-ev", expectedAmount: 172, autopayDay: 20 })],
      recurring: [
        recurring({ id: "dup", name: "Eversource electric", amountCents: 20000, dueDay: 5 }),
        recurring({ id: "other", name: "Gym membership", amountCents: 5000, dueDay: 9 }),
      ],
    });
    expect(l.heldBack.map((i) => i.sourceId)).toEqual(["dup"]);
    expect(l.items.map((i) => i.sourceId).sort()).toEqual(["ev", "other"]);
  });

  it("an untagged orphan envelope that looks like a bill is held back", () => {
    const l = run({
      bills: [tagged({ id: "fw", payee: "Firewood", tag: "t-fw", expectedAmount: 100, autopayDay: 3 })],
      orphanEnvelopes: [{ id: "env", name: "Firewood", accountId: "acct-main", entityId: P, draws: [{ estimatedDate: d("2026-12-14"), estimatedAmount: 315 }] }],
    });
    expect(l.heldBack.map((i) => i.sourceId)).toEqual(["env"]);
    expect(l.items.some((i) => i.sourceId === "env")).toBe(false);
  });
});

describe("scoping and totals", () => {
  const input = (): Partial<UpcomingLedgerInput> => ({
    days: 30,
    bills: [
      bill({ id: "p", payee: "Personal bill", expectedAmount: 100, autopayDay: 12 }),
      bill({ id: "s", payee: "SV bill", entityId: SV, expectedAmount: 40, autopayDay: 12 }),
    ],
    incomeSources: [{ id: "ip", accountId: "a", entityId: P, description: "Pay", cadence: "monthly", dayRules: { dayOfMonth: 15 }, amount: 1000, active: true }],
    rentalBookings: [{ id: "r", entityId: SV, payoutDate: d("2026-10-19"), guest: "G", grossEarnings: 1075 }],
    taxDeadlines: [{ id: "td", entityId: EK, label: "Deadline", dueDate: d("2026-10-15"), status: "upcoming" }],
  });

  it("an entity filter returns only that entity's items from every source", () => {
    const sv = run({ ...input(), entityId: SV });
    expect(sv.items.length).toBeGreaterThan(0);
    expect(sv.items.every((i) => i.entityId === SV)).toBe(true);
    expect(Object.keys(sv.totalsByEntity)).toEqual([SV]);
    expect(sv.totals.outflow.toFixed(2)).toBe("40.00");
    expect(sv.totals.inflow.toFixed(2)).toBe("1075.00");
  });

  it("the aggregate has totals per entity and a sum without netting inflow against outflow", () => {
    const all = run({ ...input(), entityId: null });
    expect(new Set(Object.keys(all.totalsByEntity))).toEqual(new Set([P, SV, EK]));
    expect(all.totalsByEntity[P]!.outflow.toFixed(2)).toBe("100.00");
    expect(all.totalsByEntity[P]!.inflow.toFixed(2)).toBe("1000.00");
    expect(all.totalsByEntity[SV]!.inflow.toFixed(2)).toBe("1075.00");
    expect(all.totals.outflow.toFixed(2)).toBe("140.00");
    expect(all.totals.inflow.toFixed(2)).toBe("2075.00");
  });

  it("outflowEstimated counts only estimated-tier items; biggest ignores transfers, unknowns, inflows and held-back items", () => {
    const l = run({
      days: 30,
      bills: [
        bill({ id: "fl", payee: "Fluctuating", amountType: "fluctuating", expectedAmount: 80, autopayDay: 12 }),
        bill({ id: "st", payee: "Static", expectedAmount: 300, autopayDay: 13 }),
        bill({ id: "un", payee: "Unknown", expectedAmount: null, autopayDay: 14 }),
      ],
      transfers: [{ id: "t", fromAccountId: "a", toAccountId: "b", fromEntityId: P, amount: 5000, cadence: "monthly", dayRules: { dayOfMonth: 15 }, active: true }],
      incomeSources: [{ id: "i", accountId: "a", entityId: P, description: "Pay", cadence: "monthly", dayRules: { dayOfMonth: 16 }, amount: 9000, active: true }],
    });
    expect(l.totals.outflow.toFixed(2)).toBe("380.00");
    expect(l.totals.outflowEstimated.toFixed(2)).toBe("80.00");
    expect(l.totals.inflow.toFixed(2)).toBe("9000.00");
    expect(l.biggest?.sourceId).toBe("st");
  });

  it("a biggest tie goes to the earlier date", () => {
    const l = run({ days: 60, bills: [bill({ id: "same", payee: "Same", expectedAmount: 100, autopayDay: 12 })] });
    expect(l.biggest?.date!.toISOString().slice(0, 10)).toBe("2026-10-12");
  });
});

describe("purity", () => {
  it("lib/upcoming-ledger.ts has no db / next / server imports", () => {
    const src = readFileSync(path.resolve(__dirname, "../upcoming-ledger.ts"), "utf8");
    expect(src).not.toMatch(/@\/lib\/db/);
    expect(src).not.toMatch(/from "next/);
    expect(src).not.toMatch(/^\s*["']use server["']/m);
    const prismaImports = [...src.matchAll(/from "(@prisma\/client[^"]*)"/g)].map((m) => m[1]);
    expect(prismaImports.every((p) => p === "@prisma/client/runtime/library")).toBe(true);
  });

  it("the loader is read-only", () => {
    const src = readFileSync(path.resolve(__dirname, "../upcoming-ledger-build.ts"), "utf8");
    expect(src).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
    expect(src).not.toMatch(/^\s*["']use server["']/m);
  });
});
