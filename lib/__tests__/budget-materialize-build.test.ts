import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  BUDGET_TX_OPTIONS,
  BudgetRefusal,
  endLine,
  entitiesHoldingTag,
  lineIsInView,
  lockBudgetWrites,
  materializeForEdit,
  readBudgetRowsForWrite,
  saveCreates,
  type BudgetWriteRow,
} from "@/lib/budget-materialize-build";
import { planMaterialization } from "@/lib/budget-materialize";
import { D, budgetRow, createFakeBudgetDb, snapshot } from "./budget-fake-db";

const P = "ent-personal";
const S = "ent-sv";
const USER = "user-1";

function world() {
  return [
    budgetRow({ entityId: P, tagId: "rent", period: "2026-12", budgeted: D("1234.56"), payDay: 3, rolloverAmount: D("9.99"), additionalAmountCents: D("7777") }),
    budgetRow({ entityId: P, tagId: "food", period: "2026-12", budgeted: D("876.54") }),
    budgetRow({ entityId: P, tagId: "old", period: "2026-11", budgeted: D("55.55") }), // ended
    budgetRow({ entityId: S, tagId: "sv-tax", period: "2026-09", budgeted: D("321.09") }),
  ];
}
const asTx = (tx: unknown) => tx as Prisma.TransactionClient;

describe("lockBudgetWrites", () => {
  it("takes the global transaction-scoped advisory lock with a parameterised key, as the first statement", async () => {
    const exec = vi.fn().mockResolvedValue(1);
    await lockBudgetWrites({ $executeRaw: exec } as unknown as Prisma.TransactionClient);
    expect(exec).toHaveBeenCalledTimes(1);
    const [strings, key] = exec.mock.calls[0] as [TemplateStringsArray, string];
    expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock(hashtext(?))");
    expect(key).toBe("budget-write");
  });
  it("the transaction options are bounded for the pooled connection", () => {
    expect(BUDGET_TX_OPTIONS).toEqual({ maxWait: 10_000, timeout: 15_000 });
  });
});

describe("readBudgetRowsForWrite", () => {
  it("reads every row with an explicit select (no include, no notes) and fails closed at the cap", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await readBudgetRowsForWrite({ budget: { findMany } } as unknown as Prisma.TransactionClient);
    const arg = findMany.mock.calls[0]![0] as { select: Record<string, unknown>; include?: unknown; take: number; where?: unknown };
    expect(arg.include).toBeUndefined();
    expect(arg.where).toBeUndefined(); // all entities: frontiers and the household-wide tag rule need every row
    expect(arg.take).toBe(5001);
    expect(Object.keys(arg.select).sort()).toEqual(
      ["accountId", "additionalAmountCents", "annualAmountDue", "biweeklyAnchorDate", "budgeted", "entityId", "frequency", "id", "payDay", "payDayOfWeek", "payMonth", "period", "rolloverAmount", "rolloverEnabled", "tagId"]
    );
    findMany.mockResolvedValue(new Array(5001).fill({}));
    await expect(readBudgetRowsForWrite({ budget: { findMany } } as unknown as Prisma.TransactionClient)).rejects.toThrow(/Too many budget rows/);
  });
});

