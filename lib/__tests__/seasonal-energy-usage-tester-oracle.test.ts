// TESTER (utility-usage-upload): independent oracles for the three usage models, written from the PLAN (not from the
// Coder's code or tests), in exact BigInt rationals (no Decimal, no floats) and compared to lib/seasonal-energy-usage.ts to
// the cent over seeded random synthetic worlds. Branch counters prove every gate / tier is actually exercised.
// All numbers are synthetic.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { electricUsageEstimate, firewoodUsageEstimate, oilUsageEstimate, smooth3, type UsageRow } from "@/lib/seasonal-energy-usage";
import type { OilPriceEntry } from "@/lib/seasonal-energy-prices";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const NOW_P = "2026-10";

// ── exact rationals ──
interface Q { n: bigint; d: bigint }
const Z = BigInt(0);
const ONE = BigInt(1);
const gcd = (a: bigint, b: bigint): bigint => { while (b !== Z) [a, b] = [b, a % b]; return a < Z ? -a : a; };
function q(n: bigint, d: bigint = ONE): Q {
  if (d < Z) { n = -n; d = -d; }
  const g = gcd(n, d);
  return g > ONE ? { n: n / g, d: d / g } : { n, d };
}
const qs = (s: string): Q => {
  const neg = s.startsWith("-");
  const t = neg ? s.slice(1) : s;
  const [w, f = ""] = t.split(".");
  const n = BigInt(w + f);
  return q(neg ? -n : n, BigInt(10) ** BigInt(f.length));
};
const qi = (x: number): Q => q(BigInt(x));
const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const cmp = (a: Q, b: Q): number => { const x = a.n * b.d - b.n * a.d; return x < Z ? -1 : x > Z ? 1 : 0; };
const sumQ = (xs: Q[]): Q => xs.reduce(add, qi(0));
const minQ = (xs: Q[]): Q => xs.reduce((a, b) => (cmp(b, a) < 0 ? b : a));
const maxQ = (xs: Q[]): Q => xs.reduce((a, b) => (cmp(b, a) > 0 ? b : a));
/** Round to cents, half away from zero, as a 2-decimal string. */
function cents(a: Q): string {
  const num = a.n * BigInt(100);
  const neg = num < Z;
  const abs = neg ? -num : num;
  const r = (BigInt(2) * abs + a.d) / (BigInt(2) * a.d);
  const s = r.toString().padStart(3, "0");
  const out = `${s.slice(0, -2)}.${s.slice(-2)}`;
  return neg && r !== Z ? `-${out}` : out;
}
const toDec = (a: Q) => new Decimal(a.n.toString()).div(new Decimal(a.d.toString()));
const smoothQ = (v: Q[]): Q[] => v.map((_, m) => div(add(add(v[(m + 11) % 12]!, v[m]!), v[(m + 1) % 12]!), qi(3)));

// ── PRNG ──
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const idxOf = (p: string) => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7)) - 1;
const perOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const NOW_IDX = idxOf(NOW_P);
let uid = 0;

function urow(kind: UsageRow["kind"], period: string, qty: string, cost: string | null, occurredOn: string, unit: string): UsageRow {
  return { id: `r${++uid}`, kind, period, occurredOn, quantity: new Decimal(qty), unit, cost: cost === null ? null : new Decimal(cost), note: null };
}

// ═══════════════════ ELECTRIC ═══════════════════

interface ERow { period: string; kwh: string; cost: string | null }

