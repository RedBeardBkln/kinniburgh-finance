// TESTER (utility-usage-upload): end-to-end behaviour of the REAL actions + REAL store + REAL loader over my own in-memory
// fake of the UtilityUsage table (unique liveKey over every row, transactional rollback, select-honouring reads). Idempotent
// re-upload, archive / re-add through liveKey, replace chains, two racing saves, entity separation through the loader and the
// site builder, preview == save, audit / log leak checks, fail-soft when the table is missing. No database is touched.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

interface Row {
  id: string; entityId: string; kind: string; period: string; occurredOn: Date; quantity: string; unit: string;
  costCents: number | null; note: string | null; source: string; importBatchId: string | null; liveKey: string | null;
  createdById: string | null; createdAt: Date; archivedAt: Date | null; archivedById: string | null;
}

const h = vi.hoisted(() => ({
  table: { rows: [] as unknown[], seq: 0, throwOn: null as null | { op: string; err: Error } },
  auth: vi.fn(),
  lines: vi.fn(),
  audit: vi.fn(),
  entityFind: vi.fn(),
  reval: vi.fn(),
  calls: [] as string[],
  ref: { db: null as unknown as Record<string, unknown> },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.reval }));
vi.mock("@/lib/seasonal-energy-build", () => ({ loadSeasonalLines: h.lines }));

function rowsOf() { return h.table.rows as Row[]; }
function match(r: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    const val = (r as unknown as Record<string, unknown>)[k];
    if (v !== null && typeof v === "object" && "in" in (v as object)) { if (!((v as { in: unknown[] }).in).includes(val)) return false; }
    else if (v === null) { if (val !== null) return false; }
    else if (val !== v) return false;
  }
  return true;
}
function maybeThrow(op: string) {
  const t = h.table.throwOn;
  if (t && t.op === op) throw t.err;
}
const util = {
  findMany: async (q: { where: Record<string, unknown>; take?: number; orderBy?: unknown; select?: Record<string, true> }) => {
    h.calls.push("findMany");
    maybeThrow("findMany");
    const rs = rowsOf().filter((r) => match(r, q.where)).sort((a, b) => (a.period + a.occurredOn.toISOString() < b.period + b.occurredOn.toISOString() ? -1 : 1)).slice(0, q.take ?? 1e9);
    return rs.map((r) => (q.select ? Object.fromEntries(Object.keys(q.select).map((k) => [k, (r as unknown as Record<string, unknown>)[k]])) : { ...r }));
  },
  findFirst: async (q: { where: Record<string, unknown> }) => {
    h.calls.push("findFirst");
    const r = rowsOf().find((x) => match(x, q.where));
    return r ? { ...r } : null;
  },
  updateMany: async (q: { where: Record<string, unknown>; data: Partial<Row> }) => {
    h.calls.push("updateMany");
    maybeThrow("updateMany");
    const hit = rowsOf().filter((r) => match(r, q.where));
    for (const r of hit) Object.assign(r, q.data);
    return { count: hit.length };
  },
  createMany: async (q: { data: Array<Partial<Row> & { liveKey?: string | null }> }) => {
    h.calls.push("createMany");
    maybeThrow("createMany");
    for (const d of q.data) {
      if (d.liveKey && rowsOf().some((r) => r.liveKey === d.liveKey)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "t" });
      }
      h.table.seq += 1;
      rowsOf().push({ id: `00000000-0000-4000-8000-${String(h.table.seq).padStart(12, "0")}`, createdAt: new Date(), archivedAt: null, archivedById: null, importBatchId: null, createdById: null, note: null, costCents: null, liveKey: null, ...d } as Row);
    }
    return { count: q.data.length };
  },
  // The module under test must never call these. A call is recorded and the test below fails.
  delete: async () => { h.calls.push("delete"); throw new Error("delete called"); },
  deleteMany: async () => { h.calls.push("deleteMany"); throw new Error("deleteMany called"); },
  upsert: async () => { h.calls.push("upsert"); throw new Error("upsert called"); },
  update: async () => { h.calls.push("update"); throw new Error("update called"); },
  create: async () => { h.calls.push("create"); throw new Error("create called"); },
};
const fakeDb = {
  entity: { findFirst: (q: unknown) => h.entityFind(q) },
  auditLog: { create: (a: unknown) => h.audit(a) },
  utilityUsage: util,
  // Isolation-aware rollback: only THIS transaction's own writes are undone (an undo log), never another tab's commit.
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    h.calls.push("tx");
    const undo: Array<() => void> = [];
    const tx = {
      ...fakeDb,
      utilityUsage: {
        ...util,
        updateMany: async (q: { where: Record<string, unknown>; data: Partial<Row> }) => {
          const before = rowsOf().filter((r) => match(r, q.where)).map((r) => ({ r, old: { ...r } }));
          const res = await util.updateMany(q);
          undo.push(() => before.forEach(({ r, old }) => Object.assign(r, old)));
          return res;
        },
        createMany: async (q: { data: Array<Partial<Row> & { liveKey?: string | null }> }) => {
          const n0 = rowsOf().length;
          try {
            return await util.createMany(q);
          } finally {
            const added = rowsOf().slice(n0);
            undo.push(() => { h.table.rows = rowsOf().filter((r) => !added.includes(r)); });
          }
        },
      },
    };
    try { return await fn(tx); } catch (e) { for (const u of undo.reverse()) u(); throw e; }
  },
};
h.ref.db = fakeDb as unknown as Record<string, unknown>;
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: (_t, k) => h.ref.db[k as string] }) }));

