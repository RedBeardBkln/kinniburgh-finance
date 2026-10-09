// TESTER-authored adversarial tests for the upcoming ledger builder (pipeline task: upcoming-ledger).
// The builder is imported dynamically so the tester's mutation runner can point UL_MUT at a mutated
// copy of lib/upcoming-ledger.ts; with UL_MUT unset it tests the real module.
import { describe, expect, it } from "vitest";
import type * as UL from "@/lib/upcoming-ledger";

const modPath = process.env.UL_MUT ?? "@/lib/upcoming-ledger";
const mod = (await import(/* @vite-ignore */ modPath)) as typeof UL;
const { buildUpcomingLedger, todayForNewYork } = mod;
type Ledger = UL.UpcomingLedger;
type Input = UL.UpcomingLedgerInput;
type BillRow = UL.UpcomingBillRow;
type BudgetRow = UL.UpcomingBudgetRow;
type RecRow = UL.UpcomingRecurringRow;

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);
const FROM = d("2026-10-08"); // Thursday
const P = "ent-p";
const SV = "ent-sv";
const EK = "ent-ek";

function bill(o: Partial<BillRow> & Pick<BillRow, "id" | "payee">): BillRow {
  return {
    accountId: "acct-a",
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
    ...o,
  };
}
const tagged = (o: Partial<BillRow> & Pick<BillRow, "id" | "payee"> & { tag: string }): BillRow => {
  const { tag, ...rest } = o;
  return bill({ budgetTagId: tag, budgetEntityId: rest.entityId ?? P, ...rest });
};
function budget(o: Partial<BudgetRow> & Pick<BudgetRow, "id" | "tagId" | "period">): BudgetRow {
  return {
    tagName: `Cat ${o.tagId}`,
    entityId: P,
    accountId: "acct-a",
    budgeted: 100,
    payDay: 10,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    ...o,
  };
}
function rec(o: Partial<RecRow> & Pick<RecRow, "id" | "name">): RecRow {
  return { entityId: P, amountCents: 10000, frequency: "monthly", dueDay: 10, nextDueDate: null, tagId: null, ...o };
}
const run = (input: Partial<Input>, days = 90, from = FROM): Ledger => buildUpcomingLedger({ from, days, ...input });
const key = (i: UL.UpcomingItem) => `${i.source}|${i.sourceId}|${iso(i.date)}|${i.amount?.toFixed(2) ?? "null"}|${i.entityId}`;

