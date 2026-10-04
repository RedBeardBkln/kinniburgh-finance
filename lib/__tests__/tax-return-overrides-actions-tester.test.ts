import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// Independent (Tester) action checks for T7. Unlike the Coder's file, the transaction
// client `tx` here is a DIFFERENT object from `db`, so a write issued outside the
// $transaction (on `db`) is detectable.

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const h = vi.hoisted(() => {
  const mk = () => ({
    taxReturnOverride: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  });
  return { db: { ...mk(), user: { findUnique: vi.fn() }, $transaction: vi.fn() }, tx: mk() };
});
vi.mock("@/lib/db", () => ({ db: h.db }));

const loader = vi.hoisted(() => ({ loadBaseAndActive: vi.fn(), loadOverrideHistory: vi.fn(), resolvePersonalEntityId: vi.fn() }));
vi.mock("@/lib/tax2025-overrides-build", () => loader);

import { clearTaxReturnOverride, setTaxReturnOverride } from "@/actions/tax-return-overrides";
import type { LineKey, ReturnLine, Ty2025Return } from "@/lib/tax2025/types";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const ROW = "55555555-5555-4555-8555-555555555555";

function ln(key: LineKey, amount: number | null, status: ReturnLine["status"] = "computed"): ReturnLine {
  return { key, form: "Schedule 1", formLine: "3", label: key, status, amount, exact: null, reason: null, ruleId: "r", citations: [], refs: [] };
}
function base(): Ty2025Return {
  const ha = { status: "computed" as const, amount: 0, reason: null };
  return {
    engineVersion: "test-engine-1",
    scheduleC: null,
    scheduleD: null,
    formsRequired: {},
    attestations: {
      digitalAssets: { value: false, status: "answered", where: "w", refs: [] },
      foreignAccounts: { value: false, status: "answered", where: "w", refs: [] },
    },
    taxYear: 2025,
    filingStatus: "mfj",
    lines: { "sch1.3": ln("sch1.3", 5000) },
    results: [
      { ruleId: "schedule-a", form: "A", status: "needs_cpa_judgment", lines: [], reasons: [], citations: [], inputsUsed: [], inputsMissing: [] },
    ],
    conflicts: [],
    openItems: [],
    decisions: [{ id: "X3", label: "QBI", chosen: "8995", status: "default_undecided" }],
    headline: {
      complete: false,
      federal: { agi: ha, taxableIncome: ha, totalTax: ha, totalPayments: ha, balance: ha },
      connecticut: { ctAgi: ha, tax: ha, totalPayments: ha, balance: ha },
      blockingItemCount: 0,
      unverifiedDocumentCount: 0,
      derivedInputCount: 0,
      undecidedDecisionCount: 0,
      caveats: [],
      provisional: null,
    },
    citations: [],
  };
}
const created = (over: Record<string, unknown> = {}) => ({
  id: ROW, taxYear: 2025, entityId: PERSONAL, targetKind: "line", targetKey: "sch1.3", version: 1, valueKind: "money_cents",
  valueCents: 600_000, valueText: null, authority: "cpa", reason: "r", ...over,
});
const outerWrites = () =>
  h.db.taxReturnOverride.create.mock.calls.length + h.db.taxReturnOverride.updateMany.mock.calls.length + h.db.auditLog.create.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  h.db.user.findUnique.mockResolvedValue({ name: "Eric Kinniburgh" });
  loader.loadBaseAndActive.mockResolvedValue({ entityId: PERSONAL, rows: [], base: base(), engineVersion: "test-engine-1" });
  h.db.$transaction.mockImplementation(async (fn: (tx: typeof h.tx) => Promise<unknown>) => fn(h.tx));
  h.tx.taxReturnOverride.findFirst.mockResolvedValue(null);
  h.tx.taxReturnOverride.findMany.mockResolvedValue([]);
  h.tx.taxReturnOverride.updateMany.mockResolvedValue({ count: 1 });
  h.tx.taxReturnOverride.create.mockResolvedValue(created());
  h.tx.auditLog.create.mockResolvedValue({});
});