import { addUtilityUsageMonth, archiveUtilityUsage, previewUtilityUsage, saveUtilityUsage } from "@/actions/utility-usage";
import { loadUtilityUsage } from "@/lib/utility-usage-build";
import { CHANGED_IN_ANOTHER_TAB } from "@/lib/utility-usage-store";
import { buildSiteEnergy } from "@/lib/seasonal-energy";

const P = "6f55fa50-9d94-47a8-92d6-2cc5abeac714";
const SV = "73edfe3c-f043-4f73-a8ab-3de6591d29d4";
const EK = "11111111-2222-4333-8444-555555555555";
const MAP = ["month", "quantity", "cost", "note"] as const;
const live = () => rowsOf().filter((r) => r.archivedAt === null);

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-10T16:00:00Z")); });
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  vi.clearAllMocks();
  h.table.rows = []; h.table.seq = 0; h.table.throwOn = null; h.calls.length = 0;
  h.auth.mockResolvedValue({ user: { id: "owner-1" } });
  h.audit.mockResolvedValue({});
  h.entityFind.mockImplementation(async (q: { where: { id: string } }) => (q.where.id === P ? { id: P, slug: "personal" } : q.where.id === SV ? { id: SV, slug: "sudden-valley" } : q.where.id === EK ? { id: EK, slug: "ek-consulting" } : null));
  h.lines.mockResolvedValue([
    { entityId: P, tagId: "t1", tagName: "Utilities / Electric (Eversource)", kind: "electric" },
    { entityId: P, tagId: "t2", tagName: "Utilities / Oil", kind: "oil" },
    { entityId: SV, tagId: "t3", tagName: "Arbor Retreat / Electricity", kind: "electric" },
    { entityId: SV, tagId: "t4", tagName: "Arbor Retreat / Firewood", kind: "firewood" },
  ]);
});

const FILE = "Month,kWh,Cost,Note\n2025-10,400,52.10,\n2025-11,380.5,49.00,first\n2025-12,360,\n";
const save = (over: Partial<Parameters<typeof saveUtilityUsage>[0]> = {}) =>
  saveUtilityUsage({ entityId: P, kind: "electric", text: FILE, mapping: [...MAP], replaceKeys: [], skipBadRows: false, ...over });
const preview = (over: Partial<Parameters<typeof previewUtilityUsage>[0]> = {}) =>
  previewUtilityUsage({ entityId: P, kind: "electric", text: FILE, mapping: [...MAP], ...over });
const statuses = async (over = {}) => {
  const r = await preview(over);
  if (!("success" in r)) throw new Error(r.error);
  return r.preview.rows.map((x) => x.status);
};

