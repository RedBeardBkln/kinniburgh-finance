// Tester: end-to-end fuzz of createBudget(alsoAddToLaterMonths) over the in-memory fake db with the real action, real planner
// and real preview loader. The checks use a tiny grid oracle written from the owner's rule (not the planner's code):
//   view(entity, month): the entity's own rows when it has any row that month, otherwise the lines of its latest EARLIER
//   rowful month... via per-line "latest earlier row", only for lines that are on the entity's latest month.
//   T1 ticked vs unticked: same refusal when unticked is refused; ticked-only refusal carries the untick hint;
//   T2 ticked rows are a superset of unticked rows; the difference is only the new line in (M, L], copied fields;
//   T3 other entities untouched; every other line's view is unchanged in every month; months < M unchanged for all lines;
//   T4 the household rule: the ticked add never creates a two-entity month the unticked add would not;
//   T5 maximality: a month in (M, L] that has rows and lacks the line after the write has a reason;
//   T6 preview (loader) == write; laterMonthsAdded == rows created; second ticked add refused, nothing written.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D, budgetRow, createFakeBudgetDb, type FakeBudgetRow } from "./budget-fake-db";

const m = vi.hoisted(() => ({ auth: vi.fn(), current: { db: null as unknown } }));
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({
  get db() {
    return m.current.db;
  },
}));

import { createBudget } from "@/actions/budgets";
import { loadLaterAddContext } from "@/lib/budget-carry-forward-build";
import { periodRange, shiftPeriod } from "@/lib/budget-materialize";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ENT = [uuid(1), uuid(2), uuid(3)];
const TAG = Array.from({ length: 8 }, (_, i) => uuid(10 + i));
const ACC = [uuid(100), uuid(101)];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function world(seed: number): FakeBudgetRow[] {
  const r = rng(seed);
  const rows: FakeBudgetRow[] = [];
  for (const entityId of ENT) {
    if (r() < 0.15) continue;
    const first = Math.floor(r() * 8);
    const last = first + Math.floor(r() * 10);
    const tags = [...TAG].sort(() => r() - 0.5).slice(0, 2 + Math.floor(r() * 4));
    for (const tagId of tags) {
      const s = first + Math.floor(r() * (last - first + 1));
      const e = r() < 0.55 ? last : s + Math.floor(r() * (last - s + 1));
      for (let k = s; k <= e; k++) {
        if (r() < 0.12 && k !== s && k !== e) continue;
        rows.push(
          budgetRow({
            entityId,
            tagId,
            period: shiftPeriod("2026-03", k),
            accountId: ACC[Math.floor(r() * 2)] as string,
            budgeted: r() < 0.1 ? null : D(String(10 + Math.floor(r() * 900))),
            payDay: r() < 0.5 ? 1 + Math.floor(r() * 27) : null,
            rolloverEnabled: r() < 0.3,
            rolloverAmount: r() < 0.3 ? D("12.5") : null,
            additionalAmountCents: r() < 0.3 ? D("5000") : D(0),
          })
        );
      }
    }
    const latest = shiftPeriod("2026-03", last);
    if (!rows.some((x) => x.entityId === entityId && x.period === latest)) rows.push(budgetRow({ entityId, tagId: tags[0] as string, period: latest }));
  }
  return rows;
}