function electricOracle(rows: ERow[], solar: string | null, paymentAnnual: string | null) {
  const kept = new Map<string, ERow>();
  for (const r of rows) {
    if (r.period >= NOW_P) continue;
    if (solar !== null && r.period < solar) continue;
    kept.set(r.period, r);
  }
  const rs = [...kept.values()].sort((a, b) => (a.period < b.period ? -1 : 1));
  if (rs.length === 0) return { gated: "none" as const };
  for (let m = 1; m <= 12; m++) if (!rs.some((r) => Number(r.period.slice(5)) === m)) return { gated: "missing" as const };
  if (NOW_IDX - idxOf(rs[rs.length - 1]!.period) > 24) return { gated: "age" as const };
  const K: Q[] = [], Kmin: Q[] = [], Kmax: Q[] = [], years: number[] = [];
  for (let m = 1; m <= 12; m++) {
    const mine = rs.filter((r) => Number(r.period.slice(5)) === m).sort((a, b) => (a.period < b.period ? 1 : -1)).slice(0, 3).map((r) => qs(r.kwh));
    K.push(div(sumQ(mine), qi(mine.length)));
    Kmin.push(minQ(mine));
    Kmax.push(maxQ(mine));
    years.push(mine.length);
  }
  const nMin = Math.min(...years);
  const paired = rs.filter((r) => r.cost !== null);
  const pairedMonths = new Set(paired.map((r) => r.period.slice(5))).size;
  let fit: { a: Q; b: Q; r2: Q; sse: Q; n: number } | null = null;
  if (paired.length >= 12 && pairedMonths >= 8) {
    const xs = paired.map((r) => qs(r.kwh));
    const ys = paired.map((r) => qs(r.cost!));
    const n = xs.length;
    const sx = sumQ(xs), sy = sumQ(ys);
    const sxx = sumQ(xs.map((x) => mul(x, x)));
    const sxy = sumQ(xs.map((x, i) => mul(x, ys[i]!)));
    const den = sub(mul(qi(n), sxx), mul(sx, sx));
    if (den.n !== Z) {
      const b = div(sub(mul(qi(n), sxy), mul(sx, sy)), den);
      const a = div(sub(sy, mul(b, sx)), qi(n));
      const ybar = div(sy, qi(n));
      const sse = sumQ(xs.map((x, i) => { const e = sub(sub(ys[i]!, a), mul(b, x)); return mul(e, e); }));
      const sst = sumQ(ys.map((y) => { const e = sub(y, ybar); return mul(e, e); }));
      if (sst.n !== Z) {
        const r2 = sub(qi(1), div(sse, sst));
        if (cmp(b, qi(0)) > 0 && cmp(r2, q(BigInt(1), BigInt(2))) >= 0) fit = { a, b, r2, sse, n };
      }
    }
  }
  if (fit) {
    const se = new Decimal(0).plus(toDec(div(fit.sse, qi(fit.n - 2)))).sqrt();
    const amounts = K.map((k) => add(fit!.a, mul(fit!.b, k)));
    const lows = Kmin.map((k) => add(fit!.a, mul(fit!.b, k)));
    const highs = Kmax.map((k) => add(fit!.a, mul(fit!.b, k)));
    let conf: "low" | "medium" | "high" = nMin >= 3 ? "high" : nMin === 2 ? "medium" : "low";
    if (cmp(fit.r2, q(BigInt(4), BigInt(5))) < 0) conf = conf === "high" ? "medium" : "low";
    return { method: "usage_paired" as const, amounts, lows, highs, years, se, conf };
  }
  if (paymentAnnual === null) return { gated: "dollars" as const };
  const total = sumQ(K);
  if (cmp(total, qi(0)) <= 0) return { gated: "zero" as const };
  const pa = qs(paymentAnnual);
  return {
    method: "usage_shape" as const,
    amounts: K.map((k) => div(mul(pa, k), total)),
    lows: Kmin.map((k) => div(mul(pa, k), total)),
    highs: Kmax.map((k) => div(mul(pa, k), total)),
    years,
    se: null,
    conf: (nMin >= 2 ? "medium" : "low") as "low" | "medium" | "high",
  };
}

