// utility-usage-upload, step 6: the owner actions (actions/utility-usage.ts) over the REAL store module and an in-memory fake
// of the UtilityUsage table (unique liveKey, transactional rollback). Auth first, preview never writes, idempotent re-upload,
// conflict / replace / fills_cost, the unique-key race, skipBadRows, entity checks and an AuditLog that holds ids and counts
// only. No test here touches a real database.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";

interface FakeRow {
  id: string;
  entityId: string;
  kind: string;
  period: string;
  occurredOn: Date;
  quantity: string;
  unit: string;
  costCents: number | null;
  note: string | null;
  source: string;
  importBatchId: string | null;
  liveKey: string | null;
  createdById: string | null;
  createdAt: Date;
  archivedAt: Date | null;
  archivedById: string | null;
}

const m = vi.hoisted(() => {
  const state = { rows: [] as unknown[], seq: 0, beforeCreate: null as null | (() => void), beforeTx: null as null | (() => void), failWith: null as null | Error };
  return {
    state,
    auth: vi.fn(),
    revalidatePath: vi.fn(),
    loadSeasonalLines: vi.fn(),
    db: {
      entity: { findFirst: vi.fn() },
      auditLog: { create: vi.fn() },
      utilityUsage: {} as Record<string, unknown>,
      $transaction: null as unknown as (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>,
    },
  };
});
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ db: m.db }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/lib/seasonal-energy-build", () => ({ loadSeasonalLines: m.loadSeasonalLines }));

import { addUtilityUsageMonth, archiveUtilityUsage, previewUtilityUsage, saveUtilityUsage } from "@/actions/utility-usage";
import { CHANGED_IN_ANOTHER_TAB } from "@/lib/utility-usage-store";

const ENT = "6f55fa50-9d94-47a8-92d6-2cc5abeac714";
const OTHER = "73edfe3c-f043-4f73-a8ab-3de6591d29d4";
const ROW_ID = "0b5a1037-03e1-43ad-bfe7-6be922c61ac4";

const rows = () => m.state.rows as FakeRow[];
const live = () => rows().filter((r) => r.archivedAt === null);

function matches(r: FakeRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    const val = (r as unknown as Record<string, unknown>)[k];
    if (v !== null && typeof v === "object" && "in" in (v as object)) {
      if (!((v as { in: unknown[] }).in as unknown[]).includes(val)) return false;
    } else if (v === null) {
      if (val !== null) return false;
    } else if (val !== v) return false;
  }
  return true;
}

function installFake() {
  const u = m.db.utilityUsage as Record<string, unknown>;
  u.findMany = vi.fn(async (q: { where: Record<string, unknown>; take?: number }) => {
    if (m.state.failWith) throw m.state.failWith;
    return rows().filter((r) => matches(r, q.where)).slice(0, q.take ?? 1e9).map((r) => ({ ...r }));
  });
  u.findFirst = vi.fn(async (q: { where: Record<string, unknown> }) => {
    const r = rows().find((x) => matches(x, q.where));
    return r ? { ...r } : null;
  });
  u.updateMany = vi.fn(async (q: { where: Record<string, unknown>; data: Partial<FakeRow> }) => {
    const hit = rows().filter((r) => matches(r, q.where));
    for (const r of hit) Object.assign(r, q.data);
    return { count: hit.length };
  });
  u.createMany = vi.fn(async (q: { data: Array<Partial<FakeRow> & { liveKey: string }> }) => {
    m.state.beforeCreate?.();
    for (const d of q.data) {
      if (d.liveKey && rows().some((r) => r.liveKey === d.liveKey)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`liveKey`)", { code: "P2002", clientVersion: "test" });
      }
      m.state.seq += 1;
      rows().push({
        id: `00000000-0000-4000-8000-${String(m.state.seq).padStart(12, "0")}`,
        entityId: "",
        kind: "",
        period: "",
        occurredOn: new Date(0),
        quantity: "0",
        unit: "",
        costCents: null,
        note: null,
        source: "",
        importBatchId: null,
        createdById: null,
        createdAt: new Date(),
        archivedAt: null,
        archivedById: null,
        ...d,
      } as FakeRow);
    }
    return { count: q.data.length };
  });
  m.db.$transaction = async (fn) => {
    m.state.beforeTx?.(); // another tab's committed write lands before this transaction starts
    const snapshot = rows().map((r) => ({ ...r }));
    try {
      return await fn(m.db);
    } catch (err) {
      m.state.rows = snapshot;
      throw err;
    }
  };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  m.state.rows = [];
  m.state.seq = 0;
  m.state.beforeCreate = null;
  m.state.beforeTx = null;
  m.state.failWith = null;
  m.auth.mockResolvedValue({ user: { id: "user-1" } });
  m.db.entity.findFirst.mockImplementation(async (q: { where: { id: string } }) => (q.where.id === ENT ? { id: ENT, slug: "personal" } : q.where.id === OTHER ? { id: OTHER, slug: "sudden-valley" } : null));
  m.db.auditLog.create.mockResolvedValue({});
  m.loadSeasonalLines.mockResolvedValue([
    { entityId: ENT, tagId: "t-e", tagName: "Utilities / Electric (Eversource)", kind: "electric" },
    { entityId: ENT, tagId: "t-o", tagName: "Utilities / Oil", kind: "oil" },
    { entityId: OTHER, tagId: "t-e2", tagName: "Arbor Retreat / Electricity", kind: "electric" },
  ]);
  installFake();
});

