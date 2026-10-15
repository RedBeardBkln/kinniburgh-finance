// The Budget actions after the copy-on-first-edit change: locator contract, one locked transaction per write,
// materialization inside it, idempotency, delete = end the line. Real actions + real planner over an in-memory fake db.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D, budgetRow, createFakeBudgetDb, type FakeBudgetRow } from "./budget-fake-db";
import { effectiveLineAt, planMaterialization } from "@/lib/budget-materialize";

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

import { createBudget, deleteBudget, updateBudget, updateBudgetAdditionalAmount, updateBudgetLine } from "@/actions/budgets";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const E_P = uuid(1);
const E_S = uuid(2);
const A_1 = uuid(100);
const A_2 = uuid(101);
const T = { rent: uuid(10), food: uuid(11), old: uuid(12), svTax: uuid(13), extra: uuid(14), fun: uuid(15) };
const SV_NAME = "Sudden Valley Property Management LLC";

function makeWorld(extra: FakeBudgetRow[] = []) {
  const rows = [
    budgetRow({ entityId: E_P, tagId: T.rent, period: "2026-12", accountId: A_1, budgeted: D("1234.56"), payDay: 3 }),
    budgetRow({ entityId: E_P, tagId: T.food, period: "2026-12", accountId: A_1, budgeted: D("876.54") }),
    budgetRow({ entityId: E_P, tagId: T.old, period: "2026-11", accountId: A_1, budgeted: D("55.55") }), // ended
    budgetRow({ entityId: E_S, tagId: T.svTax, period: "2026-09", accountId: A_2, budgeted: D("321.09") }),
    ...extra,
  ];
  const fake = createFakeBudgetDb({
    rows,
    tags: [T.rent, T.food, T.old, T.svTax, T.extra, T.fun].map((id) => ({ id, name: "Cat / " + id.slice(-2), shortName: "S" + id.slice(-2), parentId: null })),
    entities: [
      { id: E_P, name: "Personal", slug: "personal" },
      { id: E_S, name: SV_NAME, slug: "sudden-valley" },
    ],
    accounts: [
      { id: A_1, nickname: "Checking", entityId: E_P },
      { id: A_2, nickname: "SV operating", entityId: E_S },
    ],
  });
  m.current.db = fake.db;
  return fake;
}

