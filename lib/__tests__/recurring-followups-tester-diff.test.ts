// Tester: differential of the follow-ups' ledger changes against the committed (git HEAD) builder.
// The HEAD copy is only used when UL_OLD points at it (the tester script sets it); otherwise the differential is skipped
// and the always-on invariants still run.
//
// What may differ from HEAD (the intended changes): UpcomingItem.learnedCadence on ledger.learned items,
// ModelledRef.seriesKey, and the "different trailing (...) qualifier = different obligation" rule in the de-duplication.
// Everything else must be byte-identical for the same input.
import { describe, expect, it } from "vitest";
import type * as UL from "@/lib/upcoming-ledger";

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

const PLAIN = ["Amica - Home insurance", "Eversource", "Comcast", "Mortgage", "Solar loan", "Netflix", "HBO Max", "Google One", "Maintenance Fee", "Ring", "Electric (Eversource)"];
const QUALIFIED = ["Maintenance Fee (Credit Cards)", "Maintenance Fee (Slush Funds)", "Eversource (Arbor Retreat)", "Eversource (Other Property)", "Netflix (Basic)", "Netflix (Premium)"];

function bill(o: Partial<UL.UpcomingBillRow> & Pick<UL.UpcomingBillRow, "id" | "payee">): UL.UpcomingBillRow {
  return {
    accountId: "acct-a", entityId: P, amountType: "static", expectedAmount: 100, autopayDay: 10, annualBudget: null, frequency: "monthly",
    payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, active: true, budgetTagId: null, budgetEntityId: null, ...o,
  };
}
function budget(o: Partial<UL.UpcomingBudgetRow> & Pick<UL.UpcomingBudgetRow, "id" | "tagId" | "period">): UL.UpcomingBudgetRow {
  return {
    tagName: `Cat ${o.tagId}`, entityId: P, accountId: "acct-a", budgeted: 100, payDay: 10, frequency: "monthly", payDayOfWeek: null,
    biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null, ...o,
  };
}
function rec(o: Partial<UL.UpcomingRecurringRow> & Pick<UL.UpcomingRecurringRow, "id" | "name">): UL.UpcomingRecurringRow {
  return { entityId: P, amountCents: 10000, frequency: "monthly", dueDay: 10, nextDueDate: null, tagId: null, ...o };
}

/** Many recurring expenses SHARING tags (the add-with-tag scenario), bills, budgets: a superset of the committed fuzz. */
function randomInput(r: () => number, names: readonly string[]): UL.UpcomingLedgerInput {
  const ents = [P, SV, EK];
  const bills: UL.UpcomingBillRow[] = [];
  for (let n = 0; n < int(r, 0, 5); n++) {
    const kind = pick(r, ["static", "fluctuating", "accrued", "weekly", "annual", "quarterly"] as const);
    const base = {
      id: `b${n}`, payee: pick(r, names), entityId: pick(r, ents), accountId: pick(r, ["a1", "a2"]),
      expectedAmount: pick<number | null>(r, [null, 15, 19.13, 65.95, 250]), autopayDay: pick<number | null>(r, [1, 3, 5, 17, 30, null]),
      active: r() < 0.9, budgetTagId: r() < 0.3 ? pick(r, ["T1", "T2"]) : null,
    };
    const bud = base.budgetTagId ? { budgetEntityId: base.entityId } : {};
    if (kind === "weekly") bills.push(bill({ ...base, ...bud, frequency: "weekly" as const, payDayOfWeek: int(r, 0, 6), autopayDay: null }));
    else if (kind === "annual" || kind === "quarterly") bills.push(bill({ ...base, ...bud, frequency: kind, payMonth: int(r, 1, 12), annualBudget: pick<number | null>(r, [null, 1200]) }));
    else bills.push(bill({ ...base, ...bud, amountType: kind, annualBudget: kind === "accrued" ? 1200 : null }));
  }
  const recurring: UL.UpcomingRecurringRow[] = [];
  for (let n = 0; n < int(r, 0, 6); n++) {
    recurring.push(
      rec({
        id: `r${n}`, name: pick(r, names), entityId: pick(r, ents), amountCents: pick(r, [0, 1500, 6595, 10000, 25000]),
        frequency: pick(r, ["monthly", "weekly", "biweekly", "quarterly", "annually"]), dueDay: pick<number | null>(r, [1, 3, 5, 17, 30, null]),
        nextDueDate: r() < 0.5 ? d("2026-10-20") : null, tagId: r() < 0.5 ? pick(r, ["T1", "T2", "T3"]) : null,
      })
    );
  }
  const budgets: UL.UpcomingBudgetRow[] = [];
  for (const ent of ents)
    for (const t of ["T1", "T2", "T3"])
      if (r() < 0.35)
        for (const p of ["2026-10", "2026-11", "2026-12"])
          budgets.push(budget({ id: `bud-${ent}-${t}-${p}`, tagId: t, entityId: ent, period: p, budgeted: pick(r, [172, 400]), payDay: pick<number | null>(r, [20, null]), tagName: pick(r, names) }));
  return {
    from: FROM, days: pick(r, [30, 60, 90]), entityId: pick<string | null>(r, [null, P, SV, EK]), bills, recurring, budgets,
    taxDeadlines: [{ id: "td", entityId: pick(r, ents), label: "Filing", dueDate: d("2026-10-15"), status: "upcoming" }],
  };
}

