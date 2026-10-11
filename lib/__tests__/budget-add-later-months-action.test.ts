// createBudget with `alsoAddToLaterMonths`: real action + real planner over the in-memory fake db. One locked transaction,
// the target months re-derived server-side from rows read inside the lock, create-only, one id-only audit row.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D, budgetRow, createFakeBudgetDb, snapshot, type FakeBudgetRow } from "./budget-fake-db";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  current: { db: null as unknown },
}));
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/lib/db", () => ({
  get db() {
    return m.current.db;
  },
}));

import { createBudget } from "@/actions/budgets";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const E_P = uuid(1);
const E_S = uuid(2);
const A_1 = uuid(100);
const A_2 = uuid(101);
const T = { rent: uuid(10), food: uuid(11), extra: uuid(14), shared: uuid(15), ended: uuid(16) };

function world(opts: { extra?: FakeBudgetRow[]; beforeOp?: (op: string) => void } = {}) {
  const rows = [
    budgetRow({ entityId: E_P, tagId: T.rent, period: "2026-08", accountId: A_1, budgeted: D("1000"), payDay: 3 }),
    budgetRow({ entityId: E_P, tagId: T.rent, period: "2026-12", accountId: A_1, budgeted: D("1234.56"), payDay: 3 }),
    budgetRow({ entityId: E_P, tagId: T.food, period: "2026-12", accountId: A_1, budgeted: D("876.54") }),
    budgetRow({ entityId: E_S, tagId: T.rent, period: "2026-09", accountId: A_2, budgeted: D("5") }), // other entity, other tag set
    ...(opts.extra ?? []),
  ];
  const fake = createFakeBudgetDb({
    rows,
    beforeOp: opts.beforeOp,
    tags: Object.values(T).map((id) => ({ id, name: "Cat / " + id.slice(-2), shortName: "S" + id.slice(-2), parentId: null })),
    entities: [
      { id: E_P, name: "Personal", slug: "personal" },
      { id: E_S, name: "Sudden Valley Property Management LLC", slug: "sudden-valley" },
    ],
    accounts: [
      { id: A_1, nickname: "Checking", entityId: E_P },
      { id: A_2, nickname: "SV operating", entityId: E_S },
    ],
  });
  m.current.db = fake.db;
  return fake;
}

