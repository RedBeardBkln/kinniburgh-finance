// TESTER (utility-usage-upload): pins added after the second mutation pass (survivors of the Coder's suite + my first
// oracle). Each block names the behaviour it protects. All numbers synthetic.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { electricUsageEstimate, firewoodUsageEstimate, oilUsageEstimate, olsFit, type UsageRow } from "@/lib/seasonal-energy-usage";
import { buildSiteEnergy, type RawEnergyTx } from "@/lib/seasonal-energy";
import { toUiSite } from "@/lib/seasonal-energy-view";
import { parseUsageText, type ColumnRole } from "@/lib/utility-usage-parse";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const NOW_IDX = 2026 * 12 + 9;
const perOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
let n = 0;
const erow = (period: string, kwh: number, cost: number | null): UsageRow => ({
  id: `e${++n}`, kind: "electric", period, occurredOn: `${period}-01`, quantity: new Decimal(kwh), unit: "kwh", cost: cost === null ? null : new Decimal(cost), note: null,
});
const orow = (period: string, day: string, gal: number, cost: number | null = null): UsageRow => ({
  id: `o${++n}`, kind: "oil", period, occurredOn: `${period}-${day}`, quantity: new Decimal(gal), unit: "gal", cost: cost === null ? null : new Decimal(cost), note: null,
});
const frow = (date: string, qty: number, cost: number | null): UsageRow => ({
  id: `f${++n}`, kind: "firewood", period: date.slice(0, 7), occurredOn: date, quantity: new Decimal(qty), unit: "cord", cost: cost === null ? null : new Decimal(cost), note: null,
});

describe("TESTER electric edge cases", () => {
  it("twelve zero-kWh months cannot give a shape (no divide by zero): gated", () => {
    const rows = Array.from({ length: 12 }, (_, m) => erow(perOf(NOW_IDX - 12 + m), 0, null));
    expect(electricUsageEstimate({ rows, now: NOW, site: null, paymentAnnual: new Decimal(1200) }).status).toBe("gated");
  });
  it("a NEGATIVE payments level (a solar net-credit year) keeps low <= amount <= high for every month", () => {
    const rows = Array.from({ length: 24 }, (_, m) => erow(perOf(NOW_IDX - 24 + m), 300 + ((m * 53) % 400), null));
    const e = electricUsageEstimate({ rows, now: NOW, site: null, paymentAnnual: new Decimal(-240) });
    expect(e.status).toBe("estimate");
    if (e.status !== "estimate") return;
    for (const m of e.months) {
      expect(m.low.lessThanOrEqualTo(m.amount)).toBe(true);
      expect(m.high.greaterThanOrEqualTo(m.amount)).toBe(true);
    }
    expect(e.annual.toFixed(2)).toBe(e.months.reduce((a, m) => a.plus(m.amount), new Decimal(0)).toFixed(2));
  });
  it("olsFit needs three points and some spread in x", () => {
    const p = (x: number, y: number) => ({ x: new Decimal(x), y: new Decimal(y) });
    expect(olsFit([p(1, 1), p(2, 2)])).toBeNull();
    expect(olsFit([p(1, 1), p(1, 2), p(1, 3)])).toBeNull();
    expect(olsFit([p(1, 1), p(2, 3), p(3, 2)])).not.toBeNull();
  });
});

