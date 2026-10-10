// carry-forward-seasonal-energy, step 2: the owner actions on the Seasonal bills card (actions/seasonal-settings.ts):
// the heating-oil price list and the per-row "Not heating oil" mark. Auth first, validation, idempotence, caps, and an
// AuditLog that carries ids and counts only. The database boundary is mocked; no test touches a real database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  db: {
    entity: { findFirst: vi.fn(), findMany: vi.fn() },
    transaction: { findFirst: vi.fn(), findMany: vi.fn() },
    appSetting: { findUnique: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ db: m.db }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));

import { addOilPrice, removeOilPrice, setMcCarthyNotOil } from "@/actions/seasonal-settings";
import { OIL_EXCLUDED_CAP, OIL_PRICE_CAP, type OilPriceEntry } from "@/lib/seasonal-energy-prices";

const ENT = "6f55fa50-9d94-47a8-92d6-2cc5abeac714";
const EKC = "88734d5a-c7d2-4a14-94b0-5eb0dddaea21";
const SVID = "73edfe3c-f043-4f73-a8ab-3de6591d29d4";
const TX = "0b5a1037-03e1-43ad-bfe7-6be922c61ac4";
const UUID_N = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1" } });
  m.db.entity.findFirst.mockResolvedValue({ id: ENT });
  m.db.transaction.findMany.mockResolvedValue([]);
  m.db.appSetting.findUnique.mockResolvedValue(null);
  m.db.appSetting.upsert.mockResolvedValue({});
  m.db.auditLog.create.mockResolvedValue({});
});

const written = () => (m.db.appSetting.upsert.mock.calls[0]![0] as { where: { key: string }; create: { value: string } });

describe("auth comes first in every export", () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["addOilPrice", () => addOilPrice({ entityId: ENT, effectiveOn: "2026-10-01", pricePerGal: "3.5" })],
    ["removeOilPrice", () => removeOilPrice({ entityId: ENT, id: "x" })],
    ["setMcCarthyNotOil", () => setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })],
  ];
  it.each(calls)("%s rejects an anonymous caller before any database access", async (_name, run) => {
    m.auth.mockResolvedValue(null);
    await expect(run()).rejects.toThrow("Unauthorized");
    m.auth.mockResolvedValue({ user: {} });
    await expect(run()).rejects.toThrow("Unauthorized");
    for (const table of Object.values(m.db)) for (const fn of Object.values(table)) expect(fn).not.toHaveBeenCalled();
  });

  it("the source pins it: every exported async function starts with `await requireAuth();`", () => {
    const src = readFileSync(resolve(__dirname, "../..", "actions/seasonal-settings.ts"), "utf8");
    const exported = [...src.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\n([^\n]*)\n/g)];
    expect(exported.map((x) => x[1])).toEqual(["addOilPrice", "removeOilPrice", "setMcCarthyNotOil"]);
    for (const x of exported) expect(x[2], x[1]).toMatch(/await requireAuth\(\);/);
    expect(src.startsWith('"use server";')).toBe(true);
  });
});

