import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  electricUsageEstimate,
  firewoodUsageEstimate,
  oilUsageEstimate,
  olsFit,
  seasonLabel,
  seasonOfIso,
  smooth3,
  usageInfo,
  type UsageRow,
} from "@/lib/seasonal-energy-usage";
import { ENERGY_SITE_FACTS, type ElectricEstimate, type FirewoodEstimate, type Gated, type OilEstimate } from "@/lib/seasonal-energy";
import type { OilPriceEntry } from "@/lib/seasonal-energy-prices";

// Every number below is synthetic. NOW is 2026-10-10, so the last complete month is 2026-09.
const NOW = new Date("2026-10-10T12:00:00.000Z");
const PERSONAL = ENERGY_SITE_FACTS.personal!;
const SV = ENERGY_SITE_FACTS["sudden-valley"]!;
const D = (v: number | string) => new Decimal(v);

let seq = 0;
function row(kind: UsageRow["kind"], period: string, qty: number | string, cost: number | string | null = null, over: Partial<UsageRow> = {}): UsageRow {
  seq += 1;
  return {
    id: `r${seq}`,
    kind,
    period,
    occurredOn: over.occurredOn ?? `${period}-01`,
    quantity: D(qty),
    unit: kind === "electric" ? "kwh" : kind === "oil" ? "gal" : "cord",
    cost: cost === null ? null : D(cost),
    note: null,
    ...over,
  };
}

function periodsBack(lastPeriod: string, count: number): string[] {
  const idx = Number(lastPeriod.slice(0, 4)) * 12 + Number(lastPeriod.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, i) => {
    const t = idx - (count - 1 - i);
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
  });
}

const monthOf = (p: string) => Number(p.slice(5, 7));
/** A synthetic seasonal kWh curve: high in winter, low in spring. */
const kwhCurve = (month: number, year = 0) => 600 + [300, 260, 150, 20, -80, -100, -60, -90, -40, 40, 160, 280][month - 1]! + year * 10;

function electricRows(months: number, costOf?: (kwh: number) => number): UsageRow[] {
  return periodsBack("2026-09", months).map((p) => {
    const k = kwhCurve(monthOf(p), Number(p.slice(0, 4)) - 2024);
    return row("electric", p, k, costOf ? costOf(k) : null);
  });
}

const est = <T extends { status: string }>(r: T | Gated) => {
  if (r.status !== "estimate") throw new Error(`expected an estimate, got: ${(r as Gated).reason}`);
  return r as T;
};
const gate = (r: { status: string }) => {
  if (r.status !== "gated") throw new Error("expected a gate");
  return (r as Gated).reason;
};

describe("smooth3", () => {
  it("spreads a value over its neighbours, wraps Dec to Jan and preserves the sum", () => {
    const v = Array.from({ length: 12 }, () => D(0));
    v[11] = D(300);
    const s = smooth3(v);
    expect(s.map((x) => x.toNumber())).toEqual([100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 100]);
    const w = Array.from({ length: 12 }, (_, i) => D(i * 7 + 1));
    expect(smooth3(w).reduce((a, b) => a.plus(b), D(0)).toFixed(10)).toBe(w.reduce((a, b) => a.plus(b), D(0)).toFixed(10));
  });
});

describe("olsFit", () => {
  it("recovers an exact line and rejects no spread", () => {
    const pts = [1, 2, 3, 4, 5].map((x) => ({ x: D(x), y: D(10 + 2 * x) }));
    const f = olsFit(pts)!;
    expect(f.a.toFixed(6)).toBe("10.000000");
    expect(f.b.toFixed(6)).toBe("2.000000");
    expect(f.r2.toFixed(6)).toBe("1.000000");
    expect(olsFit([1, 1, 1].map((x) => ({ x: D(x), y: D(x) })))).toBeNull();
    expect(olsFit([{ x: D(1), y: D(1) }])).toBeNull();
  });
});

