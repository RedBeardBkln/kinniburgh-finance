// Property tests for the copy-on-first-edit planner against an INDEPENDENT oracle.
//
// The oracle below is written straight from the owner's rule, with brute-force filters and none of the resolver's
// structure (it does not import lib/budget-carry-forward.ts):
//   - an entity's budget for a month: a line's own row wins; a month in which the entity has ANY row is authoritative
//     (a line absent from it stays absent, owner decision 2026-10-10); in a month with no row at all the latest EARLIER
//     row of the line is copied (rollover amount dropped, one-off additional amount 0), but only if the line also has a
//     row in the entity's latest month (a line dropped from the latest month has ended), and never backwards before the
//     line's first row;
//   - each entity is judged on its own rows.
// Then random worlds (several entities, partial months, gap months, ended lines, rollover and additional values) are
// put through a chain of first edits and Deletes, and the invariants of the design are checked after every step:
//   I1 saving the carried set never changes ANY entity's view in ANY month;
//   I2 it only creates rows, creates nothing the second time and never overwrites;
//   I3 ending a line removes it from every month from the chosen one on, changes nothing else, revives nothing;
//   I4 rollover amount and additional amount are never copied;
//   I5 only the edited entity gets rows.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { addChangesEarlierMonth, periodRange, planEndLine, planMaterialization, shiftPeriod, type BudgetCreateRow, type MaterializableRow } from "@/lib/budget-materialize";

// ── the oracle ────────────────────────────────────────────────────────────────

function fields(r: MaterializableRow, carried: boolean): string {
  return JSON.stringify([
    r.accountId,
    r.budgeted === null ? null : r.budgeted.toString(),
    r.payDay,
    r.frequency,
    r.payDayOfWeek,
    r.biweeklyAnchorDate === null ? null : r.biweeklyAnchorDate.toISOString(),
    r.payMonth,
    r.annualAmountDue === null ? null : r.annualAmountDue.toString(),
    r.rolloverEnabled,
    carried ? null : r.rolloverAmount === null || r.rolloverAmount === undefined ? null : r.rolloverAmount.toString(),
    carried ? "0" : new Decimal(r.additionalAmountCents ?? 0).toString(),
  ]);
}

function oracleView(rows: readonly MaterializableRow[], entityId: string, month: string): Map<string, string> {
  const mine = rows.filter((r) => r.entityId === entityId);
  const view = new Map<string, string>();
  if (mine.length === 0) return view;
  const periods = mine.map((r) => r.period).sort();
  const latest = periods[periods.length - 1] as string;
  const inLatest = new Set(mine.filter((r) => r.period === latest).map((r) => r.tagId));
  for (const tag of new Set(mine.map((r) => r.tagId))) {
    const own = mine.find((r) => r.tagId === tag && r.period === month);
    if (own) {
      view.set(tag, fields(own, false));
      continue;
    }
    if (mine.some((r) => r.period === month)) continue; // the month has rows: authoritative
    if (!inLatest.has(tag)) continue; // ended
    const earlier = mine.filter((r) => r.tagId === tag && r.period < month).sort((a, b) => (a.period < b.period ? -1 : 1));
    const src = earlier[earlier.length - 1];
    if (src) view.set(tag, fields(src, true));
  }
  return view;
}

// ── world generation ──────────────────────────────────────────────────────────

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

const ENTITIES = ["e0", "e1", "e2"];
const TAGS = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"];
const BASE = "2026-01";
const WINDOW = [...periodRange("2025-11", "2028-12"), "2030-01"];

let idSeq = 0;
function mkRow(r: () => number, entityId: string, tagId: string, period: string): MaterializableRow {
  idSeq += 1;
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const freq = pick(["monthly", "monthly", "monthly", "weekly", "biweekly", "annual", "semiannual"]);
  return {
    id: `id-${idSeq}`,
    entityId,
    tagId,
    period,
    accountId: pick(["a1", "a2", "a3"]),
    budgeted: r() < 0.15 ? null : new Decimal(String(Math.floor(r() * 5000) / 4)),
    payDay: r() < 0.5 ? 1 + Math.floor(r() * 28) : null,
    frequency: freq,
    payDayOfWeek: freq === "weekly" || freq === "biweekly" ? Math.floor(r() * 7) : null,
    biweeklyAnchorDate: freq === "biweekly" ? new Date(Date.UTC(2026, Math.floor(r() * 12), 1 + Math.floor(r() * 27))) : null,
    payMonth: freq === "annual" || freq === "semiannual" ? 1 + Math.floor(r() * 12) : null,
    annualAmountDue: freq === "annual" || freq === "semiannual" ? new Decimal(String(100 + Math.floor(r() * 900))) : null,
    rolloverEnabled: r() < 0.3,
    rolloverAmount: r() < 0.3 ? new Decimal(String(Math.floor(r() * 400) / 2)) : null,
    additionalAmountCents: r() < 0.25 ? new Decimal(String(Math.floor(r() * 900) * 100)) : new Decimal(0),
  };
}

