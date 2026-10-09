import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import * as NEWUL from "@/lib/upcoming-ledger";
import * as NEWCF from "@/lib/cc-funding";
import { generateCardEstimatePayments, generateCardStatementPayment, monthlyDueDates } from "@/lib/forecast";

// TESTER-authored (pipeline task: credit-card-full-pay). Differentials against the git HEAD copies of the ledger
// builder and the funding analysis (UL_OLD / CF_OLD point at them; otherwise those tests are skipped), plus
// oracle fuzz of the NEW ledger/funding behaviour.

const ulOldPath = process.env.UL_OLD;
const cfOldPath = process.env.CF_OLD;
const OLDUL = ulOldPath ? ((await import(/* @vite-ignore */ ulOldPath)) as typeof NEWUL) : null;
const OLDCF = cfOldPath ? ((await import(/* @vite-ignore */ cfOldPath)) as typeof NEWCF) : null;

const DAY = 86_400_000;
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const addDays = (x: Date, n: number) => new Date(x.getTime() + n * DAY);
const D = (s: string | number) => new Decimal(String(s));

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

const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Decimal ? `D:${x.toFixed(2)}` : x));

const FROM = d("2026-10-09");
const ENTS = ["ent-p", "ent-sv", "ent-ek"];

// ── 1. Ledger: with none of the new inputs the output is the HEAD output ─────────────────────────

function randomCardsInput(r: () => number): NEWUL.UpcomingLedgerInput {
  const cards: NEWUL.UpcomingCardRow[] = [];
  for (let n = 0; n < int(r, 0, 6); n++) {
    cards.push({
      id: `c${n}`,
      nickname: pick(r, ["Barclay", "jetBlue", "Capital One", "Amex"]),
      entityId: pick(r, ENTS),
      ccDueDate: pick<Date | string>(r, [addDays(FROM, int(r, -30, 70)), addDays(FROM, int(r, -5, 5)).toISOString(), addDays(FROM, 0)]),
      ccStatementBalance: pick<NEWUL.UpcomingCardRow["ccStatementBalance"]>(r, [null, 0, -20, "623.19", 51.26, "0.00", 3000]),
    });
  }
  return {
    from: FROM,
    days: pick(r, [30, 60, 90]),
    entityId: pick<string | null>(r, [null, ...ENTS]),
    cardPastDueLookbackDays: pick<number | undefined>(r, [undefined, 14, 30, 0]),
    cards,
    bills: [],
  };
}

describe.skipIf(!OLDUL)("ledger differential vs git HEAD (no new inputs)", () => {
  it("600 random card inputs: items, undated, pastDue, heldBack, totals, totalsByEntity, biggest are identical to HEAD, and paidCards is empty", () => {
    const r = rng(999);
    for (let n = 0; n < 600; n++) {
      const input = randomCardsInput(r);
      const a = NEWUL.buildUpcomingLedger(input);
      const b = OLDUL!.buildUpcomingLedger(input);
      for (const k of ["items", "undated", "pastDue", "heldBack", "totals", "totalsByEntity", "biggest"] as const) {
        expect({ n, k, v: ser(a[k]) }).toEqual({ n, k, v: ser(b[k]) });
      }
      expect(a.paidCards).toEqual([]);
    }
  });

  it("explicit `paid: undefined` and `cardEstimates: []` are also identical to HEAD", () => {
    const r = rng(1000);
    for (let n = 0; n < 200; n++) {
      const input = randomCardsInput(r);
      const withNew: NEWUL.UpcomingLedgerInput = { ...input, cards: (input.cards ?? []).map((c) => ({ ...c, paid: undefined })), cardEstimates: [] };
      const a = NEWUL.buildUpcomingLedger(withNew);
      const b = OLDUL!.buildUpcomingLedger(input);
      for (const k of ["items", "undated", "pastDue", "heldBack", "totals", "totalsByEntity", "biggest"] as const) {
        expect(ser(a[k])).toEqual(ser(b[k]));
      }
    }
  });
});

// ── 2. Ledger: the NEW behaviour against an oracle ──────────────────────────────────────────────

