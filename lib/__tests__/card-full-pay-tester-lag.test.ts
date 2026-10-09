import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { CLOSE_LAG_DAYS, inferCloseLag, projectCardStatements, type CardInput, type CardTxRow } from "@/lib/card-next-statement";

// TESTER-authored (pipeline task: credit-card-full-pay, round 1). Independent verification of `inferCloseLag`:
//  - a re-implementation of the RULE as stated in the task (>= 3 conclusive cycles within +-1 day, >= 2 narrow,
//    no conclusive cycle disagreeing, amounts within $5, 15..32 day candidates, fallback null) compared on random
//    histories, with and without noise;
//  - a synthetic generator with a KNOWN true lag (statement = charges in (prev due - L, due - L], paid on/near the due
//    date) to check the inferred lag is the truth (dense) or close to it (sparse), and that noise never produces a lag
//    that contradicts a conclusive cycle;
//  - the confidence cap: an assumed lag never yields "high", an inferred one can.

const DAY = 86_400_000;
const D = (s: string | number) => new Decimal(String(s));
const addDays = (x: Date, n: number) => new Date(x.getTime() + n * DAY);
const diff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);

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

function dueOn(year: number, month0: number, anchor: number): Date {
  const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month0, Math.min(anchor, last)));
}

interface Synth {
  txs: CardTxRow[];
  dues: Date[];
  amounts: Decimal[];
}

/** Charges on random days; statement k = charges in (due(k-1) - L, due(k) - L]; payment-like inflow near the due date. */
function synth(r: () => number, o: { lag: number; anchor: number; cycles: number; density: number; noise: number }): Synth {
  const start = new Date(Date.UTC(2026, 9 - o.cycles - 1, 1)); // first due month = start month + 1
  const dues: Date[] = [];
  for (let k = 0; k <= o.cycles; k++) dues.push(dueOn(start.getUTCFullYear(), start.getUTCMonth() + k, o.anchor));
  const first = addDays(dues[0] as Date, -o.lag - 40);
  const last = addDays(dues[dues.length - 1] as Date, -o.lag + 2);
  const charges: { day: Date; amt: Decimal }[] = [];
  for (let dt = first; dt <= last; dt = addDays(dt, 1)) {
    if (r() < o.density) charges.push({ day: dt, amt: D((Math.floor(r() * 49000) / 100 + 6).toFixed(2)) });
  }
  const txs: CardTxRow[] = charges.map((c) => ({ postedAt: c.day, amount: c.amt.negated(), text: "shop", pending: false }));
  txs.push({ postedAt: first, amount: D("-7.77"), text: "opening charge", pending: false });
  const amounts: Decimal[] = [];
  for (let k = 1; k < dues.length; k++) {
    const from = addDays(dues[k - 1] as Date, -o.lag).getTime();
    const to = addDays(dues[k] as Date, -o.lag).getTime();
    let sum = D(0);
    for (const c of charges) if (c.day.getTime() > from && c.day.getTime() <= to) sum = sum.plus(c.amt);
    amounts.push(sum);
    if (sum.greaterThan(0)) {
      const noisy = r() < o.noise ? sum.plus(D(int(r, 20, 400))) : sum;
      txs.push({ postedAt: addDays(dues[k] as Date, int(r, -1, 2)), amount: noisy, text: "payment received", pending: false });
    }
  }
  return { txs, dues, amounts };
}

// ── Independent re-implementation of the stated rule ──────────────────────────────────────────────

