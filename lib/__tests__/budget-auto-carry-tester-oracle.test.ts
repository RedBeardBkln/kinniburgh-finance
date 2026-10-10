// TESTER: independent oracle + seeded fuzz for the Budget write actions (copy-on-first-edit, locator contract, delete =
// end the line). Own in-memory Budget table with the real unique index, an undo-log rollback and a real advisory-lock
// mutex (NOT the Coder's fake), and an own implementation of the effective view written from the owner rule in CLAUDE.md
// (a line carries from its latest earlier row only if it exists in the entity's latest month). The real actions and the
// real planner run on top of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  entityId: string;
  tagId: string;
  accountId: string;
  period: string;
  budgeted: { toString(): string } | null;
  additionalAmountCents: { toString(): string } | number;
  payDay: number | null;
  frequency: string;
  payDayOfWeek: number | null;
  biweeklyAnchorDate: Date | null;
  payMonth: number | null;
  annualAmountDue: { toString(): string } | null;
  rolloverEnabled: boolean;
  rolloverAmount: { toString(): string } | null;
};

const H = vi.hoisted(() => {
  const s = {
    rows: [] as Row[],
    audit: [] as Array<{ changeType: string; after: unknown; changedBy: string }>,
    bills: [] as Array<Record<string, unknown>>,
    txLog: [] as string[][], // per transaction: ordered op names
    session: { user: { id: "user-1" } } as { user: { id: string } } | null,
    nextId: 1,
    locking: true, // false = mutation: tx does not take the mutex
    failOn: null as string | null,
    txOpts: [] as unknown[],
    entities: {} as Record<string, string>,
    tags: new Set<string>(),
  };
  let held = false;
  const waiters: Array<() => void> = [];
  const acquire = async () => {
    if (!held) {
      held = true;
      return;
    }
    await new Promise<void>((r) => waiters.push(r));
  };
  const release = () => {
    const w = waiters.shift();
    if (w) w();
    else held = false;
  };
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const key = (r: { tagId: string; entityId: string; period: string }) => `${r.tagId}|${r.entityId}|${r.period}`;

  const db = {
    budget: {
      // plain (non-transaction) read used by the loaders
      async findMany(args: { where?: { entityId?: string } }) {
        const w = args.where?.entityId;
        return s.rows.filter((r) => !w || r.entityId === w).map((r) => ({ ...r }));
      },
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>, opts?: unknown): Promise<T> {
      s.txOpts.push(opts);
      const log: string[] = [];
      s.txLog.push(log);
      const undo: Array<() => void> = [];
      const pendingAudit: typeof s.audit = [];
      let locked = false;
      const op = async (name: string) => {
        log.push(name);
        await tick();
        if (s.failOn === name) throw new Error("injected failure at " + name);
      };
      const tx = {
        async $executeRaw(strings: TemplateStringsArray, ...vals: unknown[]) {
          await op("lock:" + strings.join("?") + ":" + String(vals[0]));
          if (s.locking) {
            await acquire();
            locked = true;
          }
          return 1;
        },
        budget: {
          async findMany(args: { where?: Record<string, unknown>; select?: unknown; orderBy?: unknown; take?: number }) {
            await op("budget.findMany");
            if (!args.select && !(args.where as { tagId?: string } | undefined)?.tagId) throw new Error("planning read without explicit select");
            let out = s.rows.slice();
            const w = args.where as { tagId?: string; entityId?: string; period?: { gt: string } } | undefined;
            if (w?.tagId) out = out.filter((r) => r.tagId === w.tagId);
            if (w?.entityId) out = out.filter((r) => r.entityId === w.entityId);
            if (w?.period?.gt) out = out.filter((r) => r.period > (w.period as { gt: string }).gt);
            return out.map((r) => ({ ...r }));
          },
          async findUnique(args: { where: { tagId_entityId_period?: { tagId: string; entityId: string; period: string }; id?: string } }) {
            await op("budget.findUnique");
            const k = args.where.tagId_entityId_period;
            const r = k ? s.rows.find((x) => key(x) === key(k)) : s.rows.find((x) => x.id === args.where.id);
            return r ? { ...r } : null;
          },
          async createMany(args: { data: Array<Omit<Row, "id">>; skipDuplicates?: boolean }) {
            await op("budget.createMany" + (args.skipDuplicates ? ":skip" : ":noskip"));
            let count = 0;
            for (const d of args.data) {
              if (s.rows.some((x) => key(x) === key(d))) {
                if (args.skipDuplicates) continue;
                throw new Error("P2002 unique");
              }
              const row = { ...d, id: "id-" + s.nextId++ } as Row;
              s.rows.push(row);
              undo.push(() => {
                s.rows = s.rows.filter((x) => x.id !== row.id);
              });
              count++;
            }
            return { count };
          },
          async create(args: { data: Partial<Omit<Row, "id">> & Pick<Row, "tagId" | "entityId" | "period"> }) {
            await op("budget.create");
            if (s.rows.some((x) => key(x) === key(args.data))) throw new Error("P2002 unique");
            const row = {
              additionalAmountCents: 0,
              payDay: null,
              payDayOfWeek: null,
              biweeklyAnchorDate: null,
              payMonth: null,
              annualAmountDue: null,
              rolloverEnabled: false,
              rolloverAmount: null,
              ...args.data,
              id: "id-" + s.nextId++,
            } as Row;
            s.rows.push(row);
            undo.push(() => {
              s.rows = s.rows.filter((x) => x.id !== row.id);
            });
            return row;
          },
          async update(args: { where: { id: string }; data: Record<string, unknown> }) {
            await op("budget.update");
            const idx = s.rows.findIndex((x) => x.id === args.where.id);
            if (idx < 0) throw new Error("update: not found");
            const old = s.rows[idx] as Row;
            const next: Record<string, unknown> = { ...old };
            for (const [k, v] of Object.entries(args.data)) {
              if (k === "account") next.accountId = (v as { connect: { id: string } }).connect.id;
              else next[k] = v;
            }
            s.rows[idx] = next as Row;
            undo.push(() => {
              s.rows[idx] = old;
            });
            return next;
          },
          async deleteMany(args: { where: { entityId: string; tagId: string; period: { gte: string } } }) {
            await op("budget.deleteMany");
            const w = args.where;
            const gone = s.rows.filter((r) => r.entityId === w.entityId && r.tagId === w.tagId && r.period >= w.period.gte);
            s.rows = s.rows.filter((r) => !gone.includes(r));
            undo.push(() => {
              s.rows.push(...gone);
            });
            return { count: gone.length };
          },
        },
        auditLog: {
          async create(args: { data: { changeType: string; after: unknown; changedBy: string } }) {
            await op("auditLog.create");
            pendingAudit.push(args.data);
            return {};
          },
        },
        entity: {
          async findUnique(args: { where: { id: string } }) {
            await op("entity.findUnique");
            return s.entities[args.where.id] ? { name: s.entities[args.where.id] } : null;
          },
        },
        tag: {
          async findUnique(args: { where: { id: string } }) {
            await op("tag.findUnique");
            return { id: args.where.id, shortName: "S-" + args.where.id.slice(-4) };
          },
        },
        scheduledBill: {
          async upsert(args: { create: Record<string, unknown> }) {
            await op("scheduledBill.upsert");
            s.bills.push({ kind: "upsert", ...args.create });
            return {};
          },
          async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
            await op("scheduledBill.updateMany");
            s.bills.push({ kind: "updateMany", ...args.where, ...args.data });
            return { count: 1 };
          },
        },
      };
      try {
        const out = await fn(tx);
        s.audit.push(...pendingAudit);
        return out;
      } catch (e) {
        for (const u of undo.reverse()) u();
        throw e;
      } finally {
        if (locked) release();
      }
    },
  };
  return { s, db };
});