describe("saveCreates / materializeForEdit", () => {
  it("creates the carried set with skipDuplicates and writes one id-and-count audit row (no amounts)", async () => {
    const { db, state } = createFakeBudgetDb({ rows: world() });
    const out = await db.$transaction(async (tx) => {
      const t = asTx(tx);
      await lockBudgetWrites(t);
      const rows = await readBudgetRowsForWrite(t);
      return materializeForEdit(t, USER, rows, P, "2027-01");
    });
    expect(out).toEqual({ created: 2, skipped: 0 });
    expect(state.log[0]).toBe("lock");
    const saved = state.committed.filter((r) => r.period === "2027-01").sort((a, b) => (a.tagId < b.tagId ? -1 : 1));
    expect(saved.map((r) => [r.entityId, r.tagId, r.budgeted?.toString()])).toEqual([[P, "food", "876.54"], [P, "rent", "1234.56"]]);
    // rollover and the one-off additional amount are not copied; the pay day is
    const rent = saved.find((r) => r.tagId === "rent")!;
    expect(rent.rolloverAmount).toBeNull();
    expect(rent.additionalAmountCents.toString()).toBe("0");
    expect(rent.payDay).toBe(3);
    // the source month is untouched
    expect(state.committed.find((r) => r.tagId === "rent" && r.period === "2026-12")!.additionalAmountCents.toString()).toBe("7777");
    // exactly one audit row: ids and counts, never a dollar amount, never a note
    expect(state.audit).toHaveLength(1);
    const a = state.audit[0]!;
    expect(a.changedBy).toBe(USER);
    expect(a.changeType).toBe("budget_materialize");
    expect(a.after).toEqual({ entityId: P, periods: ["2027-01"], created: 2, skipped: 0 });
    const text = JSON.stringify(a);
    for (const secret of ["1234.56", "876.54", "55.55", "321.09", "9.99", "7777"]) expect(text).not.toContain(secret);
  });

  it("a second call creates nothing, overwrites nothing and writes no second audit row", async () => {
    const { db, state } = createFakeBudgetDb({ rows: world() });
    const run = () =>
      db.$transaction(async (tx) => {
        const t = asTx(tx);
        await lockBudgetWrites(t);
        const rows = await readBudgetRowsForWrite(t);
        return materializeForEdit(t, USER, rows, P, "2027-01");
      });
    await run();
    // the owner edits the saved month, then double-clicks again
    state.committed = state.committed.map((r) => (r.period === "2027-01" && r.tagId === "food" ? { ...r, budgeted: D("999") } : r));
    const before = snapshot(state.committed);
    expect(await run()).toEqual({ created: 0, skipped: 0 });
    expect(snapshot(state.committed)).toEqual(before); // the edited 999 survives
    expect(state.audit).toHaveLength(1);
  });

  it("skipDuplicates: rows saved by another tab after our read are skipped, counted, and audited by what was really created", () => {
    const tx = {
      budget: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const plan = planMaterialization(world().map((r) => ({ ...r })), P, "2027-01");
    return saveCreates(tx as unknown as Prisma.TransactionClient, USER, P, plan).then((res) => {
      expect(res).toEqual({ created: 1, skipped: 1 });
      expect(tx.budget.createMany).toHaveBeenCalledWith({ data: plan.creates, skipDuplicates: true });
      expect(tx.auditLog.create.mock.calls[0]![0].data.after).toEqual({ entityId: P, periods: ["2027-01"], created: 1, skipped: 1 });
    });
  });

  it("nothing created means no audit row and no write at all", async () => {
    const tx = { budget: { createMany: vi.fn() }, auditLog: { create: vi.fn() } };
    expect(await saveCreates(tx as unknown as Prisma.TransactionClient, USER, P, { creates: [], months: [] })).toEqual({ created: 0, skipped: 0 });
    const allSkipped = { budget: { createMany: vi.fn().mockResolvedValue({ count: 0 }) }, auditLog: { create: vi.fn() } };
    const plan = planMaterialization(world(), P, "2027-01");
    expect(await saveCreates(allSkipped as unknown as Prisma.TransactionClient, USER, P, plan)).toEqual({ created: 0, skipped: 2 });
    expect(allSkipped.auditLog.create).not.toHaveBeenCalled();
    expect(tx.budget.createMany).not.toHaveBeenCalled();
  });

  it("gap fill: a far month saves every empty month up to it in one call", async () => {
    const { db, state } = createFakeBudgetDb({ rows: world() });
    const res = await db.$transaction(async (tx) => {
      const t = asTx(tx);
      await lockBudgetWrites(t);
      return materializeForEdit(t, USER, await readBudgetRowsForWrite(t), P, "2027-04");
    });
    expect(res.created).toBe(8); // 4 months x 2 lines
    expect([...new Set(state.committed.filter((r) => r.entityId === P && r.period > "2026-12").map((r) => r.period))].sort()).toEqual(["2027-01", "2027-02", "2027-03", "2027-04"]);
    expect(state.audit[0]!.after).toEqual({ entityId: P, periods: ["2027-01", "2027-02", "2027-03", "2027-04"], created: 8, skipped: 0 });
    // the other entity was not touched
    expect(state.committed.filter((r) => r.entityId === S)).toHaveLength(1);
  });
});

describe("lineIsInView / entitiesHoldingTag", () => {
  const rows = world() as unknown as BudgetWriteRow[];
  it("sees carried and own lines, not ended or foreign ones", () => {
    expect(lineIsInView(rows, { entityId: P, tagId: "rent", period: "2027-05" })).toBe(true);
    expect(lineIsInView(rows, { entityId: P, tagId: "old", period: "2027-05" })).toBe(false);
    expect(lineIsInView(rows, { entityId: P, tagId: "sv-tax", period: "2027-05" })).toBe(false);
  });
  it("the household-wide tag check counts a carried line", () => {
    expect(entitiesHoldingTag(rows, "sv-tax", "2027-05")).toEqual([S]);
    expect(entitiesHoldingTag(rows, "rent", "2027-05")).toEqual([P]);
    expect(entitiesHoldingTag(rows, "old", "2027-05")).toEqual([]);
  });
});

describe("endLine", () => {
  it("a carried month: saves the other lines (no write for the ended line), audits ids and counts, deletes nothing", async () => {
    const { db, state } = createFakeBudgetDb({ rows: world() });
    const res = await db.$transaction(async (tx) => {
      const t = asTx(tx);
      await lockBudgetWrites(t);
      return endLine(t, USER, await readBudgetRowsForWrite(t), { entityId: P, tagId: "rent", period: "2027-02" });
    });
    expect(res).toEqual({ ok: true, created: 3, deletedRows: 0, removedMonths: 1 }); // 2027-01: rent + food, 2027-02: food
    expect(state.committed.filter((r) => r.entityId === P && r.period === "2027-02").map((r) => r.tagId)).toEqual(["food"]);
    expect(state.committed.filter((r) => r.entityId === P && r.period === "2027-01").map((r) => r.tagId).sort()).toEqual(["food", "rent"]);
    const types = state.audit.map((a) => a.changeType);
    expect(types).toEqual(["budget_materialize", "budget_end_line"]);
    expect(state.audit[1]!.after).toEqual({ entityId: P, tagId: "rent", fromPeriod: "2027-02", deletedRows: 0 });
    expect(JSON.stringify(state.audit)).not.toMatch(/1234|876|55\.55|321/);
  });

  it("an existing month: deletes the line's rows from that month on and reports the months removed", async () => {
    const rows = [...world(), budgetRow({ entityId: P, tagId: "rent", period: "2026-10", budgeted: D("1") }), budgetRow({ entityId: P, tagId: "food", period: "2026-10", budgeted: D("2") }), budgetRow({ entityId: P, tagId: "food", period: "2026-11", budgeted: D("2") }), budgetRow({ entityId: P, tagId: "rent", period: "2026-11", budgeted: D("1") })];
    const { db, state } = createFakeBudgetDb({ rows });
    const res = await db.$transaction(async (tx) => {
      const t = asTx(tx);
      await lockBudgetWrites(t);
      return endLine(t, USER, await readBudgetRowsForWrite(t), { entityId: P, tagId: "rent", period: "2026-11" });
    });
    expect(res).toEqual({ ok: true, created: 0, deletedRows: 2, removedMonths: 2 });
    expect(state.committed.filter((r) => r.tagId === "rent").map((r) => r.period)).toEqual(["2026-10"]);
    expect(state.audit.map((a) => a.changeType)).toEqual(["budget_end_line"]); // nothing was materialized
  });

  it("refuses without writing anything when the line is not in view or is the only one left", async () => {
    const { db, state } = createFakeBudgetDb({ rows: world() });
    const out = await db.$transaction(async (tx) => {
      const t = asTx(tx);
      await lockBudgetWrites(t);
      const rows = await readBudgetRowsForWrite(t);
      return [
        await endLine(t, USER, rows, { entityId: P, tagId: "old", period: "2027-01" }),
        await endLine(t, USER, rows, { entityId: S, tagId: "sv-tax", period: "2026-09" }),
      ];
    });
    expect(out[0]).toEqual({ ok: false, reason: "not_in_view" });
    expect(out[1]).toEqual({ ok: false, reason: "only_line_left", frontier: "2026-09" });
    expect(state.audit).toEqual([]);
    expect(snapshot(state.committed)).toEqual(snapshot(world().map((r) => ({ ...r, id: "x" }))));
  });
});

describe("transaction behaviour", () => {
  it("a failure after the carried set was saved rolls the whole transaction back (nothing half-saved)", async () => {
    const { db, state } = createFakeBudgetDb({
      rows: world(),
      beforeOp: (op) => {
        if (op === "budget.update") throw new Error("boom");
      },
    });
    await expect(
      db.$transaction(async (tx) => {
        const t = asTx(tx);
        await lockBudgetWrites(t);
        const rows = await readBudgetRowsForWrite(t);
        await materializeForEdit(t, USER, rows, P, "2027-01");
        await t.budget.update({ where: { id: "x" }, data: {} });
      })
    ).rejects.toThrow("boom");
    expect(state.committed.filter((r) => r.period === "2027-01")).toEqual([]);
    expect(state.audit).toEqual([]);
    expect(state.rollbacks).toBe(1);
  });

  it("two interleaved callers serialize on the lock: the second finds the first's rows and creates none", async () => {
    const { db, state } = createFakeBudgetDb({ rows: world() });
    const run = (label: string) =>
      db.$transaction(async (tx) => {
        const t = asTx(tx);
        await lockBudgetWrites(t);
        await new Promise((r) => setTimeout(r, label === "a" ? 15 : 0)); // the first holder is slow
        const rows = await readBudgetRowsForWrite(t);
        return materializeForEdit(t, USER, rows, P, "2027-01");
      });
    const [a, b] = await Promise.all([run("a"), run("b")]);
    expect([a.created, b.created].sort()).toEqual([0, 2]);
    expect(state.locks).toBe(2);
    expect(state.committed.filter((r) => r.entityId === P && r.period === "2027-01")).toHaveLength(2);
    expect(state.audit).toHaveLength(1);
  });

  it("BudgetRefusal carries a plain message", () => {
    const e = new BudgetRefusal("plain");
    expect(e.message).toBe("plain");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BudgetRefusal");
  });
});