describe("TESTER oil edge cases", () => {
  const owner = (...e: Array<[string, string]>) => e.map(([effectiveOn, pricePerGal], i) => ({ id: `p${i}`, effectiveOn, pricePerGal }));
  const recent = (): UsageRow[] => [orow("2026-02", "10", 100), orow("2025-01", "05", 1)];
  it("an owner entry effective TODAY is used; the latest of several entries wins; a future entry never does", () => {
    const a = oilUsageEstimate({ rows: recent(), entries: owner(["2026-10-10", "4.0000"], ["2026-01-01", "3.0000"], ["2026-12-01", "9.0000"]), now: NOW });
    expect(a.status === "estimate" && a.price.pricePerGal).toBe("4.0000");
    const b = oilUsageEstimate({ rows: recent(), entries: owner(["2026-03-01", "4.2000"], ["2025-01-01", "3.0000"]), now: NOW });
    expect(b.status === "estimate" && b.price.pricePerGal).toBe("4.2000");
  });
  it("derived delivery price: a priced delivery exactly 24 months ago is used, 25 months ago is not", () => {
    const base = [orow("2026-02", "10", 100)];
    const at24 = oilUsageEstimate({ rows: [...base, orow("2024-10", "05", 100, 400)], entries: [], now: NOW });
    expect(at24.status === "estimate" && at24.priceSource).toBe("delivery");
    const at25 = oilUsageEstimate({ rows: [...base, orow("2024-09", "05", 100, 400)], entries: [], now: NOW });
    expect(at25.status).toBe("gated");
  });
  it("only three years are used even when five are on file (older gallons cannot move the answer)", () => {
    const rows: UsageRow[] = [];
    for (const [y, gal] of [[2026, 100], [2025, 100], [2024, 100], [2023, 1000], [2022, 1000]] as const) rows.push(orow(`${y}-01`, "15", gal));
    const e = oilUsageEstimate({ rows, entries: [{ id: "p", effectiveOn: "2026-01-01", pricePerGal: "4.0000" }], now: NOW });
    expect(e.status).toBe("estimate");
    if (e.status !== "estimate") return;
    expect(e.impliedGallons.toFixed(0)).toBe("100");
    expect(e.confidence).toBe("high");
  });
  it("rows of other kinds mixed into the input are ignored", () => {
    const entries = [{ id: "p", effectiveOn: "2026-01-01", pricePerGal: "4.0000" }];
    const only = oilUsageEstimate({ rows: recent(), entries, now: NOW });
    const mixed = oilUsageEstimate({ rows: [...recent(), erow("2026-05", 9999, 1), frow("2025-09-01", 40, 5000)], entries, now: NOW });
    expect(JSON.stringify(mixed)).toBe(JSON.stringify(only));
  });
});

describe("TESTER firewood edge cases", () => {
  it("one complete season: the reason says seasons are missing, not that the history is unfinished", () => {
    const e = firewoodUsageEstimate({ rows: [frow("2025-09-01", 2, 500)], now: NOW });
    expect(e.status).toBe("gated");
    if (e.status === "gated") {
      expect(e.reason).toMatch(/1 complete heating season/);
      expect(e.reason).not.toMatch(/not finished/);
    }
    const unfinished = firewoodUsageEstimate({ rows: [frow("2026-09-01", 2, 500)], now: NOW });
    expect(unfinished.status === "gated" && unfinished.reason).toMatch(/not finished/);
  });
  it("rows of other kinds mixed into the input are ignored", () => {
    const rows = [frow("2023-09-01", 2, 500), frow("2024-09-01", 2, 600)];
    const only = firewoodUsageEstimate({ rows, now: NOW });
    const mixed = firewoodUsageEstimate({ rows: [...rows, erow("2026-05", 9999, 1), orow("2025-01", "05", 1)], now: NOW });
    expect(JSON.stringify(mixed)).toBe(JSON.stringify(only));
  });
});

