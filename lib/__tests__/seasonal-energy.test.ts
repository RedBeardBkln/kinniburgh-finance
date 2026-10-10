// carry-forward-seasonal-energy, step 2: the pure seasonal model (lib/seasonal-energy.ts). Electric by season in NET
// dollars (solar regime), oil from the trailing 12 months restated by the owner's $/gal history, firewood gated.
// Every estimate is checked against an INDEPENDENT oracle (plain numbers, written differently from the module).
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  billMatchesLine,
  buildSiteEnergy,
  electricConfidence,
  electricEstimate,
  ENERGY_SITE_FACTS,
  firewoodFacts,
  firewoodResult,
  isServiceCharge,
  leaveOneOut,
  lineKindOfTag,
  observedMonths,
  oilEstimate,
  oilFacts,
  payeeKindOf,
  planAmountForMonth,
  planForBill,
  planForLine,
  selectSitePayments,
  usd,
  type BillSeasonalPlan,
  type EnergyEntityRef,
  type EnergyPayment,
  type RawEnergyTx,
  type SeasonalLineRef,
} from "@/lib/seasonal-energy";
import type { OilPriceEntry } from "@/lib/seasonal-energy-prices";

const NOW = new Date("2026-10-10T00:00:00Z");
const PERSONAL = ENERGY_SITE_FACTS["personal"]!;
const SV = ENERGY_SITE_FACTS["sudden-valley"]!;

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
function pay(date: string, outflow: string | number, over: Partial<EnergyPayment> = {}): EnergyPayment {
  return { id: `p-${date}-${outflow}-${Math.random().toString(36).slice(2, 6)}`, date: D(date), amount: new Decimal(String(outflow)).negated(), payee: "x", account: "Acct", fromOtherEntity: null, ...over };
}
const price = (id: string, effectiveOn: string, pricePerGal: string, over: Partial<OilPriceEntry> = {}): OilPriceEntry => ({ id, effectiveOn, pricePerGal, ...over });

// The 8 real Personal Eversource payments (live read-only, 2026-10-10): 8 payments in 8 different months.
const REAL_ELECTRIC: Array<[string, string]> = [
  ["2025-11-19", "235.66"],
  ["2025-12-18", "445.42"],
  ["2026-01-20", "665.09"],
  ["2026-02-18", "583.22"],
  ["2026-04-13", "63.60"],
  ["2026-05-05", "161.51"],
  ["2026-08-06", "41.49"],
  ["2026-09-03", "247.89"],
];
const realElectric = () => REAL_ELECTRIC.map(([d, a]) => pay(d, a));

// ── small deterministic PRNG ────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("helpers", () => {
  it("usd formats with grouping and sign", () => {
    expect(usd(new Decimal("1234.5"))).toBe("$1,234.50");
    expect(usd(new Decimal("-12"))).toBe("-$12.00");
    expect(usd(new Decimal("0"))).toBe("$0.00");
    expect(usd(new Decimal("1000000"))).toBe("$1,000,000.00");
  });
  it("payeeKindOf and lineKindOfTag", () => {
    expect(payeeKindOf("eversource web pay")).toBe("electric");
    expect(payeeKindOf("mccarthy heating oil serv 860 4432839 ct")).toBe("oil");
    expect(payeeKindOf("McCarthy Oil")).toBe("oil");
    expect(payeeKindOf("mccarthy plumbing")).toBeNull();
    expect(payeeKindOf("firewood guy")).toBe("firewood");
    expect(payeeKindOf("check 227")).toBeNull();
    expect(lineKindOfTag("Utilities / Electric (Eversource)")).toBe("electric");
    expect(lineKindOfTag("Arbor Retreat / Electricity")).toBe("electric");
    expect(lineKindOfTag("Utilities / Oil")).toBe("oil");
    expect(lineKindOfTag("Arbor Retreat / Oil")).toBe("oil");
    expect(lineKindOfTag("Utilities / Firewood")).toBe("firewood");
    expect(lineKindOfTag("Utilities / Solar")).toBeNull();
    expect(lineKindOfTag("Business Expenses / Eric / Eric Kinniburgh Consulting LLC / Utilities / Propane (heat)")).toBeNull();
  });
});

// ═══ Electric ═══════════════════════════════════════════════════════════════════

describe("observedMonths", () => {
  it("sums payments in the same month (a refund nets out) and keeps credit / near-zero months", () => {
    const m = observedMonths([pay("2026-04-02", "100"), pay("2026-04-20", "-30"), pay("2026-05-05", "0.40"), pay("2026-06-03", "-12.5")], NOW, null);
    expect(m.map((x) => [x.period, x.net.toFixed(2), x.payments])).toEqual([
      ["2026-04", "70.00", 2],
      ["2026-05", "0.40", 1],
      ["2026-06", "-12.50", 1],
    ]);
  });
  it("ignores payments before the solar-live month, older than 36 months, and in the future", () => {
    const m = observedMonths(
      [pay("2023-02-28", "500"), pay("2023-03-01", "10"), pay("2020-01-10", "99"), pay("2026-10-12", "7"), pay("2026-10-02", "5"), pay("2023-10-05", "6")],
      NOW,
      "2023-03"
    );
    // 2023-10 is 36 months before 2026-10: just outside the window (the window is the current month and the 35 before it)
    expect(m.map((x) => x.period)).toEqual(["2026-10"]);
    const noSolar = observedMonths([pay("2023-02-28", "500"), pay("2023-11-05", "6"), pay("2023-12-05", "6")], NOW, null);
    expect(noSolar.map((x) => x.period)).toEqual(["2023-11", "2023-12"]);
  });
});

