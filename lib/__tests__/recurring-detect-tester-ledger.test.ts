// TESTER-authored tests for the ledger integration of recurring detection (pipeline task: recurring-detection).
//
// 1. Invariants that always run: learned rows live ONLY in ledger.learned / learnedTotals; items, undated, pastDue,
//    heldBack, totals, totalsByEntity and biggest are identical with and without `learned` input.
// 2. A differential against the PRE-CHANGE builder (git HEAD copy of lib/upcoming-ledger.ts). It runs only when
//    UL_OLD points at that copy (the tester script sets it); otherwise those tests are skipped.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import type * as UL from "@/lib/upcoming-ledger";

// UL_MUT lets the tester's mutation runner point at a mutated copy of the new builder.
const NEW = (await import(/* @vite-ignore */ process.env.UL_MUT ?? "@/lib/upcoming-ledger")) as typeof UL;
const oldPath = process.env.UL_OLD;
const OLD = oldPath ? ((await import(/* @vite-ignore */ oldPath)) as typeof UL) : null;

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const FROM = d("2026-10-08");
const P = "ent-p";
const SV = "ent-sv";
const EK = "ent-ek";

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

function bill(o: Partial<UL.UpcomingBillRow> & Pick<UL.UpcomingBillRow, "id" | "payee">): UL.UpcomingBillRow {
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
function budget(o: Partial<UL.UpcomingBudgetRow> & Pick<UL.UpcomingBudgetRow, "id" | "tagId" | "period">): UL.UpcomingBudgetRow {
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
function rec(o: Partial<UL.UpcomingRecurringRow> & Pick<UL.UpcomingRecurringRow, "id" | "name">): UL.UpcomingRecurringRow {
  return { entityId: P, amountCents: 10000, frequency: "monthly", dueDay: 10, nextDueDate: null, tagId: null, ...o };
}

function randomInput(r: () => number): UL.UpcomingLedgerInput {
  const ents = [P, SV, EK];
  const names = ["Amica - Home insurance", "Eversource", "Comcast", "Mortgage", "Solar loan", "Netflix", "Google One", "Doggy Daycare", "Ring"];
  const bills: UL.UpcomingBillRow[] = [];
  for (let n = 0; n < int(r, 0, 7); n++) {
    const kind = pick(r, ["static", "fluctuating", "accrued", "weekly", "biweekly", "annual", "semiannual", "quarterly"] as const);
    const base = {
      id: `b${n}`,
      payee: pick(r, names),
      entityId: pick(r, ents),
      accountId: pick(r, ["a1", "a2"]),
      expectedAmount: pick<number | null>(r, [null, 19.13, 65.95, 250, 505.76]),
      autopayDay: pick<number | null>(r, [1, 5, 17, 20, 30, null]),
      active: r() < 0.9,
    };
    if (kind === "weekly") bills.push(bill({ ...base, frequency: "weekly" as const, payDayOfWeek: int(r, 0, 6), autopayDay: null }));
    else if (kind === "biweekly") bills.push(bill({ ...base, frequency: "biweekly", biweeklyAnchorDate: d("2026-08-28"), autopayDay: null }));
    else if (kind === "annual" || kind === "semiannual" || kind === "quarterly")
      bills.push(bill({ ...base, frequency: kind, payMonth: int(r, 1, 12), annualBudget: pick<number | null>(r, [null, 1200, 2400]) }));
    else bills.push(bill({ ...base, amountType: kind, annualBudget: kind === "accrued" ? 1200 : null }));
  }
  const recurring: UL.UpcomingRecurringRow[] = [];
  for (let n = 0; n < int(r, 0, 4); n++) {
    recurring.push(
      rec({
        id: `r${n}`,
        name: pick(r, names),
        entityId: pick(r, ents),
        amountCents: pick(r, [0, 6595, 10000, 25000]),
        frequency: pick(r, ["monthly", "weekly", "biweekly", "quarterly", "annually"]),
        dueDay: pick<number | null>(r, [1, 17, 30, null]),
        nextDueDate: r() < 0.5 ? d("2026-10-20") : null,
        tagId: r() < 0.3 ? pick(r, ["T1", "T2"]) : null,
      })
    );
  }
  const budgets: UL.UpcomingBudgetRow[] = [];
  for (const ent of ents)
    for (const t of ["T1", "T2"])
      if (r() < 0.4)
        for (const p of ["2026-10", "2026-11", "2026-12"])
          budgets.push(budget({ id: `bud-${ent}-${t}-${p}`, tagId: t, entityId: ent, period: p, budgeted: pick(r, [172, 400]), payDay: pick<number | null>(r, [20, null]) }));
  return {
    from: FROM,
    days: pick(r, [30, 60, 90]),
    entityId: pick<string | null>(r, [null, P, SV, EK]),
    bills,
    recurring,
    budgets,
    transfers: [{ id: "t1", fromAccountId: "a1", toAccountId: "a2", fromEntityId: pick(r, ents), amount: 100, cadence: "weekly", dayRules: { dayOfWeek: 1 }, active: true }],
    incomeSources: [{ id: "i1", accountId: "a1", entityId: pick(r, ents), description: "Pay", cadence: "monthly", dayRules: { dayOfMonth: 15 }, amount: 1000, active: true }],
    taxDeadlines: [{ id: "td", entityId: pick(r, ents), label: "Filing", dueDate: d("2026-10-15"), status: "upcoming" }],
    cards: [{ id: "c1", nickname: "Card", entityId: pick(r, ents), ccDueDate: d("2026-10-12"), ccStatementBalance: 50 }],
  };
}

function randomLearned(r: () => number): UL.LearnedSeriesRow[] {
  const out: UL.LearnedSeriesRow[] = [];
  const names = ["Google One", "Netflix", "Comcast", "Ring", "Arstrat", "Maintenance Fee", "Xfinity", "Amica Insurance"];
  for (let n = 0; n < int(r, 1, 6); n++) {
    const cadence = pick(r, ["weekly", "biweekly", "monthly", "quarterly", "annual"] as const);
    const dates: Date[] = [];
    for (let k = 0; k < int(r, 0, 5); k++) dates.push(d(`2026-${pick(r, ["10", "11", "12"])}-${String(int(r, 1, 28)).padStart(2, "0")}`));
    out.push({
      key: `${pick(r, [P, SV, EK])}|a1|out|${names[n % names.length]}${n}`,
      entityId: pick(r, [P, SV, EK]),
      accountId: pick(r, ["a1", "a2", null]),
      payee: pick(r, names),
      kind: pick(r, ["outflow", "outflow", "inflow"] as const),
      cadence,
      amount: pick(r, [4.25, 19.13, 65.95, 250]),
      minAmount: 1,
      maxAmount: 300,
      amountMode: pick(r, ["fixed", "varies"] as const),
      confidence: pick(r, ["low", "medium", "high"] as const),
      why: "Seen 6 times",
      dates,
    });
  }
  return out;
}

/** Everything that existed before this change, serialised with Decimals as strings. */
function core(l: UL.UpcomingLedger): string {
  const item = (i: UL.UpcomingItem) => ({ ...i, amount: i.amount ? i.amount.toFixed(2) : null, date: i.date ? i.date.toISOString() : null });
  const totals = (t: UL.LedgerTotals) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v && typeof v === "object" && "toFixed" in v ? (v as { toFixed: (n: number) => string }).toFixed(2) : v]));
  return JSON.stringify({
    from: l.from.toISOString(),
    to: l.to.toISOString(),
    items: l.items.map(item),
    undated: l.undated.map(item),
    pastDue: l.pastDue.map(item),
    heldBack: l.heldBack.map(item),
    totals: totals(l.totals),
    totalsByEntity: Object.fromEntries(Object.entries(l.totalsByEntity).map(([k, v]) => [k, totals(v)])),
    biggest: l.biggest ? item(l.biggest) : null,
  });
}