function makeWorld(seed: number): MaterializableRow[] {
  const r = rng(seed);
  const rows: MaterializableRow[] = [];
  for (const entityId of ENTITIES) {
    if (r() < 0.15) continue; // an entity with no budget at all
    const first = Math.floor(r() * 10);
    const last = first + Math.floor(r() * 14);
    const tagCount = 2 + Math.floor(r() * 5);
    const tags = [...TAGS].sort(() => r() - 0.5).slice(0, tagCount);
    for (const tagId of tags) {
      const s = first + Math.floor(r() * (last - first + 1));
      const e = r() < 0.6 ? last : s + Math.floor(r() * (last - s + 1));
      for (let m = s; m <= e; m++) {
        if (r() < 0.1 && m !== s && m !== e) continue; // a gap month inside the line's range
        rows.push(mkRow(r, entityId, tagId, shiftPeriod(BASE, m)));
      }
    }
    // make sure the entity's latest month exists (the frontier)
    const latest = shiftPeriod(BASE, last);
    if (!rows.some((x) => x.entityId === entityId && x.period === latest)) rows.push(mkRow(r, entityId, tags[0] as string, latest));
  }
  return rows;
}

function applyCreates(rows: readonly MaterializableRow[], creates: readonly BudgetCreateRow[]): MaterializableRow[] {
  const out = rows.slice();
  const has = new Set(out.map((x) => `${x.entityId}|${x.tagId}|${x.period}`));
  for (const c of creates) {
    const key = `${c.entityId}|${c.tagId}|${c.period}`;
    if (has.has(key)) continue; // createMany skipDuplicates
    has.add(key);
    idSeq += 1;
    out.push({ ...c, id: `id-${idSeq}`, additionalAmountCents: new Decimal(c.additionalAmountCents), rolloverAmount: c.rolloverAmount });
  }
  return out;
}

function viewAll(rows: readonly MaterializableRow[]): Map<string, string> {
  const all = new Map<string, string>();
  for (const e of ENTITIES) for (const m of WINDOW) for (const [tag, f] of oracleView(rows, e, m)) all.set(`${e}|${tag}|${m}`, f);
  return all;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("the oracle itself (sanity)", () => {
  it("matches the owner's examples", () => {
    const rows = [
      mkRow(rng(1), "e0", "t0", "2026-11"),
      mkRow(rng(2), "e0", "t1", "2026-11"),
      mkRow(rng(3), "e0", "t0", "2026-12"),
    ];
    expect([...oracleView(rows, "e0", "2027-03").keys()]).toEqual(["t0"]); // t1 ended
    expect([...oracleView(rows, "e0", "2026-10").keys()]).toEqual([]); // never backwards
    expect([...oracleView(rows, "e1", "2027-03").keys()]).toEqual([]); // another entity
  });
});

describe("materialization: invariants over random worlds", () => {
  it("I1, I2, I4, I5 hold across a chain of first edits (400 worlds, 5 edits each)", () => {
    let edits = 0;
    let createdTotal = 0;
    for (let seed = 1; seed <= 400; seed++) {
      let rows = makeWorld(seed);
      const r = rng(seed * 7919);
      for (let step = 0; step < 5; step++) {
        const entityId = ENTITIES[Math.floor(r() * ENTITIES.length)] as string;
        const month = shiftPeriod(BASE, Math.floor(r() * 30) - 4); // 2025-09 .. 2028-06, before and after the data
        const before = viewAll(rows);

        const plan = planMaterialization(rows, entityId, month);
        const next = applyCreates(rows, plan.creates);
        edits += 1;
        createdTotal += plan.creates.length;

        // I1: no entity, line or month changes
        expect(viewAll(next), `seed ${seed} step ${step}`).toEqual(before);
        // I5: only the edited entity gets rows
        expect(plan.creates.every((c) => c.entityId === entityId)).toBe(true);
        // I4: rollover amount and additional amount are never copied
        for (const c of plan.creates) {
          expect(c.rolloverAmount).toBeNull();
          expect(c.additionalAmountCents).toBe(0);
        }
        // I2: nothing existing is touched, nothing is created twice, a second run creates nothing
        const existing = new Set(rows.map((x) => `${x.entityId}|${x.tagId}|${x.period}`));
        const keys = plan.creates.map((c) => `${c.entityId}|${c.tagId}|${c.period}`);
        expect(new Set(keys).size).toBe(keys.length);
        for (const k of keys) expect(existing.has(k)).toBe(false);
        for (const orig of rows) expect(next.find((x) => x.id === orig.id)).toBe(orig);
        expect(planMaterialization(next, entityId, month).creates).toEqual([]);

        // the plan IS the carried part of the oracle's view of the edited month, and afterwards the month is saved in full
        const firstRow = rows.filter((x) => x.entityId === entityId).map((x) => x.period).sort()[0];
        const shown = oracleView(rows, entityId, month);
        const own = new Set(rows.filter((x) => x.entityId === entityId && x.period === month).map((x) => x.tagId));
        const expectedTags = [...shown.keys()].filter((t) => !own.has(t)).sort();
        expect(plan.creates.filter((c) => c.period === month).map((c) => c.tagId).sort(), `seed ${seed} step ${step}`).toEqual(expectedTags);
        if (firstRow !== undefined && month >= firstRow) {
          const saved = new Set(next.filter((x) => x.entityId === entityId && x.period === month).map((x) => x.tagId));
          expect([...saved].sort()).toEqual([...shown.keys()].sort());
        }
        rows = next;
      }
    }
    expect(edits).toBe(2000);
    expect(createdTotal).toBeGreaterThan(500); // the generator really exercises carrying
  });

  it("covers the interesting cases: gap months, ended lines, a target beyond the frontier, an entity with no rows", () => {
    let beyond = 0;
    let ended = 0;
    let gapFill = 0;
    let empty = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rows = makeWorld(seed);
      for (const e of ENTITIES) {
        const mine = rows.filter((x) => x.entityId === e);
        if (mine.length === 0) {
          empty += 1;
          continue;
        }
        const periods = mine.map((x) => x.period).sort();
        const frontier = periods[periods.length - 1] as string;
        const lastOf = new Map<string, string>();
        for (const x of mine) if ((lastOf.get(x.tagId) ?? "") < x.period) lastOf.set(x.tagId, x.period);
        if ([...lastOf.values()].some((p) => p < frontier)) ended += 1;
        const plan = planMaterialization(rows, e, shiftPeriod(frontier, 3));
        if (plan.months.length >= 3) gapFill += 1;
        beyond += 1;
      }
    }
    expect(beyond).toBeGreaterThan(200);
    expect(ended).toBeGreaterThan(50);
    expect(gapFill).toBeGreaterThan(50);
    expect(empty).toBeGreaterThan(20);
  });
});