const csv = (lines: string[]) => lines.join("\n") + "\n";
const MAP = ["month", "quantity", "cost", "note"] as const;
const base = { entityId: ENT, kind: "electric" as const, mapping: [...MAP] };
const FILE = csv(["Month,kWh,Cost,Note", "2024-04,400,52.10,", "2024-05,380.5,49.00,", "2024-06,360,"]);

async function save(over: Partial<Parameters<typeof saveUtilityUsage>[0]> = {}) {
  return saveUtilityUsage({ ...base, text: FILE, replaceKeys: [], skipBadRows: false, ...over });
}

describe("auth comes first in every export", () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["previewUtilityUsage", () => previewUtilityUsage({ entityId: ENT, kind: "electric", text: FILE })],
    ["saveUtilityUsage", () => save()],
    ["addUtilityUsageMonth", () => addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "400" })],
    ["archiveUtilityUsage", () => archiveUtilityUsage({ entityId: ENT, id: ROW_ID })],
  ];
  it.each(calls)("%s rejects an anonymous caller before any database access", async (_name, run) => {
    m.auth.mockResolvedValue(null);
    await expect(run()).rejects.toThrow("Unauthorized");
    m.auth.mockResolvedValue({ user: {} });
    await expect(run()).rejects.toThrow("Unauthorized");
    expect(m.db.entity.findFirst).not.toHaveBeenCalled();
    expect(m.db.auditLog.create).not.toHaveBeenCalled();
    expect(m.loadSeasonalLines).not.toHaveBeenCalled();
    for (const fn of Object.values(m.db.utilityUsage)) expect(fn).not.toHaveBeenCalled();
  });

  it("the source pins it: every export is an async function whose first statement is `await requireAuth();`", () => {
    const src = readFileSync(resolve(__dirname, "../..", "actions/utility-usage.ts"), "utf8");
    expect(src.startsWith('"use server";')).toBe(true);
    const exported = [...src.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\n([^\n]*)\n/g)];
    expect(exported.map((x) => x[1])).toEqual(["previewUtilityUsage", "saveUtilityUsage", "addUtilityUsageMonth", "archiveUtilityUsage"]);
    for (const x of exported) expect(x[2], x[1]).toMatch(/await requireAuth\(\);/);
    for (const line of src.split("\n").filter((l) => l.startsWith("export "))) expect(line).toMatch(/^export async function /);
  });
});