// Seeded PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
function shuffle<T>(r: () => number, xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

// ── A/B. Dedupe precedence, exact key, no double counting ─────────────────────

describe("dedupe precedence bill > budget > recurring (exact entity+tag key)", () => {
  const periods = ["2026-10", "2026-11", "2026-12", "2027-01"];
  const budgetsFor = (tag: string, over: Partial<BudgetRow> = {}) =>
    periods.map((p) => budget({ id: `b-${tag}-${p}`, tagId: tag, period: p, budgeted: 200, payDay: 20, ...over }));

  it("bill wins over budget and recurring; the others are only recorded as alsoRecordedAs", () => {
    const l = run({
      bills: [tagged({ id: "bill", payee: "B", tag: "T", expectedAmount: 111, autopayDay: 20 })],
      budgets: budgetsFor("T"),
      recurring: [rec({ id: "rec", name: "R", tagId: "T", amountCents: 30000, dueDay: 20 })],
    });
    expect(l.items.length).toBeGreaterThan(0);
    expect(l.items.every((i) => i.source === "scheduled_bill" && i.amount!.toFixed(2) === "-111.00")).toBe(true);
    expect(new Set(l.items.map((i) => iso(i.date))).size).toBe(l.items.length);
    for (const i of l.items) {
      expect(new Set(i.alsoRecordedAs.map((a) => a.source))).toEqual(new Set(["budget_line", "recurring_expense"]));
    }
    expect(l.totals.outflow.toFixed(2)).toBe((111 * l.items.length).toFixed(2));
  });

  it("with the bill inactive, budget schedule wins over recurring", () => {
    const l = run({
      bills: [tagged({ id: "bill", payee: "B", tag: "T", active: false })],
      budgets: budgetsFor("T"),
      recurring: [rec({ id: "rec", name: "R", tagId: "T", amountCents: 30000, dueDay: 20 })],
    });
    expect(l.items.length).toBeGreaterThan(0);
    expect(l.items.every((i) => i.source === "budget_line" && i.amount!.toFixed(2) === "-200.00")).toBe(true);
    expect(l.items.every((i) => i.alsoRecordedAs.some((a) => a.source === "recurring_expense"))).toBe(true);
  });

  it("a budget row without a schedule never beats a recurring expense", () => {
    const l = run({
      budgets: budgetsFor("T", { payDay: null }),
      recurring: [rec({ id: "rec", name: "R", tagId: "T", amountCents: 30000, dueDay: 20 })],
    });
    expect(l.items.length).toBeGreaterThan(0);
    expect(l.items.every((i) => i.source === "recurring_expense" && i.amount!.toFixed(2) === "-300.00")).toBe(true);
  });

  it("the key is exact: different tag, or same tag in another entity, never merges", () => {
    const l = run({
      entityId: null,
      bills: [tagged({ id: "bill", payee: "Alpha Co", tag: "T", expectedAmount: 111, autopayDay: 20 })],
      recurring: [
        rec({ id: "r-other-tag", name: "Beta Co", tagId: "T2", amountCents: 5000, dueDay: 21 }),
        rec({ id: "r-other-ent", name: "Gamma Co", entityId: SV, tagId: "T", amountCents: 6000, dueDay: 22 }),
      ],
    });
    const bySource = (s: string) => l.items.filter((i) => i.sourceId === s).length;
    expect(bySource("bill")).toBeGreaterThan(0);
    expect(bySource("r-other-tag")).toBeGreaterThan(0);
    expect(bySource("r-other-ent")).toBeGreaterThan(0);
    expect(l.items.find((i) => i.sourceId === "bill")!.alsoRecordedAs).toEqual([]);
    expect(l.heldBack).toEqual([]);
  });

  it("precedence does not depend on input order (shuffled fuzz)", () => {
    const r = rng(7);
    for (let n = 0; n < 40; n++) {
      const bills = [tagged({ id: "b1", payee: "Aaa", tag: "T", expectedAmount: 50, autopayDay: 15 }), tagged({ id: "b2", payee: "Bbb", tag: "U", expectedAmount: 60, autopayDay: 16, active: false })];
      const budgets = [...budgetsFor("T"), ...budgetsFor("U", { budgeted: 77 })];
      const recurring = [rec({ id: "r1", name: "Ccc", tagId: "T" }), rec({ id: "r2", name: "Ddd", tagId: "U", amountCents: 9900 })];
      const base = run({ bills, budgets, recurring });
      const shuf = run({ bills: shuffle(r, bills), budgets: shuffle(r, budgets), recurring: shuffle(r, recurring) });
      expect(shuf.items.map(key)).toEqual(base.items.map(key));
    }
  });

  it("oracle fuzz: exactly one payment per category per month, winner by precedence, totals match", () => {
    const r = rng(20261008);
    for (let round = 0; round < 150; round++) {
      const bills: BillRow[] = [];
      const budgets: BudgetRow[] = [];
      const recurring: RecRow[] = [];
      const expected = new Map<string, number>(); // entity -> outflow
      let expectedCount = 0;
      const nCat = int(r, 1, 6);
      for (let c = 0; c < nCat; c++) {
        const entity = pick(r, [P, SV, EK]);
        const tag = `T${round}-${c}`;
        const hasBill = r() < 0.5;
        const billActive = r() < 0.7;
        const hasBudgetSched = r() < 0.5;
        const hasBudgetPlain = !hasBudgetSched && r() < 0.5;
        const hasRec = r() < 0.5;
        const bDay = int(r, 1, 28);
        const sDay = int(r, 1, 28);
        const rDay = int(r, 1, 28);
        const bAmt = 100 + c;
        const sAmt = 200 + c;
        const rAmt = 300 + c;
        if (hasBill) bills.push(tagged({ id: `bill-${tag}`, payee: `Billy${c}x${round}`, entityId: entity, tag, expectedAmount: bAmt, autopayDay: bDay, active: billActive }));
        if (hasBudgetSched || hasBudgetPlain) {
          for (const p of periods) budgets.push(budget({ id: `bud-${tag}-${p}`, tagId: tag, entityId: entity, period: p, budgeted: sAmt, payDay: hasBudgetSched ? sDay : null }));
        }
        if (hasRec) recurring.push(rec({ id: `rec-${tag}`, name: `Recur${c}x${round}`, entityId: entity, tagId: tag, amountCents: rAmt * 100, dueDay: rDay }));

        let day: number | null = null;
        let amt = 0;
        // The bill wins the AMOUNT; when the category's Budget row carries a schedule, the Budget wins the DATE
        // (net-income-budget-dates: the money has to be in the account on the Budget date).
        if (hasBill && billActive) { day = hasBudgetSched ? sDay : bDay; amt = bAmt; }
        else if (hasBudgetSched) { day = sDay; amt = sAmt; }
        else if (hasRec) { day = rDay; amt = rAmt; }
        if (day !== null) {
          let months = 0;
          for (const [y, m] of [[2026, 9], [2026, 10], [2026, 11], [2027, 0]] as const) {
            const t = Date.UTC(y, m, day);
            if (t >= FROM.getTime() && t < FROM.getTime() + 90 * 86400000) months++;
          }
          expected.set(entity, (expected.get(entity) ?? 0) + amt * months);
          expectedCount += months;
        }
      }
      const l = run({ entityId: null, bills, budgets, recurring });
      const dated = l.items.filter((i) => i.kind === "bill");
      expect(dated.length).toBe(expectedCount);
      for (const [ent, amt] of expected) expect(l.totalsByEntity[ent]?.outflow.toFixed(2)).toBe(amt.toFixed(2));
      // no two items for the same category on the same date
      const seen = new Set<string>();
      for (const i of dated) {
        const k = `${i.entityId}|${iso(i.date)}|${i.label}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });
});

// ── C. Cross-entity isolation: scoped run == aggregate restricted to that entity ───────────────────

describe("cross-entity isolation (differential)", () => {
  it("every scoped run equals the aggregate run restricted to that entity (fuzz incl. shared names/tags)", () => {
    const r = rng(99);
    const names = ["Amica - Home insurance", "Amica - Auto insurance", "Eversource", "Electric (Eversource)", "Comcast", "Mortgage", "PennyMac - Mortgage", "Solar", "Regions Solar loan"];
    const ents = [P, SV, EK];
    for (let round = 0; round < 80; round++) {
      const bills: BillRow[] = [];
      const recurring: RecRow[] = [];
      const budgets: BudgetRow[] = [];
      for (let n = 0; n < int(r, 2, 9); n++) {
        const ent = pick(r, ents);
        const tag = r() < 0.5 ? pick(r, ["T1", "T2", "T3"]) : null; // same tag ids reused across entities on purpose
        const b = bill({ id: `b${n}`, payee: pick(r, names), entityId: ent, expectedAmount: pick(r, [65.95, 100, 172, 505.7, 4700]), autopayDay: pick(r, [1, 4, 17, 20, 30]), accountId: pick(r, ["a1", "a2"]), active: r() < 0.9 });
        if (tag && !bills.some((x) => x.budgetTagId === tag && x.budgetEntityId === ent)) { b.budgetTagId = tag; b.budgetEntityId = ent; }
        bills.push(b);
      }
      for (let n = 0; n < int(r, 0, 4); n++) {
        recurring.push(rec({ id: `r${n}`, name: pick(r, names), entityId: pick(r, ents), tagId: r() < 0.5 ? pick(r, ["T1", "T2", "T3"]) : null, amountCents: pick(r, [6595, 10000, 17200]), dueDay: pick(r, [1, 17, 20, 30]) }));
      }
      for (const ent of ents) for (const t of ["T1", "T2"]) if (r() < 0.5) budgets.push(budget({ id: `bud-${ent}-${t}`, tagId: t, entityId: ent, period: "2026-10", budgeted: 172, payDay: 20 }));
      const transfers: UL.UpcomingTransferRow[] = [{ id: "t1", fromAccountId: "a1", toAccountId: "a2", fromEntityId: pick(r, ents), amount: 100, cadence: "weekly", dayRules: { dayOfWeek: 1 }, active: true }];
      const income: UL.UpcomingIncomeRow[] = [{ id: "i1", accountId: "a1", entityId: pick(r, ents), description: "Pay", cadence: "monthly", dayRules: { dayOfMonth: 15 }, amount: 1000, active: true }];
      const taxDeadlines: UL.UpcomingTaxDeadlineRow[] = [{ id: "td", entityId: pick(r, ents), label: "Filing", dueDate: d("2026-10-15"), status: "upcoming" }];
      const cards: UL.UpcomingCardRow[] = [{ id: "c1", nickname: "Card", entityId: pick(r, ents), ccDueDate: d("2026-10-12"), ccStatementBalance: 50 }];
      const input: Partial<Input> = { bills, recurring, budgets, transfers, incomeSources: income, taxDeadlines, cards };
      const agg = run({ ...input, entityId: null });
      for (const ent of ents) {
        const sc = run({ ...input, entityId: ent });
        expect(sc.items.every((i) => i.entityId === ent)).toBe(true);
        expect([...sc.undated, ...sc.heldBack, ...sc.pastDue].every((i) => i.entityId === ent)).toBe(true);
        const only = (xs: UL.UpcomingItem[]) => xs.filter((i) => i.entityId === ent).map(key).sort();
        expect(sc.items.map(key).sort()).toEqual(only(agg.items));
        expect(sc.undated.map(key).sort()).toEqual(only(agg.undated));
        expect(sc.heldBack.map(key).sort()).toEqual(only(agg.heldBack));
        expect(sc.pastDue.map(key).sort()).toEqual(only(agg.pastDue));
        const a = agg.totalsByEntity[ent];
        const s = sc.totalsByEntity[ent];
        expect(s?.outflow.toFixed(2) ?? "0.00").toBe(a?.outflow.toFixed(2) ?? "0.00");
        expect(s?.inflow.toFixed(2) ?? "0.00").toBe(a?.inflow.toFixed(2) ?? "0.00");
      }
    }
  });

  it("an untagged duplicate-looking record in another entity is not held back by a tagged bill elsewhere", () => {
    const l = run({
      entityId: null,
      bills: [
        tagged({ id: "p-elec", payee: "Electric (Eversource)", tag: "T", expectedAmount: 172, autopayDay: 20 }),
        bill({ id: "sv-elec", payee: "Eversource (Arbor Retreat)", entityId: SV, expectedAmount: 83, autopayDay: 20 }),
      ],
    });
    expect(l.heldBack).toEqual([]);
    expect(l.items.some((i) => i.sourceId === "sv-elec")).toBe(true);
  });
});

// ── D. Unknown amounts: never $0, never dropped ────────────────────────────────────────────────────

describe("unknown amounts", () => {
  const cases: [string, Partial<Input>][] = [
    ["static null", { bills: [bill({ id: "x", payee: "Zed", expectedAmount: null })] }],
    ["static zero number", { bills: [bill({ id: "x", payee: "Zed", expectedAmount: 0 })] }],
    ["static zero string", { bills: [bill({ id: "x", payee: "Zed", expectedAmount: "0.00" })] }],
    ["static negative", { bills: [bill({ id: "x", payee: "Zed", expectedAmount: -5 })] }],
    ["fluctuating null", { bills: [bill({ id: "x", payee: "Zed", amountType: "fluctuating", expectedAmount: null })] }],
    ["accrued no annual", { bills: [bill({ id: "x", payee: "Zed", amountType: "accrued", expectedAmount: null, annualBudget: null })] }],
    ["accrued annual zero", { bills: [bill({ id: "x", payee: "Zed", amountType: "accrued", annualBudget: 0 })] }],
    ["weekly null", { bills: [bill({ id: "x", payee: "Zed", frequency: "weekly", payDayOfWeek: 3, expectedAmount: null, autopayDay: null })] }],
    ["biweekly null", { bills: [bill({ id: "x", payee: "Zed", frequency: "biweekly", biweeklyAnchorDate: d("2026-08-28"), expectedAmount: null, autopayDay: null })] }],
    ["annual null", { bills: [bill({ id: "x", payee: "Zed", frequency: "annual", payMonth: 10, autopayDay: 20, annualBudget: null })] }],
    ["semiannual zero", { bills: [bill({ id: "x", payee: "Zed", frequency: "semiannual", payMonth: 10, autopayDay: 20, annualBudget: 0 })] }],
    ["card null balance", { cards: [{ id: "x", nickname: "Zed", entityId: P, ccDueDate: d("2026-10-20"), ccStatementBalance: null }] }],
    ["budget null", { budgets: [budget({ id: "x", tagId: "T", period: "2026-10", budgeted: null, payDay: 20 })] }],
    ["budget zero", { budgets: [budget({ id: "x", tagId: "T", period: "2026-10", budgeted: 0, payDay: 20 })] }],
    ["recurring zero", { recurring: [rec({ id: "x", name: "Zed", amountCents: 0, dueDay: 20, tagId: "T" })] }],
    ["recurring weekly zero", { recurring: [rec({ id: "x", name: "Zed", amountCents: 0, frequency: "weekly", nextDueDate: d("2026-10-14") })] }],
    ["orphan draw zero", { orphanEnvelopes: [{ id: "x", name: "Zed", accountId: "a", entityId: P, draws: [{ estimatedDate: d("2026-10-20"), estimatedAmount: 0 }] }] }],
  ];
  for (const [name, input] of cases) {
    it(`${name}: listed with a date, amount null / unknown, never 0, not in totals`, () => {
      const l = run({ ...input }, 30);
      const mine = l.items.filter((i) => i.sourceId === "x");
      expect(mine.length).toBeGreaterThan(0);
      for (const i of mine) {
        expect(i.amountStatus).toBe("unknown");
        expect(i.amount).toBeNull();
        expect(i.date).not.toBeNull();
      }
      expect(l.totals.outflow.toFixed(2)).toBe("0.00");
      expect(l.totals.inflow.toFixed(2)).toBe("0.00");
      expect(l.totals.unknownAmountCount).toBe(mine.length);
      expect(l.biggest).toBeNull();
    });
  }

  it("invariant fuzz: a known amount is never zero/NaN; every complete-schedule active bill is listed somewhere", () => {
    const r = rng(4242);
    for (let round = 0; round < 120; round++) {
      const bills: BillRow[] = [];
      for (let n = 0; n < int(r, 1, 8); n++) {
        const amt = pick<number | string | null>(r, [null, 0, "0", "0.00", -3, 12.34, 500, "71.67"]);
        const kind = pick(r, ["static", "fluctuating", "accrued", "weekly", "biweekly", "annual", "semiannual"] as const);
        const base = { id: `b${round}-${n}`, payee: `Unique${n}q${round}zz` };
        if (kind === "static" || kind === "fluctuating") bills.push(bill({ ...base, amountType: kind, expectedAmount: amt, autopayDay: int(r, 1, 28) }));
        else if (kind === "accrued") bills.push(bill({ ...base, amountType: "accrued", expectedAmount: amt, annualBudget: amt, autopayDay: int(r, 1, 28) }));
        else if (kind === "weekly") bills.push(bill({ ...base, frequency: "weekly", payDayOfWeek: int(r, 0, 6), expectedAmount: amt, autopayDay: null }));
        else if (kind === "biweekly") bills.push(bill({ ...base, frequency: "biweekly", biweeklyAnchorDate: d("2026-08-28"), expectedAmount: amt, autopayDay: null }));
        else bills.push(bill({ ...base, frequency: kind, payMonth: int(r, 1, 12), autopayDay: int(r, 1, 28), annualBudget: amt, expectedAmount: null }));
      }
      const l = run({ bills }, 400);
      for (const i of [...l.items, ...l.undated]) {
        if (i.amountStatus === "known") {
          expect(i.amount).not.toBeNull();
          expect(i.amount!.isZero()).toBe(false);
          expect(i.amount!.isFinite()).toBe(true);
        } else {
          expect(i.amount).toBeNull();
        }
      }
      for (const b of bills) {
        const listed = [...l.items, ...l.undated, ...l.heldBack].some((i) => i.sourceId === b.id);
        expect(listed, `${b.id} (${b.amountType}/${b.frequency}) silently dropped`).toBe(true);
      }
    }
  });
});

// ── E. Day not set ─────────────────────────────────────────────────────────────────────────────────

describe("'Day not set' never defaults to the 1st (or Monday, or `from`)", () => {
  const undatedCases: [string, Partial<Input>][] = [
    ["monthly null day", { bills: [bill({ id: "x", payee: "Zed", autopayDay: null })] }],
    ["fluctuating null day", { bills: [bill({ id: "x", payee: "Zed", amountType: "fluctuating", autopayDay: null })] }],
    ["accrued spread null day", { bills: [bill({ id: "x", payee: "Zed", amountType: "accrued", annualBudget: 1200, autopayDay: null })] }],
    ["weekly null weekday", { bills: [bill({ id: "x", payee: "Zed", frequency: "weekly", payDayOfWeek: null, autopayDay: null })] }],
    ["biweekly null anchor", { bills: [bill({ id: "x", payee: "Zed", frequency: "biweekly", biweeklyAnchorDate: null, autopayDay: null })] }],
    ["annual null month", { bills: [bill({ id: "x", payee: "Zed", frequency: "annual", payMonth: null, autopayDay: 5, annualBudget: 120 })] }],
    ["annual null day", { bills: [bill({ id: "x", payee: "Zed", frequency: "annual", payMonth: 11, autopayDay: null, annualBudget: 120 })] }],
    ["semiannual null day", { bills: [bill({ id: "x", payee: "Zed", frequency: "semiannual", payMonth: 11, autopayDay: null, annualBudget: 120 })] }],
    ["recurring monthly null dueDay", { recurring: [rec({ id: "x", name: "Zed", dueDay: null })] }],
    ["recurring weekly no nextDueDate", { recurring: [rec({ id: "x", name: "Zed", frequency: "weekly", nextDueDate: null })] }],
    ["recurring biweekly no nextDueDate", { recurring: [rec({ id: "x", name: "Zed", frequency: "biweekly", nextDueDate: null })] }],
    ["recurring quarterly no nextDueDate", { recurring: [rec({ id: "x", name: "Zed", frequency: "quarterly", nextDueDate: null })] }],
    ["recurring annually no nextDueDate", { recurring: [rec({ id: "x", name: "Zed", frequency: "annually", nextDueDate: null })] }],
    ["budget annual no payMonth", { budgets: [budget({ id: "x", tagId: "T", period: "2026-10", frequency: "annual", payMonth: null, payDay: 5, annualAmountDue: 120 })] }],
    ["budget weekly no weekday", { budgets: [budget({ id: "x", tagId: "T", period: "2026-10", frequency: "weekly", payDayOfWeek: null, payDay: null })] }],
  ];
  for (const [name, input] of undatedCases) {
    it(`${name}: exactly one undated entry, no dated item`, () => {
      const l = run(input, 400);
      expect(l.items.filter((i) => i.sourceId === "x")).toEqual([]);
      const u = l.undated.filter((i) => i.sourceId === "x");
      expect(u.length).toBe(1);
      expect(u[0]!.date).toBeNull();
      expect(u[0]!.amountStatus).toBe("known");
      expect(u[0]!.amount!.isNegative()).toBe(true);
      expect(l.totals.outflow.toFixed(2)).toBe("0.00"); // not counted in totals
    });
  }

  it("Sunday (payDayOfWeek 0) and day-of-month values are real days, not 'unset'", () => {
    const l = run({ bills: [bill({ id: "x", payee: "Zed", frequency: "weekly", payDayOfWeek: 0, autopayDay: null })] }, 14);
    expect(l.undated).toEqual([]);
    expect(l.items.map((i) => iso(i.date))).toEqual(["2026-10-11", "2026-10-18"]);
  });

  it("an undated bill never leaks into the dated list on the 1st, even with a window containing a 1st", () => {
    const l = run({ bills: [bill({ id: "x", payee: "Lexus Financial", expectedAmount: 250, autopayDay: null })] }, 90);
    expect(l.items.some((i) => i.sourceId === "x")).toBe(false);
    expect(l.undated[0]!.amount!.toFixed(2)).toBe("-250.00");
  });
});

// ── F. Transfers excluded from totals ──────────────────────────────────────────────────────────────

describe("transfers", () => {
  const tr: UL.UpcomingTransferRow = { id: "t", fromAccountId: "a1", toAccountId: "a2", fromEntityId: P, amount: 256, cadence: "weekly", dayRules: { dayOfWeek: 1 }, active: true };
  it("only the outgoing leg exists, as kind transfer; never in outflow or inflow; counted separately", () => {
    const base = run({ bills: [bill({ id: "b", payee: "Zed", expectedAmount: 50, autopayDay: 12 })] }, 30);
    const withT = run({ bills: [bill({ id: "b", payee: "Zed", expectedAmount: 50, autopayDay: 12 })], transfers: [tr] }, 30);
    const ts = withT.items.filter((i) => i.source === "scheduled_transfer");
    expect(ts.length).toBe(4); // Mondays Oct 12,19,26 Nov 2 (window Oct 8..Nov 6)
    expect(ts.every((i) => i.kind === "transfer")).toBe(true);
    expect(withT.totals.outflow.toFixed(2)).toBe(base.totals.outflow.toFixed(2));
    expect(withT.totals.inflow.toFixed(2)).toBe("0.00");
    expect(withT.totals.transferCount).toBe(4);
    expect(withT.totals.transferTotal.toFixed(2)).toBe("1024.00");
    expect(withT.biggest?.sourceId).toBe("b");
  });
  it("inactive transfers and other-entity transfers are excluded when scoped", () => {
    const l = run({ entityId: SV, transfers: [tr, { ...tr, id: "t2", active: false }] }, 30);
    expect(l.items).toEqual([]);
    expect(l.totals.transferCount).toBe(0);
  });
  it("a transfer funds an envelope that pays a bill: outflow counts the bill once, not twice", () => {
    const l = run({ bills: [bill({ id: "b", payee: "Zed", expectedAmount: 256, autopayDay: 12, accountId: "a2" })], transfers: [{ ...tr, cadence: "monthly", dayRules: { dayOfMonth: 11 } }] }, 30);
    expect(l.totals.outflow.toFixed(2)).toBe("256.00");
    expect(l.totals.transferTotal.toFixed(2)).toBe("256.00");
  });
});

// ── G. Past due box outside totals ─────────────────────────────────────────────────────────────────

describe("past due", () => {
  const card = (id: string, due: string, bal: number | null = 623.19): UL.UpcomingCardRow => ({ id, nickname: id, entityId: P, ccDueDate: d(due), ccStatementBalance: bal });
  it("1..14 days before `from` is past due; 15 is dropped; `from` itself is a normal item; none of it is in totals", () => {
    const l = run({
      cards: [card("c1", "2026-10-07"), card("c14", "2026-09-24"), card("c15", "2026-09-23"), card("c0", "2026-10-08", 10)],
    }, 30);
    expect(l.pastDue.map((i) => i.sourceId).sort()).toEqual(["c1", "c14"]);
    expect(l.items.map((i) => i.sourceId)).toEqual(["c0"]);
    expect(l.totals.outflow.toFixed(2)).toBe("10.00");
    expect(l.pastDue.every((i) => i.notes.some((n) => /may already be paid/.test(n)))).toBe(true);
  });
  it("custom lookback is honoured", () => {
    const l = run({ cards: [card("c3", "2026-10-05"), card("c4", "2026-10-04")], cardPastDueLookbackDays: 3 }, 30);
    expect(l.pastDue.map((i) => i.sourceId)).toEqual(["c3"]);
  });
  it("overdue unrealized projected revenue is past due and not in inflow; realized/archived are ignored", () => {
    const mk = (id: string, extra: Partial<UL.UpcomingProjectedRevenueRow> = {}): UL.UpcomingProjectedRevenueRow => ({ id, entityId: P, description: id, expectedDate: d("2026-09-01"), amountCents: 100000, ...extra });
    const l = run({ projectedRevenue: [mk("late"), mk("done", { realizedAt: d("2026-09-02") }), mk("arch", { archivedAt: d("2026-09-02") })] }, 30);
    expect(l.pastDue.map((i) => i.sourceId)).toEqual(["late"]);
    expect(l.totals.inflow.toFixed(2)).toBe("0.00");
  });
  it("card due after the window end is neither listed nor counted; a card due on `to` is excluded", () => {
    const l = run({ cards: [card("on-to", "2026-11-07", 5), card("last", "2026-11-06", 7)] }, 30);
    expect(l.items.map((i) => i.sourceId)).toEqual(["last"]);
  });
});

// ── H. Per-entity totals (builder level) ───────────────────────────────────────────────────────────

describe("per-entity totals", () => {
  it("inflow and outflow stay separate per entity and are never netted", () => {
    const l = run({
      entityId: null,
      bills: [bill({ id: "pb", payee: "PB", expectedAmount: 1234.56, autopayDay: 12 }), bill({ id: "sb", payee: "SB", entityId: SV, expectedAmount: 2000, autopayDay: 13 })],
      incomeSources: [{ id: "i", accountId: "a", entityId: EK, description: "Pay", cadence: "monthly", dayRules: { dayOfMonth: 15 }, amount: 5000, active: true }],
    }, 30);
    expect(l.totalsByEntity[P]!.outflow.toFixed(2)).toBe("1234.56");
    expect(l.totalsByEntity[SV]!.outflow.toFixed(2)).toBe("2000.00");
    expect(l.totalsByEntity[EK]!.outflow.toFixed(2)).toBe("0.00");
    expect(l.totalsByEntity[EK]!.inflow.toFixed(2)).toBe("5000.00");
    expect(l.totalsByEntity[P]!.inflow.toFixed(2)).toBe("0.00");
    expect(l.totals.outflow.toFixed(2)).toBe("3234.56");
    expect(l.totals.inflow.toFixed(2)).toBe("5000.00");
  });
});

// ── I/J. Date handling and horizon boundaries ──────────────────────────────────────────────────────

describe("todayForNewYork around DST and midnight", () => {
  const cases: [string, string][] = [
    ["2026-03-08T04:59:00Z", "2026-03-07"], // 23:59 EST the night before spring-forward
    ["2026-03-08T05:00:00Z", "2026-03-08"],
    ["2026-03-08T06:59:00Z", "2026-03-08"], // 01:59 EST
    ["2026-03-09T03:59:00Z", "2026-03-08"], // 23:59 EDT
    ["2026-03-09T04:00:00Z", "2026-03-09"],
    ["2026-11-01T03:59:00Z", "2026-10-31"], // 23:59 EDT
    ["2026-11-01T04:00:00Z", "2026-11-01"],
    ["2026-11-02T04:59:00Z", "2026-11-01"], // 23:59 EST
    ["2026-11-02T05:00:00Z", "2026-11-02"],
    ["2026-12-31T23:30:00Z", "2026-12-31"],
    ["2027-01-01T04:59:59Z", "2026-12-31"],
    ["2027-01-01T05:00:00Z", "2027-01-01"],
  ];
  for (const [utc, want] of cases) {
    it(`${utc} -> ${want}`, () => {
      expect(iso(todayForNewYork(new Date(utc)))).toBe(want);
    });
  }
});

describe("horizon boundaries per source", () => {
  const days = 30; // window [Oct 8, Nov 7)
  const last = "2026-11-06";
  const edge = (iso0: string) => d(iso0);
  const sets: [string, (day: string) => Partial<Input>][] = [
    ["monthly bill", (day) => ({ bills: [bill({ id: "x", payee: "Zed", autopayDay: Number(day.slice(8)) })] })],
    ["card", (day) => ({ cards: [{ id: "x", nickname: "Zed", entityId: P, ccDueDate: edge(day), ccStatementBalance: 10 }] })],
    ["rental", (day) => ({ rentalBookings: [{ id: "x", entityId: P, payoutDate: edge(day), guest: "G", grossEarnings: 10 }] })],
    ["projected revenue", (day) => ({ projectedRevenue: [{ id: "x", entityId: P, description: "PR", expectedDate: edge(day), amountCents: 1000 }] })],
    ["tax deadline (UTC midnight)", (day) => ({ taxDeadlines: [{ id: "x", entityId: P, label: "TD", dueDate: edge(day), status: "upcoming" }] })],
    ["tax deadline (ET midnight, EST)", (day) => ({ taxDeadlines: [{ id: "x", entityId: P, label: "TD", dueDate: new Date(`${day}T05:00:00Z`), status: "upcoming" }] })],
    ["tax deadline (ET midnight, EDT)", (day) => ({ taxDeadlines: [{ id: "x", entityId: P, label: "TD", dueDate: new Date(`${day}T04:00:00Z`), status: "upcoming" }] })],
    ["policy expiry", (day) => ({ policies: [{ id: "x", entityId: P, insurer: "I", policyType: "term", expiryDate: edge(day) }] })],
    ["annual bill", (day) => ({ bills: [bill({ id: "x", payee: "Zed", frequency: "annual", payMonth: Number(day.slice(5, 7)), autopayDay: Number(day.slice(8)), annualBudget: 99 })] })],
    ["income monthly", (day) => ({ incomeSources: [{ id: "x", accountId: "a", entityId: P, description: "Pay", cadence: "monthly", dayRules: { dayOfMonth: Number(day.slice(8)) }, amount: 5, active: true }] })],
  ];
  for (const [name, mk] of sets) {
    it(`${name}: day before from excluded, from included, last day included, to excluded`, () => {
      const hit = (day: string) => run(mk(day), days).items.some((i) => i.sourceId === "x");
      // from = Oct 8 ; monthly-day sources: Oct 7 appears next as Nov 7 (excluded) so only check the in/out edges that apply
      expect(hit("2026-10-08")).toBe(true);
      expect(hit(last)).toBe(true);
      if (!["monthly bill", "income monthly"].includes(name)) {
        expect(hit("2026-11-07")).toBe(false);
        expect(hit("2026-10-07")).toBe(false);
      }
    });
  }
  it("a monthly bill on the `to` day (Nov 7) is excluded, on Oct 7 it re-appears only as Nov 7 (excluded)", () => {
    const l = run({ bills: [bill({ id: "x", payee: "Zed", autopayDay: 7 })] }, 30);
    expect(l.items).toEqual([]);
    const l31 = run({ bills: [bill({ id: "x", payee: "Zed", autopayDay: 7 })] }, 31);
    expect(l31.items.map((i) => iso(i.date))).toEqual(["2026-11-07"]);
  });
  it("`from` with a time-of-day is normalized to its UTC date, never moving the window", () => {
    const a = run({ bills: [bill({ id: "x", payee: "Zed", autopayDay: 8 })] }, 30, new Date("2026-10-08T23:59:59Z"));
    expect(a.items.map((i) => iso(i.date))).toEqual(["2026-10-08"]);
    expect(iso(a.from)).toBe("2026-10-08");
  });
  it("30/60/90 windows are nested for a mixed fixture", () => {
    const input: Partial<Input> = {
      bills: [bill({ id: "m", payee: "Aaa", autopayDay: 1 }), bill({ id: "w", payee: "Bbb", frequency: "weekly", payDayOfWeek: 3, autopayDay: null, expectedAmount: 310.56 })],
      cards: [{ id: "c", nickname: "Ccc", entityId: P, ccDueDate: d("2026-12-01"), ccStatementBalance: 5 }],
    };
    const k = (n: number) => new Set(run(input, n).items.map(key));
    for (const x of k(30)) expect(k(60).has(x)).toBe(true);
    for (const x of k(60)) expect(k(90).has(x)).toBe(true);
    expect(k(60).size).toBeGreaterThan(k(30).size);
  });
});

// ── K/L. Lump items and per-occurrence amounts ─────────────────────────────────────────────────────

describe("annual / semiannual lump items", () => {
  it("each payment is the FULL amount, not /12 or /2; semiannual is exactly 2 a year, annual exactly 1", () => {
    const l = run({
      bills: [
        bill({ id: "sa", payee: "Amica", frequency: "semiannual", payMonth: 6, autopayDay: 4, annualBudget: 1182, expectedAmount: 197 }),
        bill({ id: "an", payee: "Progressive", frequency: "annual", payMonth: 2, autopayDay: 26, annualBudget: 127, expectedAmount: 10.58 }),
      ],
    }, 365);
    const sa = l.items.filter((i) => i.sourceId === "sa");
    const an = l.items.filter((i) => i.sourceId === "an");
    expect(sa.map((i) => iso(i.date))).toEqual(["2026-12-04", "2027-06-04"]);
    expect(sa.every((i) => i.amount!.toFixed(2) === "-1182.00")).toBe(true);
    expect(an.map((i) => iso(i.date))).toEqual(["2027-02-26"]);
    expect(an[0]!.amount!.toFixed(2)).toBe("-127.00");
    expect(l.totals.outflow.toFixed(2)).toBe((1182 * 2 + 127).toFixed(2));
  });
  it("leap-year day clamp: annual on the 29th lands Feb 28 2027 and Feb 29 2028", () => {
    const l = run({ bills: [bill({ id: "x", payee: "Zed", frequency: "annual", payMonth: 2, autopayDay: 29, annualBudget: 10 })] }, 800);
    expect(l.items.map((i) => iso(i.date))).toEqual(["2027-02-28", "2028-02-29"]);
  });
  it("a window crossing Dec -> Jan keeps the right year for a January annual", () => {
    const l = run({ bills: [bill({ id: "x", payee: "Zed", frequency: "annual", payMonth: 1, autopayDay: 15, annualBudget: 10 })] }, 90, d("2026-12-01"));
    expect(l.items.map((i) => iso(i.date))).toEqual(["2027-01-15"]);
  });
  it("quarterly recurring yields 4 evenly spaced payments a year (full amount each), including month wrap", () => {
    for (const [next, want] of [
      ["2026-11-15", ["2026-11-15", "2027-02-15", "2027-05-15", "2027-08-15"]],
      ["2026-12-10", ["2026-12-10", "2027-03-10", "2027-06-10", "2027-09-10"]],
      ["2026-10-31", ["2026-10-31", "2027-01-31", "2027-04-30", "2027-07-31"]],
      ["2026-09-15", ["2026-12-15", "2027-03-15", "2027-06-15", "2027-09-15"]], // stale nextDueDate in Sep: second payMonth wraps to Dec
    ] as const) {
      const l = run({ recurring: [rec({ id: "q", name: "Zed", frequency: "quarterly", amountCents: 45000, nextDueDate: d(next), dueDay: null })] }, 365);
      expect(l.items.map((i) => iso(i.date))).toEqual(want);
      expect(l.items.every((i) => i.amount!.toFixed(2) === "-450.00")).toBe(true);
    }
  });
  it("recurring annually: one item, full amount, month/day from nextDueDate even if nextDueDate is stale", () => {
    const l = run({ recurring: [rec({ id: "a", name: "Zed", frequency: "annually", amountCents: 120000, nextDueDate: d("2025-11-20"), dueDay: null })] }, 90);
    expect(l.items.map((i) => iso(i.date))).toEqual(["2026-11-20"]);
    expect(l.items[0]!.amount!.toFixed(2)).toBe("-1200.00");
  });
});

describe("weekly / biweekly per-occurrence amounts", () => {
  it("weekly bill: monthly total x12/52, rounded to cents, correct weekday and count", () => {
    const l = run({ bills: [bill({ id: "w", payee: "Doggy", frequency: "weekly", payDayOfWeek: 3, expectedAmount: 310.56, autopayDay: null })] }, 28);
    expect(l.items.map((i) => iso(i.date))).toEqual(["2026-10-14", "2026-10-21", "2026-10-28", "2026-11-04"]);
    expect(l.items.every((i) => i.amount!.toFixed(2) === "-71.67")).toBe(true);
  });
  it("biweekly bill honours its anchor across a month boundary", () => {
    const l = run({ bills: [bill({ id: "b", payee: "Zed", frequency: "biweekly", biweeklyAnchorDate: d("2026-08-28"), expectedAmount: 500, autopayDay: null })] }, 30);
    expect(l.items.map((i) => iso(i.date))).toEqual(["2026-10-09", "2026-10-23", "2026-11-06"]);
    expect(l.items.every((i) => i.amount!.toFixed(2) === "-230.77")).toBe(true);
  });
  it("recurring weekly/biweekly: every amountCents is emitted EXACTLY per occurrence (fuzz)", () => {
    const r = rng(31337);
    const samples = [1, 2, 3, 7, 99, 100, 3333, 7167, 10000, 12345, 99999, 123456];
    for (let n = 0; n < 300; n++) samples.push(int(r, 1, 500000));
    for (const cents of samples) {
      for (const frequency of ["weekly", "biweekly"] as const) {
        const l = run({ recurring: [rec({ id: "x", name: "Zed", frequency, amountCents: cents, nextDueDate: d("2026-10-14"), dueDay: null })] }, 30);
        expect(l.items.length).toBeGreaterThanOrEqual(frequency === "weekly" ? 4 : 2);
        for (const i of l.items) expect(i.amount!.toFixed(2)).toBe(`-${(cents / 100).toFixed(2)}`);
      }
    }
  });
  it("recurring weekly on a Sunday keeps Sunday (getUTCDay 0 is a real weekday)", () => {
    const l = run({ recurring: [rec({ id: "x", name: "Zed", frequency: "weekly", nextDueDate: d("2026-10-11"), dueDay: null })] }, 14);
    expect(l.items.map((i) => iso(i.date))).toEqual(["2026-10-11", "2026-10-18"]);
  });
  it("recurring biweekly parity follows nextDueDate, including a stale (past) anchor", () => {
    const l = run({ recurring: [rec({ id: "x", name: "Zed", frequency: "biweekly", nextDueDate: d("2026-07-20"), dueDay: null })] }, 30);
    // 2026-07-20 + 14k: Jul 20, Aug 3, 17, 31, Sep 14, 28, Oct 12, 26, Nov 9
    expect(l.items.map((i) => iso(i.date))).toEqual(["2026-10-12", "2026-10-26"]);
    expect(l.items[0]!.notes).toContain("Next due date on file is in the past");
  });
});

// ── Mixed-source ordering / id sanity ──────────────────────────────────────────────────────────────

describe("ids and ordering", () => {
  it("ids are unique and items sorted by date asc under a big mixed fuzz", () => {
    const r = rng(5);
    for (let round = 0; round < 40; round++) {
      const bills = Array.from({ length: int(r, 1, 8) }, (_, n) => bill({ id: `b${n}`, payee: pick(r, ["Amica", "Eversource", "Solar", "Mortgage", "Comcast"]) + n, autopayDay: int(r, 1, 28) }));
      const l = run({ bills, entityId: null }, 90);
      const ids = [...l.items, ...l.undated, ...l.heldBack, ...l.pastDue].map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      const ts = l.items.map((i) => i.date!.getTime());
      expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    }
  });
});

// ── Stage C boundary pins (account gate, 5% / $1 tolerance) the Coder's suite does not pin ──────────

describe("stage C (untagged duplicate holding) boundaries", () => {
  const winner = () => tagged({ id: "w", payee: "Alpha utility", tag: "T", expectedAmount: 100, autopayDay: 20, accountId: "A1" });
  it("same distinctive word but DIFFERENT accounts: not merged, both counted", () => {
    const l = run({ bills: [winner(), bill({ id: "u", payee: "Alpha extra", expectedAmount: 37, autopayDay: 5, accountId: "A2" })] }, 30);
    expect(l.heldBack).toEqual([]);
    expect(l.items.map((i) => i.sourceId).sort()).toEqual(["u", "w"]);
  });
  it("same distinctive word, same account: merged (untagged held back)", () => {
    const l = run({ bills: [winner(), bill({ id: "u", payee: "Alpha extra", expectedAmount: 37, autopayDay: 5, accountId: "A1" })] }, 30);
    expect(l.heldBack.map((i) => i.sourceId)).toEqual(["u"]);
    expect(l.items.map((i) => i.sourceId)).toEqual(["w"]);
  });
  for (const [amt, merged] of [[100, true], [101, true], [104, true], [105, true], [106, false], [96, true], [94, false], [200, false]] as const) {
    it(`no shared word, same day + account: amount ${amt} vs 100 -> ${merged ? "merged" : "separate"}`, () => {
      const l = run({ bills: [winner(), bill({ id: "u", payee: "Zebra thing", expectedAmount: amt, autopayDay: 20, accountId: "A1" })] }, 30);
      expect(l.heldBack.length).toBe(merged ? 1 : 0);
      expect(l.items.length).toBe(merged ? 1 : 2);
    });
  }
  it("the small-amount floor is $1 (a $0.50 vs $1.40 pair is merged, $0.50 vs $1.60 is not)", () => {
    const w = (a: number) => tagged({ id: "w", payee: "Alpha utility", tag: "T", expectedAmount: a, autopayDay: 20, accountId: "A1" });
    const u = (a: number) => bill({ id: "u", payee: "Zebra thing", expectedAmount: a, autopayDay: 20, accountId: "A1" });
    expect(run({ bills: [w(0.5), u(1.4)] }, 30).heldBack.length).toBe(1);
    expect(run({ bills: [w(0.5), u(1.6)] }, 30).heldBack.length).toBe(0);
  });
  it("different day of month, no shared word: never merged however close the amount", () => {
    const l = run({ bills: [winner(), bill({ id: "u", payee: "Zebra thing", expectedAmount: 100, autopayDay: 21, accountId: "A1" })] }, 30);
    expect(l.heldBack).toEqual([]);
  });
});
