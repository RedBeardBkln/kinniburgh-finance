import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Mocks at the db/auth boundary (repo convention: no integrated DB tests; nothing here touches a real database).
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type Row = Record<string, unknown> & { id: string; entityId: string; factKey: string; version: number; archivedAt: Date | null };
const state = vi.hoisted(() => ({ rows: [] as unknown[], nextId: 1 }));

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  entity: { findFirst: vi.fn() },
  taxFact: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { reconfirmTaxFact } from "@/actions/tax-facts";
import { changeTaxFactForCarry } from "@/actions/tax-facts-carry";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const rows = () => state.rows as Row[];

function matches(r: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "id" && typeof v === "object" && v !== null && "in" in v) {
      if (!(v as { in: string[] }).in.includes(r.id)) return false;
    } else if (r[k] !== v) return false;
  }
  return true;
}

function seedRow(o: Partial<Row>): Row {
  const row = {
    id: `fact-${state.nextId++}`,
    entityId: PERSONAL,
    factKey: "household.filing_status",
    version: 1,
    category: "household",
    label: "Filing status",
    taxYear: 2025,
    valueKind: "choice",
    valueCents: null,
    valueText: "mfj",
    carryPolicy: "reconfirm",
    changeKind: "established",
    sourceKind: "owner_statement",
    sourceRef: null,
    reason: null,
    confirmedAt: new Date("2026-10-07T15:00:00Z"),
    setByName: "Eric",
    setAt: new Date("2026-10-07T15:00:00Z"),
    archivedAt: null,
    ...o,
  } as unknown as Row;
  state.rows.push(row);
  return row;
}

function noDbCalls() {
  expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  expect(mockDb.entity.findFirst).not.toHaveBeenCalled();
  expect(mockDb.taxFact.findMany).not.toHaveBeenCalled();
  expect(mockDb.taxFact.create).not.toHaveBeenCalled();
  expect(mockDb.taxFact.updateMany).not.toHaveBeenCalled();
  expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  expect(mockDb.$transaction).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.nextId = 1;
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.user.findUnique.mockResolvedValue({ name: "Eric" });
  mockDb.entity.findFirst.mockResolvedValue({ id: PERSONAL });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
  mockDb.taxFact.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    rows().filter((r) => matches(r, args.where)).sort((a, b) => b.version - a.version)
  );
  mockDb.taxFact.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    const row = { id: `fact-${state.nextId++}`, archivedAt: null, setAt: new Date(), ...args.data } as unknown as Row;
    state.rows.push(row);
    return row;
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

describe("the carry screen's writers refuse TY2025 and earlier before any database call", () => {
  it("reconfirmTaxFact refuses 2025 and 2024", async () => {
    for (const taxYear of [2025, 2024]) {
      const res = await reconfirmTaxFact({ factKey: "household.filing_status", taxYear });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("TY2025 and earlier");
    }
    noDbCalls();
  });

  it("changeTaxFactForCarry refuses 2025 and 2024", async () => {
    for (const taxYear of [2025, 2024]) {
      const res = await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear, valueText: "mfs", reason: "Filing separately" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("TY2025 and earlier");
    }
    noDbCalls();
  });

  it("both refuse a year too far ahead", async () => {
    const r1 = await reconfirmTaxFact({ factKey: "a.b", taxYear: 2100 });
    const r2 = await changeTaxFactForCarry({ factKey: "a.b", taxYear: 2100, valueText: "x", reason: "because" });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    noDbCalls();
  });

  it("an unauthenticated call throws before any database call", async () => {
    authMock.mockResolvedValue(null);
    await expect(changeTaxFactForCarry({ factKey: "a.b", taxYear: 2026, valueText: "x", reason: "because" })).rejects.toThrow("Unauthorized");
    await expect(reconfirmTaxFact({ factKey: "a.b", taxYear: 2026 })).rejects.toThrow("Unauthorized");
    noDbCalls();
  });

  it("an SSN-like reason is refused before the database", async () => {
    const res = await changeTaxFactForCarry({ factKey: "a.b", taxYear: 2026, valueText: "x", reason: "my ssn 123-45-6789" });
    expect(res.ok).toBe(false);
    noDbCalls();
  });

  it("nothing touches a TY2025 fact: refusing leaves the stored row untouched", async () => {
    const v1 = seedRow({});
    const before = JSON.stringify(v1);
    await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2025 });
    await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear: 2025, valueText: "mfs", reason: "Filing separately" });
    expect(rows()).toHaveLength(1);
    expect(JSON.stringify(rows()[0])).toBe(before);
  });
});

