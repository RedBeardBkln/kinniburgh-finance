// carry-forward-seasonal-energy, step 2, Round 2 (Tester R1): a mark compares ONE descriptor (payeeNormalized, else payeeRaw,
// else description), never the joined text, and the stored payee key has its long digit runs (bank reference / phone
// numbers) dropped. The real shapes: a pending "Mccarthy Heating Oil" row is replaced by a posted "Mccarthy Heating Oil Ser".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  db: {
    entity: { findFirst: vi.fn(), findMany: vi.fn() },
    budget: { findMany: vi.fn() },
    tag: { findMany: vi.fn() },
    transaction: { findFirst: vi.fn(), findMany: vi.fn() },
    appSetting: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    scheduledBill: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ db: m.db }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));

import { setMcCarthyNotOil } from "@/actions/seasonal-settings";
import { loadSeasonalEnergy } from "@/lib/seasonal-energy-build";
import { buildSiteEnergy, type EnergyEntityRef, type RawEnergyTx, type SeasonalLineRef } from "@/lib/seasonal-energy";
import { descriptorOf, parseMarks, payeeKey, resolveMarks, signatureOf, type MarkRow, type OilMark } from "@/lib/seasonal-energy-marks";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const row = (id: string, accountId: string, amount: string, payee: string, date: string): MarkRow => ({ id, accountId, amount, payee, date: D(date) });

describe("descriptorOf: one descriptor, the first non-empty", () => {
  it("payeeNormalized, else payeeRaw, else description", () => {
    expect(descriptorOf({ payeeNormalized: "a", payeeRaw: "b", description: "c" })).toBe("a");
    expect(descriptorOf({ payeeNormalized: "", payeeRaw: "b", description: "c" })).toBe("b");
    expect(descriptorOf({ payeeNormalized: null, payeeRaw: "  ", description: "c" })).toBe("c");
    expect(descriptorOf({ payeeNormalized: null, payeeRaw: null, description: null })).toBe("");
    expect(descriptorOf({})).toBe("");
  });
});

describe("payeeKey drops digit runs of 5 or more characters", () => {
  it("bank reference and phone numbers are not stored; short numbers stay", () => {
    expect(payeeKey("mccarthy heating oil serv 860 4432839 ct")).toBe("mccarthy heating oil serv 860 ct");
    expect(payeeKey("DDA PURCHASE AP 12098201 MADISON TPKE")).toBe("dda purchase ap madison tpke");
    expect(payeeKey("check 227")).toBe("check 227");
    expect(payeeKey("store 1234")).toBe("store 1234"); // 4 digits stay
    expect(payeeKey("store 12345")).toBe("store"); // 5 digits go
    expect(payeeKey("ref#98765432101")).toBe("ref");
    expect(/\d{5,}/.test(payeeKey("a 123456789 b 55555 c 4444"))).toBe(false);
  });
  it("a reference number that differs between pending and posted no longer matters", () => {
    const pending = row(U(1), "acct", "-100", "Mccarthy Heating Oil 1234567", "2026-10-09");
    const posted = row(U(2), "acct", "-100", "Mccarthy Heating Oil 7654321", "2026-10-10");
    expect(resolveMarks([{ id: pending.id, sig: signatureOf(pending) }], [posted]).excludedIds.has(U(2))).toBe(true);
  });
  it("the signature never contains a long digit run", () => {
    const sig = signatureOf(row(U(3), "acct", "-100", "dda purchase ap 12098201 madison", "2026-10-09"));
    expect(/\d{5,}/.test(sig.p)).toBe(false);
    expect(JSON.stringify(sig)).not.toMatch(/12098201/);
  });
});

