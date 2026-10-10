// TESTER (carry-forward-seasonal-energy, step 2): independent oracles for the seasonal model. The oracle below is written
// from the plan / owner answers in integer cents and BigInt rationals (not from the Coder's code) and compared with
// lib/seasonal-energy.ts on random worlds. Also pins: a gated result carries no number, entity separation, site facts.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  ENERGY_SITE_FACTS,
  buildSiteEnergy,
  electricEstimate,
  firewoodFacts,
  firewoodResult,
  leaveOneOut,
  observedMonths,
  oilEstimate,
  oilFacts,
  selectSitePayments,
  type EnergyEntityRef,
  type EnergyPayment,
  type EnergySiteFacts,
  type RawEnergyTx,
  type SeasonalLineRef,
} from "@/lib/seasonal-energy";
import { type OilPriceEntry } from "@/lib/seasonal-energy-prices";

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
const ri = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const DAY = 86_400_000;

// ── Independent oracle: electric (BigInt rationals, cents) ──────────────────────
const B0 = BigInt(0);
const B1 = BigInt(1);
const B2 = BigInt(2);
type Rat = { n: bigint; d: bigint };
const rat = (n: bigint, d: bigint = B1): Rat => (d < B0 ? { n: -n, d: -d } : { n, d });
const addR = (a: Rat, b: Rat): Rat => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const divR = (a: Rat, b: Rat): Rat => rat(a.n * b.d, a.d * b.n);
function roundCents(a: Rat): bigint {
  // round half away from zero (Decimal.js default ROUND_HALF_UP)
  const neg = a.n < B0;
  const n = neg ? -a.n : a.n;
  const q = (B2 * n + a.d) / (B2 * a.d);
  return neg ? -q : q;
}
const heat = (m: number) => m === 11 || m === 12 || m <= 3;

interface OPay {
  date: Date;
  cost: number; // cents out (positive = money paid, negative = refund / credit)
}
function oracleElectric(pays: OPay[], now: Date, solarFrom: string | null) {
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const byP = new Map<string, { cost: bigint; newest: Date }>();
  for (const p of pays) {
    const idx = p.date.getUTCFullYear() * 12 + p.date.getUTCMonth();
    if (idx > nowIdx || nowIdx - idx >= 36) continue;
    const per = p.date.toISOString().slice(0, 7);
    if (solarFrom && per < solarFrom) continue;
    const cur = byP.get(per) ?? { cost: B0, newest: p.date };
    cur.cost += BigInt(p.cost);
    if (p.date > cur.newest) cur.newest = p.date;
    byP.set(per, cur);
  }
  const obs = [...byP.entries()].map(([per, v]) => ({ per, m: Number(per.slice(5)), cost: v.cost, newest: v.newest }));
  if (obs.length < 6) return { gated: true as const };
  const H = obs.filter((o) => heat(o.m));
  const O = obs.filter((o) => !heat(o.m));
  if (H.length < 2 || O.length < 2) return { gated: true as const };
  const newest = obs.reduce((a, o) => (o.newest > a ? o.newest : a), obs[0]!.newest);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const nd = Date.UTC(newest.getUTCFullYear(), newest.getUTCMonth(), newest.getUTCDate());
  if (Math.floor((today - nd) / DAY) > 90) return { gated: true as const };
  const sumC = (l: typeof obs) => l.reduce((a, o) => a + o.cost, B0);
  const months: { amount: bigint; low: bigint; high: bigint; own: number }[] = [];
  for (let m = 1; m <= 12; m++) {
    const grp = heat(m) ? H : O;
    const own = obs.filter((o) => o.m === m);
    const gMean = rat(sumC(grp), BigInt(grp.length));
    const est = divR(addR(rat(sumC(own)), gMean), rat(BigInt(own.length + 1)));
    const costs = grp.map((o) => o.cost);
    const lo = costs.reduce((a, b) => (b < a ? b : a));
    const hi = costs.reduce((a, b) => (b > a ? b : a));
    months.push({ amount: roundCents(est), low: lo, high: hi, own: own.length });
  }
  const counts = new Array(12).fill(0);
  for (const o of obs) counts[o.m - 1]++;
  const confidence = counts.every((c) => c >= 2) ? "high" : counts.every((c) => c >= 1) ? "medium" : "low";
  return { gated: false as const, months, annual: months.reduce((a, x) => a + x.amount, B0), confidence, count: obs.length };
}

