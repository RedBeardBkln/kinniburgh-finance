import { beforeEach, describe, expect, it, vi } from "vitest";

// The loader's DB and engine edges are mocked: this file checks the COMPOSITION (rows ->
// decisions -> engine -> applyOverrides), the fail-closed policy and the entity lookup.

vi.mock("@/lib/db", () => ({ db: { taxReturnOverride: { findMany: vi.fn() } } }));
const entityMock = vi.hoisted(() => ({ getEntityBySlug: vi.fn() }));
vi.mock("@/lib/entity", () => entityMock);
vi.mock("@/lib/tax2025-build", () => ({ buildTy2025Return: vi.fn() }));

import { buildTy2025ReturnWithOverrides, loadBaseAndActive } from "@/lib/tax2025-overrides-build";
import type { OverrideRow } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Decisions } from "@/lib/tax2025/types";
import { emptyFacts, fullFacts1b } from "./tax2025-fixtures";

const PERSONAL = "22222222-2222-4222-8222-222222222222";

function fakeBuild(factsFn = fullFacts1b) {
  return vi.fn(async (_year: 2025, decisions: Ty2025Decisions) => {
    const facts = factsFn();
    const ret = computeTy2025Return(facts, decisions);
    return { raw: { taxYear: 2025 } as never, resolved: {} as never, facts, ret };
  });
}

function lineRow(over: Partial<OverrideRow> = {}): OverrideRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    taxYear: 2025,
    targetKind: "line",
    targetKey: "sch1.3",
    version: 1,
    valueKind: "money_cents",
    valueCents: 6_000_000,
    valueText: null,
    computedSnapshot: { status: "computed", cents: 5_000_000 },
    authority: "cpa",
    reason: "CPA said so",
    setByName: "Eric Kinniburgh",
    setAt: new Date("2026-10-12T02:30:00Z"),
    archivedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  entityMock.getEntityBySlug.mockResolvedValue({ id: PERSONAL, name: "Personal", slug: "personal", navLabel: null, type: "personal" });
});

describe("buildTy2025ReturnWithOverrides", () => {
  it("with no rows the effective lines equal the base lines and nothing is marked", async () => {
    const build = fakeBuild();
    const res = await buildTy2025ReturnWithOverrides(2025, { build, loadRows: async () => [] });
    if ("error" in res) throw new Error(res.error);
    for (const [k, l] of Object.entries(res.ret.lines)) {
      const eff = res.effective.lines[k as keyof typeof res.effective.lines];
      expect(eff?.effective).toEqual({ amount: l?.amount, status: l?.status });
      expect(eff?.override).toBeUndefined();
      expect(eff?.dependsOnOverridden).toBeUndefined();
    }
    expect(res.effective.totalsNotRecomputed).toBe(false);
    expect(res.effective.applied.lines).toEqual([]);
    expect(res.overrideRows).toEqual([]);
    expect(build).toHaveBeenCalledWith(2025, {});
  });

  it("a line row is applied over the return the engine produced (value, mark, dependents, version)", async () => {
    const build = fakeBuild();
    const res = await buildTy2025ReturnWithOverrides(2025, { build, loadRows: async () => [lineRow()] });
    if ("error" in res) throw new Error(res.error);
    expect(res.effective.lines["sch1.3"]?.effective).toEqual({ amount: 60_000, status: "overridden" });
    expect(res.effective.lines["sch1.3"]?.override?.was).toEqual({ status: "computed", amount: 50_000 });
    expect(res.effective.lines["f1040.9"]?.dependsOnOverridden).toContain("sch1.3");
    // the engine's own return is untouched
    expect(res.ret.lines["sch1.3"]?.amount).toBe(50_000);
    expect(res.effective.totalsNotRecomputed).toBe(true);
    expect(res.effective.engineVersion).toBe(res.ret.engineVersion);
  });

  it("a decision row is fed to the engine (the engine recomputes with it), and the row is surfaced", async () => {
    const build = fakeBuild();
    const decisionRow = lineRow({
      id: "00000000-0000-4000-8000-000000000002",
      targetKind: "decision",
      targetKey: "homeOfficeMethod",
      valueKind: "choice",
      valueCents: null,
      valueText: "actual",
    });
    const res = await buildTy2025ReturnWithOverrides(2025, { build, loadRows: async () => [decisionRow] });
    if ("error" in res) throw new Error(res.error);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]?.[1]).toEqual({ homeOfficeMethod: { chosen: "actual", by: "Eric Kinniburgh", at: "2026-10-12T02:30:00.000Z" } });
    expect(res.overrideRows).toHaveLength(1);
  });

  it("FAIL-CLOSED: unreadable override rows return an error and never the un-overridden return", async () => {
    const build = fakeBuild();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await buildTy2025ReturnWithOverrides(2025, {
      build,
      loadRows: async () => {
        throw new Error("connection refused: secret row data");
      },
    });
    expect(res).toHaveProperty("error");
    if (!("error" in res)) throw new Error("unreachable");
    expect(res.error).toContain("could not be read");
    expect(res.error).not.toContain("secret");
    expect(build).not.toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret"); // only the error NAME is logged
    spy.mockRestore();
  });

  it("returns the engine's own error unchanged", async () => {
    const res = await buildTy2025ReturnWithOverrides(2025, { build: async () => ({ error: "Personal entity not found" }), loadRows: async () => [] });
    expect(res).toEqual({ error: "Personal entity not found" });
  });

  it("looks up the household through getEntityBySlug('personal') and reads rows for THAT entity id", async () => {
    const loadRows = vi.fn(async () => [] as OverrideRow[]);
    await buildTy2025ReturnWithOverrides(2025, { build: fakeBuild(), loadRows });
    expect(entityMock.getEntityBySlug).toHaveBeenCalledWith("personal");
    expect(loadRows).toHaveBeenCalledWith(2025, PERSONAL);
  });

  it("a missing Personal entity is a plain error (no rows read, no engine run)", async () => {
    entityMock.getEntityBySlug.mockResolvedValue(null);
    const loadRows = vi.fn();
    const build = fakeBuild();
    const res = await buildTy2025ReturnWithOverrides(2025, { build, loadRows });
    expect(res).toEqual({ error: "The Personal entity was not found." });
    expect(loadRows).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });
});

describe("loadBaseAndActive (what the set action snapshots)", () => {
  it("returns the SAME base the sheet shows: decisions fed, engineVersion from the return", async () => {
    const build = fakeBuild(emptyFacts);
    const res = await loadBaseAndActive(2025, { build, loadRows: async () => [lineRow()] });
    if ("error" in res) throw new Error(res.error);
    expect(res.entityId).toBe(PERSONAL);
    expect(res.rows).toHaveLength(1);
    expect(res.engineVersion).toBe(res.base.engineVersion);
    expect(res.base).toBe(res.build.ret);
  });

  it("propagates the fail-closed error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await loadBaseAndActive(2025, {
      build: fakeBuild(),
      loadRows: async () => {
        throw new Error("x");
      },
    });
    expect(res).toHaveProperty("error");
    spy.mockRestore();
  });
});
