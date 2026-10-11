// TESTER (utility-usage-upload): boundary pins added after a mutation run showed the Coder's tests did not distinguish
// these thresholds. Exact R2 = 0.5 and R2 = 0.8 fixtures are built from +/-1 designs so the rational R2 is exact.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { electricUsageEstimate, type UsageRow } from "@/lib/seasonal-energy-usage";
import { buildSiteEnergy, type RawEnergyTx, type SiteEnergyInput } from "@/lib/seasonal-energy";
import { parseUsageText } from "@/lib/utility-usage-parse";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const NOW_IDX = 2026 * 12 + 9;
const perOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
let n = 0;
const erow = (period: string, kwh: number, cost: number | null): UsageRow => ({
  id: `b${++n}`, kind: "electric", period, occurredOn: `${period}-01`, quantity: new Decimal(kwh), unit: "kwh", cost: cost === null ? null : new Decimal(cost), note: null,
});

/** 12 months, x = +/-1 (kWh 600 / 400) balanced over months, cost = 200 + 10 * (slope * x + z), z = +/-1 balanced inside each x group. */
function design(slope: number, years: number): UsageRow[] {
  const rows: UsageRow[] = [];
  for (let y = 0; y < years; y++) {
    for (let m = 0; m < 12; m++) {
      const idx = NOW_IDX - 12 * (years - y) + m;
      const x = m % 2 === 0 ? 1 : -1;
      // within the x = +1 group (m = 0,2,4,...) alternate z by position; same for x = -1
      const z = Math.floor(m / 2) % 2 === 0 ? 1 : -1;
      rows.push(erow(perOf(idx), 500 + 100 * x, Number((200 + 10 * (slope * x + z)).toFixed(2))));
    }
  }
  return rows;
}

describe("TESTER electric fit thresholds are exact", () => {
  it("R2 exactly 0.5 is accepted (>=), so the measured rate is used", () => {
    const e = electricUsageEstimate({ rows: design(1, 1), now: NOW, site: null, paymentAnnual: null });
    expect(e.status).toBe("estimate");
    if (e.status === "estimate") expect(e.method).toBe("usage_paired");
  });
  it("R2 = s^2/(s^2+1): slope 0.99 gives 0.495 (rejected), slope 1.01 gives 0.5025 (accepted)", () => {
    const low = electricUsageEstimate({ rows: design(0.99, 1), now: NOW, site: null, paymentAnnual: null });
    expect(low.status).toBe("gated");
    const high = electricUsageEstimate({ rows: design(1.01, 1), now: NOW, site: null, paymentAnnual: null });
    expect(high.status === "estimate" && high.method).toBe("usage_paired");
  });
  it("R2 exactly 0.8 does NOT step the confidence down (three years -> high)", () => {
    const e = electricUsageEstimate({ rows: design(2, 3), now: NOW, site: null, paymentAnnual: null });
    expect(e.status).toBe("estimate");
    if (e.status === "estimate") {
      expect(e.method).toBe("usage_paired");
      expect(e.confidence).toBe("high");
    }
  });
  it("R2 exactly 0.5 with three years is stepped down from high to medium", () => {
    const e = electricUsageEstimate({ rows: design(1, 3), now: NOW, site: null, paymentAnnual: null });
    expect(e.status === "estimate" && e.confidence).toBe("medium");
  });
  it("12+ paired rows over only 7 calendar months do NOT give a measured rate (needs 8)", () => {
    // 2 years; amounts only in months 1..7 of each year (14 paired rows), the other 5 months are kWh only
    const rows: UsageRow[] = [];
    for (let y = 0; y < 2; y++) {
      for (let m = 0; m < 12; m++) {
        const idx = NOW_IDX - 24 + 12 * y + m;
        const calMonth = Number(perOf(idx).slice(5));
        const kwh = 400 + ((m * 37 + y * 11) % 200);
        rows.push(erow(perOf(idx), kwh, calMonth <= 7 ? 20 + kwh * 0.1 : null));
      }
    }
    const paired = rows.filter((r) => r.cost !== null);
    expect(paired.length).toBeGreaterThanOrEqual(12);
    expect(new Set(paired.map((r) => r.period.slice(5))).size).toBe(7);
    const e = electricUsageEstimate({ rows, now: NOW, site: null, paymentAnnual: null });
    expect(e.status).toBe("gated"); // not paired, and no payments level for the shape
    const ok8 = rows.map((r) => (Number(r.period.slice(5)) === 8 ? erow(r.period, r.quantity.toNumber(), 20 + r.quantity.toNumber() * 0.1) : r));
    const e8 = electricUsageEstimate({ rows: ok8, now: NOW, site: null, paymentAnnual: null });
    expect(e8.status === "estimate" && e8.method).toBe("usage_paired");
  });
  it("11 paired rows are not enough (needs 12) even over 8+ calendar months", () => {
    const rows = design(3, 1).map((r, i) => (i === 0 ? erow(r.period, r.quantity.toNumber(), null) : r));
    expect(rows.filter((r) => r.cost !== null)).toHaveLength(11);
    expect(electricUsageEstimate({ rows, now: NOW, site: null, paymentAnnual: null }).status).toBe("gated");
  });
});

