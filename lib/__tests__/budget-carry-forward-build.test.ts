// carry-forward-seasonal-energy, step 1: the read-only effective-budget loader (lib/budget-carry-forward-build.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mockDb = vi.hoisted(() => ({
  budget: { findMany: vi.fn() },
  appSetting: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  loadEffectiveBudgetRows,
  loadEffectiveBudgetRowsSafe,
  loadEffectiveScheduleRows,
} from "@/lib/budget-carry-forward-build";

const P = "ent-p";

function dbRow(tagId: string, tagName: string, period: string, over: Record<string, unknown> = {}) {
  return {
    id: `row-${tagId}-${period}`,
    entityId: P,
    tagId,
    accountId: "acct-1",
    period,
    budgeted: new Decimal("100"),
    additionalAmountCents: new Decimal("0"),
    payDay: 5,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    rolloverEnabled: true,
    rolloverAmount: new Decimal("12"),
    tag: { id: tagId, name: tagName, shortName: tagName.split(" / ").pop(), parentId: null },
    entity: { id: P, name: "Personal", slug: "personal" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appSetting.findUnique.mockResolvedValue(null);
  mockDb.budget.findMany.mockResolvedValue([]);
});

describe("loadEffectiveBudgetRows", () => {
  it("returns own rows and carried rows for the requested months", async () => {
    mockDb.budget.findMany.mockResolvedValue([dbRow("mort", "Utilities / Mortgage", "2026-12"), dbRow("mort", "Utilities / Mortgage", "2026-11")]);
    const rows = await loadEffectiveBudgetRows({ periods: ["2026-12", "2027-01"] });
    expect(rows.map((r) => [r.period, r.source, r.carriedFrom, r.id])).toEqual([
      ["2026-12", "own", null, "row-mort-2026-12"],
      ["2027-01", "carried", "2026-12", "carried:row-mort-2026-12:2027-01"],
    ]);
    // rollover is not carried, additional is not carried; the flag is
    expect(rows[1]!.rolloverAmount).toBeNull();
    expect(rows[1]!.additionalAmountCents.toString()).toBe("0");
    expect(rows[1]!.rolloverEnabled).toBe(true);
    expect(rows[0]!.rolloverAmount!.toString()).toBe("12");
  });

  it("reads with an explicit select (no include), no period filter, newest first, capped; entity filter when given", async () => {
    await loadEffectiveBudgetRows({ periods: ["2027-01"], entityId: P });
    const arg = mockDb.budget.findMany.mock.calls[0]![0];
    expect(arg.include).toBeUndefined();
    expect(arg.where).toEqual({ entityId: P });
    expect(arg.orderBy).toEqual([{ period: "desc" }]);
    expect(arg.take).toBe(5000);
    expect(Object.keys(arg.select).sort()).toEqual(
      ["accountId", "additionalAmountCents", "annualAmountDue", "biweeklyAnchorDate", "budgeted", "entity", "entityId", "frequency", "id", "payDay", "payDayOfWeek", "payMonth", "period", "rolloverAmount", "rolloverEnabled", "tag", "tagId"]
    );
    await loadEffectiveBudgetRows({ periods: ["2027-01"] });
    expect(mockDb.budget.findMany.mock.calls[1]![0].where).toEqual({});
  });

  it("an empty or invalid period list reads nothing", async () => {
    expect(await loadEffectiveBudgetRows({ periods: [] })).toEqual([]);
    expect(await loadEffectiveBudgetRows({ periods: ["garbage"] })).toEqual([]);
    expect(mockDb.budget.findMany).not.toHaveBeenCalled();
  });

  // Step 2: the variable lines now carry their flat figure as the FALLBACK for the seasonal model (flagged variable).
  it("default variable lines (by tag path) are flagged and carry their flat figure as the fallback", async () => {
    mockDb.budget.findMany.mockResolvedValue([
      dbRow("elec", "Utilities / Electric (Eversource)", "2026-12"),
      dbRow("oil", "Utilities / Oil", "2026-12"),
      dbRow("wood", "Utilities / Firewood", "2026-12"),
      dbRow("sol", "Utilities / Solar", "2026-12"),
    ]);
    const own = await loadEffectiveBudgetRows({ periods: ["2026-12"] });
    expect(own.filter((r) => r.variable).map((r) => r.tagId).sort()).toEqual(["elec", "oil", "wood"]);
    const later = await loadEffectiveBudgetRows({ periods: ["2027-01"] });
    expect(later.map((r) => r.tagId).sort()).toEqual(["elec", "oil", "sol", "wood"]);
    expect(later.filter((r) => r.variable).map((r) => r.tagId).sort()).toEqual(["elec", "oil", "wood"]);
    expect(later.every((r) => r.source === "carried" && r.carriedFrom === "2026-12")).toBe(true);
  });

  it("the owner's setting replaces the default set", async () => {
    mockDb.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify([{ entityId: P, tagId: "sol" }]) });
    mockDb.budget.findMany.mockResolvedValue([dbRow("oil", "Utilities / Oil", "2026-12"), dbRow("sol", "Utilities / Solar", "2026-12")]);
    const later = await loadEffectiveBudgetRows({ periods: ["2027-01"] });
    expect(later.map((r) => r.tagId).sort()).toEqual(["oil", "sol"]);
    expect(later.filter((r) => r.variable).map((r) => r.tagId)).toEqual(["sol"]); // Oil is no longer variable; Solar is
    expect(mockDb.appSetting.findUnique).toHaveBeenCalledWith({ where: { key: "seasonal_budget_lines" }, select: { value: true } });
  });

  it("a garbage setting value falls back to the default set; a setting READ ERROR throws (step 2, Reviewer note on step 1)", async () => {
    mockDb.budget.findMany.mockResolvedValue([dbRow("oil", "Utilities / Oil", "2026-12"), dbRow("sol", "Utilities / Solar", "2026-12")]);
    mockDb.appSetting.findUnique.mockResolvedValue({ value: "{not json" });
    const garbage = await loadEffectiveBudgetRows({ periods: ["2027-01"] });
    expect(garbage.filter((r) => r.variable).map((r) => r.tagId)).toEqual(["oil"]); // the default set applied
    // An unreadable setting must not silently swap the owner's set for the default one: the read fails instead.
    mockDb.appSetting.findUnique.mockRejectedValue(new Error("down"));
    await expect(loadEffectiveBudgetRows({ periods: ["2027-01"] })).rejects.toThrow("down");
    const safe = await loadEffectiveBudgetRowsSafe({ periods: ["2027-01"] });
    expect(safe).toEqual({ rows: [], failed: true });
  });

  it("a Budget read error is thrown (consumers that already propagated it keep doing so)", async () => {
    mockDb.budget.findMany.mockRejectedValue(new Error("db down"));
    await expect(loadEffectiveBudgetRows({ periods: ["2027-01"] })).rejects.toThrow("db down");
  });
});

