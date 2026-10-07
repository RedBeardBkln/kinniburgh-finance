import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";

// Mocks at the db/auth boundary (repo convention: no integrated DB tests). The fake keeps TaxFact rows in memory.
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type Row = Record<string, unknown> & { id: string; entityId: string; factKey: string; version: number; archivedAt: Date | null };

const state = vi.hoisted(() => ({ rows: [] as unknown[], nextId: 1, failCreateWith: null as unknown, failFindWith: null as unknown }));

const mockDb = vi.hoisted(() => {
  const db = {
    user: { findUnique: vi.fn() },
    entity: { findFirst: vi.fn() },
    taxFact: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  return db;
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  reconfirmTaxFact,
  retireTaxFact,
  seedTaxFactsTy2025,
  setTaxFact,
  setTaxFactPolicy,
} from "@/actions/tax-facts";
import { TAX_FACTS_SEED_TY2025 } from "@/lib/tax-facts/seed-ty2025";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const rows = () => state.rows as Row[];

function matches(r: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "factKey" && typeof v === "object" && v !== null && "in" in v) {
      if (!(v as { in: string[] }).in.includes(r.factKey)) return false;
    } else if (k === "id" && typeof v === "object" && v !== null && "in" in v) {
      if (!(v as { in: string[] }).in.includes(r.id)) return false;
    } else if (r[k] !== v) return false;
  }
  return true;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.nextId = 1;
  state.failCreateWith = null;
  state.failFindWith = null;
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.user.findUnique.mockResolvedValue({ name: "Eric" });
  mockDb.entity.findFirst.mockResolvedValue({ id: PERSONAL });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
  mockDb.taxFact.findMany.mockImplementation(async (args: { where: Record<string, unknown>; orderBy?: unknown }) => {
    if (state.failFindWith) throw state.failFindWith;
    const out = rows().filter((r) => matches(r, args.where));
    return [...out].sort((a, b) => b.version - a.version);
  });
  mockDb.taxFact.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    const out = rows().filter((r) => matches(r, args.where)).sort((a, b) => b.version - a.version);
    return out[0] ?? null;
  });
  mockDb.taxFact.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    if (state.failCreateWith) throw state.failCreateWith;
    const row = { id: `fact-${state.nextId++}`, archivedAt: null, setAt: new Date(), ...args.data } as unknown as Row;
    state.rows.push(row);
    return row;
  });
  mockDb.taxFact.createMany.mockImplementation(async (args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
    let count = 0;
    for (const d of args.data) {
      const dup = rows().some((r) => r.entityId === d.entityId && r.factKey === d.factKey && r.version === d.version);
      if (dup && args.skipDuplicates) continue;
      state.rows.push({ id: `fact-${state.nextId++}`, archivedAt: null, ...d } as unknown as Row);
      count += 1;
    }
    return { count };
  });
  mockDb.taxFact.updateMany.mockImplementation(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const r of rows()) {
      if (matches(r, args.where)) {
        Object.assign(r, args.data);
        count += 1;
      }
    }
    return { count };
  });
});

const createInput = {
  mode: "create" as const,
  factKey: "household.filing_status",
  category: "household" as const,
  label: "Filing status",
  valueKind: "choice" as const,
  valueText: "mfj",
  carryPolicy: "reconfirm" as const,
  taxYear: 2025,
};

