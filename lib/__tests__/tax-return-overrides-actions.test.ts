import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";

// Mocks at the db / auth / loader boundary (repo convention: no integrated DB tests).
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

const mockDb = vi.hoisted(() => {
  const m = {
    user: { findUnique: vi.fn() },
    taxReturnOverride: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  return m;
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

const loader = vi.hoisted(() => ({
  loadBaseAndActive: vi.fn(),
  loadOverrideHistory: vi.fn(),
  resolvePersonalEntityId: vi.fn(),
}));
vi.mock("@/lib/tax2025-overrides-build", () => loader);

import { clearTaxReturnOverride, listTaxReturnOverrideHistory, setTaxReturnOverride } from "@/actions/tax-return-overrides";
import type { LineKey, ReturnLine, RuleStatus, Ty2025Return } from "@/lib/tax2025/types";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const ROW = "55555555-5555-4555-8555-555555555555";
const REASON = "CPA instruction by phone, call 10/7";
const ENGINE = "test-engine-1";

function line(key: LineKey, amount: number | null, status: RuleStatus = "computed"): ReturnLine {
  return { key, form: "Schedule 1", formLine: "3", label: key, status, amount, exact: null, reason: null, ruleId: "r", citations: [], refs: [] };
}

function base(): Ty2025Return {
  return {
    engineVersion: ENGINE,
    taxYear: 2025,
    filingStatus: "mfj",
    lines: { "sch1.3": line("sch1.3", 12345), "sch1.13": line("sch1.13", null, "missing_input") },
    results: [
      { ruleId: "schedule-a", form: "Schedule A", status: "needs_cpa_judgment", lines: [], reasons: [], citations: [], inputsUsed: [], inputsMissing: [] },
      { ruleId: "tax-calc", form: "Form 1040", status: "computed", lines: [], reasons: [], citations: [], inputsUsed: [], inputsMissing: [] },
    ],
    conflicts: [],
    openItems: [],
    decisions: [{ id: "X1", label: "Home office", chosen: "simplified", status: "default_undecided" }],
    headline: {
      complete: false,
      federal: {
        agi: { status: "computed", amount: 0, reason: null },
        taxableIncome: { status: "computed", amount: 0, reason: null },
        totalTax: { status: "computed", amount: 0, reason: null },
        totalPayments: { status: "computed", amount: 0, reason: null },
        balance: { status: "computed", amount: 0, reason: null },
      },
      connecticut: {
        ctAgi: { status: "computed", amount: 0, reason: null },
        tax: { status: "computed", amount: 0, reason: null },
        totalPayments: { status: "computed", amount: 0, reason: null },
        balance: { status: "computed", amount: 0, reason: null },
      },
      blockingItemCount: 0,
      unverifiedDocumentCount: 0,
      derivedInputCount: 0,
      undecidedDecisionCount: 0,
      caveats: [],
      provisional: null,
    },
    citations: [],
    scheduleC: null,
    scheduleD: null,
    formsRequired: {},
    attestations: {
      digitalAssets: { value: false, status: "answered", where: "w", refs: [] },
      foreignAccounts: { value: false, status: "answered", where: "w", refs: [] },
    },
  };
}

const lineInput = { taxYear: 2025, targetKind: "line" as const, targetKey: "sch1.3", valueCents: 1_300_000, reason: REASON };

function createdRow(over: Record<string, unknown> = {}) {
  return {
    id: ROW,
    taxYear: 2025,
    entityId: PERSONAL,
    targetKind: "line",
    targetKey: "sch1.3",
    version: 1,
    valueKind: "money_cents",
    valueCents: 1_300_000,
    valueText: null,
    authority: "cpa",
    reason: REASON,
    ...over,
  };
}

function writes() {
  return mockDb.taxReturnOverride.create.mock.calls.length + mockDb.taxReturnOverride.updateMany.mock.calls.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.user.findUnique.mockResolvedValue({ name: "Eric Kinniburgh" });
  loader.loadBaseAndActive.mockResolvedValue({ entityId: PERSONAL, rows: [], base: base(), engineVersion: ENGINE });
  loader.resolvePersonalEntityId.mockResolvedValue(PERSONAL);
  loader.loadOverrideHistory.mockResolvedValue([]);
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
  mockDb.taxReturnOverride.findFirst.mockResolvedValue(null);
  mockDb.taxReturnOverride.findMany.mockResolvedValue([]);
  mockDb.taxReturnOverride.updateMany.mockResolvedValue({ count: 1 });
  mockDb.taxReturnOverride.create.mockResolvedValue(createdRow());
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("auth gate", () => {
  it("every export rejects an unauthenticated caller before any db or loader call", async () => {
    authMock.mockResolvedValue(null);
    await expect(setTaxReturnOverride(lineInput)).rejects.toThrow("Unauthorized");
    await expect(clearTaxReturnOverride({ id: ROW, reason: REASON })).rejects.toThrow("Unauthorized");
    await expect(listTaxReturnOverrideHistory({ taxYear: 2025, targetKind: "line", targetKey: "sch1.3" })).rejects.toThrow("Unauthorized");
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.taxReturnOverride.findFirst).not.toHaveBeenCalled();
    expect(loader.loadBaseAndActive).not.toHaveBeenCalled();
    expect(loader.loadOverrideHistory).not.toHaveBeenCalled();
    expect(loader.resolvePersonalEntityId).not.toHaveBeenCalled();
  });

  it("source check: every export starts with `const user = await requireAuth();` or `await requireAuth();`", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/tax-return-overrides.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(src.trimStart().startsWith('"use server";')).toBe(true);
    const names = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(names.sort()).toEqual(["clearTaxReturnOverride", "listTaxReturnOverrideHistory", "setTaxReturnOverride"]);
    for (const name of names) {
      const start = src.indexOf(`export async function ${name}`);
      const open = src.indexOf("{\n", start) + 2;
      const body = src.slice(open, open + 120).trimStart();
      expect(body.startsWith("const user = await requireAuth();") || body.startsWith("await requireAuth();"), name).toBe(true);
    }
    // nothing but async functions is exported from a "use server" file
    expect([...src.matchAll(/^export (?!async function|type )/gm)]).toEqual([]);
  });

  it("source check: no hard delete, no `any`, and the audit shape never mentions a reason", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/tax-return-overrides.ts"), "utf8");
    expect(src).not.toMatch(/\.delete\(|\.deleteMany\(/);
    expect(src).not.toMatch(/:\s*any\b|as any\b/);
    const shape = src.slice(src.indexOf("function auditShape"), src.indexOf("function isUniqueViolation"));
    expect(shape.length).toBeGreaterThan(50);
    expect(shape).not.toMatch(/reason/i);
    // every auditLog.create call in the file passes an auditShape (or JsonNull), not a row
    for (const m of src.matchAll(/auditLog\.create\(\{[\s\S]*?\}\s*\)/g)) {
      expect(m[0]).not.toMatch(/reason/i);
    }
  });
});

describe("setTaxReturnOverride: validation (nothing is written on a rejection)", () => {
  it("rejects a reason that is too short or too long", async () => {
    expect((await setTaxReturnOverride({ ...lineInput, reason: "ab" })).ok).toBe(false);
    expect((await setTaxReturnOverride({ ...lineInput, reason: "   a  " })).ok).toBe(false);
    expect((await setTaxReturnOverride({ ...lineInput, reason: "x".repeat(501) })).ok).toBe(false);
    expect(writes()).toBe(0);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("rejects non-integer, cents and out-of-bound amounts", async () => {
    expect((await setTaxReturnOverride({ ...lineInput, valueCents: 1.5 })).ok).toBe(false);
    expect((await setTaxReturnOverride({ ...lineInput, valueCents: 1_300_050 })).ok).toBe(false);
    expect((await setTaxReturnOverride({ ...lineInput, valueCents: 2_100_000_100 })).ok).toBe(false);
    expect((await setTaxReturnOverride({ ...lineInput, valueCents: Number.NaN })).ok).toBe(false);
    expect(writes()).toBe(0);
  });

  it("rejects an unsupported tax year, an unknown kind, and an unknown decision key", async () => {
    expect((await setTaxReturnOverride({ ...lineInput, taxYear: 2024 })).ok).toBe(false);
    // @ts-expect-error deliberately invalid kind
    expect((await setTaxReturnOverride({ ...lineInput, targetKind: "free_text" })).ok).toBe(false);
    expect((await setTaxReturnOverride({ taxYear: 2025, targetKind: "decision", targetKey: "notADecision", choice: "actual", reason: REASON })).ok).toBe(false);
    expect(writes()).toBe(0);
  });

  it("rejects a line the computed return does not carry (unknown / pending key)", async () => {
    const res = await setTaxReturnOverride({ ...lineInput, targetKey: "f1040.27a" });
    expect(res.ok).toBe(false);
    expect((await setTaxReturnOverride({ ...lineInput, targetKey: "sch1.20" })).ok).toBe(false); // a real key, absent from this return
    expect(writes()).toBe(0);
  });

  it("rejects an override equal to the computed value ('no change')", async () => {
    const res = await setTaxReturnOverride({ ...lineInput, valueCents: 1_234_500 });
    expect(res).toEqual({ ok: false, error: "No change: the override equals the computed value." });
    expect(writes()).toBe(0);
  });

  it("rejects a decision choice outside the registry and an unknown / non-ackable rule", async () => {
    const bad = await setTaxReturnOverride({ taxYear: 2025, targetKind: "decision", targetKey: "homeOfficeMethod", choice: "weird", reason: REASON });
    expect(bad.ok).toBe(false);
    expect((await setTaxReturnOverride({ taxYear: 2025, targetKind: "rule_ack", targetKey: "tax-calc", reason: REASON })).ok).toBe(false); // computed
    expect((await setTaxReturnOverride({ taxYear: 2025, targetKind: "rule_ack", targetKey: "nope", reason: REASON })).ok).toBe(false);
    expect(writes()).toBe(0);
  });

  it("returns the loader's plain error (fail-closed) when the overrides or the return cannot be loaded", async () => {
    loader.loadBaseAndActive.mockResolvedValue({ error: "The recorded CPA overrides could not be read, so the return is not shown." });
    const res = await setTaxReturnOverride(lineInput);
    expect(res).toEqual({ ok: false, error: "The recorded CPA overrides could not be read, so the return is not shown." });
    expect(writes()).toBe(0);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("fails cleanly when the Personal entity is missing", async () => {
    loader.loadBaseAndActive.mockResolvedValue({ error: "The Personal entity was not found." });
    expect((await setTaxReturnOverride(lineInput)).ok).toBe(false);
    expect(writes()).toBe(0);
  });
});

describe("a reason that looks like a Social Security Number is refused BEFORE any db or engine call", () => {
  const SSN_REASONS = ["per CPA: SSN 123-45-6789", "ssn is 123 45 6789 ok", "123456789 was typed", "use 123.45.6789"];

  it.each(SSN_REASONS)("set refuses %j with no db, loader or write", async (reason) => {
    const res = await setTaxReturnOverride({ ...lineInput, reason });
    expect(res).toEqual({ ok: false, error: "The reason looks like a Social Security Number; remove it." });
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(loader.loadBaseAndActive).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(SSN_REASONS)("clear refuses %j with no db read or write", async (reason) => {
    const res = await clearTaxReturnOverride({ id: ROW, reason });
    expect(res).toEqual({ ok: false, error: "The reason looks like a Social Security Number; remove it." });
    expect(mockDb.taxReturnOverride.findFirst).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("an ordinary reason with dates, amounts and a year is NOT mistaken for an SSN", async () => {
    const res = await setTaxReturnOverride({ ...lineInput, reason: "CPA call 2026-10-07 about $12,345 for tax year 2025" });
    expect(res.ok).toBe(true);
  });

  it("a successful audit row never holds the reason or any SSN-like text", async () => {
    await setTaxReturnOverride({ ...lineInput, reason: "Because the CPA said so on the 7th" });
    const audit = JSON.stringify(mockDb.auditLog.create.mock.calls[0]![0].data);
    expect(audit).not.toMatch(/\b\d{3}[-\s.]?\d{2}[-\s.]?\d{4}\b/);
    expect(audit).not.toContain("CPA said so");
  });
});

describe("setTaxReturnOverride: writes", () => {
  it("creates version 1 with a server-computed snapshot, who/when, and no archive when none is active", async () => {
    const res = await setTaxReturnOverride(lineInput);
    expect(res).toEqual({ ok: true, id: ROW, version: 1 });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.taxReturnOverride.updateMany).not.toHaveBeenCalled();
    const data = mockDb.taxReturnOverride.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      taxYear: 2025,
      entityId: PERSONAL,
      targetKind: "line",
      targetKey: "sch1.3",
      version: 1,
      valueKind: "money_cents",
      valueCents: 1_300_000,
      valueText: null,
      authority: "owner",
      reason: REASON,
      setById: USER,
      setByName: "Eric Kinniburgh",
    });
    // the snapshot is the SERVER's base line (12,345 dollars), never a client value
    expect(data.computedSnapshot).toEqual({ status: "computed", cents: 1_234_500, engineVersion: ENGINE });
    expect(revalidateMock).toHaveBeenCalledWith("/tax/forms/2025");
    expect(revalidateMock).toHaveBeenCalledWith("/tax/forms/2025/return");
  });

  it("supersedes: archives the active row (superseded) and creates version + 1", async () => {
    mockDb.taxReturnOverride.findFirst.mockResolvedValue({ version: 2 });
    mockDb.taxReturnOverride.findMany.mockResolvedValue([createdRow({ id: "prev-id", version: 2, valueCents: 900_000 })]);
    mockDb.taxReturnOverride.create.mockResolvedValue(createdRow({ version: 3 }));
    const res = await setTaxReturnOverride({ ...lineInput, authority: "owner" });
    expect(res).toEqual({ ok: true, id: ROW, version: 3 });

    const upd = mockDb.taxReturnOverride.updateMany.mock.calls[0]![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(upd.where).toEqual({ id: { in: ["prev-id"] }, archivedAt: null });
    expect(upd.data).toMatchObject({ archiveKind: "superseded", archivedById: USER });
    expect(upd.data.archivedAt).toBeInstanceOf(Date);
    const created = mockDb.taxReturnOverride.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(created.version).toBe(3);
    expect(created.authority).toBe("owner");
    // the previous row is archived BEFORE the new one is created
    expect(mockDb.taxReturnOverride.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDb.taxReturnOverride.create.mock.invocationCallOrder[0]!
    );
    const audit = mockDb.auditLog.create.mock.calls[0]![0].data as { before: { version: number }; after: { version: number } };
    expect(audit.before.version).toBe(2);
    expect(audit.after.version).toBe(3);
  });

  it("a re-set after a clear continues the version sequence (never reuses a version)", async () => {
    mockDb.taxReturnOverride.findFirst.mockResolvedValue({ version: 4 }); // latest row is archived (cleared)
    mockDb.taxReturnOverride.findMany.mockResolvedValue([]);
    await setTaxReturnOverride(lineInput);
    expect(mockDb.taxReturnOverride.create.mock.calls[0]![0].data.version).toBe(5);
    expect(mockDb.taxReturnOverride.updateMany).not.toHaveBeenCalled();
  });

  it("a concurrent double-write (P2002) becomes a friendly conflict result, not a throw", async () => {
    mockDb.taxReturnOverride.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
    );
    const res = await setTaxReturnOverride(lineInput);
    expect(res).toMatchObject({ ok: false, code: "conflict" });
    expect(revalidateMock).not.toHaveBeenCalled();
    // any other failure is not swallowed
    mockDb.taxReturnOverride.create.mockRejectedValue(new Error("boom"));
    await expect(setTaxReturnOverride(lineInput)).rejects.toThrow("boom");
  });

  it("the AuditLog rows contain ids / keys / values but NO reason text", async () => {
    mockDb.taxReturnOverride.findFirst.mockResolvedValue({ version: 1 });
    mockDb.taxReturnOverride.findMany.mockResolvedValue([createdRow({ id: "prev-id", version: 1, reason: "SECRET PRIOR REASON" })]);
    await setTaxReturnOverride({ ...lineInput, reason: "SECRET NEW REASON" });
    const audit = mockDb.auditLog.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(audit.changeType).toBe("tax_return_override_set");
    expect(audit.changedBy).toBe(USER);
    const text = JSON.stringify(audit);
    expect(text).not.toContain("SECRET");
    expect(text).not.toMatch(/reason/i);
    expect(audit.after).toMatchObject({ taxYear: 2025, targetKind: "line", targetKey: "sch1.3", version: 1, valueKind: "money_cents", valueCents: 1_300_000, authority: "cpa" });
  });

  it("records a decision (choice id only) and an acknowledgement (no value)", async () => {
    mockDb.taxReturnOverride.create.mockResolvedValue(createdRow({ targetKind: "decision", targetKey: "homeOfficeMethod", valueKind: "choice", valueCents: null, valueText: "actual" }));
    await setTaxReturnOverride({ taxYear: 2025, targetKind: "decision", targetKey: "homeOfficeMethod", choice: "actual", reason: REASON });
    const d = mockDb.taxReturnOverride.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(d).toMatchObject({ targetKind: "decision", targetKey: "homeOfficeMethod", valueKind: "choice", valueText: "actual", valueCents: null });
    expect(d.computedSnapshot).toEqual({ status: "default_undecided", cents: null, engineVersion: ENGINE });

    await setTaxReturnOverride({ taxYear: 2025, targetKind: "rule_ack", targetKey: "schedule-a", reason: REASON });
    const a = mockDb.taxReturnOverride.create.mock.calls[1]![0].data as Record<string, unknown>;
    expect(a).toMatchObject({ targetKind: "rule_ack", targetKey: "schedule-a", valueKind: "ack", valueCents: null, valueText: null });
    expect(a.computedSnapshot).toEqual({ status: "needs_cpa_judgment", cents: null, engineVersion: ENGINE });
  });

  it("takes the engine version for the snapshot from the loader (the return the sheet shows)", async () => {
    loader.loadBaseAndActive.mockResolvedValue({ entityId: PERSONAL, rows: [], base: base(), engineVersion: "2025.3" });
    await setTaxReturnOverride(lineInput);
    expect(mockDb.taxReturnOverride.create.mock.calls[0]![0].data.computedSnapshot).toEqual({
      status: "computed",
      cents: 1_234_500,
      engineVersion: "2025.3",
    });
  });
});

describe("clearTaxReturnOverride", () => {
  it("requires a reason and a uuid, without touching the db", async () => {
    expect((await clearTaxReturnOverride({ id: ROW, reason: "" })).ok).toBe(false);
    expect((await clearTaxReturnOverride({ id: ROW, reason: "ab" })).ok).toBe(false);
    expect((await clearTaxReturnOverride({ id: "not-a-uuid", reason: REASON })).ok).toBe(false);
    expect(mockDb.taxReturnOverride.findFirst).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("archives (cleared) with who/when/reason, never deletes, and audits without the reason", async () => {
    mockDb.taxReturnOverride.findFirst.mockResolvedValue(createdRow());
    const res = await clearTaxReturnOverride({ id: ROW, reason: "SECRET CLEAR REASON" });
    expect(res).toEqual({ ok: true, id: ROW, version: 1 });
    expect(mockDb.taxReturnOverride.findFirst).toHaveBeenCalledWith({ where: { id: ROW, archivedAt: null } });
    const upd = mockDb.taxReturnOverride.updateMany.mock.calls[0]![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(upd.where).toEqual({ id: ROW, archivedAt: null });
    expect(upd.data).toMatchObject({ archiveKind: "cleared", archivedById: USER, archiveReason: "SECRET CLEAR REASON" });
    expect(upd.data.archivedAt).toBeInstanceOf(Date);
    expect(mockDb.taxReturnOverride.delete).not.toHaveBeenCalled();
    expect(mockDb.taxReturnOverride.deleteMany).not.toHaveBeenCalled();
    const audit = mockDb.auditLog.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(audit.changeType).toBe("tax_return_override_clear");
    expect(JSON.stringify(audit)).not.toContain("SECRET");
    expect(JSON.stringify(audit)).not.toMatch(/reason/i);
    expect(revalidateMock).toHaveBeenCalledWith("/tax/forms/2025");
  });

  it("reports 'not found' for an already archived row (also when it loses a race)", async () => {
    mockDb.taxReturnOverride.findFirst.mockResolvedValue(null);
    expect((await clearTaxReturnOverride({ id: ROW, reason: REASON })).ok).toBe(false);
    mockDb.taxReturnOverride.findFirst.mockResolvedValue(createdRow());
    mockDb.taxReturnOverride.updateMany.mockResolvedValue({ count: 0 });
    expect((await clearTaxReturnOverride({ id: ROW, reason: REASON })).ok).toBe(false);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("listTaxReturnOverrideHistory", () => {
  it("returns every version (archived included) with reasons, as plain strings", async () => {
    loader.loadOverrideHistory.mockResolvedValue([
      { ...createdRow({ version: 2 }), setByName: "Eric Kinniburgh", setAt: new Date("2026-10-12T02:30:00Z"), archivedAt: null, archiveKind: null, archiveReason: null },
      {
        ...createdRow({ version: 1, reason: "first reason" }),
        setByName: "Eric Kinniburgh",
        setAt: new Date("2026-10-11T12:00:00Z"),
        archivedAt: new Date("2026-10-12T02:30:00Z"),
        archiveKind: "superseded",
        archiveReason: null,
      },
    ]);
    const res = await listTaxReturnOverrideHistory({ taxYear: 2025, targetKind: "line", targetKey: "sch1.3" });
    expect(loader.loadOverrideHistory).toHaveBeenCalledWith(2025, PERSONAL, "line", "sch1.3");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.rows.map((r) => r.version)).toEqual([2, 1]);
    expect(res.rows[1]).toMatchObject({ reason: "first reason", archiveKind: "superseded", archivedAt: "2026-10-12T02:30:00.000Z" });
    expect(res.rows[0]?.setAt).toBe("2026-10-12T02:30:00.000Z");
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects invalid input without querying", async () => {
    // @ts-expect-error deliberately invalid kind
    expect((await listTaxReturnOverrideHistory({ taxYear: 2025, targetKind: "nope", targetKey: "x" })).ok).toBe(false);
    expect((await listTaxReturnOverrideHistory({ taxYear: 1999, targetKind: "line", targetKey: "x" })).ok).toBe(false);
    expect(loader.loadOverrideHistory).not.toHaveBeenCalled();
  });
});