describe("TESTER oracle: electric usage model (exact rationals vs the module)", () => {
  it("2500 seeded worlds agree on gate, method, every month amount/low/high to the cent, annual and confidence", () => {
    const r = rng(20261010);
    const count: Record<string, number> = {};
    const bump = (k: string) => (count[k] = (count[k] ?? 0) + 1);
    for (let w = 0; w < 2500; w++) {
      const solar = r() < 0.3 ? perOf(NOW_IDX - ri(r, 14, 40)) : null;
      const years = ri(r, 1, 4);
      const endIdx = NOW_IDX - 1 - (r() < 0.12 ? ri(r, 1, 30) : 0);
      const startIdx = endIdx - years * 12 + 1;
      const rows: ERow[] = [];
      const costed = r() < 0.55;
      const fixed = ri(r, 0, 30);
      const slope = r() < 0.15 ? -0.05 : 0.08 + r() * 0.1;
      const noise = r() < 0.3 ? 80 : 4;
      const hole = r() < 0.2 ? ri(r, 1, 12) : 0;
      for (let i = startIdx; i <= endIdx; i++) {
        if (hole && Number(perOf(i).slice(5)) === hole && r() < 0.95) continue;
        if (r() < 0.04) continue;
        const kwh = (ri(r, 3000, 14000) / 10).toFixed(1);
        let cost: string | null = null;
        if (costed && r() < 0.9) cost = (fixed + slope * Number(kwh) + (r() - 0.5) * noise).toFixed(2);
        rows.push({ period: perOf(i), kwh, cost });
      }
      if (rows.length === 0) continue;
      const payAnnual = r() < 0.6 ? (ri(r, 60000, 260000) / 100).toFixed(2) : null;
      const want = electricOracle(rows, solar, payAnnual);
      const got = electricUsageEstimate({
        rows: rows.map((x) => urow("electric", x.period, x.kwh, x.cost, `${x.period}-01`, "kwh")),
        now: NOW,
        site: solar === null ? null : { slug: "x", solarLiveFrom: solar, oilFromEntitySlugs: [], rentalSince: null, serviceCharges: [], statedOn: "2026-10-09" },
        paymentAnnual: payAnnual === null ? null : new Decimal(payAnnual),
      });
      if ("gated" in want) {
        bump(`gate:${want.gated}`);
        expect(got.status, `world ${w} should be gated (${want.gated})`).toBe("gated");
        expect(Object.keys(got).sort()).toEqual(["kind", "reason", "status"]);
        continue;
      }
      expect(got.status, `world ${w} should estimate`).toBe("estimate");
      if (got.status !== "estimate") continue;
      bump(want.method);
      expect(got.method).toBe(want.method);
      expect(got.confidence, `world ${w} confidence`).toBe(want.conf);
      let annual = qi(0);
      got.months.forEach((m, i) => {
        const amt = cents(want.amounts[i]!);
        expect(m.amount.toFixed(2), `world ${w} month ${i + 1}`).toBe(amt);
        annual = add(annual, qs(amt));
        let lo = want.lows[i]!;
        let hi = want.highs[i]!;
        if (want.method === "usage_paired" && want.years[i] === 1 && want.se) {
          // one-year month: widened by one standard error (sqrt in Decimal, compared within a cent)
          const seQ = qs(want.se.toFixed(6));
          const l2 = sub(want.amounts[i]!, seQ);
          const h2 = add(want.amounts[i]!, seQ);
          if (cmp(l2, lo) < 0) lo = l2;
          if (cmp(h2, hi) > 0) hi = h2;
          expect(Math.abs(m.low.minus(cents(lo)).toNumber()), `world ${w} low ${i}`).toBeLessThanOrEqual(0.011);
          expect(Math.abs(m.high.minus(cents(hi)).toNumber()), `world ${w} high ${i}`).toBeLessThanOrEqual(0.011);
        } else {
          const loC = cmp(lo, want.amounts[i]!) < 0 ? lo : want.amounts[i]!;
          const hiC = cmp(hi, want.amounts[i]!) > 0 ? hi : want.amounts[i]!;
          expect(m.low.toFixed(2), `world ${w} low ${i}`).toBe(cents(loC));
          expect(m.high.toFixed(2), `world ${w} high ${i}`).toBe(cents(hiC));
        }
        expect(m.low.lessThanOrEqualTo(m.amount) && m.high.greaterThanOrEqualTo(m.amount)).toBe(true);
      });
      expect(got.annual.toFixed(2), `world ${w} annual = sum of 12 rounded months`).toBe(cents(annual));
    }
    // every branch is exercised
    for (const k of ["usage_paired", "usage_shape", "gate:missing", "gate:dollars"]) expect(count[k] ?? 0, k).toBeGreaterThan(40);
    expect(count["gate:age"] ?? 0).toBeGreaterThan(20);
  });

  it("Tier B equals paymentAnnual * K / sum(K) exactly (hand fixture) and sums to the payments annual within 6 cents", () => {
    const K = [900, 850, 700, 600, 520, 500, 540, 560, 530, 600, 720, 860];
    const rows = K.map((k, i) => urow("electric", perOf(NOW_IDX - 12 + i), String(k), null, `${perOf(NOW_IDX - 12 + i)}-01`, "kwh"));
    const e = rows.map((x) => ({ period: x.period, kwh: x.quantity.toString(), cost: null as string | null }));
    const want = electricOracle(e, null, "1800.00");
    if ("gated" in want) throw new Error("fixture gated");
    const got = electricUsageEstimate({ rows, now: NOW, site: null, paymentAnnual: new Decimal("1800.00") });
    if (got.status !== "estimate") throw new Error("expected estimate");
    got.months.forEach((m, i) => expect(m.amount.toFixed(2)).toBe(cents(want.amounts[i]!)));
    expect(got.method).toBe("usage_shape");
    expect(Math.abs(got.annual.minus(1800).toNumber())).toBeLessThanOrEqual(0.06);
  });

  it("a negative-slope fit and an R2 < 0.5 fit both fall to Tier B; an exactly-flat cost column (SST = 0) cannot divide by zero", () => {
    const base = (costOf: (k: number, i: number) => string) =>
      Array.from({ length: 12 }, (_, i) => {
        const p = perOf(NOW_IDX - 12 + i);
        const k = 400 + i * 30;
        return urow("electric", p, String(k), costOf(k, i), `${p}-01`, "kwh");
      });
    const pay = new Decimal("1500");
    const neg = electricUsageEstimate({ rows: base((k) => (300 - k * 0.1).toFixed(2)), now: NOW, site: null, paymentAnnual: pay });
    expect(neg.status === "estimate" && neg.method).toBe("usage_shape");
    const flat = electricUsageEstimate({ rows: base(() => "100.00"), now: NOW, site: null, paymentAnnual: pay });
    expect(flat.status === "estimate" && flat.method).toBe("usage_shape");
    const noisy = electricUsageEstimate({ rows: base((_k, i) => (i % 2 === 0 ? "10.00" : "200.00")), now: NOW, site: null, paymentAnnual: pay });
    expect(noisy.status === "estimate" && noisy.method).toBe("usage_shape");
    const gated = electricUsageEstimate({ rows: base((k) => (300 - k * 0.1).toFixed(2)), now: NOW, site: null, paymentAnnual: null });
    expect(gated.status).toBe("gated");
    expect(Object.keys(gated).sort()).toEqual(["kind", "reason", "status"]);
  });

  it("exact 0.5 R2 passes and 0.8 is 'not stepped down' boundary: slope-only fixtures with a constructed R2", () => {
    // y = 2x exactly -> R2 = 1; high confidence only with 3 years per month
    const mk = (years: number) =>
      Array.from({ length: years * 12 }, (_, i) => {
        const p = perOf(NOW_IDX - years * 12 + i);
        const k = 300 + (i % 12) * 20;
        return urow("electric", p, String(k), (k * 2).toFixed(2), `${p}-01`, "kwh");
      });
    const three = electricUsageEstimate({ rows: mk(3), now: NOW, site: null, paymentAnnual: null });
    const two = electricUsageEstimate({ rows: mk(2), now: NOW, site: null, paymentAnnual: null });
    const one = electricUsageEstimate({ rows: mk(1), now: NOW, site: null, paymentAnnual: null });
    expect(three.status === "estimate" && three.confidence).toBe("high");
    expect(two.status === "estimate" && two.confidence).toBe("medium");
    expect(one.status === "estimate" && one.confidence).toBe("low");
  });
});

