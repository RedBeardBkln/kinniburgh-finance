// TESTER (carry-forward-seasonal-energy, step 2): adversarial matrix for actions/seasonal-settings.ts with the database
// boundary mocked (no test touches a real database). Complements the Coder's seasonal-settings-actions.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

it("the documented caps are literally 200 marked rows and 60 price entries", () => {
  expect(OIL_EXCLUDED_CAP).toBe(200);
  expect(OIL_PRICE_CAP).toBe(60);
});

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const E = { personal: U(1), sv: U(2), ek: U(3), mezzo: U(4) };
const SLUG: Record<string, string> = { [E.personal]: "personal", [E.sv]: "sudden-valley", [E.ek]: "ek-consulting", [E.mezzo]: "mezzo" };
const TX = U(900);

function primeEntities(archived: string[] = []) {
  m.db.entity.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.filter((id) => SLUG[id] && !archived.includes(id)).map((id) => ({ id, slug: SLUG[id] }))
  );
}
function primeTx(entityId: string, payee: { n?: string | null; r?: string | null; d?: string | null } = { n: "mccarthy heating oil" }) {
  // Round 1: the action also reads the columns of a mark's durable signature (account, amount, posted date) and the tags.
  m.db.transaction.findFirst.mockResolvedValue({
    id: TX,
    entityId,
    accountId: U(500),
    amount: "-1036.75",
    postedAt: new Date("2026-10-09T00:00:00Z"),
    payeeNormalized: payee.n ?? null,
    payeeRaw: payee.r ?? null,
    description: payee.d ?? null,
    tags: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1" } });
  m.db.entity.findFirst.mockResolvedValue({ id: E.personal });
  m.db.transaction.findMany.mockResolvedValue([]);
  m.db.appSetting.findUnique.mockResolvedValue(null);
  m.db.appSetting.upsert.mockResolvedValue({});
  m.db.auditLog.create.mockResolvedValue({});
  primeEntities();
});
afterEach(() => vi.useRealTimers());

const noWrites = () => {
  expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  expect(m.db.auditLog.create).not.toHaveBeenCalled();
};

describe("setMcCarthyNotOil: which transaction may be marked for which site", () => {
  const allowed: Array<[string, string]> = [
    [E.personal, E.personal],
    [E.personal, E.ek], // the card charged by mistake
    [E.sv, E.sv],
    [E.mezzo, E.mezzo],
    [E.ek, E.ek],
  ];
  const refused: Array<[string, string]> = [
    [E.sv, E.personal],
    [E.sv, E.ek],
    [E.sv, E.mezzo],
    [E.personal, E.sv], // Personal never reads Sudden Valley's rows
    [E.personal, E.mezzo],
    [E.ek, E.personal],
    [E.ek, E.sv],
    [E.mezzo, E.personal],
  ];
  it.each(allowed)("site %s may mark a McCarthy row on %s", async (site, owner) => {
    primeTx(owner);
    const r = await setMcCarthyNotOil({ entityId: site, transactionId: TX, notOil: true });
    expect(r).toEqual({ success: true });
    expect(m.db.appSetting.upsert).toHaveBeenCalledTimes(1);
    expect((m.db.appSetting.upsert.mock.calls[0]![0] as { where: { key: string } }).where.key).toBe(`oil_not_heating:${site}`);
  });
  it.each(refused)("site %s may NOT mark a McCarthy row on %s", async (site, owner) => {
    primeTx(owner);
    const r = await setMcCarthyNotOil({ entityId: site, transactionId: TX, notOil: true });
    expect("error" in r).toBe(true);
    noWrites();
  });

  it("an archived (or missing) transaction is refused, and the lookup itself carries archivedAt: null", async () => {
    m.db.transaction.findFirst.mockResolvedValue(null);
    const r = await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true });
    expect("error" in r).toBe(true);
    expect(m.db.transaction.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: TX, archivedAt: null } }));
    noWrites();
  });

  it("an archived site entity or archived owner entity is refused", async () => {
    primeEntities([E.personal]);
    primeTx(E.personal);
    expect("error" in (await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true }))).toBe(true);
    primeEntities([E.ek]);
    primeTx(E.ek);
    expect("error" in (await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true }))).toBe(true);
    noWrites();
  });

  it.each([
    ["a grocery payee", { n: "stop & shop" }],
    ["a McCarthy plumber (no heating / oil word)", { n: "mccarthy plumbing" }],
    ["an oil word without McCarthy", { n: "valero oil" }],
    ["all three payee fields empty", {}],
  ])("refuses %s", async (_label, payee) => {
    primeTx(E.personal, payee);
    const r = await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true });
    expect("error" in r).toBe(true);
    noWrites();
  });

  it("accepts the McCarthy payee when it is only in the raw payee or the description", async () => {
    primeTx(E.personal, { r: "MCCARTHY HEATING & OIL SERV" });
    expect(await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true })).toEqual({ success: true });
    vi.clearAllMocks();
    m.auth.mockResolvedValue({ user: { id: "user-1" } });
    m.db.appSetting.findUnique.mockResolvedValue(null);
    primeEntities();
    primeTx(E.personal, { d: "McCarthy Heating Oil 860" });
    expect(await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true })).toEqual({ success: true });
  });

  it.each(["not-a-uuid", "", "00000000-0000-4000-8000-00000000090", "' OR 1=1 --", "x".repeat(200)])("a malformed transaction id %j is refused before any lookup", async (bad) => {
    const r = await setMcCarthyNotOil({ entityId: E.personal, transactionId: bad, notOil: true });
    expect(r).toEqual({ error: "Invalid request" });
    expect(m.db.transaction.findFirst).not.toHaveBeenCalled();
    noWrites();
  });

  it("a non-boolean notOil is refused", async () => {
    primeTx(E.personal);
    const r = await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: "yes" as unknown as boolean });
    expect(r).toEqual({ error: "Invalid request" });
    noWrites();
  });
});