describe("TESTER parser edge cases", () => {
  const T = "2026-10-10";
  const parse = (kind: "electric" | "oil", text: string, over: { mapping?: ColumnRole[] } = {}) => parseUsageText({ kind, text, today: T, site: { solarLiveFrom: null }, ...over });
  it("electric $2.00 per kWh is silent, above it warns", () => {
    const w = (cost: string) => {
      const o = parse("electric", `Month,kWh,Cost\n2025-01,100,${cost}\n`);
      return o.ok ? o.rows[0]!.warnings.length : -1;
    };
    expect(w("200.00")).toBe(0);
    expect(w("200.01")).toBe(1);
  });
  it("a billing period that starts and ends the same day is accepted; a half-day midpoint rounds down to the start month", () => {
    const mp: ColumnRole[] = ["month", "periodEnd", "quantity"];
    const same = parse("electric", "Start,End,kWh\n1/20/2025,1/20/2025,100\n", { mapping: mp });
    expect(same.ok && same.rows[0]).toMatchObject({ status: "new", period: "2025-01" });
    const half = parse("electric", "Start,End,kWh\n1/31/2025,2/1/2025,100\n", { mapping: mp });
    expect(half.ok && half.rows[0]).toMatchObject({ status: "new", period: "2025-01" });
  });
  it("a BOM before a quoted first cell of a header-less file is stripped (the quote still opens)", () => {
    const o = parse("electric", '﻿"2025-01",100\n"2025-02",110\n');
    expect(o.ok && o.rows.map((r) => r.status)).toEqual(["new", "new"]);
  });
  it("a comma-decimal number gets the comma-decimal message", () => {
    const e = parse("electric", "Month;kWh\n2025-01;12,5\n");
    expect(e.ok && e.rows[0]!.errors.join(" ")).toMatch(/comma decimal/);
  });
  it("two columns mapped to the quantity is a mapping error, never rows", () => {
    const o = parse("electric", "Month,kWh,Usage\n2025-01,100,200\n", { mapping: ["month", "quantity", "quantity"] });
    expect(o.ok && o.mappingError).toBeTruthy();
    expect(o.ok && o.rows).toEqual([]);
  });
});

describe("TESTER site-level wiring", () => {
  const ent = { id: "e1", name: "Sudden Valley", slug: "sudden-valley" };
  const lines = [
    { entityId: "e1", tagId: "t1", tagName: "Arbor Retreat / Electricity", kind: "electric" as const },
    { entityId: "e1", tagId: "t3", tagName: "Arbor Retreat / Firewood", kind: "firewood" as const },
  ];
  const mk = (usage: UsageRow[], txs: RawEnergyTx[] = []) =>
    buildSiteEnergy({ entity: ent, lines, txs, entities: [ent], priceEntries: [], flatMonthly: {}, replaceDraws: false, now: NOW, usage });

  it("a firewood plan carries the twelve different monthly figures; months with a zero estimate are null (no $0 event)", () => {
    const s = mk([frow("2024-10-05", 2, 600), frow("2025-10-05", 2, 600)]);
    expect(s.firewood!.result.status).toBe("estimate");
    const plan = s.plans.find((p) => p.kind === "firewood")!;
    expect(plan.monthly).toHaveLength(12);
    expect(plan.monthly.filter((x) => x === null)).toHaveLength(9);
    expect(plan.monthly.filter((x) => x !== null).map((x) => x!.toFixed(2))).toEqual(["200.00", "200.00", "200.00"]);
    expect(plan.monthly[9]!.toFixed(2)).toBe("200.00"); // index 9 = October
  });

  it("the site keeps every uploaded row for the history table, and the Ui history lists them by year", () => {
    const s = mk([erow("2025-11", 400, null), erow("2026-01", 500, null), frow("2025-10-05", 2, 600)]);
    expect(s.usageRows).toHaveLength(3);
    const ui = toUiSite(s, NOW, { pricesCorrupt: false, usageStatus: "ok" });
    expect(ui.usageHistory.map((h) => [h.kind, h.count])).toEqual([["electric", 2], ["firewood", 1]]);
    expect(ui.usageHistory[0]!.years.map((y) => y.year)).toEqual([2026, 2025]);
  });

  it("the 'payments in the last 12 months' check line leaves the unfinished current month out", () => {
    const pay = (p: string, amt: number): RawEnergyTx => ({ id: `t${p}`, date: new Date(`${p}-15T00:00:00Z`), amount: new Decimal(-amt), entityId: "e1", payee: "eversource", account: "A", tagPaths: [] });
    const txs = Array.from({ length: 12 }, (_, i) => pay(perOf(NOW_IDX - 12 + i), 100)).concat([pay("2026-10", 7777)]);
    const rows = Array.from({ length: 12 }, (_, m) => erow(perOf(NOW_IDX - 12 + m), 400 + m * 10, null));
    const e = mk(rows, txs).electric!.result;
    expect(e.status).toBe("estimate");
    if (e.status !== "estimate") return;
    expect(e.basis).toMatch(/payments in the last 12 months were \$1,200\.00/);
    expect(e.basis).not.toMatch(/7,777|8,977/);
  });
});
