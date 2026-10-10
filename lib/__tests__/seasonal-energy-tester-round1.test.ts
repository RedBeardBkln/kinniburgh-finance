// TESTER (carry-forward-seasonal-energy, step 2, re-test of round 1): D4 (which rows can be marked), D5 (price bounds),
// D6 (the loader is not memoised outside a render), over a mocked database. No test touches a real database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  db: {
    entity: { findFirst: vi.fn(), findMany: vi.fn() },
    transaction: { findFirst: vi.fn(), findMany: vi.fn() },
    appSetting: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
    budget: { findMany: vi.fn() },
    tag: { findMany: vi.fn() },
    scheduledBill: { findMany: vi.fn() },
  },
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ db: m.db }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));

import { setMcCarthyNotOil, addOilPrice } from "@/actions/seasonal-settings";
import { loadSeasonalEnergySafe, loadSeasonalPlansSafe } from "@/lib/seasonal-energy-build";
import { normalizePrice, OIL_PRICE_MIN } from "@/lib/seasonal-energy-prices";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const E = { personal: U(1), sv: U(2), ek: U(3) };
const SLUG: Record<string, string> = { [E.personal]: "personal", [E.sv]: "sudden-valley", [E.ek]: "ek-consulting" };
const TX = U(900);

function txRow(entityId: string, payee: string, tags: string[]) {
  return {
    id: TX,
    entityId,
    accountId: U(77),
    amount: new Decimal("-250.00"),
    postedAt: new Date("2026-10-05T00:00:00Z"),
    payeeNormalized: payee,
    payeeRaw: null,
    description: null,
    tags: tags.map((name) => ({ tag: { name } })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1" } });
  m.db.entity.findFirst.mockResolvedValue({ id: E.personal });
  m.db.entity.findMany.mockImplementation(async (args: { where: { id?: { in: string[] } } }) =>
    args.where.id ? args.where.id.in.filter((id) => SLUG[id]).map((id) => ({ id, slug: SLUG[id] })) : []
  );
  m.db.appSetting.findUnique.mockResolvedValue(null);
  m.db.appSetting.findMany.mockResolvedValue([]);
  m.db.appSetting.upsert.mockResolvedValue({});
  m.db.auditLog.create.mockResolvedValue({});
  m.db.transaction.findMany.mockResolvedValue([]);
});

describe("D4: which rows may be marked (the model's own rule: the payee decides the kind first)", () => {
  const OIL = "Utilities / Oil";
  const cases: Array<[string, string, string, string[], boolean]> = [
    // label, site, row entity, ..., accepted
    ["McCarthy payee, own books, any tag", E.personal, E.personal, ["Home & Property / Home Repair"], true],
    ["McCarthy payee on EK for the Personal house", E.personal, E.ek, [], true],
    ["non-supplier payee tagged Utilities / Oil on the site's own books", E.personal, E.personal, [OIL], true],
    ["non-supplier payee, no oil tag, own books", E.personal, E.personal, ["Groceries"], false],
    ["Eversource payee tagged Oil (payee decides first)", E.personal, E.personal, [OIL], false],
    ["Firewood payee tagged Oil", E.personal, E.personal, [OIL], false],
    ["tag-only oil row on EK for the Personal house (a tag never crosses entities)", E.personal, E.ek, [OIL], false],
    ["tag-only oil row on Sudden Valley for the Personal house", E.personal, E.sv, [OIL], false],
    ["McCarthy row on Personal for the Sudden Valley site", E.sv, E.personal, [], false],
    ["McCarthy row on EK for the Sudden Valley site", E.sv, E.ek, [], false],
  ];
  const payeeFor = (label: string) => (label.startsWith("McCarthy") ? "mccarthy heating oil" : label.startsWith("Eversource") ? "eversource web pay" : label.startsWith("Firewood") ? "firewood guy" : "valero");
  it.each(cases)("%s", async (label, site, owner, tags, accepted) => {
    m.db.transaction.findFirst.mockResolvedValue(txRow(owner, payeeFor(label), tags));
    const r = await setMcCarthyNotOil({ entityId: site, transactionId: TX, notOil: true });
    expect("error" in r, label).toBe(!accepted);
    expect(m.db.appSetting.upsert).toHaveBeenCalledTimes(accepted ? 1 : 0);
  });

  it("the stored entry carries the signature (account id, cents, payee key, date); the AuditLog row carries none of it", async () => {
    m.db.transaction.findFirst.mockResolvedValue(txRow(E.personal, "McCarthy Heating Oil", []));
    await setMcCarthyNotOil({ entityId: E.personal, transactionId: TX, notOil: true });
    const saved = JSON.parse((m.db.appSetting.upsert.mock.calls[0]![0] as { create: { value: string } }).create.value);
    expect(saved).toEqual([{ id: TX, sig: { a: U(77), c: 25000, p: "mccarthy heating oil", on: "2026-10-05" } }]);
    const audit = JSON.stringify(m.db.auditLog.create.mock.calls[0]![0]);
    expect(audit).not.toMatch(/mccarthy|25000|2026-10-05|"sig"/i);
    expect(audit).not.toContain(U(77));
  });
});

describe("D5: oil price bounds", () => {
  it.each([["1.00", true], ["1", true], ["0.99", false], ["0.35", false], ["20", true], ["20.00", true], ["20.01", false], ["0", false], ["0.00", false]])("price %s accepted=%s", (price, ok) => {
    const r = normalizePrice(price);
    expect(r.ok).toBe(ok);
  });
  it("under $1.00 gives the typo hint, zero gives its own message, above $20 gives the upper-bound message", () => {
    const low = normalizePrice("0.35");
    const zero = normalizePrice("0");
    const high = normalizePrice("25");
    expect(!low.ok && low.error).toMatch(/under \$1\.00 a gallon is probably a typing slip \(for example 0\.35 for 3\.50\)/);
    expect(!zero.ok && zero.error).toMatch(/greater than zero/);
    expect(zero.ok || low.ok ? "same" : zero.error).not.toBe(low.ok ? "same" : low.error);
    expect(!high.ok && high.error).toMatch(/above \$20/);
    expect(OIL_PRICE_MIN).toBe(1);
  });
  it("addOilPrice refuses 0.35 and stores nothing", async () => {
    const r = await addOilPrice({ entityId: E.personal, effectiveOn: "2026-10-01", pricePerGal: "0.35" });
    expect("error" in r).toBe(true);
    expect(m.db.appSetting.upsert).not.toHaveBeenCalled();
  });
});

describe("D6: the seasonal load is not memoised outside a render, and a failure stays fail-soft", () => {
  const budgetRow = {
    id: "r1", entityId: E.personal, tagId: "t-op", accountId: "a", period: "2026-10", budgeted: new Decimal("308"), additionalAmountCents: new Decimal(0), payDay: null, frequency: "monthly",
    payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null, rolloverEnabled: false, rolloverAmount: null,
    tag: { id: "t-op", name: "Utilities / Oil", shortName: "Oil", parentId: null }, entity: { id: E.personal, name: "Personal", slug: "personal" },
  };
  beforeEach(() => {
    m.db.entity.findMany.mockResolvedValue([{ id: E.personal, name: "Personal", slug: "personal" }]);
    m.db.budget.findMany.mockResolvedValue([budgetRow]);
    m.db.tag.findMany.mockResolvedValue([]);
    m.db.scheduledBill.findMany.mockResolvedValue([]);
  });
  const NOW = new Date("2026-10-10T12:00:00Z");

  it("two calls on the same day outside a render each read the database (actions / cron / tests see fresh data)", async () => {
    const a = await loadSeasonalEnergySafe({ now: NOW });
    const b = await loadSeasonalPlansSafe({ now: NOW });
    expect(a.failed).toBe(false);
    expect(b.failed).toBe(false);
    expect(m.db.transaction.findMany).toHaveBeenCalledTimes(2);
  });

  it("data changed between two calls is seen by the second call", async () => {
    const first = await loadSeasonalEnergySafe({ now: NOW });
    expect(first.sites[0]!.oil!.facts.payments).toHaveLength(0);
    m.db.transaction.findMany.mockResolvedValue([
      { id: "t1", postedAt: new Date("2026-09-01T00:00:00Z"), amount: new Decimal("-800"), entityId: E.personal, payeeNormalized: "mccarthy heating oil", payeeRaw: null, description: null, accountId: "a", pending: false, account: { nickname: "x" }, tags: [] },
    ]);
    const second = await loadSeasonalEnergySafe({ now: NOW });
    expect(second.sites[0]!.oil!.facts.payments).toHaveLength(1);
  });

  it("a failure never rejects, is reported as failed with no plans, on every call", async () => {
    m.db.transaction.findMany.mockRejectedValue(new Error("down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let i = 0; i < 2; i++) {
      const r = await loadSeasonalPlansSafe({ now: NOW });
      expect(r).toEqual({ plans: [], failed: true });
    }
    expect(spy.mock.calls.flat().every((x) => typeof x === "string")).toBe(true);
    spy.mockRestore();
  });
});
