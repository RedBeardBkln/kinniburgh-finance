// carry-forward-seasonal-energy, step 2: the read-only seasonal loader (lib/seasonal-energy-build.ts) over a mocked
// database. No test here touches a real database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const mockDb = vi.hoisted(() => ({
  entity: { findMany: vi.fn() },
  budget: { findMany: vi.fn() },
  tag: { findMany: vi.fn() },
  appSetting: { findUnique: vi.fn(), findMany: vi.fn() },
  transaction: { findMany: vi.fn() },
  scheduledBill: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { loadSeasonalEnergy, loadSeasonalEnergySafe, loadSeasonalPlansSafe } from "@/lib/seasonal-energy-build";

const P = "ent-p";
const SV = "ent-sv";
const EKC = "ent-ekc";
const NOW = new Date("2026-10-10T12:00:00Z");

const budgetRow = (entityId: string, tagId: string, name: string, period = "2026-10", budgeted = "100") => ({
  id: `row-${entityId}-${tagId}-${period}`,
  entityId,
  tagId,
  accountId: "acct",
  period,
  budgeted: new Decimal(budgeted),
  additionalAmountCents: new Decimal(0),
  payDay: null,
  frequency: "monthly",
  payDayOfWeek: null,
  biweeklyAnchorDate: null,
  payMonth: null,
  annualAmountDue: null,
  rolloverEnabled: false,
  rolloverAmount: null,
  tag: { id: tagId, name, shortName: name.split(" / ").pop(), parentId: null },
  entity: { id: entityId, name: entityId, slug: entityId },
});

const txRow = (id: string, entityId: string, date: string, outflow: string, payee: string, tags: string[] = [], account = "Acct") => ({
  id,
  postedAt: new Date(`${date}T00:00:00Z`),
  amount: new Decimal(outflow).negated(),
  entityId,
  payeeNormalized: payee,
  payeeRaw: null,
  description: null,
  account: { nickname: account },
  tags: tags.map((name) => ({ tag: { name } })),
});

const ELECTRIC = [["2025-11-19", "235.66"], ["2025-12-18", "445.42"], ["2026-01-20", "665.09"], ["2026-02-18", "583.22"], ["2026-04-13", "63.60"], ["2026-05-05", "161.51"], ["2026-08-06", "41.49"], ["2026-09-03", "247.89"]];

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.entity.findMany.mockResolvedValue([
    { id: P, name: "Personal", slug: "personal" },
    { id: SV, name: "Sudden Valley Property Management, LLC", slug: "sudden-valley" },
    { id: EKC, name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting" },
  ]);
  mockDb.budget.findMany.mockResolvedValue([
    budgetRow(P, "t-ep", "Utilities / Electric (Eversource)", "2026-10", "172"),
    budgetRow(P, "t-op", "Utilities / Oil", "2026-10", "308"),
    budgetRow(P, "t-wp", "Utilities / Firewood"),
    budgetRow(SV, "t-esv", "Arbor Retreat / Electricity", "2026-10", "100"),
    budgetRow(SV, "t-osv", "Arbor Retreat / Oil", "2026-10", "240"),
    budgetRow(P, "t-solar", "Utilities / Solar"),
  ]);
  mockDb.appSetting.findUnique.mockResolvedValue(null);
  mockDb.appSetting.findMany.mockResolvedValue([]);
  mockDb.tag.findMany.mockResolvedValue([]);
  mockDb.scheduledBill.findMany.mockResolvedValue([]);
  mockDb.transaction.findMany.mockResolvedValue([
    ...ELECTRIC.map(([d, a], i) => txRow(`e${i}`, P, d!, a!, "eversource", ["Utilities / Electric (Eversource)"])),
    txRow("sv1", SV, "2026-05-08", "79.81", "eversource", ["Arbor Retreat / Electricity"]),
    txRow("k1", EKC, "2025-12-02", "679.65", "mccarthy heating oil serv 860 4432839 ct", ["Utilities / Oil"], "Capital One"),
    txRow("k2", EKC, "2025-10-31", "292.46", "mccarthy heating oil serv860 4432839ct", [], "Capital One"),
    txRow("o1", P, "2026-10-08", "1529.50", "mccarthy heating oil", ["Utilities / Oil"], "Heating & Electric"),
    txRow("o2", P, "2026-10-09", "1036.75", "mccarthy heating oil", [], "Barclay"),
  ]);
});