// ── grid oracle ───────────────────────────────────────────────────────────────
function view(rows: readonly FakeBudgetRow[], entityId: string, p: string): Set<string> {
  const mine = rows.filter((x) => x.entityId === entityId);
  const out = new Set<string>();
  if (mine.length === 0) return out;
  const L = mine.reduce((acc, x) => (x.period > acc ? x.period : acc), "0000-00");
  const onL = new Set(mine.filter((x) => x.period === L).map((x) => x.tagId));
  if (mine.some((x) => x.period === p)) {
    for (const x of mine) if (x.period === p) out.add(x.tagId);
    return out;
  }
  for (const t of onL) if (mine.some((x) => x.tagId === t && x.period < p)) out.add(t);
  return out;
}
const WINDOW = periodRange("2025-09", "2029-06");
const key = (x: FakeBudgetRow) => `${x.entityId}|${x.tagId}|${x.period}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
  m.auth.mockReset();
  m.auth.mockResolvedValue({ user: { id: "user-1" } });
});
afterEach(() => vi.useRealTimers());

function fresh(rows: FakeBudgetRow[]) {
  const f = createFakeBudgetDb({
    rows,
    tags: TAG.map((id) => ({ id, name: id, shortName: id, parentId: null })),
    entities: ENT.map((id, i) => ({ id, name: `Entity ${i}`, slug: `e${i}` })),
    accounts: ACC.map((id) => ({ id, nickname: id, entityId: ENT[0] as string })),
  });
  m.current.db = f.db;
  return f;
}

describe("tester: ticked add end to end", () => {
  it("T1-T6 over random multi-entity worlds", async () => {
    const stats = { runs: 0, bothOk: 0, withLater: 0, tickedOnlyRefusal: 0, skippedOther: 0, skippedHas: 0, popped: 0, noRowsGap: 0 };
    for (let seed = 1; seed <= 260; seed++) {
      const base = world(seed);
      const r = rng(seed * 104729);
      for (let k = 0; k < 6; k++) {
        const entityId = ENT[Math.floor(r() * 3)] as string;
        const tagId = TAG[Math.floor(r() * TAG.length)] as string;
        const M = WINDOW[Math.floor(r() * (WINDOW.length - 8)) + 4] as string; // stays within 24 months of 2026-10
        if (M > "2028-10") continue;
        stats.runs += 1;
        const input = { tagId, entityId, accountId: ACC[1] as string, period: M, budgeted: "77.25", payDay: 9 };

        const fu = fresh(base.map((x) => ({ ...x })));
        const ru = (await createBudget(input as never)) as { success?: true; error?: string };
        const ft = fresh(base.map((x) => ({ ...x })));
        const pre = await loadLaterAddContext({ period: M, entityId });
        const rt = (await createBudget({ ...input, alsoAddToLaterMonths: true } as never)) as { success?: true; error?: string; laterMonthsAdded?: number };

        // T1
        if (ru.error) {
          expect(rt, `seed ${seed} ${k}`).toEqual(ru);
          expect(ft.state.committed.length).toBe(base.length);
          continue;
        }
        if (rt.error) {
          stats.tickedOnlyRefusal += 1;
          expect(rt.error).toContain("untick 'Also add to later saved months'");
          expect(ft.state.committed.length).toBe(base.length);
          expect(ft.state.audit).toEqual([]);
          continue;
        }
        stats.bothOk += 1;
        expect(rt.laterMonthsAdded).toBeTypeOf("number");

        // T2
        const uKeys = new Set(fu.state.committed.map(key));
        const tKeys = new Set(ft.state.committed.map(key));
        for (const kk of uKeys) expect(tKeys.has(kk), `seed ${seed}: ticked lost ${kk}`).toBe(true);
        const extra = ft.state.committed.filter((x) => !uKeys.has(key(x)));
        expect(extra.length).toBe(rt.laterMonthsAdded);
        const L = base.filter((x) => x.entityId === entityId).reduce((a, x) => (x.period > a ? x.period : a), "0000-00");
        for (const x of extra) {
          expect(x.entityId).toBe(entityId);
          expect(x.tagId).toBe(tagId);
          expect(x.period > M && x.period <= L, `seed ${seed}: extra row ${x.period} outside (${M}, ${L}]`).toBe(true);
          expect(x.accountId).toBe(ACC[1]);
          expect(x.budgeted?.toString()).toBe("77.25");
          expect(x.payDay).toBe(9);
          expect(x.rolloverEnabled).toBe(false);
          expect(x.rolloverAmount).toBeNull();
          expect(Number(x.additionalAmountCents)).toBe(0);
        }
        // the unticked rows equal the ticked ones outside the extras (same stored fields)
        for (const x of fu.state.committed) {
          const y = ft.state.committed.find((z) => key(z) === key(x))!;
          const strip = (q: FakeBudgetRow) => ({ ...q, id: "" });
          expect(strip(y)).toEqual(strip(x));
        }
        if (extra.length > 0) stats.withLater += 1;

        // T3
        for (const e of ENT.filter((x) => x !== entityId)) {
          expect(ft.state.committed.filter((x) => x.entityId === e).map(key).sort()).toEqual(base.filter((x) => x.entityId === e).map(key).sort());
        }
        for (const p of WINDOW) {
          for (const e of ENT) {
            const a = view(base, e, p);
            const b = view(ft.state.committed, e, p);
            for (const t of new Set([...a, ...b])) {
              if (e === entityId && t === tagId) continue;
              expect(b.has(t), `seed ${seed} ${e} ${t} ${p}: other line view changed`).toBe(a.has(t));
            }
          }
          if (p < M) expect(view(ft.state.committed, entityId, p).has(tagId), `seed ${seed}: month ${p} before ${M} gained the line`).toBe(view(base, entityId, p).has(tagId));
        }

        // T4: two-entity months for this tag
        const dup = (rows: readonly FakeBudgetRow[]) => WINDOW.filter((p) => ENT.filter((e) => view(rows, e, p).has(tagId)).length > 1);
        const dBase = dup(base);
        const dU = dup(fu.state.committed);
        const dT = dup(ft.state.committed);
        for (const p of dT) expect(dU.includes(p) || dBase.includes(p), `seed ${seed} ${entityId} ${tagId} ${M}: ticked add created a two-entity month ${p}`).toBe(true);

        // T5 maximality
        if (pre) {
          const preMonths = pre.candidates.filter((p) => !(pre.skippedByTag[tagId] ?? []).includes(p));
          expect(extra.map((x) => x.period).sort(), `seed ${seed}: preview != write`).toEqual(preMonths);
          stats.skippedHas += (pre.skippedByTag[tagId] ?? []).length > 0 ? 1 : 0;
        } else expect(extra).toEqual([]);
        for (const p of periodRange(shiftPeriod(M, 1), L)) {
          const hasRows = ft.state.committed.some((x) => x.entityId === entityId && x.period === p);
          const lacks = !ft.state.committed.some((x) => x.entityId === entityId && x.tagId === tagId && x.period === p);
          if (!hasRows || !lacks) continue;
          const reasons = [
            // the unticked-write view of the line in that month already had it (never true for a missing row), or another entity holds it
            ENT.some((e) => e !== entityId && view(base, e, p).has(tagId)),
            // the latest month was left out so the line does not run into another entity's months
            p === L,
          ];
          expect(reasons.some(Boolean), `seed ${seed} ${entityId} ${tagId} ${M}: ${p} has rows and lacks the line without a reason`).toBe(true);
          if (p === L && !ENT.some((e) => e !== entityId && view(base, e, p).has(tagId))) stats.popped += 1;
          else stats.skippedOther += 1;
        }
        if (periodRange(shiftPeriod(M, 1), L).some((p) => !base.some((x) => x.entityId === entityId && x.period === p) && !ft.state.committed.some((x) => x.entityId === entityId && x.period === p))) stats.noRowsGap += 1;

        // T6 second add refused, nothing written
        const snap = ft.state.committed.map(key).sort();
        const again = await createBudget({ ...input, alsoAddToLaterMonths: true } as never);
        expect(again).toHaveProperty("error");
        expect(ft.state.committed.map(key).sort()).toEqual(snap);
      }
    }
    console.log("tester-e2e stats", JSON.stringify(stats));
    expect(stats.bothOk).toBeGreaterThan(300);
    expect(stats.withLater).toBeGreaterThan(100);
    expect(stats.skippedHas).toBeGreaterThan(5);
  }, 600_000);

  it("every schedule field of the added line is copied to the later rows (weekly, biweekly, annual, semiannual, auto-sum parent)", async () => {
    const cases: Array<Record<string, unknown>> = [
      { frequency: "weekly", payDayOfWeek: 3, budgeted: "40" },
      { frequency: "biweekly", payDayOfWeek: 5, biweeklyAnchorDate: "2026-02-06", budgeted: "250.10" },
      { frequency: "annual", payMonth: 11, annualAmountDue: "1200", budgeted: "100", payDay: 15 },
      { frequency: "semiannual", payMonth: 4, annualAmountDue: "600.50", budgeted: "50", payDay: 2 },
      { frequency: "monthly", budgeted: "", payDay: 28 },
    ];
    for (const c of cases) {
      const rows = [
        budgetRow({ entityId: ENT[0] as string, tagId: TAG[0] as string, period: "2026-06", accountId: ACC[0] as string }),
        budgetRow({ entityId: ENT[0] as string, tagId: TAG[0] as string, period: "2026-09", accountId: ACC[0] as string }),
      ];
      const f = fresh(rows);
      const res = await createBudget({ tagId: TAG[5], entityId: ENT[0], accountId: ACC[1], period: "2026-07", alsoAddToLaterMonths: true, ...c } as never);
      expect(res).toEqual({ success: true, laterMonthsAdded: 2 });
      const mine = f.state.committed.filter((x) => x.tagId === TAG[5]).sort((a, b) => (a.period < b.period ? -1 : 1));
      expect(mine.map((x) => x.period)).toEqual(["2026-07", "2026-08", "2026-09"]);
      const [first, ...rest] = mine;
      for (const x of rest) {
        for (const fld of ["accountId", "frequency", "payDay", "payDayOfWeek", "payMonth"] as const) expect(x[fld], `${c.frequency} ${fld}`).toEqual(first![fld]);
        expect(x.budgeted?.toString() ?? null).toBe(first!.budgeted?.toString() ?? null);
        expect(x.annualAmountDue?.toString() ?? null).toBe(first!.annualAmountDue?.toString() ?? null);
        expect(x.biweeklyAnchorDate?.toISOString() ?? null).toBe(first!.biweeklyAnchorDate?.toISOString() ?? null);
      }
      if (c.frequency === "biweekly") expect(rest[0]!.biweeklyAnchorDate).not.toBeNull();
      if (c.frequency === "annual") expect(rest[0]!.annualAmountDue?.toString()).toBe("1200");
      if (c.budgeted === "") expect(rest[0]!.budgeted).toBeNull();
    }
  });

  it("M before the entity's first row: the empty months in between are not given rows (documented), the line is created from the first row on", async () => {
    const rows = [
      budgetRow({ entityId: ENT[0] as string, tagId: TAG[0] as string, period: "2026-06", accountId: ACC[0] as string }),
      budgetRow({ entityId: ENT[0] as string, tagId: TAG[0] as string, period: "2026-08", accountId: ACC[0] as string }),
    ];
    const f = fresh(rows);
    const res = await createBudget({ tagId: TAG[5], entityId: ENT[0], accountId: ACC[1], period: "2026-03", budgeted: "9", alsoAddToLaterMonths: true } as never);
    expect(res).toEqual({ success: true, laterMonthsAdded: 2 });
    expect(f.state.committed.filter((x) => x.tagId === TAG[5]).map((x) => x.period).sort()).toEqual(["2026-03", "2026-06", "2026-08"]);
    // no row was created in the empty months 04 and 05 (before the entity's first row, the first-edit save does not reach back)
    expect(f.state.committed.some((x) => x.period === "2026-04" || x.period === "2026-05")).toBe(false);
    // OBSERVATION (low, plan risk section accepts it): the line is now on the entity's latest month, so it is CARRIED into
    // the row-less months 04 and 05, which therefore show a one-line budget (the unticked add shows nothing there).
    const un = fresh(rows.map((x) => ({ ...x })));
    await createBudget({ tagId: TAG[5], entityId: ENT[0], accountId: ACC[1], period: "2026-03", budgeted: "9" } as never);
    expect([...view(un.state.committed, ENT[0] as string, "2026-04")]).toEqual([]);
    expect([...view(f.state.committed, ENT[0] as string, "2026-04")]).toEqual([TAG[5]]);
  });

  it("saveLaterAdds: create-only (skipDuplicates), nothing for an empty list, and no audit row when nothing was created", async () => {
    const { saveLaterAdds } = await import("@/lib/budget-materialize-build");
    const { toLaterCreateRows } = await import("@/lib/budget-materialize");
    const loc = { entityId: ENT[0] as string, tagId: TAG[0] as string, period: "2026-04" };
    const fields = { accountId: ACC[0] as string, budgeted: D("1"), payDay: null, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null };
    const rows = toLaterCreateRows(loc, ["2026-05", "2026-06"], fields);
    const make = (count: number) => ({
      budget: { createMany: vi.fn(async () => ({ count })) },
      auditLog: { create: vi.fn(async () => ({})) },
    });
    const none = make(0);
    expect(await saveLaterAdds(none as never, "u", loc, [])).toEqual({ created: 0, skipped: 0 });
    expect(none.budget.createMany).not.toHaveBeenCalled();
    expect(none.auditLog.create).not.toHaveBeenCalled();
    expect(await saveLaterAdds(none as never, "u", loc, rows)).toEqual({ created: 0, skipped: 2 });
    expect(none.budget.createMany).toHaveBeenCalledWith({ data: rows, skipDuplicates: true });
    expect(none.auditLog.create).not.toHaveBeenCalled();
    const some = make(1);
    expect(await saveLaterAdds(some as never, "u", loc, rows)).toEqual({ created: 1, skipped: 1 });
    expect(some.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("auth first and direct-call hardening: non-boolean / null flag rejected before any transaction, flag false identical to absent", async () => {
    const f = fresh(world(3));
    const input = { tagId: TAG[7], entityId: ENT[0], accountId: ACC[0], period: "2026-04", budgeted: "5" };
    for (const bad of [null, 1, "true", [], {}]) {
      expect(await createBudget({ ...input, alsoAddToLaterMonths: bad } as never)).toHaveProperty("error");
    }
    expect(f.state.transactions).toBe(0);
    m.auth.mockResolvedValue(null);
    await expect(createBudget({ ...input, alsoAddToLaterMonths: true } as never)).rejects.toThrow("Unauthorized");
    expect(f.state.transactions).toBe(0);
  });
});