describe("ledger with paid evidence and estimates: oracle fuzz", () => {
  it("800 random inputs: paid cards leave items/pastDue/totals; estimates are counted exactly once per in-window in-scope row; entity scoped run == aggregate filtered", () => {
    const r = rng(31337);
    for (let n = 0; n < 800; n++) {
      const base = randomCardsInput(r);
      const cards = (base.cards ?? []).map((c) => ({
        ...c,
        paid: pick<NEWUL.UpcomingCardRow["paid"]>(r, [undefined, null, { date: addDays(FROM, -3), amount: D("1"), via: "a payment received on the card" }]),
      }));
      const estimates: NEWUL.UpcomingCardEstimateRow[] = [];
      for (let k = 0; k < int(r, 0, 5); k++) {
        estimates.push({
          cardId: pick(r, ["c0", "c1", "c2"]),
          entityId: pick(r, ENTS),
          nickname: pick(r, ["Barclay", "jetBlue"]),
          dueDate: addDays(FROM, int(r, -3, 100)),
          amount: pick(r, [D("100.10"), D("0"), D("-5"), D("2914.91"), D("21.26")]),
          confidence: pick(r, ["high", "medium", "low"] as const),
          why: "basis",
          kind: pick(r, ["cycle_to_date", "typical_month"] as const),
        });
      }
      const input: NEWUL.UpcomingLedgerInput = { ...base, cards, cardEstimates: estimates };
      const L = NEWUL.buildUpcomingLedger(input);
      const to = addDays(FROM, base.days);
      const inScope = (e: string) => base.entityId == null || base.entityId === e;

      // paid cards are never counted: they appear in paidCards only
      const paidIds = new Set(cards.filter((c) => c.paid).map((c) => c.id));
      for (const it of [...L.items, ...L.pastDue]) {
        if (it.source === "card_statement" && !it.sourceId.includes(":est:")) expect(paidIds.has(it.sourceId.split(":")[0]!)).toBe(false);
      }
      // estimate items: exactly the positive, in-window, in-scope rows
      const wantEst = estimates.filter((e) => inScope(e.entityId) && e.dueDate >= FROM && e.dueDate < to && e.amount.greaterThan(0));
      const gotEst = L.items.filter((i) => i.sourceId.includes(":est:"));
      expect({ n, c: gotEst.length }).toEqual({ n, c: wantEst.length });
      for (const it of gotEst) {
        expect(it.tier).toBe("estimated");
        expect(it.kind).toBe("card");
        expect(it.amount!.isNegative()).toBe(true);
      }
      // totals: outflowEstimated is the sum of the estimates (only card rows are in this input)
      const estSum = wantEst.reduce((s, e) => s.plus(e.amount.toDecimalPlaces(2)), D(0));
      expect(L.totals.outflowEstimated.toFixed(2)).toBe(estSum.toFixed(2));
      // ids are unique across items
      const ids = L.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      // entity separation: a scoped run equals the aggregate run restricted to that entity
      if (base.entityId) {
        const agg = NEWUL.buildUpcomingLedger({ ...input, entityId: null });
        const strip = (items: NEWUL.UpcomingItem[]) => items.filter((i) => i.entityId === base.entityId).map((i) => `${i.sourceId}|${(i.date ? iso(i.date) : "undated")}|${i.amount?.toFixed(2)}`).sort();
        expect(L.items.map((i) => `${i.sourceId}|${(i.date ? iso(i.date) : "undated")}|${i.amount?.toFixed(2)}`).sort()).toEqual(strip(agg.items));
        expect(L.paidCards.map((i) => i.sourceId).sort()).toEqual(agg.paidCards.filter((i) => i.entityId === base.entityId).map((i) => i.sourceId).sort());
      }
    }
  });

  it("a paid on-file statement whose due date is in the window is NOT in items and NOT in totals, and the unpaid sibling is", () => {
    const L = NEWUL.buildUpcomingLedger({
      from: FROM,
      days: 30,
      cards: [
        { id: "a", nickname: "A", entityId: "ent-p", ccDueDate: d("2026-10-20"), ccStatementBalance: "100.00", paid: { date: d("2026-10-08"), amount: D("100"), via: "x" } },
        { id: "b", nickname: "B", entityId: "ent-p", ccDueDate: d("2026-10-20"), ccStatementBalance: "40.00", paid: null },
      ],
    });
    expect(L.items.map((i) => i.label)).toEqual(["B statement due"]);
    expect(L.paidCards.map((i) => i.label)).toEqual(["A statement due"]);
    expect(L.totals.outflow.toFixed(2)).toBe("40.00");
  });
});

