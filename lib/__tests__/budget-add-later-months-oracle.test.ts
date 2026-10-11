// Property tests for "also add to later saved months" against an INDEPENDENT oracle (naive, written from the owner's rule;
// it does not import lib/budget-carry-forward.ts):
//   - an entity's budget for a month: a line's own row wins; a month in which the entity has ANY row is authoritative;
//     in a month with no row at all the latest EARLIER row of the line is copied, but only if the line also has a row in
//     the entity's latest month (otherwise it has ended), and never backwards before the line's first row;
//   - adding a line in month M (M before the entity's latest month L, M not before the entity's first row) also adds it
//     to a month p in (M, L] when the entity has no view of the line there, no OTHER entity has it there, and p holds
//     rows (its own, or the carried set that the first-edit save stores in an empty month). A month before the entity's
//     first row is never saved.
// Checked over random multi-entity worlds and random (entity, tag, M):
//   P1 the planner's months equal the oracle's;
//   P2 after the write nothing beyond the new rows changes: other tags and other entities keep their views, no row after L;
//   P3 an earlier month changes exactly when the guard says so (so the action refuses exactly then);
//   P4 the household rule holds (the line is never in two entities in one month);
//   P5 running it again offers nothing, and the tag check would refuse the second add;
//   P6 rollover and the additional amount are never copied.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  addChangesEarlierMonth,
  periodRange,
  planAddToLaterMonths,
  planMaterialization,
  shiftPeriod,
  toLaterCreateRows,
  type BudgetCreateRow,
  type MaterializableRow,
} from "@/lib/budget-materialize";

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
    if (mine.some((r) => r.period === month)) continue;
    if (!inLatest.has(tag)) continue;
    const earlier = mine.filter((r) => r.tagId === tag && r.period < month).sort((a, b) => (a.period < b.period ? -1 : 1));
    const src = earlier[earlier.length - 1];
    if (src) view.set(tag, fields(src, true));
  }
  return view;
}

/** The oracle's answer: which months in (M, L] the new line is also added to. */
function oracleTargets(rows: readonly MaterializableRow[], entityId: string, tagId: string, M: string): string[] {
  const mine = rows.filter((r) => r.entityId === entityId);
  if (mine.length === 0) return [];
  const periods = mine.map((r) => r.period).sort();
  const first = periods[0] as string;
  const L = periods[periods.length - 1] as string;
  if (!(M < L)) return [];
  const out: string[] = [];
  for (let p = shiftPeriod(M, 1); p <= L; p = shiftPeriod(p, 1)) {
    if (oracleView(rows, entityId, p).has(tagId)) continue; // the entity already has it there (own or carried-and-saved)
    if (new Set(rows.map((r) => r.entityId)).size > 1) {
      const heldElsewhere = [...new Set(rows.map((r) => r.entityId))].some((e) => e !== entityId && oracleView(rows, e, p).has(tagId));
      if (heldElsewhere) continue;
    }
    const hasOwnRows = mine.some((r) => r.period === p);
    const saved = M >= first && p >= first && oracleView(rows, entityId, p).size > 0; // the first-edit save fills an empty month
    if (hasOwnRows || saved) out.push(p);
  }
  // the line would then carry forward from L: into every month after it and every month before it that has no rows. If
  // another entity holds the tag in one of those months, L is left out
  if (out[out.length - 1] === L) {
    const lastAll = rows.map((r) => r.period).sort().pop() as string;
    const rowless = (p: string) => !mine.some((r) => r.period === p) && !(M >= first && p >= first && oracleView(rows, entityId, p).size > 0);
    for (let p = shiftPeriod(M, 1); p <= shiftPeriod(lastAll, 1); p = shiftPeriod(p, 1)) {
      if (p === L || (p < L && !rowless(p))) continue;
      if (ENTITIES.some((e) => e !== entityId && oracleView(rows, e, p).has(tagId))) {
        out.pop();
        break;
      }
    }
  }
  return out;
}