describe("TESTER idempotency and archive / re-add through liveKey", () => {
  it("upload, re-upload (0 inserted, no audit row, all unchanged), archive one row, re-upload re-adds exactly that row", async () => {
    expect(await statuses()).toEqual(["new", "new", "new"]);
    expect(await save()).toMatchObject({ success: true, inserted: 3 });
    expect(live()).toHaveLength(3);
    expect(h.audit).toHaveBeenCalledTimes(1);

    expect(await statuses()).toEqual(["unchanged", "unchanged", "unchanged"]);
    const again = await save();
    expect(again).toMatchObject({ success: true, inserted: 0, unchanged: true });
    expect(rowsOf()).toHaveLength(3);
    expect(h.audit).toHaveBeenCalledTimes(1); // nothing written, nothing audited

    const victim = rowsOf().find((r) => r.period === "2025-11")!;
    expect(await archiveUtilityUsage({ entityId: P, id: victim.id })).toEqual({ success: true });
    expect(victim.archivedAt).not.toBeNull();
    expect(victim.liveKey).toBeNull();
    expect(rowsOf()).toHaveLength(3); // archived, not deleted
    expect(live()).toHaveLength(2);

    expect(await statuses()).toEqual(["unchanged", "new", "unchanged"]);
    expect(await save()).toMatchObject({ success: true, inserted: 1 });
    expect(rowsOf()).toHaveLength(4); // the archived row is still there
    expect(live()).toHaveLength(3);
    expect(new Set(live().map((r) => r.liveKey)).size).toBe(3);
    expect(h.calls.filter((c) => ["delete", "deleteMany", "upsert", "update", "create"].includes(c))).toEqual([]);
  });

  it("archiving the same row twice, or with another entity's id, is a friendly miss and changes nothing", async () => {
    await save();
    const r0 = rowsOf()[0]!;
    expect(await archiveUtilityUsage({ entityId: SV, id: r0.id })).toMatchObject({ error: expect.stringMatching(/not found/i) });
    expect(r0.archivedAt).toBeNull();
    expect(await archiveUtilityUsage({ entityId: P, id: r0.id })).toEqual({ success: true });
    expect(await archiveUtilityUsage({ entityId: P, id: r0.id })).toMatchObject({ error: expect.stringMatching(/not found/i) });
    expect(h.audit).toHaveBeenCalledTimes(2); // import + one archive, not two archives
  });

  it("a changed kWh is a conflict; without the tick nothing is written; with it the old row is archived and the new one live; chain of three replaces keeps exactly one live row", async () => {
    await save();
    const v2 = FILE.replace("400,52.10", "410,52.10");
    expect(await statuses({ text: v2 })).toEqual(["conflict", "unchanged", "unchanged"]);
    const noTick = await save({ text: v2 });
    expect(noTick).toMatchObject({ success: true, inserted: 0 });
    expect(live().find((r) => r.period === "2025-10")!.quantity).toBe("400.000");
    expect(rowsOf()).toHaveLength(3);

    const key = "electric|2025-10";
    expect(await save({ text: v2, replaceKeys: [key] })).toMatchObject({ success: true, inserted: 1, replaced: 1 });
    expect(rowsOf()).toHaveLength(4);
    expect(live().filter((r) => r.period === "2025-10")).toHaveLength(1);
    expect(live().find((r) => r.period === "2025-10")!.quantity).toBe("410.000");

    for (const q of ["420", "430", "440"]) {
      const t = FILE.replace("400,52.10", `${q},52.10`);
      expect(await save({ text: t, replaceKeys: [key] })).toMatchObject({ success: true, inserted: 1, replaced: 1 });
    }
    expect(live().filter((r) => r.period === "2025-10")).toHaveLength(1);
    expect(rowsOf().filter((r) => r.period === "2025-10")).toHaveLength(5);
    // going back to the very first value is a conflict again (the live row is 440), and replacing works with the freed key
    expect(await statuses({ text: FILE })).toEqual(["conflict", "unchanged", "unchanged"]);
    expect(await save({ text: FILE, replaceKeys: [key] })).toMatchObject({ success: true, inserted: 1, replaced: 1 });
    expect(live().find((r) => r.period === "2025-10")!.quantity).toBe("400.000");
  });

  it("a replace tick for a key that is NOT a conflict does nothing; a tick cannot be used to overwrite an unchanged row", async () => {
    await save();
    const r = await save({ replaceKeys: ["electric|2025-10", "electric|2025-11", "electric|1999-01", "oil|2025-10-01|400.000"] });
    expect(r).toMatchObject({ success: true, inserted: 0 });
    expect(rowsOf()).toHaveLength(3);
  });

  it("fills_cost: same kWh, saved without an amount, then an upload with the amount archives the old row without a tick", async () => {
    await save({ text: "Month,kWh\n2025-10,400\n", mapping: ["month", "quantity"] });
    const r = await save({ text: "Month,kWh,Cost\n2025-10,400,52.10\n", mapping: ["month", "quantity", "cost"] });
    expect(r).toMatchObject({ success: true, inserted: 1, replaced: 1 });
    expect(live()).toHaveLength(1);
    expect(live()[0]!.costCents).toBe(5210);
    expect(rowsOf()).toHaveLength(2);
  });

  it("oil: same date + gallons with another amount is a conflict; a second delivery the same day with other gallons is added with a warning", async () => {
    const oil = (t: string) => ({ entityId: P, kind: "oil" as const, text: t, mapping: ["month", "quantity", "cost"] as never });
    await saveUtilityUsage({ ...oil("Date,Gal,Cost\n2025-10-15,100,350.00\n"), replaceKeys: [], skipBadRows: false });
    const p1 = await previewUtilityUsage(oil("Date,Gal,Cost\n2025-10-15,100,360.00\n"));
    expect("success" in p1 && p1.preview.rows[0]!.status).toBe("conflict");
    const p2 = await previewUtilityUsage(oil("Date,Gal,Cost\n2025-10-15,120,400.00\n"));
    expect("success" in p2 && p2.preview.rows[0]!.status).toBe("new");
    expect("success" in p2 && p2.preview.rows[0]!.warnings.join(" ")).toMatch(/another delivery/);
  });
});