// ═══════════════════ OIL ═══════════════════

interface ODel { date: string; gal: string; cost: string | null }

function oilOracle(dels: ODel[], prices: OilPriceEntry[]) {
  if (dels.length === 0) return { gated: "none" as const };
  const L = NOW_IDX - 1;
  const first = Math.min(...dels.map((d) => idxOf(d.date.slice(0, 7))));
  const windows: Q[][] = [];
  for (let w = 0; w < 3; w++) {
    const start = L - 11 - 12 * w;
    if (start < first) break;
    const vec: Q[] = Array.from({ length: 12 }, () => qi(0));
    for (let i = start; i <= L - 12 * w; i++) {
      for (const d of dels) if (idxOf(d.date.slice(0, 7)) === i) vec[i % 12] = add(vec[i % 12]!, qs(d.gal));
    }
    windows.push(vec);
  }
  if (windows.length === 0) return { gated: "window" as const };
  if (cmp(sumQ(windows[0]!), qi(0)) <= 0) return { gated: "empty" as const };
  const k = windows.length;
  const g = Array.from({ length: 12 }, (_, m) => div(sumQ(windows.map((w) => w[m]!)), qi(k)));
  const s = smoothQ(g);
  const day = "2026-10-10";
  const act = prices.filter((p) => p.effectiveOn <= day).sort((a, b) => (a.effectiveOn < b.effectiveOn ? -1 : 1));
  let P: Q;
  let source: "owner" | "delivery";
  if (act.length > 0) {
    P = qs(act[act.length - 1]!.pricePerGal);
    source = "owner";
  } else {
    const priced = dels
      .filter((d) => d.cost !== null && NOW_IDX - idxOf(d.date.slice(0, 7)) <= 24)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (!priced) return { gated: "price" as const };
    P = div(qs(priced.cost!), qs(priced.gal));
    source = "delivery";
  }
  const byMonth = s.map((x) => cents(mul(x, P)));
  const ranges = Array.from({ length: 12 }, (_, m) => {
    const vals = windows.map((w) => mul(smoothQ(w)[m]!, P));
    return { low: cents(minQ(vals)), high: cents(maxQ(vals)) };
  });
  let conf: "low" | "medium" | "high" = k >= 3 ? "high" : k === 2 ? "medium" : "low";
  if (source === "delivery" && conf === "high") conf = "medium";
  const annual = sumQ(byMonth.map(qs));
  return { byMonth, ranges, conf, annual: cents(annual), G: sumQ(g), k, source };
}