describe("ledger: learned rows stay out of every pre-existing field (always-on invariants)", () => {
  it("fuzz: adding `learned` input changes nothing except learned / learnedTotals / learnedDropped", () => {
    const r = rng(20261008);
    let placed = 0;
    for (let round = 0; round < 250; round++) {
      const input = randomInput(r);
      const learned = randomLearned(r);
      const without = NEW.buildUpcomingLedger(input);
      const withL = NEW.buildUpcomingLedger({ ...input, learned });
      expect(core(withL)).toBe(core(without));
      // without learned input the new fields are empty
      expect(without.learned).toEqual([]);
      expect(without.learnedTotals.count).toBe(0);
      expect(without.learnedTotals.outflow.toFixed(2)).toBe("0.00");
      expect(without.learnedDropped).toBe(0);
      // learned content rules
      for (const it of withL.learned) {
        placed += 1;
        expect(it.tier).toBe("learned");
        expect(it.source).toBe("learned_history");
        expect(it.amountStatus).toBe("known");
        expect(it.amount && it.amount.lt(0)).toBe(true);
        expect(it.date).not.toBeNull();
        expect((it.date as Date).getTime()).toBeGreaterThanOrEqual(withL.from.getTime());
        expect((it.date as Date).getTime()).toBeLessThan(withL.to.getTime());
        if (input.entityId) expect(it.entityId).toBe(input.entityId);
        const row = learned.find((l) => l.key === it.sourceId);
        expect(row).toBeTruthy();
        expect(row?.kind).toBe("outflow");
        expect(row?.cadence).not.toBe("annual");
        expect(row?.confidence).not.toBe("low");
      }
      const sum = withL.learned.reduce((a, i) => a.plus((i.amount as NonNullable<typeof i.amount>).abs()), new Decimal(0));
      expect(withL.learnedTotals.outflow.toFixed(2)).toBe(sum.toFixed(2));
      expect(withL.learnedTotals.count).toBe(withL.learned.length);
      // ids unique across learned
      expect(new Set(withL.learned.map((i) => i.id)).size).toBe(withL.learned.length);
    }
    expect(placed).toBeGreaterThan(50);
  });

  it("low confidence, annual and inflow rows are never placed even when they carry dates", () => {
    const mk = (o: Partial<UL.LearnedSeriesRow>): UL.LearnedSeriesRow => ({
      key: "k",
      entityId: P,
      accountId: "a1",
      payee: "Zzyzx Widgets",
      kind: "outflow",
      cadence: "monthly",
      amount: 10,
      minAmount: 10,
      maxAmount: 10,
      amountMode: "fixed",
      confidence: "high",
      why: "w",
      dates: [d("2026-10-20")],
      ...o,
    });
    const run = (row: UL.LearnedSeriesRow) => NEW.buildUpcomingLedger({ from: FROM, days: 30, entityId: P, learned: [row] }).learned.length;
    expect(run(mk({}))).toBe(1);
    expect(run(mk({ confidence: "medium" }))).toBe(1);
    expect(run(mk({ confidence: "low" }))).toBe(0);
    expect(run(mk({ cadence: "annual" }))).toBe(0);
    expect(run(mk({ kind: "inflow" }))).toBe(0);
    expect(run(mk({ dates: [d("2026-11-07")] }))).toBe(0); // 2026-11-07 is day 30 of a 30-day window starting 10-08: exclusive end
    expect(run(mk({ dates: [d("2026-11-06")] }))).toBe(1);
    expect(run(mk({ dates: [d("2026-10-07")] }))).toBe(0); // before the window
    expect(run(mk({ entityId: SV }))).toBe(0); // other entity under a scoped run
    expect(run(mk({ amount: 0 }))).toBe(0);
  });

  it("a learned row that looks like a bill the ledger already keeps is dropped and counted (belt and braces)", () => {
    const row: UL.LearnedSeriesRow = {
      key: "k-dup", entityId: P, accountId: "acct-a", payee: "Comcast", kind: "outflow", cadence: "monthly", amount: 100, minAmount: 100, maxAmount: 100,
      amountMode: "fixed", confidence: "high", why: "w", dates: [d("2026-10-20")],
    };
    const l = NEW.buildUpcomingLedger({ from: FROM, days: 30, entityId: P, bills: [bill({ id: "b1", payee: "Comcast Internet", autopayDay: 10 })], learned: [row] });
    expect(l.items.some((i) => i.sourceId === "b1")).toBe(true);
    expect(l.learned).toEqual([]);
    expect(l.learnedDropped).toBe(1);
    // the same row against an unrelated bill is kept
    const k = NEW.buildUpcomingLedger({ from: FROM, days: 30, entityId: P, bills: [bill({ id: "b2", payee: "Mortgage", expectedAmount: 1500, autopayDay: 1 })], learned: [row] });
    expect(k.learned).toHaveLength(1);
    expect(k.learnedDropped).toBe(0);
  });

  it("no blended money: a learned row in another entity never enters totalsByEntity", () => {
    const l = NEW.buildUpcomingLedger({
      from: FROM,
      days: 30,
      entityId: null,
      learned: [
        {
          key: "k1",
          entityId: SV,
          accountId: "a1",
          payee: "Zzyzx Widgets",
          kind: "outflow",
          cadence: "monthly",
          amount: 77,
          minAmount: 77,
          maxAmount: 77,
          amountMode: "fixed",
          confidence: "high",
          why: "w",
          dates: [d("2026-10-20")],
        },
      ],
    });
    expect(l.learned).toHaveLength(1);
    expect(l.totals.outflow.toFixed(2)).toBe("0.00");
    expect(Object.keys(l.totalsByEntity)).toEqual([]);
    expect(l.biggest).toBeNull();
    expect(l.items).toEqual([]);
  });
});

