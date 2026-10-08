import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";

// Mocks at the db/auth boundary (repo convention: no integrated DB tests; nothing here touches a real database).
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

type Stored = {
  id: string; entityId: string; taxYear: number; seq: number; kind: string; filedOn: Date | null; note: string | null;
  byId: string | null; byName: string; at: Date; createdAt: Date;
};
const state = vi.hoisted(() => ({
  events: [] as unknown[],
  nextId: 1,
  failCreateWith: null as unknown,
  failFindWith: null as unknown,
}));

const mockDb = vi.hoisted(() => ({
  user: { findMany: vi.fn(), findUnique: vi.fn() },
  entity: { findFirst: vi.fn() },
  taxYearCloseEvent: { findMany: vi.fn(), create: vi.fn() },
  taxFact: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { closeTaxYear, reopenTaxYear } from "@/actions/tax-year-close";
import { reconfirmTaxFact } from "@/actions/tax-facts";
import { changeTaxFactForCarry } from "@/actions/tax-facts-carry";
import { CLOSED_CHECK_FAILED_MESSAGE, checkCarryTargetGuarded } from "@/lib/tax-facts-carry-guard";
import { loadYearCloseStates, readLatestClosedYear } from "@/lib/tax-year-close-store";

const ERIC = "11111111-1111-4111-8111-111111111111";
const EVA = "33333333-3333-4333-8333-333333333333";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const events = () => state.events as Stored[];

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
}
function p2021(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("missing", { code: "P2021", clientVersion: "test" });
}

function seedEvent(o: Partial<Stored> & { taxYear: number; seq: number; kind: string }): void {
  state.events.push({
    id: `ev-${state.nextId++}`, entityId: PERSONAL, filedOn: o.kind === "closed" ? new Date("2026-10-12T12:00:00Z") : null,
    note: null, byId: ERIC, byName: "Eric Kinniburgh", at: new Date("2026-10-12T15:00:00Z"), createdAt: new Date(), ...o,
  });
}

beforeEach(() => {
  // The actions read the clock ("not in the future"): pin it so a filing date of 2026-10-12 is in the past whenever this runs.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T15:00:00Z"));
  vi.clearAllMocks();
  state.events = [];
  state.nextId = 1;
  state.failCreateWith = null;
  state.failFindWith = null;
  authMock.mockResolvedValue({ user: { id: ERIC } });
  mockDb.user.findMany.mockResolvedValue([
    { id: ERIC, name: "Eric Kinniburgh" },
    { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" },
  ]);
  mockDb.entity.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if (args.where.slug === "ek-consulting") return { id: "ekc", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", navLabel: null, type: "business" };
    return { id: PERSONAL };
  });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
  mockDb.taxYearCloseEvent.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if (state.failFindWith) throw state.failFindWith;
    return events()
      .filter((e) => e.entityId === args.where.entityId && (args.where.taxYear === undefined || e.taxYear === args.where.taxYear))
      .sort((a, b) => a.taxYear - b.taxYear || a.seq - b.seq);
  });
  mockDb.taxYearCloseEvent.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    if (state.failCreateWith) throw state.failCreateWith;
    const dup = events().some((e) => e.entityId === args.data.entityId && e.taxYear === args.data.taxYear && e.seq === args.data.seq);
    if (dup) throw p2002();
    const row = { id: `ev-${state.nextId++}`, at: new Date(), createdAt: new Date(), ...args.data } as unknown as Stored;
    state.events.push(row);
    return row;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auth and owner gates", () => {
  it("an unauthenticated call throws before any db call", async () => {
    authMock.mockResolvedValue(null);
    await expect(closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" })).rejects.toThrow("Unauthorized");
    await expect(reopenTaxYear({ taxYear: 2025, reason: "Because" })).rejects.toThrow("Unauthorized");
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("the other household account is refused with zero writes", async () => {
    authMock.mockResolvedValue({ user: { id: EVA } });
    const a = await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toContain("Only the owner's own account");
    seedEvent({ taxYear: 2025, seq: 1, kind: "closed" });
    const b = await reopenTaxYear({ taxYear: 2025, reason: "Because" });
    expect(b.ok).toBe(false);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.taxYearCloseEvent.create).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(events()).toHaveLength(1);
  });

  it("when the owner cannot be named nobody can close (fail closed)", async () => {
    mockDb.entity.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      args.where.slug === "ek-consulting" ? null : { id: PERSONAL }
    );
    const r = await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" });
    expect(r.ok).toBe(false);
    expect(mockDb.taxYearCloseEvent.create).not.toHaveBeenCalled();
  });

  it("text that looks private, a bad date or a bad year is refused before ANY db call", async () => {
    const cases = [
      closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12", note: "confirmation 1234567890" }),
      closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12", note: "ssn 123-45-6789" }),
      closeTaxYear({ taxYear: 2025, filedOn: "2025-12-31" }),
      closeTaxYear({ taxYear: 2025, filedOn: "2999-01-01" }),
      closeTaxYear({ taxYear: 2025, filedOn: "not a date" }),
      closeTaxYear({ taxYear: 1999, filedOn: "2026-10-12" }),
      reopenTaxYear({ taxYear: 2025, reason: "ab" }),
      reopenTaxYear({ taxYear: 2025, reason: "EIN 12-3456789" }),
    ];
    for (const r of await Promise.all(cases)) expect(r.ok).toBe(false);
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(mockDb.entity.findFirst).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe("close and reopen insert rows", () => {
  it("the owner closes: one row seq 1, kind closed, filedOn stored at 12:00 UTC, one audit row", async () => {
    const r = await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12", note: "e-filed" });
    expect(r).toMatchObject({ ok: true, seq: 1, kind: "closed" });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ entityId: PERSONAL, taxYear: 2025, seq: 1, kind: "closed", note: "e-filed", byId: ERIC, byName: "Eric Kinniburgh" });
    expect(events()[0]!.filedOn?.toISOString()).toBe("2026-10-12T12:00:00.000Z");
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("closing twice is refused; reopen then close again gives seq 3; nothing is ever updated or deleted", async () => {
    expect((await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" })).ok).toBe(true);
    expect((await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-13" })).ok).toBe(false);
    expect(await reopenTaxYear({ taxYear: 2025, reason: "Corrected a form" })).toMatchObject({ ok: true, seq: 2, kind: "reopened" });
    expect((await reopenTaxYear({ taxYear: 2025, reason: "Again" })).ok).toBe(false);
    expect(await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-13" })).toMatchObject({ ok: true, seq: 3 });
    expect(events().map((e) => [e.seq, e.kind])).toEqual([[1, "closed"], [2, "reopened"], [3, "closed"]]);
    expect(Object.keys(mockDb.taxYearCloseEvent).sort()).toEqual(["create", "findMany"]);
  });

  it("the audit row holds ids, the year, the seq and the kind only: never the note, the reason, the date or a name", async () => {
    await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12", note: "UNIQUE-NOTE-TEXT" });
    await reopenTaxYear({ taxYear: 2025, reason: "UNIQUE-REASON-TEXT" });
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(2);
    const audit = JSON.stringify(mockDb.auditLog.create.mock.calls);
    for (const secret of ["UNIQUE-NOTE-TEXT", "UNIQUE-REASON-TEXT", "2026-10-12", "Eric", "Kinniburgh"]) expect(audit).not.toContain(secret);
    const first = mockDb.auditLog.create.mock.calls[0]![0] as { data: { changeType: string; after: Record<string, unknown> } };
    expect(first.data.changeType).toBe("tax_year_close");
    expect(Object.keys(first.data.after).sort()).toEqual(["id", "kind", "seq", "taxYear"]);
    const second = mockDb.auditLog.create.mock.calls[1]![0] as { data: { changeType: string } };
    expect(second.data.changeType).toBe("tax_year_reopen");
  });

  it("two racing tabs: the second insert hits the unique index and gets a conflict result, not a second row", async () => {
    // both tabs read an open year, so both plan seq 1; the second create throws P2002
    seedEvent({ taxYear: 2026, seq: 1, kind: "closed" }); // another year's row must not matter
    const first = await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" });
    expect(first.ok).toBe(true);
    mockDb.taxYearCloseEvent.findMany.mockResolvedValueOnce([]); // the stale read of the second tab
    const second = await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" });
    expect(second).toMatchObject({ ok: false, code: "conflict" });
    expect(events().filter((e) => e.taxYear === 2025)).toHaveLength(1);
  });

  it("a missing table is a migration_missing result", async () => {
    state.failFindWith = p2021();
    expect(await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" })).toMatchObject({ ok: false, code: "migration_missing" });
  });

  it("revalidates the pages that show the year", async () => {
    await closeTaxYear({ taxYear: 2025, filedOn: "2026-10-12" });
    const paths = revalidateMock.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(expect.arrayContaining(["/tax", "/tax/forms/2025", "/tax/personal/2025", "/tax/donations/2025", "/tax/fixed-assets/2025", "/tax/facts"]));
  });
});

describe("readers: display is fail-soft, the guard is fail-closed", () => {
  it("loadYearCloseStates never throws: missing table, no entity, error", async () => {
    state.failFindWith = p2021();
    expect(await loadYearCloseStates()).toEqual({ state: "table_missing" });
    state.failFindWith = new Error("boom");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await loadYearCloseStates()).toEqual({ state: "error" });
    expect(spy.mock.calls.flat().join(" ")).not.toContain("boom");
    spy.mockRestore();
    state.failFindWith = null;
    mockDb.entity.findFirst.mockResolvedValue(null);
    expect(await loadYearCloseStates()).toEqual({ state: "no_entity" });
  });

  it("readLatestClosedYear: ok/null for a missing table or no entity, ok:false for any other error", async () => {
    state.failFindWith = p2021();
    expect(await readLatestClosedYear()).toEqual({ ok: true, year: null });
    state.failFindWith = new Error("db down");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await readLatestClosedYear()).toEqual({ ok: false });
    spy.mockRestore();
    state.failFindWith = null;
    mockDb.entity.findFirst.mockResolvedValue(null);
    expect(await readLatestClosedYear()).toEqual({ ok: true, year: null });
  });

  it("an event with an unrecognised kind makes the display state an error, never a guess", async () => {
    seedEvent({ taxYear: 2026, seq: 1, kind: "weird" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await loadYearCloseStates()).toEqual({ state: "error" });
    expect(await readLatestClosedYear()).toEqual({ ok: false });
    spy.mockRestore();
  });
});

describe("the carry guard", () => {
  const NOW = new Date("2026-10-13T15:00:00Z");

  it("with nothing closed: 2026 allowed, 2025 refused without reading the database", async () => {
    expect(await checkCarryTargetGuarded(2026, NOW)).toEqual({ ok: true });
    mockDb.entity.findFirst.mockClear();
    const r = await checkCarryTargetGuarded(2025, NOW);
    expect(r.ok).toBe(false);
    expect(mockDb.entity.findFirst).not.toHaveBeenCalled();
  });

  it("a closed 2026 refuses 2026 (message names the Tax Forms page) and allows 2027", async () => {
    seedEvent({ taxYear: 2026, seq: 1, kind: "closed" });
    const r = await checkCarryTargetGuarded(2026, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Tax Forms page");
    expect((await checkCarryTargetGuarded(2027, NOW)).ok).toBe(true);
  });

  it("a reopened 2026 no longer blocks", async () => {
    seedEvent({ taxYear: 2026, seq: 1, kind: "closed" });
    seedEvent({ taxYear: 2026, seq: 2, kind: "reopened", note: "why" });
    expect((await checkCarryTargetGuarded(2026, NOW)).ok).toBe(true);
  });

  it("a closed TY2025 does not change the 2026 target (2025 is already refused by the floor)", async () => {
    seedEvent({ taxYear: 2025, seq: 1, kind: "closed" });
    expect((await checkCarryTargetGuarded(2026, NOW)).ok).toBe(true);
  });

  it("a read failure other than a missing table refuses the write", async () => {
    state.failFindWith = new Error("db down");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await checkCarryTargetGuarded(2026, NOW)).toEqual({ ok: false, error: CLOSED_CHECK_FAILED_MESSAGE });
    spy.mockRestore();
  });

  it("both carry actions refuse a closed 2026 and write nothing; with it reopened they write", async () => {
    mockDb.taxFact.findMany.mockResolvedValue([
      {
        id: "f1", entityId: PERSONAL, factKey: "household.filing_status", version: 1, category: "household", label: "Filing status",
        taxYear: 2025, valueKind: "choice", valueCents: null, valueText: "mfj", carryPolicy: "reconfirm", changeKind: "established",
        sourceKind: "owner_statement", sourceRef: null, reason: null, confirmedAt: new Date(), setByName: "Eric", setAt: new Date(), archivedAt: null,
      },
    ]);
    mockDb.taxFact.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: "f2", ...a.data }));
    mockDb.taxFact.updateMany.mockResolvedValue({ count: 1 });
    mockDb.user.findUnique.mockResolvedValue({ name: "Eric" });
    seedEvent({ taxYear: 2026, seq: 1, kind: "closed" });

    const r1 = await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 });
    const r2 = await changeTaxFactForCarry({ factKey: "household.filing_status", taxYear: 2026, valueText: "mfs", reason: "Filing separately" });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(mockDb.taxFact.create).not.toHaveBeenCalled();
    expect(mockDb.taxFact.updateMany).not.toHaveBeenCalled();

    seedEvent({ taxYear: 2026, seq: 2, kind: "reopened", note: "why" });
    const r3 = await reconfirmTaxFact({ factKey: "household.filing_status", taxYear: 2026 });
    expect(r3.ok).toBe(true);
    expect(mockDb.taxFact.create).toHaveBeenCalledTimes(1);
  });
});

describe("source shape", () => {
  const src = readFileSync(resolve(__dirname, "../../actions/tax-year-close.ts"), "utf8").replace(/\r\n/g, "\n");

  it("a use-server file whose two exports each start with `const user = await requireAuth();`", () => {
    expect(src.startsWith('"use server";')).toBe(true);
    const names = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort();
    expect(names).toEqual(["closeTaxYear", "reopenTaxYear"]);
    for (const name of names) {
      const start = src.indexOf(`export async function ${name}`);
      const open = src.indexOf("{\n", start) + 2;
      expect(src.slice(open, open + 60).trimStart().startsWith("const user = await requireAuth();"), name).toBe(true);
    }
  });

  it("the privacy checks run before the owner check and the insert", () => {
    const close = src.slice(src.indexOf("export async function closeTaxYear"), src.indexOf("export async function reopenTaxYear"));
    expect(close.indexOf("validateCloseNote(")).toBeLessThan(close.indexOf("authorize("));
    expect(close.indexOf("parseFiledOn(")).toBeLessThan(close.indexOf("authorize("));
    expect(close.indexOf("authorize(")).toBeLessThan(close.indexOf("insertCloseEvent("));
    const reopen = src.slice(src.indexOf("export async function reopenTaxYear"));
    expect(reopen.indexOf("validateReopenReason(")).toBeLessThan(reopen.indexOf("authorize("));
  });

  it("the audit shape in the store excludes the note, reason, filing date and names", () => {
    const store = readFileSync(resolve(__dirname, "../../lib/tax-year-close-store.ts"), "utf8").replace(/\r\n/g, "\n");
    const slice = store.slice(store.indexOf("tx.auditLog.create"), store.indexOf("return { ok: true, id: row.id"));
    expect(slice).toContain("after: { id: row.id, taxYear: row.taxYear, seq: row.seq, kind: row.kind }");
    expect(slice).not.toMatch(/note|reason|filedOn|byName|name/);
  });
});