describe("the carry screen's writers add versions for the target year, append-only", () => {
  it("reconfirm for 2026 inserts version 2 with taxYear 2026 and only archives version 1", async () => {
    seedRow({});
    const res = await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 });
    expect(res).toMatchObject({ ok: true, version: 2 });
    expect(rows()).toHaveLength(2);
    const v1 = rows().find((r) => r.version === 1)!;
    const v2 = rows().find((r) => r.version === 2)!;
    expect(v1.archivedAt).toBeInstanceOf(Date);
    expect(v1.valueText).toBe("mfj");
    expect(v1.taxYear).toBe(2025);
    expect(v2).toMatchObject({ taxYear: 2026, changeKind: "reconfirmed", valueText: "mfj", archivedAt: null });
    expect(mockDb.taxFact.updateMany).toHaveBeenCalledTimes(1);
    const call = mockDb.taxFact.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(Object.keys(call.data).sort()).toEqual(["archivedAt", "archivedById"]);
  });

  it("change for the carry screen inserts version 2, changeKind changed, taxYear 2026", async () => {
    seedRow({});
    const res = await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear: 2026, valueText: "mfs", reason: "Filing separately" });
    expect(res).toMatchObject({ ok: true, version: 2 });
    const v2 = rows().find((r) => r.version === 2)!;
    expect(v2).toMatchObject({ taxYear: 2026, changeKind: "changed", valueText: "mfs" });
    expect(rows().find((r) => r.version === 1)!.valueText).toBe("mfj");
  });

  it("a same-value change is refused (the same-answer path is the explicit reconfirm)", async () => {
    seedRow({});
    const res = await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear: 2026, valueText: "mfj", reason: "Still the same" });
    expect(res.ok).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  it("an open item cannot be reconfirmed through the carry writer", async () => {
    seedRow({ factKey: "open.q", category: "open_item", valueKind: "open_item", valueText: "A question", carryPolicy: "stable" });
    const res = await reconfirmTaxFact({ factKey: "open.q", taxYear: 2026 });
    expect(res.ok).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  it("the audit row holds ids, key, version, year and kind only, never the value or the reason", async () => {
    seedRow({});
    await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear: 2026, valueText: "mfs", reason: "Unique reason text" });
    const audit = JSON.stringify(mockDb.auditLog.create.mock.calls);
    expect(audit).not.toContain("Unique reason text");
    expect(audit).not.toContain("mfs");
    expect(audit).toContain("household.filing_status");
  });
});

describe("source shape", () => {
  const src = readFileSync(resolve(__dirname, "../../actions/tax-facts-carry.ts"), "utf8").replace(/\r\n/g, "\n");

  it("is a use-server file whose only export starts with requireAuth()", () => {
    expect(src.startsWith('"use server";')).toBe(true);
    const names = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    expect(names).toEqual(["changeTaxFactForCarry"]);
    const start = src.indexOf("export async function changeTaxFactForCarry");
    const open = src.indexOf("{\n", start) + 2;
    expect(src.slice(open, open + 40).trimStart().startsWith("await requireAuth();")).toBe(true);
  });

  it("takes one fact key per call: no array parameter, no Promise.all", () => {
    expect(src).toMatch(/factKey:\s*z\.string\(\)/);
    expect(src).not.toMatch(/factKeys|z\.array|Promise\.all/);
  });

  it("checks the target year before it delegates", () => {
    expect(src.indexOf("checkCarryTarget(")).toBeGreaterThan(0);
    expect(src.indexOf("checkCarryTarget(")).toBeLessThan(src.indexOf("await setTaxFact("));
  });

  it("reconfirmTaxFact checks the target year before any db call", () => {
    const s = readFileSync(resolve(__dirname, "../../actions/tax-facts.ts"), "utf8").replace(/\r\n/g, "\n");
    const start = s.indexOf("export async function reconfirmTaxFact");
    const end = s.indexOf("export async function setTaxFactPolicy");
    const body = s.slice(start, end);
    expect(body.indexOf("checkCarryTarget(")).toBeGreaterThan(0);
    expect(body.indexOf("checkCarryTarget(")).toBeLessThan(body.indexOf("loadWriter("));
  });
});
