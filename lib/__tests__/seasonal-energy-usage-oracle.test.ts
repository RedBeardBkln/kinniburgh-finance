import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { electricUsageEstimate, firewoodUsageEstimate, oilUsageEstimate, type UsageRow } from "@/lib/seasonal-energy-usage";
import { ENERGY_SITE_FACTS, type ElectricEstimate, type FirewoodEstimate, type OilEstimate } from "@/lib/seasonal-energy";

// An independent, deliberately naive re-implementation of the three usage models, compared with the real ones on seeded
// random synthetic histories. The naive versions use explicit loops and explicit index arithmetic (no shared helpers, no
// modular smoothing helper, JS numbers instead of Decimal except for the OLS means formula). All data is synthetic.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = new Date("2026-10-10T12:00:00.000Z");
const NOW_IDX = 2026 * 12 + 9; // October 2026
const D = (v: number | string) => new Decimal(v);
let seq = 0;
const periodOfIdx = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const idxOf = (p: string) => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7)) - 1;

function mk(kind: UsageRow["kind"], period: string, occurredOn: string, qty: number, cost: number | null, unit?: string): UsageRow {
  seq += 1;
  return {
    id: `o${seq}`,
    kind,
    period,
    occurredOn,
    quantity: D(qty.toFixed(3)),
    unit: unit ?? (kind === "electric" ? "kwh" : kind === "oil" ? "gal" : "cord"),
    cost: cost === null ? null : D(cost.toFixed(2)),
    note: null,
  };
}

function naiveSmooth(v: number[]): number[] {
  const s: number[] = [];
  for (let m = 0; m < 12; m++) {
    const prev = m === 0 ? v[11]! : v[m - 1]!;
    const next = m === 11 ? v[0]! : v[m + 1]!;
    s.push((prev + v[m]! + next) / 3);
  }
  return s;
}

const close = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;

// ── Electric ───────────────────────────────────────────────────────────────────

function naiveElectric(rows: UsageRow[], solar: string | null, paymentAnnual: number | null) {
  const eligible = rows.filter((r) => idxOf(r.period) < NOW_IDX && (solar === null || r.period >= solar));
  const byMonth: Record<number, UsageRow[]> = {};
  for (const r of eligible) (byMonth[Number(r.period.slice(5, 7))] ??= []).push(r);
  for (let m = 1; m <= 12; m++) if (!byMonth[m] || byMonth[m]!.length === 0) return { gated: true as const };
  const newest = Math.max(...eligible.map((r) => idxOf(r.period)));
  if (NOW_IDX - newest > 24) return { gated: true as const };
  const K: number[] = [];
  const Kmin: number[] = [];
  const Kmax: number[] = [];
  const years: number[] = [];
  for (let m = 1; m <= 12; m++) {
    const list = byMonth[m]!.slice().sort((a, b) => idxOf(b.period) - idxOf(a.period)).slice(0, 3);
    const q = list.map((r) => r.quantity.toNumber());
    K.push(q.reduce((a, b) => a + b, 0) / q.length);
    Kmin.push(Math.min(...q));
    Kmax.push(Math.max(...q));
    years.push(list.length);
  }
  const paired = eligible.filter((r) => r.cost !== null);
  const calMonths = new Set(paired.map((r) => Number(r.period.slice(5, 7)))).size;
  if (paired.length >= 12 && calMonths >= 8) {
    // means formula, in Decimal
    const n = D(paired.length);
    const xbar = paired.reduce((a, r) => a.plus(r.quantity), D(0)).div(n);
    const ybar = paired.reduce((a, r) => a.plus(r.cost!), D(0)).div(n);
    let sxy = D(0);
    let sxx = D(0);
    let syy = D(0);
    for (const r of paired) {
      const dx = r.quantity.minus(xbar);
      const dy = r.cost!.minus(ybar);
      sxy = sxy.plus(dx.times(dy));
      sxx = sxx.plus(dx.times(dx));
      syy = syy.plus(dy.times(dy));
    }
    if (!sxx.isZero() && !syy.isZero()) {
      const b = sxy.div(sxx);
      const a = ybar.minus(b.times(xbar));
      const r2 = sxy.times(sxy).div(sxx.times(syy));
      if (b.greaterThan(0) && r2.greaterThanOrEqualTo("0.5")) {
        const se = Math.sqrt(syy.minus(b.times(sxy)).div(paired.length - 2).toNumber());
        const amt = K.map((k) => a.toNumber() + b.toNumber() * k);
        const lo = K.map((_, i) => {
          const v = a.toNumber() + b.toNumber() * Kmin[i]!;
          return years[i] === 1 ? Math.min(v, amt[i]! - se) : v;
        });
        const hi = K.map((_, i) => {
          const v = a.toNumber() + b.toNumber() * Kmax[i]!;
          return years[i] === 1 ? Math.max(v, amt[i]! + se) : v;
        });
        const nMin = Math.min(...years);
        let conf = nMin >= 3 ? 2 : nMin === 2 ? 1 : 0;
        if (r2.lessThan("0.8")) conf = Math.max(0, conf - 1);
        return { gated: false as const, method: "usage_paired", amt, lo, hi, conf };
      }
    }
  }
  if (paymentAnnual === null) return { gated: true as const };
  const total = K.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { gated: true as const };
  const amt = K.map((k) => (paymentAnnual * k) / total);
  const lo = Kmin.map((k) => (paymentAnnual * k) / total);
  const hi = Kmax.map((k) => (paymentAnnual * k) / total);
  return { gated: false as const, method: "usage_shape", amt, lo, hi, conf: Math.min(...years) >= 2 ? 1 : 0 };
}