describe("auth gate", () => {
  it("every export rejects an unauthenticated caller before touching the db", async () => {
    authMock.mockResolvedValue(null);
    await expect(setTaxFact(createInput)).rejects.toThrow("Unauthorized");
    await expect(reconfirmTaxFact({ factKey: "a.b", taxYear: 2026 })).rejects.toThrow("Unauthorized");
    await expect(setTaxFactPolicy({ factKey: "a.b", carryPolicy: "stable" })).rejects.toThrow("Unauthorized");
    await expect(retireTaxFact({ factKey: "a.b", taxYear: 2026, reason: "done" })).rejects.toThrow("Unauthorized");
    await expect(seedTaxFactsTy2025()).rejects.toThrow("Unauthorized");
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(mockDb.entity.findFirst).not.toHaveBeenCalled();
    expect(mockDb.taxFact.create).not.toHaveBeenCalled();
    expect(mockDb.taxFact.createMany).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("source check: every exported function starts with `const user = await requireAuth();`", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/tax-facts.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(src.startsWith('"use server";')).toBe(true);
    const names = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(names.sort()).toEqual(["reconfirmTaxFact", "retireTaxFact", "seedTaxFactsTy2025", "setTaxFact", "setTaxFactPolicy"]);
    for (const name of names) {
      const start = src.indexOf(`export async function ${name}`);
      const open = src.indexOf("{\n", start) + 2;
      expect(src.slice(open, open + 60).trimStart().startsWith("const user = await requireAuth();"), name).toBe(true);
    }
  });
});

describe("versioning through the actions", () => {
  it("creates version 1, then a change inserts version 2 and archives version 1; history stays", async () => {
    const created = await setTaxFact(createInput);
    expect(created).toMatchObject({ ok: true, version: 1 });
    const changed = await setTaxFact({ mode: "change", factKey: "household.filing_status", taxYear: 2026, valueText: "mfs", reason: "Filing separately" });
    expect(changed).toMatchObject({ ok: true, version: 2 });
    expect(rows()).toHaveLength(2);
    const [v1, v2] = rows();
    expect(v1!.archivedAt).toBeInstanceOf(Date);
    expect(v1!.valueText).toBe("mfj");
    expect(v2!.archivedAt).toBeNull();
    expect(v2!.valueText).toBe("mfs");
    expect(v2!.setByName).toBe("Eric");
    expect(v2!.reason).toBe("Filing separately");
  });

  it("reconfirm adds a version for the later year with the same value; policy change keeps value and year", async () => {
    await setTaxFact(createInput);
    expect(await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 })).toMatchObject({ ok: true, version: 2 });
    expect(await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 })).toMatchObject({ ok: false });
    expect(await setTaxFactPolicy({ factKey: "household.filing_status", carryPolicy: "stable" })).toMatchObject({ ok: true, version: 3 });
    const latest = rows().find((r) => r.version === 3)!;
    expect(latest.taxYear).toBe(2026);
    expect(latest.valueText).toBe("mfj");
    expect(latest.carryPolicy).toBe("stable");
  });

  it("retire inserts a retired version (never deletes); an open item is resolved instead", async () => {
    await setTaxFact(createInput);
    expect(await retireTaxFact({ factKey: "household.filing_status", taxYear: 2026, reason: "No longer applies" })).toMatchObject({ ok: true, version: 2 });
    expect(rows().map((r) => r.changeKind)).toEqual(["established", "retired"]);

    await setTaxFact({ mode: "create", factKey: "open.q", category: "open_item", label: "Q", valueKind: "open_item", valueText: "A question", carryPolicy: "stable", taxYear: 2025 });
    expect(await retireTaxFact({ factKey: "open.q", taxYear: 2026, reason: "Settled" })).toMatchObject({ ok: true });
    expect(rows().filter((r) => r.factKey === "open.q").map((r) => r.changeKind)).toEqual(["established", "resolved"]);
  });

  it("a change without a reason, or to the same value, writes nothing", async () => {
    await setTaxFact(createInput);
    const before = rows().length;
    expect(await setTaxFact({ mode: "change", factKey: "household.filing_status", taxYear: 2025, valueText: "mfs" })).toMatchObject({ ok: false });
    expect(await setTaxFact({ mode: "change", factKey: "household.filing_status", taxYear: 2025, valueText: "mfj", reason: "no real change" })).toMatchObject({ ok: false });
    expect(rows()).toHaveLength(before);
  });

  it("a unique-index race maps to a conflict result", async () => {
    state.failCreateWith = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
    const res = await setTaxFact(createInput);
    expect(res).toMatchObject({ ok: false, code: "conflict" });
  });

  it("a missing table maps to the migration-not-applied result", async () => {
    state.failFindWith = new Prisma.PrismaClientKnownRequestError("no table", { code: "P2021", clientVersion: "test" });
    const res = await setTaxFact({ mode: "change", factKey: "household.filing_status", taxYear: 2025, valueText: "mfs", reason: "because" });
    expect(res).toMatchObject({ ok: false, code: "migration_missing" });
    const seed = await seedTaxFactsTy2025();
    expect(seed).toMatchObject({ ok: false, code: "migration_missing" });
  });
});