const PERSONAL_SITE: EnergySiteFacts = ENERGY_SITE_FACTS["personal"]!;
const toCents = (d: Decimal) => BigInt(d.times(100).toDecimalPlaces(0).toString());

describe("electric model vs an independent BigInt-rational oracle (random worlds)", () => {
  it("3000 worlds: gate decision, every month's estimate and range, annual, confidence", () => {
    const r = rng(20261010);
    let est = 0;
    let gatedN = 0;
    const gateKinds = { few: 0, season: 0, stale: 0 };
    for (let w = 0; w < 3000; w++) {
      const now = new Date(Date.UTC(2026, ri(r, 0, 11), ri(r, 1, 28), 15));
      const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
      const n = ri(r, 0, 40);
      const pays: OPay[] = [];
      for (let i = 0; i < n; i++) {
        const back = ri(r, -1, 42); // -1 = a future month, 37+ = beyond the window
        const idx = nowIdx - back;
        const dim = new Date(Date.UTC(Math.floor(idx / 12), (idx % 12) + 1, 0)).getUTCDate();
        const date = new Date(Date.UTC(Math.floor(idx / 12), idx % 12, ri(r, 1, dim)));
        const kind = r();
        const cost = kind < 0.08 ? -ri(r, 1, 30000) : kind < 0.14 ? ri(r, 0, 99) : ri(r, 100, 90000);
        pays.push({ date, cost });
      }
      const solarFrom = r() < 0.6 ? "2023-03" : null;
      const payments: EnergyPayment[] = pays.map((p, i) => ({
        id: `p${i}`,
        date: p.date,
        amount: new Decimal(-p.cost).div(100),
        payee: "eversource",
        account: "x",
        fromOtherEntity: null,
      }));
      const site = solarFrom ? PERSONAL_SITE : null;
      const got = electricEstimate({ payments, now, site, flatMonthly: null });
      const exp = oracleElectric(pays, now, site?.solarLiveFrom ?? null);
      if (exp.gated) {
        gatedN++;
        expect(got.status, `world ${w}`).toBe("gated");
        expect(Object.keys(got).sort()).toEqual(["kind", "reason", "status"]);
        continue;
      }
      est++;
      expect(got.status, `world ${w}`).toBe("estimate");
      if (got.status !== "estimate") continue;
      expect(got.confidence, `world ${w}`).toBe(exp.confidence);
      expect(got.observedMonths).toBe(exp.count);
      got.months.forEach((m, i) => {
        expect(toCents(m.amount), `world ${w} month ${i + 1} amount`).toBe(exp.months[i]!.amount);
        expect(toCents(m.low), `world ${w} month ${i + 1} low`).toBe(BigInt(exp.months[i]!.low));
        expect(toCents(m.high), `world ${w} month ${i + 1} high`).toBe(BigInt(exp.months[i]!.high));
        expect(m.ownObservations).toBe(exp.months[i]!.own);
      });
      expect(toCents(got.annual), `world ${w} annual`).toBe(exp.annual);
      // sums of the table agree with the headline
      expect(toCents(got.months.reduce((a, m) => a.plus(m.amount), new Decimal(0)))).toBe(exp.annual);
    }
    expect(est).toBeGreaterThan(300);
    expect(gatedN).toBeGreaterThan(300);
    void gateKinds;
  });

  it("gate boundaries: exactly 90 days passes, 91 gates; 5 months gates, 6 passes; 1 winter month gates", () => {
    const mk = (periods: string[], day = 5): EnergyPayment[] =>
      periods.map((p, i) => ({ id: String(i), date: D(`${p}-${String(day).padStart(2, "0")}`), amount: new Decimal(-100), payee: "eversource", account: null, fromOtherEntity: null }));
    const six = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
    const newestJul5 = D("2026-07-05");
    const at = (days: number) => new Date(newestJul5.getTime() + days * DAY + 11 * 3600_000);
    expect(electricEstimate({ payments: mk(six), now: at(90), site: null, flatMonthly: null }).status).toBe("estimate");
    expect(electricEstimate({ payments: mk(six), now: at(91), site: null, flatMonthly: null }).status).toBe("gated");
    expect(electricEstimate({ payments: mk(six.slice(1)), now: at(10), site: null, flatMonthly: null }).status).toBe("gated"); // 5 months
    // 6 months but only 1 heating month (Mar) and 5 others
    expect(electricEstimate({ payments: mk(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]), now: D("2026-08-20"), site: null, flatMonthly: null }).status).toBe("gated");
    // 6 months, 5 heating (Nov..Mar) and 1 other
    expect(electricEstimate({ payments: mk(["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04"]), now: D("2026-04-20"), site: null, flatMonthly: null }).status).toBe("gated");
  });

  it("a gated result for every kind carries exactly {status, kind, reason} and the reason contains no dollar figure of an estimate", () => {
    const e = electricEstimate({ payments: [], now: D("2026-10-10"), site: PERSONAL_SITE, flatMonthly: new Decimal(172) });
    const o = oilEstimate({ payments: [], entries: [], now: D("2026-10-10"), site: PERSONAL_SITE });
    const f = firewoodResult(firewoodFacts([], D("2026-10-10")));
    for (const g of [e, o, f]) {
      expect(g.status).toBe("gated");
      expect(Object.keys(g).sort()).toEqual(["kind", "reason", "status"]);
    }
    expect([e.kind, o.kind, f.kind]).toEqual(["electric", "oil", "firewood"]);
  });

  it("solar regime: payments before 2023-03 are ignored for the Personal house (and only there)", () => {
    const base = ["2022-12", "2023-01", "2023-02"].map((p, i) => ({ id: `old${i}`, date: D(`${p}-10`), amount: new Decimal(-999), payee: "eversource", account: null, fromOtherEntity: null }));
    const now = D("2025-02-20"); // all three months are inside the 36-month window
    const withSolar = observedMonths(base, now, "2023-03");
    const without = observedMonths(base, now, null);
    expect(withSolar).toHaveLength(0);
    expect(without.map((m) => m.period)).toEqual(["2022-12", "2023-01", "2023-02"]);
    expect(ENERGY_SITE_FACTS["sudden-valley"]!.solarLiveFrom).toBeNull();
  });

  it("credit and near-zero months are kept as data: a -$12 month and a $0.00 month are observed, not dropped", () => {
    const pays: EnergyPayment[] = [
      { id: "a", date: D("2026-07-08"), amount: new Decimal("12.00"), payee: "eversource", account: null, fromOtherEntity: null }, // inflow = credit
      { id: "b", date: D("2026-08-08"), amount: new Decimal("0.00"), payee: "eversource", account: null, fromOtherEntity: null },
    ];
    const obs = observedMonths(pays, D("2026-10-10"), "2023-03");
    expect(obs.map((m) => [m.period, m.net.toString()])).toEqual([["2026-07", "-12"], ["2026-08", "0"]]);
  });

  it("leave-one-out reproduces the owner-visible numbers from the 8 real Personal payments ($145.26 vs flat $195.84)", () => {
    const raw: Array<[string, string]> = [["2025-11", "235.66"], ["2025-12", "445.42"], ["2026-01", "665.09"], ["2026-02", "583.22"], ["2026-04", "63.60"], ["2026-05", "161.51"], ["2026-08", "41.49"], ["2026-09", "247.89"]];
    const obs = raw.map(([p, a]) => ({ period: p, month: Number(p.slice(5)), net: new Decimal(a), payments: 1, newest: D(`${p}-10`) }));
    const loo = leaveOneOut(obs, new Decimal(172))!;
    expect(loo.months).toBe(8);
    expect(loo.modelMiss.toDecimalPlaces(2).toString()).toBe("145.26");
    expect(loo.flatMiss!.toDecimalPlaces(2).toString()).toBe("195.84");
  });
});