describe("previewUtilityUsage", () => {
  it("shows every row with its status and writes nothing", async () => {
    const r = await previewUtilityUsage({ entityId: ENT, kind: "electric", text: FILE, mapping: [...MAP] });
    expect(r).toMatchObject({ success: true });
    if (!("success" in r)) return;
    expect(r.preview.rows.map((x) => x.status)).toEqual(["new", "new", "new"]);
    expect(r.preview.summary.counts.new).toBe(3);
    expect(r.preview.summary).toMatchObject({ months: 3, first: "2024-04", last: "2024-06" });
    expect(m.db.auditLog.create).not.toHaveBeenCalled();
    expect(m.revalidatePath).not.toHaveBeenCalled();
    const u = m.db.utilityUsage as Record<string, { mock: { calls: unknown[] } }>;
    expect(u.createMany!.mock.calls).toHaveLength(0);
    expect(u.updateMany!.mock.calls).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it("suggests a mapping when none is given and reports a mapping problem without rows", async () => {
    const r = await previewUtilityUsage({ entityId: ENT, kind: "electric", text: "A,B\n2024-04,400\n" });
    expect(r).toMatchObject({ success: true });
    if ("success" in r) expect(r.preview.mappingError).toMatch(/month/);
  });

  it("returns the whole-input error for oversize text instead of a partial parse", async () => {
    const r = await previewUtilityUsage({ entityId: ENT, kind: "electric", text: "a".repeat(200_001) });
    expect(r).toEqual({ error: expect.stringMatching(/too much text/) });
  });

  it("classifies against what is saved right now", async () => {
    await save();
    const r = await previewUtilityUsage({ entityId: ENT, kind: "electric", text: csv(["Month,kWh,Cost", "2024-04,400,52.10", "2024-05,390,49.00", "2024-07,300,40"]), mapping: ["month", "quantity", "cost"] });
    if (!("success" in r)) throw new Error(r.error);
    expect(r.preview.rows.map((x) => x.status)).toEqual(["unchanged", "conflict", "new"]);
  });

  it("a missing table is a plain message, not a throw", async () => {
    m.state.failWith = Object.assign(new Error("The table `public.UtilityUsage` does not exist"), { code: "P2021" });
    const r = await previewUtilityUsage({ entityId: ENT, kind: "electric", text: FILE, mapping: [...MAP] });
    expect(r).toEqual({ error: expect.stringMatching(/not set up yet/) });
  });
});

describe("saveUtilityUsage", () => {
  it("inserts the previewed rows with a live key, the entity, the author and the batch; AuditLog holds counts and ids only", async () => {
    const r = await save({ text: csv(["Month,kWh,Cost,Note", "2024-04,777.123,5252.10,ZEBRA-NOTE"]) });
    expect(r).toEqual({ success: true, inserted: 1, replaced: 0, skipped: 0 });
    expect(rows()).toHaveLength(1);
    const row = rows()[0]!;
    expect(row).toMatchObject({
      entityId: ENT,
      kind: "electric",
      period: "2024-04",
      quantity: "777.123",
      unit: "kwh",
      costCents: 525210,
      note: "ZEBRA-NOTE",
      source: "upload",
      liveKey: `${ENT}|electric|2024-04`,
      createdById: "user-1",
      archivedAt: null,
    });
    expect(row.occurredOn.toISOString()).toBe("2024-04-01T00:00:00.000Z");
    expect(row.importBatchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.revalidatePath).toHaveBeenCalledWith("/forecast");
    const audit = m.db.auditLog.create.mock.calls[0]![0] as { data: { changeType: string; changedBy: string; after: Record<string, unknown> } };
    expect(audit.data.changeType).toBe("utility_usage_import");
    expect(audit.data.changedBy).toBe("user-1");
    expect(Object.keys(audit.data.after).sort()).toEqual(["batchId", "entityId", "inserted", "kind", "replaced", "skipped"]);
    const blob = JSON.stringify(m.db.auditLog.create.mock.calls);
    for (const secret of ["ZEBRA", "777.123", "5252.10", "525210"]) expect(blob).not.toContain(secret);
  });

  it("re-uploading the same file inserts nothing and writes no audit row", async () => {
    expect(await save()).toMatchObject({ success: true, inserted: 3 });
    m.db.auditLog.create.mockClear();
    m.revalidatePath.mockClear();
    const again = await save();
    expect(again).toEqual({ success: true, inserted: 0, replaced: 0, skipped: 3, unchanged: true });
    expect(live()).toHaveLength(3);
    expect(m.db.auditLog.create).not.toHaveBeenCalled();
    const p = await previewUtilityUsage({ entityId: ENT, kind: "electric", text: FILE, mapping: [...MAP] });
    if (!("success" in p)) throw new Error(p.error);
    expect(p.preview.rows.map((x) => x.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
  });

  it("a changed month is a conflict: not saved without its Replace tick; with it the old row is archived, never deleted", async () => {
    await save();
    const changed = csv(["Month,kWh,Cost,Note", "2024-04,411,52.10,", "2024-05,380.5,49.00,"]);
    const untouched = await save({ text: changed });
    expect(untouched).toMatchObject({ success: true, inserted: 0, unchanged: true });
    expect(live().find((r) => r.period === "2024-04")!.quantity).toBe("400.000");

    const replaced = await save({ text: changed, replaceKeys: ["electric|2024-04"] });
    expect(replaced).toEqual({ success: true, inserted: 1, replaced: 1, skipped: 1 });
    expect(live()).toHaveLength(3);
    expect(live().find((r) => r.period === "2024-04")!.quantity).toBe("411.000");
    const archived = rows().filter((r) => r.archivedAt !== null);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ period: "2024-04", liveKey: null, archivedById: "user-1" });
    expect(rows()).toHaveLength(4); // nothing was deleted
    const audit = m.db.auditLog.create.mock.calls.at(-1)![0] as { data: { after: Record<string, unknown> } };
    expect(audit.data.after).toMatchObject({ inserted: 1, replaced: 1 });
  });

  it("adding a dollar amount to a saved kWh-only month fills the cost without a tick", async () => {
    await save({ text: csv(["Month,kWh", "2024-04,400"]), mapping: ["month", "quantity"] });
    const r = await save({ text: csv(["Month,kWh,Cost", "2024-04,400,52.10"]), mapping: ["month", "quantity", "cost"] });
    expect(r).toEqual({ success: true, inserted: 1, replaced: 1, skipped: 0 });
    expect(live()).toHaveLength(1);
    expect(live()[0]!.costCents).toBe(5210);
    expect(rows().filter((x) => x.archivedAt !== null)).toHaveLength(1);
  });

  it("two tabs racing for the same month: the loser gets a friendly message and nothing changes", async () => {
    // between this save's read of the saved rows and its insert, another tab saves April
    m.state.beforeTx = () => {
      m.state.beforeTx = null;
      rows().push({
        id: "11111111-1111-4111-8111-111111111111", entityId: ENT, kind: "electric", period: "2024-04", occurredOn: new Date("2024-04-01T00:00:00Z"),
        quantity: "400.000", unit: "kwh", costCents: null, note: null, source: "upload", importBatchId: null, liveKey: `${ENT}|electric|2024-04`,
        createdById: "user-2", createdAt: new Date(), archivedAt: null, archivedById: null,
      });
    };
    const r = await save();
    expect(r).toEqual({ error: CHANGED_IN_ANOTHER_TAB });
    expect(live()).toHaveLength(1); // only the other tab's row; this save rolled back completely
    expect(m.db.auditLog.create).not.toHaveBeenCalled();
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it("a row that was archived by another tab before a ticked replace rolls the whole save back", async () => {
    await save({ text: csv(["Month,kWh", "2024-04,400"]), mapping: ["month", "quantity"] });
    const target = live()[0]!;
    const orig = (m.db.utilityUsage as Record<string, (q: unknown) => Promise<unknown>>).updateMany!;
    (m.db.utilityUsage as Record<string, unknown>).updateMany = vi.fn(async (q: unknown) => {
      target.archivedAt = new Date(); // another tab archived it first
      target.liveKey = null;
      return orig(q);
    });
    const r = await save({ text: csv(["Month,kWh", "2024-04,555"]), mapping: ["month", "quantity"], replaceKeys: ["electric|2024-04"] });
    expect(r).toEqual({ error: CHANGED_IN_ANOTHER_TAB });
    expect(m.db.auditLog.create).toHaveBeenCalledTimes(1); // only the first save's
  });

  it("rows with errors block the save unless skipBadRows; then only the good rows are written", async () => {
    const text = csv(["Month,kWh", "2024-04,400", "2024-05,not a number", "2024-06,360"]);
    const blocked = await save({ text, mapping: ["month", "quantity"] });
    expect(blocked).toEqual({ error: expect.stringMatching(/1 row has an error/) });
    expect(rows()).toHaveLength(0);
    const ok = await save({ text, mapping: ["month", "quantity"], skipBadRows: true });
    expect(ok).toEqual({ success: true, inserted: 2, replaced: 0, skipped: 1 });
    expect(live().map((r) => r.period).sort()).toEqual(["2024-04", "2024-06"]);
  });

  it("a refused file saves nothing (formula-leading note, SSN-like note, futures, current month)", async () => {
    const withNote = ["month", "quantity", "note"] as const;
    const plain = ["month", "quantity"] as const;
    const cases: Array<[string, readonly ("month" | "quantity" | "note")[]]> = [
      [csv(["Month,kWh,Note", '2024-04,400,"=HYPERLINK(1)"']), withNote],
      [csv(["Month,kWh,Note", "2024-04,400,123-45-6789"]), withNote],
      [csv(["Month,kWh", "2027-04,400"]), plain],
      [csv(["Month,kWh", "2026-10,400"]), plain],
      [csv(["Month,kWh", '2024-04,"400']), plain],
    ];
    for (const [text, mapping] of cases) {
      const r = await save({ text, mapping: [...mapping] });
      expect("error" in r, text).toBe(true);
    }
    expect(rows()).toHaveLength(0);
    expect(m.db.auditLog.create).not.toHaveBeenCalled();
  });

  it("a mapping problem saves nothing", async () => {
    const r = await save({ mapping: ["month", "ignore", "ignore", "ignore"] });
    expect(r).toEqual({ error: expect.stringMatching(/kWh/) });
  });

  it("the same text saved for two houses stays separate", async () => {
    await save();
    const other = await saveUtilityUsage({ ...base, entityId: OTHER, text: FILE, replaceKeys: [], skipBadRows: false });
    expect(other).toMatchObject({ success: true, inserted: 3 });
    expect(live().filter((r) => r.entityId === ENT)).toHaveLength(3);
    expect(live().filter((r) => r.entityId === OTHER)).toHaveLength(3);
    expect(new Set(live().map((r) => r.liveKey)).size).toBe(6);
  });
});

describe("entity and kind checks", () => {
  it("an unknown entity is refused", async () => {
    const r = await saveUtilityUsage({ ...base, entityId: "5d3cbe0d-04b3-4a0f-8d7a-1a3d9a2c0001", text: FILE, replaceKeys: [], skipBadRows: false });
    expect(r).toEqual({ error: "Invalid request" });
  });
  it("a house without a line of that kind is refused for preview, save and add", async () => {
    const msg = { error: "That house has no Oil line." };
    expect(await previewUtilityUsage({ entityId: OTHER, kind: "oil", text: "2024-04,100\n" })).toEqual(msg);
    expect(await saveUtilityUsage({ entityId: OTHER, kind: "oil", text: "2024-04,100\n", mapping: ["month", "quantity"], replaceKeys: [], skipBadRows: false })).toEqual(msg);
    expect(await addUtilityUsageMonth({ entityId: OTHER, kind: "oil", month: "2024-04", quantity: "100" })).toEqual(msg);
    expect(await previewUtilityUsage({ entityId: ENT, kind: "firewood", text: "2024-04,1\n" })).toEqual({ error: "That house has no Firewood line." });
    expect(rows()).toHaveLength(0);
  });
  it("malformed input is refused before any database access", async () => {
    // @ts-expect-error deliberately wrong
    expect(await previewUtilityUsage({ entityId: "nope", kind: "gas", text: 5 })).toEqual({ error: "Invalid request" });
    expect(m.db.entity.findFirst).not.toHaveBeenCalled();
  });
  it("a budget-line read failure refuses the write", async () => {
    m.loadSeasonalLines.mockRejectedValue(new Error("down"));
    const r = await save();
    expect(r).toEqual({ error: expect.stringMatching(/budget lines could not be read/) });
    expect(rows()).toHaveLength(0);
  });
});

describe("addUtilityUsageMonth", () => {
  it("saves one month through the same checks, as a manual row", async () => {
    const r = await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "Apr 2024", quantity: "400", cost: "52.10", note: "solar credit 12" });
    expect(r).toEqual({ success: true, inserted: 1, replaced: 0, skipped: 0 });
    expect(live()[0]).toMatchObject({ period: "2024-04", quantity: "400.000", costCents: 5210, note: "solar credit 12", source: "manual" });
    const audit = m.db.auditLog.create.mock.calls[0]![0] as { data: { changeType: string; after: Record<string, unknown> } };
    expect(audit.data.changeType).toBe("utility_usage_add");
    // needles a random batch UUID can never contain (a UUID has no "." and no letters beyond a-f)
    expect(JSON.stringify(audit)).not.toMatch(/400\.000|52\.10|solar credit/);
  });

  it("a different value for a saved month needs Replace; the same value is reported as already saved", async () => {
    await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "400" });
    expect(await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "400" })).toMatchObject({ success: true, inserted: 0, unchanged: true });
    expect(await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "420" })).toEqual({ error: expect.stringMatching(/Tick Replace/) });
    expect(await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "420", replace: true })).toEqual({ success: true, inserted: 1, replaced: 1, skipped: 0 });
    expect(live()).toHaveLength(1);
  });

  it("refuses what the parser refuses, and anything with a line break", async () => {
    expect(await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2027-01", quantity: "400" })).toEqual({ error: expect.stringMatching(/future/) });
    expect(await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "-4" })).toEqual({ error: expect.stringMatching(/negative kWh/) });
    expect(await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "400", note: "a\nb" })).toEqual({ error: "Invalid request" });
    expect(await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "400", note: "=1+1" })).toEqual({ error: expect.stringMatching(/formula/) });
    for (const note of [" =1+1", "\u00A0+1", "\uFEFF@x", "\t=1"]) {
      expect(await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "400", note }), JSON.stringify(note)).toEqual({ error: expect.stringMatching(/formula/) });
    }
    expect(rows()).toHaveLength(0);
  });

  it("an oil delivery keeps its day", async () => {
    await addUtilityUsageMonth({ entityId: ENT, kind: "oil", month: "2025-11-14", quantity: "120.5", cost: "420" });
    expect(live()[0]).toMatchObject({ kind: "oil", period: "2025-11", unit: "gal", liveKey: `${ENT}|oil|2025-11-14|120.500` });
    expect(live()[0]!.occurredOn.toISOString()).toBe("2025-11-14T00:00:00.000Z");
  });
});

