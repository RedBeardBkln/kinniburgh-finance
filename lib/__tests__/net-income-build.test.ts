import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

// The loader is read-only with explicit selects; a failed deposit/paystub read degrades to a flagged gross, a
// failed source read propagates. The db is mocked at the function boundary (no test touches a real database).

const incomeFind = vi.fn();
const txFind = vi.fn();
const stubFind = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    incomeSource: { findMany: (...a: unknown[]) => incomeFind(...a) },
    transaction: { findMany: (...a: unknown[]) => txFind(...a) },
    paystub: { findMany: (...a: unknown[]) => stubFind(...a) },
  },
}));

import { loadNetIncomeSources, loadNetIncomeSourcesSafe } from "@/lib/net-income-build";

const NOW = new Date("2026-10-09T12:00:00Z");
const sourceRow = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  entityId: "e1",
  accountId: "a1",
  description: "payroll (Alpine Bio Inc)",
  cadence: "semi_monthly",
  dayRules: { daysOfMonth: [15, 31] },
  amount: new Decimal("9000"),
  active: true,
  ...over,
});
const tx = (date: string, amount: string, over: Record<string, unknown> = {}) => ({
  postedAt: new Date(`${date}T00:00:00Z`),
  amount: new Decimal(amount),
  payeeNormalized: "alpine bio inc payroll",
  accountId: "a1",
  entityId: "e1",
  ...over,
});

beforeEach(() => {
  incomeFind.mockReset();
  txFind.mockReset();
  stubFind.mockReset();
  stubFind.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("loadNetIncomeSources", () => {
  it("replaces amount with the net median and keeps the gross + basis", async () => {
    incomeFind.mockResolvedValue([sourceRow()]);
    txFind.mockResolvedValue([
      tx("2026-09-28", "6064.87"),
      tx("2026-09-14", "6064.86"),
      tx("2026-08-28", "6064.85"),
    ]);
    const rows = await loadNetIncomeSources({ now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount.toFixed(2)).toBe("6064.86");
    expect(rows[0]!.grossAmount.toFixed(2)).toBe("9000.00");
    expect(rows[0]!.amountBasis).toBe("deposits");
    expect(rows[0]!.netInfo.label).toContain("from your last 3 deposits");
  });

  it("uses explicit selects, read-only calls, and filters transfers / refunds / archived rows", async () => {
    incomeFind.mockResolvedValue([sourceRow()]);
    txFind.mockResolvedValue([]);
    await loadNetIncomeSources({ now: NOW, withAccount: true, withEntity: true, where: { accountId: "a1" } });
    const inc = incomeFind.mock.calls[0]![0] as Record<string, unknown>;
    expect(inc).not.toHaveProperty("include");
    expect(inc["select"]).toMatchObject({ amount: true, account: { select: { nickname: true, mask: true } }, entity: { select: { name: true } } });
    expect(inc["where"]).toEqual({ active: true, accountId: "a1" });
    const t = txFind.mock.calls[0]![0] as { where: Record<string, unknown>; select: Record<string, boolean>; take: number };
    expect(t.where).toMatchObject({ archivedAt: null, transferPairId: null, amount: { gt: 0 }, accountId: { in: ["a1"] } });
    expect(Object.keys(t.select).sort()).toEqual(["accountId", "amount", "entityId", "payeeNormalized", "postedAt"]);
    expect(t.take).toBe(400);
    const s = stubFind.mock.calls[0]![0] as { where: Record<string, unknown>; select: Record<string, boolean> };
    expect(s.where).toMatchObject({ archivedAt: null, confirmedAt: { not: null } });
    expect(s.select).not.toHaveProperty("extractionRaw");
    expect(s.select).not.toHaveProperty("employeeName");
  });

  it("enforces entity equality: another entity's deposits do not count", async () => {
    incomeFind.mockResolvedValue([sourceRow()]);
    txFind.mockResolvedValue([
      tx("2026-09-28", "6064.87", { entityId: "other" }),
      tx("2026-09-14", "6064.86", { entityId: "other" }),
      tx("2026-08-28", "6064.85", { entityId: "other" }),
    ]);
    const rows = await loadNetIncomeSources({ now: NOW });
    expect(rows[0]!.amountBasis).toBe("gross_unknown");
    expect(rows[0]!.amount.toFixed(2)).toBe("9000.00");
    expect(rows[0]!.netInfo.assumption).toBe(true);
  });

  it("a stub of another entity is not used", async () => {
    incomeFind.mockResolvedValue([sourceRow()]);
    txFind.mockResolvedValue([]);
    stubFind.mockResolvedValue([
      {
        entityId: "other",
        employerName: "Alpine Bio Inc",
        payDate: new Date("2026-09-28T00:00:00Z"),
        payFrequency: "semi_monthly",
        grossPayCents: 900000,
        netPayCents: 606485,
        depositAccountId: null,
      },
    ]);
    const rows = await loadNetIncomeSources({ now: NOW });
    expect(rows[0]!.amountBasis).toBe("gross_unknown");
  });

  it("a deposit read failure degrades to flagged gross and logs only the error name", async () => {
    incomeFind.mockResolvedValue([sourceRow()]);
    txFind.mockRejectedValue(Object.assign(new Error("secret 4111111111111111"), { name: "PrismaClientKnownRequestError" }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rows = await loadNetIncomeSources({ now: NOW });
    expect(rows[0]!.amountBasis).toBe("gross_unknown");
    expect(rows[0]!.amount.toFixed(2)).toBe("9000.00");
    expect(rows[0]!.netInfo.assumption).toBe(true);
    expect(rows[0]!.netInfo.label).toContain("take-home could not be read");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(["Net income inputs unavailable", "PrismaClientKnownRequestError"]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
  });

  it("a source read failure propagates (the safe variant returns failed)", async () => {
    incomeFind.mockRejectedValue(Object.assign(new Error("down"), { name: "PrismaClientInitializationError" }));
    await expect(loadNetIncomeSources({ now: NOW })).rejects.toThrow("down");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loadNetIncomeSourcesSafe({ now: NOW })).resolves.toEqual({ sources: [], failed: true });
    expect(spy.mock.calls[0]).toEqual(["Income sources unavailable", "PrismaClientInitializationError"]);
  });

  it("returns [] without reading deposits when there are no sources", async () => {
    incomeFind.mockResolvedValue([]);
    await expect(loadNetIncomeSources({ now: NOW })).resolves.toEqual([]);
    expect(txFind).not.toHaveBeenCalled();
  });

  it("two sources in one account resolve independently", async () => {
    incomeFind.mockResolvedValue([
      sourceRow(),
      sourceRow({
        id: "s2",
        description: "payroll (Seacoast Mushrooms LLC)",
        cadence: "biweekly",
        dayRules: { intervalDays: 14, anchorDate: "2026-08-28" },
        amount: new Decimal("2555"),
      }),
    ]);
    txFind.mockResolvedValue([
      tx("2026-09-28", "6064.86"),
      tx("2026-09-14", "6064.86"),
      tx("2026-08-28", "6064.86"),
      tx("2026-10-07", "2100", { payeeNormalized: "seacoast mushroo payroll" }),
      tx("2026-09-23", "2000", { payeeNormalized: "seacoast mushroo payroll" }),
      tx("2026-09-09", "2050", { payeeNormalized: "seacoast mushroo payroll" }),
    ]);
    const rows = await loadNetIncomeSources({ now: NOW });
    expect(rows.find((r) => r.id === "s1")!.amount.toFixed(2)).toBe("6064.86");
    expect(rows.find((r) => r.id === "s2")!.amount.toFixed(2)).toBe("2050.00");
  });
});