vi.mock("@/lib/auth", () => ({ auth: async () => H.s.session }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: H.db }));

import { Prisma } from "@prisma/client";
import { createBudget, deleteBudget, updateBudget, updateBudgetAdditionalAmount, updateBudgetLine } from "@/actions/budgets";
import { loadFirstEditContext } from "@/lib/budget-carry-forward-build";
import { carriedMonthNotice } from "@/lib/budget-materialize";

// ── helpers ────────────────────────────────────────────────────────────────────

const S = H.s;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ENTS = [uuid(1), uuid(2), uuid(3)];
const ACCTS = [uuid(100), uuid(101), uuid(102)];
const TAGS_BY_ENT = [
  [uuid(10), uuid(11), uuid(12), uuid(13), uuid(14)],
  [uuid(20), uuid(21), uuid(22), uuid(23)],
  [uuid(30), uuid(31), uuid(32)],
];
const ALL_TAGS = TAGS_BY_ENT.flat();

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// months as integer index (year*12 + month-1): my own arithmetic, not the planner's string helpers
const mi = (p: string) => Number(p.slice(0, 4)) * 12 + Number(p.slice(5, 7)) - 1;
const pm = (i: number) => `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;

interface V {
  budgeted: string | null;
  accountId: string;
  payDay: number | null;
  frequency: string;
  dow: number | null;
  anchor: string | null;
  payMonth: number | null;
  annual: string | null;
  rollEnabled: boolean;
  add: number;
  rollAmt: string | null;
}
const num = (x: { toString(): string } | number | null): string | null => (x === null ? null : Number(x.toString()).toFixed(2));
function fields(r: Row, carried: boolean): V {
  return {
    budgeted: num(r.budgeted),
    accountId: r.accountId,
    payDay: r.payDay,
    frequency: r.frequency,
    dow: r.payDayOfWeek,
    anchor: r.biweeklyAnchorDate ? r.biweeklyAnchorDate.toISOString().slice(0, 10) : null,
    payMonth: r.payMonth,
    annual: num(r.annualAmountDue),
    rollEnabled: r.rolloverEnabled,
    add: carried ? 0 : Number((r.additionalAmountCents ?? 0).toString()),
    rollAmt: carried ? null : num(r.rolloverAmount),
  };
}

/** My own effective view: Map tagId -> {source, fields} for one entity and month. */
function view(rows: Row[], entityId: string, month: string): Map<string, { src: "own" | "carried"; v: V; from: string }> {
  const mine = rows.filter((r) => r.entityId === entityId);
  const out = new Map<string, { src: "own" | "carried"; v: V; from: string }>();
  if (mine.length === 0) return out;
  const frontier = Math.max(...mine.map((r) => mi(r.period)));
  const m = mi(month);
  // owner decision 2026-10-10: a month in which the entity has rows is authoritative (nothing is carried into it)
  const hasRows = mine.some((r) => mi(r.period) === m);
  for (const tag of new Set(mine.map((r) => r.tagId))) {
    const rs = mine.filter((r) => r.tagId === tag).sort((a, b) => mi(a.period) - mi(b.period));
    let hit: Row | undefined;
    for (const r of rs) if (mi(r.period) <= m) hit = r;
    if (!hit) continue;
    if (mi(hit.period) === m) out.set(tag, { src: "own", v: fields(hit, false), from: hit.period });
    else if (!hasRows && mi(rs[rs.length - 1]!.period) === frontier) out.set(tag, { src: "carried", v: fields(hit, true), from: hit.period });
  }
  return out;
}

const WINDOW_FROM = mi("2025-10");
const WINDOW_TO = mi("2029-12");

function snapshotViews(rows: Row[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of ENTS) {
    for (let i = WINDOW_FROM; i <= WINDOW_TO; i++) {
      for (const [tag, x] of view(rows, e, pm(i))) m.set(`${e}|${pm(i)}|${tag}`, JSON.stringify(x.v));
    }
  }
  return m;
}
function diffViews(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) out.push(`${k}: ${a.get(k) ?? "-"} => ${b.get(k) ?? "-"}`);
  return out.sort();
}

const D = (s: string | null) => (s === null ? null : new Prisma.Decimal(s));
function mk(p: Partial<Row> & Pick<Row, "entityId" | "tagId" | "period">): Row {
  return {
    id: "seed-" + S.nextId++,
    accountId: ACCTS[0]!,
    budgeted: D("10.00"),
    additionalAmountCents: new Prisma.Decimal(0),
    payDay: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    rolloverEnabled: false,
    rolloverAmount: null,
    ...p,
  } as Row;
}

function genWorld(seed: number, opts: { gapLines: boolean }): Row[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const rows: Row[] = [];
  for (let e = 0; e < ENTS.length; e++) {
    if (r() < 0.15) continue; // empty entity (like Mezzo)
    const first = mi("2026-01") + Math.floor(r() * 6);
    const F = first + Math.floor(r() * 10);
    const tags = TAGS_BY_ENT[e]!;
    const curated = new Set<number>([first, F]);
    for (let i = first; i <= F; i++) if (r() < 0.75) curated.add(i);
    const core = tags[0]!;
    for (const tag of tags) {
      const start = tag === core ? first : first + Math.floor(r() * (F - first + 1));
      const ended = tag !== core && r() < 0.3;
      const end = ended ? start + Math.floor(r() * Math.max(1, F - start)) : F;
      for (const i of curated) {
        if (i < start || i > end) continue;
        if (tag !== core && opts.gapLines && r() > 0.8) continue; // line gap (a month where other lines have rows, this one has none)
        rows.push(
          mk({
            entityId: ENTS[e]!,
            tagId: tag,
            period: pm(i),
            accountId: pick(ACCTS),
            budgeted: r() < 0.15 ? null : D((10 + Math.floor(r() * 500)).toFixed(0) + "." + pick(["00", "25", "50"])),
            payDay: r() < 0.5 ? 1 + Math.floor(r() * 28) : null,
            additionalAmountCents: new Prisma.Decimal(r() < 0.1 ? 500 : 0),
            rolloverEnabled: r() < 0.1,
          })
        );
      }
    }
  }
  return rows;
}

function setWorld(rows: Row[]) {
  S.rows = rows.map((x) => ({ ...x }));
  S.audit = [];
  S.bills = [];
  S.txLog = [];
  S.session = { user: { id: "user-1" } };
  S.locking = true;
  S.failOn = null;
  S.txOpts = [];
  S.entities = { [ENTS[0]!]: "Personal", [ENTS[1]!]: "Sudden Valley", [ENTS[2]!]: "EK Consulting" };
}

const NOW_PERIOD_INDEX = mi("2026-10");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
  S.nextId = 1;
});
afterEach(() => vi.useRealTimers());

function entityInfo(rows: Row[], e: string) {
  const mine = rows.filter((r) => r.entityId === e);
  if (!mine.length) return null;
  const idx = mine.map((r) => mi(r.period));
  return { first: Math.min(...idx), frontier: Math.max(...idx), has: new Set(idx) };
}

/** The expected store after an edit/create at (e, M): fill row-less months up to max(M, F), plus the carried lines of M. */
function expectedFilled(rows: Row[], e: string, M: number): Row[] {
  const info = entityInfo(rows, e);
  const out = rows.map((x) => ({ ...x }));
  if (!info || M < info.first) return out;
  const upTo = Math.max(M, info.frontier);
  const months = new Set<number>([M]);
  for (let i = info.first; i <= upTo; i++) if (!info.has.has(i)) months.add(i);
  for (const i of months) {
    for (const [tag, x] of view(rows, e, pm(i))) {
      if (x.src !== "carried") continue;
      const src = rows.find((r) => r.entityId === e && r.tagId === tag && r.period === x.from)!;
      out.push({
        ...src,
        id: "exp-" + out.length,
        period: pm(i),
        additionalAmountCents: new Prisma.Decimal(0),
        rolloverAmount: null,
      });
    }
  }
  return out;
}

function randomLine(r: () => number, rows: Row[], e: string, M: number): { tagId: string; inView: boolean } {
  const v = view(rows, e, pm(M));
  const tags = [...v.keys()];
  if (tags.length && r() < 0.9) return { tagId: tags[Math.floor(r() * tags.length)]!, inView: true };
  const t = TAGS_BY_ENT[ENTS.indexOf(e)]![Math.floor(r() * TAGS_BY_ENT[ENTS.indexOf(e)]!.length)]!;
  return { tagId: t, inView: v.has(t) };
}

const counters = { edits: 0, deletes: 0, creates: 0, refusedDelete: 0, staleRefused: 0, ownAtM: 0, carriedAtM: 0, mAfterF: 0, mBeforeF: 0, gapFill: 0, applyFuture: 0, lineGapFlow: 0, createConflict: 0, crossEntity: 0, firstEditNoop: 0 };

describe("TESTER oracle: every write path vs an independent model", () => {
  it("edits (inline amount, modal, additional buffer) change only the intended cell; the saved set is exactly the carried set + row-less months", async () => {
    for (let seed = 1; seed <= 350; seed++) {
      const r = rng(seed * 7919);
      const world = genWorld(seed, { gapLines: seed % 2 === 0 });
      setWorld(world);
      for (let step = 0; step < 4; step++) {
        const before = S.rows.map((x) => ({ ...x }));
        const e = ENTS[Math.floor(r() * ENTS.length)]!;
        const info = entityInfo(before, e);
        const lo = info ? info.first - 2 : mi("2026-10");
        const hi = Math.min(info ? info.frontier + 8 : mi("2026-10") + 6, NOW_PERIOD_INDEX + 24);
        const M = lo + Math.floor(r() * (hi - lo + 1));
        const { tagId, inView } = randomLine(r, before, e, M);
        const loc = { entityId: e, tagId, period: pm(M) };
        const kind = Math.floor(r() * 3);
        const auditBefore = S.audit.length;
        const viewsBefore = snapshotViews(before);
        let res: { success?: true; error?: string };
        const edit: Partial<V> & { applyFuture?: boolean } = {};
        if (kind === 0) {
          edit.budgeted = (100 + Math.floor(r() * 900)).toFixed(0) + ".00";
          res = await updateBudgetLine(loc, edit.budgeted);
        } else if (kind === 1) {
          edit.add = 1 + Math.floor(r() * 900);
          res = await updateBudgetAdditionalAmount(loc, edit.add);
        } else {
          edit.payDay = 1 + Math.floor(r() * 28);
          edit.accountId = ACCTS[Math.floor(r() * 3)]!;
          edit.applyFuture = r() < 0.5;
          res = await updateBudget(loc, { payDay: edit.payDay, accountId: edit.accountId, applyToFuture: edit.applyFuture });
        }
        counters.edits++;
        if (!inView) {
          counters.staleRefused++;
          expect(res.error, `seed ${seed} step ${step} stale`).toBe("That line is no longer on this month's budget. Refresh the page.");
          expect(snapshotViews(S.rows)).toEqual(viewsBefore);
          expect(S.rows.length).toBe(before.length);
          expect(S.audit.length).toBe(auditBefore);
          continue;
        }
        expect(res.success, `seed ${seed} step ${step} ${JSON.stringify(res)}`).toBe(true);

        // expected store
        const exp = expectedFilled(before, e, M);
        const target = exp.find((x) => x.entityId === e && x.tagId === tagId && x.period === pm(M))!;
        const wasCarried = view(before, e, pm(M)).get(tagId)!.src === "carried";
        if (wasCarried) counters.carriedAtM++;
        else counters.ownAtM++;
        if (info && M > info.frontier) counters.mAfterF++;
        if (info && M < info.frontier) counters.mBeforeF++;
        if (exp.length - before.length > 1) counters.gapFill++;
        if (kind === 0) target.budgeted = D(edit.budgeted!);
        if (kind === 1) target.additionalAmountCents = new Prisma.Decimal(edit.add!);
        if (kind === 2) {
          target.payDay = edit.payDay!;
          target.accountId = edit.accountId!;
          if (edit.applyFuture) {
            counters.applyFuture++;
            for (const x of exp) {
              if (x.entityId === e && x.tagId === tagId && mi(x.period) > M) {
                x.payDay = edit.payDay!;
                x.accountId = edit.accountId!;
              }
            }
          }
        }
        // 1. effective views equal the model over a 4-year window for every entity
        const dv = diffViews(snapshotViews(exp), snapshotViews(S.rows));
        expect(dv.slice(0, 5), `seed ${seed} step ${step} kind ${kind} e=${ENTS.indexOf(e)} M=${pm(M)} view diff`).toEqual([]);
        // 2. the stored row set is exactly the expected one (no extra rows, none missing), field by field
        const keyOf = (x: Row) => `${x.entityId}|${x.tagId}|${x.period}`;
        const a = new Map(exp.map((x) => [keyOf(x), JSON.stringify(fields(x, false))]));
        const b = new Map(S.rows.map((x) => [keyOf(x), JSON.stringify(fields(x, false))]));
        expect(S.rows.length, `seed ${seed} step ${step} row count`).toBe(exp.length);
        for (const [k, v] of a) expect(b.get(k), `seed ${seed} step ${step} row ${k}`).toBe(v);
        // 3. every created row has rollover null and additional 0 (except the edited cell)
        for (const x of S.rows) {
          if (before.some((y) => keyOf(y) === keyOf(x))) continue;
          expect(x.rolloverAmount).toBeNull();
          if (!(x.entityId === e && x.tagId === tagId && x.period === pm(M) && kind === 1)) {
            expect(Number(x.additionalAmountCents.toString())).toBe(0);
          }
        }
        // 4. nothing outside the target entity changed
        for (const other of ENTS.filter((x) => x !== e)) {
          expect(S.rows.filter((x) => x.entityId === other).length).toBe(before.filter((x) => x.entityId === other).length);
        }
        // 5. audit: only when rows were created, ids/periods/counts only
        const created = S.rows.length - before.length;
        const newAudit = S.audit.slice(auditBefore);
        if (created === 0) expect(newAudit).toEqual([]);
        else {
          expect(newAudit.length).toBe(1);
          expect(newAudit[0]!.changeType).toBe("budget_materialize");
          const after = newAudit[0]!.after as Record<string, unknown>;
          expect(Object.keys(after).sort()).toEqual(["created", "entityId", "periods", "skipped"]);
          expect(after.created).toBe(created);
          expect(after.entityId).toBe(e);
          expect(JSON.stringify(after)).not.toMatch(/budget|amount|\d+\.\d\d/i);
        }
        // 6. idempotent: the same call again changes nothing
        const snapRows = JSON.stringify(S.rows.map((x) => [keyOf(x), fields(x, false)]).sort());
        const auditN = S.audit.length;
        if (kind === 0) await updateBudgetLine(loc, edit.budgeted!);
        if (kind === 1) await updateBudgetAdditionalAmount(loc, edit.add!);
        if (kind === 2) await updateBudget(loc, { payDay: edit.payDay, accountId: edit.accountId, applyToFuture: edit.applyFuture });
        expect(JSON.stringify(S.rows.map((x) => [keyOf(x), fields(x, false)]).sort())).toBe(snapRows);
        expect(S.audit.length).toBe(auditN);
        // 7. strict-view quirk probe: a view change outside (line, month >= M) other than the intended cell
        const afterViews = snapshotViews(S.rows);
        for (const d of diffViews(viewsBefore, afterViews)) {
          const [ent, per, tag] = d.split(":")[0]!.split("|");
          const isLine = ent === e && tag === tagId;
          if (!isLine) {
            // another line / entity changed: always a defect (only the edited line may differ)
            expect.fail(`seed ${seed} step ${step}: other line changed ${d}`);
          }
          if (mi(per!) < M) expect.fail(`seed ${seed} step ${step}: earlier month changed ${d}`);
          if (mi(per!) > M && info && mi(per!) <= info.frontier && !(kind === 2 && edit.applyFuture)) counters.lineGapFlow++;
        }
      }
    }
    // lineGapFlow = an edit also changed the carried figure of the SAME line in a later month that is inside the saved range
    // but where other lines have rows and this one does not (not row-less, so not frozen). Informational, see the report.
    console.info("TESTER counters " + JSON.stringify(counters));
    // branch coverage guard: the fuzz must have actually exercised each branch
    expect(counters.carriedAtM).toBeGreaterThan(150);
    expect(counters.ownAtM).toBeGreaterThan(150);
    expect(counters.mAfterF).toBeGreaterThan(100);
    expect(counters.mBeforeF).toBeGreaterThan(100);
    expect(counters.gapFill).toBeGreaterThan(50);
    expect(counters.applyFuture).toBeGreaterThan(50);
    // the authoritative-month rule: a line absent from a month that has rows stays absent, so an edit can no longer flow into one
    expect(counters.lineGapFlow).toBe(0);
    expect(counters.staleRefused).toBeGreaterThan(30);
  }, 240_000);

  it("delete ends the line from the month on; nothing earlier and no other line changes; refused when it would empty the latest month", async () => {
    let doneDeletes = 0;
    let midRefusals = 0;
    let conservative = 0;
    let refused = 0;
    let beforeF = 0;
    let atF = 0;
    let afterF = 0;
    let gone = 0;
    for (let seed = 1; seed <= 350; seed++) {
      const r = rng(seed * 104729);
      const world = genWorld(seed + 5000, { gapLines: seed % 2 === 0 });
      setWorld(world);
      for (let step = 0; step < 3; step++) {
        const before = S.rows.map((x) => ({ ...x }));
        const e = ENTS[Math.floor(r() * ENTS.length)]!;
        const info = entityInfo(before, e);
        const lo = info ? info.first - 1 : mi("2026-10");
        const hi = Math.min(info ? info.frontier + 8 : mi("2026-10") + 4, NOW_PERIOD_INDEX + 24);
        const M = lo + Math.floor(r() * (hi - lo + 1));
        const { tagId, inView } = randomLine(r, before, e, M);
        const loc = { entityId: e, tagId, period: pm(M) };
        const viewsBefore = snapshotViews(before);
        const auditBefore = S.audit.length;
        const billsBefore = S.bills.filter((b) => b.kind === "updateMany").length;
        const res = (await deleteBudget(loc)) as { success?: true; removedMonths?: number; error?: string };
        if (!inView) {
          gone++;
          expect(res, `seed ${seed} gone`).toEqual({ success: true, removedMonths: 0 });
          expect(S.rows.length).toBe(before.length);
          expect(S.audit.length).toBe(auditBefore);
          expect(S.bills.filter((b) => b.kind === "updateMany").length).toBeGreaterThanOrEqual(0);
          continue;
        }
        // Owner's words: ending a line removes it from M onward and changes nothing else. The end is possible iff SOME store
        // realises "view before minus this line from M on" (earlier months and other lines identical). I realise it the only
        // way the app can (save every row-less month up to max(M, latest) with the OTHER lines, then drop the line's rows from
        // M on) and compare the views; if they differ the end must be refused (it would change another month).
        const F = info!.frontier;
        const simDel = before.map((x) => ({ ...x }));
        {
          const months = new Set<number>([M]);
          const hasRow = new Set(before.filter((x) => x.entityId === e).map((x) => mi(x.period)));
          for (let p = info!.first; p <= Math.max(M, F); p++) if (!hasRow.has(p)) months.add(p);
          for (const p of months) {
            for (const [t, x] of view(before, e, pm(p))) {
              if (x.src !== "carried" || (t === tagId && p >= M)) continue;
              const src = before.find((r) => r.entityId === e && r.tagId === t && r.period === x.from)!;
              simDel.push({ ...src, id: "sim-" + simDel.length, period: pm(p), additionalAmountCents: new Prisma.Decimal(0), rolloverAmount: null });
            }
          }
        }
        const simAfter = simDel.filter((x) => !(x.entityId === e && x.tagId === tagId && mi(x.period) >= M));
        const strictExp = new Map(viewsBefore);
        for (const k of [...strictExp.keys()]) {
          const [ent, per, tag] = k.split("|");
          if (ent === e && tag === tagId && mi(per!) >= M) strictExp.delete(k);
        }
        const feasible = diffViews(strictExp, snapshotViews(simAfter)).length === 0;
        const offending: string[] = [];
        if (!feasible) for (let p = M; p <= Math.max(M, F); p++) {
          const a = [...view(before, e, pm(p)).keys()].filter((t) => t !== tagId).sort().join(",");
          const b = [...view(simAfter, e, pm(p)).keys()].sort().join(",");
          if (a !== b) offending.push(pm(p));
        }
        // The stated product rule is structural and a little stricter than realisability: ending is refused if it would leave ANY
        // month that holds rows with none (or, for a month after the latest, if no other line would be carried there).
        const mineB = before.filter((x) => x.entityId === e);
        const soleMonths = [...new Set(mineB.map((x) => mi(x.period)))].filter((p) => p >= M && mineB.filter((x) => mi(x.period) === p).every((x) => x.tagId === tagId));
        const noOtherAtTarget = M > F && [...view(before, e, pm(M)).keys()].filter((t) => t !== tagId).length === 0;
        const structural = soleMonths.length > 0 || noOtherAtTarget;
        // never allow a delete that changes another month's view: infeasible must be a subset of structural
        expect(!feasible ? structural : true, `a delete that would change another month must be refused: seed ${seed} step ${step}`).toBe(true);
        if (structural && feasible) conservative++;
        if (structural) {
          refused++;
          if (!feasible) expect(offending.length).toBeGreaterThan(0);
          expect(res.error ?? `NO ERROR ${JSON.stringify({ res, M: pm(M), F: pm(F), offending, seed, step, rows: before.filter((x) => x.entityId === e).map((x) => x.tagId.slice(-2) + "@" + x.period), tag: tagId.slice(-2) })}`, `seed ${seed} step ${step} refusal`).toMatch(/^This is the only line left in /);
          const named = [...soleMonths, ...(noOtherAtTarget ? [M] : [])].map((p) => new Date(Date.UTC(Number(pm(p).slice(0, 4)), Number(pm(p).slice(5, 7)) - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }));
          expect(named.some((l) => (res.error ?? "").includes(l)), `message names an offending month: ${res.error} vs ${named.join("|")}`).toBe(true);
          if (soleMonths.some((p) => p < Math.max(M, F))) midRefusals++;
          expect(S.rows.length).toBe(before.length);
          expect(snapshotViews(S.rows)).toEqual(viewsBefore);
          expect(S.audit.length).toBe(auditBefore);
          expect(S.bills.filter((b) => b.kind === "updateMany").length).toBe(billsBefore);
          continue;
        }
        expect(res.success, `seed ${seed} step ${step} ${JSON.stringify(res)} M=${pm(M)} F=${pm(F)} tag=${tagId.slice(-2)} rows=${before.filter((x) => x.entityId === e).map((x) => x.tagId.slice(-2) + "@" + x.period).sort().join(" ")}`).toBe(true);
        doneDeletes++;
        if (M < F) beforeF++;
        else if (M === F) atF++;
        else afterF++;
        // expected: before-view minus (line, months >= M)
        const exp = new Map(viewsBefore);
        for (const k of [...exp.keys()]) {
          const [ent, per, tag] = k.split("|");
          if (ent === e && tag === tagId && mi(per!) >= M) exp.delete(k);
        }
        const after = snapshotViews(S.rows);
        expect(diffViews(exp, after).slice(0, 5), `seed ${seed} step ${step} M=${pm(M)} F=${pm(F)} delete view diff`).toEqual([]);
        // the line has no row at or after M
        expect(S.rows.some((x) => x.entityId === e && x.tagId === tagId && mi(x.period) >= M)).toBe(false);
        // other entities untouched
        for (const other of ENTS.filter((x) => x !== e)) {
          expect(JSON.stringify(S.rows.filter((x) => x.entityId === other).map((x) => x.id).sort())).toBe(
            JSON.stringify(before.filter((x) => x.entityId === other).map((x) => x.id).sort())
          );
        }
        // bill deactivated for this tag+entity
        expect(S.bills.some((b) => b.kind === "updateMany" && b.budgetTagId === tagId && b.budgetEntityId === e && b.active === false)).toBe(true);
        // audit rows: ids/counts only
        for (const a of S.audit.slice(auditBefore)) {
          expect(["budget_materialize", "budget_end_line"]).toContain(a.changeType);
          expect(JSON.stringify(a.after)).not.toMatch(/budget"|amount|\d+\.\d\d/i);
        }
        const endAudit = S.audit.slice(auditBefore).filter((a) => a.changeType === "budget_end_line");
        expect(endAudit.length).toBe(1);
        expect(Object.keys(endAudit[0]!.after as object).sort()).toEqual(["deletedRows", "entityId", "fromPeriod", "tagId"]);
        // the audit counts are TRUE: rows of the line at or after the month, as they stood before the call
        expect(endAudit[0]!.after).toEqual({
          entityId: e,
          tagId,
          fromPeriod: pm(M),
          deletedRows: before.filter((x) => x.entityId === e && x.tagId === tagId && mi(x.period) >= M).length,
        });
        // removedMonths = rows removed + 1 when the line was only carried in that month
        const wasOwn = view(before, e, pm(M)).get(tagId)!.src === "own";
        expect(res.removedMonths).toBe(before.filter((x) => x.entityId === e && x.tagId === tagId && mi(x.period) >= M).length + (wasOwn ? 0 : 1));
        // second delete is a no-op success
        const n = S.rows.length;
        const again = await deleteBudget(loc);
        expect(again).toEqual({ success: true, removedMonths: 0 });
        expect(S.rows.length).toBe(n);
      }
    }
    expect(doneDeletes).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(10);
    console.info("TESTER delete fuzz: refusals " + refused + ", of which stricter than strictly necessary " + conservative);
    expect(midRefusals).toBeGreaterThan(3); // a middle month holding only this line also refuses
    expect(beforeF).toBeGreaterThan(80);
    expect(atF).toBeGreaterThan(30);
    expect(afterF).toBeGreaterThan(80);
    expect(gone).toBeGreaterThan(20);
  }, 240_000);

  it("createBudget: household tag rule over the EFFECTIVE view, materialize-then-create, tag held elsewhere refused without writes", async () => {
    let created = 0;
    let guardRefused = 0;
    let conflictSame = 0;
    let conflictOther = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed * 31337);
      setWorld(genWorld(seed + 9000, { gapLines: seed % 2 === 0 }));
      for (let step = 0; step < 5; step++) {
        const before = S.rows.map((x) => ({ ...x }));
        const e = ENTS[Math.floor(r() * ENTS.length)]!;
        const info = entityInfo(before, e);
        const lo = info ? info.first - 2 : mi("2026-10");
        const hi = Math.min(info ? info.frontier + 8 : mi("2026-10") + 4, NOW_PERIOD_INDEX + 24);
        const M = lo + Math.floor(r() * (hi - lo + 1));
        const tagId = ALL_TAGS[Math.floor(r() * ALL_TAGS.length)]!;
        const holders = ENTS.filter((x) => view(before, x, pm(M)).has(tagId));
        const auditBefore = S.audit.length;
        const res = (await createBudget({ tagId, entityId: e, accountId: ACCTS[0]!, period: pm(M), budgeted: "77.00" })) as { success?: true; error?: string };
        if (holders.length) {
          expect(S.rows.length, `seed ${seed} refused leaves no write`).toBe(before.length);
          expect(S.audit.length).toBe(auditBefore);
          if (holders.includes(e)) {
            conflictSame++;
            expect(res.error).toBe("This tag already has a budget line this period.");
          } else {
            conflictOther++;
            expect(res.error).toBe(`This tag already has a budget line under ${S.entities[holders[0]!]} this period.`);
          }
          continue;
        }
        // Owner's words: adding a line must change no earlier month. Simulate the add (fills + the new row) with MY view and
        // look for the earliest earlier month whose line set differs; if there is one the add must be refused, naming it.
        const sim = expectedFilled(before, e, M);
        sim.push(mk({ entityId: e, tagId, period: pm(M), budgeted: D("77.00") }));
        let firstChanged: number | null = null;
        for (let p = WINDOW_FROM; p < M && firstChanged === null; p++) {
          const a = [...view(before, e, pm(p)).keys()].sort().join(",");
          const b = [...view(sim, e, pm(p)).keys()].sort().join(",");
          if (a !== b) firstChanged = p;
        }
        if (firstChanged !== null) {
          guardRefused++;
          const label = new Date(Date.UTC(Number(pm(firstChanged).slice(0, 4)), Number(pm(firstChanged).slice(5, 7)) - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
          expect(res.error, `seed ${seed} step ${step} re-add guard M=${pm(M)} earliest=${pm(firstChanged)}`).toContain(label);
          expect(res.error).toMatch(/^Adding this line here would also make it appear in /);
          expect(S.rows.length).toBe(before.length);
          expect(S.audit.length).toBe(auditBefore);
          continue;
        }
        expect(res.success, `seed ${seed} step ${step} ${JSON.stringify(res)}`).toBe(true);
        created++;
        const exp = sim;
        expect(diffViews(snapshotViews(exp), snapshotViews(S.rows)).slice(0, 5), `seed ${seed} step ${step} create view diff M=${pm(M)}`).toEqual([]);
        expect(S.rows.length).toBe(exp.length);
      }
    }
    expect(created).toBeGreaterThan(300);
    expect(guardRefused).toBeGreaterThan(0);
    console.info("TESTER create fuzz: created " + created + ", re-add guard refusals " + guardRefused);
    expect(conflictSame).toBeGreaterThan(20);
    expect(conflictOther).toBeGreaterThan(20);
  }, 240_000);
});

describe("TESTER: re-add guard on worlds built to trigger it (entity-level empty months, ended lines)", () => {
  it("400 crafted worlds x 5 adds: refused exactly when my simulation says an earlier month would change, message names the earliest, nothing written on refusal", async () => {
    let refused = 0;
    let accepted = 0;
    let reAddOld = 0;
    let followUps = 0;
    let followDone = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed * 7001);
      const e = ENTS[0]!;
      const tags = TAGS_BY_ENT[0]!; // 5 tags
      const base = mi("2026-02");
      const k = Math.floor(r() * 3); // old lines live base..base+k
      const gap = 1 + Math.floor(r() * 3); // entity-level empty months
      const startNew = base + k + 1 + gap;
      const F = startNew + Math.floor(r() * 3);
      const rows: Row[] = [];
      for (let i = base; i <= base + k; i++) for (const t of [tags[0]!, tags[1]!]) if (i === base || r() < 0.8) rows.push(mk({ entityId: e, tagId: t, period: pm(i) }));
      for (let i = startNew; i <= F; i++) for (const t of [tags[2]!, tags[3]!]) rows.push(mk({ entityId: e, tagId: t, period: pm(i) }));
      setWorld(rows);
      for (let step = 0; step < 5; step++) {
        const before = S.rows.map((x) => ({ ...x }));
        const M = base + Math.floor(r() * (F + 6 - base + 1));
        const tagId = tags[Math.floor(r() * tags.length)]!;
        if (view(before, e, pm(M)).has(tagId)) continue;
        const auditBefore = S.audit.length;
        const res = (await createBudget({ tagId, entityId: e, accountId: ACCTS[0]!, period: pm(M), budgeted: "9.00" })) as { success?: true; error?: string };
        const sim = expectedFilled(before, e, M);
        sim.push(mk({ entityId: e, tagId, period: pm(M), budgeted: D("9.00") }));
        let firstChanged: number | null = null;
        for (let p = WINDOW_FROM; p < M && firstChanged === null; p++) {
          if ([...view(before, e, pm(p)).keys()].sort().join(",") !== [...view(sim, e, pm(p)).keys()].sort().join(",")) firstChanged = p;
        }
        if (firstChanged !== null) {
          refused++;
          if (before.some((x) => x.tagId === tagId)) reAddOld++;
          const label = new Date(Date.UTC(Number(pm(firstChanged).slice(0, 4)), Number(pm(firstChanged).slice(5, 7)) - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
          expect(res.error, `seed ${seed} M=${pm(M)} tag=${tagId.slice(-2)} earliest=${pm(firstChanged)}`).toContain(label);
          expect(res.error).toMatch(/Add it to that month first, or choose that month instead.$/);
          expect(S.rows.length).toBe(before.length);
          expect(S.audit.length).toBe(auditBefore);
          // the advice works: add the line to the named month first, then (month by month if several) to the wanted month
          if (followUps < 60) {
            followUps++;
            let guardErr: string | undefined = res.error;
            let hops = 0;
            while (guardErr && hops < 6) {
              hops++;
              const named = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48].map((d) => WINDOW_FROM + d).find((p) => guardErr!.includes(new Date(Date.UTC(Number(pm(p).slice(0, 4)), Number(pm(p).slice(5, 7)) - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })));
              expect(named, "message names a month").toBeDefined();
              const step1 = (await createBudget({ tagId, entityId: e, accountId: ACCTS[0]!, period: pm(named!), budgeted: "9.00" })) as { success?: true; error?: string };
              expect(step1.success, `advice step failed: ${JSON.stringify(step1)}`).toBe(true);
              const again = (await createBudget({ tagId, entityId: e, accountId: ACCTS[0]!, period: pm(M), budgeted: "9.00" })) as { success?: true; error?: string };
              guardErr = again.error;
              if (!guardErr) expect(again.success).toBe(true);
            }
            expect(guardErr, "the advice eventually leads to a successful add").toBeUndefined();
            followDone++;
          }
        } else {
          accepted++;
          expect(res.success, `seed ${seed} M=${pm(M)} tag=${tagId.slice(-2)} ${JSON.stringify(res)}`).toBe(true);
          // and really: no earlier month changed
          expect(diffViews(snapshotViews(before), snapshotViews(S.rows)).filter((d) => mi(d.split(":")[0]!.split("|")[1]!) < M)).toEqual([]);
        }
      }
    }
    console.info(`TESTER guard fuzz: refused ${refused} (re-adds of old tags ${reAddOld}), accepted ${accepted}`);
    expect(followDone).toBe(followUps);
    expect(refused).toBeGreaterThan(50);
    expect(accepted).toBeGreaterThan(200);
  }, 120_000);
});

describe("TESTER: mixed sequences, generic never-changes-another-month invariant", () => {
  it("300 worlds x 14 random writes (edit, modal, buffer, add, end): a successful write never changes another entity, another line, or any month before the edited one; a refusal writes nothing", async () => {
    let ok = 0;
    let refused = 0;
    const byKind: Record<string, number> = {};
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 6007);
      setWorld(genWorld(seed + 20000, { gapLines: seed % 2 === 0 }));
      for (let step = 0; step < 14; step++) {
        const before = S.rows.map((x) => ({ ...x }));
        const vb = snapshotViews(before);
        const e = ENTS[Math.floor(r() * ENTS.length)]!;
        const info = entityInfo(before, e);
        const lo = info ? info.first - 2 : mi("2026-10");
        const hi = Math.min(info ? info.frontier + 8 : mi("2026-10") + 4, NOW_PERIOD_INDEX + 24);
        const M = lo + Math.floor(r() * (hi - lo + 1));
        const { tagId } = randomLine(r, before, e, M);
        const loc = { entityId: e, tagId, period: pm(M) };
        const kind = ["line", "modal", "buffer", "add", "end"][Math.floor(r() * 5)]!;
        let res: { success?: true; error?: string };
        let applyFuture = false;
        const addTag = ALL_TAGS[Math.floor(r() * ALL_TAGS.length)]!;
        if (kind === "line") res = await updateBudgetLine(loc, "123.00");
        else if (kind === "modal") {
          applyFuture = r() < 0.5;
          res = await updateBudget(loc, { payDay: 9, accountId: ACCTS[1]!, applyToFuture: applyFuture });
        } else if (kind === "buffer") res = await updateBudgetAdditionalAmount(loc, 700);
        else if (kind === "add") res = await createBudget({ tagId: addTag, entityId: e, accountId: ACCTS[0]!, period: pm(M), budgeted: "5.00" });
        else res = await deleteBudget(loc);
        const after = snapshotViews(S.rows);
        const target = kind === "add" ? addTag : tagId;
        if (res.error) {
          refused++;
          expect(JSON.stringify(S.rows.map((x) => x.id))).toBe(JSON.stringify(before.map((x) => x.id)));
          expect(after).toEqual(vb);
          continue;
        }
        ok++;
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        for (const d of diffViews(vb, after)) {
          const [ent, per, tag] = d.split(":")[0]!.split("|");
          const where = `seed ${seed} step ${step} ${kind} M=${pm(M)} ${d.slice(0, 160)}`;
          expect(ent, where).toBe(e); // never another entity
          expect(tag, where).toBe(target); // never another line
          expect(mi(per!), where).toBeGreaterThanOrEqual(M); // never an earlier month
        }
      }
    }
    console.info("TESTER mixed sequences " + JSON.stringify({ ok, refused, byKind }));
    expect(ok).toBeGreaterThan(1500);
    expect(refused).toBeGreaterThan(100);
  }, 240_000);
});

describe("TESTER: the counts the owner is told BEFORE a change equal what the change does", () => {
  it("first-edit month count (notice, dashboard note) == distinct months the write creates; end-line count == rows the write removes", async () => {
    let edits = 0;
    let multi = 0;
    let ends = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 9109);
      setWorld(genWorld(seed + 30000, { gapLines: seed % 2 === 0 }));
      for (let step = 0; step < 3; step++) {
        const before = S.rows.map((x) => ({ ...x }));
        const e = ENTS[Math.floor(r() * ENTS.length)]!;
        const info = entityInfo(before, e);
        if (!info) continue;
        const M = info.first + Math.floor(r() * (info.frontier - info.first + 9));
        if (M > NOW_PERIOD_INDEX + 24) continue;
        const v = view(before, e, pm(M));
        const tags = [...v.keys()];
        if (tags.length === 0) continue;
        const tagId = tags[Math.floor(r() * tags.length)]!;
        const ctx = await loadFirstEditContext({ period: pm(M) });
        if (r() < 0.6) {
          const told = ctx.saveMonths[e] ?? [];
          const res = await updateBudgetLine({ entityId: e, tagId, period: pm(M) }, "50.00");
          expect(res).toEqual({ success: true });
          const created = new Set(S.rows.filter((x) => x.entityId === e && !before.some((b) => b.id === x.id)).map((x) => x.period));
          expect([...created].sort(), `seed ${seed} step ${step} told ${told.join(",")}`).toEqual([...told].sort());
          edits++;
          if (told.length > 1) multi++;
          // the wording is built from the same list
          const row = [...v.entries()].filter(([, x]) => x.src === "carried").map(([, x]) => ({ source: "carried" as const, carriedFrom: x.from, entityId: e, entityName: "E" }))[0];
          if (row && v.get(tagId)) {
            const text = carriedMonthNotice([row], ctx.saveMonths);
            if (told.length > 1) expect(text).toContain(`saved for ${told.length} months`);
            else expect(text).toContain("the whole list is saved for this month.");
          }
        } else {
          const key = `${e}|${tagId}`;
          const later = ctx.laterSavedMonths[key] ?? 0;
          const wasOwn = v.get(tagId)!.src === "own";
          const mineBefore = before.filter((x) => x.entityId === e && x.tagId === tagId && mi(x.period) >= M).length;
          const res = (await deleteBudget({ entityId: e, tagId, period: pm(M) })) as { success?: true; removedMonths?: number; error?: string };
          if (res.error) continue; // refusal: nothing to compare
          ends++;
          // "removes the line from <month> and the N later months that already have it": N == rows after M that the line had
          expect(later, `seed ${seed} step ${step}`).toBe(before.filter((x) => x.entityId === e && x.tagId === tagId && mi(x.period) > M).length);
          expect(res.removedMonths).toBe(later + 1);
          expect(mineBefore).toBe(later + (wasOwn ? 1 : 0));
        }
      }
    }
    console.info("TESTER counts: edits " + edits + " (multi-month " + multi + "), ends " + ends);
    expect(edits).toBeGreaterThan(100);
    expect(multi).toBeGreaterThan(20);
    expect(ends).toBeGreaterThan(40);
  }, 120_000);
});

describe("TESTER: transaction shape, auth, locator contract, concurrency", () => {
  const E = ENTS[0]!;
  const T0 = TAGS_BY_ENT[0]![0]!;
  const T1 = TAGS_BY_ENT[0]![1]!;
  const world = () => [
    mk({ entityId: E, tagId: T0, period: "2026-12", budgeted: D("100.00"), payDay: 3 }),
    mk({ entityId: E, tagId: T1, period: "2026-12", budgeted: D("200.00") }),
  ];

  it("every export: auth first, one interactive transaction whose FIRST operation is the advisory lock, createMany skipDuplicates", async () => {
    setWorld(world());
    await updateBudgetLine({ entityId: E, tagId: T0, period: "2027-03" }, "5.00");
    const log = S.txLog[0]!;
    expect(log[0]).toBe("lock:SELECT pg_advisory_xact_lock(hashtext(?)):budget-write");
    // a big first edit (hundreds of rows over a pooled connection) needs more than Prisma's 2 s maxWait / 5 s timeout defaults
    const opts = S.txOpts[0] as { maxWait?: number; timeout?: number } | undefined;
    expect(opts?.maxWait ?? 0).toBeGreaterThanOrEqual(10_000);
    expect(opts?.timeout ?? 0).toBeGreaterThanOrEqual(15_000);
    expect(log[1]).toBe("budget.findMany");
    expect(log).toContain("budget.createMany:skip");
    expect(log).not.toContain("budget.createMany:noskip");
    expect(S.txLog.length).toBe(1);
    // unauthenticated: rejects and opens no transaction
    setWorld(world());
    S.session = null;
    const loc = { entityId: E, tagId: T0, period: "2027-03" };
    await expect(updateBudgetLine(loc, "1")).rejects.toThrow("Unauthorized");
    await expect(updateBudget(loc, {})).rejects.toThrow("Unauthorized");
    await expect(updateBudgetAdditionalAmount(loc, 1)).rejects.toThrow("Unauthorized");
    await expect(deleteBudget(loc)).rejects.toThrow("Unauthorized");
    await expect(createBudget({ tagId: T0, entityId: E, accountId: ACCTS[0]!, period: "2027-03", budgeted: "1" })).rejects.toThrow("Unauthorized");
    expect(S.txLog.length).toBe(0);
    // a session without an id is also refused
    S.session = { user: {} } as never;
    await expect(deleteBudget(loc)).rejects.toThrow("Unauthorized");
  });

  it("a Budget id / synthetic carried id / bad period never reaches the database", async () => {
    setWorld(world());
    const bad = [
      "carried:abc:2027-01",
      "id-1",
      { entityId: E, tagId: "carried:abc:2027-01", period: "2027-01" },
      { entityId: E, tagId: T0, period: "2027-13" },
      { entityId: E, tagId: T0, period: "2027-1" },
      { entityId: E, tagId: T0, period: "2027-01 " },
      { entityId: "not-a-uuid", tagId: T0, period: "2027-01" },
      { tagId: T0, period: "2027-01" },
      null,
      undefined,
    ];
    for (const b of bad) {
      for (const res of [
        await updateBudgetLine(b as never, "1"),
        await updateBudget(b as never, {}),
        await updateBudgetAdditionalAmount(b as never, 1),
        await deleteBudget(b as never),
      ]) {
        expect(res).toEqual({ error: "Invalid budget line" });
      }
    }
    expect(S.txLog.length).toBe(0);
    expect(S.rows.length).toBe(2);
  });

  it("writes more than 24 months after the current NY month are refused before any transaction; exactly +24 is allowed", async () => {
    setWorld(world());
    const loc = (p: string) => ({ entityId: E, tagId: T0, period: p });
    expect(await updateBudgetLine(loc("2028-11"), "1")).toEqual({ error: "That month is too far ahead to edit yet." });
    expect(await deleteBudget(loc("2028-11"))).toEqual({ error: "That month is too far ahead to edit yet." });
    expect(await updateBudgetAdditionalAmount(loc("2029-01"), 1)).toEqual({ error: "That month is too far ahead to edit yet." });
    expect(await updateBudget(loc("2028-11"), { payDay: 2 })).toEqual({ error: "That month is too far ahead to edit yet." });
    expect(await createBudget({ tagId: ALL_TAGS[9]!, entityId: E, accountId: ACCTS[0]!, period: "2028-11", budgeted: "1" })).toEqual({ error: "That month is too far ahead to edit yet." });
    expect(S.txLog.length).toBe(0);
    const ok = await updateBudgetLine(loc("2028-10"), "1.00");
    expect(ok).toEqual({ success: true });
    expect(S.rows.filter((r) => r.entityId === E).length).toBe(2 + 2 * 22); // 2026-12 ... fills 2027-01..2028-10 = 22 months x 2 lines
  });

  it("NY month boundary: late on the 31st in New York is already the next UTC month, the limit follows New York", async () => {
    setWorld(world());
    // 2026-10-31 23:30 NY = 2026-11-01 03:30 UTC -> current NY month is still 2026-10 -> limit 2028-10
    vi.setSystemTime(new Date("2026-11-01T03:30:00Z"));
    expect(await updateBudgetLine({ entityId: E, tagId: T0, period: "2028-11" }, "1")).toEqual({ error: "That month is too far ahead to edit yet." });
    vi.setSystemTime(new Date("2026-11-01T05:30:00Z")); // now NY is November -> 2028-11 allowed
    expect(await updateBudgetLine({ entityId: E, tagId: T0, period: "2028-11" }, "1")).toEqual({ success: true });
  });

  it("failure after the carried set was saved rolls the copy back (nothing, not even the audit row, is kept)", async () => {
    for (const failOn of ["budget.update", "budget.findUnique", "budget.createMany:skip"]) {
      setWorld(world());
      S.failOn = failOn;
      const before = JSON.stringify(S.rows.map((r) => r.id));
      await expect(updateBudgetLine({ entityId: E, tagId: T0, period: "2027-02" }, "9.00")).rejects.toThrow(/injected/);
      expect(JSON.stringify(S.rows.map((r) => r.id))).toBe(before);
      expect(S.audit).toEqual([]);
    }
    // delete: failing at the deleteMany leaves the saved gap months out too
    setWorld(world());
    S.failOn = "budget.deleteMany";
    await expect(deleteBudget({ entityId: E, tagId: T0, period: "2026-12" })).rejects.toThrow(/injected/);
    expect(S.rows.length).toBe(2);
    expect(S.audit).toEqual([]);
    expect(S.bills).toEqual([]);
  });

  it("two tabs / double click: concurrent identical and conflicting calls serialize on the lock and end exactly like the sequential result", async () => {
    // identical edit twice at once
    setWorld(world());
    const loc = { entityId: E, tagId: T0, period: "2027-03" };
    const [a, b] = await Promise.all([updateBudgetLine(loc, "55.00"), updateBudgetLine(loc, "55.00")]);
    expect(a).toEqual({ success: true });
    expect(b).toEqual({ success: true });
    expect(S.rows.filter((r) => r.entityId === E).length).toBe(2 * 4); // 2026-12 + 2027-01..03 for two lines
    expect(S.audit.filter((x) => x.changeType === "budget_materialize").length).toBe(1);
    const keys = S.rows.map((r) => `${r.entityId}|${r.tagId}|${r.period}`);
    expect(new Set(keys).size).toBe(keys.length);

    // an edit in 2027-03 racing a delete of the same line in 2027-02, both orders
    const results: string[] = [];
    for (const order of [0, 1]) {
      setWorld(world());
      const edit = () => updateBudgetLine({ entityId: E, tagId: T0, period: "2027-03" }, "66.00");
      const del = () => deleteBudget({ entityId: E, tagId: T0, period: "2027-02" });
      const [x, y] = order === 0 ? await Promise.all([edit(), del()]) : (await Promise.all([del(), edit()])).reverse();
      const sig = JSON.stringify([x, y, S.rows.filter((r) => r.entityId === E).map((r) => `${r.tagId.slice(-2)}@${r.period}`).sort()]);
      results.push(sig);
      const k = S.rows.map((r) => `${r.entityId}|${r.tagId}|${r.period}`);
      expect(new Set(k).size).toBe(k.length);
      // the end state is one of the two serial orders, never a mix
      // serial A: edit then delete -> T0 rows 2026-12, 2027-01 remain; serial B: delete (2027-02 ends T0) then edit refused (stale)
      const t0 = S.rows.filter((r) => r.tagId === T0).map((r) => r.period).sort();
      expect(t0).toEqual(["2026-12", "2027-01"]);
    }
    // without the lock the very same race must be detectably different or at least not crash silently: the mutation check lives in the mutation runner
    expect(results.length).toBe(2);
  });
});

describe("TESTER: negative control for the concurrency harness (lock disabled in the FAKE, real actions)", () => {
  const E = ENTS[0]!;
  const T0 = TAGS_BY_ENT[0]![0]!;
  const T1 = TAGS_BY_ENT[0]![1]!;
  const world = () => [
    mk({ entityId: E, tagId: T0, period: "2026-12", budgeted: D("100.00") }),
    mk({ entityId: E, tagId: T1, period: "2026-12", budgeted: D("200.00") }),
  ];
  const sig = () => JSON.stringify(S.rows.filter((r) => r.entityId === E).map((r) => `${r.tagId.slice(-2)}@${r.period}`).sort());

  it("with the lock the end state of an edit racing a delete equals a serial order; without it the harness can see a different end state or an error", async () => {
    const edit = () => updateBudgetLine({ entityId: E, tagId: T0, period: "2027-03" }, "66.00");
    const del = () => deleteBudget({ entityId: E, tagId: T0, period: "2027-02" });
    const serial: string[] = [];
    for (const order of [0, 1]) {
      setWorld(world());
      if (order === 0) {
        await edit();
        await del();
      } else {
        await del();
        await edit();
      }
      serial.push(sig());
    }
    setWorld(world());
    await Promise.all([edit(), del()]);
    expect(serial).toContain(sig());

    // negative control: same race, lock off in the fake
    setWorld(world());
    S.locking = false;
    let anomaly = false;
    try {
      await Promise.all([edit(), del()]);
      if (!serial.includes(sig())) anomaly = true;
    } catch {
      anomaly = true;
    }
    S.locking = true;
    console.info("TESTER negative control anomaly seen without lock: " + anomaly);
    expect(anomaly, "the harness must be able to see the race when the lock is off").toBe(true);
  });
});

describe("TESTER defect probe: re-adding an ended line must not bring it back in the months in between", () => {
  const E = ENTS[0]!;
  const [A, B, OLD] = [TAGS_BY_ENT[0]![0]!, TAGS_BY_ENT[0]![1]!, TAGS_BY_ENT[0]![2]!];
  const world = () => [
    mk({ entityId: E, tagId: OLD, period: "2026-10", budgeted: D("33.00") }),
    mk({ entityId: E, tagId: A, period: "2026-10", budgeted: D("100.00") }),
    mk({ entityId: E, tagId: A, period: "2026-11", budgeted: D("100.00") }),
    mk({ entityId: E, tagId: B, period: "2026-11", budgeted: D("200.00") }),
    mk({ entityId: E, tagId: A, period: "2026-12", budgeted: D("100.00") }),
    mk({ entityId: E, tagId: B, period: "2026-12", budgeted: D("200.00") }),
  ];

  it("repro facts: OLD ended after 2026-10, so 2026-11 and 2026-12 do not show it", () => {
    setWorld(world());
    for (const m of ["2026-11", "2026-12"]) expect([...view(S.rows, E, m).keys()].sort()).toEqual([A, B].sort());
  });

  // D1 (fixed in round 1 by the authoritative-month rule, the it.fails probe is flipped): createBudget(OLD, 2027-01) makes OLD
  // the entity's latest-month line again; the months that have rows (2026-11, 2026-12) no longer carry it into themselves.
  it("createBudget of an ended tag leaves every earlier month's effective view unchanged", async () => {
    setWorld(world());
    const before = snapshotViews(S.rows);
    const res = await createBudget({ tagId: OLD, entityId: E, accountId: ACCTS[0]!, period: "2027-01", budgeted: "40.00" });
    expect(res).toEqual({ success: true });
    const changedEarlier = diffViews(before, snapshotViews(S.rows)).filter((d) => mi(d.split(":")[0]!.split("|")[1]!) < mi("2027-01"));
    console.info("TESTER probe earlier-month changes: " + JSON.stringify(changedEarlier));
    expect(changedEarlier).toEqual([]);
    // the Tester's repro, stated directly: 2026-11 and 2026-12 still show only A and B; OLD shows from 2027-01 on
    for (const m of ["2026-11", "2026-12"]) expect([...view(S.rows, E, m).keys()].sort()).toEqual([A, B].sort());
    for (const m of ["2027-01", "2027-02", "2028-06"]) expect(view(S.rows, E, m).has(OLD)).toBe(true);
    expect(view(S.rows, E, "2026-10").has(OLD)).toBe(true); // its own old row is untouched
  });
});