describe("addOilPrice", () => {
  it("saves a normalised entry as a decimal STRING under the entity's key; AuditLog has ids and counts only", async () => {
    const r = await addOilPrice({ entityId: ENT, effectiveOn: "2026-10-01", pricePerGal: "3.5", note: "invoice 12" });
    expect(r).toEqual({ success: true });
    const w = written();
    expect(w.where.key).toBe(`oil_price_history:${ENT}`);
    const saved = JSON.parse(w.create.value) as OilPriceEntry[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ effectiveOn: "2026-10-01", pricePerGal: "3.50", note: "invoice 12" });
    expect(typeof saved[0]!.pricePerGal).toBe("string");
    const audit = m.db.auditLog.create.mock.calls[0]![0] as { data: { changedBy: string; changeType: string; after: Record<string, unknown> } };
    expect(audit.data.changedBy).toBe("user-1");
    expect(audit.data.changeType).toBe("oil_price_add");
    expect(Object.keys(audit.data.after).sort()).toEqual(["entityId", "entries", "entryId"]);
    expect(JSON.stringify(audit)).not.toMatch(/3\.5|invoice|2026-10-01/);
    expect(m.revalidatePath).toHaveBeenCalledWith("/forecast");
  });

  it("appends to the existing list, keeping earlier entries (including removed ones)", async () => {
    const existing: OilPriceEntry[] = [{ id: "old", effectiveOn: "2025-11-01", pricePerGal: "4.10", removed: true }];
    m.db.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify(existing) });
    await addOilPrice({ entityId: ENT, effectiveOn: "2026-10-01", pricePerGal: 3.75 });
    const saved = JSON.parse(written().create.value) as OilPriceEntry[];
    expect(saved.map((e) => e.id)).toHaveLength(2);
    expect(saved[0]).toEqual(existing[0]);
    expect(saved[1]!.pricePerGal).toBe("3.75");
  });

  it.each([
    ["zero", { pricePerGal: "0" }],
    ["negative", { pricePerGal: "-3" }],
    ["too high", { pricePerGal: "25" }],
    ["five decimals", { pricePerGal: "3.12345" }],
    ["text", { pricePerGal: "abc" }],
    ["bad date", { effectiveOn: "10/01/2026" }],
    ["far future", { effectiveOn: "2031-01-01" }],
    ["long note", { note: "x".repeat(130) }],
  ])("rejects %s without writing anything", async (_label, over) => {
    const r = await addOilPrice({ entityId: ENT, effectiveOn: "2026-10-01", pricePerGal: "3.5", ...over });
    expect("error" in r).toBe(true);
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
    expect(m.db.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses a note that looks like a personal number", async () => {
    const r = await addOilPrice({ entityId: ENT, effectiveOn: "2026-10-01", pricePerGal: "3.5", note: "acct 123-45-6789" });
    expect(r).toEqual({ error: "The note looks like it holds a personal number; please leave that out." });
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it("a malformed request or an unknown entity is 'Invalid request'", async () => {
    expect(await addOilPrice({ entityId: "not-a-uuid", effectiveOn: "2026-10-01", pricePerGal: "3.5" })).toEqual({ error: "Invalid request" });
    m.db.entity.findFirst.mockResolvedValue(null);
    expect(await addOilPrice({ entityId: ENT, effectiveOn: "2026-10-01", pricePerGal: "3.5" })).toEqual({ error: "Invalid request" });
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it("an unreadable saved list is never overwritten", async () => {
    m.db.appSetting.findUnique.mockResolvedValue({ value: "{broken" });
    const r = await addOilPrice({ entityId: ENT, effectiveOn: "2026-10-01", pricePerGal: "3.5" });
    expect(r).toEqual({ error: "The saved price list could not be read, so nothing was changed." });
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it("the list is capped (removed entries count)", async () => {
    const full = Array.from({ length: OIL_PRICE_CAP }, (_, i) => ({ id: `id${i}`, effectiveOn: "2026-01-01", pricePerGal: "3.00", removed: true }));
    m.db.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify(full) });
    const r = await addOilPrice({ entityId: ENT, effectiveOn: "2026-10-01", pricePerGal: "3.5" });
    expect("error" in r).toBe(true);
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  });
});

describe("removeOilPrice", () => {
  const list: OilPriceEntry[] = [
    { id: "a", effectiveOn: "2025-11-01", pricePerGal: "4.10" },
    { id: "b", effectiveOn: "2026-06-01", pricePerGal: "3.50" },
  ];
  it("marks the entry removed and keeps it", async () => {
    m.db.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify(list) });
    expect(await removeOilPrice({ entityId: ENT, id: "a" })).toEqual({ success: true });
    const saved = JSON.parse(written().create.value) as OilPriceEntry[];
    expect(saved).toEqual([{ ...list[0], removed: true }, list[1]]);
    const audit = m.db.auditLog.create.mock.calls[0]![0] as { data: { changeType: string; after: Record<string, unknown> } };
    expect(audit.data.changeType).toBe("oil_price_remove");
    expect(JSON.stringify(audit)).not.toMatch(/4\.10|2025-11-01/);
  });
  it("an unknown id or a malformed request writes nothing", async () => {
    m.db.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify(list) });
    expect("error" in (await removeOilPrice({ entityId: ENT, id: "zzz" }))).toBe(true);
    expect(await removeOilPrice({ entityId: "nope", id: "a" })).toEqual({ error: "Invalid request" });
    expect(await removeOilPrice({ entityId: ENT, id: "" })).toEqual({ error: "Invalid request" });
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  });
});

