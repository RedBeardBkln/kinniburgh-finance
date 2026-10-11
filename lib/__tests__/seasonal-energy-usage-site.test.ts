// utility-usage-upload (step 3): how uploaded usage rows change one site's seasonal result. With no usage rows everything
// is exactly what it was before this feature; with rows the usage model is tried first and the payments model stays the
// fallback (its own gate is never changed by usage). All figures are synthetic.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  buildSiteEnergy,
  type EnergyEntityRef,
  type RawEnergyTx,
  type SeasonalLineRef,
  type SiteEnergyInput,
} from "@/lib/seasonal-energy";
import type { UsageRow } from "@/lib/seasonal-energy-usage";
import { generateBillOccurrencesBudgetDated, type BillDateBill, type SeasonalScheduleEvent } from "@/lib/bill-dates";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const D = (v: number | string) => new Decimal(v);
const SV: EnergyEntityRef = { id: "ent-sv", name: "Sudden Valley", slug: "sudden-valley" };
const PERSONAL: EnergyEntityRef = { id: "ent-p", name: "Personal", slug: "personal" };
const ELEC: SeasonalLineRef = { entityId: "ent-sv", tagId: "t-e", tagName: "Arbor Retreat / Electricity", kind: "electric" };
const OIL: SeasonalLineRef = { entityId: "ent-sv", tagId: "t-o", tagName: "Arbor Retreat / Oil", kind: "oil" };
const WOOD: SeasonalLineRef = { entityId: "ent-sv", tagId: "t-w", tagName: "Arbor Retreat / Firewood", kind: "firewood" };

let seq = 0;
const row = (kind: UsageRow["kind"], period: string, qty: number, cost: number | null = null, occurredOn = `${period}-01`, unit?: string): UsageRow => ({
  id: `u${++seq}`,
  kind,
  period,
  occurredOn,
  quantity: D(qty),
  unit: unit ?? (kind === "electric" ? "kwh" : kind === "oil" ? "gal" : "cord"),
  cost: cost === null ? null : D(cost),
  note: null,
});

function periodsBack(last: string, count: number): string[] {
  const idx = Number(last.slice(0, 4)) * 12 + Number(last.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, i) => {
    const t = idx - (count - 1 - i);
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
  });
}
const CURVE = [900, 850, 700, 600, 520, 500, 540, 560, 530, 600, 720, 860];
const electricYear = (): UsageRow[] => periodsBack("2026-09", 12).map((p) => row("electric", p, CURVE[Number(p.slice(5, 7)) - 1]!));

function eversourceTxs(entityId: string, months: number): RawEnergyTx[] {
  return periodsBack("2026-09", months).map((p, i) => ({
    id: `tx-${entityId}-${p}`,
    date: new Date(`${p}-15T00:00:00.000Z`),
    amount: D(-(100 + (i % 5) * 20)),
    entityId,
    payee: "eversource",
    account: "Acct",
    tagPaths: [],
  }));
}

function input(over: Partial<SiteEnergyInput> = {}): SiteEnergyInput {
  return {
    entity: SV,
    lines: [ELEC, OIL, WOOD],
    txs: [],
    entities: [SV, PERSONAL],
    priceEntries: [],
    flatMonthly: {},
    replaceDraws: false,
    now: NOW,
    ...over,
  };
}

describe("no usage rows: nothing changes", () => {
  it("usage undefined and usage [] give the same result as before (payments only)", () => {
    const txs = eversourceTxs("ent-sv", 12);
    const a = buildSiteEnergy(input({ txs }));
    const b = buildSiteEnergy(input({ txs, usage: [] }));
    expect(b).toEqual(a);
    expect(a.electric!.result.status).toBe("estimate");
    expect(a.electric!.usage).toBeNull();
    expect((a.electric!.result as { method: string }).method).toBe("payments");
    expect(a.oil!.result.status).toBe("gated");
    expect(a.firewood!.result.status).toBe("gated");
  });

  it("rows of another kind do not touch a line", () => {
    const s = buildSiteEnergy(input({ usage: [row("oil", "2025-10", 200, null, "2025-10-15")] }));
    expect(s.electric!.usage).toBeNull();
    expect(s.firewood!.usage).toBeNull();
    expect(s.oil!.usage).toMatchObject({ count: 1, used: false });
  });
});