describe("electricUsageEstimate: gates", () => {
  it("names the missing calendar months", () => {
    const rows = electricRows(12).filter((r) => ![3, 6].includes(monthOf(r.period)));
    const reason = gate(electricUsageEstimate({ rows, now: NOW, site: SV, paymentAnnual: D(3000) }));
    expect(reason).toMatch(/missing Mar, Jun/);
    expect(reason).toMatch(/all 12 calendar months are needed/);
  });

  it("ignores the unfinished current month and anything later", () => {
    const rows = [...electricRows(12), row("electric", "2026-10", 900), row("electric", "2026-11", 900)];
    const e = est<ElectricEstimate>(electricUsageEstimate({ rows, now: NOW, site: SV, paymentAnnual: D(3000) }));
    expect(e.observedMonths).toBe(12);
    // October's kWh is the 2025-10 value, not the unfinished 2026-10 row
    const oct = e.months[9]!;
    expect(oct.ownObservations).toBe(1);
  });

  it("gates when the newest month on file is more than 24 months old", () => {
    const old = periodsBack("2024-08", 12).map((p) => row("electric", p, kwhCurve(monthOf(p))));
    expect(gate(electricUsageEstimate({ rows: old, now: NOW, site: SV, paymentAnnual: D(3000) }))).toMatch(/more than 24 months ago/);
    const edge = periodsBack("2024-10", 12).map((p) => row("electric", p, kwhCurve(monthOf(p))));
    est(electricUsageEstimate({ rows: edge, now: NOW, site: SV, paymentAnnual: D(3000) }));
  });

  it("drops months before solar went live (March 2023 inclusive) and says so", () => {
    const pre = periodsBack("2023-02", 12).map((p) => row("electric", p, kwhCurve(monthOf(p))));
    const r1 = electricUsageEstimate({ rows: pre, now: NOW, site: PERSONAL, paymentAnnual: D(3000) });
    expect(gate(r1)).toMatch(/before solar went live/);
    // 2022-10..2026-09: the five months before March 2023 are dropped, March 2023 itself is used
    const ok = est<ElectricEstimate>(electricUsageEstimate({ rows: electricRows(48), now: NOW, site: PERSONAL, paymentAnnual: D(3000) }));
    expect(ok.observedMonths).toBe(43);
    expect(ok.basis).toMatch(/5 months from before solar went live \(Mar 2023\) are kept but not used/);
    expect(ok.months[9]!.ownObservations).toBe(3); // October: 2023, 2024 and 2025 (2022-10 is before solar)
    expect(ok.months[2]!.ownObservations).toBe(3); // March: the latest 3 of 2023..2026
  });
});

describe("electricUsageEstimate: kWh shape with the payments level (tier B)", () => {
  it("equals paymentAnnual x K / sum K per month, capped at low with one year", () => {
    const rows = electricRows(12);
    const e = est<ElectricEstimate>(electricUsageEstimate({ rows, now: NOW, site: SV, paymentAnnual: D(3600) }));
    expect(e.method).toBe("usage_shape");
    const k = rows.map((r) => r.quantity);
    const total = k.reduce((a, b) => a.plus(b), D(0));
    for (const m of e.months) {
      const row = rows.find((r) => monthOf(r.period) === m.month)!;
      expect(m.amount.toFixed(2)).toBe(D(3600).times(row.quantity).div(total).toDecimalPlaces(2).toFixed(2));
      expect(m.basis).toBe("usage");
      expect(m.ownObservations).toBe(1);
    }
    expect(e.annual.toFixed(2)).toBe(e.months.reduce((a, m) => a.plus(m.amount), D(0)).toFixed(2));
    expect(Math.abs(e.annual.minus(3600).toNumber())).toBeLessThan(0.07);
    expect(e.confidence).toBe("low");
    expect(e.basis).toMatch(/in proportion to kWh \(a fixed monthly charge is not separated\)/);
    expect(e.basis).not.toMatch(/per kWh, measured/);
  });

  it("is medium with two years of every month and never high", () => {
    const two = est<ElectricEstimate>(electricUsageEstimate({ rows: electricRows(24), now: NOW, site: SV, paymentAnnual: D(3600) }));
    expect(two.confidence).toBe("medium");
    const three = est<ElectricEstimate>(electricUsageEstimate({ rows: electricRows(36), now: NOW, site: SV, paymentAnnual: D(3600) }));
    expect(three.confidence).toBe("medium");
    expect(three.months[0]!.ownObservations).toBe(3);
  });

  it("uses the latest 3 years of a month, and the range is their lowest and highest", () => {
    const rows = [...electricRows(48)];
    const e = est<ElectricEstimate>(electricUsageEstimate({ rows, now: NOW, site: SV, paymentAnnual: D(3600) }));
    const jan = rows.filter((r) => monthOf(r.period) === 1).sort((a, b) => (a.period < b.period ? 1 : -1)).slice(0, 3);
    expect(e.months[0]!.ownObservations).toBe(3);
    const total = rows
      .reduce<Record<number, UsageRow[]>>((acc, r) => ((acc[monthOf(r.period)] ??= []).push(r), acc), {})
    ;
    const sumK = Object.values(total).reduce((a, list) => {
      const latest = list.sort((x, y) => (x.period < y.period ? 1 : -1)).slice(0, 3);
      return a.plus(latest.reduce((s, r) => s.plus(r.quantity), D(0)).div(latest.length));
    }, D(0));
    const kMin = Decimal.min(...jan.map((r) => r.quantity));
    const kMax = Decimal.max(...jan.map((r) => r.quantity));
    expect(e.months[0]!.low.toFixed(2)).toBe(D(3600).times(kMin).div(sumK).toDecimalPlaces(2).toFixed(2));
    expect(e.months[0]!.high.toFixed(2)).toBe(D(3600).times(kMax).div(sumK).toDecimalPlaces(2).toFixed(2));
  });

  it("gates (no number) when the dollars are unknown", () => {
    const g = electricUsageEstimate({ rows: electricRows(12), now: NOW, site: SV, paymentAnnual: null });
    expect(g).toEqual({ status: "gated", kind: "electric", reason: expect.stringMatching(/give the shape, but the dollars are unknown/) });
    expect(Object.keys(g).sort()).toEqual(["kind", "reason", "status"]);
  });
});