describe.skipIf(!OLD)("ledger: differential against the pre-change builder (git HEAD)", () => {
  it("fuzz: the pre-existing fields are byte-identical for the same inputs (no learned)", () => {
    const r = rng(777);
    for (let round = 0; round < 400; round++) {
      const input = randomInput(r);
      const a = (OLD as typeof UL).buildUpcomingLedger(input);
      const b = NEW.buildUpcomingLedger(input);
      expect(core(b)).toBe(core(a));
    }
  });
  it("fuzz: still identical when learned rows are supplied to the new builder", () => {
    const r = rng(778);
    for (let round = 0; round < 400; round++) {
      const input = randomInput(r);
      const a = (OLD as typeof UL).buildUpcomingLedger(input);
      const b = NEW.buildUpcomingLedger({ ...input, learned: randomLearned(r) });
      expect(core(b)).toBe(core(a));
    }
  });
});

describe("collectModelledRefs mirrors the builder's own filters", () => {
  it("inactive bills, other-entity records and schedule-less budgets are not modelled; one record per category", () => {
    const input: UL.UpcomingLedgerInput = {
      from: FROM,
      days: 30,
      entityId: P,
      bills: [
        bill({ id: "b-on", payee: "Alpha Co", budgetTagId: "T1", budgetEntityId: P }),
        bill({ id: "b-off", payee: "Beta Co", active: false }),
        bill({ id: "b-sv", payee: "Gamma Co", entityId: SV }),
      ],
      budgets: [
        budget({ id: "bud1", tagId: "T1", period: "2026-10" }), // same category as the bill -> not a second ref
        budget({ id: "bud2", tagId: "T2", period: "2026-10", payDay: null }), // no schedule
        budget({ id: "bud3", tagId: "T3", period: "2026-10" }),
      ],
      recurring: [rec({ id: "r1", name: "Delta Co", tagId: "T3" }), rec({ id: "r2", name: "Eps Co" })],
    };
    const refs = NEW.collectModelledRefs(input);
    const ids = refs.map((x) => x.sourceId).sort();
    expect(ids).toEqual(["b-on", "bud3", "r2"]);
    expect(refs.every((x) => x.entityId === P)).toBe(true);
  });
});