// ── 3. Funding analysis: HEAD differential + semantics of the new fields ─────────────────────────

function randomCfInput(r: () => number) {
  const from = d("2026-10-09");
  const days = int(r, 5, 45);
  const to = addDays(from, days);
  const cards: NEWCF.CardDue[] = [];
  for (let k = 0; k < int(r, 0, 6); k++) {
    cards.push({
      accountNickname: pick(r, ["Barclay", "jetBlue", "Capital One"]),
      dueDate: addDays(from, int(r, -2, days + 3)),
      statementBalance: pick(r, [D("623.19"), D("51.26"), D("792.68"), D("2914.91"), D("0"), D("1")]),
    });
  }
  return { from, to, cards, currentBalance: pick(r, [D("499.09"), D("5000"), D("0"), D("250"), D("-10")]), minimumBalance: pick<Decimal | null>(r, [D("250"), null, D("0")]) };
}

describe.skipIf(!OLDCF)("analyzeCardFunding differential vs git HEAD", () => {
  it("500 random inputs: without otherFlows and estimates the result equals HEAD's for status, totalDue, shortfall, firstShortfallDate, daily and cards", () => {
    const r = rng(555);
    for (let n = 0; n < 500; n++) {
      const inp = randomCfInput(r);
      const a = NEWCF.analyzeCardFunding(inp);
      const b = OLDCF!.analyzeCardFunding({ ...inp, cards: inp.cards.map((c) => ({ ...c, minimumPayment: null })) });
      expect(a.status).toBe(b.status);
      expect(a.totalDue.toFixed(2)).toBe(b.totalDue.toFixed(2));
      expect(a.shortfall?.toFixed(2) ?? null).toBe(b.shortfall?.toFixed(2) ?? null);
      expect(a.firstShortfallDate?.toISOString() ?? null).toBe(b.firstShortfallDate?.toISOString() ?? null);
      expect(ser(a.daily.map((x) => [x.date, x.balanceAfter]))).toBe(ser(b.daily.map((x) => [x.date, x.balanceAfter])));
      expect(a.estimatedTotalDue.toFixed(2)).toBe("0.00");
      // an empty otherFlows array is also identical
      const c = NEWCF.analyzeCardFunding({ ...inp, otherFlows: [] });
      expect(ser(c.daily)).toBe(ser(a.daily));
    }
  });
});