describe("the real shapes inherit", () => {
  const pending = row(U(10), "heating-electric", "-180.80", "Mccarthy Heating Oil", "2026-10-08");
  const mark: OilMark = { id: pending.id, sig: signatureOf(pending) };

  it("pending 'Mccarthy Heating Oil' -> posted 'Mccarthy Heating Oil Ser' on the same account and cents within 5 days", () => {
    const posted = row(U(11), "heating-electric", "-180.80", "Mccarthy Heating Oil Ser", "2026-10-09");
    expect(resolveMarks([mark], [posted]).excludedIds).toEqual(new Set([U(11)]));
    const later = row(U(12), "heating-electric", "-180.80", "Mccarthy Heating Oil Ser", "2026-10-13");
    expect(resolveMarks([mark], [later]).excludedIds).toEqual(new Set([U(12)]));
  });
  it("the same descriptor on both sides still inherits (the Barclay case)", () => {
    const b = row(U(13), "barclay", "-1036.75", "Mccarthy Heating Oil", "2026-10-09");
    expect(resolveMarks([{ id: b.id, sig: signatureOf(b) }], [row(U(14), "barclay", "-1036.75", "Mccarthy Heating Oil", "2026-10-10")]).excludedIds.size).toBe(1);
  });
  it("a different supplier, account, amount or a date past the window does not", () => {
    for (const other of [
      row(U(20), "heating-electric", "-180.80", "Valley Fuel Ser", "2026-10-09"),
      row(U(21), "heating-electric", "-180.80", "Mccarthy Plumbing", "2026-10-09"),
      row(U(22), "slush-funds", "-180.80", "Mccarthy Heating Oil Ser", "2026-10-09"),
      row(U(23), "heating-electric", "-180.81", "Mccarthy Heating Oil Ser", "2026-10-09"),
      row(U(24), "heating-electric", "-180.80", "Mccarthy Heating Oil Ser", "2026-10-14"),
    ]) {
      expect(resolveMarks([mark], [other]).excludedIds.size, other.id).toBe(0);
    }
  });
  it("only a whole-word prefix counts: 'Mccarthy Heating Oil' vs 'Mccarthy Heating Oils' is not alike", () => {
    expect(resolveMarks([mark], [row(U(25), "heating-electric", "-180.80", "Mccarthy Heating Oils", "2026-10-09")]).excludedIds.size).toBe(0);
  });
});

// ── through the model: the joined text must not be what a mark compares ──────────

const NOW = new Date("2026-10-10T12:00:00Z");
const P: EnergyEntityRef = { id: "ent-p", name: "Personal", slug: "personal" };
const L_OIL: SeasonalLineRef = { entityId: "ent-p", tagId: "t-op", tagName: "Utilities / Oil", kind: "oil" };

describe("buildSiteEnergy compares the single descriptor", () => {
  // The joined supplier text DOUBLES the descriptor; the descriptor field is what a mark uses.
  const tx = (id: string, date: string, descriptor: string, pending: boolean): RawEnergyTx => ({
    id,
    date: D(date),
    amount: new Decimal("180.80").negated(),
    entityId: "ent-p",
    payee: `${descriptor} ${descriptor}`,
    descriptor,
    account: "Heating & Electric",
    accountId: "heating-electric",
    pending,
    tagPaths: ["Home & Property / Home Repair"],
  });
  const site = (txs: RawEnergyTx[], marks: OilMark[]) => buildSiteEnergy({ entity: P, lines: [L_OIL], txs, entities: [P], priceEntries: [], flatMonthly: {}, replaceDraws: false, oilMarks: marks, now: NOW });

  it("a mark on the pending row follows it to the posted '... Ser' row (the live Heating & Electric shape)", () => {
    const pending = tx(U(30), "2026-10-08", "Mccarthy Heating Oil", true);
    const mark: OilMark = { id: pending.id, sig: signatureOf({ id: pending.id, accountId: "heating-electric", amount: "-180.80", payee: "Mccarthy Heating Oil", date: pending.date }) };
    expect(site([pending], [mark]).oil!.facts.excluded.map((p) => p.id)).toEqual([pending.id]);
    const posted = tx(U(31), "2026-10-09", "Mccarthy Heating Oil Ser", false);
    const s = site([posted], [mark]);
    expect(s.oil!.facts.excluded.map((p) => p.id)).toEqual([posted.id]);
    expect(s.oil!.facts.counted).toEqual([]);
  });

  it("without a descriptor field the joined payee is used (older callers), so nothing breaks", () => {
    const plain: RawEnergyTx = { ...tx(U(32), "2026-10-09", "x", false), payee: "mccarthy heating oil", descriptor: undefined };
    expect(site([plain], []).oil!.facts.counted).toHaveLength(1);
  });
});