describe("oracle: electric usage model against a naive implementation", () => {
  it("agrees on 300 seeded random synthetic histories", () => {
    const rand = mulberry32(5150);
    let estimates = 0;
    let paired = 0;
    let gates = 0;
    for (let trial = 0; trial < 300; trial++) {
      const years = 1 + Math.floor(rand() * 4);
      const monthsBack = years * 12 - Math.floor(rand() * 4);
      const dropChance = rand() < 0.25 ? 0.15 : 0;
      const slope = rand() < 0.15 ? -0.1 : 0.08 + rand() * 0.2;
      const noise = rand() * 25;
      const withCost = rand() < 0.65;
      const costChance = 0.5 + rand() * 0.5;
      const rows: UsageRow[] = [];
      for (let i = NOW_IDX - monthsBack; i < NOW_IDX; i++) {
        if (rand() < dropChance) continue;
        const m = (i % 12) + 1;
        const kwh = 450 + 300 * Math.cos(((m - 1) / 12) * 2 * Math.PI) + rand() * 120;
        const cost = withCost && rand() < costChance ? 25 + slope * kwh + (rand() - 0.5) * noise : null;
        rows.push(mk("electric", periodOfIdx(i), `${periodOfIdx(i)}-01`, kwh, cost));
      }
      if (rows.length === 0) continue;
      const solar = rand() < 0.4 ? "2023-03" : null;
      const site = solar ? ENERGY_SITE_FACTS.personal! : ENERGY_SITE_FACTS["sudden-valley"]!;
      const paymentAnnual = rand() < 0.7 ? 2500 + rand() * 2000 : null;
      const real = electricUsageEstimate({ rows, now: NOW, site, paymentAnnual: paymentAnnual === null ? null : D(paymentAnnual.toFixed(2)) });
      const naive = naiveElectric(rows, solar, paymentAnnual === null ? null : Number(paymentAnnual.toFixed(2)));
      if (naive.gated) {
        gates += 1;
        expect(real.status, `trial ${trial}`).toBe("gated");
        expect(Object.keys(real).sort()).toEqual(["kind", "reason", "status"]);
        continue;
      }
      expect(real.status, `trial ${trial}`).toBe("estimate");
      const e = real as ElectricEstimate;
      estimates += 1;
      if (naive.method === "usage_paired") paired += 1;
      expect(e.method, `trial ${trial}`).toBe(naive.method);
      for (let m = 0; m < 12; m++) {
        expect(close(e.months[m]!.amount.toNumber(), naive.amt[m]!, 0.02), `trial ${trial} month ${m + 1} amount ${e.months[m]!.amount} vs ${naive.amt[m]}`).toBe(true);
        expect(close(e.months[m]!.low.toNumber(), Math.min(naive.lo[m]!, naive.amt[m]!), 0.02), `trial ${trial} low ${m + 1}`).toBe(true);
        expect(close(e.months[m]!.high.toNumber(), Math.max(naive.hi[m]!, naive.amt[m]!), 0.02), `trial ${trial} high ${m + 1}`).toBe(true);
      }
      expect(e.confidence, `trial ${trial}`).toBe((["low", "medium", "high"] as const)[naive.conf]);
      // the headline is the sum of the rounded months, to the cent
      expect(e.annual.toFixed(2)).toBe(e.months.reduce((a, m) => a.plus(m.amount), D(0)).toFixed(2));
    }
    // the random histories must reach both tiers and the gates
    expect(estimates).toBeGreaterThan(60);
    expect(paired).toBeGreaterThan(10);
    expect(gates).toBeGreaterThan(20);
  });
});