// ── Oil oracle ───────────────────────────────────────────────────────────────────
const DEC = Decimal.clone({ precision: 80 });
interface OOil {
  id: string;
  date: Date;
  cents: number; // paid (positive)
}
function oracleOil(pays: OOil[], entries: OilPriceEntry[], now: Date, excluded: Set<string>) {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fromMs = todayMs - 365 * DAY;
  const win = pays.filter((p) => p.date.getTime() > fromMs && Date.UTC(p.date.getUTCFullYear(), p.date.getUTCMonth(), p.date.getUTCDate()) <= todayMs);
  const counted = win.filter((p) => p.cents !== 29246 && !excluded.has(p.id));
  if (counted.length === 0) return { gated: true as const, why: "none" };
  const todayIso = new Date(todayMs).toISOString().slice(0, 10);
  const byDate = new Map<string, OilPriceEntry>();
  for (const e of entries) if (!e.removed) byDate.set(e.effectiveOn, e);
  const active = [...byDate.values()].filter((e) => e.effectiveOn <= todayIso).sort((a, b) => (a.effectiveOn < b.effectiveOn ? -1 : 1));
  if (active.length < 2) return { gated: true as const, why: "prices" };
  const first = active[0]!.effectiveOn;
  const latest = active[active.length - 1]!;
  // six months after `first`, day clamped to the month length
  const [y, m, d] = first.split("-").map(Number) as [number, number, number];
  const tIdx = y * 12 + (m - 1) + 6;
  const ty = Math.floor(tIdx / 12);
  const tm = tIdx % 12;
  const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const sixLater = new Date(Date.UTC(ty, tm, Math.min(d, dim))).toISOString().slice(0, 10);
  if (latest.effectiveOn < sixLater) return { gated: true as const, why: "gap" };
  const priceAt = (iso: string) => {
    let hit: OilPriceEntry | null = null;
    for (const e of active) if (e.effectiveOn <= iso) hit = e;
    return hit;
  };
  let adj = new DEC(0);
  let gal = new DEC(0);
  for (const p of counted) {
    const pr = priceAt(p.date.toISOString().slice(0, 10));
    if (!pr) return { gated: true as const, why: "uncovered" };
    const paid = new DEC(p.cents).div(100);
    adj = adj.plus(paid.times(latest.pricePerGal).div(pr.pricePerGal));
    gal = gal.plus(paid.div(pr.pricePerGal));
  }
  const asPaid = counted.reduce((a, p) => a.plus(new DEC(p.cents).div(100)), new DEC(0));
  return {
    gated: false as const,
    annual: adj.toDecimalPlaces(2),
    monthly: adj.div(12).toDecimalPlaces(2),
    sens: gal.times("0.5").toDecimalPlaces(2),
    asPaid: asPaid.toDecimalPlaces(2),
  };
}

