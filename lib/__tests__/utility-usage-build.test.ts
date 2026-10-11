// utility-usage-upload, step 5: the read-only usage loader and its isolation from the main seasonal load. A mocked database
// only; nothing here touches a real one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const mockDb = vi.hoisted(() => ({
  entity: { findMany: vi.fn() },
  budget: { findMany: vi.fn() },
  tag: { findMany: vi.fn() },
  appSetting: { findUnique: vi.fn(), findMany: vi.fn() },
  transaction: { findMany: vi.fn() },
  scheduledBill: { findMany: vi.fn() },
  utilityUsage: { findMany: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { MAX_USAGE_ROWS, isMissingUsageTable, loadUtilityUsage } from "@/lib/utility-usage-build";
import { loadSeasonalEnergy } from "@/lib/seasonal-energy-build";

const NOW = new Date("2026-10-10T12:00:00Z");
const SV = "ent-sv";
const P = "ent-p";

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  entityId: SV,
  kind: "electric",
  period: "2025-10",
  occurredOn: new Date("2025-10-01T00:00:00Z"),
  quantity: new Decimal("850.5"),
  unit: "kwh",
  costCents: 14218,
  note: null,
  ...over,
});

function missingTable(): Error {
  return Object.assign(new Error("The table `public.UtilityUsage` does not exist in the current database."), { code: "P2021", name: "PrismaClientKnownRequestError" });
}

const budgetRow = (entityId: string, tagId: string, name: string, budgeted = "100") => ({
  id: `row-${entityId}-${tagId}`,
  entityId,
  tagId,
  accountId: "acct",
  period: "2026-10",
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

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.entity.findMany.mockResolvedValue([
    { id: P, name: "Personal", slug: "personal" },
    { id: SV, name: "Sudden Valley", slug: "sudden-valley" },
  ]);
  mockDb.budget.findMany.mockResolvedValue([
    budgetRow(SV, "t-esv", "Arbor Retreat / Electricity"),
    budgetRow(SV, "t-osv", "Arbor Retreat / Oil", "240"),
    budgetRow(P, "t-ep", "Utilities / Electric (Eversource)", "172"),
  ]);
  mockDb.appSetting.findUnique.mockResolvedValue(null);
  mockDb.appSetting.findMany.mockResolvedValue([]);
  mockDb.tag.findMany.mockResolvedValue([]);
  mockDb.scheduledBill.findMany.mockResolvedValue([]);
  mockDb.transaction.findMany.mockResolvedValue([]);
  mockDb.utilityUsage.findMany.mockResolvedValue([]);
});

describe("loadUtilityUsage", () => {
  it("reads live rows only with an explicit select, a cap and a stable order, and never writes", async () => {
    mockDb.utilityUsage.findMany.mockResolvedValue([dbRow()]);
    const r = await loadUtilityUsage([SV, P]);
    expect(r.status).toBe("ok");
    expect(mockDb.utilityUsage.findMany).toHaveBeenCalledTimes(1);
    const q = mockDb.utilityUsage.findMany.mock.calls[0]![0] as { where: Record<string, unknown>; select: Record<string, unknown>; take: number; include?: unknown };
    expect(q.where).toEqual({ entityId: { in: [SV, P] }, archivedAt: null });
    expect(q.take).toBe(MAX_USAGE_ROWS);
    expect(q.include).toBeUndefined();
    expect(Object.keys(q.select).sort()).toEqual(["entityId", "id", "kind", "note", "occurredOn", "period", "quantity", "unit", "costCents"].sort());
    for (const m of ["create", "createMany", "update", "updateMany", "delete", "deleteMany", "upsert"] as const) {
      expect(mockDb.utilityUsage[m]).not.toHaveBeenCalled();
    }
  });

  it("shapes rows: Decimal quantity, dollars from cents, a calendar-day string, null cost kept", async () => {
    mockDb.utilityUsage.findMany.mockResolvedValue([dbRow(), dbRow({ id: "u2", costCents: null, kind: "oil", unit: "gal" }), dbRow({ id: "u3", kind: "propane" })]);
    const r = await loadUtilityUsage([SV]);
    expect(r.rows.map((x) => x.id)).toEqual(["u1", "u2"]); // an unknown kind is dropped
    expect(r.rows[0]!.quantity.toFixed(3)).toBe("850.500");
    expect(r.rows[0]!.cost!.toFixed(2)).toBe("142.18");
    expect(r.rows[0]!.occurredOn).toBe("2025-10-01");
    expect(r.rows[1]!.cost).toBeNull();
    expect(r.rows[0]!.entityId).toBe(SV);
  });

  it("no entities: nothing is read", async () => {
    expect(await loadUtilityUsage([])).toEqual({ status: "ok", rows: [] });
    expect(mockDb.utilityUsage.findMany).not.toHaveBeenCalled();
  });

  it("a missing table is not_set_up (P2021, a 42P01 meta code, or the message naming the table)", async () => {
    for (const err of [
      missingTable(),
      Object.assign(new Error("boom"), { meta: { code: "42P01" } }),
      new Error('relation "UtilityUsage" does not exist'),
    ]) {
      mockDb.utilityUsage.findMany.mockRejectedValueOnce(err);
      expect(await loadUtilityUsage([SV])).toEqual({ status: "not_set_up", rows: [] });
    }
    expect(isMissingUsageTable(new Error("something else"))).toBe(false);
    expect(isMissingUsageTable(null)).toBe(false);
  });

  it("any other error is failed, and only err.name is logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockDb.utilityUsage.findMany.mockRejectedValueOnce(Object.assign(new Error("secret detail 12345"), { name: "ConnectionError" }));
    expect(await loadUtilityUsage([SV])).toEqual({ status: "failed", rows: [] });
    expect(spy).toHaveBeenCalledWith("Utility usage unavailable", "ConnectionError");
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret detail/);
    spy.mockRestore();
  });

  it("reaching the row ceiling is a failed (incomplete) read, not a silent partial one", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockDb.utilityUsage.findMany.mockResolvedValueOnce(Array.from({ length: MAX_USAGE_ROWS }, (_, i) => dbRow({ id: `u${i}` })));
    expect((await loadUtilityUsage([SV])).status).toBe("failed");
    spy.mockRestore();
  });
});

