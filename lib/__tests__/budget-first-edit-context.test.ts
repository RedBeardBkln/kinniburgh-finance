// loadFirstEditContext: the read-only numbers behind "this change saves N months" and "ending this line removes N later
// saved months", computed by the SAME planner the write uses.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { D, budgetRow, createFakeBudgetDb } from "./budget-fake-db";

const m = vi.hoisted(() => ({ current: { db: null as unknown } }));
vi.mock("@/lib/db", () => ({
  get db() {
    return m.current.db;
  },
}));

import { loadFirstEditContext, loadFirstEditContextSafe } from "@/lib/budget-carry-forward-build";

const P = "ent-p";
const S = "ent-s";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fake = createFakeBudgetDb({
    rows: [
      budgetRow({ entityId: P, tagId: "rent", period: "2026-08", budgeted: D("10") }),
      budgetRow({ entityId: P, tagId: "food", period: "2026-08", budgeted: D("20") }),
      budgetRow({ entityId: P, tagId: "rent", period: "2026-12", budgeted: D("10") }),
      budgetRow({ entityId: P, tagId: "food", period: "2026-12", budgeted: D("20") }),
      budgetRow({ entityId: S, tagId: "oil", period: "2026-09", budgeted: D("5") }),
    ],
  });
  m.current.db = fake.db;
});

describe("loadFirstEditContext", () => {
  it("counts the months a first change would save (the empty ones in between included), per entity", async () => {
    const ctx = await loadFirstEditContext({ period: "2027-03" });
    // P has rows in 2026-08 and 2026-12: the empty 2026-09..11 are saved too, then 2027-01..03
    expect(ctx.saveMonths[P]).toEqual(["2026-09", "2026-10", "2026-11", "2027-01", "2027-02", "2027-03"]);
    // Sudden Valley's latest month is 2026-09: four more empty months in between
    expect(ctx.saveMonths[S]).toEqual(["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
  });

  it("an entity that already has rows in the month needs no save there; a gap month inside the range is counted", async () => {
    const ctx = await loadFirstEditContext({ period: "2026-12" });
    expect(ctx.saveMonths[P]).toEqual(["2026-09", "2026-10", "2026-11"]); // empty months up to the latest one are saved with any first edit
    const mid = await loadFirstEditContext({ period: "2026-10" });
    expect(mid.saveMonths[P]).toEqual(["2026-09", "2026-10", "2026-11"]);
  });

  it("counts, per line, the saved months AFTER the month shown (what ending the line removes besides this month)", async () => {
    const ctx = await loadFirstEditContext({ period: "2026-10" });
    expect(ctx.laterSavedMonths[`${P}|rent`]).toBe(1); // 2026-12
    expect(ctx.laterSavedMonths[`${P}|food`]).toBe(1);
    expect(ctx.laterSavedMonths[`${S}|oil`]).toBeUndefined(); // nothing after 2026-10
    expect((await loadFirstEditContext({ period: "2026-08" })).laterSavedMonths[`${P}|rent`]).toBe(1);
    expect((await loadFirstEditContext({ period: "2027-01" })).laterSavedMonths).toEqual({});
  });

  it("an entity filter limits the read; an invalid period reads nothing", async () => {
    const ctx = await loadFirstEditContext({ period: "2027-01", entityId: S });
    expect(Object.keys(ctx.saveMonths)).toEqual([S]);
    expect(await loadFirstEditContext({ period: "2027-13" })).toEqual({ saveMonths: {}, laterSavedMonths: {} });
  });

  it("is read-only, uses an explicit select and no relations", async () => {
    const fake = createFakeBudgetDb({ rows: [] });
    const spy = vi.spyOn(fake.db.budget, "findMany");
    m.current.db = fake.db;
    await loadFirstEditContext({ period: "2027-01" });
    const arg = spy.mock.calls[0]![0] as { select: Record<string, unknown>; include?: unknown };
    expect(arg.include).toBeUndefined();
    expect(Object.values(arg.select).every((v) => v === true)).toBe(true);
    expect(Object.keys(arg.select).sort()).toEqual(
      ["accountId", "additionalAmountCents", "annualAmountDue", "biweeklyAnchorDate", "budgeted", "entityId", "frequency", "id", "payDay", "payDayOfWeek", "payMonth", "period", "rolloverAmount", "rolloverEnabled", "tagId"]
    );
  });

  it("the Safe form never rejects: null, with the error NAME only in the log", async () => {
    const fake = createFakeBudgetDb({ rows: [] });
    vi.spyOn(fake.db.budget, "findMany").mockRejectedValue(new Error("boom postgres://u:p@h/d"));
    m.current.db = fake.db;
    expect(await loadFirstEditContextSafe({ period: "2027-01" })).toBeNull();
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).toContain("Error");
    expect(logged).not.toContain("postgres://");
  });
});