describe("privacy: SSN-like or identifier text is refused before any db call", () => {
  it("reason, label, value and source reference", async () => {
    const ssn = "123-45-6789";
    const calls = [
      setTaxFact({ mode: "change", factKey: "a.b", taxYear: 2026, valueText: "x", reason: `my ssn ${ssn}` }),
      setTaxFact({ ...createInput, label: `Filing ${ssn}` }),
      setTaxFact({ ...createInput, valueKind: "text", valueText: "ein 12-3456789" }),
      setTaxFact({ ...createInput, sourceRef: "account 1234567" }),
      reconfirmTaxFact({ factKey: "a.b", taxYear: 2026, reason: `ssn ${ssn}` }),
      setTaxFactPolicy({ factKey: "a.b", carryPolicy: "stable", reason: `ssn ${ssn}` }),
      retireTaxFact({ factKey: "a.b", taxYear: 2026, reason: `ssn ${ssn}` }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).not.toContain("6789");
    }
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(mockDb.entity.findFirst).not.toHaveBeenCalled();
    expect(mockDb.taxFact.findMany).not.toHaveBeenCalled();
    expect(mockDb.taxFact.create).not.toHaveBeenCalled();
  });

  it("an invalid new fact (bad key, bad value) is refused before the db", async () => {
    expect(await setTaxFact({ ...createInput, factKey: "Bad Key" })).toMatchObject({ ok: false });
    expect(await setTaxFact({ ...createInput, valueKind: "bool", valueText: "maybe" })).toMatchObject({ ok: false });
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("seed", () => {
  it("is idempotent: the first run inserts every row once, the second inserts none", async () => {
    const first = await seedTaxFactsTy2025();
    expect(first).toEqual({ ok: true, inserted: TAX_FACTS_SEED_TY2025.length, alreadyPresent: 0, total: TAX_FACTS_SEED_TY2025.length });
    expect(rows()).toHaveLength(TAX_FACTS_SEED_TY2025.length);
    const second = await seedTaxFactsTy2025();
    expect(second).toEqual({ ok: true, inserted: 0, alreadyPresent: TAX_FACTS_SEED_TY2025.length, total: TAX_FACTS_SEED_TY2025.length });
    expect(rows()).toHaveLength(TAX_FACTS_SEED_TY2025.length);
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("writes version 1, established, with the spec date, source and policy, and nothing else", async () => {
    await seedTaxFactsTy2025();
    for (const r of rows()) {
      expect(r.version).toBe(1);
      expect(r.changeKind).toBe("established");
      expect(r.entityId).toBe(PERSONAL);
      expect((r.confirmedAt as Date).toISOString().slice(0, 10)).toBe("2026-10-07");
      expect(r.setByName).toBe("Eric");
    }
    expect(mockDb.taxFact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.taxFact.create).not.toHaveBeenCalled();
  });

  it("never overwrites a key the owner already edited (a key with any row is skipped)", async () => {
    await seedTaxFactsTy2025();
    await setTaxFact({ mode: "change", factKey: "household.filing_status", taxYear: 2026, valueText: "mfs", reason: "Filing separately" });
    const before = rows().length;
    const res = await seedTaxFactsTy2025();
    expect(res).toMatchObject({ ok: true, inserted: 0 });
    expect(rows()).toHaveLength(before);
    expect(rows().filter((r) => r.factKey === "household.filing_status" && r.archivedAt === null)[0]!.valueText).toBe("mfs");
  });

  it("only the missing keys are inserted when some exist", async () => {
    state.rows.push({
      id: "pre",
      entityId: PERSONAL,
      factKey: "household.filing_status",
      version: 1,
      archivedAt: null,
    });
    const res = await seedTaxFactsTy2025();
    expect(res).toMatchObject({ ok: true, inserted: TAX_FACTS_SEED_TY2025.length - 1, alreadyPresent: 1 });
  });

  it("the audit row holds counts and the seed version only", async () => {
    await seedTaxFactsTy2025();
    const call = mockDb.auditLog.create.mock.calls[0]![0] as { data: { changeType: string; after: Record<string, unknown> } };
    expect(call.data.changeType).toBe("tax_fact_seed");
    expect(Object.keys(call.data.after).sort()).toEqual(["inserted", "seedVersion", "total"]);
  });
});

describe("audit rows never carry a label, a value or a reason", () => {
  it("runtime: the audit payloads hold only the allowed keys", async () => {
    await setTaxFact({ ...createInput, label: "Secret label" });
    await setTaxFact({ mode: "change", factKey: "household.filing_status", taxYear: 2026, valueText: "mfs", reason: "Secret reason" });
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(2);
    const allowed = ["id", "version", "factKey", "category", "carryPolicy", "changeKind", "taxYear", "valueKind"].sort();
    for (const [arg] of mockDb.auditLog.create.mock.calls) {
      const data = (arg as { data: { before: unknown; after: Record<string, unknown> } }).data;
      expect(Object.keys(data.after).sort()).toEqual(allowed);
      if (data.before !== Prisma.JsonNull) expect(Object.keys(data.before as object).sort()).toEqual(allowed);
      expect(JSON.stringify(data)).not.toMatch(/Secret|mfs|mfj/);
    }
  });

  it("source: auditShape and every auditLog.create call name none of label / value / reason", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/tax-facts.ts"), "utf8").replace(/\r\n/g, "\n");
    const shapeStart = src.indexOf("function auditShape(");
    const shape = src.slice(shapeStart, src.indexOf("\n}\n", shapeStart));
    expect(shape.length).toBeGreaterThan(100);
    const slices = [shape];
    for (const m of src.matchAll(/auditLog\.create\(\{/g)) {
      const at = m.index ?? 0;
      slices.push(src.slice(at, src.indexOf("});", at)));
    }
    expect(slices.length).toBeGreaterThanOrEqual(3);
    for (const s of slices) expect(s).not.toMatch(/label|valueText|valueCents|reason|sourceRef/);
  });
});