describe("TESTER two racing saves of the same file", () => {
  it("exactly one wins, the loser gets the friendly message, and no row is doubled", async () => {
    const [a, b] = await Promise.all([save(), save()]);
    const results = [a, b];
    const wins = results.filter((r) => "success" in r && r.inserted === 3);
    const losses = results.filter((r) => "error" in r);
    expect(wins).toHaveLength(1);
    expect(losses).toEqual([{ error: CHANGED_IN_ANOTHER_TAB }]);
    expect(rowsOf()).toHaveLength(3);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it("a losing REPLACE rolls back its archive step too (the old row stays live)", async () => {
    await save();
    const v2 = FILE.replace("400,52.10", "410,52.10");
    const key = "electric|2025-10";
    const [a, b] = await Promise.all([save({ text: v2, replaceKeys: [key] }), save({ text: v2, replaceKeys: [key] })]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => "success" in r && r.inserted === 1)).toHaveLength(1);
    expect(live().filter((r) => r.period === "2025-10")).toHaveLength(1);
    expect(live().filter((r) => r.period === "2025-10")[0]!.quantity).toBe("410.000");
    expect(rowsOf().filter((r) => r.period === "2025-10")).toHaveLength(2);
  });
});

describe("TESTER entity separation (rows, keys, loader, site builder)", () => {
  it("the same file for two houses is stored twice; archiving in one house leaves the other; the loader hands each house only its own rows", async () => {
    await save({ entityId: P });
    await save({ entityId: SV });
    expect(live()).toHaveLength(6);
    expect(new Set(live().map((r) => r.liveKey)).size).toBe(6);
    const loaded = await loadUtilityUsage([P, SV]);
    expect(loaded.status).toBe("ok");
    expect(loaded.rows.filter((r) => r.entityId === P)).toHaveLength(3);
    expect(loaded.rows.filter((r) => r.entityId === SV)).toHaveLength(3);
    await archiveUtilityUsage({ entityId: P, id: rowsOf().find((r) => r.entityId === P)!.id });
    const after = await loadUtilityUsage([P, SV]);
    expect(after.rows.filter((r) => r.entityId === P)).toHaveLength(2);
    expect(after.rows.filter((r) => r.entityId === SV)).toHaveLength(3);
    const only = await loadUtilityUsage([SV]);
    expect(only.rows.every((r) => r.entityId === SV)).toBe(true);
  });

  it("a house without the line, an archived or unknown entity, EK Consulting, and a bad uuid are all refused before any table access", async () => {
    h.calls.length = 0;
    expect(await save({ entityId: SV, kind: "oil" })).toMatchObject({ error: expect.stringMatching(/no Oil line/) });
    expect(await save({ entityId: P, kind: "firewood" })).toMatchObject({ error: expect.stringMatching(/no Firewood line/) });
    expect(await save({ entityId: EK })).toMatchObject({ error: expect.stringMatching(/no Electric line/) });
    expect(await save({ entityId: "00000000-0000-4000-8000-0000000000aa" })).toEqual({ error: "Invalid request" });
    expect(await save({ entityId: "not-a-uuid" })).toEqual({ error: "Invalid request" });
    expect(await preview({ entityId: EK })).toMatchObject({ error: expect.any(String) });
    expect(await addUtilityUsageMonth({ entityId: SV, kind: "oil", month: "2025-10-01", quantity: "100" })).toMatchObject({ error: expect.stringMatching(/no Oil line/) });
    expect(h.calls).toEqual([]);
    expect(rowsOf()).toHaveLength(0);
  });

  it("rows of one house never reach the other house's estimate", async () => {
    const elec = (n: number) => Array.from({ length: 12 }, (_, i) => {
      const idx = 2025 * 12 + 9 + i; // 2025-10 .. 2026-09
      const p = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
      return `${p},${n + i * 10}`;
    }).join("\n");
    await save({ entityId: P, text: `Month,kWh\n${elec(300)}\n`, mapping: ["month", "quantity"] });
    const loaded = await loadUtilityUsage([P, SV]);
    const by = (id: string) => loaded.rows.filter((r) => r.entityId === id).map((r) => ({ id: r.id, kind: r.kind, period: r.period, occurredOn: r.occurredOn, quantity: r.quantity, unit: r.unit, cost: r.cost, note: r.note }));
    const line = (entityId: string) => ({ entityId, tagId: "t", tagName: entityId === P ? "Utilities / Electric (Eversource)" : "Arbor Retreat / Electricity", kind: "electric" as const });
    const mk = (id: string, slug: string, name: string) => buildSiteEnergy({
      entity: { id, name, slug }, lines: [line(id)], txs: [], entities: [{ id: P, name: "Personal", slug: "personal" }, { id: SV, name: "SV", slug: "sudden-valley" }],
      priceEntries: [], flatMonthly: {}, replaceDraws: false, usage: by(id), now: new Date("2026-10-10T12:00:00Z"),
    });
    const sv = mk(SV, "sudden-valley", "Sudden Valley");
    expect(sv.electric!.usage).toBeNull(); // no SV rows at all
    expect(sv.usageRows).toEqual([]);
    const personal = mk(P, "personal", "Personal");
    expect(personal.electric!.usage).toMatchObject({ count: 12 });
  });
});

describe("TESTER preview == save, audit and log leaks", () => {
  it("random tables: the rows a save writes are exactly the previewed new / fills_cost rows (skip-bad on), for 300 seeded files", async () => {
    let seed = 99;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)] as T;
    for (let t = 0; t < 300; t++) {
      h.table.rows = []; h.table.seq = 0;
      const lines = ["Month,kWh,Cost,Note"];
      const n = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < n; i++) {
        lines.push([pick(["2025-10", "2025-11", "2025-12", "2026-01", "2026-10", "Jan-26", "2026-02", "2025-10"]), pick(["100", "250.5", "-3", "abc", "30000", "412.125", "0"]), pick(["", "10.00", "99999", "(5.00)", "x"]), pick(["", "ok", "=bad", "note"])].join(","));
      }
      const text = lines.join("\n");
      const p = await preview({ text });
      if (!("success" in p)) continue; // whole-input refusals are previews too
      const expected = p.preview.rows.filter((r) => r.status === "new" || r.status === "fills_cost").map((r) => `${r.period}|${r.quantity}|${r.costCents}|${r.note}|${r.unit}`).sort();
      const s = await save({ text, skipBadRows: true });
      if ("error" in s) { expect(rowsOf()).toHaveLength(0); continue; }
      const written = rowsOf().map((r) => `${r.period}|${r.quantity}|${r.costCents}|${r.note}|${r.unit}`).sort();
      expect(written, text).toEqual(expected);
      // and refusing bad rows without the flag writes nothing
      h.table.rows = [];
      const hasBad = p.preview.rows.some((r) => r.status === "error");
      const strict = await save({ text, skipBadRows: false });
      if (hasBad) { expect("error" in strict).toBe(true); expect(rowsOf()).toHaveLength(0); }
    }
  });

  it("AuditLog and console output hold ids and counts only: no quantity, amount, note or pasted text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "Month,kWh,Cost,Note\n2025-10,777.7,4242.42,SECRETNOTE-ZEBRA\n";
    await save({ text: secret });
    const month = await addUtilityUsageMonth({ entityId: P, kind: "electric", month: "2025-11", quantity: "888.8", cost: "5151.51", note: "SECRETNOTE-GIRAFFE" });
    expect("success" in month).toBe(true);
    await archiveUtilityUsage({ entityId: P, id: rowsOf()[0]!.id });
    h.table.throwOn = { op: "createMany", err: new Error("boom 777.7 SECRETNOTE-ZEBRA") };
    await save({ text: "Month,kWh\n2026-01,555.5\n", mapping: ["month", "quantity"] });
    h.table.throwOn = null;
    const dump = JSON.stringify([h.audit.mock.calls, spy.mock.calls]);
    for (const needle of ["777.7", "4242.42", "424242", "SECRETNOTE", "888.8", "5151.51", "515151", "555.5", "boom"]) expect(dump, needle).not.toContain(needle);
    expect(h.audit.mock.calls.map((c) => (c[0] as { data: { changeType: string } }).data.changeType)).toEqual(["utility_usage_import", "utility_usage_add", "utility_usage_archive"]);
    spy.mockRestore();
  });

  it("a mid-transaction failure writes nothing and says so", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await save();
    h.table.throwOn = { op: "createMany", err: new Error("connection reset") };
    const v2 = FILE.replace("400,52.10", "410,52.10");
    const r = await save({ text: v2, replaceKeys: ["electric|2025-10"] });
    expect(r).toEqual({ error: "The history could not be saved just now. Nothing was changed." });
    expect(live().find((x) => x.period === "2025-10")!.quantity).toBe("400.000"); // the archive step was rolled back
    expect(live()).toHaveLength(3);
    spy.mockRestore();
  });
});