describe("electricUsageEstimate: measured price per kWh (tier A)", () => {
  const line = (kwh: number) => 20 + 0.15 * kwh;

  it("fits cost = a + b kWh from paired months and applies it at each month's average kWh", () => {
    const rows = electricRows(36, line);
    const e = est<ElectricEstimate>(electricUsageEstimate({ rows, now: NOW, site: SV, paymentAnnual: null }));
    expect(e.method).toBe("usage_paired");
    expect(e.confidence).toBe("high"); // 3 years, R2 = 1
    for (const m of e.months) {
      const mine = rows.filter((r) => monthOf(r.period) === m.month);
      const k = mine.reduce((a, r) => a.plus(r.quantity), D(0)).div(mine.length);
      expect(m.amount.toFixed(2)).toBe(D(20).plus(D("0.15").times(k)).toDecimalPlaces(2).toFixed(2));
    }
    expect(e.basis).toMatch(/\$20\.00 a month fixed plus \$0\.1500 per kWh, measured from 36 paired months/);
  });

  it("needs 12 paired months over 8 calendar months", () => {
    const eleven = electricRows(12).map((r, i) => (i === 0 ? r : { ...r, cost: D(line(r.quantity.toNumber())) }));
    const e = est<ElectricEstimate>(electricUsageEstimate({ rows: eleven, now: NOW, site: SV, paymentAnnual: D(3000) }));
    expect(e.method).toBe("usage_shape"); // only 11 paired months
    expect(e.basis).toMatch(/11 months? have a dollar amount/);
  });

  it("falls back to the shape when the slope is negative or the fit is weak", () => {
    const neg = electricRows(24, (k) => 400 - 0.2 * k);
    const a = est<ElectricEstimate>(electricUsageEstimate({ rows: neg, now: NOW, site: SV, paymentAnnual: D(3000) }));
    expect(a.method).toBe("usage_shape");
    expect(a.basis).toMatch(/did not give a usable price per kWh/);
    // weak: cost unrelated to kWh
    let flip = 0;
    const weak = electricRows(24, () => 100 + ((flip++ * 37) % 91));
    const b = est<ElectricEstimate>(electricUsageEstimate({ rows: weak, now: NOW, site: SV, paymentAnnual: D(3000) }));
    expect(b.method).toBe("usage_shape");
    // and with no payments level at all it is gated, naming the rate problem
    expect(gate(electricUsageEstimate({ rows: neg, now: NOW, site: SV, paymentAnnual: null }))).toMatch(/usable price per kWh/);
  });

  it("confidence ladder: 3 years high, 2 medium, 1 low; R2 below 0.8 drops one step", () => {
    const conf = (months: number, cost: (k: number) => number) =>
      est<ElectricEstimate>(electricUsageEstimate({ rows: electricRows(months, cost), now: NOW, site: SV, paymentAnnual: null })).confidence;
    expect(conf(36, line)).toBe("high");
    expect(conf(24, line)).toBe("medium");
    expect(conf(12, line)).toBe("low");
    // add a deterministic wobble so R2 lands between 0.5 and 0.8
    let i = 0;
    const wobble = (k: number) => line(k) + (((i++ * 53) % 100) - 50) * 0.45;
    const r = est<ElectricEstimate>(electricUsageEstimate({ rows: electricRows(36, wobble), now: NOW, site: SV, paymentAnnual: null }));
    const m = r.basis.match(/R2 (\d\.\d\d)/);
    expect(m).not.toBeNull();
    const r2 = Number(m![1]);
    expect(r2).toBeGreaterThanOrEqual(0.5);
    expect(r2).toBeLessThan(0.8);
    expect(r.confidence).toBe("medium"); // three years would be high; R2 below 0.8 drops one step
  });

  it("widens a month with a single year of kWh by one standard error", () => {
    // 11 calendar months have 2 years, one has 1 year; noise gives a nonzero standard error
    let i = 0;
    const noisy = (k: number) => line(k) + (((i++ * 29) % 21) - 10) * 0.3;
    const rows = electricRows(24, noisy).filter((r) => !(monthOf(r.period) === 5 && r.period < "2026-01"));
    const e = est<ElectricEstimate>(electricUsageEstimate({ rows, now: NOW, site: SV, paymentAnnual: null }));
    const may = e.months[4]!;
    const jan = e.months[0]!;
    expect(may.ownObservations).toBe(1);
    expect(may.high.minus(may.low).toNumber()).toBeGreaterThan(0);
    expect(jan.ownObservations).toBe(2);
  });

  it("keeps a credit (negative or near-zero) month: a negative amount is kept in the table", () => {
    const rows = electricRows(36, (k) => -400 + 0.5 * k);
    const e = est<ElectricEstimate>(electricUsageEstimate({ rows, now: NOW, site: SV, paymentAnnual: null }));
    expect(e.months.some((m) => m.amount.isNegative())).toBe(true);
    expect(e.annual.toFixed(2)).toBe(e.months.reduce((a, m) => a.plus(m.amount), D(0)).toFixed(2));
  });
});