describe("Delete = end the line from this month on: invariants over random worlds", () => {
  it("I3 and the refusal rule hold (400 worlds, 5 deletes each)", () => {
    let done = 0;
    let refused = 0;
    let notInView = 0;
    for (let seed = 1; seed <= 400; seed++) {
      let rows = makeWorld(seed + 10_000);
      const r = rng(seed * 104729);
      for (let step = 0; step < 5; step++) {
        const entityId = ENTITIES[Math.floor(r() * ENTITIES.length)] as string;
        const month = shiftPeriod(BASE, Math.floor(r() * 28) - 2);
        const tagId = TAGS[Math.floor(r() * TAGS.length)] as string;
        const before = viewAll(rows);
        const plan = planEndLine(rows, { entityId, tagId, period: month });

        const inView = oracleView(rows, entityId, month).has(tagId);
        if (!inView) {
          expect(plan, `seed ${seed}`).toEqual({ ok: false, reason: "not_in_view" });
          notInView += 1;
          continue;
        }

        // the refusal rule, stated independently: a month that holds rows today (from the chosen month on) would be left
        // with none, or the chosen month after the latest one would have no other line
        const mineRows = rows.filter((x) => x.entityId === entityId);
        const mine = mineRows.map((x) => x.period).sort();
        const frontier = mine[mine.length - 1] as string;
        const reference = month > frontier ? month : frontier;
        const soleMonths = [...new Set(mine)].filter((p) => p >= month && mineRows.filter((x) => x.period === p).every((x) => x.tagId === tagId));
        const noOtherAtTarget = month > frontier && [...oracleView(rows, entityId, month).keys()].filter((t) => t !== tagId).length === 0;
        if (soleMonths.length > 0 || noOtherAtTarget) {
          expect(plan, `seed ${seed} step ${step}`).toMatchObject({ ok: false, reason: "only_line_left" });
          refused += 1;
          continue;
        }

        expect(plan.ok, `seed ${seed} step ${step}`).toBe(true);
        if (!plan.ok) continue;
        // apply: create the fill set, delete the line's rows from the month on
        const after = applyCreates(
          rows.filter((x) => !(x.entityId === entityId && x.tagId === tagId && x.period >= month)),
          plan.creates
        );
        expect(rows.filter((x) => x.entityId === entityId && x.tagId === tagId && x.period >= month)).toHaveLength(plan.deleteCount);
        const view = viewAll(after);

        for (const [key, value] of before) {
          const [e, t, m] = key.split("|") as [string, string, string];
          if (e === entityId && t === tagId && m >= month) {
            expect(view.has(key), `line must be gone: ${key} (seed ${seed})`).toBe(false); // I3a
          } else {
            expect(view.get(key), `unchanged: ${key} (seed ${seed} step ${step} ended ${entityId}/${tagId}@${month}, creates ${plan.creates.length})`).toBe(value); // I3b/c: nothing else moves, nothing is revived
          }
        }
        for (const key of view.keys()) {
          if (!before.has(key)) throw new Error(`a line appeared that was not shown before: ${key} (seed ${seed})`); // nothing revived
        }
        // I4 and I5 for the fill set
        for (const c of plan.creates) {
          expect(c.entityId).toBe(entityId);
          expect(c.rolloverAmount).toBeNull();
          expect(c.additionalAmountCents).toBe(0);
          if (c.tagId === tagId) expect(c.period < month).toBe(true); // the ended line is never saved at or after the chosen month
        }
        // the entity keeps a latest month that is the same as before (or the target month)
        const afterPeriods = after.filter((x) => x.entityId === entityId).map((x) => x.period).sort();
        expect(afterPeriods[afterPeriods.length - 1]).toBe(reference);
        // idempotent: the line is no longer in view, so a second Delete is a no-op
        expect(planEndLine(after, { entityId, tagId, period: month })).toEqual({ ok: false, reason: "not_in_view" });
        rows = after;
        done += 1;
      }
    }
    expect(done).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(5);
    expect(notInView).toBeGreaterThan(100);
  });
});