describe("TESTER oracle: oil usage model (windows, smoothing, price precedence)", () => {
  it("2500 seeded worlds agree to the cent", () => {
    const r = rng(77);
    let oneCent = 0;
    let months = 0;
    const count: Record<string, number> = {};
    const bump = (k: string) => (count[k] = (count[k] ?? 0) + 1);
    for (let w = 0; w < 2500; w++) {
      const span = ri(r, 3, 66);
      const firstIdx = NOW_IDX - span;
      const dels: ODel[] = [];
      const priceCosts = r() < 0.5;
      for (let i = firstIdx; i <= NOW_IDX; i++) {
        if (r() < 0.25) {
          const n = r() < 0.15 ? 2 : 1;
          for (let j = 0; j < n; j++) {
            const day = i === NOW_IDX ? ri(r, 1, 10) : ri(r, 1, 28);
            const gal = (ri(r, 500, 3000) / 10).toFixed(1);
            const cost = priceCosts && r() < 0.8 ? (Number(gal) * (2.5 + r() * 2)).toFixed(2) : null;
            dels.push({ date: `${perOf(i)}-${String(day).padStart(2, "0")}`, gal, cost });
          }
        }
      }
      if (r() < 0.05) dels.length = 0;
      const prices: OilPriceEntry[] = r() < 0.4 ? [{ id: "p1", effectiveOn: perOf(NOW_IDX - ri(r, 1, 10)) + "-01", pricePerGal: (3 + r() * 2).toFixed(4) }] : [];
      if (prices.length > 0 && r() < 0.5) prices.push({ id: "p0", effectiveOn: perOf(NOW_IDX - ri(r, 11, 20)) + "-01", pricePerGal: (2 + r()).toFixed(4) });
      if (prices.length > 0 && r() < 0.15) prices.push({ id: "pt", effectiveOn: "2026-10-10", pricePerGal: (5 + r()).toFixed(4) }); // effective today
      if (r() < 0.1) prices.push({ id: "p2", effectiveOn: "2026-12-01", pricePerGal: "9.9900" }); // future entry must be ignored
      const want = oilOracle(dels, prices);
      const rows = dels.map((d) => urow("oil", d.date.slice(0, 7), d.gal, d.cost, d.date, "gal"));
      const got = oilUsageEstimate({ rows, entries: prices, now: NOW });
      if ("gated" in want) {
        bump(`gate:${want.gated}`);
        expect(got.status, `world ${w}`).toBe("gated");
        expect(Object.keys(got).sort()).toEqual(["kind", "reason", "status"]);
        continue;
      }
      expect(got.status, `world ${w}`).toBe("estimate");
      if (got.status !== "estimate") continue;
      bump(`k${want.k}:${want.source}`);
      // The module divides by 3 at 20 significant digits BEFORE multiplying by the price, so a value that is exactly a
      // half-cent in exact arithmetic can land one cent lower. Accept at most 1 cent per month and count how often it happens.
      got.byMonth!.forEach((x, i) => {
        const d = Math.abs(x.minus(want.byMonth[i]!).toNumber());
        expect(d, `world ${w} month ${i}`).toBeLessThanOrEqual(0.0101);
        if (d > 0) oneCent++;
        months++;
      });
      expect(got.confidence, `world ${w}`).toBe(want.conf);
      expect(got.monthly.toFixed(2), `world ${w}: monthly = annual / 12`).toBe(cents(div(qs(got.annual.toFixed(2)), qi(12))));
      expect(got.annual.toFixed(2), `world ${w}: annual is the sum of the 12 rounded months`).toBe(got.byMonth!.reduce((a, b) => a.plus(b), new Decimal(0)).toFixed(2));
      expect(Math.abs(got.annual.minus(want.annual).toNumber()), `world ${w}`).toBeLessThanOrEqual(0.12);
      got.byMonthRange!.forEach((x, i) => {
        expect(Math.abs(x.low.minus(want.ranges[i]!.low).toNumber())).toBeLessThanOrEqual(0.0101);
        expect(Math.abs(x.high.minus(want.ranges[i]!.high).toNumber())).toBeLessThanOrEqual(0.0101);
      });
      expect(got.priceSource).toBe(want.source);
      // (G is a sum of thirds at 20 significant digits, so an exact .5 can display one gallon lower: allow 1)
      expect(Math.abs(got.impliedGallons.minus(toDec(want.G).toDecimalPlaces(0)).toNumber()), `world ${w}`).toBeLessThanOrEqual(1);
      if (want.k === 1) for (const x of got.byMonthRange!) expect(x.low.equals(x.high)).toBe(true);
    }
    expect(oneCent / months, "half-cent boundary cases should be rare").toBeLessThan(0.01);
    expect(count["k1:owner"] ?? 0).toBeGreaterThan(30);
    expect(count["k2:owner"] ?? 0).toBeGreaterThan(30);
    expect(count["k3:owner"] ?? 0).toBeGreaterThan(30);
    expect(count["k3:delivery"] ?? 0).toBeGreaterThan(30);
    expect(count["gate:price"] ?? 0).toBeGreaterThan(30);
    expect(count["gate:window"] ?? 0).toBeGreaterThan(30);
    expect(count["gate:empty"] ?? 0).toBeGreaterThan(5);
  });

  it("smooth3 is circular and sum-preserving; a lone December delivery spreads over Nov, Dec, Jan", () => {
    const v = Array.from({ length: 12 }, () => new Decimal(0));
    v[11] = new Decimal(300);
    const s = smooth3(v);
    expect(s.map((x) => x.toFixed(0))).toEqual(["100", "0", "0", "0", "0", "0", "0", "0", "0", "0", "100", "100"]);
    expect(s.reduce((a, b) => a.plus(b), new Decimal(0)).toFixed(6)).toBe("300.000000");
  });

  it("window boundary: first delivery in exactly the window's first month makes one window; one month later makes none", () => {
    const prices: OilPriceEntry[] = [{ id: "p", effectiveOn: "2026-01-01", pricePerGal: "4.0000" }];
    // now = 2026-10 -> last complete month 2026-09 -> window 2025-10..2026-09
    const ok1 = oilUsageEstimate({ rows: [urow("oil", "2025-10", "100", null, "2025-10-20", "gal")], entries: prices, now: NOW });
    expect(ok1.status).toBe("estimate");
    const no = oilUsageEstimate({ rows: [urow("oil", "2025-11", "100", null, "2025-11-20", "gal")], entries: prices, now: NOW });
    expect(no.status).toBe("gated");
    // now in January: window = Jan..Dec of last year
    const jan = new Date("2027-01-15T12:00:00.000Z");
    const j = oilUsageEstimate({ rows: [urow("oil", "2026-01", "100", null, "2026-01-05", "gal")], entries: prices, now: jan });
    expect(j.status).toBe("estimate");
    const j2 = oilUsageEstimate({ rows: [urow("oil", "2026-02", "100", null, "2026-02-05", "gal")], entries: prices, now: jan });
    expect(j2.status).toBe("gated");
  });

  it("a delivery in the unfinished current month never enters a window", () => {
    const prices: OilPriceEntry[] = [{ id: "p", effectiveOn: "2026-01-01", pricePerGal: "4.0000" }];
    const rows = [urow("oil", "2025-10", "100", null, "2025-10-20", "gal"), urow("oil", "2026-10", "500", null, "2026-10-05", "gal")];
    const e = oilUsageEstimate({ rows, entries: prices, now: NOW });
    expect(e.status === "estimate" && e.impliedGallons.toFixed(0)).toBe("100");
  });
});

