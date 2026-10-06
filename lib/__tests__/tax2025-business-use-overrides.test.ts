// The business-use percentage decision through the override layer (engine ty2025-1b.9): rows -> engine decisions -> effective view,
// and the set action with a mocked db (repo convention: no integrated DB tests).

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  taxReturnOverride: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
const loader = vi.hoisted(() => ({ loadBaseAndActive: vi.fn(), loadOverrideHistory: vi.fn(), resolvePersonalEntityId: vi.fn() }));
vi.mock("@/lib/tax2025-overrides-build", () => loader);

import { setTaxReturnOverride } from "@/actions/tax-return-overrides";
import { downstreamOf } from "@/lib/tax2025/line-flow";
import { applyOverrides, decisionsFromOverrides, formatOverrideNote, type OverrideRow } from "@/lib/tax2025/overrides";
import { TY2025_ENGINE_VERSION, computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { LineKey, Ty2025Return } from "@/lib/tax2025/types";
import { fullFacts1b, gl, owner } from "@/lib/__tests__/tax2025-fixtures";

const REASON = "Bill split: two of the three people on the plan work from home; usage log kept.";
const TARGET = "businessUse.internet_phone";
const AT = new Date("2026-10-06T16:00:00.000Z");

function facts(withAccount = true): Ty2025Facts {
  const f = fullFacts1b();
  if (withAccount) f.income.scheduleC.glLines = [...f.income.scheduleC.glLines, gl("6100", "Utilities:Internet & Phone", "expense", 261_017)];
  return f;
}

function row(over: Partial<OverrideRow> = {}): OverrideRow {
  return {
    id: "row-1",
    taxYear: 2025,
    targetKind: "decision",
    targetKey: TARGET,
    version: 1,
    valueKind: "choice",
    valueCents: null,
    valueText: "70",
    computedSnapshot: { status: "default_undecided", cents: null, engineVersion: TY2025_ENGINE_VERSION },
    authority: "owner",
    reason: REASON,
    setByName: "Eric",
    setAt: AT,
    archivedAt: null,
    ...over,
  };
}

/** The server's recompute: engine decisions from the rows, then the effective view. */
function run(rows: OverrideRow[], f: Ty2025Facts = facts()): { base: Ty2025Return; eff: ReturnType<typeof applyOverrides> } {
  const base = computeTy2025Return(f, decisionsFromOverrides(rows));
  return { base, eff: applyOverrides(base, rows) };
}

describe("decisionsFromOverrides: business-use rows", () => {
  it("turns a recorded percent into the engine input (tenths, who, when); canonical text", () => {
    expect(decisionsFromOverrides([row()]).businessUse).toEqual({ internet_phone: { percentTenths: 700, by: "Eric", at: AT.toISOString() } });
    expect(decisionsFromOverrides([row({ valueText: "70.5" })]).businessUse?.internet_phone?.percentTenths).toBe(705);
    expect(decisionsFromOverrides([row({ valueText: "0" })]).businessUse?.internet_phone?.percentTenths).toBe(0);
    expect(decisionsFromOverrides([row({ valueText: "100" })]).businessUse?.internet_phone?.percentTenths).toBe(1000);
  });
  it("ignores an unparseable value, an unknown key, an archived row and a non-decision row; nothing recorded = no businessUse key", () => {
    for (const valueText of ["abc", "101", "-5", "70.55", "", "1e2"]) {
      expect(decisionsFromOverrides([row({ valueText })]).businessUse, valueText).toBeUndefined();
    }
    expect(decisionsFromOverrides([row({ targetKey: "businessUse.nope" })]).businessUse).toBeUndefined();
    expect(decisionsFromOverrides([row({ archivedAt: AT })]).businessUse).toBeUndefined();
    expect(decisionsFromOverrides([]).businessUse).toBeUndefined();
  });
  it("the highest version wins; a cleared (archived) latest row returns to the default", () => {
    const v1 = row({ id: "a", version: 1, valueText: "70", archivedAt: AT });
    const v2 = row({ id: "b", version: 2, valueText: "60" });
    expect(decisionsFromOverrides([v1, v2]).businessUse?.internet_phone?.percentTenths).toBe(600);
    expect(decisionsFromOverrides([v1, { ...v2, archivedAt: AT }]).businessUse).toBeUndefined();
  });
  it("does not disturb the registry decisions", () => {
    const d = decisionsFromOverrides([row(), row({ id: "h", targetKey: "homeOfficeMethod", valueText: "actual" })]);
    expect(d.homeOfficeMethod?.chosen).toBe("actual");
    expect(d.businessUse?.internet_phone?.percentTenths).toBe(700);
  });
});

describe("applyOverrides with a recorded percentage", () => {
  it("recompute -> decided, the note reads '70%', no 'not reflected' item, nothing stale", () => {
    const { base, eff } = run([row()]);
    expect(base.lines["schc.25"]?.amount).toBe(1827);
    const d = eff.decisions.find((x) => x.id === "X6");
    expect(d).toMatchObject({ chosen: "70%", status: "decided" });
    expect(d?.override).toMatchObject({ decisionId: "X6", choice: "70", display: "70%", stale: null });
    expect(eff.openItems.some((i) => i.id.startsWith("override-decision-not-reflected"))).toBe(false);
    expect(eff.stale).toEqual([]);
    expect(eff.orphans).toEqual([]);
    expect(eff.engineChanged).toEqual([]);
    const note = formatOverrideNote(eff.applied.decisions[0]!);
    expect(note).toContain("set to 70%");
    expect(note).toContain("by Eric (owner)");
    expect(note).toContain(`reason: ${REASON}`);
    expect(note).not.toContain("set to 70,");
  });
  it("a decimal reads '70.5%'", () => {
    const { eff } = run([row({ valueText: "70.5" })]);
    expect(eff.decisions.find((x) => x.id === "X6")?.override?.display).toBe("70.5%");
    expect(eff.openItems.some((i) => i.id.startsWith("override-decision-not-reflected"))).toBe(false);
  });
  it("0 and 100 are decided too (no false 'not reflected')", () => {
    for (const v of ["0", "100"]) {
      const { eff } = run([row({ valueText: v })]);
      expect(eff.decisions.find((x) => x.id === "X6")?.status, v).toBe("decided");
      expect(eff.openItems.some((i) => i.severity === "blocking" && i.id.startsWith("override-")), v).toBe(false);
    }
  });
  it("an engine that did not get the decision is reported as a BLOCKING 'not reflected' item (never silently trusted)", () => {
    const base = computeTy2025Return(facts(), {}); // the rows were not fed to the engine
    const eff = applyOverrides(base, [row()]);
    const item = eff.openItems.find((i) => i.id === `override-decision-not-reflected:${TARGET}`);
    expect(item?.severity).toBe("blocking");
  });
  it("an unparseable stored value is an advisory orphan, the engine stays at the default", () => {
    const { base, eff } = run([row({ valueText: "101" })]);
    expect(base.decisions.find((d) => d.id === "X6")?.status).toBe("default_undecided");
    expect(eff.orphans.map((o) => o.targetKey)).toEqual([TARGET]);
    expect(eff.orphans[0]?.message).toContain("no longer a valid choice");
    expect(eff.openItems.find((i) => i.id === `override-orphan:decision:${TARGET}`)?.severity).toBe("advisory");
  });
  it("an unknown list key is an orphan advisory", () => {
    const { eff } = run([row({ targetKey: "businessUse.nope" })]);
    expect(eff.orphans[0]?.message).toContain("is not a decision this engine knows");
  });
  it("a recorded decision for an account that has no balance is an orphan advisory, no crash", () => {
    const { base, eff } = run([row()], facts(false));
    expect(base.decisions.some((d) => d.id === "X6")).toBe(false);
    expect(eff.orphans[0]?.message).toContain("the computed return carries no X6 decision");
    expect(eff.openItems.find((i) => i.id === `override-orphan:decision:${TARGET}`)?.severity).toBe("advisory");
  });
  it("an engine-version change alone is an advisory 'engine changed' item, never blocking", () => {
    const old = row({ computedSnapshot: { status: "default_undecided", cents: null, engineVersion: "ty2025-1b.8" } });
    const { eff } = run([old]);
    const item = eff.openItems.find((i) => i.id === `override-engine:decision:${TARGET}`);
    expect(item?.severity).toBe("advisory");
    expect(eff.engineChanged).toHaveLength(1);
    expect(eff.openItems.filter((i) => i.severity === "blocking" && i.id.startsWith("override-"))).toEqual([]);
  });
});

describe("a pin on Schedule C line 25 and the percentage", () => {
  const pin = (cents: number, snapshotCents: number, version = 1): OverrideRow => ({
    id: "pin-1",
    taxYear: 2025,
    targetKind: "line",
    targetKey: "schc.25",
    version,
    valueKind: "money_cents",
    valueCents: cents,
    valueText: null,
    computedSnapshot: { status: "computed", cents: snapshotCents, engineVersion: TY2025_ENGINE_VERSION },
    authority: "owner",
    reason: "Per the bill.",
    setByName: "Eric",
    setAt: AT,
    archivedAt: null,
  });

  it("a recorded percentage plus a pin on line 25 adds the 'shadowed' advisory (not blocking)", () => {
    const { eff } = run([row(), pin(200_000, 182_700)]);
    const item = eff.openItems.find((i) => i.id === "override-decision-shadowed:X6");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toContain("pinned by an override");
    expect(item?.lineKeys).toEqual(["schc.25"]);
  });
  it("no pin, no advisory; a pin without a percentage, no advisory", () => {
    expect(run([row()]).eff.openItems.some((i) => i.id.startsWith("override-decision-shadowed"))).toBe(false);
    expect(run([pin(200_000, 261_000)]).eff.openItems.some((i) => i.id.startsWith("override-decision-shadowed"))).toBe(false);
  });
  it("recording the percentage changes the computed line 25, so a pin set at 100% turns STALE (blocking)", () => {
    const { eff } = run([row(), pin(200_000, 261_000)]);
    const stale = eff.openItems.find((i) => i.id === "override-stale:line:schc.25");
    expect(stale?.severity).toBe("blocking");
    expect(eff.stale.map((s) => s.targetKey)).toEqual(["schc.25"]);
  });
  it("the line-flow graph already carries line 25 to everything it feeds (no new edge is needed)", () => {
    const down = downstreamOf("schc.25");
    for (const k of ["schc.28", "schc.29", "schc.31", "se.2", "se.3", "sch1.3", "f8995.1i"] as LineKey[]) expect(down, k).toContain(k);
  });
});

// ── the action ─────────────────────────────────────────────────────────────────────────────────────────────────────

const USER = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";

function created(valueText: string) {
  return { id: "row-new", taxYear: 2025, entityId: ENTITY, targetKind: "decision", targetKey: TARGET, version: 1, valueKind: "choice", valueCents: null, valueText, authority: "owner", reason: REASON };
}
function input(choice: string, over: Record<string, unknown> = {}) {
  return { taxYear: 2025, targetKind: "decision" as const, targetKey: TARGET, choice, reason: REASON, ...over };
}
function writes(): number {
  return mockDb.taxReturnOverride.create.mock.calls.length + mockDb.taxReturnOverride.updateMany.mock.calls.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.user.findUnique.mockResolvedValue({ name: "Eric" });
  loader.loadBaseAndActive.mockResolvedValue({ entityId: ENTITY, rows: [], base: computeTy2025Return(facts(), {}), engineVersion: TY2025_ENGINE_VERSION });
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
  mockDb.taxReturnOverride.findFirst.mockResolvedValue(null);
  mockDb.taxReturnOverride.findMany.mockResolvedValue([]);
  mockDb.taxReturnOverride.updateMany.mockResolvedValue({ count: 1 });
  mockDb.taxReturnOverride.create.mockImplementation(async (a: { data: { valueText: string } }) => created(a.data.valueText));
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("setTaxReturnOverride for a business-use percentage", () => {
  it("records 70 as choice '70' with the default_undecided snapshot and the written reason", async () => {
    const res = await setTaxReturnOverride(input("70"));
    expect(res).toEqual({ ok: true, id: "row-new", version: 1 });
    const data = mockDb.taxReturnOverride.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ targetKind: "decision", targetKey: TARGET, valueKind: "choice", valueText: "70", valueCents: null, authority: "owner", reason: REASON, setByName: "Eric", version: 1 });
    expect(data.computedSnapshot).toEqual({ status: "default_undecided", cents: null, engineVersion: TY2025_ENGINE_VERSION });
  });
  it("stores the canonical text: '70%', ' 70.0 ', '070' -> '70'; '70.5' stays; 0 and 100 are accepted", async () => {
    for (const [typed, stored] of [["70%", "70"], [" 70.0 ", "70"], ["070", "70"], ["70.5", "70.5"], ["0", "0"], ["100", "100"]] as const) {
      mockDb.taxReturnOverride.create.mockClear();
      const res = await setTaxReturnOverride(input(typed));
      expect(res.ok, typed).toBe(true);
      expect(mockDb.taxReturnOverride.create.mock.calls[0]![0].data.valueText, typed).toBe(stored);
    }
  });
  it("refuses 70.55, 101, -1, blank, text with the plain message and writes nothing", async () => {
    for (const bad of ["70.55", "101", "-1", "", "abc", "1e2", "70,5"]) {
      const res = await setTaxReturnOverride(input(bad));
      expect(res.ok, bad).toBe(false);
      if (!res.ok) expect(res.error, bad).toMatch(/percentage from 0 to 100|at least 1|Too small/i);
    }
    expect(writes()).toBe(0);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
  it("refuses an unknown list key, and a decision the computed return does not carry", async () => {
    expect((await setTaxReturnOverride(input("70", { targetKey: "businessUse.nope" }))).ok).toBe(false);
    expect((await setTaxReturnOverride(input("70", { targetKey: "businessUse.constructor" }))).ok).toBe(false);
    loader.loadBaseAndActive.mockResolvedValue({ entityId: ENTITY, rows: [], base: computeTy2025Return(facts(false), {}), engineVersion: TY2025_ENGINE_VERSION });
    expect(await setTaxReturnOverride(input("70"))).toEqual({ ok: false, error: "That decision is not on the computed return." });
    expect(writes()).toBe(0);
  });
  it("the reason rules are unchanged: too short, and an SSN-like reason refused before any db call", async () => {
    expect((await setTaxReturnOverride(input("70", { reason: "ab" }))).ok).toBe(false);
    const ssn = await setTaxReturnOverride(input("70", { reason: "basis 123-45-6789" }));
    expect(ssn).toEqual({ ok: false, error: "The reason looks like a Social Security Number; remove it." });
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });
  it("supersedes the active version (new version, old archived) and the AuditLog never holds the reason", async () => {
    mockDb.taxReturnOverride.findFirst.mockResolvedValue({ version: 1 });
    mockDb.taxReturnOverride.findMany.mockResolvedValue([{ id: "old", taxYear: 2025, targetKind: "decision", targetKey: TARGET, version: 1, valueKind: "choice", valueCents: null, valueText: "60", authority: "owner", reason: "secret old reason" }]);
    const res = await setTaxReturnOverride(input("70"));
    expect(res.ok).toBe(true);
    expect(mockDb.taxReturnOverride.updateMany.mock.calls[0]![0].data).toMatchObject({ archiveKind: "superseded" });
    expect(mockDb.taxReturnOverride.create.mock.calls[0]![0].data.version).toBe(2);
    const audit = JSON.stringify(mockDb.auditLog.create.mock.calls);
    expect(audit).not.toContain(REASON);
    expect(audit).not.toContain("secret old reason");
    expect(audit).toContain(TARGET);
  });
  it("rejects an unauthenticated caller before anything else", async () => {
    authMock.mockResolvedValue(null);
    await expect(setTaxReturnOverride(input("70"))).rejects.toThrow("Unauthorized");
    expect(loader.loadBaseAndActive).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });
  it("the registry decisions still work through the same action (X1 'actual')", async () => {
    const f = facts();
    f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
    f.income.scheduleC.homeOfficeSqft = owner(200);
    loader.loadBaseAndActive.mockResolvedValue({ entityId: ENTITY, rows: [], base: computeTy2025Return(f, {}), engineVersion: TY2025_ENGINE_VERSION });
    const res = await setTaxReturnOverride({ taxYear: 2025, targetKind: "decision", targetKey: "homeOfficeMethod", choice: "actual", reason: REASON });
    expect(res.ok).toBe(true);
    expect(mockDb.taxReturnOverride.create.mock.calls[0]![0].data.valueText).toBe("actual");
    expect((await setTaxReturnOverride({ taxYear: 2025, targetKind: "decision", targetKey: "homeOfficeMethod", choice: "weird", reason: REASON })).ok).toBe(false);
  });
});