describe("oilUsageEstimate", () => {
  const price = (p: string, on = "2026-01-01"): OilPriceEntry => ({ id: `p${p}`, effectiveOn: on, pricePerGal: p });
  // Window 0 is 2025-10..2026-09.
  const deliveries = (): UsageRow[] => [
    row("oil", "2025-10", 200, null, { occurredOn: "2025-10-15" }),
    row("oil", "2026-02", 150, null, { occurredOn: "2026-02-10" }),
    row("oil", "2026-05", 100, null, { occurredOn: "2026-05-05" }),
  ];

  it("one complete window gives annual gallons G and a smooth3 shape that sums to G", () => {
    const e = est<OilEstimate>(oilUsageEstimate({ rows: deliveries(), entries: [price("4.0000")], now: NOW }));
    expect(e.method).toBe("usage");
    expect(e.impliedGallons.toFixed(0)).toBe("450");
    // gallons by calendar month: Oct 200, Feb 150, May 100
    const g = Array.from({ length: 12 }, () => D(0));
    g[9] = D(200);
    g[1] = D(150);
    g[4] = D(100);
    const s = smooth3(g);
    expect(e.byMonth!.map((x) => x.toFixed(2))).toEqual(s.map((x) => x.times(4).toDecimalPlaces(2).toFixed(2)));
    expect(e.annual.toFixed(2)).toBe(e.byMonth!.reduce((a, b) => a.plus(b), D(0)).toFixed(2));
    expect(Math.abs(e.annual.minus(1800).toNumber())).toBeLessThan(0.07);
    expect(e.confidence).toBe("low");
    expect(e.sensitivity.toFixed(2)).toBe("225.00");
    expect(e.monthly.toFixed(2)).toBe(e.annual.div(12).toDecimalPlaces(2).toFixed(2));
  });

  it("with one year the range equals the estimate and the basis says so", () => {
    const e = est<OilEstimate>(oilUsageEstimate({ rows: deliveries(), entries: [price("4.0000")], now: NOW }));
    for (let m = 0; m < 12; m++) {
      expect(e.byMonthRange![m]!.low.toFixed(2)).toBe(e.byMonth![m]!.toFixed(2));
      expect(e.byMonthRange![m]!.high.toFixed(2)).toBe(e.byMonth![m]!.toFixed(2));
    }
    expect(e.basis).toMatch(/no range/);
  });

  it("wraps December deliveries into January", () => {
    const rows = [row("oil", "2025-12", 300, null, { occurredOn: "2025-12-20" })];
    const e = est<OilEstimate>(oilUsageEstimate({ rows: [row("oil", "2025-10", 0.5), ...rows], entries: [price("3.0000")], now: NOW }));
    // Dec 300 + Oct 0.5: Nov, Dec, Jan each get 100 from the December delivery
    expect(e.byMonth![11]!.toNumber()).toBeGreaterThan(299.9);
    expect(e.byMonth![0]!.toNumber()).toBeGreaterThan(299.9);
  });

  it("a month with two deliveries adds them", () => {
    const rows = [...deliveries(), row("oil", "2026-02", 50, null, { occurredOn: "2026-02-25" })];
    const e = est<OilEstimate>(oilUsageEstimate({ rows, entries: [price("4.0000")], now: NOW }));
    expect(e.impliedGallons.toFixed(0)).toBe("500");
  });

  it("gates when the first listed delivery is after the start of the only window, naming the dates", () => {
    const rows = [row("oil", "2025-11", 200, null, { occurredOn: "2025-11-15" })];
    const r = gate(oilUsageEstimate({ rows, entries: [price("4.0000")], now: NOW }));
    expect(r).toMatch(/starts in Nov 2025/);
    expect(r).toMatch(/Oct 2025 to Sep 2026/);
  });

  it("a first row in the window's first month is complete; one month later is not", () => {
    est(oilUsageEstimate({ rows: [row("oil", "2025-10", 200, null, { occurredOn: "2025-10-31" })], entries: [price("4.0000")], now: NOW }));
  });

  it("gates when nothing was delivered in the newest window", () => {
    const rows = [row("oil", "2024-01", 200, null, { occurredOn: "2024-01-15" })];
    expect(gate(oilUsageEstimate({ rows, entries: [price("4.0000")], now: NOW }))).toMatch(/No oil delivery is listed in the last 12 months/);
  });

  it("2 windows give medium and 3 give high; the range is the min and max of the years", () => {
    const y1 = [row("oil", "2025-10", 200, null, { occurredOn: "2025-10-15" })];
    const y2 = [row("oil", "2024-10", 100, null, { occurredOn: "2024-10-15" })];
    const y3 = [row("oil", "2023-10", 300, null, { occurredOn: "2023-10-15" })];
    const two = est<OilEstimate>(oilUsageEstimate({ rows: [...y1, ...y2], entries: [price("4.0000")], now: NOW }));
    expect(two.confidence).toBe("medium");
    expect(two.byMonthRange![9]!.low.toFixed(2)).toBe(D(100).div(3).times(4).toDecimalPlaces(2).toFixed(2));
    expect(two.byMonthRange![9]!.high.toFixed(2)).toBe(D(200).div(3).times(4).toDecimalPlaces(2).toFixed(2));
    const three = est<OilEstimate>(oilUsageEstimate({ rows: [...y1, ...y2, ...y3], entries: [price("4.0000")], now: NOW }));
    expect(three.confidence).toBe("high");
    expect(three.impliedGallons.toFixed(0)).toBe("200"); // (200 + 100 + 300) / 3
  });

  it("gates with a specific message when there is no price and no priced delivery", () => {
    const r = gate(oilUsageEstimate({ rows: deliveries(), entries: [], now: NOW }));
    expect(r).toMatch(/enter today's price per gallon/);
    expect(r).toMatch(/450 a year/);
  });

  it("derives a labelled price from the newest paired delivery and caps confidence at medium", () => {
    const rows = [
      row("oil", "2025-10", 200, "720", { occurredOn: "2025-10-15" }),
      row("oil", "2026-02", 100, "400", { occurredOn: "2026-02-10" }),
      row("oil", "2024-10", 200, null, { occurredOn: "2024-10-15" }),
      row("oil", "2023-10", 200, null, { occurredOn: "2023-10-15" }),
    ];
    const e = est<OilEstimate>(oilUsageEstimate({ rows, entries: [], now: NOW }));
    expect(e.priceSource).toBe("delivery");
    expect(e.price.pricePerGal).toBe("4.0000"); // the newest paired delivery: Feb 2026, 400 / 100
    expect(e.confidence).toBe("medium"); // three windows would be high
    expect(e.basis).toMatch(/not today's price/);
  });

  it("the owner's price wins over a derived price and a price entered after today is ignored", () => {
    const rows = [row("oil", "2025-10", 200, "720", { occurredOn: "2025-10-15" })];
    const owner = est<OilEstimate>(oilUsageEstimate({ rows, entries: [price("3.5000", "2026-03-01")], now: NOW }));
    expect(owner.priceSource).toBe("owner");
    expect(owner.price).toEqual({ pricePerGal: "3.5000", effectiveOn: "2026-03-01" });
    const future = est<OilEstimate>(oilUsageEstimate({ rows, entries: [price("9.0000", "2027-03-01")], now: NOW }));
    expect(future.priceSource).toBe("delivery");
  });

  it("one price entry is enough; payments are information only", () => {
    const e = est<OilEstimate>(oilUsageEstimate({ rows: deliveries(), entries: [price("4.0000")], now: NOW, paymentsAsPaid: { total: D(1700), count: 3 } }));
    expect(e.basis).toMatch(/McCarthy payments over the last 12 months were \$1,700\.00 as paid/);
  });

  it("window boundaries when now is in January", () => {
    const jan = new Date("2027-01-15T12:00:00.000Z"); // last complete month is 2026-12; window 0 is 2026-01..2026-12
    const rows = [row("oil", "2026-01", 100, null, { occurredOn: "2026-01-05" })];
    const e = est<OilEstimate>(oilUsageEstimate({ rows, entries: [price("4.0000")], now: jan }));
    expect(e.impliedGallons.toFixed(0)).toBe("100");
    const late = [row("oil", "2026-02", 100, null, { occurredOn: "2026-02-05" })];
    expect(gate(oilUsageEstimate({ rows: late, entries: [price("4.0000")], now: jan }))).toMatch(/starts in Feb 2026/);
  });

  it("a delivery this month is not in the windows but still counts as listed", () => {
    const rows = [...deliveries(), row("oil", "2026-10", 999, null, { occurredOn: "2026-10-05" })];
    const e = est<OilEstimate>(oilUsageEstimate({ rows, entries: [price("4.0000")], now: NOW }));
    expect(e.impliedGallons.toFixed(0)).toBe("450");
  });
});

describe("firewoodUsageEstimate", () => {
  // Now is October 2026, so the current heating season (2026-27) is not finished; the last complete one is 2025-26.
  const wood = (iso: string, cost: number | null, qty = 2, unit = "cord"): UsageRow =>
    row("firewood", iso.slice(0, 7), qty, cost, { occurredOn: iso, unit });

  it("season helpers", () => {
    expect(seasonOfIso("2025-07-01")).toBe(2025);
    expect(seasonOfIso("2025-06-30")).toBe(2024);
    expect(seasonOfIso("2026-01-15")).toBe(2025);
    expect(seasonLabel(2024)).toBe("2024-25");
    expect(seasonLabel(2099)).toBe("2099-00");
  });

  it("one counted season is gated; two give a low-confidence estimate", () => {
    const one = [wood("2025-10-05", 500)];
    expect(gate(firewoodUsageEstimate({ rows: one, now: NOW }))).toMatch(/at least two complete heating seasons/);
    const two = [wood("2024-10-05", 500), wood("2025-11-02", 700)];
    const e = est<FirewoodEstimate>(firewoodUsageEstimate({ rows: two, now: NOW }));
    expect(e.confidence).toBe("low");
    expect(e.method).toBe("usage");
    // Oct average 250, Nov average 350, smoothed over neighbours
    const g = Array.from({ length: 12 }, () => D(0));
    g[9] = D(250);
    g[10] = D(350);
    expect(e.byMonth.map((x) => x.toFixed(2))).toEqual(smooth3(g).map((x) => x.toDecimalPlaces(2).toFixed(2)));
    expect(e.annual.toFixed(2)).toBe(e.byMonth.reduce((a, b) => a.plus(b), D(0)).toFixed(2));
    expect(Math.abs(e.annual.minus(600).toNumber())).toBeLessThan(0.07);
    expect(e.firstSeason).toBe(2024);
    expect(e.lastSeason).toBe(2025);
    expect(e.basis).toMatch(/2024-25 2 cords, \$500\.00; 2025-26 2 cords, \$700\.00/);
    // range: the two seasons' own smoothed values
    expect(e.byMonthRange[9]!.low.toFixed(2)).toBe(D(500).div(3).toDecimalPlaces(2).toFixed(2));
    expect(e.byMonthRange[9]!.high.toFixed(2)).toBe(D(700).div(3).toDecimalPlaces(2).toFixed(2));
  });

  it("a season with a cost-less purchase is skipped and named", () => {
    const rows = [wood("2023-10-05", 400), wood("2024-10-05", null), wood("2025-10-05", 600)];
    const e = est<FirewoodEstimate>(firewoodUsageEstimate({ rows, now: NOW }));
    expect(e.seasons.find((s) => s.season === 2024)).toMatchObject({ counted: false });
    expect(e.basis).toMatch(/Left out: 2024-25 \(1 purchase has no amount\)/);
    expect(e.annual.toNumber()).toBeGreaterThan(499);
    const gated = firewoodUsageEstimate({ rows: [wood("2024-10-05", null), wood("2025-10-05", 600)], now: NOW });
    expect(gate(gated)).toMatch(/2024-25: 1 purchase has no amount/);
  });

  it("a season between purchases with no row counts as no purchase; three seasons are medium; only the latest 3 are used", () => {
    const rows = [wood("2021-10-05", 9999), wood("2022-10-05", 300), wood("2024-10-05", 600), wood("2025-10-05", 900)];
    // seasons 2022 (300), 2023 (no row = 0), 2024 (600), 2025 (900): the latest 3 counted are 2023, 2024, 2025
    const e = est<FirewoodEstimate>(firewoodUsageEstimate({ rows, now: NOW }));
    expect(e.confidence).toBe("medium");
    expect(e.seasons.find((s) => s.season === 2023)).toMatchObject({ purchases: 0, cost: expect.anything() });
    expect(e.annual.toNumber()).toBeGreaterThan(499);
    expect(e.annual.toNumber()).toBeLessThan(501); // (0 + 600 + 900) / 3
  });

  it("ignores the unfinished current season, and gates when the history starts in it", () => {
    const rows = [wood("2024-10-05", 500), wood("2025-10-05", 700), wood("2026-09-01", 99999)];
    const e = est<FirewoodEstimate>(firewoodUsageEstimate({ rows, now: NOW }));
    expect(e.annual.toNumber()).toBeLessThan(700);
    const only = [wood("2026-08-01", 500)];
    expect(gate(firewoodUsageEstimate({ rows: only, now: NOW }))).toMatch(/not finished/);
  });

  it("keeps cords and face cords as entered in the basis (no conversion)", () => {
    const rows = [wood("2024-10-05", 500, 2, "cord"), wood("2024-11-05", 100, 1, "face_cord"), wood("2025-10-05", 700, 3, "cord")];
    const e = est<FirewoodEstimate>(firewoodUsageEstimate({ rows, now: NOW }));
    expect(e.seasons[0]!.quantity).toBe("2 cords + 1 face cord");
  });
});

describe("usageInfo", () => {
  it("summarises the rows and counts electric rows before solar", () => {
    const rows = [row("electric", "2023-01", 500), row("electric", "2023-04", 400), row("electric", "2024-04", 400)];
    expect(usageInfo(rows, "electric", PERSONAL)).toEqual({ count: 3, from: "2023-01", to: "2024-04", unit: "kWh", ignored: 1 });
    expect(usageInfo(rows, "electric", SV).ignored).toBe(0);
    expect(usageInfo([row("oil", "2024-04", 100)], "oil", PERSONAL).unit).toBe("gallons");
  });
});