describe("TESTER parser warning / range boundaries", () => {
  const T = "2026-10-10";
  const one = (kind: "electric" | "oil", head: string, line: string) => {
    const out = parseUsageText({ kind, text: `${head}\n${line}\n`, today: T, site: { solarLiveFrom: null } });
    if (!out.ok) throw new Error(out.error);
    return out.rows[0]!;
  };
  it("electric 5,000 kWh is silent, 5,000.001 warns, 20,000 is accepted, 20,000.001 is refused", () => {
    expect(one("electric", "Month,kWh", "2025-01,5000").warnings).toEqual([]);
    expect(one("electric", "Month,kWh", "2025-01,5000.001").warnings.length).toBe(1);
    expect(one("electric", "Month,kWh", "2025-01,20000").status).toBe("new");
    expect(one("electric", "Month,kWh", "2025-01,20000.001").status).toBe("error");
  });
  it("oil 800 gallons is silent, 800.001 warns", () => {
    expect(one("oil", "Date,Gal", "2026-01-05,800").warnings).toEqual([]);
    expect(one("oil", "Date,Gal", "2026-01-05,800.001").warnings.length).toBe(1);
  });
  it("oil amounts cannot be negative; electric credits can, down to exactly -5,000.00", () => {
    expect(one("oil", "Date,Gal,Cost", "2026-01-05,100,-0.01").status).toBe("error");
    expect(one("oil", "Date,Gal,Cost", "2026-01-05,100,0").status).toBe("error"); // $0.00 a gallon is outside 0.50 to 12.00
    expect(one("electric", "Month,kWh,Cost", "2025-01,100,-5000").status).toBe("new");
    expect(one("electric", "Month,kWh,Cost", "2025-01,100,-5000.01").status).toBe("error");
  });
});

describe("TESTER a gated usage result never replaces a payments-based oil estimate", () => {
  const ent = { id: "e1", name: "Personal", slug: "sudden-valley" };
  const oilLine = { entityId: "e1", tagId: "t2", tagName: "Arbor Retreat / Oil", kind: "oil" as const };
  const txs: RawEnergyTx[] = [];
  for (let i = 0; i < 14; i += 2) {
    const idx = NOW_IDX - 1 - i;
    txs.push({ id: `mc${i}`, date: new Date(`${perOf(idx)}-10T00:00:00Z`), amount: new Decimal(-500), entityId: "e1", payee: "mccarthy heating oil", account: "A", tagPaths: [] });
  }
  const base = (usage?: SiteEnergyInput["usage"]): SiteEnergyInput => ({
    entity: ent, lines: [oilLine], txs, entities: [ent],
    priceEntries: [{ id: "p1", effectiveOn: "2025-06-01", pricePerGal: "3.5000" }, { id: "p2", effectiveOn: "2026-03-01", pricePerGal: "3.9000" }],
    flatMonthly: {}, replaceDraws: false, now: NOW, usage,
  });
  it("the fixture alone gives a payments estimate", () => {
    expect(buildSiteEnergy(base()).oil!.result.status).toBe("estimate");
  });
  it("one oil delivery too recent to fill a window: result, plans and facts equal the no-usage ones; only the usage note is added", () => {
    const without = buildSiteEnergy(base());
    const row: UsageRow = { id: "o1", kind: "oil", period: "2026-08", occurredOn: "2026-08-10", quantity: new Decimal(100), unit: "gal", cost: null, note: null };
    const withRow = buildSiteEnergy(base([row]));
    expect(withRow.oil!.usage).toMatchObject({ used: false });
    expect(withRow.oil!.result).toEqual(without.oil!.result);
    expect(withRow.plans).toEqual(without.plans);
  });
});