function randomLearned(r: () => number): UL.LearnedSeriesRow[] {
  const out: UL.LearnedSeriesRow[] = [];
  for (let n = 0; n < int(r, 1, 6); n++) {
    const dates: Date[] = [];
    for (let k = 0; k < int(r, 0, 5); k++) dates.push(d(`2026-${pick(r, ["10", "11", "12"])}-${String(int(r, 1, 28)).padStart(2, "0")}`));
    out.push({
      key: `${pick(r, [P, SV, EK])}|a1|out|${n}`, entityId: pick(r, [P, SV, EK]), accountId: pick(r, ["a1", "a2", null]),
      payee: pick(r, [...PLAIN, ...QUALIFIED]), kind: pick(r, ["outflow", "outflow", "inflow"] as const),
      cadence: pick(r, ["weekly", "biweekly", "monthly", "quarterly", "annual"] as const), amount: pick(r, [4.25, 15, 19.13, 65.95, 250]),
      minAmount: 1, maxAmount: 300, amountMode: pick(r, ["fixed", "varies"] as const), confidence: pick(r, ["low", "medium", "high"] as const),
      why: "Seen 6 times", dates,
    });
  }
  return out;
}

type Json = Record<string, unknown>;
function ser(l: UL.UpcomingLedger, dropLearnedCadence: boolean): string {
  const item = (i: UL.UpcomingItem) => {
    const o: Json = { ...i, amount: i.amount ? i.amount.toFixed(2) : null, date: i.date ? i.date.toISOString() : null };
    if (dropLearnedCadence) delete o.learnedCadence;
    return o;
  };
  const totals = (t: UL.LedgerTotals) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v && typeof v === "object" && "toFixed" in v ? (v as { toFixed: (n: number) => string }).toFixed(2) : v]));
  return JSON.stringify({
    from: l.from.toISOString(), to: l.to.toISOString(),
    items: l.items.map(item), undated: l.undated.map(item), pastDue: l.pastDue.map(item), heldBack: l.heldBack.map(item),
    totals: totals(l.totals), totalsByEntity: Object.fromEntries(Object.entries(l.totalsByEntity).map(([k, v]) => [k, totals(v)])),
    biggest: l.biggest ? item(l.biggest) : null,
    learned: l.learned.map(item), learnedTotals: totals(l.learnedTotals as unknown as UL.LedgerTotals), learnedDropped: l.learnedDropped,
  });
}

/** True when two records of one entity both end in a "(...)" and the two differ. */
function hasDifferingQualifierPair(input: UL.UpcomingLedgerInput): boolean {
  const labels: { e: string; q: string | null }[] = [];
  const q = (s: string) => NEW.trailingQualifier(s);
  for (const b of input.bills ?? []) labels.push({ e: b.entityId, q: q(b.payee) });
  for (const x of input.recurring ?? []) labels.push({ e: x.entityId, q: q(x.name) });
  for (const x of input.budgets ?? []) labels.push({ e: x.entityId, q: q(x.tagName) });
  for (const x of input.learned ?? []) labels.push({ e: x.entityId, q: q(x.payee) });
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i] as { e: string; q: string | null };
      const b = labels[j] as { e: string; q: string | null };
      if (a.e === b.e && a.q !== null && b.q !== null && a.q !== b.q) return true;
    }
  return false;
}