// ── through the loader: payeeNormalized wins over payeeRaw and description ───────

describe("loadSeasonalEnergy builds the MarkRow from payeeNormalized, else payeeRaw, else description", () => {
  const budgetRow = {
    id: "row-1",
    entityId: "ent-p",
    tagId: "t-op",
    accountId: "acct",
    period: "2026-10",
    budgeted: new Decimal("308"),
    additionalAmountCents: new Decimal(0),
    payDay: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    rolloverEnabled: false,
    rolloverAmount: null,
    tag: { id: "t-op", name: "Utilities / Oil", shortName: "Oil", parentId: null },
    entity: { id: "ent-p", name: "Personal", slug: "personal" },
  };
  const txRow = (id: string, date: string, over: Record<string, unknown>) => ({
    id,
    postedAt: D(date),
    amount: new Decimal("-180.80"),
    pending: false,
    accountId: "heating-electric",
    entityId: "ent-p",
    payeeNormalized: null,
    payeeRaw: null,
    description: null,
    account: { nickname: "Heating & Electric" },
    tags: [],
    ...over,
  });
  beforeEach(() => {
    vi.clearAllMocks();
    m.db.entity.findMany.mockResolvedValue([{ id: "ent-p", name: "Personal", slug: "personal" }]);
    m.db.budget.findMany.mockResolvedValue([budgetRow]);
    m.db.tag.findMany.mockResolvedValue([]);
    m.db.appSetting.findUnique.mockResolvedValue(null);
    m.db.scheduledBill.findMany.mockResolvedValue([]);
  });

  it("the three text columns of the posted row do not double the descriptor the mark is matched against", async () => {
    const pendingDescriptor = "Mccarthy Heating Oil";
    const sig = signatureOf({ id: U(40), accountId: "heating-electric", amount: "-180.80", payee: pendingDescriptor, date: D("2026-10-08") });
    m.db.appSetting.findMany.mockResolvedValue([{ key: "oil_not_heating:ent-p", value: JSON.stringify([{ id: U(40), sig }]) }]);
    m.db.transaction.findMany.mockResolvedValue([
      txRow(U(41), "2026-10-09", { payeeNormalized: "Mccarthy Heating Oil Ser", payeeRaw: "Mccarthy Heating Oil Ser", description: "MCCARTHY HEATING OIL SER 860 4432839" }),
    ]);
    const r = await loadSeasonalEnergy({ now: NOW });
    expect(r.sites[0]!.oil!.facts.excluded.map((p) => p.id)).toEqual([U(41)]);
  });

  it("a row with only a description falls back to it, and a pending row stays flagged pending", async () => {
    const sig = signatureOf({ id: U(42), accountId: "heating-electric", amount: "-180.80", payee: "MCCARTHY HEATING OIL", date: D("2026-10-08") });
    m.db.appSetting.findMany.mockResolvedValue([{ key: "oil_not_heating:ent-p", value: JSON.stringify([{ id: U(42), sig }]) }]);
    m.db.transaction.findMany.mockResolvedValue([txRow(U(43), "2026-10-09", { description: "MCCARTHY HEATING OIL SER", pending: true })]);
    const r = await loadSeasonalEnergy({ now: NOW });
    const oil = r.sites[0]!.oil!;
    expect(oil.facts.excluded.map((p) => [p.id, p.pending])).toEqual([[U(43), true]]);
  });
});

