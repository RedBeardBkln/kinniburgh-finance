// TESTER (carry-forward-seasonal-energy, step 2): extra loader checks over a mocked database (no real database).
// Complements seasonal-energy-build.test.ts: per-entity separation of prices, opt-in parsing, archived entities,
// query shape, and that a failure logs only the error NAME.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { loadSeasonalEnergy, loadSeasonalEnergySafe } from "@/lib/seasonal-energy-build";

const P = "ent-p";
const SV = "ent-sv";
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
const txRow = (id: string, entityId: string, date: string, outflow: string, payee: string, tags: string[] = []) => ({
  id,
  postedAt: new Date(`${date}T00:00:00Z`),
  amount: new Decimal(outflow).negated(),
  entityId,
  payeeNormalized: payee,
  payeeRaw: null,
  description: null,
  account: { nickname: "Acct" },
  tags: tags.map((name) => ({ tag: { name } })),
});

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  mockDb.entity.findMany.mockResolvedValue([
    { id: P, name: "Personal", slug: "personal" },
    { id: SV, name: "Sudden Valley Property Management, LLC", slug: "sudden-valley" },
  ]);
  mockDb.budget.findMany.mockResolvedValue([
    budgetRow(P, "t-op", "Utilities / Oil", "2026-10", "308"),
    budgetRow(SV, "t-osv", "Arbor Retreat / Oil", "2026-10", "240"),
  ]);
  mockDb.appSetting.findUnique.mockResolvedValue(null);
  mockDb.appSetting.findMany.mockResolvedValue([]);
  mockDb.tag.findMany.mockResolvedValue([]);
  mockDb.scheduledBill.findMany.mockResolvedValue([]);
  mockDb.transaction.findMany.mockResolvedValue([
    txRow("p1", P, "2026-09-01", "800", "mccarthy heating oil", ["Utilities / Oil"]),
    txRow("sv1", SV, "2026-09-02", "900", "mccarthy heating oil", ["Arbor Retreat / Oil"]),
  ]);
});
afterEach(() => errSpy.mockRestore());

const PRICES = JSON.stringify([
  { id: "a", effectiveOn: "2025-10-01", pricePerGal: "4.00" },
  { id: "b", effectiveOn: "2026-06-01", pricePerGal: "3.50" },
]);

describe("per-entity separation in the loader", () => {
  it("prices entered for Personal never reach Sudden Valley: Personal oil is an estimate, SV oil (own payments, no prices) stays gated", async () => {
    mockDb.appSetting.findMany.mockResolvedValue([{ key: `oil_price_history:${P}`, value: PRICES }]);
    const r = await loadSeasonalEnergy({ now: NOW });
    const p = r.sites.find((s) => s.slug === "personal")!;
    const sv = r.sites.find((s) => s.slug === "sudden-valley")!;
    expect(p.oil!.result.status).toBe("estimate");
    expect(sv.oil!.facts.payments).toHaveLength(1); // its own 900 payment
    expect(sv.oil!.result.status).toBe("gated");
    expect(sv.oil!.entries).toEqual([]);
    expect(r.plans.map((x) => x.entityId)).toEqual([P]);
  });

  it("the 'not heating oil' marks are per site: a mark under Personal's key does not remove a Sudden Valley row", async () => {
    mockDb.transaction.findMany.mockResolvedValue([
      txRow("00000000-0000-4000-8000-0000000000a1", P, "2026-09-01", "800", "mccarthy heating oil", ["Utilities / Oil"]),
      txRow("00000000-0000-4000-8000-0000000000b1", SV, "2026-09-02", "900", "mccarthy heating oil", ["Arbor Retreat / Oil"]),
    ]);
    mockDb.appSetting.findMany.mockResolvedValue([{ key: `oil_not_heating:${P}`, value: JSON.stringify(["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b1"]) }]);
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r.sites.find((s) => s.slug === "personal")!.oil!.facts.excluded.map((x) => x.id)).toEqual(["00000000-0000-4000-8000-0000000000a1"]);
    expect(r.sites.find((s) => s.slug === "sudden-valley")!.oil!.facts.excluded).toEqual([]);
    expect(r.sites.find((s) => s.slug === "sudden-valley")!.oil!.facts.counted).toHaveLength(1);
  });

  it("the replace-draws opt-in is on only for the literal 'true' (any case); absent, '1', 'yes', 'false' and junk are off", async () => {
    for (const [value, expected] of [["true", true], ["TRUE", true], [" True ", true], ["1", false], ["yes", false], ["false", false], ["", false], ["{}", false]] as const) {
      mockDb.appSetting.findMany.mockResolvedValue([{ key: "seasonal_replace_draws", value }]);
      expect((await loadSeasonalEnergy({ now: NOW })).replaceDraws, JSON.stringify(value)).toBe(expected);
    }
    mockDb.appSetting.findMany.mockResolvedValue([]);
    expect((await loadSeasonalEnergy({ now: NOW })).replaceDraws).toBe(false);
  });
});