describe("the seasonal load is isolated from a usage failure", () => {
  const sv = async () => (await loadSeasonalEnergy({ now: NOW })).sites.find((s) => s.slug === "sudden-valley")!;

  it("table missing: the load is NOT failed, usageStatus says not_set_up, every result equals the one without usage", async () => {
    const clean = await loadSeasonalEnergy({ now: NOW });
    mockDb.utilityUsage.findMany.mockRejectedValue(missingTable());
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r.failed).toBe(false);
    expect(r.usageStatus).toBe("not_set_up");
    expect(r.sites.length).toBeGreaterThan(0);
    expect(r.plans).toEqual(clean.plans);
    expect(r.sites.map((s) => [s.slug, s.electric?.result, s.oil?.result])).toEqual(clean.sites.map((s) => [s.slug, s.electric?.result, s.oil?.result]));
  });

  it("an unexpected usage error is contained: usageStatus failed, estimates from payments intact", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockDb.utilityUsage.findMany.mockRejectedValue(new Error("db down"));
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r.failed).toBe(false);
    expect(r.usageStatus).toBe("failed");
    expect(r.sites.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("a mock without the usage model at all (older environments) is contained too", async () => {
    const saved = mockDb.utilityUsage.findMany;
    (mockDb as unknown as { utilityUsage: unknown }).utilityUsage = undefined;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r.failed).toBe(false);
    expect(r.usageStatus).toBe("failed");
    spy.mockRestore();
    (mockDb as unknown as { utilityUsage: unknown }).utilityUsage = { findMany: saved };
  });

  it("rows are handed to the right site only (entity separation) and change that site's result", async () => {
    // a full Sudden Valley kWh year, plus a Personal row that must not leak into it
    const months = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
    const svRows = months.map((p, i) => dbRow({ id: `sv-${p}`, entityId: SV, period: p, occurredOn: new Date(`${p}-01T00:00:00Z`), quantity: new Decimal(500 + i * 30), costCents: null }));
    const pRow = dbRow({ id: "p-1", entityId: P, period: "2026-01", occurredOn: new Date("2026-01-01T00:00:00Z") });
    mockDb.utilityUsage.findMany.mockResolvedValue([...svRows, pRow]);
    const site = await sv();
    expect(site.electric?.usage).toMatchObject({ count: 12, from: "2025-10", to: "2026-09" });
    expect(site.usageRows?.every((r) => r.id.startsWith("sv-"))).toBe(true);
    const personal = (await loadSeasonalEnergy({ now: NOW })).sites.find((s) => s.slug === "personal")!;
    expect(personal.electric?.usage).toMatchObject({ count: 1 });
    expect(personal.usageRows?.map((r) => r.id)).toEqual(["p-1"]);
  });

  it("asks for the usage rows of the sites that have seasonal lines, once", async () => {
    await loadSeasonalEnergy({ now: NOW });
    expect(mockDb.utilityUsage.findMany).toHaveBeenCalledTimes(1);
    const where = (mockDb.utilityUsage.findMany.mock.calls[0]![0] as { where: { entityId: { in: string[] } } }).where;
    expect([...where.entityId.in].sort()).toEqual([P, SV].sort());
  });
});