describe("TESTER fail-soft when the table does not exist", () => {
  const p2021 = () => Object.assign(new Error("The table `public.UtilityUsage` does not exist in the current database."), { code: "P2021" });
  it("the loader answers not_set_up (no throw, no rows); a generic error answers failed; both stay quiet about details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.table.throwOn = { op: "findMany", err: p2021() };
    expect(await loadUtilityUsage([P])).toEqual({ status: "not_set_up", rows: [] });
    h.table.throwOn = { op: "findMany", err: new Error("password authentication failed for user x") };
    expect(await loadUtilityUsage([P])).toEqual({ status: "failed", rows: [] });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("password");
    h.table.throwOn = { op: "findMany", err: Object.assign(new Error("relation does not exist"), { meta: { code: "42P01" } }) };
    expect((await loadUtilityUsage([P])).status).toBe("not_set_up");
    spy.mockRestore();
  });
  it("preview, save, add and archive each answer with a plain message instead of throwing", async () => {
    h.table.throwOn = { op: "findMany", err: p2021() };
    const a = await preview();
    expect(a).toMatchObject({ error: expect.stringMatching(/not set up/i) });
    const b = await save();
    expect(b).toMatchObject({ error: expect.stringMatching(/not set up/i) });
    const c = await addUtilityUsageMonth({ entityId: P, kind: "electric", month: "2025-10", quantity: "100" });
    expect(c).toMatchObject({ error: expect.stringMatching(/not set up/i) });
    h.table.throwOn = null;
    h.table.throwOn = { op: "createMany", err: p2021() };
    expect(await save()).toMatchObject({ error: expect.stringMatching(/not set up/i) });
    h.table.throwOn = null;
    h.table.throwOn = { op: "updateMany", err: p2021() };
    expect(await archiveUtilityUsage({ entityId: P, id: "0b5a1037-03e1-43ad-bfe7-6be922c61ac4" })).toMatchObject({ error: expect.any(String) });
  });
});