describe.skipIf(!OLD)("tester: counted ledger vs git HEAD builder", () => {
  it("fuzz (names without differing qualifiers): every field incl. learned, learnedTotals, learnedDropped is byte-identical (minus learnedCadence)", () => {
    const r = rng(5150);
    let compared = 0;
    for (let round = 0; round < 3000; round++) {
      const input = randomInput(r, [...PLAIN, ...QUALIFIED]);
      const withLearned = { ...input, learned: randomLearned(r) };
      if (hasDifferingQualifierPair(withLearned)) continue;
      const a = (OLD as typeof UL).buildUpcomingLedger(withLearned);
      const b = NEW.buildUpcomingLedger(withLearned);
      expect(ser(b, true)).toBe(ser(a, true));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(200);
  });

  it("fuzz (unqualified names only): identical for 1,500 inputs", () => {
    const r = rng(8008);
    for (let round = 0; round < 1500; round++) {
      const input = randomInput(r, PLAIN.filter((n) => !n.includes("(")));
      const learned = randomLearned(r).map((l) => ({ ...l, payee: pick(r, PLAIN) }));
      const a = (OLD as typeof UL).buildUpcomingLedger({ ...input, learned });
      const b = NEW.buildUpcomingLedger({ ...input, learned });
      expect(ser(b, true)).toBe(ser(a, true));
    }
  });

  it("learned items gain ONLY learnedCadence, equal to the series cadence; counted items never carry it", () => {
    const r = rng(77);
    let seen = 0;
    for (let round = 0; round < 300; round++) {
      const input = randomInput(r, PLAIN);
      const learned = randomLearned(r);
      const b = NEW.buildUpcomingLedger({ ...input, learned });
      for (const it of b.learned) {
        seen += 1;
        expect(it.learnedCadence).toBe(learned.find((l) => l.key === it.sourceId)?.cadence);
      }
      for (const it of [...b.items, ...b.undated, ...b.pastDue, ...b.heldBack]) expect(it.learnedCadence).toBeUndefined();
    }
    expect(seen).toBeGreaterThan(100);
  });

  it("where names with differing qualifiers exist, the ONLY permitted drift is in de-duplication (never a lost or invented record)", () => {
    const r = rng(404);
    let differing = 0;
    let changed = 0;
    for (let round = 0; round < 800; round++) {
      const input = randomInput(r, [...PLAIN, ...QUALIFIED]);
      if (!hasDifferingQualifierPair(input)) continue;
      differing += 1;
      const a = (OLD as typeof UL).buildUpcomingLedger(input);
      const b = NEW.buildUpcomingLedger(input);
      // every record that the old builder kept or held back is still somewhere in the new output (kept or held back)
      const idsOf = (l: UL.UpcomingLedger) => new Set([...l.items, ...l.undated, ...l.pastDue, ...l.heldBack].map((i) => i.sourceId));
      const oldIds = idsOf(a);
      const newIds = idsOf(b);
      for (const id of oldIds) expect(newIds.has(id)).toBe(true);
      for (const id of newIds) expect(oldIds.has(id)).toBe(true);
      // held back can only SHRINK (a pair stops being merged), never grow
      expect(b.heldBack.length).toBeLessThanOrEqual(a.heldBack.length);
      if (ser(a, true) !== ser(b, true)) changed += 1;
    }
    expect(differing).toBeGreaterThan(100);
    // documents how often the rule actually fires on adversarial qualified names
    expect(changed).toBeGreaterThan(0);
  });

  it("collectModelledRefs: identical to HEAD apart from the new seriesKey field (null without a marker)", () => {
    const r = rng(31);
    for (let round = 0; round < 300; round++) {
      const input = randomInput(r, [...PLAIN, ...QUALIFIED]);
      const a = (OLD as typeof UL).collectModelledRefs(input);
      const b = NEW.collectModelledRefs(input).map((x) => {
        const { seriesKey, ...rest } = x;
        expect(seriesKey ?? null).toBeNull();
        return rest;
      });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });
});

describe.skipIf(!OLD)("tester: the qualifier trade-off against HEAD", () => {
  it("HEAD held the differently-qualified untagged twin back; the follow-up counts both", () => {
    const input: UL.UpcomingLedgerInput = {
      from: FROM, days: 30, entityId: P,
      bills: [
        bill({ id: "t", payee: "Electric (Eversource)", budgetTagId: "T1", budgetEntityId: P, expectedAmount: 172, autopayDay: 20 }),
        bill({ id: "u", payee: "Eversource (Heat)", expectedAmount: 173, autopayDay: 20 }),
      ],
    };
    expect((OLD as typeof UL).buildUpcomingLedger(input).heldBack.map((i) => i.sourceId)).toEqual(["u"]);
    expect(NEW.buildUpcomingLedger(input).heldBack).toHaveLength(0);
  });
});

describe("tester: several recurring expenses sharing one tag all survive with their own amounts (always on)", () => {
  it("fuzz: N same-kind records under one tag, no bill/budget: every record is counted once per due date at its own amount", () => {
    const r = rng(9090);
    for (let round = 0; round < 300; round++) {
      const n = int(r, 2, 5);
      const recs = Array.from({ length: n }, (_, i) =>
        rec({ id: `r${i}`, name: `Streaming ${["Alpha", "Bravo", "Charlie", "Delta", "Echo"][i]}`, amountCents: 100 * (int(r, 3, 90) + i * 100) + int(r, 0, 99), dueDay: int(r, 1, 28), tagId: "T-shared" })
      );
      const l = NEW.buildUpcomingLedger({ from: FROM, days: 35, entityId: P, recurring: recs });
      expect(l.heldBack).toHaveLength(0);
      for (const x of recs) {
        const mine = l.items.filter((i) => i.sourceId === x.id);
        expect(mine.length).toBeGreaterThanOrEqual(1);
        for (const it of mine) expect(it.amount!.abs().toFixed(2)).toBe((x.amountCents / 100).toFixed(2));
        expect(mine[0]!.amount!.abs().toFixed(2)).toBe((x.amountCents / 100).toFixed(2));
        expect(mine[0]!.alsoRecordedAs).toEqual([]);
      }
      const total = recs.reduce((s, x) => s + x.amountCents * l.items.filter((i) => i.sourceId === x.id).length, 0);
      expect(l.totals.outflow.times(100).toFixed(0)).toBe(String(total));
    }
  });
  it("two fees with the same name under one tag (account-qualified) are both counted; with a budget line on that tag they merge by the existing precedence", () => {
    const fees = [rec({ id: "f1", name: "Maintenance Fee (Credit Cards)", amountCents: 1500, dueDay: 3, tagId: "T-fee" }), rec({ id: "f2", name: "Maintenance Fee (Slush Funds)", amountCents: 1500, dueDay: 5, tagId: "T-fee" })];
    const both = NEW.buildUpcomingLedger({ from: FROM, days: 60, entityId: P, recurring: fees });
    expect(both.items.map((i) => i.sourceId).sort()).toEqual(["f1", "f1", "f2", "f2"]);
    expect(both.totals.outflow.toFixed(2)).toBe("60.00");
    const withBudget = NEW.buildUpcomingLedger({ from: FROM, days: 60, entityId: P, recurring: fees, budgets: [budget({ id: "b", tagId: "T-fee", period: "2026-10", budgeted: 30, payDay: 4 }), budget({ id: "b2", tagId: "T-fee", period: "2026-11", budgeted: 30, payDay: 4 })] });
    // unchanged precedence: the budget line carries the category; the records are alternates (never double counted)
    expect(withBudget.items.every((i) => i.sourceId === "b" || i.sourceId === "b2")).toBe(true);
  });
});

describe("tester: qualifier rule edge cases (always on)", () => {
  const run = (over: Partial<UL.UpcomingLedgerInput>) => NEW.buildUpcomingLedger({ from: FROM, days: 30, entityId: P, ...over });

  it("a tagged bill and an untagged twin whose names carry the SAME qualifier are still merged (genuine duplicate)", () => {
    const l = run({
      bills: [bill({ id: "t", payee: "Electric (Eversource)", budgetTagId: "T1", budgetEntityId: P, expectedAmount: 172, autopayDay: 20 }), bill({ id: "u", payee: "Power bill (Eversource)", expectedAmount: 173, autopayDay: 20 })],
    });
    expect(l.heldBack.map((i) => i.sourceId)).toEqual(["u"]);
  });

  it("qualifier case/spacing/punctuation differences are not 'different' (Credit Cards vs credit-cards)", () => {
    expect(NEW.qualifiersDiffer("Fee (Credit Cards)", "Fee (credit-cards)")).toBe(false);
    expect(NEW.qualifiersDiffer("Fee (Credit Cards)", "Fee (Slush Funds)")).toBe(true);
  });

  it("KNOWN TRADE-OFF: a genuine duplicate whose two names carry DIFFERENT qualifiers is no longer held back (documented, not asserted as a defect)", () => {
    const l = run({
      bills: [
        bill({ id: "t", payee: "Electric (Eversource)", budgetTagId: "T1", budgetEntityId: P, expectedAmount: 172, autopayDay: 20 }),
        bill({ id: "u", payee: "Eversource (Heat)", expectedAmount: 173, autopayDay: 20 }),
      ],
    });
    // Both now count (old builder held "u" back). Recorded so a reviewer sees the exact effect.
    expect(l.items.map((i) => i.sourceId).sort()).toEqual(["t", "u"]);
    expect(l.heldBack).toHaveLength(0);
  });

  it("nicknames with brackets break the qualifier reader (nested parentheses are not a qualifier)", () => {
    expect(NEW.trailingQualifier("Maintenance Fee (Checking (x1234))")).toBeNull();
    expect(NEW.trailingQualifier(`Fee (${"x".repeat(61)})`)).toBeNull();
  });
});