describe("setMcCarthyNotOil: what is stored", () => {
  it("the id plus its durable signature is stored (Round 1: a mark must survive pending -> posted); the AuditLog row holds ids and the list size only", async () => {
    primeTx(E.ek, { n: "mccarthy heating oil serv 860 4432839 ct" });
    await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true });
    const call = m.db.appSetting.upsert.mock.calls[0]![0] as { update: { value: string }; create: { value: string } };
    // changed from `[TX]` by D1: the signature (account id, cents, payee key, date) sits beside the id
    expect(JSON.parse(call.create.value)).toEqual([{ id: TX, sig: { a: U(500), c: 103675, p: "mccarthy heating oil serv 860 ct", on: "2026-10-09" } }]); // Round 2: the 7-digit reference run is not stored
    expect(Object.keys(JSON.parse(call.create.value)[0].sig).sort()).toEqual(["a", "c", "on", "p"]);
    const audit = m.db.auditLog.create.mock.calls[0]![0] as { data: { changedBy: string; changeType: string; after: Record<string, unknown>; before: unknown } };
    expect(audit.data.changeType).toBe("oil_row_excluded");
    expect(Object.keys(audit.data.after).sort()).toEqual(["entityId", "entries", "transactionId"]);
    expect(JSON.stringify(audit)).not.toMatch(/mccarthy|860|oil heat/i);
  });

  it("idempotent both ways: marking twice writes once; counting again an unmarked row writes nothing", async () => {
    primeTx(E.personal);
    await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true });
    expect(m.db.appSetting.upsert).toHaveBeenCalledTimes(1);
    const stored = (m.db.appSetting.upsert.mock.calls[0]![0] as { create: { value: string } }).create.value;
    m.db.appSetting.findUnique.mockResolvedValue({ value: stored });
    expect(await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true })).toEqual({ success: true });
    expect(m.db.appSetting.upsert).toHaveBeenCalledTimes(1);
    expect(m.db.auditLog.create).toHaveBeenCalledTimes(1);
    // count it again -> writes [] ; again -> no further write
    await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: false });
    expect(m.db.appSetting.upsert).toHaveBeenCalledTimes(2);
    expect(JSON.parse((m.db.appSetting.upsert.mock.calls[1]![0] as { create: { value: string } }).create.value)).toEqual([]);
    expect((m.db.auditLog.create.mock.calls[1]![0] as { data: { changeType: string } }).data.changeType).toBe("oil_row_included");
    m.db.appSetting.findUnique.mockResolvedValue({ value: "[]" });
    await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: false });
    expect(m.db.appSetting.upsert).toHaveBeenCalledTimes(2);
  });

  it("cap 200: a new id is refused at the cap, an id already there is still a no-op success, and removal frees a slot", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => U(5000 + i));
    const sigOf = (i: number) => ({ a: U(600 + i), c: 1000 + i, p: "mccarthy heating oil", on: "2026-01-01" });
    m.db.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify(ids.map((id, i) => ({ id, sig: sigOf(i) }))) });
    // every stored id is a live row (not a stale pending id), so none of them can be taken over by the new row
    m.db.transaction.findMany.mockResolvedValue(ids.map((id) => ({ id })));
    primeTx(E.personal);
    const r = await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true });
    expect("error" in r).toBe(true);
    noWrites();
    // the id in the list: success, no write
    m.db.transaction.findFirst.mockResolvedValue({
      id: ids[3],
      entityId: E.personal,
      accountId: sigOf(3).a,
      amount: "-10.03",
      postedAt: new Date("2026-01-01T00:00:00Z"),
      payeeNormalized: "mccarthy heating oil",
      payeeRaw: null,
      description: null,
      tags: [],
    });
    expect(await setMcCarthyNotOil({ entityId: E.personal, transactionId: ids[3]!, notOil: true })).toEqual({ success: true });
    noWrites();
    // removal at the cap works and shrinks the list by one
    expect(await setMcCarthyNotOil({ entityId: E.personal, transactionId: ids[3]!, notOil: false })).toEqual({ success: true });
    const saved = JSON.parse((m.db.appSetting.upsert.mock.calls[0]![0] as { create: { value: string } }).create.value) as Array<{ id: string }>;
    expect(saved).toHaveLength(199);
    expect(saved.map((s) => s.id)).not.toContain(ids[3]);
  });

  it("a corrupt stored list is never overwritten", async () => {
    primeTx(E.personal);
    for (const bad of ["{not json", '{"a":1}', '"x"']) {
      m.db.appSetting.findUnique.mockResolvedValue({ value: bad });
      const r = await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true });
      expect("error" in r, bad).toBe(true);
    }
    noWrites();
  });

  it("two sites keep separate lists: the key is per site entity", async () => {
    primeTx(E.sv);
    await setMcCarthyNotOil({ entityId: E.sv, transactionId: TX, notOil: true });
    expect((m.db.appSetting.upsert.mock.calls[0]![0] as { where: { key: string } }).where.key).toBe(`oil_not_heating:${E.sv}`);
  });
});