describe("electric with kWh on file", () => {
  it("a full year of kWh plus a payments level: the usage shape is used and the plan carries it", () => {
    const txs = eversourceTxs("ent-sv", 12);
    const base = buildSiteEnergy(input({ txs }));
    const s = buildSiteEnergy(input({ txs, usage: electricYear() }));
    const res = s.electric!.result;
    expect(res.status).toBe("estimate");
    if (res.status !== "estimate") return;
    expect(res.method).toBe("usage_shape");
    expect(s.electric!.usage).toMatchObject({ used: true, count: 12, from: "2025-10", to: "2026-09" });
    // the annual level is the payments model's, only the shape moves
    const payAnnual = (base.electric!.result as { annual: Decimal }).annual;
    expect(Math.abs(res.annual.minus(payAnnual).toNumber())).toBeLessThan(0.07);
    const plan = s.plans.find((p) => p.kind === "electric")!;
    expect(plan.monthly).toHaveLength(12);
    expect(plan.monthly[0]!.toFixed(2)).toBe(res.months[0]!.amount.toFixed(2));
    expect(plan.basis).toBe(res.basis);
    // the payments list under the table is unchanged
    expect(s.electric!.history).toEqual(base.electric!.history);
  });

  it("kWh only and no payments estimate: gated with both reasons, no number, flat budget stays", () => {
    const s = buildSiteEnergy(input({ usage: electricYear() }));
    const res = s.electric!.result;
    expect(res.status).toBe("gated");
    expect(Object.keys(res).sort()).toEqual(["kind", "reason", "status"]);
    if (res.status === "gated") {
      expect(res.reason).toMatch(/dollars are unknown/);
      expect(res.reason).toMatch(/No Eversource payments were found/);
    }
    expect(s.plans.find((p) => p.kind === "electric")).toBeUndefined();
    expect(s.electric!.usage).toMatchObject({ used: false });
  });

  it("an incomplete kWh year never replaces a working payments estimate and says why", () => {
    const txs = eversourceTxs("ent-sv", 12);
    const base = buildSiteEnergy(input({ txs }));
    const rows = electricYear().filter((r) => r.period !== "2026-03");
    const s = buildSiteEnergy(input({ txs, usage: rows }));
    expect(s.electric!.result).toEqual(base.electric!.result);
    expect(s.electric!.usage).toMatchObject({ used: false, why: expect.stringMatching(/missing Mar/) });
  });

  it("measured rates need no payments at all", () => {
    const rows = periodsBack("2026-09", 36).map((p) => {
      const k = CURVE[Number(p.slice(5, 7)) - 1]!;
      return row("electric", p, k, 18 + 0.14 * k);
    });
    const s = buildSiteEnergy(input({ usage: rows }));
    expect(s.electric!.result.status).toBe("estimate");
    expect(s.plans.some((p) => p.kind === "electric")).toBe(true);
  });
});

describe("oil with deliveries on file", () => {
  const deliveries = (): UsageRow[] => [row("oil", "2025-10", 200, null, "2025-10-15"), row("oil", "2026-02", 150, null, "2026-02-10")];

  it("deliveries and one price give an estimate whose plan has twelve different monthly figures", () => {
    const s = buildSiteEnergy(input({ usage: deliveries(), priceEntries: [{ id: "p1", effectiveOn: "2026-01-01", pricePerGal: "4.0000" }] }));
    const res = s.oil!.result;
    expect(res.status).toBe("estimate");
    const plan = s.plans.find((p) => p.kind === "oil")!;
    expect(plan.monthly).toHaveLength(12);
    expect(new Set(plan.monthly.map((m) => m?.toFixed(2))).size).toBeGreaterThan(2);
    expect(s.oil!.usage).toMatchObject({ used: true, count: 2 });
  });

  it("without a price it is gated with the usage reason first", () => {
    const s = buildSiteEnergy(input({ usage: deliveries() }));
    const res = s.oil!.result;
    expect(res.status).toBe("gated");
    if (res.status === "gated") expect(res.reason.startsWith("The gallons are known")).toBe(true);
    expect(s.plans.some((p) => p.kind === "oil")).toBe(false);
  });
});