describe("electricEstimate on the real Personal history", () => {
  const est = () => electricEstimate({ payments: realElectric(), now: NOW, site: PERSONAL, flatMonthly: new Decimal("172") });

  it("passes the gate (8 months, 4 + 4, newest 37 days old) as a LOW confidence estimate", () => {
    const e = est();
    expect(e.status).toBe("estimate");
    if (e.status !== "estimate") return;
    expect(e.confidence).toBe("low");
    expect(e.observedMonths).toBe(8);
    expect(e.paymentCount).toBe(8);
  });

  it("month figures: own payment halves toward the season mean, an unseen month is the season mean", () => {
    const e = est();
    if (e.status !== "estimate") throw new Error("expected an estimate");
    const heating = (235.66 + 445.42 + 665.09 + 583.22) / 4; // 482.3475
    const other = (63.6 + 161.51 + 41.49 + 247.89) / 4; // 128.6225
    expect(e.heatingMean.toNumber()).toBeCloseTo(heating, 6);
    expect(e.otherMean.toNumber()).toBeCloseTo(other, 6);
    const by = new Map(e.months.map((m) => [m.month, m]));
    expect(by.get(1)!.amount.toFixed(2)).toBe(((665.09 + heating) / 2).toFixed(2)); // 573.72
    expect(by.get(3)!.amount.toFixed(2)).toBe(heating.toFixed(2)); // March: no payment seen -> season mean, not zero
    expect(by.get(3)!.basis).toBe("season");
    expect(by.get(8)!.amount.toFixed(2)).toBe(((41.49 + other) / 2).toFixed(2)); // 85.06
    expect(by.get(6)!.basis).toBe("season");
    expect(by.get(7)!.basis).toBe("season");
    expect(by.get(10)!.basis).toBe("season");
    // the range is the lowest and highest month seen in that season
    expect(by.get(1)!.low.toFixed(2)).toBe("235.66");
    expect(by.get(1)!.high.toFixed(2)).toBe("665.09");
    expect(by.get(8)!.low.toFixed(2)).toBe("41.49");
    expect(by.get(8)!.high.toFixed(2)).toBe("247.89");
    for (const m of e.months) {
      expect(m.low.lte(m.amount)).toBe(true);
      expect(m.amount.lte(m.high)).toBe(true);
    }
  });

  it("the leave-one-out check reproduces the plan's numbers: $145 for the model, $196 for the flat $172", () => {
    const e = est();
    if (e.status !== "estimate") throw new Error("expected an estimate");
    expect(e.backtest?.months).toBe(8);
    expect(e.backtest!.modelMiss.toFixed(2)).toBe("145.26");
    expect(e.backtest!.flatMiss!.toFixed(2)).toBe("195.84");
    // independent recomputation with plain numbers
    const nets = REAL_ELECTRIC.map(([d, a]) => ({ m: Number(d.slice(5, 7)), v: Number(a), p: d.slice(0, 7) }));
    const heat = (m: number) => [11, 12, 1, 2, 3].includes(m);
    let modelSum = 0;
    let flatSum = 0;
    for (const h of nets) {
      const rest = nets.filter((x) => x.p !== h.p && heat(x.m) === heat(h.m));
      const pred = rest.reduce((a, b) => a + b.v, 0) / rest.length;
      modelSum += Math.abs(pred - h.v);
      flatSum += Math.abs(172 - h.v);
    }
    expect(e.backtest!.modelMiss.toNumber()).toBeCloseTo(modelSum / 8, 6);
    expect(e.backtest!.flatMiss!.toNumber()).toBeCloseTo(flatSum / 8, 6);
    expect(e.backtest!.modelMiss.lt(e.backtest!.flatMiss!)).toBe(true);
  });

  it("the basis says it is net of solar, that credit months are kept, that payments are not usage, and the confidence", () => {
    const e = est();
    if (e.status !== "estimate") throw new Error("expected an estimate");
    expect(e.basis).toMatch(/solar/i);
    expect(e.basis).toMatch(/Mar 2023/);
    expect(e.basis).toMatch(/credit month is real data and is kept/);
    expect(e.basis).toMatch(/payments, not usage/);
    expect(e.basis).toMatch(/\(not zero\)/);
    expect(e.basis).toMatch(/Low confidence/);
    expect(e.basis).toMatch(/a flat \$172\.00 would have missed by \$195\.84/);
    expect(e.basis).not.toMatch(/rental/);
    expect(e.shortBasis).toMatch(/low confidence/);
  });

  it("the annual figure is the twelve months added up", () => {
    const e = est();
    if (e.status !== "estimate") throw new Error("expected an estimate");
    const sum = e.months.reduce((a, m) => a.plus(m.amount), new Decimal(0));
    expect(e.annual.toFixed(2)).toBe(sum.toFixed(2));
  });
});

describe("electricEstimate gates: a reason and NO number", () => {
  const gate = (payments: EnergyPayment[], site = PERSONAL, now = NOW) => electricEstimate({ payments, now, site, flatMonthly: null });
  const expectGated = (r: ReturnType<typeof electricEstimate>, re: RegExp) => {
    expect(r.status).toBe("gated");
    if (r.status !== "gated") return;
    expect(r.reason).toMatch(re);
    expect(Object.keys(r).sort()).toEqual(["kind", "reason", "status"]); // no amount of any kind
    expect(r.kind).toBe("electric");
  };

  it("nothing at all", () => expectGated(gate([]), /No Eversource payments/));
  it("fewer than 6 different months", () => {
    expectGated(gate(realElectric().slice(0, 5)), /Only 5 different months/);
    expectGated(gate([pay("2026-09-03", "10")]), /Only 1 different month of Eversource payments was found/);
  });
  it("many payments in few months still count as few months", () => {
    const many = ["2026-05-01", "2026-05-09", "2026-05-17", "2026-06-01", "2026-06-09", "2026-07-01", "2026-07-09", "2026-08-01"].map((d) => pay(d, "50"));
    expectGated(gate(many), /Only 4 different months/);
  });
  it("at least 2 months in November to March", () => {
    const only1Heating = [pay("2026-01-05", "300"), pay("2026-04-05", "60"), pay("2026-05-05", "70"), pay("2026-06-05", "80"), pay("2026-07-05", "90"), pay("2026-08-05", "50")];
    expectGated(gate(only1Heating), /Only 1 month of payments fall in November to March/);
  });
  it("at least 2 months in April to October", () => {
    const only1Other = [pay("2025-11-05", "300"), pay("2025-12-05", "300"), pay("2026-01-05", "300"), pay("2026-02-05", "300"), pay("2026-03-05", "300"), pay("2026-09-05", "50")];
    expectGated(gate(only1Other), /Only 1 month of payments fall in April to October/);
  });
  it("the newest payment must be within 90 days", () => {
    const later = new Date("2027-01-15T00:00:00Z"); // newest payment 2026-09-03 is 134 days old
    expectGated(gate(realElectric(), PERSONAL, later), /more than 90 days ago/);
    const ok = new Date("2026-12-02T00:00:00Z"); // exactly 90 days after 2026-09-03
    expect(gate(realElectric(), PERSONAL, ok).status).toBe("estimate");
    const tooOld = new Date("2026-12-03T00:00:00Z"); // 91 days
    expect(gate(realElectric(), PERSONAL, tooOld).status).toBe("gated");
  });
  it("Sudden Valley today (5 months, none in the heating season) is gated and says why", () => {
    const sv = [["2026-05-08", "79.81"], ["2026-06-09", "70.97"], ["2026-07-13", "127.11"], ["2026-08-11", "237.43"], ["2026-09-14", "237.58"]].map(([d, a]) => pay(d!, a!));
    expectGated(gate(sv, SV), /Only 5 different months/);
  });
  it("payments before the solar-live month do not count toward the gate", () => {
    const old = ["2022-06-05", "2022-07-05", "2022-08-05", "2022-12-05", "2023-01-05", "2023-02-05"].map((d) => pay(d, "100"));
    expectGated(gate([...old, pay("2026-09-03", "40")]), /Only 1 different month/);
  });
});