describe("oil model vs an independent oracle (random worlds)", () => {
  it("3000 worlds: gate (why), annual, monthly, sensitivity, as-paid, exclusions, service amount, price rules", () => {
    const r = rng(7001);
    let est = 0;
    const why: Record<string, number> = {};
    for (let w = 0; w < 3000; w++) {
      const now = new Date(Date.UTC(2026, ri(r, 0, 11), ri(r, 1, 28), 15));
      const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const n = ri(r, 0, 14);
      const pays: OOil[] = [];
      for (let i = 0; i < n; i++) {
        const back = ri(r, -3, 420);
        const date = new Date(todayMs - back * DAY);
        const cents = r() < 0.15 ? 29246 : ri(r, 1000, 250000);
        pays.push({ id: `tx${w}-${i}`, date, cents });
      }
      const excluded = new Set(pays.filter(() => r() < 0.15).map((p) => p.id));
      const entries: OilPriceEntry[] = [];
      const ne = ri(r, 0, 5);
      for (let i = 0; i < ne; i++) {
        const dateMs = todayMs - ri(r, -40, 700) * DAY;
        const price = (ri(r, 200, 600) / 100).toFixed(2);
        const rate = r();
        entries.push({
          id: `e${i}`,
          effectiveOn: new Date(dateMs).toISOString().slice(0, 10),
          pricePerGal: rate < 0.3 ? new Decimal(price).toFixed(4) : price,
          ...(r() < 0.2 ? { removed: true as const } : {}),
        });
      }
      const payments: EnergyPayment[] = pays.map((p) => ({ id: p.id, date: p.date, amount: new Decimal(-p.cents).div(100), payee: "mccarthy heating oil", account: null, fromOtherEntity: null }));
      const got = oilEstimate({ payments, entries, now, site: PERSONAL_SITE, excludedIds: excluded });
      const exp = oracleOil(pays, entries, now, excluded);
      if (exp.gated) {
        why[exp.why] = (why[exp.why] ?? 0) + 1;
        expect(got.status, `world ${w} (${exp.why})`).toBe("gated");
        expect(Object.keys(got).sort()).toEqual(["kind", "reason", "status"]);
        if (exp.why === "uncovered" && got.status === "gated") expect(got.reason).toMatch(/\d{4}-\d{2}-\d{2}/);
        continue;
      }
      est++;
      expect(got.status, `world ${w}`).toBe("estimate");
      if (got.status !== "estimate") continue;
      expect(got.annual.toString(), `world ${w} annual`).toBe(exp.annual.toString());
      expect(got.monthly.toString(), `world ${w} monthly`).toBe(exp.monthly.toString());
      expect(got.sensitivity.toString(), `world ${w} sensitivity`).toBe(exp.sens.toString());
      const facts = oilFacts(payments, now, PERSONAL_SITE, { excludedIds: excluded });
      expect(facts.trailingAsPaid.toDecimalPlaces(2).toString()).toBe(exp.asPaid.toString());
      expect(got.low.lessThanOrEqualTo(got.high)).toBe(true);
    }
    expect(est).toBeGreaterThan(150);
    for (const k of ["none", "prices", "gap", "uncovered"]) expect(why[k] ?? 0, k).toBeGreaterThan(20);
  });

  it("the yearly furnace service ($292.46) is never counted, wherever it sits; an oil payment of any other amount is", () => {
    const mk = (id: string, cents: number, iso: string): EnergyPayment => ({ id, date: D(iso), amount: new Decimal(-cents).div(100), payee: "mccarthy heating oil", account: null, fromOtherEntity: null });
    const f = oilFacts([mk("a", 29246, "2026-09-11"), mk("b", 29245, "2026-09-12"), mk("c", 29247, "2026-09-13")], D("2026-10-10"), PERSONAL_SITE);
    expect(f.counted.map((x) => x.id).sort()).toEqual(["b", "c"]);
    expect(f.service?.amount.toString()).toBe("292.46");
    // Sudden Valley has no owner-confirmed service amount: nothing is left out there
    const sv = oilFacts([mk("a", 29246, "2026-09-11")], D("2026-10-10"), ENERGY_SITE_FACTS["sudden-valley"]!);
    expect(sv.counted).toHaveLength(1);
  });

  it("owner marking every row leaves nothing: gated with 'nothing to estimate', and the marked ids are listed", () => {
    const mk = (id: string, cents: number, iso: string): EnergyPayment => ({ id, date: D(iso), amount: new Decimal(-cents).div(100), payee: "mccarthy heating oil", account: null, fromOtherEntity: null });
    const pays = [mk("a", 100000, "2026-09-11"), mk("b", 100000, "2026-08-12")];
    const entries: OilPriceEntry[] = [{ id: "1", effectiveOn: "2025-01-01", pricePerGal: "3.00" }, { id: "2", effectiveOn: "2026-09-01", pricePerGal: "3.50" }];
    expect(oilEstimate({ payments: pays, entries, now: D("2026-10-10"), site: PERSONAL_SITE }).status).toBe("estimate");
    const g = oilEstimate({ payments: pays, entries, now: D("2026-10-10"), site: PERSONAL_SITE, excludedIds: new Set(["a", "b"]) });
    expect(g.status).toBe("gated");
    const f = oilFacts(pays, D("2026-10-10"), PERSONAL_SITE, { excludedIds: new Set(["a"]) });
    expect(f.excluded.map((x) => x.id)).toEqual(["a"]);
    expect(f.counted.map((x) => x.id)).toEqual(["b"]);
  });

  it("month-end clamp: prices Aug 31 -> Feb 28 pass (6 months clamped), Jan 31 -> Jul 30 gate; exactly 6 months passes", () => {
    const pay: EnergyPayment[] = [{ id: "p", date: D("2026-09-20"), amount: new Decimal(-500), payee: "mccarthy heating oil", account: null, fromOtherEntity: null }];
    const e = (a: string, b: string): OilPriceEntry[] => [{ id: "1", effectiveOn: a, pricePerGal: "3.00" }, { id: "2", effectiveOn: b, pricePerGal: "3.50" }];
    const now = D("2026-10-10");
    expect(oilEstimate({ payments: pay, entries: e("2026-04-10", "2026-10-10"), now, site: null }).status).toBe("estimate");
    expect(oilEstimate({ payments: pay, entries: e("2026-04-11", "2026-10-10"), now, site: null }).status).toBe("gated");
    expect(oilEstimate({ payments: pay, entries: e("2026-03-31", "2026-09-30"), now, site: null }).status).toBe("estimate"); // Mar 31 + 6 = Sep 30 (clamped)
    // a price dated tomorrow is not in force yet
    expect(oilEstimate({ payments: pay, entries: e("2026-03-01", "2026-10-11"), now, site: null }).status).toBe("gated");
  });
});