describe("set: every write goes through the transaction client", () => {
  it("version read, archive, create and audit all use tx and none use the outer db", async () => {
    h.tx.taxReturnOverride.findFirst.mockResolvedValue({ version: 1 });
    h.tx.taxReturnOverride.findMany.mockResolvedValue([created({ id: "old", version: 1 })]);
    h.tx.taxReturnOverride.create.mockResolvedValue(created({ version: 2 }));
    const r = await setTaxReturnOverride({ taxYear: 2025, targetKind: "line", targetKey: "sch1.3", valueCents: 600_000, reason: "because CPA said" });
    expect(r).toEqual({ ok: true, id: ROW, version: 2 });
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(h.tx.taxReturnOverride.updateMany).toHaveBeenCalledTimes(1);
    expect(h.tx.taxReturnOverride.create).toHaveBeenCalledTimes(1);
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(outerWrites()).toBe(0);
  });

  it("a failure in the audit write aborts the whole set (the error propagates out of the transaction callback)", async () => {
    h.tx.auditLog.create.mockRejectedValue(new Error("audit down"));
    await expect(
      setTaxReturnOverride({ taxYear: 2025, targetKind: "line", targetKey: "sch1.3", valueCents: 600_000, reason: "because CPA said" })
    ).rejects.toThrow("audit down");
  });
});

describe("set: the server never trusts client-supplied extras", () => {
  it("ignores client-supplied snapshot / entity / version / names / base numbers", async () => {
    const evil = {
      taxYear: 2025, targetKind: "line" as const, targetKey: "sch1.3", valueCents: 600_000, reason: "because CPA said",
      computedSnapshot: { status: "computed", cents: 600_000 }, entityId: "evil-entity", version: 99, setByName: "Mallory", setById: "mallory",
      base: { lines: { "sch1.3": { amount: 600 } } }, archivedAt: "2020-01-01",
    };
    const r = await setTaxReturnOverride(evil as unknown as Parameters<typeof setTaxReturnOverride>[0]);
    expect(r.ok).toBe(true);
    const data = h.tx.taxReturnOverride.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.computedSnapshot).toEqual({ status: "computed", cents: 500_000, engineVersion: "test-engine-1" });
    expect(data.entityId).toBe(PERSONAL);
    expect(data.version).toBe(1);
    expect(data.setByName).toBe("Eric Kinniburgh");
    expect(data.setById).toBe(USER);
    expect(data).not.toHaveProperty("archivedAt");
    expect(JSON.stringify(data)).not.toContain("Mallory");
    expect(JSON.stringify(data)).not.toContain("evil-entity");
  });

  it("the equal-to-computed check uses the SERVER's base even if the client claims a different computed value", async () => {
    const r = await setTaxReturnOverride({
      taxYear: 2025, targetKind: "line", targetKey: "sch1.3", valueCents: 500_000, reason: "because CPA said",
      ...({ base: { lines: { "sch1.3": { amount: 1 } } } } as object),
    } as Parameters<typeof setTaxReturnOverride>[0]);
    expect(r).toMatchObject({ ok: false });
    expect(h.tx.taxReturnOverride.create).not.toHaveBeenCalled();
  });
});