// ── Oil ────────────────────────────────────────────────────────────────────────

function naiveOil(rows: UsageRow[], priceOwner: number | null) {
  const L = NOW_IDX - 1;
  const first = Math.min(...rows.map((r) => idxOf(r.period)));
  const windows: number[][] = [];
  for (let w = 0; w < 3; w++) {
    const start = L - 11 - 12 * w;
    if (start < first) break;
    const vec = new Array<number>(12).fill(0);
    for (const r of rows) {
      const i = idxOf(r.period);
      if (i >= start && i <= L - 12 * w) vec[i % 12]! += r.quantity.toNumber();
    }
    windows.push(vec);
  }
  if (windows.length === 0) return { gated: true as const };
  if (!(windows[0]!.reduce((a, b) => a + b, 0) > 0)) return { gated: true as const };
  let price = priceOwner;
  let derived = false;
  if (price === null) {
    const priced = rows
      .filter((r) => r.cost !== null && r.quantity.greaterThan(0) && NOW_IDX - idxOf(r.period) <= 24)
      .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1))[0];
    if (!priced) return { gated: true as const };
    price = priced.cost!.toNumber() / priced.quantity.toNumber();
    derived = true;
  }
  const g = new Array<number>(12).fill(0);
  for (const w of windows) for (let m = 0; m < 12; m++) g[m]! += w[m]! / windows.length;
  const s = naiveSmooth(g);
  const sw = windows.map(naiveSmooth);
  const amt = s.map((v) => v * price!);
  const lo = amt.map((_, m) => Math.min(...sw.map((v) => v[m]! * price!)));
  const hi = amt.map((_, m) => Math.max(...sw.map((v) => v[m]! * price!)));
  let conf = windows.length - 1;
  if (derived && conf > 1) conf = 1;
  return { gated: false as const, amt, lo, hi, conf, G: g.reduce((a, b) => a + b, 0) };
}

describe("oracle: oil usage model against a naive implementation", () => {
  it("agrees on 300 seeded random synthetic histories", () => {
    const rand = mulberry32(8675);
    let estimates = 0;
    let gates = 0;
    let derivedCount = 0;
    for (let trial = 0; trial < 300; trial++) {
      const startBack = 4 + Math.floor(rand() * 40); // first possible delivery month, back from now
      const rows: UsageRow[] = [];
      const nDel = Math.floor(rand() * 14);
      const withCost = rand() < 0.5;
      for (let d = 0; d < nDel; d++) {
        const i = NOW_IDX - startBack + Math.floor(rand() * (startBack + 1));
        if (i > NOW_IDX) continue;
        const day = 1 + Math.floor(rand() * 28);
        const gal = 40 + Math.floor(rand() * 200);
        const per = 2.5 + rand() * 2;
        const occurredOn = `${periodOfIdx(i)}-${String(day).padStart(2, "0")}`;
        if (occurredOn > "2026-10-10") continue;
        rows.push(mk("oil", periodOfIdx(i), occurredOn, gal, withCost && rand() < 0.7 ? gal * per : null));
      }
      if (rows.length === 0) continue;
      const priceOwner = rand() < 0.5 ? Number((2.8 + rand() * 1.5).toFixed(4)) : null;
      const entries = priceOwner === null ? [] : [{ id: "p", effectiveOn: "2026-01-01", pricePerGal: priceOwner.toFixed(4) }];
      const real = oilUsageEstimate({ rows, entries, now: NOW });
      const naive = naiveOil(rows, priceOwner);
      if (naive.gated) {
        gates += 1;
        expect(real.status, `trial ${trial}`).toBe("gated");
        expect(Object.keys(real).sort()).toEqual(["kind", "reason", "status"]);
        continue;
      }
      expect(real.status, `trial ${trial}`).toBe("estimate");
      const e = real as OilEstimate;
      estimates += 1;
      if (e.priceSource === "delivery") derivedCount += 1;
      for (let m = 0; m < 12; m++) {
        expect(close(e.byMonth![m]!.toNumber(), naive.amt[m]!, 0.02), `trial ${trial} month ${m + 1}`).toBe(true);
        expect(close(e.byMonthRange![m]!.low.toNumber(), naive.lo[m]!, 0.02), `trial ${trial} low ${m + 1}`).toBe(true);
        expect(close(e.byMonthRange![m]!.high.toNumber(), naive.hi[m]!, 0.02), `trial ${trial} high ${m + 1}`).toBe(true);
      }
      expect(e.impliedGallons.toNumber()).toBe(Math.round(naive.G));
      expect(e.confidence, `trial ${trial}`).toBe((["low", "medium", "high"] as const)[naive.conf]);
      expect(e.annual.toFixed(2)).toBe(e.byMonth!.reduce((a, b) => a.plus(b), D(0)).toFixed(2));
    }
    expect(estimates).toBeGreaterThan(40);
    expect(gates).toBeGreaterThan(20);
    expect(derivedCount).toBeGreaterThan(3);
  });
});