describe("TESTER 'today' is the New York calendar day, not the UTC day", () => {
  it("at 22:00 New York time on Oct 10 (UTC is already Oct 11) an Oct 10 delivery is accepted and an Oct 11 one is a future date", async () => {
    vi.setSystemTime(new Date("2026-10-11T02:00:00Z"));
    try {
      const mapping = ["month", "quantity"] as never;
      const ok = await previewUtilityUsage({ entityId: P, kind: "oil", text: "Date,Gal\n2026-10-10,100\n2026-10-11,100\n", mapping });
      expect("success" in ok && ok.preview.rows.map((r) => r.status)).toEqual(["new", "error"]);
      vi.setSystemTime(new Date("2026-11-01T02:00:00Z")); // Oct 31 22:00 in New York: October is still the unfinished month
      const e = await previewUtilityUsage({ entityId: P, kind: "electric", text: "Month,kWh\n2026-09,100\n2026-10,100\n2026-11,100\n", mapping });
      expect("success" in e && e.preview.rows.map((r) => r.status)).toEqual(["new", "error", "error"]);
    } finally {
      vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
    }
  });
});

describe("TESTER the store alone refuses to archive another house's row", () => {
  it("insertRows with a foreign archive id rolls back with the friendly message and leaves the row live", async () => {
    await save({ entityId: SV });
    const svRow = rowsOf().find((r) => r.entityId === SV)!;
    const { insertRows } = await import("@/lib/utility-usage-store");
    const res = await insertRows({ entityId: P, kind: "electric", userId: "owner-1", batchId: "b", source: "upload", rows: [], archiveIds: [svRow.id] });
    expect(res).toEqual({ ok: false, error: CHANGED_IN_ANOTHER_TAB });
    expect(svRow.archivedAt).toBeNull();
    expect(svRow.liveKey).not.toBeNull();
  });
});