const add = (over: Record<string, unknown> = {}) => ({
  tagId: T.extra,
  entityId: E_P,
  accountId: A_1,
  period: "2026-09",
  budgeted: "42.50",
  payDay: 7,
  ...over,
});
const lineMonths = (state: { committed: FakeBudgetRow[] }, tagId: string, entityId = E_P) =>
  state.committed.filter((r) => r.entityId === entityId && r.tagId === tagId).map((r) => r.period).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
  m.auth.mockReset();
  m.auth.mockResolvedValue({ user: { id: "user-1" } });
  m.revalidatePath.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("createBudget alsoAddToLaterMonths", () => {
  it("requireAuth first: unauthenticated rejects with the flag true and no database work happens", async () => {
    const { db, state } = world();
    const spy = vi.spyOn(db, "$transaction");
    m.auth.mockResolvedValue(null);
    await expect(createBudget(add({ alsoAddToLaterMonths: true }) as never)).rejects.toThrow("Unauthorized");
    expect(spy).not.toHaveBeenCalled();
    expect(state.transactions).toBe(0);
  });

  it("ticked, M before the latest month: the line is created in M and every later month that has rows, in ONE transaction after the lock", async () => {
    const { state } = world();
    const result = await createBudget(add({ alsoAddToLaterMonths: true }) as never);
    expect(result).toEqual({ success: true, laterMonthsAdded: 3 });
    expect(lineMonths(state, T.extra)).toEqual(["2026-09", "2026-10", "2026-11", "2026-12"]);
    // every copy carries the same amount, schedule and account; rollover and the additional amount are not copied
    for (const r of state.committed.filter((x) => x.tagId === T.extra)) {
      expect(r.budgeted?.toString()).toBe("42.5");
      expect(r.payDay).toBe(7);
      expect(r.accountId).toBe(A_1);
      expect(r.frequency).toBe("monthly");
      expect(r.rolloverEnabled).toBe(false);
      expect(r.rolloverAmount).toBeNull();
      expect(Number(r.additionalAmountCents)).toBe(0);
    }
    expect(state.transactions).toBe(1);
    expect(state.log[0]).toBe("lock");
    // the lock came before the later-months createMany
    const createManys = state.log.map((op, i) => [op, i] as const).filter(([op]) => op === "budget.createMany");
    expect(createManys).toHaveLength(2); // the first-edit save, then the later months
    expect(createManys[0]![1]).toBeGreaterThan(0);
    // nothing after the entity's latest month, nothing in the other entity
    expect(lineMonths(state, T.extra, E_S)).toEqual([]);
    expect(state.committed.some((r) => r.tagId === T.extra && r.period > "2026-12")).toBe(false);
    expect(m.revalidatePath).toHaveBeenCalledWith("/budgets");
  });

  it("audit: one budget_add_later_months row with ids, periods and counts only", async () => {
    const { state } = world();
    await createBudget(add({ alsoAddToLaterMonths: true }) as never);
    const rows = state.audit.filter((a) => a.changeType === "budget_add_later_months");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changedBy).toBe("user-1");
    expect(rows[0]!.after).toEqual({
      entityId: E_P,
      tagId: T.extra,
      fromPeriod: "2026-09",
      periods: ["2026-10", "2026-11", "2026-12"],
      created: 3,
      skipped: 0,
    });
    expect(Object.keys(rows[0]!.after as object).sort()).toEqual(["created", "entityId", "fromPeriod", "periods", "skipped", "tagId"]);
    expect(JSON.stringify(rows[0])).not.toMatch(/42\.5|1234|876/); // no amounts
    // the first-edit save keeps its own audit row
    expect(state.audit.map((a) => a.changeType).sort()).toEqual(["budget_add_later_months", "budget_materialize"]);
  });

  it("unticked or flag absent: only the chosen month is created, the result is strictly { success: true } and there is no extra audit row", async () => {
    for (const flag of [{}, { alsoAddToLaterMonths: false }]) {
      const { state } = world();
      expect(await createBudget(add(flag) as never)).toEqual({ success: true });
      expect(lineMonths(state, T.extra)).toEqual(["2026-09"]);
      expect(state.audit.some((a) => a.changeType === "budget_add_later_months")).toBe(false);
    }
  });

  it("unticked equals today's result row for row (the ticked run only adds the later rows)", async () => {
    const a = world();
    await createBudget(add() as never);
    const b = world();
    await createBudget(add({ alsoAddToLaterMonths: true }) as never);
    const plain = snapshot(a.state.committed);
    const ticked = snapshot(b.state.committed);
    expect(ticked.filter((r) => !plain.includes(r))).toHaveLength(3);
    expect(plain.every((r) => ticked.includes(r))).toBe(true);
  });

  it("M at or after the latest month with the flag true: only M is created, laterMonthsAdded 0, no extra audit", async () => {
    for (const period of ["2026-12", "2027-02"]) {
      const { state } = world();
      expect(await createBudget(add({ period, alsoAddToLaterMonths: true }) as never)).toEqual({ success: true, laterMonthsAdded: 0 });
      expect(lineMonths(state, T.extra)).toEqual([period]);
      expect(state.audit.some((a) => a.changeType === "budget_add_later_months")).toBe(false);
    }
  });

  it("a later month that already has the line is left alone (never overwritten) and the others are added", async () => {
    const existing = budgetRow({ entityId: E_P, tagId: T.extra, period: "2026-12", accountId: A_1, budgeted: D("9"), rolloverAmount: D("3") });
    const { state } = world({ extra: [existing] });
    expect(await createBudget(add({ alsoAddToLaterMonths: true }) as never)).toEqual({ success: true, laterMonthsAdded: 2 });
    expect(lineMonths(state, T.extra)).toEqual(["2026-09", "2026-10", "2026-11", "2026-12"]);
    const kept = state.committed.find((r) => r.tagId === T.extra && r.period === "2026-12")!;
    expect(kept.budgeted?.toString()).toBe("9");
    expect(kept.rolloverAmount?.toString()).toBe("3");
  });

  it("two tabs: the second identical add is refused by the tag check and writes nothing", async () => {
    const { state } = world();
    expect(await createBudget(add({ alsoAddToLaterMonths: true }) as never)).toMatchObject({ success: true });
    const rowsAfterFirst = snapshot(state.committed);
    const auditAfterFirst = state.audit.length;
    expect(await createBudget(add({ alsoAddToLaterMonths: true }) as never)).toEqual({ error: "This tag already has a budget line this period." });
    expect(snapshot(state.committed)).toEqual(rowsAfterFirst);
    expect(state.audit).toHaveLength(auditAfterFirst);
  });

  it("two simultaneous adds serialize on the lock: exactly one wins", async () => {
    const { state } = world();
    const [a, b] = await Promise.all([createBudget(add({ alsoAddToLaterMonths: true }) as never), createBudget(add({ alsoAddToLaterMonths: true }) as never)]);
    expect([a, b].filter((r) => "success" in r)).toHaveLength(1);
    expect([a, b].filter((r) => "error" in r)).toHaveLength(1);
    expect(lineMonths(state, T.extra)).toEqual(["2026-09", "2026-10", "2026-11", "2026-12"]);
    expect(state.audit.filter((x) => x.changeType === "budget_add_later_months")).toHaveLength(1);
  });

  it("a failure while creating the later months rolls back everything: the chosen month and the first-edit save too", async () => {
    let createManys = 0;
    const { state } = world({
      beforeOp: (op) => {
        if (op === "budget.createMany" && ++createManys === 2) throw new Error("boom");
      },
    });
    const before = snapshot(state.committed);
    await expect(createBudget(add({ alsoAddToLaterMonths: true }) as never)).rejects.toThrow("boom");
    expect(snapshot(state.committed)).toEqual(before);
    expect(state.audit).toEqual([]);
    expect(state.rollbacks).toBe(1);
  });

  it("client-supplied month lists are ignored: unknown keys are stripped and change nothing", async () => {
    const { state } = world();
    const result = await createBudget(add({ alsoAddToLaterMonths: true, months: ["2030-01"], laterPeriods: ["2027-05"], periods: ["2026-10"] }) as never);
    expect(result).toEqual({ success: true, laterMonthsAdded: 3 });
    expect(lineMonths(state, T.extra)).toEqual(["2026-09", "2026-10", "2026-11", "2026-12"]);
  });

  it("a non-boolean flag is rejected by validation before any transaction", async () => {
    const { state } = world();
    const result = await createBudget(add({ alsoAddToLaterMonths: "yes" }) as never);
    expect(result).toHaveProperty("error");
    expect(state.transactions).toBe(0);
  });

  it("entity separation: a Personal add never writes Sudden Valley rows, and a month where another entity holds the tag is skipped, not refused", async () => {
    // Sudden Valley holds "shared" only in its own 2026-11 row; its latest month (2026-12) has ended it
    const sv = [
      budgetRow({ entityId: E_S, tagId: T.shared, period: "2026-11", accountId: A_2 }),
      budgetRow({ entityId: E_S, tagId: T.rent, period: "2026-12", accountId: A_2 }),
    ];
    const { state } = world({ extra: sv });
    const svBefore = snapshot(state.committed.filter((r) => r.entityId === E_S));
    const result = await createBudget(add({ tagId: T.shared, alsoAddToLaterMonths: true }) as never);
    expect(result).toEqual({ success: true, laterMonthsAdded: 2 });
    expect(lineMonths(state, T.shared, E_P)).toEqual(["2026-09", "2026-10", "2026-12"]);
    expect(snapshot(state.committed.filter((r) => r.entityId === E_S))).toEqual(svBefore);
    // household rule: no month has the tag in both entities
    const both = lineMonths(state, T.shared, E_P).filter((p) => lineMonths(state, T.shared, E_S).includes(p));
    expect(both).toEqual([]);
  });

  it("a month more than 24 months ahead is refused before any transaction, flag or not", async () => {
    const { state } = world();
    expect(await createBudget(add({ period: "2028-11", alsoAddToLaterMonths: true }) as never)).toEqual({ error: "That month is too far ahead to edit yet." });
    expect(state.transactions).toBe(0);
  });

  it("the existing refusal when the tag is already on the month still comes first", async () => {
    const { state } = world();
    expect(await createBudget(add({ tagId: T.rent, alsoAddToLaterMonths: true }) as never)).toEqual({ error: "This tag already has a budget line this period." });
    expect(state.audit).toEqual([]);
  });

  it("the earlier-month refusal with the later rows suggests unticking (a line that would be revived in an empty earlier month)", async () => {
    // "ended" had rows only in 2026-01; 2026-02..04 are empty; a, b start in May. Re-adding "ended" at 2026-06 (before the
    // latest month 2026-08) alone is fine; landing on 2026-08 would revive it in the empty months before.
    const rows = [
      budgetRow({ entityId: E_P, tagId: T.ended, period: "2026-01", accountId: A_1 }),
      budgetRow({ entityId: E_P, tagId: T.rent, period: "2026-05", accountId: A_1 }),
      budgetRow({ entityId: E_P, tagId: T.rent, period: "2026-08", accountId: A_1 }),
    ];
    const fake = createFakeBudgetDb({ rows, tags: [], entities: [], accounts: [] });
    m.current.db = fake.db;
    const unticked = await createBudget(add({ tagId: T.ended, period: "2026-06" }) as never);
    expect(unticked).toEqual({ success: true });
    const fake2 = createFakeBudgetDb({ rows, tags: [], entities: [], accounts: [] });
    m.current.db = fake2.db;
    const ticked = await createBudget(add({ tagId: T.ended, period: "2026-06", alsoAddToLaterMonths: true }) as never);
    expect(ticked).toHaveProperty("error");
    expect((ticked as { error: string }).error).toContain("February 2026");
    expect((ticked as { error: string }).error).toContain("untick 'Also add to later saved months'");
    expect(fake2.state.committed).toHaveLength(rows.length); // nothing written
  });
});