describe("set: reason and amount boundaries", () => {
  const go = (reason: string, valueCents = 600_000) =>
    setTaxReturnOverride({ taxYear: 2025, targetKind: "line", targetKey: "sch1.3", valueCents, reason });

  it("accepts 3 and 500 characters (after trim), stores the trimmed text, rejects 2 and 501", async () => {
    expect((await go("abc")).ok).toBe(true);
    expect((await go("  abc  ")).ok).toBe(true);
    expect(h.tx.taxReturnOverride.create.mock.calls[1]![0].data.reason).toBe("abc");
    expect((await go("x".repeat(500))).ok).toBe(true);
    expect((await go(`  ${"x".repeat(500)}  `)).ok).toBe(true); // trimmed to 500
    expect((await go("ab")).ok).toBe(false);
    expect((await go("x".repeat(501))).ok).toBe(false);
    expect((await go("\n\t \n")).ok).toBe(false);
  });

  it("accepts +/- $21,000,000 and zero, rejects one dollar beyond; rejects Infinity and unsafe ints", async () => {
    expect((await go("because", 2_100_000_000)).ok).toBe(true);
    expect((await go("because", -2_100_000_000)).ok).toBe(true);
    expect((await go("because", 0)).ok).toBe(true);
    expect((await go("because", 2_100_000_100)).ok).toBe(false);
    expect((await go("because", Infinity)).ok).toBe(false);
    expect((await go("because", Number.MAX_SAFE_INTEGER)).ok).toBe(false);
  });

  it("rejects a non-string reason, a non-number amount and an unknown authority without any write", async () => {
    const call = (o: object) => setTaxReturnOverride({ taxYear: 2025, targetKind: "line", targetKey: "sch1.3", valueCents: 600_000, reason: "because", ...o } as Parameters<typeof setTaxReturnOverride>[0]);
    expect((await call({ reason: 12345 })).ok).toBe(false);
    expect((await call({ valueCents: "6000" })).ok).toBe(false);
    expect((await call({ authority: "admin" })).ok).toBe(false);
    expect((await call({ taxYear: "2025" })).ok).toBe(false);
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

describe("audit payloads: ids / keys / versions / values only, never reason text (all three kinds)", () => {
  const SECRET = "ZZ-SECRET-REASON-ZZ";
  const auditJson = () => JSON.stringify(h.tx.auditLog.create.mock.calls.map((c) => c[0]));

  it("line, decision and rule_ack sets, with a prior row that has its own reason and archiveReason", async () => {
    const prior = created({ id: "p", reason: SECRET, archiveReason: SECRET, snapshot: SECRET });
    h.tx.taxReturnOverride.findFirst.mockResolvedValue({ version: 1 });
    h.tx.taxReturnOverride.findMany.mockResolvedValue([prior]);
    await setTaxReturnOverride({ taxYear: 2025, targetKind: "line", targetKey: "sch1.3", valueCents: 600_000, reason: SECRET });
    h.tx.taxReturnOverride.create.mockResolvedValue(created({ targetKind: "decision", targetKey: "qbiForm", valueKind: "choice", valueCents: null, valueText: "8995a" }));
    await setTaxReturnOverride({ taxYear: 2025, targetKind: "decision", targetKey: "qbiForm", choice: "8995a", reason: SECRET });
    h.tx.taxReturnOverride.create.mockResolvedValue(created({ targetKind: "rule_ack", targetKey: "schedule-a", valueKind: "ack", valueCents: null }));
    await setTaxReturnOverride({ taxYear: 2025, targetKind: "rule_ack", targetKey: "schedule-a", reason: SECRET });
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(3);
    expect(auditJson()).not.toContain("SECRET");
    expect(auditJson()).not.toMatch(/reason/i);
    for (const call of h.tx.auditLog.create.mock.calls) {
      const d = call[0].data as { changeType: string; changedBy: string; after: Record<string, unknown> };
      expect(d.changeType).toBe("tax_return_override_set");
      expect(d.changedBy).toBe(USER);
      expect(Object.keys(d.after).sort()).toEqual(["authority", "id", "targetKey", "targetKind", "taxYear", "valueCents", "valueKind", "valueText", "version"]);
    }
  });

  it("clear: before-image has no reason/archiveReason even when the row carries both", async () => {
    h.db.taxReturnOverride.findFirst.mockResolvedValue(created({ reason: SECRET, archiveReason: SECRET }));
    const r = await clearTaxReturnOverride({ id: ROW, reason: SECRET });
    expect(r.ok).toBe(true);
    expect(auditJson()).not.toContain("SECRET");
    expect(h.tx.taxReturnOverride.updateMany.mock.calls[0]![0].data.archiveReason).toBe(SECRET); // stored, but only on the row
    expect(h.tx.taxReturnOverride.delete).not.toHaveBeenCalled();
    expect(h.db.taxReturnOverride.delete).not.toHaveBeenCalled();
    expect(outerWrites()).toBe(0);
  });
});

describe("supersede race", () => {
  it("P2002 thrown by the version-unique index on create returns `conflict`, and writes no audit row", async () => {
    h.tx.taxReturnOverride.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "t" }));
    const r = await setTaxReturnOverride({ taxYear: 2025, targetKind: "line", targetKey: "sch1.3", valueCents: 600_000, reason: "because" });
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a non-unique known error (P2003 FK) is NOT reported as a conflict", async () => {
    h.tx.taxReturnOverride.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "t" }));
    await expect(
      setTaxReturnOverride({ taxYear: 2025, targetKind: "line", targetKey: "sch1.3", valueCents: 600_000, reason: "because" })
    ).rejects.toThrow("fk");
  });
});

describe("the loader module is wired (the core's not_wired stub is gone)", () => {
  it("exports the real loaders and no BaseReturnNotWiredError / computeBaseReturn stub", async () => {
    const real = await vi.importActual<typeof import("@/lib/tax2025-overrides-build")>("@/lib/tax2025-overrides-build");
    expect(typeof real.buildTy2025ReturnWithOverrides).toBe("function");
    expect(typeof real.loadBaseAndActive).toBe("function");
    expect("BaseReturnNotWiredError" in real).toBe(false);
    expect("computeBaseReturn" in real).toBe(false);
  });
});