// ── through the action: one descriptor, digit runs stripped ──────────────────────

describe("setMcCarthyNotOil stores the single-descriptor key without long digit runs", () => {
  const TX = U(50);
  beforeEach(() => {
    vi.clearAllMocks();
    m.auth.mockResolvedValue({ user: { id: "user-1" } });
    m.db.transaction.findMany.mockResolvedValue([]);
    m.db.appSetting.findUnique.mockResolvedValue(null);
    m.db.appSetting.upsert.mockResolvedValue({});
    m.db.auditLog.create.mockResolvedValue({});
    m.db.entity.findMany.mockResolvedValue([{ id: "ent-p", slug: "personal" }]);
  });
  const tx = (over: Record<string, unknown>) => ({
    id: TX,
    entityId: "ent-p",
    accountId: "heating-electric",
    amount: "-180.80",
    postedAt: D("2026-10-08"),
    payeeNormalized: null,
    payeeRaw: null,
    description: null,
    tags: [],
    ...over,
  });
  const savedSig = () => {
    const call = m.db.appSetting.upsert.mock.calls[0]![0] as { create: { value: string } };
    return parseMarks(call.create.value).marks[0]!.sig!;
  };
  const UUID_ENT = "6f55fa50-9d94-47a8-92d6-2cc5abeac714";

  it("uses payeeNormalized alone (not the three columns joined) and drops the reference digits", async () => {
    m.db.entity.findMany.mockResolvedValue([{ id: UUID_ENT, slug: "personal" }]);
    m.db.transaction.findFirst.mockResolvedValue(
      tx({ entityId: UUID_ENT, payeeNormalized: "mccarthy heating oil serv 860 4432839 ct", payeeRaw: "MCCARTHY HEATING OIL SERV 860 4432839 CT", description: "MCCARTHY HEATING OIL SERV860 4432839CT" })
    );
    expect(await setMcCarthyNotOil({ entityId: UUID_ENT, transactionId: TX, notOil: true })).toEqual({ success: true });
    expect(savedSig().p).toBe("mccarthy heating oil serv 860 ct");
    expect(JSON.stringify(m.db.appSetting.upsert.mock.calls)).not.toMatch(/4432839/);
  });

  it("falls back to payeeRaw, then description", async () => {
    m.db.entity.findMany.mockResolvedValue([{ id: UUID_ENT, slug: "personal" }]);
    m.db.transaction.findFirst.mockResolvedValue(tx({ entityId: UUID_ENT, payeeRaw: "Mccarthy Heating Oil" }));
    await setMcCarthyNotOil({ entityId: UUID_ENT, transactionId: TX, notOil: true });
    expect(savedSig().p).toBe("mccarthy heating oil");
    m.db.appSetting.upsert.mockClear();
    m.db.transaction.findFirst.mockResolvedValue(tx({ entityId: UUID_ENT, description: "MCCARTHY HEATING OIL" }));
    await setMcCarthyNotOil({ entityId: UUID_ENT, transactionId: TX, notOil: true });
    expect(savedSig().p).toBe("mccarthy heating oil");
  });

  it("a mark made on the pending row is the same key the loader matches the posted '... Ser' row against", async () => {
    m.db.entity.findMany.mockResolvedValue([{ id: UUID_ENT, slug: "personal" }]);
    m.db.transaction.findFirst.mockResolvedValue(tx({ entityId: UUID_ENT, payeeNormalized: "Mccarthy Heating Oil", payeeRaw: "Mccarthy Heating Oil" }));
    await setMcCarthyNotOil({ entityId: UUID_ENT, transactionId: TX, notOil: true });
    const sig = savedSig();
    const posted = row(U(51), "heating-electric", "-180.80", "Mccarthy Heating Oil Ser", "2026-10-09");
    expect(resolveMarks([{ id: TX, sig }], [posted]).excludedIds.has(U(51))).toBe(true);
  });
});
