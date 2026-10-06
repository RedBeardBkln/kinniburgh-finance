// The overpayment decisions X7 / X8 through the override layer (engine ty2025-1b.10): rows -> engine decisions -> effective view,
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
import { applyOverrides, decisionsFromOverrides, formatOverrideNote, overpaymentAvailable, type OverrideRow } from "@/lib/tax2025/overrides";
import { TY2025_ENGINE_VERSION, computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { LineKey, Ty2025Return } from "@/lib/tax2025/types";
import { fullFacts1b } from "@/lib/__tests__/tax2025-fixtures";

const REASON = "Refund it all: the 2026 estimates are paid from the business account.";
const AT = new Date("2026-10-06T16:00:00.000Z");
const FED = "federalOverpayment";
const CT = "ctOverpayment";

function overFacts(): Ty2025Facts {
  const f = fullFacts1b();
  f.income.w2s[0]!.fedWithheldCents = (f.income.w2s[0]!.fedWithheldCents ?? 0) + 3_000_000;
  f.income.w2s[0]!.ctWithheldCents = (f.income.w2s[0]!.ctWithheldCents ?? 0) + 600_000;
  return f;
}

function row(over: Partial<OverrideRow> = {}): OverrideRow {
  return {
    id: "row-1",
    taxYear: 2025,
    targetKind: "decision",
    targetKey: FED,
    version: 1,
    valueKind: "choice",
    valueCents: null,
    valueText: "refund_all",
    computedSnapshot: { status: "default_undecided", cents: null, engineVersion: TY2025_ENGINE_VERSION },
    authority: "owner",
    reason: REASON,
    setByName: "Eric",
    setAt: AT,
    archivedAt: null,
    ...over,
  };
}
const ctRow = (over: Partial<OverrideRow> = {}): OverrideRow => row({ id: "row-2", targetKey: CT, ...over });

function run(rows: OverrideRow[], f: Ty2025Facts = overFacts()): { base: Ty2025Return; eff: ReturnType<typeof applyOverrides> } {
  const base = computeTy2025Return(f, decisionsFromOverrides(rows));
  return { base, eff: applyOverrides(base, rows) };
}
const amt = (r: Ty2025Return, k: LineKey): number | null => r.lines[k]?.amount ?? null;
const O = amt(computeTy2025Return(overFacts(), {}), "f1040.34") ?? -1;
const C = amt(computeTy2025Return(overFacts(), {}), "ct1040.22") ?? -1;

describe("decisionsFromOverrides: overpayment rows", () => {
  it("turns each stored text into the engine input (mode, whole dollars, who, when)", () => {
    expect(decisionsFromOverrides([row()]).federalOverpayment).toEqual({ chosen: "refund_all", by: "Eric", at: AT.toISOString() });
    expect(decisionsFromOverrides([row({ valueText: "apply_all" })]).federalOverpayment?.chosen).toBe("apply_all");
    expect(decisionsFromOverrides([ctRow({ valueText: "apply_amount:400" })]).ctOverpayment).toEqual({ chosen: "apply_amount", appliedDollars: 400, by: "Eric", at: AT.toISOString() });
  });
  it("ignores a bare apply_amount, cents, zero, text, an archived row; nothing recorded = no key", () => {
    for (const valueText of ["apply_amount", "apply_amount:100.50", "apply_amount:0", "abc", "", "schedule_a", "no_election"]) {
      expect(decisionsFromOverrides([row({ valueText })]).federalOverpayment, valueText).toBeUndefined();
    }
    expect(decisionsFromOverrides([row({ archivedAt: AT })]).federalOverpayment).toBeUndefined();
    expect(decisionsFromOverrides([]).federalOverpayment).toBeUndefined();
  });
  it("the highest version wins; a cleared latest row returns to the default; the two decisions do not disturb each other or X1", () => {
    const v1 = row({ id: "a", version: 1, valueText: "apply_all", archivedAt: AT });
    const v2 = row({ id: "b", version: 2, valueText: "refund_all" });
    expect(decisionsFromOverrides([v1, v2]).federalOverpayment?.chosen).toBe("refund_all");
    expect(decisionsFromOverrides([v1, { ...v2, archivedAt: AT }]).federalOverpayment).toBeUndefined();
    const d = decisionsFromOverrides([row(), ctRow({ valueText: "apply_all" }), row({ id: "h", targetKey: "homeOfficeMethod", valueText: "actual" })]);
    expect([d.federalOverpayment?.chosen, d.ctOverpayment?.chosen, d.homeOfficeMethod?.chosen]).toEqual(["refund_all", "apply_all", "actual"]);
  });
});

describe("applyOverrides with a recorded overpayment decision", () => {
  it("recompute -> decided, no false 'not reflected', the note reads 'Refund all', nothing stale or orphaned", () => {
    const { base, eff } = run([row(), ctRow()]);
    expect(amt(base, "f1040.35a")).toBe(O);
    expect(amt(base, "ct1040.25")).toBe(C);
    for (const id of ["X7", "X8"]) {
      const d = eff.decisions.find((x) => x.id === id);
      expect(d).toMatchObject({ chosen: "refund_all", status: "decided" });
      expect(d?.override).toMatchObject({ decisionId: id, choice: "refund_all", display: "Refund all", stale: null });
    }
    expect(eff.openItems.some((i) => i.id.startsWith("override-decision-not-reflected"))).toBe(false);
    expect(eff.stale).toEqual([]);
    expect(eff.orphans).toEqual([]);
    expect(eff.engineChanged).toEqual([]);
    const note = formatOverrideNote(eff.applied.decisions[0]!);
    expect(note).toContain("set to Refund all");
    expect(note).toContain("by Eric (owner)");
    expect(note).toContain(`reason: ${REASON}`);
  });
  it("a stated amount reads 'Apply $5,000 to 2026' and the engine decision carries the canonical text (no false 'not reflected')", () => {
    const { base, eff } = run([row({ valueText: "apply_amount:5000" })]);
    expect(amt(base, "f1040.36")).toBe(5000);
    expect(amt(base, "f1040.35a")).toBe(O - 5000);
    const d = eff.decisions.find((x) => x.id === "X7");
    expect(d?.chosen).toBe("apply_amount:5000");
    expect(d?.override?.display).toBe("Apply $5,000 to 2026");
    expect(eff.openItems.some((i) => i.id.startsWith("override-decision-not-reflected"))).toBe(false);
  });
  it("a non-canonical stored amount ('apply_amount:$5,000') is applied the same way and shown canonical", () => {
    const { base, eff } = run([row({ valueText: "apply_amount:$5,000" })]);
    expect(amt(base, "f1040.36")).toBe(5000);
    expect(eff.decisions.find((x) => x.id === "X7")?.override?.choice).toBe("apply_amount:5000");
    expect(eff.openItems.some((i) => i.id.startsWith("override-decision-not-reflected"))).toBe(false);
  });
  it("an engine that did not get the decision is reported as a BLOCKING 'not reflected' item", () => {
    const base = computeTy2025Return(overFacts(), {});
    const eff = applyOverrides(base, [row()]);
    expect(eff.openItems.find((i) => i.id === `override-decision-not-reflected:${FED}`)?.severity).toBe("blocking");
  });
  it("an unparseable stored value is an advisory orphan and the engine stays at the default", () => {
    const { base, eff } = run([row({ valueText: "apply_amount" })]);
    expect(base.decisions.find((d) => d.id === "X7")?.status).toBe("default_undecided");
    expect(eff.orphans.map((o) => o.targetKey)).toEqual([FED]);
    expect(eff.orphans[0]?.message).toContain("no longer a valid choice");
    expect(eff.openItems.find((i) => i.id === `override-orphan:decision:${FED}`)?.severity).toBe("advisory");
  });
  it("a decision recorded for a return with no overpayment is an orphan advisory, no crash", () => {
    const { base, eff } = run([row(), ctRow()], fullFacts1b());
    expect(base.decisions.some((d) => d.id === "X7" || d.id === "X8")).toBe(false);
    expect(eff.orphans.map((o) => o.targetKey).sort()).toEqual([CT, FED]);
    expect(eff.orphans[0]?.message).toContain("carries no");
    for (const o of eff.openItems.filter((i) => i.id.startsWith("override-orphan"))) expect(o.severity).toBe("advisory");
  });
  it("a recorded amount that is more than the overpayment after the return changed blocks (re-record), it does not print", () => {
    const { base, eff } = run([row({ valueText: `apply_amount:${O + 1}` })]);
    expect(base.lines["f1040.35a"]?.status).toBe("missing_input");
    expect(eff.headline.complete).toBe(false);
    expect(eff.openItems.some((i) => i.id === "rule:overpayment-federal" && i.severity === "blocking")).toBe(true);
  });
  it("an engine-version change alone is an advisory 'engine changed' item, never blocking", () => {
    const { eff } = run([row({ computedSnapshot: { status: "default_undecided", cents: null, engineVersion: "ty2025-1b.9" } })]);
    expect(eff.openItems.find((i) => i.id === `override-engine:decision:${FED}`)?.severity).toBe("advisory");
    expect(eff.engineChanged).toHaveLength(1);
    expect(eff.openItems.filter((i) => i.severity === "blocking" && i.id.startsWith("override-"))).toEqual([]);
  });
});

describe("a pin on a line the decision fills", () => {
  const pin = (key: string, cents: number, snapshotCents: number | null, status = "not_yet_computed"): OverrideRow => ({
    id: `pin-${key}`,
    taxYear: 2025,
    targetKind: "line",
    targetKey: key,
    version: 1,
    valueKind: "money_cents",
    valueCents: cents,
    valueText: null,
    computedSnapshot: { status, cents: snapshotCents, engineVersion: TY2025_ENGINE_VERSION },
    authority: "owner",
    reason: "Per the notice.",
    setByName: "Eric",
    setAt: AT,
    archivedAt: null,
  });

  it("a recorded decision plus a pin on line 35a adds the 'shadowed' advisory (not blocking), naming the line", () => {
    const { eff } = run([row(), pin("f1040.35a", 1_000_000, O * 100, "computed")]);
    const item = eff.openItems.find((i) => i.id === "override-decision-shadowed:X7");
    expect(item?.severity).toBe("advisory");
    expect(item?.lineKeys).toEqual(["f1040.35a"]);
    expect(item?.message).toContain("pinned by an override");
  });
  it("the same for a pin on CT line 25 under X8; no pin and no decision, no advisory", () => {
    expect(run([ctRow(), pin("ct1040.25", 100_000, C * 100, "computed")]).eff.openItems.some((i) => i.id === "override-decision-shadowed:X8")).toBe(true);
    expect(run([row()]).eff.openItems.some((i) => i.id.startsWith("override-decision-shadowed"))).toBe(false);
    expect(run([pin("f1040.35a", 1_000_000, null)]).eff.openItems.some((i) => i.id.startsWith("override-decision-shadowed"))).toBe(false);
  });
  it("recording the decision changes the computed line 35a, so a pin set while it was blank turns STALE (blocking)", () => {
    const { eff } = run([row(), pin("f1040.35a", 1_000_000, null)]);
    expect(eff.openItems.find((i) => i.id === "override-stale:line:f1040.35a")?.severity).toBe("blocking");
  });
  it("a pin on line 34 flags 35a / 36 as 'depends on an override' (line flow edge)", () => {
    const { eff } = run([row(), pin("f1040.34", 1_000_000, O * 100, "computed")]);
    expect(eff.lines["f1040.35a"]?.dependsOnOverridden).toContain("f1040.34");
    expect(eff.lines["f1040.36"]?.dependsOnOverridden).toContain("f1040.34");
  });
});

describe("overpaymentAvailable", () => {
  it("is line 34 less the printed line 38 for X7 and line 22 for X8; null when the line has no amount", () => {
    const ret = computeTy2025Return(overFacts(), {});
    expect(overpaymentAvailable(ret, FED)).toBe(O);
    expect(overpaymentAvailable(ret, CT)).toBe(C);
    expect(overpaymentAvailable({ lines: {} }, FED)).toBeNull();
    expect(overpaymentAvailable({ lines: {} }, CT)).toBeNull();
  });
});

// ── the action ─────────────────────────────────────────────────────────────────────────────────────────────────────

const USER = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";

function created(targetKey: string, valueText: string) {
  return { id: "row-new", taxYear: 2025, entityId: ENTITY, targetKind: "decision", targetKey, version: 1, valueKind: "choice", valueCents: null, valueText, authority: "owner", reason: REASON };
}
function input(choice: string, over: Record<string, unknown> = {}) {
  return { taxYear: 2025, targetKind: "decision" as const, targetKey: FED, choice, reason: REASON, ...over };
}
function writes(): number {
  return mockDb.taxReturnOverride.create.mock.calls.length + mockDb.taxReturnOverride.updateMany.mock.calls.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.user.findUnique.mockResolvedValue({ name: "Eric" });
  loader.loadBaseAndActive.mockResolvedValue({ entityId: ENTITY, rows: [], base: computeTy2025Return(overFacts(), {}), engineVersion: TY2025_ENGINE_VERSION });
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
  mockDb.taxReturnOverride.findFirst.mockResolvedValue(null);
  mockDb.taxReturnOverride.findMany.mockResolvedValue([]);
  mockDb.taxReturnOverride.updateMany.mockResolvedValue({ count: 1 });
  mockDb.taxReturnOverride.create.mockImplementation(async (a: { data: { targetKey: string; valueText: string } }) => created(a.data.targetKey, a.data.valueText));
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("setTaxReturnOverride for X7 / X8", () => {
  it("records refund_all as an owner decision with the default_undecided snapshot and the written reason", async () => {
    const res = await setTaxReturnOverride(input("refund_all"));
    expect(res).toEqual({ ok: true, id: "row-new", version: 1 });
    const data = mockDb.taxReturnOverride.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ targetKind: "decision", targetKey: FED, valueKind: "choice", valueText: "refund_all", valueCents: null, authority: "owner", reason: REASON, setByName: "Eric", version: 1 });
    expect(data.computedSnapshot).toEqual({ status: "default_undecided", cents: null, engineVersion: TY2025_ENGINE_VERSION });
  });
  it("records CT the same way, and a stated amount as canonical text ('apply_amount:$ 400' -> 'apply_amount:400')", async () => {
    expect((await setTaxReturnOverride(input("apply_all", { targetKey: CT }))).ok).toBe(true);
    expect(mockDb.taxReturnOverride.create.mock.calls[0]![0].data.valueText).toBe("apply_all");
    mockDb.taxReturnOverride.create.mockClear();
    expect((await setTaxReturnOverride(input("apply_amount:$ 400", { targetKey: CT }))).ok).toBe(true);
    expect(mockDb.taxReturnOverride.create.mock.calls[0]![0].data.valueText).toBe("apply_amount:400");
  });
  it("refuses a bare apply_amount, zero, cents, text and a registry id of another decision, with a plain message and nothing written", async () => {
    for (const bad of ["apply_amount", "apply_amount:0", "apply_amount:100.50", "apply_amount:abc", "apply_amount:-5", "schedule_a", "no_election", "refund"]) {
      const res = await setTaxReturnOverride(input(bad));
      expect(res.ok, bad).toBe(false);
      if (!res.ok) expect(res.error.length, bad).toBeGreaterThan(10);
    }
    const cents = await setTaxReturnOverride(input("apply_amount:100.50"));
    expect(cents).toEqual({ ok: false, error: "Enter whole dollars: the form takes whole dollars." });
    expect(writes()).toBe(0);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
  it("checks a stated amount against the overpayment of the rebuilt base return (equal is fine, one more is refused)", async () => {
    expect((await setTaxReturnOverride(input(`apply_amount:${O}`))).ok).toBe(true);
    mockDb.taxReturnOverride.create.mockClear();
    const over = await setTaxReturnOverride(input(`apply_amount:${O + 1}`));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("more than the overpayment");
    const overCt = await setTaxReturnOverride(input(`apply_amount:${C + 1}`, { targetKey: CT }));
    expect(overCt.ok).toBe(false);
    expect(writes()).toBe(0);
  });
  it("refuses when the decision is not on the computed return (no overpayment)", async () => {
    loader.loadBaseAndActive.mockResolvedValue({ entityId: ENTITY, rows: [], base: computeTy2025Return(fullFacts1b(), {}), engineVersion: TY2025_ENGINE_VERSION });
    expect(await setTaxReturnOverride(input("refund_all"))).toEqual({ ok: false, error: "That decision is not on the computed return." });
    expect(writes()).toBe(0);
  });
  it("supersedes the active version and the AuditLog holds ids, key and value text but never the reason", async () => {
    mockDb.taxReturnOverride.findFirst.mockResolvedValue({ version: 1 });
    mockDb.taxReturnOverride.findMany.mockResolvedValue([{ id: "old", taxYear: 2025, targetKind: "decision", targetKey: FED, version: 1, valueKind: "choice", valueCents: null, valueText: "apply_all", authority: "owner", reason: "secret old reason" }]);
    const res = await setTaxReturnOverride(input("refund_all"));
    expect(res.ok).toBe(true);
    expect(mockDb.taxReturnOverride.updateMany.mock.calls[0]![0].data).toMatchObject({ archiveKind: "superseded" });
    expect(mockDb.taxReturnOverride.create.mock.calls[0]![0].data.version).toBe(2);
    const audit = JSON.stringify(mockDb.auditLog.create.mock.calls);
    expect(audit).not.toContain(REASON);
    expect(audit).not.toContain("secret old reason");
    expect(audit).toContain(FED);
    expect(audit).toContain("refund_all");
  });
  it("refuses an SSN-like reason before any db call, a too-short reason, and an unauthenticated caller", async () => {
    const ssn = await setTaxReturnOverride(input("refund_all", { reason: "refund 123-45-6789" }));
    expect(ssn).toEqual({ ok: false, error: "The reason looks like a Social Security Number; remove it." });
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect((await setTaxReturnOverride(input("refund_all", { reason: "ab" }))).ok).toBe(false);
    authMock.mockResolvedValue(null);
    await expect(setTaxReturnOverride(input("refund_all"))).rejects.toThrow("Unauthorized");
    expect(loader.loadBaseAndActive).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });
  it("the zod choice limit (40) holds the longest typed text, so a valid amount is never cut off", async () => {
    const res = await setTaxReturnOverride(input("apply_amount:$ 9,999,999", { targetKey: CT }));
    // refused only because it is more than the overpayment, not because of its length
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("more than the overpayment");
  });
});