describe("setMcCarthyNotOil", () => {
  const SIG = { a: UUID_N(500), c: 103675, p: "mccarthy heating oil", on: "2026-10-09" };
  const tx = (over: Record<string, unknown> = {}) => ({
    id: TX,
    entityId: ENT,
    accountId: UUID_N(500),
    amount: "-1036.75",
    postedAt: new Date("2026-10-09T00:00:00Z"),
    payeeNormalized: "mccarthy heating oil",
    payeeRaw: null,
    description: null,
    tags: [],
    ...over,
  });
  const entities = (txEntity: { id: string; slug: string | null } = { id: ENT, slug: "personal" }, site = { id: ENT, slug: "personal" }) => {
    m.db.entity.findMany.mockResolvedValue(site.id === txEntity.id ? [site] : [site, txEntity]);
  };
  const stored = (marks: unknown[]) => m.db.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify(marks) });
  const savedMarks = () => JSON.parse(written().create.value) as Array<{ id: string; sig?: typeof SIG }>;
  beforeEach(() => {
    m.db.transaction.findFirst.mockResolvedValue(tx());
    entities();
  });

  it("marks a McCarthy row on the site's own books: saves the id AND its durable signature; AuditLog has ids and counts", async () => {
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ success: true });
    const w = written();
    expect(w.where.key).toBe(`oil_not_heating:${ENT}`);
    expect(savedMarks()).toEqual([{ id: TX, sig: SIG }]);
    const audit = m.db.auditLog.create.mock.calls[0]![0] as { data: { changeType: string; after: Record<string, unknown> } };
    expect(audit.data.changeType).toBe("oil_row_excluded");
    expect(audit.data.after).toEqual({ entityId: ENT, transactionId: TX, entries: 1 });
    expect(JSON.stringify(audit)).not.toMatch(/103675|mccarthy|1036/i); // the signature stays in the setting, never in the audit
    expect(m.revalidatePath).toHaveBeenCalledWith("/forecast");
    const q = m.db.transaction.findFirst.mock.calls[0]![0] as { where: Record<string, unknown>; select: Record<string, unknown> };
    expect(q.where).toEqual({ id: TX, archivedAt: null });
    expect(Object.keys(q.select).sort()).toEqual(["accountId", "amount", "description", "entityId", "id", "payeeNormalized", "payeeRaw", "postedAt", "tags"]);
  });

  it("is idempotent: marking an already-marked row, or counting an unmarked one, writes nothing", async () => {
    stored([{ id: TX, sig: SIG }]);
    m.db.transaction.findMany.mockResolvedValue([{ id: TX }]);
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ success: true });
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
    m.db.appSetting.findUnique.mockResolvedValue({ value: "[]" });
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: false })).toEqual({ success: true });
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
    expect(m.db.auditLog.create).not.toHaveBeenCalled();
  });

  it("an entry saved in the first (id-only) format is upgraded with its signature on the next click", async () => {
    m.db.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify([TX]) });
    m.db.transaction.findMany.mockResolvedValue([{ id: TX }]);
    await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true });
    expect(savedMarks()).toEqual([{ id: TX, sig: SIG }]);
  });

  it("toggles off: the entry is removed and the others stay", async () => {
    const other = { id: UUID_N(7), sig: { ...SIG, a: UUID_N(501), c: 5000 } };
    stored([other, { id: TX, sig: SIG }]);
    m.db.transaction.findMany.mockResolvedValue([{ id: UUID_N(7) }, { id: TX }]);
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: false })).toEqual({ success: true });
    expect(savedMarks()).toEqual([other]);
    expect((m.db.auditLog.create.mock.calls[0]![0] as { data: { changeType: string } }).data.changeType).toBe("oil_row_included");
  });

  // ── D1: a mark survives the pending -> posted re-id ──
  it("the posted twin of a marked PENDING row: marking it again replaces the stale entry in the same slot (no extra cap slot)", async () => {
    const PENDING_ID = UUID_N(800);
    stored([{ id: PENDING_ID, sig: { ...SIG, on: "2026-10-08" } }]); // the pending row, one day earlier
    m.db.transaction.findMany.mockResolvedValue([]); // the pending id no longer exists (archived by the sync)
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ success: true });
    expect(savedMarks()).toEqual([{ id: TX, sig: SIG }]);
    expect((m.db.auditLog.create.mock.calls[0]![0] as { data: { after: Record<string, unknown> } }).data.after).toMatchObject({ entries: 1 });
  });

  it("'Count it again' on the posted twin removes the stale entry (id and signature go together)", async () => {
    stored([{ id: UUID_N(800), sig: { ...SIG, on: "2026-10-08" } }]);
    m.db.transaction.findMany.mockResolvedValue([]);
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: false })).toEqual({ success: true });
    expect(savedMarks()).toEqual([]);
  });

  it("two identical charges are two decisions: a LIVE marked row is never taken over by a look-alike", async () => {
    const FIRST = UUID_N(801);
    stored([{ id: FIRST, sig: SIG }]);
    m.db.transaction.findMany.mockResolvedValue([{ id: FIRST }]); // the first row still exists
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ success: true });
    expect(savedMarks().map((e) => e.id)).toEqual([FIRST, TX]);
    // counting the second one again leaves the first marked
    stored([{ id: FIRST, sig: SIG }, { id: TX, sig: SIG }]);
    m.db.transaction.findMany.mockResolvedValue([{ id: FIRST }, { id: TX }]);
    m.db.appSetting.upsert.mockClear();
    await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: false });
    expect(savedMarks().map((e) => e.id)).toEqual([FIRST]);
  });

  it("a stale entry outside the window, on another account, or of another amount is NOT taken over", async () => {
    for (const sig of [{ ...SIG, on: "2026-09-20" }, { ...SIG, a: UUID_N(999) }, { ...SIG, c: 103676 }, { ...SIG, p: "valero" }]) {
      m.db.appSetting.upsert.mockClear();
      stored([{ id: UUID_N(802), sig }]);
      m.db.transaction.findMany.mockResolvedValue([]);
      await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true });
      expect(savedMarks().map((e) => e.id), JSON.stringify(sig)).toEqual([UUID_N(802), TX]);
    }
  });

  it("the list is capped at the limit; a new id at the cap is refused, an existing one can still be removed", async () => {
    const full = Array.from({ length: OIL_EXCLUDED_CAP }, (_, i) => ({ id: UUID_N(i + 100), sig: { ...SIG, a: UUID_N(2000 + i) } }));
    stored(full);
    m.db.transaction.findMany.mockResolvedValue(full.map((f) => ({ id: f.id })));
    const r = await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true });
    expect("error" in r).toBe(true);
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: full[0]!.id, notOil: false })).toEqual({ success: true });
    expect(savedMarks()).toHaveLength(OIL_EXCLUDED_CAP - 1);
  });

  it("the transaction must exist and not be archived", async () => {
    m.db.transaction.findFirst.mockResolvedValue(null);
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ error: "That transaction was not found." });
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it("its payee must be McCarthy heating oil (or, on the site's own books, it must carry an oil budget tag): anything else is refused", async () => {
    for (const payee of ["pse&g", "mccarthy plumbing", "eversource", ""]) {
      m.db.transaction.findFirst.mockResolvedValue(tx({ payeeNormalized: payee }));
      const r = await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true });
      expect(r, payee).toEqual({ error: "Only payments counted in this property's oil history can be marked this way." });
    }
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
    // the raw payee or the bank description also count
    m.db.transaction.findFirst.mockResolvedValue(tx({ payeeNormalized: null, description: "MCCARTHY HEATING OIL SERV" }));
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ success: true });
  });

  // ── D4: any row the model counts in the oil history can be marked ──
  it("a row counted by its TAG (non-McCarthy payee) on the site's own books can be marked", async () => {
    m.db.transaction.findFirst.mockResolvedValue(tx({ payeeNormalized: "valley fuel co", tags: [{ tag: { name: "Utilities / Oil" } }] }));
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ success: true });
    expect(savedMarks()[0]!.id).toBe(TX);
  });

  it("a tag that is not an oil line does not make a row part of the oil history", async () => {
    m.db.transaction.findFirst.mockResolvedValue(tx({ payeeNormalized: "valley fuel co", tags: [{ tag: { name: "Home & Property / Home Repair" } }] }));
    expect("error" in (await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true }))).toBe(true);
  });

  it("a supplier payee decides the kind first: an Eversource row tagged Oil is not oil-history", async () => {
    m.db.transaction.findFirst.mockResolvedValue(tx({ payeeNormalized: "eversource", tags: [{ tag: { name: "Utilities / Oil" } }] }));
    expect("error" in (await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true }))).toBe(true);
  });

  it("another entity's row is accepted only for the EK Consulting McCarthy payee on the Personal house, even if it is tagged Oil", async () => {
    m.db.transaction.findFirst.mockResolvedValue(tx({ entityId: EKC }));
    entities({ id: EKC, slug: "ek-consulting" }, { id: ENT, slug: "personal" });
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ success: true });
    m.db.appSetting.upsert.mockClear();
    m.db.transaction.findFirst.mockResolvedValue(tx({ entityId: EKC, payeeNormalized: "valley fuel co", tags: [{ tag: { name: "Utilities / Oil" } }] }));
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ error: "That payment does not belong to this property's oil history." });
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it("the EK Consulting card row may be marked on the Personal house, but not on Sudden Valley, and nothing else crosses entities", async () => {
    m.db.transaction.findFirst.mockResolvedValue(tx({ entityId: EKC }));
    entities({ id: EKC, slug: "ek-consulting" }, { id: ENT, slug: "personal" });
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ success: true });
    m.db.appSetting.upsert.mockClear();
    entities({ id: EKC, slug: "ek-consulting" }, { id: SVID, slug: "sudden-valley" });
    const sv = await setMcCarthyNotOil({ entityId: SVID, transactionId: TX, notOil: true });
    expect(sv).toEqual({ error: "That payment does not belong to this property's oil history." });
    m.db.transaction.findFirst.mockResolvedValue(tx({ entityId: SVID }));
    entities({ id: SVID, slug: "sudden-valley" }, { id: ENT, slug: "personal" });
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ error: "That payment does not belong to this property's oil history." });
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it("malformed requests, an unknown entity and an unreadable saved list are refused without writing", async () => {
    expect(await setMcCarthyNotOil({ entityId: "x", transactionId: TX, notOil: true })).toEqual({ error: "Invalid request" });
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: "not-a-uuid", notOil: true })).toEqual({ error: "Invalid request" });
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: "yes" as unknown as boolean })).toEqual({ error: "Invalid request" });
    m.db.entity.findMany.mockResolvedValue([]);
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ error: "Invalid request" });
    entities();
    m.db.appSetting.findUnique.mockResolvedValue({ value: "{nope" });
    expect(await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true })).toEqual({ error: "The saved list could not be read, so nothing was changed." });
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  });

  it("never changes a transaction: only findFirst and findMany reads", async () => {
    await setMcCarthyNotOil({ entityId: ENT, transactionId: TX, notOil: true });
    expect(Object.keys(m.db.transaction).sort()).toEqual(["findFirst", "findMany"]);
    const src = readFileSync(resolve(__dirname, "../..", "actions/seasonal-settings.ts"), "utf8");
    expect(src).not.toMatch(/db\.transaction\.(update|updateMany|create|delete|deleteMany|upsert)/);
  });
});