// ═══════════════════ FIREWOOD ═══════════════════

interface FPur { date: string; qty: string; cost: string | null }
const seasonOf = (date: string) => (Number(date.slice(5, 7)) >= 7 ? Number(date.slice(0, 4)) : Number(date.slice(0, 4)) - 1);

function woodOracle(ps: FPur[]) {
  if (ps.length === 0) return { gated: "none" as const };
  const cur = seasonOf("2026-10-10"); // 2026
  const first = Math.min(...ps.map((p) => seasonOf(p.date)));
  const last = cur - 1;
  if (last < first) return { gated: "unfinished" as const };
  const seasons: Array<{ s: number; counted: boolean }> = [];
  for (let s = first; s <= last; s++) seasons.push({ s, counted: ps.filter((p) => seasonOf(p.date) === s).every((p) => p.cost !== null) });
  const counted = seasons.filter((x) => x.counted);
  if (counted.length < 2) return { gated: "few" as const };
  const used = counted.slice(-3);
  const vecs = used.map((u) => {
    const v: Q[] = Array.from({ length: 12 }, () => qi(0));
    for (const p of ps) if (seasonOf(p.date) === u.s) v[Number(p.date.slice(5, 7)) - 1] = add(v[Number(p.date.slice(5, 7)) - 1]!, qs(p.cost!));
    return v;
  });
  const g = Array.from({ length: 12 }, (_, m) => div(sumQ(vecs.map((v) => v[m]!)), qi(used.length)));
  const sm = smoothQ(g);
  const byMonth = sm.map(cents);
  const ranges = Array.from({ length: 12 }, (_, m) => {
    const vals = vecs.map((v) => smoothQ(v)[m]!);
    return { low: cents(minQ(vals)), high: cents(maxQ(vals)) };
  });
  return { byMonth, ranges, conf: used.length >= 3 ? ("medium" as const) : ("low" as const), annual: cents(sumQ(byMonth.map(qs))), n: used.length };
}