describe("loadSeasonalEnergy", () => {
  it("builds one site per entity with seasonal lines: Personal gets its electric plan, McCarthy rows across entities (Personal only), Sudden Valley stays separate", async () => {
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r.failed).toBe(false);
    expect(r.sites.map((s) => s.slug)).toEqual(["personal", "sudden-valley"]);
    const personal = r.sites[0]!;
    expect(personal.electric?.result.status).toBe("estimate");
    expect(personal.electric?.flat?.toString()).toBe("172");
    expect(personal.oil?.facts.payments.map((p) => p.id).sort()).toEqual(["k1", "k2", "o1", "o2"]);
    expect(personal.oil?.facts.otherEntityRows).toBe(2); // every EK-card row read (the service charge included)
    expect(personal.oil?.facts.otherEntityCount).toBe(1); // ... but only the counted one is in the figure (Round 1, D2)
    expect(personal.oil?.facts.service?.dates).toEqual(["2025-10-31"]);
    expect(personal.oil?.flat?.toString()).toBe("308");
    expect(personal.firewood?.result.status).toBe("gated");
    const sv = r.sites[1]!;
    expect(sv.electric?.history.map((m) => m.period)).toEqual(["2026-05"]);
    expect(sv.oil?.facts.payments).toEqual([]);
    expect(sv.plans).toEqual([]);
    expect(r.plans.map((p) => p.lineKey)).toEqual([`${P}|t-ep`]);
  });

  it("an unmarked untagged McCarthy row is listed to check; a stored mark moves it to the excluded list", async () => {
    const open = await loadSeasonalEnergy({ now: NOW });
    expect(open.sites[0]!.oil!.facts.check.map((p) => p.id)).toEqual(["o2"]);
    mockDb.appSetting.findMany.mockResolvedValue([{ key: `oil_not_heating:${P}`, value: JSON.stringify(["00000000-0000-4000-8000-000000000001", "o2"]) }]);
    // ids that do not look like transaction ids are dropped by the parser, so use a real-looking id
    mockDb.transaction.findMany.mockResolvedValue([
      txRow("00000000-0000-4000-8000-0000000000aa", P, "2026-10-08", "1529.50", "mccarthy heating oil", ["Utilities / Oil"]),
      txRow("00000000-0000-4000-8000-0000000000bb", P, "2026-10-09", "1036.75", "mccarthy heating oil", []),
    ]);
    mockDb.appSetting.findMany.mockResolvedValue([{ key: `oil_not_heating:${P}`, value: JSON.stringify(["00000000-0000-4000-8000-0000000000bb"]) }]);
    const marked = await loadSeasonalEnergy({ now: NOW });
    const oil = marked.sites[0]!.oil!;
    expect(oil.facts.excluded.map((p) => p.id)).toEqual(["00000000-0000-4000-8000-0000000000bb"]);
    expect(oil.facts.check).toEqual([]);
    expect(oil.facts.trailingAsPaid.toFixed(2)).toBe("1529.50");
  });

  it("reads the owner's prices and the replace-draws opt-in from AppSetting; a corrupt price list is reported, not overwritten", async () => {
    mockDb.appSetting.findMany.mockResolvedValue([
      { key: "seasonal_replace_draws", value: "true" },
      { key: `oil_price_history:${P}`, value: JSON.stringify([{ id: "a", effectiveOn: "2025-10-01", pricePerGal: "4.00" }, { id: "b", effectiveOn: "2026-06-01", pricePerGal: "3.50" }]) },
      { key: `oil_price_history:${SV}`, value: "{broken" },
    ]);
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r.replaceDraws).toBe(true);
    expect(r.pricesCorrupt).toEqual([SV]);
    expect(r.sites[0]!.oil!.result.status).toBe("estimate");
    expect(r.plans.find((p) => p.kind === "oil")?.replaceDraws).toBe(true);
    const keys = (mockDb.appSetting.findMany.mock.calls[0]![0] as { where: { key: { in: string[] } } }).where.key.in;
    expect(keys.sort()).toEqual(["seasonal_replace_draws", `oil_not_heating:${P}`, `oil_not_heating:${SV}`, `oil_price_history:${P}`, `oil_price_history:${SV}`].sort());
  });

  it("hand-entered draws of the matching accrued bills ride along for display (by Budget link, or by entity + payee when unlinked)", async () => {
    mockDb.scheduledBill.findMany.mockResolvedValue([
      { entityId: P, payee: "McCarthy Heating & Oil", budgetTagId: "t-op", budgetEntityId: P, accrualEnvelope: { draws: [{ estimatedDate: new Date("2027-02-08T00:00:00Z"), estimatedAmount: new Decimal("2000") }, { estimatedDate: new Date("2026-12-16T00:00:00Z"), estimatedAmount: new Decimal("2000") }] } },
      { entityId: SV, payee: "McCarthy Oil (Arbor Retreat)", budgetTagId: null, budgetEntityId: null, accrualEnvelope: { draws: [{ estimatedDate: new Date("2026-11-20T00:00:00Z"), estimatedAmount: new Decimal("500") }] } },
      { entityId: P, payee: "Firewood", budgetTagId: "t-wp", budgetEntityId: P, accrualEnvelope: null },
    ]);
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r.sites[0]!.oil!.draws.map((d) => d.date)).toEqual(["2026-12-16", "2027-02-08"]);
    expect(r.sites[1]!.oil!.draws.map((d) => d.date)).toEqual(["2026-11-20"]);
    expect(r.sites[0]!.firewood!.draws).toEqual([]);
  });

  it("the owner's seasonal-lines setting replaces the default set (an entity with no line has no site)", async () => {
    mockDb.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify([{ entityId: P, tagId: "t-ep" }]) });
    mockDb.tag.findMany.mockResolvedValue([{ id: "t-ep", name: "Utilities / Electric (Eversource)" }]);
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r.sites.map((s) => s.slug)).toEqual(["personal"]);
    expect(r.sites[0]!.oil).toBeNull();
    expect(r.sites[0]!.electric).not.toBeNull();
  });

  it("no seasonal lines at all: nothing is read beyond the setting and the Budget lines", async () => {
    mockDb.budget.findMany.mockResolvedValue([budgetRow(P, "t-solar", "Utilities / Solar")]);
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r).toEqual({ sites: [], plans: [], pricesCorrupt: [], replaceDraws: false, failed: false });
    expect(mockDb.transaction.findMany).not.toHaveBeenCalled();
  });

  it("selects explicitly: no include, no account numbers, bounded, newest 37 months, transfers and archived rows out", async () => {
    await loadSeasonalEnergy({ now: NOW });
    const q = mockDb.transaction.findMany.mock.calls[0]![0] as { where: Record<string, unknown>; select: Record<string, unknown>; take: number; include?: unknown };
    expect(q.include).toBeUndefined();
    expect(q.take).toBe(4000);
    expect(q.where).toMatchObject({ archivedAt: null, transferPairId: null });
    expect((q.where.postedAt as { gte: Date }).gte.toISOString()).toBe("2023-09-01T00:00:00.000Z");
    expect(Object.keys(q.select).sort()).toEqual(["account", "accountId", "amount", "description", "entityId", "id", "payeeNormalized", "payeeRaw", "pending", "postedAt", "tags"]);
    expect(q.select.account).toEqual({ select: { nickname: true } });
    expect(JSON.stringify(q.select)).not.toMatch(/mask|accountNumber|plaid/i);
  });
});