// ── Firewood ───────────────────────────────────────────────────────────────────

function seasonNaive(iso: string): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (m >= 7) return y;
  return y - 1;
}

function naiveFirewood(rows: UsageRow[]) {
  const cur = 2026; // October 2026 is in the season starting July 2026
  const first = Math.min(...rows.map((r) => seasonNaive(r.occurredOn)));
  const seasons: Array<{ s: number; counted: boolean; vec: number[] }> = [];
  for (let s = first; s <= cur - 1; s++) {
    const vec = new Array<number>(12).fill(0);
    let counted = true;
    for (const r of rows) {
      if (seasonNaive(r.occurredOn) !== s) continue;
      if (r.cost === null) counted = false;
      else vec[Number(r.period.slice(5, 7)) - 1]! += r.cost.toNumber();
    }
    seasons.push({ s, counted, vec });
  }
  const counted = seasons.filter((x) => x.counted);
  if (counted.length < 2) return { gated: true as const };
  const used = counted.slice(Math.max(0, counted.length - 3));
  const g = new Array<number>(12).fill(0);
  for (const x of used) for (let m = 0; m < 12; m++) g[m]! += x.vec[m]! / used.length;
  const amt = naiveSmooth(g);
  const sm = used.map((x) => naiveSmooth(x.vec));
  return {
    gated: false as const,
    amt,
    lo: amt.map((_, m) => Math.min(...sm.map((v) => v[m]!))),
    hi: amt.map((_, m) => Math.max(...sm.map((v) => v[m]!))),
    conf: used.length >= 3 ? 1 : 0,
  };
}

describe("oracle: firewood usage model against a naive implementation", () => {
  it("agrees on 300 seeded random synthetic histories", () => {
    const rand = mulberry32(31337);
    let estimates = 0;
    let gates = 0;
    for (let trial = 0; trial < 300; trial++) {
      const rows: UsageRow[] = [];
      const n = Math.floor(rand() * 12);
      for (let k = 0; k < n; k++) {
        const i = NOW_IDX - 1 - Math.floor(rand() * 60);
        const day = 1 + Math.floor(rand() * 28);
        const occurredOn = `${periodOfIdx(i)}-${String(day).padStart(2, "0")}`;
        // sometimes in the unfinished current season (Jul-Sep 2026)
        rows.push(mk("firewood", periodOfIdx(i), occurredOn, 1 + Math.floor(rand() * 4), rand() < 0.85 ? 100 + Math.floor(rand() * 600) : null));
      }
      if (rows.length === 0) continue;
      const real = firewoodUsageEstimate({ rows, now: NOW });
      const naive = naiveFirewood(rows);
      if (naive.gated) {
        gates += 1;
        expect(real.status, `trial ${trial}`).toBe("gated");
        expect(Object.keys(real).sort()).toEqual(["kind", "reason", "status"]);
        continue;
      }
      expect(real.status, `trial ${trial}`).toBe("estimate");
      const e = real as FirewoodEstimate;
      estimates += 1;
      for (let m = 0; m < 12; m++) {
        expect(close(e.byMonth[m]!.toNumber(), naive.amt[m]!, 0.02), `trial ${trial} month ${m + 1}`).toBe(true);
        expect(close(e.byMonthRange[m]!.low.toNumber(), naive.lo[m]!, 0.02), `trial ${trial} low ${m + 1}`).toBe(true);
        expect(close(e.byMonthRange[m]!.high.toNumber(), naive.hi[m]!, 0.02), `trial ${trial} high ${m + 1}`).toBe(true);
      }
      expect(e.confidence, `trial ${trial}`).toBe((["low", "medium"] as const)[naive.conf]);
      expect(e.annual.toFixed(2)).toBe(e.byMonth.reduce((a, b) => a.plus(b), D(0)).toFixed(2));
    }
    expect(estimates).toBeGreaterThan(30);
    expect(gates).toBeGreaterThan(20);
  });
});