describe("loader query shape (read-only, bounded)", () => {
  it("entities: archived ones are excluded; draws: only for entities with lines; transactions: not archived, not transfer legs, newest 37 months, a ceiling", async () => {
    await loadSeasonalEnergy({ now: NOW });
    expect(mockDb.entity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { archivedAt: null } }));
    const bill = mockDb.scheduledBill.findMany.mock.calls[0]![0] as { where: { active: boolean; amountType: string; entityId: { in: string[] } } };
    expect(bill.where.entityId.in.sort()).toEqual([P, SV]);
    expect(bill.where.amountType).toBe("accrued");
    const txq = mockDb.transaction.findMany.mock.calls[0]![0] as { where: { archivedAt: null; transferPairId: null; postedAt: { gte: Date } }; take: number; select: Record<string, unknown> };
    expect(txq.where.archivedAt).toBeNull();
    expect(txq.where.transferPairId).toBeNull();
    expect(txq.where.postedAt.gte.toISOString()).toBe("2023-09-01T00:00:00.000Z"); // 37 months before Oct 2026
    expect(txq.take).toBe(4000);
    expect(Object.keys(txq.select).sort()).toEqual(["account", "accountId", "amount", "description", "entityId", "id", "payeeNormalized", "payeeRaw", "pending", "postedAt", "tags"]);
  });

  it("a ceiling-sized read counts as failed (never a silent partial history)", async () => {
    mockDb.transaction.findMany.mockResolvedValue(Array.from({ length: 4000 }, (_, i) => txRow(`t${i}`, P, "2026-09-01", "1", "eversource")));
    await expect(loadSeasonalEnergy({ now: NOW })).rejects.toThrow("SeasonalHistoryTooLarge");
    const safe = await loadSeasonalEnergySafe({ now: NOW });
    expect(safe).toMatchObject({ failed: true, plans: [], sites: [] });
  });
});

describe("failure logging", () => {
  it("a failed read logs only the error NAME, never the message (which can carry connection details) or the object", async () => {
    const boom = new Error("password authentication failed for user postgresql://u:hunter2@host/db");
    boom.name = "PrismaClientInitializationError";
    mockDb.transaction.findMany.mockRejectedValue(boom);
    const r = await loadSeasonalEnergySafe({ now: NOW });
    expect(r.failed).toBe(true);
    const logged = errSpy.mock.calls.flat();
    expect(logged.some((a) => typeof a !== "string")).toBe(false);
    expect(logged.join(" ")).toContain("PrismaClientInitializationError");
    expect(logged.join(" ")).not.toMatch(/hunter2|password|postgresql/);
  });

  it("a failed read of the seasonal-lines setting fails the whole load (not the default set), and is reported, not thrown, by the Safe wrapper", async () => {
    mockDb.appSetting.findUnique.mockRejectedValue(new Error("down"));
    const r = await loadSeasonalEnergySafe({ now: NOW });
    expect(r).toMatchObject({ failed: true, sites: [], plans: [] });
    expect(mockDb.transaction.findMany).not.toHaveBeenCalled();
  });
});