describe("failures", () => {
  it("a failed read of the seasonal-lines setting FAILS the load (never silently the default set)", async () => {
    mockDb.appSetting.findUnique.mockRejectedValue(new Error("down"));
    await expect(loadSeasonalEnergy({ now: NOW })).rejects.toThrow("down");
  });

  it("a transaction read error rejects; reaching the row ceiling counts as an incomplete (failed) read", async () => {
    mockDb.transaction.findMany.mockRejectedValue(new Error("db down"));
    await expect(loadSeasonalEnergy({ now: NOW })).rejects.toThrow("db down");
    mockDb.transaction.findMany.mockResolvedValue(Array.from({ length: 4000 }, (_, i) => txRow(`x${i}`, P, "2026-05-05", "10", "eversource")));
    await expect(loadSeasonalEnergy({ now: NOW })).rejects.toThrow("SeasonalHistoryTooLarge");
  });

  it("the Safe variants never reject: no sites, no plans, failed true, and only err.name is logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockDb.transaction.findMany.mockRejectedValue(Object.assign(new Error("secret postgres://u:p@host"), { name: "PrismaClientKnownRequestError" }));
    const r = await loadSeasonalEnergySafe({ now: NOW });
    expect(r).toEqual({ sites: [], plans: [], pricesCorrupt: [], replaceDraws: false, failed: true });
    expect(await loadSeasonalPlansSafe({ now: NOW })).toEqual({ plans: [], failed: true });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("PrismaClientKnownRequestError");
    expect(logged).not.toMatch(/secret|postgres/);
    spy.mockRestore();
  });

  it("a Budget read failure for the flat figures only drops the comparison, not the estimates", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    mockDb.budget.findMany.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return [budgetRow(P, "t-ep", "Utilities / Electric (Eversource)")]; // the variable-lines read
      throw new Error("budget down");
    });
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r.failed).toBe(false);
    expect(r.sites[0]!.electric?.flat).toBeNull();
    expect(r.sites[0]!.electric?.result.status).toBe("estimate");
    spy.mockRestore();
  });
});