describe("TESTER oracle: firewood usage model (July-June seasons, skipped seasons, smoothing)", () => {
  it("2500 seeded worlds agree to the cent", () => {
    const r = rng(404);
    const count: Record<string, number> = {};
    const bump = (k: string) => (count[k] = (count[k] ?? 0) + 1);
    for (let w = 0; w < 2500; w++) {
      const firstSeason = 2026 - ri(r, 1, 6);
      const ps: FPur[] = [];
      for (let s = firstSeason; s <= 2026; s++) {
        const buys = r() < 0.15 ? 0 : ri(r, 1, 3);
        const missCost = r() < 0.15;
        for (let b = 0; b < buys; b++) {
          const mi = ri(r, 0, 11);
          const month = ((mi + 6) % 12) + 1; // July..June order
          const year = month >= 7 ? s : s + 1;
          const day = ri(r, 1, 28);
          const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          if (date > "2026-10-10") continue;
          ps.push({ date, qty: (ri(r, 2, 80) / 4).toFixed(2).replace(/0$/, ""), cost: missCost && b === 0 ? null : (ri(r, 20000, 90000) / 100).toFixed(2) });
        }
      }
      const want = woodOracle(ps);
      const got = firewoodUsageEstimate({ rows: ps.map((p) => urow("firewood", p.date.slice(0, 7), p.qty, p.cost, p.date, "cord")), now: NOW });
      if ("gated" in want) {
        bump(`gate:${want.gated}`);
        expect(got.status, `world ${w}`).toBe("gated");
        expect(Object.keys(got).sort()).toEqual(["kind", "reason", "status"]);
        continue;
      }
      expect(got.status, `world ${w}`).toBe("estimate");
      if (got.status !== "estimate") continue;
      bump(`n${want.n}`);
      expect(got.byMonth.map((x) => x.toFixed(2)), `world ${w}`).toEqual(want.byMonth);
      expect(got.byMonthRange.map((x) => ({ low: x.low.toFixed(2), high: x.high.toFixed(2) })), `world ${w}`).toEqual(want.ranges);
      expect(got.confidence).toBe(want.conf);
      expect(got.annual.toFixed(2)).toBe(want.annual);
      expect(got.monthly.toFixed(2), `world ${w}: monthly = annual / 12`).toBe(cents(div(qs(want.annual), qi(12))));
    }
    expect(count["n2"] ?? 0).toBeGreaterThan(40);
    expect(count["n3"] ?? 0).toBeGreaterThan(40);
    expect(count["gate:few"] ?? 0).toBeGreaterThan(40);
  });

  it("season boundary: June 30 is the old season, July 1 the new one; the unfinished current season never counts", () => {
    const mk = (date: string, cost: string) => urow("firewood", date.slice(0, 7), "2", cost, date, "cord");
    // seasons 2023-24, 2024-25 complete; a purchase on 2025-06-30 belongs to 2024-25, one on 2025-07-01 to 2025-26 (complete as now is Oct 2026)
    const rows = [mk("2023-09-01", "500.00"), mk("2024-10-01", "600.00"), mk("2025-06-30", "100.00")];
    const e = firewoodUsageEstimate({ rows, now: NOW });
    expect(e.status).toBe("estimate");
    if (e.status !== "estimate") return;
    // seasons 2023, 2024, 2025 are complete; 2025 has no purchase (counts as zero) -> 3 seasons
    expect(e.seasons.map((s) => s.label)).toEqual(["2023-24", "2024-25", "2025-26"]);
    expect(e.seasons[1]!.cost.toFixed(2)).toBe("700.00");
    const e2 = firewoodUsageEstimate({ rows: [mk("2023-09-01", "500.00"), mk("2026-09-01", "600.00")], now: NOW });
    expect(e2.status).toBe("estimate"); // 2023-24, 2024-25, 2025-26 complete (2 are zero seasons, all counted)
  });
});