describe("solar regime: credit and near-zero bills are data, not errors", () => {
  it("keeps a net-credit and a near-zero month in the profile", () => {
    const payments = [
      pay("2026-04-05", "-35"), // net credit
      pay("2026-05-05", "0.01"), // near zero
      pay("2026-06-05", "12"),
      pay("2026-07-05", "20"),
      pay("2025-12-05", "300"),
      pay("2026-01-05", "400"),
    ];
    const e = electricEstimate({ payments, now: new Date("2026-07-20T00:00:00Z"), site: PERSONAL, flatMonthly: null });
    expect(e.status).toBe("estimate");
    if (e.status !== "estimate") return;
    expect(e.otherMean.toNumber()).toBeCloseTo((-35 + 0.01 + 12 + 20) / 4, 6);
    const april = e.months.find((m) => m.month === 4)!;
    expect(april.low.toNumber()).toBe(-35); // the credit is the bottom of the range
    expect(april.amount.toNumber()).toBeCloseTo((-35 + e.otherMean.toNumber()) / 2, 2);
  });
});

describe("electricConfidence ladder", () => {
  const months = (periods: string[]) => periods.map((p) => ({ period: p, month: Number(p.slice(5, 7)), net: new Decimal(1), payments: 1, newest: D(`${p}-05`) }));
  const year = (y: number) => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
  it("low until every calendar month is seen, medium then, high at twice", () => {
    expect(electricConfidence(months(year(2025).slice(0, 11)))).toBe("low");
    expect(electricConfidence(months(year(2025)))).toBe("medium");
    expect(electricConfidence(months([...year(2025), ...year(2026).slice(0, 11)]))).toBe("medium");
    expect(electricConfidence(months([...year(2025), ...year(2026)]))).toBe("high");
  });
});

describe("leaveOneOut", () => {
  it("is null when the others cannot form both seasons", () => {
    const m = [{ period: "2026-01", month: 1, net: new Decimal(10), payments: 1, newest: D("2026-01-05") }];
    expect(leaveOneOut(m, null)).toBeNull();
  });
  it("flat comparison is optional", () => {
    const m = observedMonths(realElectric(), NOW, null);
    expect(leaveOneOut(m, null)!.flatMiss).toBeNull();
    expect(leaveOneOut(m, new Decimal("172"))!.flatMiss).not.toBeNull();
  });
});

// ── Fuzz: electricEstimate vs an independent oracle ─────────────────────────────

interface OracleElectric {
  gated: null | "none" | "few" | "heating" | "other" | "stale";
  months: number[];
  lows: number[];
  highs: number[];
  confidence: "low" | "medium" | "high";
}

function oracleElectric(payments: Array<{ date: string; cost: number }>, nowIso: string, solarFrom: string | null): OracleElectric {
  const nowIdx = Number(nowIso.slice(0, 4)) * 12 + Number(nowIso.slice(5, 7)) - 1;
  const net = new Map<string, number>();
  let newestMs = -Infinity;
  for (const p of payments) {
    const per = p.date.slice(0, 7);
    const idx = Number(per.slice(0, 4)) * 12 + Number(per.slice(5, 7)) - 1;
    if (idx > nowIdx || nowIdx - idx >= 36) continue;
    if (solarFrom && per < solarFrom) continue;
    net.set(per, (net.get(per) ?? 0) + p.cost);
    newestMs = Math.max(newestMs, Date.parse(p.date));
  }
  const keys = [...net.keys()];
  const isHeat = (per: string) => {
    const m = Number(per.slice(5, 7));
    return m >= 11 || m <= 3;
  };
  const heat = keys.filter(isHeat);
  const other = keys.filter((k) => !isHeat(k));
  let gated: OracleElectric["gated"] = null;
  if (keys.length === 0) gated = "none";
  else if (keys.length < 6) gated = "few";
  else if (heat.length < 2) gated = "heating";
  else if (other.length < 2) gated = "other";
  else if ((Date.parse(nowIso) - newestMs) / 86_400_000 > 90) gated = "stale";
  const out: OracleElectric = { gated, months: [], lows: [], highs: [], confidence: "low" };
  if (gated) return out;
  const hm = heat.reduce((a, k) => a + net.get(k)!, 0) / heat.length;
  const om = other.reduce((a, k) => a + net.get(k)!, 0) / other.length;
  const counts = new Array(12).fill(0);
  for (let m = 1; m <= 12; m++) {
    const own = keys.filter((k) => Number(k.slice(5, 7)) === m);
    counts[m - 1] = own.length;
    const group = m >= 11 || m <= 3 ? hm : om;
    out.months.push((own.reduce((a, k) => a + net.get(k)!, 0) + group) / (own.length + 1));
    const g = m >= 11 || m <= 3 ? heat : other;
    out.lows.push(Math.min(...g.map((k) => net.get(k)!)));
    out.highs.push(Math.max(...g.map((k) => net.get(k)!)));
  }
  out.confidence = counts.every((c) => c >= 2) ? "high" : counts.every((c) => c >= 1) ? "medium" : "low";
  return out;
}