describe("analyzeCardFunding: otherFlows, estimates and peakShortfall semantics (oracle)", () => {
  it("1000 random inputs: daily balance equals an independent running sum; peakShortfall is the true low point; estimatedTotalDue sums only estimates", () => {
    const r = rng(8080);
    for (let n = 0; n < 1000; n++) {
      const inp = randomCfInput(r);
      const flows: NEWCF.ScheduledFlow[] = [];
      for (let k = 0; k < int(r, 0, 6); k++) flows.push({ date: addDays(inp.from, int(r, -3, 50)), amount: pick(r, [D("3000"), D("-250"), D("9000"), D("-2350")]) });
      const cards = inp.cards.map((c) => (r() < 0.4 ? { ...c, estimate: { confidence: pick(r, ["high", "medium", "low"] as const), why: "w" } } : c));
      const res = NEWCF.analyzeCardFunding({ ...inp, cards, otherFlows: flows });
      const min = inp.minimumBalance ?? D(0);
      let bal = inp.currentBalance;
      const days = Math.round((inp.to.getTime() - inp.from.getTime()) / DAY);
      const lows: Decimal[] = [];
      let first: { i: number; short: Decimal } | null = null;
      for (let i = 0; i < days; i++) {
        const day = addDays(inp.from, i);
        for (const f of flows) if (iso(f.date) === iso(day)) bal = bal.plus(f.amount);
        for (const c of cards) if (iso(c.dueDate) === iso(day)) bal = bal.minus(c.statementBalance);
        expect(res.daily[i]!.balanceAfter.toFixed(2)).toBe(bal.toFixed(2));
        lows.push(bal);
        if (first === null && bal.lessThan(min)) first = { i, short: min.minus(bal) };
      }
      expect(res.status === "shortfall").toBe(first !== null);
      expect(res.shortfall?.toFixed(2) ?? null).toBe(first ? first.short.toFixed(2) : null);
      if (first) {
        const lowest = lows.reduce((m, x) => (x.lessThan(m) ? x : m));
        expect(res.peakShortfall!.toFixed(2)).toBe(min.minus(lowest).toFixed(2));
        expect(res.peakShortfall!.greaterThanOrEqualTo(res.shortfall!)).toBe(true);
        expect(iso(res.peakShortfallDate!)).toBe(iso(addDays(inp.from, lows.findIndex((x) => x.equals(lowest)))));
      } else {
        expect(res.peakShortfall).toBeNull();
        expect(res.peakShortfallDate).toBeNull();
      }
      const est = cards.filter((c) => c.estimate).reduce((s, c) => s.plus(c.statementBalance), D(0));
      expect(res.estimatedTotalDue.toFixed(2)).toBe(est.toFixed(2));
      expect(res.totalDue.toFixed(2)).toBe(cards.reduce((s, c) => s.plus(c.statementBalance), D(0)).toFixed(2));
    }
  });

  it("buildFundingMessage never says unpaid / interest / minimum payment, marks estimates, and keeps the on-file wording when there are none", () => {
    const r = rng(12);
    for (let n = 0; n < 300; n++) {
      const inp = randomCfInput(r);
      const cards = inp.cards.map((c) => (r() < 0.5 ? { ...c, estimate: { confidence: "high" as const, why: "based on this cycle's charges so far" } } : c));
      const result = NEWCF.analyzeCardFunding({ ...inp, cards });
      const { title, body } = NEWCF.buildFundingMessage({
        fundingAccountNickname: "Credit Cards",
        currentBalance: inp.currentBalance,
        minimumBalance: inp.minimumBalance,
        minimumBalanceFee: D(15),
        result,
      });
      expect(`${title} ${body}`).not.toMatch(/unpaid|accru|minimum payment/i);
      if (result.cards.some((c) => c.estimate)) expect(body).toContain("Estimated amounts are not final");
      else expect(body).not.toContain("estimate");
    }
  });
});

// ── 4. Forecast helpers ─────────────────────────────────────────────────────────────────────────

describe("forecast helpers for card payments", () => {
  it("generateCardEstimatePayments: window is [from,to), zero/negative skipped, description says (estimate), outflow negative", () => {
    const evs = generateCardEstimatePayments(
      {
        nickname: "Barclay",
        fundingAccountId: "cc",
        estimates: [
          { dueDate: d("2026-11-05"), amount: D("2914.91") },
          { dueDate: d("2026-10-09"), amount: D("10") }, // = from: included
          { dueDate: d("2026-11-09"), amount: D("10") }, // = to: excluded
          { dueDate: d("2026-11-06"), amount: D("0") },
          { dueDate: d("2026-11-07"), amount: D("-4") },
        ],
      },
      d("2026-10-09"),
      d("2026-11-09")
    );
    expect(evs.map((e) => [iso(e.date), e.amount.toFixed(2), e.description, e.accountId])).toEqual([
      ["2026-10-09", "-10.00", "Barclay statement payment (estimate)", "cc"],
      ["2026-11-05", "-2914.91", "Barclay statement payment (estimate)", "cc"],
    ]);
  });

  it("generateCardStatementPayment is unchanged for the on-file statement (full balance, not an estimate)", () => {
    const evs = generateCardStatementPayment({ id: "x", nickname: "Capital One", fundingAccountId: "cc", ccDueDate: d("2026-10-12"), ccStatementBalance: "792.68" }, d("2026-10-09"), d("2026-11-09"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.amount.toFixed(2)).toBe("-792.68");
    expect(evs[0]!.description).not.toContain("estimate");
  });

  it("monthlyDueDates clamps day 29-31 to the month end and goes back to the anchor day", () => {
    expect(monthlyDueDates(31, d("2026-01-01"), d("2026-06-01")).map(iso)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    expect(monthlyDueDates(30, d("2027-02-01"), d("2027-04-01")).map(iso)).toEqual(["2027-02-28", "2027-03-30"]);
    expect(monthlyDueDates(0, d("2026-01-01"), d("2026-06-01"))).toEqual([]);
    expect(monthlyDueDates(32, d("2026-01-01"), d("2026-06-01"))).toEqual([]);
    expect(monthlyDueDates(1.5, d("2026-01-01"), d("2026-06-01"))).toEqual([]);
  });
});