// ── Site selection: entity separation ────────────────────────────────────────────
describe("selectSitePayments: entity separation (random worlds)", () => {
  const ents: EnergyEntityRef[] = [
    { id: "E-P", name: "Personal", slug: "personal" },
    { id: "E-SV", name: "Sudden Valley Property Management, LLC", slug: "sudden-valley" },
    { id: "E-EK", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting" },
    { id: "E-MZ", name: "Mezzo", slug: "mezzo" },
    { id: "E-NULL", name: "No slug", slug: null },
  ];
  const lines: SeasonalLineRef[] = [
    { entityId: "E-P", tagId: "t1", tagName: "Utilities / Electric (Eversource)", kind: "electric" },
    { entityId: "E-P", tagId: "t2", tagName: "Utilities / Oil", kind: "oil" },
    { entityId: "E-P", tagId: "t3", tagName: "Utilities / Firewood", kind: "firewood" },
    { entityId: "E-SV", tagId: "t4", tagName: "Arbor Retreat / Electricity", kind: "electric" },
    { entityId: "E-SV", tagId: "t5", tagName: "Arbor Retreat / Oil", kind: "oil" },
  ];
  const payees = ["eversource web pay", "mccarthy heating oil serv", "firewood guy", "stop and shop", "mccarthy plumbing", "mccarthy"];
  const tagsPool = ["Utilities / Electric (Eversource)", "Utilities / Oil", "Utilities / Firewood", "Arbor Retreat / Electricity", "Arbor Retreat / Oil", "Groceries"];

  it("2000 random ledgers: SV receives only SV rows; Personal receives its own plus EK McCarthy-oil rows only; nobody else gets other entities' rows", () => {
    const r = rng(99);
    let ekIn = 0;
    let svOwn = 0;
    let svMcOther = 0;
    for (let w = 0; w < 2000; w++) {
      const txs: RawEnergyTx[] = [];
      const n = ri(r, 1, 40);
      for (let i = 0; i < n; i++) {
        txs.push({
          id: `t${i}`,
          date: D("2026-05-01"),
          amount: new Decimal(-10),
          entityId: ents[ri(r, 0, ents.length - 1)]!.id,
          payee: payees[ri(r, 0, payees.length - 1)]!,
          account: null,
          tagPaths: r() < 0.5 ? [tagsPool[ri(r, 0, tagsPool.length - 1)]!] : [],
        });
      }
      const byId = new Map(txs.map((t) => [t.id, t]));
      for (const ent of ents) {
        const out = selectSitePayments(txs, ent, lines, ents);
        for (const kind of ["electric", "oil", "firewood"] as const) {
          for (const p of out[kind]) {
            const tx = byId.get(p.id)!;
            if (tx.entityId !== ent.id) {
              // the ONLY cross-entity read: Personal <- EK, McCarthy heating-oil payee, oil kind
              expect(ent.slug, "only the Personal house reads another entity").toBe("personal");
              expect(tx.entityId).toBe("E-EK");
              expect(kind).toBe("oil");
              expect(tx.payee).toMatch(/mccarthy heating oil/);
              expect(p.fromOtherEntity).toBe("Eric Kinniburgh Consulting, LLC");
              ekIn++;
            } else {
              expect(p.fromOtherEntity).toBeNull();
            }
          }
        }
        if (ent.slug === "sudden-valley") {
          for (const kind of ["electric", "oil", "firewood"] as const) for (const p of out[kind]) expect(byId.get(p.id)!.entityId).toBe("E-SV");
          svOwn += out.electric.length + out.oil.length;
        }
        if (ent.id === "E-EK" || ent.id === "E-MZ" || ent.id === "E-NULL") {
          expect(out.electric.length + out.oil.length + out.firewood.length, "entities without seasonal lines receive nothing").toBe(0);
        }
      }
      // Sudden Valley never gets a Personal or EK McCarthy row, even when Personal does
      const sv = selectSitePayments(txs, ents[1]!, lines, ents);
      const svIds = new Set([...sv.oil, ...sv.electric, ...sv.firewood].map((p) => p.id));
      for (const t of txs) if (t.entityId !== "E-SV") expect(svIds.has(t.id)).toBe(false);
      svMcOther += txs.filter((t) => t.entityId !== "E-SV" && /mccarthy/.test(t.payee)).length;
    }
    expect(ekIn).toBeGreaterThan(200);
    expect(svOwn).toBeGreaterThan(100);
    expect(svMcOther).toBeGreaterThan(500);
  });

  it("the Personal house does NOT read Sudden Valley's McCarthy rows, nor EK's Eversource or firewood rows", () => {
    const t = (id: string, entityId: string, payee: string): RawEnergyTx => ({ id, date: D("2026-05-01"), amount: new Decimal(-10), entityId, payee, account: null, tagPaths: [] });
    const txs = [t("sv-oil", "E-SV", "mccarthy heating oil"), t("ek-elec", "E-EK", "eversource"), t("ek-wood", "E-EK", "firewood"), t("ek-oil", "E-EK", "mccarthy heating oil")];
    const out = selectSitePayments(txs, ents[0]!, lines, ents);
    expect(out.oil.map((p) => p.id)).toEqual(["ek-oil"]);
    expect(out.electric).toEqual([]);
    expect(out.firewood).toEqual([]);
  });

  it("buildSiteEnergy for SV with Personal+EK McCarthy rows present: gated, zero payments, and no plan", () => {
    const t = (id: string, entityId: string): RawEnergyTx => ({ id, date: D("2026-09-01"), amount: new Decimal(-900), entityId, payee: "mccarthy heating oil", account: null, tagPaths: [] });
    const site = buildSiteEnergy({
      entity: ents[1]!,
      lines: lines.filter((l) => l.entityId === "E-SV"),
      txs: [t("a", "E-P"), t("b", "E-EK")],
      entities: ents,
      priceEntries: [{ id: "1", effectiveOn: "2025-01-01", pricePerGal: "3.00" }, { id: "2", effectiveOn: "2026-09-01", pricePerGal: "3.50" }],
      flatMonthly: {},
      replaceDraws: false,
      now: D("2026-10-10"),
    });
    expect(site.oil!.result.status).toBe("gated");
    expect(site.oil!.facts.payments).toHaveLength(0);
    expect(site.plans).toHaveLength(0);
    expect(site.siteNotes.join(" ")).toMatch(/short-term rental/);
    expect(site.siteNotes.join(" ")).not.toMatch(/charged to another entity/);
  });
});

describe("D2 (fixed in Round 1, was pinned with it.fails): the oil basis counts other-entity rows that are not counted", () => {
  it("'N of the payments sit on another entity's books' counts only payments that are in the figure (service and marked rows are not)", () => {
    const mk = (id: string, cents: number, iso: string, other: string | null): EnergyPayment => ({ id, date: D(iso), amount: new Decimal(-cents).div(100), payee: "mccarthy heating oil", account: null, fromOtherEntity: other });
    const pays = [mk("svc", 29246, "2026-01-10", "EKC"), mk("oil1", 67965, "2026-01-12", "EKC"), mk("oil2", 70000, "2026-05-12", null)];
    const entries: OilPriceEntry[] = [{ id: "1", effectiveOn: "2025-01-01", pricePerGal: "3.00" }, { id: "2", effectiveOn: "2026-09-01", pricePerGal: "3.50" }];
    const g = oilEstimate({ payments: pays, entries, now: D("2026-10-10"), site: PERSONAL_SITE });
    expect(g.status).toBe("estimate");
    if (g.status === "estimate") expect(g.basis).toMatch(/\b1 of the payments sit on another entity's books/);
  });
});

describe("the 'Check these McCarthy charges' thresholds (25% and 300% of the median counted payment, strict) and the tag rule", () => {
  const mk = (id: string, cents: number, iso: string, tags: string[] = ["Utilities / Oil"]): EnergyPayment => ({ id, date: D(iso), amount: new Decimal(-cents).div(100), payee: "mccarthy heating oil", account: null, fromOtherEntity: null, tagPaths: tags });
  const pays = [mk("a", 100000, "2026-09-01"), mk("b", 100000, "2026-08-01"), mk("c", 100000, "2026-07-01"), mk("low-edge", 25000, "2026-06-01"), mk("low", 24999, "2026-05-01"), mk("high-edge", 300000, "2026-04-01"), mk("high", 300001, "2026-03-01")];
  const f = oilFacts(pays, D("2026-10-10"), null, { oilTagName: "Utilities / Oil" });
  it("exactly 0.25x and 3.00x the median are NOT flagged; one cent beyond is", () => {
    expect(f.check.map((x) => x.id).sort()).toEqual(["high", "low"]);
    expect(f.check.find((x) => x.id === "low")!.checkWhy.join(" ")).toMatch(/far below the typical payment \(median \$1,000\.00\)/);
    expect(f.check.find((x) => x.id === "high")!.checkWhy.join(" ")).toMatch(/far above the typical payment/);
  });
  it("everything flagged stays COUNTED (the figure includes it until the owner marks it)", () => {
    expect(f.counted).toHaveLength(7);
    expect(f.trailingCount).toBe(7);
  });
  it("fewer than 3 counted payments: no amount rule; the tag rule still applies; wrong tag or no tag flags, the exact Oil tag does not", () => {
    const two = oilFacts([mk("x", 100000, "2026-09-01"), mk("y", 5000, "2026-08-01", ["Home & Property / Home Repair"]), mk("z", 100000, "2026-07-01", [])], D("2026-10-10"), null, { oilTagName: "Utilities / Oil" });
    expect(two.check.map((c) => c.id).sort()).toEqual(["y", "z"]);
    const none = oilFacts([mk("x", 100000, "2026-09-01", [])], D("2026-10-10"), null, {});
    expect(none.check).toEqual([]); // no Oil line known: tags are not judged
  });
  it("a marked row or the service amount never shows in the check list", () => {
    const g = oilFacts([...pays, mk("svc", 29246, "2026-02-01", [])], D("2026-10-10"), PERSONAL_SITE, { oilTagName: "Utilities / Oil", excludedIds: new Set(["low"]) });
    // Round 1 (N3): on the Personal house a row within 20% of the known service amount ($250 'low-edge' is) is listed as
    // service-like; the exact service amount ('svc') and the marked row ('low') still never are.
    expect(g.check.map((x) => x.id).sort()).toEqual(["high", "low-edge"]);
    expect(g.check.find((x) => x.id === "low-edge")!.checkWhy.join(" ")).toMatch(/close to the yearly furnace service amount \(\$292\.46\)/);
    expect(g.excluded.map((x) => x.id)).toEqual(["low"]);
  });
});

describe("marked-row id list hygiene (pure)", () => {
  it("parseExcludedIds keeps only id-shaped strings, dedupes, caps at 200; setExcluded refuses an id that is not id-shaped", async () => {
    const { parseExcludedIds, setExcluded } = await import("@/lib/seasonal-energy-prices");
    const good = "5cb58f64-8fea-4a9a-b890-bed71caf3747";
    const r = parseExcludedIds(JSON.stringify([good, good, "abc", "'; DROP TABLE x;--", "<script>", 42, null, "x".repeat(70), "5cb58f64 8fea"]));
    expect(r).toEqual({ ids: [good], corrupt: false });
    expect(setExcluded([], "not an id!", true)).toMatchObject({ ok: false });
    expect(setExcluded([], "'; DROP", false)).toMatchObject({ ok: false });
    const many = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(parseExcludedIds(JSON.stringify(many)).ids).toHaveLength(200);
  });
});