const loc = (tagId: string, period: string, entityId = E_P) => ({ entityId, tagId, period });
const at = (state: { committed: FakeBudgetRow[] }, period: string, entityId = E_P) =>
  state.committed.filter((r) => r.entityId === entityId && r.period === period).sort((a, b) => (a.tagId < b.tagId ? -1 : 1));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
  m.auth.mockReset();
  m.auth.mockResolvedValue({ user: { id: "user-1" } });
  m.revalidatePath.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("auth and the locator contract", () => {
  it("every action starts with requireAuth: no session means Unauthorized and no database work at all", async () => {
    const { db, state } = makeWorld();
    const spy = vi.spyOn(db, "$transaction");
    m.auth.mockResolvedValue(null);
    await expect(updateBudgetLine(loc(T.rent, "2027-01"), "10")).rejects.toThrow("Unauthorized");
    await expect(updateBudget(loc(T.rent, "2027-01"), { budgeted: "10" })).rejects.toThrow("Unauthorized");
    await expect(updateBudgetAdditionalAmount(loc(T.rent, "2027-01"), 100)).rejects.toThrow("Unauthorized");
    await expect(deleteBudget(loc(T.rent, "2027-01"))).rejects.toThrow("Unauthorized");
    await expect(createBudget({ tagId: T.extra, entityId: E_P, accountId: A_1, period: "2027-01", budgeted: "1" })).rejects.toThrow("Unauthorized");
    expect(spy).not.toHaveBeenCalled();
    expect(state.transactions).toBe(0);
  });

  it("a session without a user id is also refused", async () => {
    makeWorld();
    m.auth.mockResolvedValue({ user: {} });
    await expect(deleteBudget(loc(T.rent, "2027-01"))).rejects.toThrow("Unauthorized");
  });

  it("a synthetic carried id (or any non-uuid, bad month, missing field) is refused before any transaction", async () => {
    const { state } = makeWorld();
    const bad = [
      { entityId: E_P, tagId: "carried:abc:2027-01", period: "2027-01" },
      { entityId: "carried:abc:2027-01", tagId: T.rent, period: "2027-01" },
      { entityId: E_P, tagId: T.rent, period: "2027-13" },
      { entityId: E_P, tagId: T.rent, period: "2027-1" },
      { entityId: E_P, tagId: T.rent },
    ] as unknown as Array<{ entityId: string; tagId: string; period: string }>;
    for (const b of bad) {
      expect(await updateBudgetLine(b, "10")).toEqual({ error: "Invalid budget line" });
      expect(await updateBudget(b, { budgeted: "10" })).toEqual({ error: "Invalid budget line" });
      expect(await updateBudgetAdditionalAmount(b, 100)).toEqual({ error: "Invalid budget line" });
      expect(await deleteBudget(b)).toEqual({ error: "Invalid budget line" });
    }
    expect(await createBudget({ tagId: "carried:x", entityId: E_P, accountId: A_1, period: "2027-01" })).toHaveProperty("error");
    expect(state.transactions).toBe(0);
  });

  it("a month more than 24 months ahead is refused with the plain message, before any transaction", async () => {
    const { state } = makeWorld();
    const tooFar = "2028-11"; // current month 2026-10 + 25
    const msg = { error: "That month is too far ahead to edit yet." };
    expect(await updateBudgetLine(loc(T.rent, tooFar), "10")).toEqual(msg);
    expect(await updateBudget(loc(T.rent, tooFar), { budgeted: "10" })).toEqual(msg);
    expect(await updateBudgetAdditionalAmount(loc(T.rent, tooFar), 100)).toEqual(msg);
    expect(await deleteBudget(loc(T.rent, tooFar))).toEqual(msg);
    expect(await createBudget({ tagId: T.extra, entityId: E_P, accountId: A_1, period: tooFar, budgeted: "1" })).toEqual(msg);
    expect(state.transactions).toBe(0);
    // exactly 24 months ahead is allowed
    const ok = await updateBudgetLine(loc(T.rent, "2028-10"), "10");
    expect(ok).toEqual({ success: true });
  });

  it("the existing messages are unchanged", async () => {
    makeWorld();
    expect(await updateBudgetLine(loc(T.rent, "2027-01"), "abc")).toEqual({ error: "Must be blank (to auto-sum nested lines) or a positive dollar amount (e.g. 217.00)" });
    expect(await updateBudgetAdditionalAmount(loc(T.rent, "2027-01"), -5)).toEqual({ error: "Amount must be a non-negative integer (cents)" });
    expect(await updateBudgetAdditionalAmount(loc(T.rent, "2027-01"), 1.5)).toEqual({ error: "Amount must be a non-negative integer (cents)" });
    expect(await updateBudget(loc(T.rent, "2027-01"), { frequency: "weekly" })).toEqual({ error: "Day of week is required for a weekly budget line" });
    expect(await createBudget({ tagId: T.extra, entityId: E_P, accountId: A_1, period: "2027-01", frequency: "biweekly", payDayOfWeek: 2 })).toEqual({ error: "Day of week and anchor date are required for a biweekly budget line" });
  });
});