describe("adding or re-adding a line (createBudget): only that line, from that month on, changes", () => {
  it("no other entity, line or earlier month changes (400 worlds x 5 adds), including a re-added ENDED line (owner decision 2026-10-10)", () => {
    let adds = 0;
    let refusedAdds = 0;
    let reAdded = 0;
    let afterFrontier = 0;
    let withGapFill = 0;
    for (let seed = 1; seed <= 400; seed++) {
      let rows = makeWorld(seed + 20_000);
      const r = rng(seed * 15485863);
      for (let step = 0; step < 5; step++) {
        const entityId = ENTITIES[Math.floor(r() * ENTITIES.length)] as string;
        const month = shiftPeriod(BASE, Math.floor(r() * 28) - 2);
        const tagId = TAGS[Math.floor(r() * TAGS.length)] as string;
        if (oracleView(rows, entityId, month).has(tagId)) continue; // the tag rule refuses a line that is already on the month
        if (rows.some((x) => x.entityId === entityId && x.tagId === tagId && x.period === month)) continue;
        const before = viewAll(rows);
        const mine = rows.filter((x) => x.entityId === entityId).map((x) => x.period).sort();
        const frontier = mine[mine.length - 1];

        // what createBudget does: save the carried set first, then insert the new line
        const plan = planMaterialization(rows, entityId, month);
        const added = mkRow(r, entityId, tagId, month);
        const next = applyCreates(rows, plan.creates).concat(added);
        const after = viewAll(next);
        // the guard: an add that WOULD change an earlier month is refused by the action; here the guard must agree with the oracle
        const touched = addChangesEarlierMonth(rows, { entityId, tagId, period: month });
        const earlierChanged = [...new Set([...before.keys(), ...after.keys()])].some((key) => {
          const [e, , m] = key.split("|") as [string, string, string];
          return e === entityId && m < month && before.get(key) !== after.get(key);
        });
        expect(touched !== null, `seed ${seed} step ${step} guard vs oracle (${tagId} at ${month})`).toBe(earlierChanged);
        if (touched !== null) {
          refusedAdds += 1;
          continue; // the action answers with a plain message and writes nothing
        }
        adds += 1;
        if (rows.some((x) => x.entityId === entityId && x.tagId === tagId && x.period < month)) reAdded += 1;
        if (frontier !== undefined && month > frontier) afterFrontier += 1;
        if (plan.months.length > 1) withGapFill += 1;

        for (const key of new Set([...before.keys(), ...after.keys()])) {
          const [e, t, m] = key.split("|") as [string, string, string];
          if (e === entityId && t === tagId && m >= month) continue; // the added line, from its month on
          expect(after.get(key), `seed ${seed} step ${step} ${key} (added ${tagId} at ${month})`).toBe(before.get(key));
        }
        expect(after.has(`${entityId}|${tagId}|${month}`)).toBe(true);
        rows = next;
      }
    }
    expect(refusedAdds).toBeGreaterThanOrEqual(0); // rare by construction (an empty month in which nothing is carried today)
    expect(adds).toBeGreaterThan(700);
    expect(reAdded).toBeGreaterThan(50);
    expect(afterFrontier).toBeGreaterThan(100);
    expect(withGapFill).toBeGreaterThan(50);
  });
});