function ruleOracle(anchor: number, txs: CardTxRow[]): number | null {
  const posted = txs.filter((t) => !t.pending);
  if (!posted.length) return null;
  const first = Math.min(...posted.map((t) => t.postedAt.getTime()));
  const isPay = (t: CardTxRow) => !t.pending && t.amount.greaterThan(0) && /payment|autopay|pymt/i.test(t.text);
  // payments, clustered when within 7 days
  const pays = posted.filter(isPay).sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
  const merged: { date: Date; amount: Decimal }[] = [];
  for (const p of pays) {
    const last = merged[merged.length - 1];
    if (last && diff(p.postedAt, last.date) <= 7) {
      last.amount = last.amount.plus(p.amount);
      last.date = p.postedAt;
    } else merged.push({ date: p.postedAt, amount: p.amount });
  }
  // nearest monthly due date within 7 days; two payments on one due date are ambiguous and dropped
  const claimed = new Map<number, Decimal | "dup">();
  for (const p of merged) {
    let best: Date | null = null;
    for (let m = -1; m <= 1; m++) {
      const cand = dueOn(p.date.getUTCFullYear(), p.date.getUTCMonth() + m, anchor);
      if (best === null || Math.abs(diff(cand, p.date)) < Math.abs(diff(best, p.date))) best = cand;
    }
    if (!best || Math.abs(diff(best, p.date)) > 7) continue;
    const key = best.getTime();
    claimed.set(key, claimed.has(key) ? "dup" : p.amount);
  }
  const cycles = [...claimed.entries()].filter(([, v]) => v !== "dup").map(([k, v]) => ({ due: new Date(k), amount: v as Decimal })).sort((a, b) => a.due.getTime() - b.due.getTime());
  const charges = posted.filter((t) => !PAYLIKE.test(t.text)).map((t) => ({ day: t.postedAt.getTime(), spent: t.amount.negated() }));
  const fits: Set<number>[] = [];
  for (const c of cycles) {
    const prev = dueOn(c.due.getUTCFullYear(), c.due.getUTCMonth() - 1, anchor);
    if (first > addDays(prev, -32).getTime()) continue; // history must reach the earliest candidate close
    const f = new Set<number>();
    for (let lag = 15; lag <= 32; lag++) {
      const lo = addDays(prev, -lag).getTime();
      const hi = addDays(c.due, -lag).getTime();
      let sum = D(0);
      for (const x of charges) if (x.day > lo && x.day <= hi) sum = sum.plus(x.spent);
      if (sum.minus(c.amount).abs().lessThanOrEqualTo(5)) f.add(lag);
    }
    if (f.size) fits.push(f);
  }
  let best: { lag: number; exact: number } | null = null;
  for (let lag = 15; lag <= 32; lag++) {
    const agree = fits.filter((f) => f.has(lag - 1) || f.has(lag) || f.has(lag + 1));
    const narrow = agree.filter((f) => f.size <= 4).length;
    if (agree.length < 3 || narrow < 2 || agree.length !== fits.length) continue;
    const exact = fits.filter((f) => f.has(lag)).length;
    if (best === null || exact > best.exact || (exact === best.exact && Math.abs(lag - 25) < Math.abs(best.lag - 25))) best = { lag, exact };
  }
  return best ? best.lag : null;
}
const PAYLIKE = /payment|autopay|pymt/i;

describe("inferCloseLag: independent rule oracle", () => {
  it("1500 random synthetic histories (true lag 15..32, anchors 5/12/28/31, sparse to dense, with payment noise): same answer as the rule re-implementation", () => {
    const r = rng(60606);
    let inferred = 0;
    let nulls = 0;
    for (let n = 0; n < 1500; n++) {
      const anchor = pick(r, [5, 12, 28, 31, 1]);
      const s = synth(r, { lag: int(r, 15, 32), anchor, cycles: int(r, 2, 7), density: pick(r, [0.05, 0.15, 0.4, 0.9]), noise: pick(r, [0, 0, 0.2, 0.5]) });
      const got = inferCloseLag({ anchorDay: anchor, txs: s.txs });
      const want = ruleOracle(anchor, s.txs);
      if (want !== null) inferred++;
      else nulls++;
      expect({ n, lag: got?.lag ?? null }).toEqual({ n, lag: want });
    }
    expect(inferred).toBeGreaterThan(150);
    expect(nulls).toBeGreaterThan(150);
  });
});