describe("archiveUtilityUsage", () => {
  it("archives a live row of that house: it leaves the live set, is kept, and the AuditLog has ids and kind only", async () => {
    await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "400", note: "private note" });
    const id = live()[0]!.id;
    m.db.auditLog.create.mockClear();
    expect(await archiveUtilityUsage({ entityId: ENT, id })).toEqual({ success: true });
    expect(live()).toHaveLength(0);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ liveKey: null, archivedById: "user-1" });
    expect(rows()[0]!.archivedAt).toBeInstanceOf(Date);
    expect(m.db.auditLog.create.mock.calls[0]![0]).toEqual({ data: { changedBy: "user-1", changeType: "utility_usage_archive", before: Prisma.JsonNull, after: { entityId: ENT, id, kind: "electric" } } });
    expect(m.revalidatePath).toHaveBeenCalledWith("/forecast");
    // the month can be added again once its row is archived
    expect(await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "410" })).toMatchObject({ success: true, inserted: 1 });
  });

  it("another house's row, an unknown row and an already archived row are refused", async () => {
    await addUtilityUsageMonth({ entityId: ENT, kind: "electric", month: "2024-04", quantity: "400" });
    const id = live()[0]!.id;
    expect(await archiveUtilityUsage({ entityId: OTHER, id })).toEqual({ error: expect.stringMatching(/not found/) });
    expect(live()).toHaveLength(1);
    expect(await archiveUtilityUsage({ entityId: ENT, id: ROW_ID })).toEqual({ error: expect.stringMatching(/not found/) });
    await archiveUtilityUsage({ entityId: ENT, id });
    expect(await archiveUtilityUsage({ entityId: ENT, id })).toEqual({ error: expect.stringMatching(/not found/) });
    expect(await archiveUtilityUsage({ entityId: "bad", id })).toEqual({ error: "Invalid request" });
  });
});