describe("electricEstimate agrees with an independent oracle on random worlds", () => {
  it("2500 worlds: gate decision, every month, range and confidence", () => {
    const rnd = mulberry32(20261010);
    const counts = { estimate: 0, none: 0, few: 0, heating: 0, other: 0, stale: 0, high: 0, medium: 0, credit: 0 };
    for (let w = 0; w < 2500; w++) {
      const nowIso = `${2024 + Math.floor(rnd() * 4)}-${String(1 + Math.floor(rnd() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;
      const nowIdx = Number(nowIso.slice(0, 4)) * 12 + Number(nowIso.slice(5, 7)) - 1;
      const nPay = Math.floor(rnd() * (w % 5 === 0 ? 60 : 24));
      const raw: Array<{ date: string; cost: number }> = [];
      for (let i = 0; i < nPay; i++) {
        const back = Math.floor(rnd() * (w % 7 === 0 ? 50 : 14)) - (rnd() < 0.05 ? 2 : 0);
        const idx = nowIdx - back;
        const y = Math.floor(idx / 12);
        const m = (idx % 12) + 1;
        const day = 1 + Math.floor(rnd() * 28);
        const cost = Math.round((rnd() * 700 - (rnd() < 0.1 ? 120 : 0)) * 100) / 100;
        raw.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, cost });
        if (cost < 0) counts.credit++;
      }
      const solarFrom = rnd() < 0.5 ? "2023-03" : null;
      const o = oracleElectric(raw, nowIso, solarFrom);
      const got = electricEstimate({
        payments: raw.map((p) => pay(p.date, p.cost.toFixed(2))),
        now: D(nowIso),
        site: solarFrom ? PERSONAL : SV,
        flatMonthly: null,
      });
      if (o.gated) {
        expect(got.status, `world ${w}`).toBe("gated");
        counts[o.gated]++;
        const re = { none: /No Eversource/, few: /different month/, heating: /November to March/, other: /April to October/, stale: /90 days ago/ }[o.gated];
        expect((got as { reason: string }).reason, `world ${w}`).toMatch(re);
        continue;
      }
      expect(got.status, `world ${w}`).toBe("estimate");
      if (got.status !== "estimate") continue;
      counts.estimate++;
      if (o.confidence === "high") counts.high++;
      if (o.confidence === "medium") counts.medium++;
      expect(got.confidence, `world ${w}`).toBe(o.confidence);
      for (let m = 0; m < 12; m++) {
        expect(got.months[m]!.amount.toNumber(), `world ${w} month ${m + 1}`).toBeCloseTo(o.months[m]!, 1);
        expect(Math.abs(got.months[m]!.amount.toNumber() - o.months[m]!), `world ${w} month ${m + 1}`).toBeLessThanOrEqual(0.0051);
        expect(got.months[m]!.low.toNumber(), `world ${w}`).toBeCloseTo(o.lows[m]!, 2);
        expect(got.months[m]!.high.toNumber(), `world ${w}`).toBeCloseTo(o.highs[m]!, 2);
      }
    }
    // every branch was exercised
    expect(counts.estimate).toBeGreaterThan(150);
    for (const k of ["none", "few", "heating", "other", "stale"] as const) expect(counts[k], k).toBeGreaterThan(1);
    expect(counts.credit).toBeGreaterThan(20);
    expect(counts.medium + counts.high).toBeGreaterThan(3);
  });
});

// ═══ Oil ════════════════════════════════════════════════════════════════════════

const SERVICE = 292.46;
function oilPayments(extra: EnergyPayment[] = []): EnergyPayment[] {
  return [
    pay("2025-10-31", SERVICE.toFixed(2), { fromOtherEntity: "Eric Kinniburgh Consulting, LLC" }),
    pay("2025-12-02", "679.65", { fromOtherEntity: "Eric Kinniburgh Consulting, LLC" }),
    pay("2026-01-26", "1225.25", { fromOtherEntity: "Eric Kinniburgh Consulting, LLC" }),
    pay("2026-02-09", "67.10", { fromOtherEntity: "Eric Kinniburgh Consulting, LLC" }),
    pay("2026-04-05", "804.60"),
    pay("2026-09-11", SERVICE.toFixed(2)),
    pay("2026-10-08", "1529.50"),
    ...extra,
  ];
}

describe("service charge", () => {
  it("only the owner-confirmed exact amount, on the Personal house", () => {
    expect(isServiceCharge(new Decimal("-292.46"), PERSONAL)?.label).toBe("yearly furnace service");
    expect(isServiceCharge(new Decimal("292.46"), PERSONAL)?.label).toBe("yearly furnace service");
    expect(isServiceCharge(new Decimal("-292.47"), PERSONAL)).toBeNull();
    expect(isServiceCharge(new Decimal("-292.45"), PERSONAL)).toBeNull();
    expect(isServiceCharge(new Decimal("-292.46"), SV)).toBeNull(); // not stated for Sudden Valley
    expect(isServiceCharge(new Decimal("-292.46"), null)).toBeNull();
  });
});

describe("oilFacts", () => {
  it("separates the furnace service from the as-paid total and labels the other-entity payments", () => {
    const f = oilFacts(oilPayments(), NOW, PERSONAL);
    expect(f.trailingAsPaid.toFixed(2)).toBe((679.65 + 1225.25 + 67.1 + 804.6 + 1529.5).toFixed(2));
    expect(f.trailingCount).toBe(5);
    expect(f.service).toMatchObject({ label: "yearly furnace service" });
    expect(f.service!.amount.toFixed(2)).toBe("292.46");
    expect(f.service!.dates).toEqual(["2025-10-31", "2026-09-11"]);
    expect(f.otherEntityRows).toBe(4); // every EK-card row read, the service charge on the EK card included
    expect(f.otherEntityCount).toBe(3); // Round 1 (D2): only the rows counted in the figures
    expect(f.payments.find((p) => p.date === "2025-12-02")?.fromOtherEntity).toBe("Eric Kinniburgh Consulting, LLC");
    expect(f.windowTo).toBe("2026-10-10");
  });
  it("the window is the 365 days ending today: older and future payments are out", () => {
    const f = oilFacts([pay("2025-10-10", "500"), pay("2025-10-11", "600"), pay("2026-10-10", "700"), pay("2026-10-11", "800")], NOW, PERSONAL);
    expect(f.payments.map((p) => p.date)).toEqual(["2026-10-10", "2025-10-11"]);
    expect(f.trailingAsPaid.toFixed(2)).toBe("1300.00");
  });
});

describe("oilEstimate gates: a reason and NO number", () => {
  const prices2 = [price("a", "2025-11-01", "4.00"), price("b", "2026-06-01", "3.50")];
  const run = (payments = oilPayments(), entries: OilPriceEntry[] = prices2, now = NOW, site = PERSONAL) => oilEstimate({ payments, entries, now, site });
  const expectGated = (r: ReturnType<typeof oilEstimate>, re: RegExp) => {
    expect(r.status).toBe("gated");
    if (r.status !== "gated") return;
    expect(r.reason).toMatch(re);
    expect(Object.keys(r).sort()).toEqual(["kind", "reason", "status"]);
    expect(r.kind).toBe("oil");
  };

  it("no payments in the last 12 months", () => expectGated(run([]), /No heating-oil payments/));
  it("only service charges is still no oil", () => expectGated(run([pay("2026-09-11", SERVICE.toFixed(2))]), /No heating-oil payments/));
  it("no price entered", () => expectGated(run(oilPayments(), []), /No heating-oil price has been entered/));
  it("one price entered", () => expectGated(run(oilPayments(), [price("a", "2025-11-01", "4")]), /Only one heating-oil price/));
  it("removed prices do not count", () => expectGated(run(oilPayments(), [price("a", "2025-11-01", "4"), price("b", "2026-06-01", "3.5", { removed: true })]), /Only one heating-oil price/));
  it("two prices on the same date are one price", () => expectGated(run(oilPayments(), [price("a", "2025-11-01", "4"), price("b", "2025-11-01", "4.1")]), /Only one heating-oil price/));
  it("a future-dated price does not count yet", () => expectGated(run(oilPayments(), [price("a", "2025-11-01", "4"), price("b", "2027-01-01", "3.5")]), /Only one heating-oil price/));
  it("prices less than 6 months apart", () => {
    expectGated(run(oilPayments(), [price("a", "2025-11-01", "4"), price("b", "2026-04-30", "3.5")]), /less than 6 months apart/);
    expect(run(oilPayments(), [price("a", "2025-11-01", "4"), price("b", "2026-05-01", "3.5")]).status).toBe("estimate"); // exactly 6 months
  });
  it("6 months apart is measured with end-of-month clamping", () => {
    // 2025-08-31 + 6 months = 2026-02-28
    const p = [pay("2026-04-05", "500")];
    expect(oilEstimate({ payments: p, entries: [price("a", "2025-08-31", "4"), price("b", "2026-02-28", "3")], now: NOW, site: PERSONAL }).status).toBe("estimate");
    expect(oilEstimate({ payments: p, entries: [price("a", "2025-08-31", "4"), price("b", "2026-02-27", "3")], now: NOW, site: PERSONAL }).status).toBe("gated");
  });
  it("a payment older than the first price entry cannot be restated: gated, naming the date to enter", () => {
    expectGated(run(oilPayments(), [price("a", "2026-01-01", "4"), price("b", "2026-08-01", "3.5")]), /older than your first price entry \(2026-01-01\).*on or before 2025-12-02/);
    expectGated(run(oilPayments(), [price("a", "2026-01-26", "4"), price("b", "2026-08-01", "3.5")]), /Enter the price in force on or before 2025-12-02/);
  });
});

describe("oilEstimate on the real McCarthy history with two prices", () => {
  const entries = [price("a", "2025-11-01", "4.00"), price("b", "2026-06-01", "3.50")];
  const est = () => oilEstimate({ payments: oilPayments(), entries, now: NOW, site: PERSONAL });

  it("restates each payment at today's price using the price in force when it was paid; the service charge is left out", () => {
    const e = est();
    expect(e.status).toBe("estimate");
    if (e.status !== "estimate") return;
    // 679.65 (Dec, $4.00), 1225.25 (Jan, $4.00), 67.10 (Feb, $4.00), 804.60 (Apr, $4.00), 1529.50 (Oct, $3.50)
    const adjusted = ((679.65 + 1225.25 + 67.1 + 804.6) * 3.5) / 4 + 1529.5;
    const gallons = (679.65 + 1225.25 + 67.1 + 804.6) / 4 + 1529.5 / 3.5;
    expect(Math.abs(e.annual.toNumber() - adjusted)).toBeLessThanOrEqual(0.0051);
    expect(Math.abs(e.monthly.toNumber() - adjusted / 12)).toBeLessThanOrEqual(0.0051);
    expect(e.impliedGallons.toNumber()).toBeCloseTo(gallons, 0);
    expect(e.sensitivity.toNumber()).toBeCloseTo(gallons * 0.5, 2);
    const asPaid = (679.65 + 1225.25 + 67.1 + 804.6 + 1529.5) / 12;
    expect(e.low.toNumber()).toBeCloseTo(Math.min(asPaid, adjusted / 12), 2);
    expect(e.high.toNumber()).toBeCloseTo(Math.max(asPaid, adjusted / 12), 2);
    expect(e.confidence).toBe("low");
    expect(e.price).toEqual({ pricePerGal: "3.50", effectiveOn: "2026-06-01" });
  });

  it("the basis names the service exclusion, the price, the even spread and the wrong-card payments", () => {
    const e = est();
    if (e.status !== "estimate") throw new Error("expected an estimate");
    expect(e.basis).toMatch(/yearly furnace service \(\$292\.46\) is left out/);
    expect(e.basis).toMatch(/\$3\.50 a gallon, in force since 2026-06-01, entered by you/);
    expect(e.basis).toMatch(/spread evenly/);
    expect(e.basis).toMatch(/no winter peak is claimed/);
    expect(e.basis).toMatch(/3 of the payments sit on another entity's books \(charged to the wrong card by mistake\)/);
    expect(e.basis).toMatch(/nothing was changed or moved/);
    expect(e.basis).toMatch(/Low confidence/);
  });

  it("the service charge changes neither the estimate nor the sensitivity", () => {
    const withService = est();
    const without = oilEstimate({ payments: oilPayments().filter((p) => !p.amount.abs().equals(SERVICE)), entries, now: NOW, site: PERSONAL });
    if (withService.status !== "estimate" || without.status !== "estimate") throw new Error("expected estimates");
    expect(withService.monthly.toFixed(2)).toBe(without.monthly.toFixed(2));
    expect(withService.sensitivity.toFixed(2)).toBe(without.sensitivity.toFixed(2));
  });

  it("raising the latest price raises the estimate in proportion to the payments restated", () => {
    const hi = oilEstimate({ payments: oilPayments(), entries: [price("a", "2025-11-01", "4.00"), price("b", "2026-06-01", "4.00")], now: NOW, site: PERSONAL });
    if (hi.status !== "estimate") throw new Error("expected an estimate");
    // all prices equal: restating changes nothing, so the estimate is the as-paid figure
    expect(hi.annual.toFixed(2)).toBe((679.65 + 1225.25 + 67.1 + 804.6 + 1529.5).toFixed(2));
  });
});

interface OracleOil {
  gated: null | "none" | "few" | "gap" | "uncovered" | "stale-none";
  annual: number;
  gallons: number;
  asPaid: number;
}

function oracleOil(
  payments: Array<{ date: string; cost: number; service?: boolean }>,
  prices: Array<{ id: string; on: string; p: number; removed?: boolean }>,
  todayIso: string
): OracleOil {
  const today = Date.parse(todayIso);
  const cutoff = today - 365 * 86_400_000;
  const counted = payments.filter((x) => Date.parse(x.date) > cutoff && Date.parse(x.date) <= today && !x.service);
  const out: OracleOil = { gated: null, annual: 0, gallons: 0, asPaid: 0 };
  if (counted.length === 0) return { ...out, gated: "none" };
  // live prices: not removed, on or before today, later array entry wins on the same date
  const byDate = new Map<string, number>();
  for (const e of prices) if (!e.removed && e.on <= todayIso) byDate.set(e.on, e.p);
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return { ...out, gated: "few" };
  const first = dates[0]!;
  const latest = dates[dates.length - 1]!;
  const [fy, fm, fd] = first.split("-").map(Number) as [number, number, number];
  const tIdx = fy * 12 + (fm - 1) + 6;
  const ty = Math.floor(tIdx / 12);
  const tm = tIdx % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const threshold = new Date(Date.UTC(ty, tm, Math.min(fd, lastDay))).toISOString().slice(0, 10);
  if (latest < threshold) return { ...out, gated: "gap" };
  const at = (d: string) => {
    let hit: number | null = null;
    for (const k of dates) if (k <= d) hit = byDate.get(k)!;
    return hit;
  };
  if (counted.some((x) => at(x.date) === null)) return { ...out, gated: "uncovered" };
  const pNow = byDate.get(latest)!;
  for (const x of counted) {
    out.annual += (x.cost * pNow) / at(x.date)!;
    out.gallons += x.cost / at(x.date)!;
    out.asPaid += x.cost;
  }
  return out;
}

describe("oilEstimate agrees with an independent oracle on random worlds", () => {
  it("2500 worlds: gate decision, annual, gallons and sensitivity", () => {
    const rnd = mulberry32(8675309);
    const seen = { estimate: 0, none: 0, few: 0, gap: 0, uncovered: 0, service: 0, removed: 0 };
    const todayIso = "2026-10-10";
    for (let w = 0; w < 2500; w++) {
      const nPay = Math.floor(rnd() * 10);
      const payments: Array<{ date: string; cost: number; service?: boolean }> = [];
      for (let i = 0; i < nPay; i++) {
        const ago = Math.floor(rnd() * 460) - 10; // some in the future, some beyond the window
        const d = new Date(Date.parse(todayIso) - ago * 86_400_000).toISOString().slice(0, 10);
        const service = rnd() < 0.15;
        if (service) seen.service++;
        payments.push({ date: d, cost: service ? SERVICE : Math.round((50 + rnd() * 1500) * 100) / 100, service });
      }
      const nPrice = Math.floor(rnd() * 5);
      const prices: Array<{ id: string; on: string; p: number; removed?: boolean }> = [];
      for (let i = 0; i < nPrice; i++) {
        const ago = Math.floor(rnd() * 600) - 15;
        const on = new Date(Date.parse(todayIso) - ago * 86_400_000).toISOString().slice(0, 10);
        const removed = rnd() < 0.2;
        if (removed) seen.removed++;
        prices.push({ id: `p${i}`, on, p: Math.round((2.5 + rnd() * 2) * 10000) / 10000, ...(removed ? { removed } : {}) });
      }
      const o = oracleOil(payments, prices, todayIso);
      const got = oilEstimate({
        payments: payments.map((x) => pay(x.date, x.cost.toFixed(2))),
        entries: prices.map((e) => price(e.id, e.on, e.p.toFixed(4), e.removed ? { removed: true } : {})),
        now: D(todayIso),
        site: PERSONAL,
      });
      if (o.gated) {
        expect(got.status, `world ${w}`).toBe("gated");
        seen[o.gated as "none" | "few" | "gap" | "uncovered"]++;
        const re = { none: /No heating-oil payments/, few: /heating-oil price/, gap: /less than 6 months apart/, uncovered: /older than your first price entry/ }[o.gated as "none" | "few" | "gap" | "uncovered"];
        expect((got as { reason: string }).reason, `world ${w}`).toMatch(re);
        continue;
      }
      expect(got.status, `world ${w}`).toBe("estimate");
      if (got.status !== "estimate") continue;
      seen.estimate++;
      expect(Math.abs(got.annual.toNumber() - o.annual), `world ${w}`).toBeLessThanOrEqual(0.0051);
      expect(Math.abs(got.monthly.toNumber() - o.annual / 12), `world ${w}`).toBeLessThanOrEqual(0.0051);
      expect(Math.abs(got.impliedGallons.toNumber() - o.gallons), `world ${w}`).toBeLessThanOrEqual(0.5001);
      expect(Math.abs(got.sensitivity.toNumber() - o.gallons * 0.5), `world ${w}`).toBeLessThanOrEqual(0.0051);
      const asPaidMonthly = o.asPaid / 12;
      expect(got.low.toNumber(), `world ${w}`).toBeLessThanOrEqual(Math.min(asPaidMonthly, o.annual / 12) + 0.0051);
      expect(got.high.toNumber(), `world ${w}`).toBeGreaterThanOrEqual(Math.max(asPaidMonthly, o.annual / 12) - 0.0051);
    }
    expect(seen.estimate).toBeGreaterThan(100);
    for (const k of ["none", "few", "gap", "uncovered"] as const) expect(seen[k], k).toBeGreaterThan(5);
    expect(seen.service).toBeGreaterThan(100);
    expect(seen.removed).toBeGreaterThan(100);
  });
});

// ═══ Firewood ═══════════════════════════════════════════════════════════════════

describe("firewood stays on its budget and draws", () => {
  it("is always gated with a reason and no number, even with purchases in two seasons", () => {
    const one = firewoodFacts([pay("2026-01-08", "315"), pay("2026-02-20", "315")], NOW);
    expect(one.seasons).toBe(1);
    const r = firewoodResult(one);
    expect(r.status).toBe("gated");
    expect(Object.keys(r).sort()).toEqual(["kind", "reason", "status"]);
    expect(r.reason).toMatch(/2 purchases in 1 heating season/);
    expect(r.reason).toMatch(/budget line and your entered draws/);
    const two = firewoodFacts([pay("2025-01-08", "300"), pay("2026-01-08", "315"), pay("2026-07-01", "100")], NOW);
    expect(two.seasons).toBe(3); // Jan 2025 = season 2024, Jan 2026 = season 2025, Jul 2026 = season 2026
    expect(firewoodResult(two).status).toBe("gated");
    expect(firewoodResult(firewoodFacts([], NOW)).reason).toMatch(/No firewood purchases/);
  });
});

// ═══ Which transactions count for which house ═══════════════════════════════════

const E_PERSONAL: EnergyEntityRef = { id: "ent-p", name: "Personal", slug: "personal" };
const E_SV: EnergyEntityRef = { id: "ent-sv", name: "Sudden Valley Property Management, LLC", slug: "sudden-valley" };
const E_EKC: EnergyEntityRef = { id: "ent-ekc", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting" };
const E_MEZZO: EnergyEntityRef = { id: "ent-mz", name: "Mezzo", slug: "mezzo" };
const ALL = [E_PERSONAL, E_SV, E_EKC, E_MEZZO];

const L_ELEC_P: SeasonalLineRef = { entityId: "ent-p", tagId: "t-ep", tagName: "Utilities / Electric (Eversource)", kind: "electric" };
const L_OIL_P: SeasonalLineRef = { entityId: "ent-p", tagId: "t-op", tagName: "Utilities / Oil", kind: "oil" };
const L_WOOD_P: SeasonalLineRef = { entityId: "ent-p", tagId: "t-wp", tagName: "Utilities / Firewood", kind: "firewood" };
const L_ELEC_SV: SeasonalLineRef = { entityId: "ent-sv", tagId: "t-esv", tagName: "Arbor Retreat / Electricity", kind: "electric" };
const L_OIL_SV: SeasonalLineRef = { entityId: "ent-sv", tagId: "t-osv", tagName: "Arbor Retreat / Oil", kind: "oil" };

let txSeq = 0;
function tx(entityId: string, date: string, outflow: string, payee: string, tagPaths: string[] = [], account = "Acct"): RawEnergyTx {
  return { id: `tx${++txSeq}`, date: D(date), amount: new Decimal(outflow).negated(), entityId, payee, account, tagPaths };
}

describe("selectSitePayments: which entity's rows count for which house", () => {
  const txs: RawEnergyTx[] = [
    tx("ent-p", "2026-05-05", "161.51", "eversource", ["Utilities / Electric (Eversource)"]),
    tx("ent-p", "2026-06-05", "99", "eversource"), // untagged, payee decides
    tx("ent-p", "2026-07-05", "55", "pse&g", ["Utilities / Electric (Eversource)"]), // tag decides
    tx("ent-sv", "2026-05-08", "79.81", "eversource", ["Arbor Retreat / Electricity"]),
    tx("ent-ekc", "2026-02-09", "67.10", "mccarthy heating oil serv 860 4432839 ct", ["Business Expenses / Eric / Eric Kinniburgh Consulting LLC / Utilities / Propane (heat)"], "Capital One"),
    tx("ent-ekc", "2025-12-02", "679.65", "mccarthy heating oil serv 860 4432839 ct", ["Utilities / Oil"], "Capital One"),
    tx("ent-ekc", "2025-11-19", "200", "eversource web pay"), // an EKC Eversource payment is NOT the house's
    tx("ent-sv", "2026-08-01", "300", "mccarthy heating oil", ["Arbor Retreat / Oil"]),
    tx("ent-mz", "2026-03-01", "100", "mccarthy heating oil"), // Mezzo is not named for the house
    tx("ent-p", "2026-04-05", "804.60", "mccarthy heating oil"),
    tx("ent-p", "2026-01-08", "315", "check 227", ["Utilities / Firewood"]),
    tx("ent-ekc", "2026-01-09", "315", "firewood guy"), // another entity's firewood is not Personal's
  ];

  it("Personal: its own electric by payee or tag; oil from its own books AND the EK Consulting rows (McCarthy payee only); firewood own only", () => {
    const r = selectSitePayments(txs, E_PERSONAL, [L_ELEC_P, L_OIL_P, L_WOOD_P], ALL);
    expect(r.electric.map((p) => p.amount.negated().toFixed(2)).sort()).toEqual(["161.51", "55.00", "99.00"]);
    expect(r.oil.map((p) => [p.date.toISOString().slice(0, 10), p.fromOtherEntity])).toEqual([
      ["2025-12-02", "Eric Kinniburgh Consulting, LLC"],
      ["2026-02-09", "Eric Kinniburgh Consulting, LLC"],
      ["2026-04-05", null],
    ]);
    expect(r.firewood).toHaveLength(1);
    expect(r.firewood[0]!.account).toBe("Acct");
  });

  it("Sudden Valley: only its own rows, never the Personal or EK Consulting McCarthy / Eversource payments", () => {
    const r = selectSitePayments(txs, E_SV, [L_ELEC_SV, L_OIL_SV], ALL);
    expect(r.electric.map((p) => p.amount.negated().toFixed(2))).toEqual(["79.81"]);
    expect(r.oil.map((p) => p.amount.negated().toFixed(2))).toEqual(["300.00"]);
    expect(r.oil.every((p) => p.fromOtherEntity === null)).toBe(true);
    expect(r.firewood).toEqual([]);
  });

  it("the cross-entity inclusion needs the house to HAVE an oil line, and is only for McCarthy rows", () => {
    const noOil = selectSitePayments(txs, E_PERSONAL, [L_ELEC_P], ALL);
    expect(noOil.oil).toEqual([]);
    const ekcElectricOnly = selectSitePayments(txs, E_PERSONAL, [L_ELEC_P, L_OIL_P], ALL);
    expect(ekcElectricOnly.electric.map((p) => p.amount.negated().toFixed(2)).sort()).toEqual(["161.51", "55.00", "99.00"]); // the EKC Eversource row is not here
  });

  it("an entity without site facts gets no cross-entity rows at all", () => {
    const stranger: EnergyEntityRef = { id: "ent-x", name: "Other", slug: "other" };
    const r = selectSitePayments(txs, stranger, [{ entityId: "ent-x", tagId: "t", tagName: "X / Oil", kind: "oil" }], [...ALL, stranger]);
    expect(r.oil).toEqual([]);
  });

  it("rows come back oldest first", () => {
    const r = selectSitePayments(txs, E_PERSONAL, [L_OIL_P], ALL);
    const dates = r.oil.map((p) => p.date.getTime());
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
  });
});

describe("buildSiteEnergy", () => {
  const base = {
    entities: ALL,
    priceEntries: [] as OilPriceEntry[],
    flatMonthly: { electric: new Decimal("172"), oil: new Decimal("308") },
    replaceDraws: false,
    now: NOW,
  };
  const personalTxs = [
    ...REAL_ELECTRIC.map(([d, a]) => tx("ent-p", d, a, "eversource", ["Utilities / Electric (Eversource)"])),
    tx("ent-ekc", "2025-12-02", "679.65", "mccarthy heating oil serv 860 4432839 ct", ["Utilities / Oil"], "Capital One"),
    tx("ent-ekc", "2025-10-31", "292.46", "mccarthy heating oil serv860 4432839ct", [], "Capital One"),
    tx("ent-p", "2026-09-11", "292.46", "mccarthy heating oil ser", ["Home & Property / Home Repair"]),
    tx("ent-p", "2026-10-08", "1529.50", "mccarthy heating oil", ["Utilities / Oil"]),
  ];

  it("Personal: an electric plan (gate passed), no oil plan (no prices), firewood gated; notes carry the owner statements", () => {
    const s = buildSiteEnergy({ ...base, entity: E_PERSONAL, lines: [L_ELEC_P, L_OIL_P, L_WOOD_P], txs: personalTxs });
    expect(s.plans.map((p) => [p.kind, p.lineKey])).toEqual([["electric", "ent-p|t-ep"]]);
    expect(s.electric?.result.status).toBe("estimate");
    expect(s.oil?.result.status).toBe("gated");
    expect(s.firewood?.result.status).toBe("gated");
    expect(s.siteNotes.join(" ")).toMatch(/solar \(live since Mar 2023\)/);
    expect(s.siteNotes.join(" ")).toMatch(/charged to another entity's card by mistake/);
    expect(s.siteNotes.join(" ")).toMatch(/bookkeeping and tax implications/);
    expect(s.oil!.facts.service?.dates).toEqual(["2025-10-31", "2026-09-11"]);
    const plan = s.plans[0]!;
    expect(plan.monthly).toHaveLength(12);
    expect(plan.monthly[2]!.toFixed(2)).toBe("482.35"); // March, season mean
    expect(plan.replaceDraws).toBe(false);
  });

  it("with two prices the oil plan appears: 12 equal months, replaceDraws copied from the setting", () => {
    const s = buildSiteEnergy({
      ...base,
      replaceDraws: true,
      priceEntries: [price("a", "2025-10-01", "4.00"), price("b", "2026-06-01", "3.50")],
      entity: E_PERSONAL,
      lines: [L_ELEC_P, L_OIL_P],
      txs: personalTxs,
    });
    const oil = s.plans.find((p) => p.kind === "oil")!;
    expect(oil.monthly.every((m) => m !== null && m.equals(oil.monthly[0]!))).toBe(true);
    expect(oil.replaceDraws).toBe(true);
    expect(oil.basis).toMatch(/yearly furnace service/);
    expect(s.siteNotes.join(" ")).toMatch(/Some McCarthy oil payments/);
  });

  it("a net credit month makes no outflow estimate (null) but stays in the model", () => {
    const credits = [
      tx("ent-p", "2026-04-05", "-60", "eversource"),
      tx("ent-p", "2026-05-05", "-55", "eversource"),
      tx("ent-p", "2026-06-05", "-40", "eversource"),
      tx("ent-p", "2026-07-05", "-30", "eversource"),
      tx("ent-p", "2025-12-05", "300", "eversource"),
      tx("ent-p", "2026-01-05", "400", "eversource"),
    ];
    const s = buildSiteEnergy({ ...base, now: new Date("2026-07-20T00:00:00Z"), entity: E_PERSONAL, lines: [L_ELEC_P], txs: credits });
    expect(s.electric?.result.status).toBe("estimate");
    const plan = s.plans[0]!;
    expect(plan.monthly[3]).toBeNull(); // April nets to a credit: no outflow in the cash-flow forecast
    expect(plan.monthly[0]!.greaterThan(0)).toBe(true);
  });

  it("Sudden Valley: its own history, its own notes, and none of the Personal solar text", () => {
    const svTxs = [
      ...[["2026-05-08", "79.81"], ["2026-06-09", "70.97"], ["2026-07-13", "127.11"], ["2026-08-11", "237.43"], ["2026-09-14", "237.58"]].map(([d, a]) => tx("ent-sv", d!, a!, "eversource", ["Arbor Retreat / Electricity"])),
      ...personalTxs,
    ];
    const s = buildSiteEnergy({ ...base, entity: E_SV, lines: [L_ELEC_SV, L_OIL_SV], txs: svTxs, flatMonthly: { electric: new Decimal("100"), oil: new Decimal("240") } });
    expect(s.plans).toEqual([]);
    expect(s.electric?.result.status).toBe("gated");
    expect(s.electric?.history.map((m) => m.period)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(s.oil?.result.status).toBe("gated");
    expect(s.oil?.facts.payments).toEqual([]); // the Personal / EK McCarthy rows never reach Sudden Valley
    expect(s.siteNotes.join(" ")).toMatch(/short-term rental since Apr 2026/);
    expect(s.siteNotes.join(" ")).not.toMatch(/solar/i);
  });

  it("Sudden Valley with a full year would say it is a rental in the basis", () => {
    const svTxs = ["2025-11", "2025-12", "2026-01", "2026-02", "2026-04", "2026-05", "2026-08", "2026-09"].map((p) => tx("ent-sv", `${p}-10`, "100", "eversource"));
    const s = buildSiteEnergy({ ...base, entity: E_SV, lines: [L_ELEC_SV], txs: svTxs });
    expect(s.electric?.result.status).toBe("estimate");
    if (s.electric?.result.status !== "estimate") return;
    expect(s.electric.result.basis).toMatch(/short-term rental since Apr 2026/);
    expect(s.electric.result.basis).not.toMatch(/solar/i);
  });
});

describe("plan lookups", () => {
  const plans: BillSeasonalPlan[] = [
    { kind: "electric", entityId: "ent-p", lineKey: "ent-p|t-ep", lineLabel: "Electric", monthly: Array(12).fill(new Decimal(100)), confidence: "low", basis: "b", shortBasis: "sb", replaceDraws: false },
    { kind: "oil", entityId: "ent-sv", lineKey: "ent-sv|t-osv", lineLabel: "Oil", monthly: Array(12).fill(new Decimal(200)), confidence: "low", basis: "b", shortBasis: "sb", replaceDraws: false },
  ];
  it("by Budget link; the link wins over the payee; never across entities", () => {
    expect(planForBill(plans, { entityId: "ent-p", budgetTagId: "t-ep", budgetEntityId: "ent-p", payee: "Electric (Eversource)" })).toBe(plans[0]);
    expect(planForBill(plans, { entityId: "ent-p", budgetTagId: "t-other", budgetEntityId: "ent-p", payee: "Eversource" })).toBeNull();
    expect(planForBill(plans, { entityId: "ent-sv", budgetTagId: "t-ep", budgetEntityId: "ent-sv", payee: "Eversource" })).toBeNull();
  });
  it("an unlinked bill matches on its own entity and a supplier payee (Sudden Valley's bills today)", () => {
    expect(planForBill(plans, { entityId: "ent-sv", budgetTagId: null, budgetEntityId: null, payee: "McCarthy Oil (Arbor Retreat)" })).toBe(plans[1]);
    expect(planForBill(plans, { entityId: "ent-sv", payee: "Eversource (Arbor Retreat)" })).toBeNull(); // no electric plan for SV
    expect(planForBill(plans, { entityId: "ent-p", payee: "McCarthy Heating & Oil" })).toBeNull(); // Personal has no oil plan
    expect(planForBill(plans, { payee: "Eversource" })).toBeNull();
    expect(planForBill(null, { entityId: "ent-p", payee: "Eversource" })).toBeNull();
    expect(planForBill([], { entityId: "ent-p", payee: "Eversource" })).toBeNull();
  });
  it("planForLine and planAmountForMonth", () => {
    expect(planForLine(plans, "ent-p", "t-ep")).toBe(plans[0]);
    expect(planForLine(plans, "ent-p", "nope")).toBeNull();
    expect(planForLine(undefined, "ent-p", "t-ep")).toBeNull();
    expect(planAmountForMonth(plans[0]!, 3)?.toFixed(2)).toBe("100.00");
  });
  it("billMatchesLine mirrors planForBill", () => {
    const line = { entityId: "ent-sv", tagId: "t-osv", kind: "oil" as const };
    expect(billMatchesLine({ entityId: "ent-sv", payee: "McCarthy Oil (Arbor Retreat)" }, line)).toBe(true);
    expect(billMatchesLine({ entityId: "ent-p", payee: "McCarthy Heating & Oil" }, line)).toBe(false);
    expect(billMatchesLine({ entityId: "ent-p", budgetTagId: "t-osv", budgetEntityId: "ent-sv", payee: "x" }, line)).toBe(true);
  });
});