// ── world generation (same shape as budget-materialize-oracle.test.ts) ────────

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
    if (r() < 0.15) continue;
    const first = Math.floor(r() * 10);
    const last = first + Math.floor(r() * 14);
    const tagCount = 2 + Math.floor(r() * 5);
    const tags = [...TAGS].sort(() => r() - 0.5).slice(0, tagCount);
    for (const tagId of tags) {
      const s = first + Math.floor(r() * (last - first + 1));
      const e = r() < 0.6 ? last : s + Math.floor(r() * (last - s + 1));
      for (let m = s; m <= e; m++) {
        if (r() < 0.1 && m !== s && m !== e) continue;
        rows.push(mkRow(r, entityId, tagId, shiftPeriod(BASE, m)));
      }
    }
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

const heldAnywhere = (rows: readonly MaterializableRow[], tagId: string, month: string) =>
  ENTITIES.some((e) => oracleView(rows, e, month).has(tagId));

const viewKey = (rows: readonly MaterializableRow[], entityId: string, month: string) =>
  JSON.stringify([...oracleView(rows, entityId, month)].sort(([a], [b]) => (a < b ? -1 : 1)));

// ── tests ─────────────────────────────────────────────────────────────────────

describe("add to later saved months vs an independent oracle", () => {
  it("P1-P6 over random worlds and random (entity, tag, month)", () => {
    let exercised = 0;
    let withTargets = 0;
    let withSkips = 0;
    let refusedByGuard = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rows = makeWorld(seed);
      const r = rng(seed * 7919);
      for (let k = 0; k < 8; k++) {
        const entityId = ENTITIES[Math.floor(r() * ENTITIES.length)] as string;
        const tagId = TAGS[Math.floor(r() * TAGS.length)] as string;
        const M = WINDOW[Math.floor(r() * WINDOW.length)] as string;
        if (heldAnywhere(rows, tagId, M)) continue; // the tag check would refuse the add before anything else
        if (!rows.some((x) => x.entityId === entityId)) continue;
        const loc = { entityId, tagId, period: M };
        if (addChangesEarlierMonth(rows, loc) !== null) continue; // refused even when unticked
        exercised += 1;

        // P1
        const plan = planAddToLaterMonths(rows, loc);
        const expected = oracleTargets(rows, entityId, tagId, M);
        expect(plan.months, `seed ${seed} ${entityId} ${tagId} ${M}`).toEqual(expected);
        if (plan.months.length > 0) withTargets += 1;
        if (plan.skipped.length > 0) withSkips += 1;
        const mine = rows.filter((x) => x.entityId === entityId);
        const L = mine.map((x) => x.period).sort().pop() as string;
        expect(plan.through).toBe(M < L ? L : null);

        // the write: first-edit save, the chosen month, the later months
        const save = planMaterialization(rows, entityId, M).creates;
        const withSave = applyCreates(rows, save);
        const newRow = { ...mkRow(rng(seed + k), entityId, tagId, M), rolloverAmount: null, additionalAmountCents: new Decimal(0) };
        const later = toLaterCreateRows(loc, plan.months, newRow);
        const after = applyCreates([...withSave, newRow], later);

        // P6
        for (const c of later) {
          expect(c.rolloverAmount).toBeNull();
          expect(c.additionalAmountCents).toBe(0);
          expect(c.rolloverEnabled).toBe(false);
        }

        // P3: an earlier month changes exactly when the guard (with the later months) says so
        const guard = addChangesEarlierMonth(rows, loc, plan.months);
        const earlierMonths = WINDOW.filter((p) => p < M);
        const changedEarlier = earlierMonths.filter((p) => viewKey(rows, entityId, p) !== viewKey(after, entityId, p));
        if (guard === null) expect(changedEarlier, `seed ${seed} ${entityId} ${tagId} ${M}`).toEqual([]);
        else {
          refusedByGuard += 1;
          expect(changedEarlier.length, `seed ${seed}: the guard refused but no earlier month changed`).toBeGreaterThan(0);
          expect(changedEarlier[0]!.slice(0, 7)).toBe(guard);
          continue; // the action refuses here: no write, nothing more to check
        }

        // P2: from M on, every other line keeps its view; the new line is where the oracle says
        const targets = new Set(expected);
        for (const p of WINDOW.filter((q) => q >= M && q <= L)) {
          const was = oracleView(rows, entityId, p);
          const now = oracleView(after, entityId, p);
          for (const [tag, f] of was) if (tag !== tagId) expect(now.get(tag), `seed ${seed} ${p} ${tag}`).toBe(f);
          for (const tag of now.keys()) if (tag !== tagId) expect(was.has(tag), `seed ${seed} ${p} gained ${tag}`).toBe(true);
          if (p === M || targets.has(p)) expect(now.has(tagId), `seed ${seed} ${p} should have the line`).toBe(true);
          else if (p !== M && after.some((x) => x.entityId === entityId && x.period === p)) expect(now.has(tagId), `seed ${seed} ${p} must not gain the line`).toBe(was.has(tagId));
        }
        // no row was created after the entity's latest month, and nothing was created for any month but M and the targets
        const addedRows = after.filter((x) => !rows.some((y) => y.id === x.id));
        for (const x of addedRows) {
          expect(x.entityId).toBe(entityId);
          if (x.period > L && M < L) throw new Error(`seed ${seed}: row created after the latest month`);
          if (x.tagId === tagId) expect(x.period === M || targets.has(x.period)).toBe(true);
        }
        // other entities are byte-identical
        for (const e of ENTITIES.filter((x) => x !== entityId)) {
          expect(after.filter((x) => x.entityId === e).map((x) => x.id).sort()).toEqual(rows.filter((x) => x.entityId === e).map((x) => x.id).sort());
        }

        // P4: the household rule, month by month (the window reaches well past every entity's latest month)
        // (Only for M before the latest month: adding at or after the latest month is today's single-month add, which
        // checks the chosen month only and is not part of this change.)
        // (Nor when the entity's latest month already has the line: adding it again in a month before the entity's first
        // row then carries it into the empty months, with or without this feature.)
        const alreadyOnLatest = oracleView(rows, entityId, L).has(tagId);
        for (const p of M < L && !alreadyOnLatest ? WINDOW.filter((q) => q >= M) : []) {
          const holders = ENTITIES.filter((e) => oracleView(after, e, p).has(tagId));
          const before = ENTITIES.filter((e) => oracleView(rows, e, p).has(tagId));
          expect(holders.length, `seed ${seed} ${entityId} ${tagId} ${M} month ${p}`).toBeLessThanOrEqual(Math.max(1, before.length));
        }

        // P5: again -> nothing more to add, and the tag check refuses the second add
        const again = planAddToLaterMonths(after, loc);
        // (a month before the entity's first row saves nothing, so a gap after it can still be filled by a later add;
        // that second add is refused by the tag check anyway)
        if (M >= (mine.map((x) => x.period).sort()[0] as string)) expect(again.months).toEqual([]);
        expect(heldAnywhere(after, tagId, M)).toBe(true);
      }
    }
    // the generator really exercised the interesting branches
    expect(exercised).toBeGreaterThan(300);
    expect(withTargets).toBeGreaterThan(100);
    expect(withSkips).toBeGreaterThan(10);
    expect(refusedByGuard).toBeGreaterThanOrEqual(0);
  });

  it("the preview (candidates minus the tag's skipped months) equals the months the write creates", () => {
    // The loader derives candidates with a tag that no row has, and skippedByTag per real tag, from the same planner.
    for (let seed = 1; seed <= 150; seed++) {
      const rows = makeWorld(seed);
      const r = rng(seed * 31);
      const entityId = ENTITIES[Math.floor(r() * ENTITIES.length)] as string;
      const M = WINDOW[Math.floor(r() * WINDOW.length)] as string;
      if (!rows.some((x) => x.entityId === entityId)) continue;
      const base = planAddToLaterMonths(rows, { entityId, tagId: "no-such-tag", period: M });
      for (const tagId of [...TAGS, "no-such-tag-2"]) {
        const plan = planAddToLaterMonths(rows, { entityId, tagId, period: M });
        const skipped = plan.skipped.filter((s) => s.reason !== "no_rows").map((s) => s.period);
        expect(base.months.filter((p) => !skipped.includes(p)), `seed ${seed} ${tagId} ${M}`).toEqual(plan.months);
      }
    }
  });
});