describe("TESTER the whole input is bounded server-side too", () => {
  it("a 1,000,001-character text is an 'Invalid request', 200,001 a clear refusal, and an over-long mapping is invalid", async () => {
    expect(await preview({ text: "a".repeat(1_000_001) })).toEqual({ error: "Invalid request" });
    const r = await preview({ text: "Month,kWh\n" + " ".repeat(200_000) });
    expect("error" in r).toBe(true);
    expect(await preview({ mapping: Array(21).fill("ignore") as never })).toEqual({ error: "Invalid request" });
    expect(await preview({ mapping: ["month", "drop table"] as never })).toEqual({ error: "Invalid request" });
    expect(rowsOf()).toHaveLength(0);
  });
  it("the one-month form goes through the same checks and cannot smuggle a second row, a header or a delimiter", async () => {
    const bad = [
      { month: "2025-10\n2025-11,5", quantity: "100" },
      { month: "2025-10", quantity: "100\n2025-11,5" },
      { month: "2026-10", quantity: "100" }, // unfinished month
      { month: "2025-10", quantity: "100", note: "=1+1" },
      { month: "2025-10", quantity: "100", cost: "1,5" },
      { month: "2025-10", quantity: "-5" },
    ];
    for (const b of bad) expect(await addUtilityUsageMonth({ entityId: P, kind: "electric", ...b })).toHaveProperty("error");
    expect(rowsOf()).toHaveLength(0);
    const tricky = await addUtilityUsageMonth({ entityId: P, kind: "electric", month: "2025-10", quantity: "100", note: 'a,b";c"' });
    expect("success" in tricky).toBe(true);
    expect(rowsOf()).toHaveLength(1);
    expect(rowsOf()[0]!.note).toBe('a,b";c"');
  });
});