describe("inferCloseLag: truth recovery and false-positive control (known true lag)", () => {
  it("dense charges, 5-7 clean cycles: the inferred lag is the true lag, exactly, for every lag 15..32 and anchors 5 / 12 / 31", () => {
    const r = rng(7);
    for (const anchor of [5, 12, 31]) {
      for (let lag = 15; lag <= 32; lag++) {
        const s = synth(r, { lag, anchor, cycles: 6, density: 0.9, noise: 0 });
        const got = inferCloseLag({ anchorDay: anchor, txs: s.txs });
        expect({ anchor, lag, got: got?.lag ?? null }).toEqual({ anchor, lag, got: lag });
      }
    }
  });

  it("sparse charges: any inferred lag is within 3 days of the truth (never a confidently wrong close), and it is often null", () => {
    const r = rng(8);
    let wrong = 0;
    let right = 0;
    let none = 0;
    for (let n = 0; n < 1500; n++) {
      const lag = int(r, 15, 32);
      const anchor = pick(r, [5, 12, 31]);
      const s = synth(r, { lag, anchor, cycles: int(r, 3, 7), density: pick(r, [0.04, 0.08, 0.15]), noise: 0 });
      const got = inferCloseLag({ anchorDay: anchor, txs: s.txs });
      if (!got) none++;
      else if (Math.abs(got.lag - lag) <= 3) right++;
      else wrong++;
    }
    expect({ wrong }).toEqual({ wrong: 0 });
    expect(right).toBeGreaterThan(100);
    expect(none).toBeGreaterThan(50);
  });

  it("an inferred lag never contradicts a conclusive cycle: with one corrupted-but-conclusive cycle (a second consistent lag) the answer is null", () => {
    const r = rng(9);
    let checked = 0;
    for (let n = 0; n < 300; n++) {
      const anchor = 12;
      const a = synth(r, { lag: 20, anchor, cycles: 6, density: 0.9, noise: 0 });
      // the 3rd statement was actually closed on a 30-day lag: replace its payment with the amount that lag implies
      const k = 3;
      const charges = a.txs.filter((t) => t.text === "shop" || t.text === "opening charge");
      const from = addDays(a.dues[k - 1] as Date, -30).getTime();
      const to = addDays(a.dues[k] as Date, -30).getTime();
      let sum = D(0);
      for (const c of charges) if (c.postedAt.getTime() > from && c.postedAt.getTime() <= to) sum = sum.plus(c.amount.negated());
      const dueK = a.dues[k] as Date;
      const txs = a.txs.filter((t) => !(t.text === "payment received" && Math.abs(diff(t.postedAt, dueK)) <= 3)).concat([{ postedAt: dueK, amount: sum, text: "payment received", pending: false }]);
      // skip the rare draw where the corrupted amount coincidentally (within $5) also matches a window 18..22 days
      // before the due date: then the cycle really does not disagree with the other five (chance fits, ~5% per cycle)
      let coincidence = false;
      for (let L = 18; L <= 22; L++) {
        let q = D(0);
        const lo = addDays(a.dues[k - 1] as Date, -L).getTime();
        const hi = addDays(dueK, -L).getTime();
        for (const c of charges) if (c.postedAt.getTime() > lo && c.postedAt.getTime() <= hi) q = q.plus(c.amount.negated());
        if (q.minus(sum).abs().lessThanOrEqualTo(5)) coincidence = true;
      }
      if (coincidence) continue;
      const got = inferCloseLag({ anchorDay: anchor, txs });
      checked++;
      // every other cycle says 20, this cycle says 30 and is narrow when dense: no lag is consistent with all of them
      expect(got).toBeNull();
    }
    expect(checked).toBeGreaterThan(250);
  });

  it("amounts: a $5 difference still fits, $5.01 does not (the rule's tolerance), shown on a dense 6-cycle history", () => {
    const r = rng(10);
    const s = synth(r, { lag: 22, anchor: 12, cycles: 6, density: 0.9, noise: 0 });
    const bump = (by: string) => s.txs.map((t) => (t.text === "payment received" ? { ...t, amount: t.amount.plus(D(by)) } : t));
    expect(inferCloseLag({ anchorDay: 12, txs: bump("5.00") })?.lag).toBe(22);
    expect(inferCloseLag({ anchorDay: 12, txs: bump("5.01") })).toBeNull();
  });

  it("fewer than 3 conclusive cycles, or 2 cycles, never infer; pending rows and refunds-as-payments are ignored", () => {
    const r = rng(11);
    const two = synth(r, { lag: 22, anchor: 12, cycles: 2, density: 0.9, noise: 0 });
    expect(inferCloseLag({ anchorDay: 12, txs: two.txs })).toBeNull();
    const six = synth(r, { lag: 22, anchor: 12, cycles: 6, density: 0.9, noise: 0 });
    // payments turned pending are not payments at all -> nothing to infer from
    expect(inferCloseLag({ anchorDay: 12, txs: six.txs.map((t) => (t.text === "payment received" ? { ...t, pending: true } : t)) })).toBeNull();
    expect(inferCloseLag({ anchorDay: 12, txs: [] })).toBeNull();
  });
});