describe("firewood with purchases on file", () => {
  const wood = (): UsageRow[] => [
    row("firewood", "2024-10", 2, 500, "2024-10-05"),
    row("firewood", "2025-11", 2, 700, "2025-11-02"),
  ];

  it("two complete seasons with amounts produce a firewood estimate and a plan of kind firewood", () => {
    const s = buildSiteEnergy(input({ usage: wood() }));
    const res = s.firewood!.result;
    expect(res.status).toBe("estimate");
    const plan = s.plans.find((p) => p.kind === "firewood");
    expect(plan).toBeDefined();
    expect(plan!.lineKey).toBe("ent-sv|t-w");
    expect(plan!.confidence).toBe("low");
    expect(s.firewood!.usage).toMatchObject({ used: true });
  });

  it("one season stays gated with the usage reason and the old reason", () => {
    const s = buildSiteEnergy(input({ usage: [wood()[1]!] }));
    const res = s.firewood!.result;
    expect(res.status).toBe("gated");
    if (res.status === "gated") expect(res.reason).toMatch(/at least two complete heating seasons/);
    expect(s.plans.some((p) => p.kind === "firewood")).toBe(false);
  });

  it("the plan flows through the bill generator: draws win, the tail is the model, events are marked firewood", () => {
    const s = buildSiteEnergy(input({ usage: wood() }));
    const plan = s.plans.find((p) => p.kind === "firewood")!;
    const bill: BillDateBill = {
      id: "b-wood",
      accountId: "acct",
      entityId: "ent-sv",
      payee: "Firewood supplier",
      amountType: "accrued",
      expectedAmount: null,
      autopayDay: 10,
      annualBudget: "900",
      frequency: "monthly",
      payDayOfWeek: null,
      biweeklyAnchorDate: null,
      payMonth: null,
      budgetTagId: "t-w",
      budgetEntityId: "ent-sv",
    };
    const none = generateBillOccurrencesBudgetDated(bill, new Map(), new Date("2026-10-10T00:00:00Z"), new Date("2027-04-01T00:00:00Z"), [], plan) as SeasonalScheduleEvent[];
    expect(none.length).toBeGreaterThan(0);
    for (const e of none) expect(e.estimate).toMatchObject({ kind: "firewood", confidence: "low" });
    // a hand-entered draw in December wins in its month and the model fills only the months after it
    const draws = [{ estimatedDate: new Date("2026-12-05T00:00:00Z"), estimatedAmount: D(333) }];
    const withDraw = generateBillOccurrencesBudgetDated(bill, new Map(), new Date("2026-10-10T00:00:00Z"), new Date("2027-04-01T00:00:00Z"), draws, plan) as SeasonalScheduleEvent[];
    const dec = withDraw.filter((e) => e.date.toISOString().startsWith("2026-12"));
    expect(dec).toHaveLength(1);
    expect(dec[0]!.amount.abs().toFixed(2)).toBe("333.00");
    expect(dec[0]!.estimate).toBeUndefined();
    expect(withDraw.filter((e) => e.date.toISOString() < "2026-12-01").every((e) => e.estimate)).toBe(true);
  });
});

describe("entity separation", () => {
  it("usage given for one site is never read by another call (the caller filters by entity)", () => {
    const sv = buildSiteEnergy(input({ usage: electricYear() }));
    const personal = buildSiteEnergy(input({ entity: PERSONAL, lines: [{ ...ELEC, entityId: "ent-p", tagId: "t-ep" }], usage: [] }));
    expect(sv.electric!.usage).not.toBeNull();
    expect(personal.electric!.usage).toBeNull();
  });
});