describe("addOilPrice / removeOilPrice: validation edge matrix", () => {
  const today = new Date("2026-10-10T15:00:00Z");
  const add = (over: Record<string, unknown>) =>
    addOilPrice({ entityId: E.personal, effectiveOn: "2026-10-01", pricePerGal: "3.50", ...over } as Parameters<typeof addOilPrice>[0]);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(today);
  });

  it.each([
    ["", "empty"], ["   ", "blank"], ["3.", "trailing dot"], [".5", "leading dot"], ["1e1", "exponent"], ["0x10", "hex"], ["3,5", "comma"],
    ["٣.٥", "arabic-indic digits"], ["20.01", "above the bound"], ["21", "above the bound"], ["0", "zero"], ["0.00", "zero"], ["-1", "negative"],
    ["+3", "plus sign"], ["Infinity", "Infinity"], ["NaN", "NaN"], ["3.49999", "five decimals"], ["1000", "four digits"], ["349", "typing slip"], ["3 .5", "inner space"],
  ])("rejects the price %j (%s) and writes nothing", async (price) => {
    const r = await add({ pricePerGal: price });
    expect("error" in r).toBe(true);
    noWrites();
  });

  it.each([
    ["3", "3.00"], ["3.5", "3.50"], ["3.499", "3.499"], ["3.4990", "3.4990"], ["03.50", "3.50"], ["$3.50", "3.50"], [" 3.5 ", "3.50"],
    ["20", "20.00"], ["20.0000", "20.0000"], [20, "20.00"], [3.499, "3.499"],
  ])("accepts %j and stores the decimal STRING %s", async (price, stored) => {
    const r = await add({ pricePerGal: price });
    expect(r).toEqual({ success: true });
    const value = (m.db.appSetting.upsert.mock.calls[0]![0] as { create: { value: string } }).create.value;
    const e = (JSON.parse(value) as OilPriceEntry[])[0]!;
    expect(e.pricePerGal).toBe(stored);
    expect(typeof e.pricePerGal).toBe("string");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1e21, 1e-7])("a numeric price %s is refused", async (price) => {
    const r = await add({ pricePerGal: price });
    expect("error" in r).toBe(true);
    noWrites();
  });

  it.each([
    ["2026-02-30", false], ["2026-13-01", false], ["2026-10-1", false], ["10/01/2026", false], ["2026-10-01T00:00:00Z", false], [" 2026-10-01", false],
    ["2014-12-31", false], ["2015-01-01", true], ["2026-11-09", true], ["2026-11-10", false], ["2026-11-11", false], ["2026-10-10", true],
  ])("date %j accepted=%s (today is 2026-10-10, up to 30 days ahead)", async (date, ok) => {
    const r = await add({ effectiveOn: date });
    expect("error" in r, String(date)).toBe(!ok);
    if (!ok) noWrites();
  });

  it("the note: 120 characters pass, 121 fail, control characters fail, blank is dropped, an SSN-like note is refused", async () => {
    expect(await add({ note: "x".repeat(120) })).toEqual({ success: true });
    vi.clearAllMocks();
    m.auth.mockResolvedValue({ user: { id: "user-1" } });
    m.db.entity.findFirst.mockResolvedValue({ id: E.personal });
    m.db.appSetting.findUnique.mockResolvedValue(null);
    expect("error" in (await add({ note: "x".repeat(121) }))).toBe(true);
    expect("error" in (await add({ note: "bad\u0007note" }))).toBe(true);
    expect("error" in (await add({ note: "ssn 123-45-6789" }))).toBe(true);
    noWrites();
    expect(await add({ note: "   " })).toEqual({ success: true });
    const e = (JSON.parse((m.db.appSetting.upsert.mock.calls[0]![0] as { create: { value: string } }).create.value) as OilPriceEntry[])[0]!;
    expect("note" in e).toBe(false);
  });

  it("an unknown or archived entity is refused", async () => {
    m.db.entity.findFirst.mockResolvedValue(null);
    expect(await add({})).toEqual({ error: "Invalid request" });
    expect(await removeOilPrice({ entityId: E.personal, id: "x" })).toEqual({ error: "Invalid request" });
    noWrites();
  });

  it("cap 60 counts removed entries: at 60 an add is refused, a removal still works and only marks the entry", async () => {
    const list: OilPriceEntry[] = Array.from({ length: 60 }, (_, i) => ({
      id: `id${i}`,
      effectiveOn: `2020-${String((i % 12) + 1).padStart(2, "0")}-01`,
      pricePerGal: "3.00",
      ...(i % 2 ? { removed: true as const } : {}),
    }));
    m.db.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify(list) });
    expect("error" in (await add({}))).toBe(true);
    noWrites();
    expect(await removeOilPrice({ entityId: E.personal, id: "id4" })).toEqual({ success: true });
    const after = JSON.parse((m.db.appSetting.upsert.mock.calls[0]![0] as { create: { value: string } }).create.value) as OilPriceEntry[];
    expect(after).toHaveLength(60);
    expect(after.find((e) => e.id === "id4")).toMatchObject({ removed: true, pricePerGal: "3.00", effectiveOn: list[4]!.effectiveOn });
    expect(after.filter((e) => !e.removed)).toHaveLength(list.filter((e) => !e.removed).length - 1);
    // everything else byte-identical
    for (const e of after) if (e.id !== "id4") expect(e).toEqual(list.find((x) => x.id === e.id));
  });

  it("removing an unknown id is an error and writes nothing; the audit row has ids and counts only", async () => {
    m.db.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify([{ id: "a", effectiveOn: "2026-01-01", pricePerGal: "3.10", note: "secret note 3.10" }]) });
    expect("error" in (await removeOilPrice({ entityId: E.personal, id: "nope" }))).toBe(true);
    noWrites();
    await removeOilPrice({ entityId: E.personal, id: "a" });
    const audit = JSON.stringify(m.db.auditLog.create.mock.calls[0]![0]);
    expect(audit).not.toMatch(/3\.10|secret|2026-01-01/);
    expect(Object.keys((m.db.auditLog.create.mock.calls[0]![0] as { data: { after: object } }).data.after).sort()).toEqual(["entityId", "entries", "entryId"]);
  });

  it("a corrupt price list is not overwritten by add or remove", async () => {
    m.db.appSetting.findUnique.mockResolvedValue({ value: "garbage{" });
    expect("error" in (await add({}))).toBe(true);
    expect("error" in (await removeOilPrice({ entityId: E.personal, id: "a" }))).toBe(true);
    noWrites();
  });
});