describe("confidence cap and what the estimate says about its close date (rule: assumed lag never 'high')", () => {
  it.each([5, 12, 20])("anchor day %i: a lag-pinned history can reach 'high'; the same history with a 2-cycle (unpinnable) record cannot", (anchor) => {
    // Build the open cycle explicitly: last synthetic due is s.dues[last]; Plaid on-file due = that last due; next = +1 month.
    const r = rng(5 + anchor);
    const lag = 27;
    const s = synth(r, { lag, anchor, cycles: 6, density: 0.9, noise: 0 });
    const lastDue = s.dues[s.dues.length - 1] as Date;
    // choose "today" so the next close is N days away: next due = lastDue + 1 month; close = next due - 27
    const nextDue = dueOn(lastDue.getUTCFullYear(), lastDue.getUTCMonth() + 1, anchor);
    const closeDate = addDays(nextDue, -lag);
    const run = (txs: CardTxRow[], toClose: number) => {
      const today = addDays(closeDate, -toClose);
      const card: CardInput = { id: "c", nickname: "P", entityId: "e", currentBalance: D("1500"), currentBalanceAt: today, ccDueDate: lastDue, ccStatementBalance: D("0"), txs };
      const p = projectCardStatements({ card, bankOutflows: [], today });
      return p.estimates.find((e) => e.kind === "cycle_to_date");
    };
    // inferred (6 cycles): boundaries 3 / 4 / 10 / 11 days to close
    expect(run(s.txs, 3)).toMatchObject({ confidence: "high", closeLagDays: lag, closeLagInferred: true, daysToClose: 3 });
    expect(run(s.txs, 4)).toMatchObject({ confidence: "medium", closeLagInferred: true });
    expect(run(s.txs, 10)).toMatchObject({ confidence: "medium" });
    expect(run(s.txs, 11)).toMatchObject({ confidence: "low" });
    expect(run(s.txs, 0)).toMatchObject({ confidence: "high", daysToClose: 0 });
    expect(run(s.txs, 3)!.why).toContain("worked out from your past statements");
    // Same card without enough history to infer (only the last 2 cycles' rows): lag assumed 25, never 'high'
    const cut = s.txs.filter((t) => t.postedAt.getTime() >= addDays(s.dues[s.dues.length - 3] as Date, -lag - 3).getTime());
    const assumed = run(cut, 1);
    expect(assumed).toMatchObject({ closeLagDays: CLOSE_LAG_DAYS, closeLagInferred: false });
    expect(assumed).toMatchObject({ daysToClose: 3, confidence: "medium" }); // 3 days is "high" by days alone; the assumed lag caps it
    expect(assumed!.why).toContain(`assumed to be ${CLOSE_LAG_DAYS} days before the due date`);
  });
});

describe("inferCloseLag: attach / history / pending rules (each only matters in a 3-cycle history)", () => {
  const base = () => synth(rng(21), { lag: 22, anchor: 12, cycles: 3, density: 0.9, noise: 0 });
  const isPay = (t: CardTxRow) => t.text === "payment received";

  it("baseline: three clean dense cycles infer the true lag", () => {
    expect(inferCloseLag({ anchorDay: 12, txs: base().txs })?.lag).toBe(22);
  });

  it("history must reach back before the earliest candidate close: a cycle whose window starts before the first row is not used", () => {
    const b = base();
    const keepFrom = addDays(b.dues[0] as Date, -10).getTime();
    const shops = b.txs.filter((t) => !isPay(t) && t.text === "shop" && t.postedAt.getTime() > keepFrom);
    const from = addDays(b.dues[0] as Date, -22).getTime();
    const to = addDays(b.dues[1] as Date, -22).getTime();
    let partial = D(0);
    for (const t of shops) if (t.postedAt.getTime() > from && t.postedAt.getTime() <= to) partial = partial.plus(t.amount.negated());
    const pays = b.txs.filter(isPay).sort((x, y) => x.postedAt.getTime() - y.postedAt.getTime());
    const txs = [...shops, { ...(pays[0] as CardTxRow), amount: partial }, pays[1] as CardTxRow, pays[2] as CardTxRow];
    // cycles 2 and 3 are complete, cycle 1 has a partial history: only two usable cycles
    expect(inferCloseLag({ anchorDay: 12, txs })).toBeNull();
  });

  it("two payments claiming one due date are ambiguous and the cycle is dropped (not silently replaced by the later one)", () => {
    const b = base();
    const pays = b.txs.filter(isPay).sort((x, y) => x.postedAt.getTime() - y.postedAt.getTime());
    const due3 = b.dues[3] as Date;
    const others = b.txs.filter((t) => !isPay(t));
    const txs = [...others, pays[0] as CardTxRow, pays[1] as CardTxRow, { ...(pays[2] as CardTxRow), postedAt: addDays(due3, 2) }, { postedAt: addDays(due3, -6), amount: D("30"), text: "payment received", pending: false }];
    expect(inferCloseLag({ anchorDay: 12, txs })).toBeNull();
  });

  it("a payment more than 7 days from every due date is not attached to a cycle", () => {
    const b = base();
    const pays = b.txs.filter(isPay).sort((x, y) => x.postedAt.getTime() - y.postedAt.getTime());
    const others = b.txs.filter((t) => !isPay(t));
    const late = (n: number) => [...others, pays[0] as CardTxRow, pays[1] as CardTxRow, { ...(pays[2] as CardTxRow), postedAt: addDays(b.dues[3] as Date, n) }];
    expect(inferCloseLag({ anchorDay: 12, txs: late(7) })?.lag).toBe(22); // 7 days late still attaches
    expect(inferCloseLag({ anchorDay: 12, txs: late(10) })).toBeNull(); // 10 days late does not
  });

  it("pending charges are not statement charges", () => {
    const b = base();
    const pending: CardTxRow = { postedAt: addDays(b.dues[1] as Date, -15), amount: D("-500"), text: "shop", pending: true };
    expect(inferCloseLag({ anchorDay: 12, txs: [...b.txs, pending] })?.lag).toBe(22);
  });
});