describe("updateBudgetLine: the first edit of a carried month saves the whole carried set", () => {
  it("saves every carried line as a real row in the same transaction as the edit, with one audit row", async () => {
    const { state } = makeWorld();
    expect(await updateBudgetLine(loc(T.rent, "2027-01"), "1300.00")).toEqual({ success: true });
    const jan = at(state, "2027-01");
    expect(jan.map((r) => [r.tagId, r.budgeted?.toString()])).toEqual([[T.rent, "1300"], [T.food, "876.54"]].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
    // the carried copy kept the schedule; the ended line was NOT saved; the other entity was not touched
    expect(jan.find((r) => r.tagId === T.rent)!.payDay).toBe(3);
    expect(jan.some((r) => r.tagId === T.old)).toBe(false);
    expect(at(state, "2027-01", E_S)).toEqual([]);
    expect(state.audit.map((a) => a.changeType)).toEqual(["budget_materialize"]);
    expect(state.audit[0]!.after).toEqual({ entityId: E_P, periods: ["2027-01"], created: 2, skipped: 0 });
    expect(state.log[0]).toBe("lock"); // the lock is the first statement of the transaction
    expect(state.transactions).toBe(1);
    expect(m.revalidatePath).toHaveBeenCalledWith("/budgets");
    expect(m.revalidatePath).toHaveBeenCalledWith("/");
  });

  it("a double click: the second call saves nothing new, repeats the same edit, and adds no audit row", async () => {
    const { state } = makeWorld();
    await updateBudgetLine(loc(T.rent, "2027-01"), "1300");
    const rowsAfterFirst = state.committed.length;
    expect(await updateBudgetLine(loc(T.rent, "2027-01"), "1300")).toEqual({ success: true });
    expect(state.committed).toHaveLength(rowsAfterFirst);
    expect(state.audit).toHaveLength(1);
    expect(at(state, "2027-01").find((r) => r.tagId === T.rent)!.budgeted?.toString()).toBe("1300");
  });

  it("two tabs editing different lines of the same empty month at once keep both edits and exactly one copy of each line", async () => {
    const { state } = makeWorld();
    const [a, b] = await Promise.all([updateBudgetLine(loc(T.rent, "2027-01"), "1111"), updateBudgetLine(loc(T.food, "2027-01"), "2222")]);
    expect(a).toEqual({ success: true });
    expect(b).toEqual({ success: true });
    const jan = at(state, "2027-01");
    expect(jan).toHaveLength(2);
    expect(jan.find((r) => r.tagId === T.rent)!.budgeted?.toString()).toBe("1111");
    expect(jan.find((r) => r.tagId === T.food)!.budgeted?.toString()).toBe("2222");
    expect(state.audit.filter((x) => x.changeType === "budget_materialize")).toHaveLength(1);
    expect(state.locks).toBe(2);
  });

  it("an existing row is edited in place: nothing is saved, no audit row", async () => {
    const { state } = makeWorld();
    expect(await updateBudgetLine(loc(T.rent, "2026-12"), "1500")).toEqual({ success: true });
    expect(state.audit).toEqual([]);
    expect(at(state, "2026-12").find((r) => r.tagId === T.rent)!.budgeted?.toString()).toBe("1500");
    expect(state.committed).toHaveLength(4);
  });

  it("a blank amount clears to auto-sum (null)", async () => {
    const { state } = makeWorld();
    await updateBudgetLine(loc(T.rent, "2027-01"), "");
    expect(at(state, "2027-01").find((r) => r.tagId === T.rent)!.budgeted).toBeNull();
  });

  it("a far month saves every empty month up to it (gap fill) and the edited month is complete", async () => {
    const { state } = makeWorld();
    await updateBudgetLine(loc(T.food, "2027-03"), "5");
    for (const p of ["2027-01", "2027-02", "2027-03"]) expect(at(state, p)).toHaveLength(2);
    expect(at(state, "2027-02").find((r) => r.tagId === T.food)!.budgeted?.toString()).toBe("876.54"); // untouched figure in between
    expect(at(state, "2027-03").find((r) => r.tagId === T.food)!.budgeted?.toString()).toBe("5");
    expect(state.audit[0]!.after).toMatchObject({ created: 6, periods: ["2027-01", "2027-02", "2027-03"] });
  });

  it("a stale view (the line has ended or never existed) is refused in plain words and leaves nothing behind", async () => {
    const { state } = makeWorld();
    const msg = { error: "That line is no longer on this month's budget. Refresh the page." };
    expect(await updateBudgetLine(loc(T.old, "2027-01"), "1")).toEqual(msg);
    expect(await updateBudgetLine(loc(T.svTax, "2027-01"), "1")).toEqual(msg); // another entity's line
    expect(state.committed).toHaveLength(4);
    expect(state.audit).toEqual([]);
  });

  it("a month before the entity's first row has no carried line to edit", async () => {
    makeWorld();
    expect(await updateBudgetLine(loc(T.rent, "2026-05"), "1")).toEqual({ error: "That line is no longer on this month's budget. Refresh the page." });
  });

  it("rollover amount and the one-off additional amount of the source month are not copied", async () => {
    const { state } = makeWorld();
    state.committed = state.committed.map((r) => (r.tagId === T.rent && r.period === "2026-12" ? { ...r, rolloverAmount: D("42"), additionalAmountCents: D("5000"), rolloverEnabled: true } : r));
    await updateBudgetLine(loc(T.food, "2027-01"), "1");
    const rent = at(state, "2027-01").find((r) => r.tagId === T.rent)!;
    expect(rent.rolloverAmount).toBeNull();
    expect(rent.additionalAmountCents.toString()).toBe("0");
    expect(rent.rolloverEnabled).toBe(true); // the flag is copied
  });
});

describe("updateBudget", () => {
  it("edits a carried month: schedule fields change on that month's real row, the bill follows, the set is saved", async () => {
    const { state } = makeWorld();
    const res = await updateBudget(loc(T.rent, "2027-01"), { budgeted: "1400", payDay: 9, accountId: A_2 });
    expect(res).toEqual({ success: true });
    const rent = at(state, "2027-01").find((r) => r.tagId === T.rent)!;
    expect([rent.budgeted?.toString(), rent.payDay, rent.accountId]).toEqual(["1400", 9, A_2]);
    expect(at(state, "2027-01")).toHaveLength(2);
    expect(state.bills).toHaveLength(1);
    expect(state.bills[0]).toMatchObject({ budgetTagId: T.rent, budgetEntityId: E_P, active: true, autopayDay: 9 });
    // the source month is untouched
    expect(at(state, "2026-12").find((r) => r.tagId === T.rent)!.payDay).toBe(3);
  });

  it("applyToFuture pushes schedule fields to EXISTING later rows only, never earlier ones, and not the amount", async () => {
    const { state } = makeWorld([
      budgetRow({ entityId: E_P, tagId: T.rent, period: "2027-03", accountId: A_1, budgeted: D("2000"), payDay: 3 }),
      budgetRow({ entityId: E_P, tagId: T.food, period: "2027-03", accountId: A_1, budgeted: D("900") }),
    ]);
    // 2027-01 and 2027-02 are empty months inside the entity's range (the frontier is 2027-03)
    const res = await updateBudget(loc(T.rent, "2027-01"), { budgeted: "1500", payDay: 20, applyToFuture: true });
    expect(res).toEqual({ success: true });
    const payDays = (p: string) => at(state, p).find((r) => r.tagId === T.rent)!.payDay;
    expect(payDays("2026-12")).toBe(3); // earlier month: untouched
    expect(payDays("2027-01")).toBe(20);
    expect(payDays("2027-02")).toBe(20); // saved by the gap fill, then pushed
    expect(payDays("2027-03")).toBe(20);
    expect(at(state, "2027-03").find((r) => r.tagId === T.rent)!.budgeted?.toString()).toBe("2000"); // amount is not pushed
    expect(at(state, "2027-01").find((r) => r.tagId === T.rent)!.budgeted?.toString()).toBe("1500");
  });

  it("without applyToFuture the later rows keep their schedule", async () => {
    const { state } = makeWorld([budgetRow({ entityId: E_P, tagId: T.rent, period: "2027-03", accountId: A_1, payDay: 3 }), budgetRow({ entityId: E_P, tagId: T.food, period: "2027-03", accountId: A_1 })]);
    await updateBudget(loc(T.rent, "2027-01"), { payDay: 20 });
    expect(at(state, "2027-03").find((r) => r.tagId === T.rent)!.payDay).toBe(3);
  });

  it("a validation error after the copy rolls everything back (no half-saved month)", async () => {
    const { state } = makeWorld();
    const res = await updateBudget(loc(T.rent, "2027-01"), { frequency: "annual", budgeted: "100" });
    expect(res).toEqual({ error: "Due month and day are required for an annual, semi-annual or quarterly budget line" });
    expect(state.committed).toHaveLength(4);
    expect(state.audit).toEqual([]);
    expect(state.rollbacks).toBe(1);
  });

  it("clearing the pay day deactivates the linked bill, as before", async () => {
    const { state } = makeWorld();
    state.bills = [{ id: "b1", budgetTagId: T.rent, budgetEntityId: E_P, active: true }];
    await updateBudget(loc(T.rent, "2027-01"), { payDay: null });
    expect(state.bills[0]!.active).toBe(false);
  });
});

describe("updateBudgetAdditionalAmount", () => {
  it("sets the top-up on this month's row only; it is never carried to a later month", async () => {
    const { state } = makeWorld();
    expect(await updateBudgetAdditionalAmount(loc(T.rent, "2027-01"), 12345)).toEqual({ success: true });
    expect(at(state, "2027-01").find((r) => r.tagId === T.rent)!.additionalAmountCents.toString()).toBe("12345");
    expect(at(state, "2027-01").find((r) => r.tagId === T.food)!.additionalAmountCents.toString()).toBe("0");
    // the next month would be saved from 2027-01 with a zero additional amount
    const next = planMaterialization(state.committed, E_P, "2027-02");
    expect(next.creates.every((c) => c.additionalAmountCents === 0)).toBe(true);
    expect(effectiveLineAt(state.committed, loc(T.rent, "2027-02"))!.additionalAmountCents?.toString()).toBe("0");
  });
});

describe("createBudget", () => {
  it("adds a line to a carried month: saves the carried set first, then the new line, as one transaction", async () => {
    const { state } = makeWorld();
    const res = await createBudget({ tagId: T.extra, entityId: E_P, accountId: A_1, period: "2027-01", budgeted: "50", payDay: 15 });
    expect(res).toEqual({ success: true });
    expect(at(state, "2027-01").map((r) => r.tagId).sort()).toEqual([T.rent, T.food, T.extra].sort());
    expect(state.bills.some((b) => b.budgetTagId === T.extra && b.active)).toBe(true);
    // the frontier moved to 2027-01 WITH the carried lines in it, so they still carry into 2027-02
    expect(effectiveLineAt(state.committed, loc(T.rent, "2027-02"))?.source).toBe("carried");
    expect(effectiveLineAt(state.committed, loc(T.extra, "2027-02"))?.source).toBe("carried");
    expect(state.transactions).toBe(1);
  });

  it("the household-wide tag rule sees a CARRIED line of another entity, with the same message as before", async () => {
    const { state } = makeWorld();
    const res = await createBudget({ tagId: T.svTax, entityId: E_P, accountId: A_1, period: "2027-01", budgeted: "5" });
    expect(res).toEqual({ error: `This tag already has a budget line under ${SV_NAME} this period.` });
    expect(state.committed).toHaveLength(4);
  });

  it("a tag already carried in the same entity is refused with the same-entity message", async () => {
    const { state } = makeWorld();
    expect(await createBudget({ tagId: T.rent, entityId: E_P, accountId: A_1, period: "2027-01", budgeted: "5" })).toEqual({ error: "This tag already has a budget line this period." });
    expect(state.committed).toHaveLength(4);
    expect(state.audit).toEqual([]); // refused before anything was saved
  });

  it("an ended line can be added again as a new line, and NO earlier month changes (owner decision 2026-10-10)", async () => {
    const { state } = makeWorld([
      // the Tester's repro shape: OLD ended after 2026-10, 2026-11 and 2026-12 hold only the other lines
      budgetRow({ entityId: E_P, tagId: T.old, period: "2026-10", accountId: A_1, budgeted: D("33") }),
    ]);
    const viewsOf = (months: string[]) => months.map((p) => [p, ...["rent", "food", "old"].filter((k) => effectiveLineAt(state.committed, loc(T[k as "rent" | "food" | "old"], p))).sort()].join(" "));
    const months = ["2026-10", "2026-11", "2026-12"];
    const before = viewsOf(months);
    expect(await createBudget({ tagId: T.old, entityId: E_P, accountId: A_1, period: "2027-01", budgeted: "5" })).toEqual({ success: true });
    expect(at(state, "2027-01").some((r) => r.tagId === T.old)).toBe(true);
    expect(viewsOf(months)).toEqual(before);
    expect(effectiveLineAt(state.committed, loc(T.old, "2027-06"))?.source).toBe("carried"); // it shows from 2027-01 on
  });

  it("adding it back several months later saves the empty months in between first, so they do not start to show it", async () => {
    const { state } = makeWorld([budgetRow({ entityId: E_P, tagId: T.old, period: "2026-10", accountId: A_1, budgeted: D("33") })]);
    expect(await createBudget({ tagId: T.old, entityId: E_P, accountId: A_1, period: "2027-04", budgeted: "5" })).toEqual({ success: true });
    for (const p of ["2027-01", "2027-02", "2027-03"]) {
      expect(at(state, p).map((r) => r.tagId).sort()).toEqual([T.rent, T.food].sort());
      expect(effectiveLineAt(state.committed, loc(T.old, p))).toBeNull();
    }
    expect(at(state, "2027-04").map((r) => r.tagId).sort()).toEqual([T.rent, T.food, T.old].sort());
  });

  it("the rare case that cannot be made safe is refused in plain words and writes nothing", async () => {
    const fake = createFakeBudgetDb({
      rows: [
        budgetRow({ entityId: E_P, tagId: T.old, period: "2026-01", accountId: A_1 }),
        budgetRow({ entityId: E_P, tagId: T.rent, period: "2026-05", accountId: A_1 }),
        budgetRow({ entityId: E_P, tagId: T.food, period: "2026-05", accountId: A_1 }),
      ],
      entities: [{ id: E_P, name: "Personal", slug: "personal" }],
    });
    m.current.db = fake.db;
    expect(await createBudget({ tagId: T.old, entityId: E_P, accountId: A_1, period: "2026-06", budgeted: "5" })).toEqual({
      error: "Adding this line here would also make it appear in February 2026, an earlier month that has no budget lines. Add it to that month first, or choose that month instead.",
    });
    expect(fake.state.committed).toHaveLength(3);
    expect(fake.state.audit).toEqual([]);
  });

  it("adding the first line of an entity with no rows needs no copy", async () => {
    const { state } = makeWorld();
    const mezzo = uuid(3);
    expect(await createBudget({ tagId: T.fun, entityId: mezzo, accountId: A_1, period: "2027-01", budgeted: "5" })).toEqual({ success: true });
    expect(state.committed.filter((r) => r.entityId === mezzo)).toHaveLength(1);
    expect(state.audit).toEqual([]);
  });
});

describe("deleteBudget: ends the line from this month on", () => {
  it("a carried month: the line is gone from that month and every later one, the rest is saved, the bill is deactivated", async () => {
    const { state } = makeWorld();
    state.bills = [{ id: "b1", budgetTagId: T.rent, budgetEntityId: E_P, active: true }];
    const res = await deleteBudget(loc(T.rent, "2027-02"));
    expect(res).toEqual({ success: true, removedMonths: 1 });
    expect(at(state, "2027-02").map((r) => r.tagId)).toEqual([T.food]);
    expect(at(state, "2027-01").map((r) => r.tagId).sort()).toEqual([T.rent, T.food].sort()); // earlier month keeps it
    for (const p of ["2027-02", "2027-03", "2028-12"]) expect(effectiveLineAt(state.committed, loc(T.rent, p))).toBeNull();
    expect(effectiveLineAt(state.committed, loc(T.food, "2028-12"))?.source).toBe("carried");
    expect(state.bills[0]!.active).toBe(false);
    expect(state.audit.map((a) => a.changeType)).toEqual(["budget_materialize", "budget_end_line"]);
  });

  it("a month with its own rows: later rows of the line are removed too and the count says how many months", async () => {
    const { state } = makeWorld([
      budgetRow({ entityId: E_P, tagId: T.rent, period: "2027-01", accountId: A_1 }),
      budgetRow({ entityId: E_P, tagId: T.food, period: "2027-01", accountId: A_1 }),
      budgetRow({ entityId: E_P, tagId: T.rent, period: "2027-02", accountId: A_1 }),
      budgetRow({ entityId: E_P, tagId: T.food, period: "2027-02", accountId: A_1 }),
    ]);
    expect(await deleteBudget(loc(T.rent, "2027-01"))).toEqual({ success: true, removedMonths: 2 });
    expect(state.committed.filter((r) => r.tagId === T.rent).map((r) => r.period)).toEqual(["2026-12"]);
    expect(effectiveLineAt(state.committed, loc(T.rent, "2027-06"))).toBeNull();
  });

  it("refuses to empty the entity's latest month, in plain words, and changes nothing", async () => {
    const { state } = makeWorld();
    const res = await deleteBudget(loc(T.svTax, "2026-09", E_S));
    expect(res).toEqual({ error: "This is the only line left in September 2026; add another line or remove it from the earlier month." });
    expect(state.committed).toHaveLength(4);
    expect(state.audit).toEqual([]);
  });

  it("a second click (or another tab got there first) finds the line already gone and succeeds without touching anything", async () => {
    const { state } = makeWorld();
    await deleteBudget(loc(T.rent, "2027-02"));
    const rows = state.committed.length;
    const audits = state.audit.length;
    expect(await deleteBudget(loc(T.rent, "2027-02"))).toEqual({ success: true, removedMonths: 0 });
    expect(state.committed).toHaveLength(rows);
    expect(state.audit).toHaveLength(audits);
  });

  it("a delete racing an edit in the same empty month serializes: the edit lands, the line ends, nothing is saved twice", async () => {
    const { state } = makeWorld();
    const [d, u] = await Promise.all([deleteBudget(loc(T.rent, "2027-01")), updateBudgetLine(loc(T.food, "2027-01"), "77")]);
    expect(d).toMatchObject({ success: true });
    expect(u).toEqual({ success: true });
    expect(at(state, "2027-01").map((r) => [r.tagId, r.budgeted?.toString()])).toEqual([[T.food, "77"]]);
    expect(effectiveLineAt(state.committed, loc(T.rent, "2027-05"))).toBeNull();
    expect(effectiveLineAt(state.committed, loc(T.food, "2027-05"))?.budgeted?.toString()).toBe("77");
  });
});

describe("a failing write leaves nothing behind", () => {
  it("an error while editing after the copy rolls the copy back too", async () => {
    const fake = createFakeBudgetDb({
      rows: [budgetRow({ entityId: E_P, tagId: T.rent, period: "2026-12", accountId: A_1 }), budgetRow({ entityId: E_P, tagId: T.food, period: "2026-12", accountId: A_1 })],
      beforeOp: (op) => {
        if (op === "budget.update") throw new Error("connection reset");
      },
    });
    m.current.db = fake.db;
    await expect(updateBudgetLine(loc(T.rent, "2027-01"), "1")).rejects.toThrow("connection reset");
    expect(fake.state.committed).toHaveLength(2);
    expect(fake.state.audit).toEqual([]);
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });
});