describe("loadEffectiveBudgetRowsSafe", () => {
  it("never rejects: { rows: [], failed: true }, logs the error name only", async () => {
    mockDb.budget.findMany.mockRejectedValue(Object.assign(new Error("secret postgres://u:p@host"), { name: "PrismaClientKnownRequestError" }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await loadEffectiveBudgetRowsSafe({ periods: ["2027-01"] });
    expect(r).toEqual({ rows: [], failed: true });
    expect(JSON.stringify(spy.mock.calls)).toBe(JSON.stringify([["Budget carry-forward unavailable", "PrismaClientKnownRequestError"]]));
    spy.mockRestore();
  });

  it("returns the rows when the read works", async () => {
    mockDb.budget.findMany.mockResolvedValue([dbRow("mort", "Utilities / Mortgage", "2026-12")]);
    const r = await loadEffectiveBudgetRowsSafe({ periods: ["2027-03"] });
    expect(r.failed).toBe(false);
    expect(r.rows).toHaveLength(1);
  });
});

describe("loadEffectiveScheduleRows (the date index read)", () => {
  it("selects schedule columns only: no budgeted amount, no account, no rollover", async () => {
    await loadEffectiveScheduleRows({ periods: ["2027-01"] });
    const arg = mockDb.budget.findMany.mock.calls[0]![0];
    expect(Object.keys(arg.select).sort()).toEqual(
      ["annualAmountDue", "biweeklyAnchorDate", "entityId", "frequency", "id", "payDay", "payDayOfWeek", "payMonth", "period", "tag", "tagId"]
    );
    expect(arg.select).not.toHaveProperty("budgeted");
    expect(arg.select).not.toHaveProperty("accountId");
    expect(arg.include).toBeUndefined();
  });
});

describe("the loader module is read-only", () => {
  const src = readFileSync(resolve(__dirname, "../..", "lib/budget-carry-forward-build.ts"), "utf8");
  it("has no write verb, no raw SQL, no auth import, no server-action directive", () => {
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/);
    expect(src).not.toMatch(/^"use server"/m);
    expect(src).not.toMatch(/\binclude:/);
    // two Budget reads (rows, schedule rows) + the variable-lines helper's Tag and distinct Budget reads
    expect(src.match(/\.findMany\(/g)).toHaveLength(4);
    expect(src.match(/\.findUnique\(/g)).toHaveLength(1);
  });
});
