// TESTER (carry-forward-seasonal-energy, step 2, round 2): pending -> posted mark inheritance through the REAL code path
// (setMcCarthyNotOil action -> stored AppSetting -> loadSeasonalEnergy -> buildSiteEnergy), over a stateful mocked
// database with all three text columns populated. No test touches a real database.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

interface Row {
  id: string;
  postedAt: Date;
  amount: Decimal;
  entityId: string;
  accountId: string;
  pending: boolean;
  payeeNormalized: string | null;
  payeeRaw: string | null;
  description: string | null;
  account: { nickname: string };
  tags: Array<{ tag: { name: string } }>;
}
const st = vi.hoisted(() => ({ rows: [] as unknown[], settings: new Map<string, string>() }));
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

import { setMcCarthyNotOil } from "@/actions/seasonal-settings";
import { loadSeasonalEnergy } from "@/lib/seasonal-energy-build";
import { descriptorOf, payeeKey, payeesAlike } from "@/lib/seasonal-energy-marks";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = U(1);
const NOW = new Date("2026-10-10T12:00:00Z");
const day = (offset: number) => new Date(Date.UTC(2026, 8, 1) + offset * 86_400_000); // Sep 1 + offset
let seq = 100;
const newId = () => U(++seq);

const mk = (id: string, accountId: string, cents: number, date: Date, descriptor: string, pending: boolean): Row => ({
  id,
  postedAt: date,
  amount: new Decimal(-cents).div(100),
  entityId: P,
  accountId,
  pending,
  // all three columns populated, as the bank/Plaid data is: normalized lower-case, raw as typed, description a third spelling
  payeeNormalized: descriptor.toLowerCase(),
  payeeRaw: descriptor,
  description: descriptor.toUpperCase(),
  account: { nickname: accountId === U(10) ? "Heating & Electric" : "Barclay" },
  tags: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  st.rows = [];
  st.settings = new Map();
  m.auth.mockResolvedValue({ user: { id: "u1" } });
  m.db.entity.findMany.mockImplementation(async (args: { where: { id?: { in: string[] } } }) =>
    args.where.id ? args.where.id.in.filter((x) => x === P).map((id) => ({ id, slug: "personal", name: "Personal" })) : [{ id: P, name: "Personal", slug: "personal" }]
  );
  m.db.budget.findMany.mockResolvedValue([
    {
      id: "b1", entityId: P, tagId: "t-op", accountId: "a", period: "2026-10", budgeted: new Decimal("308"), additionalAmountCents: new Decimal(0), payDay: null, frequency: "monthly", payDayOfWeek: null,
      biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null, rolloverEnabled: false, rolloverAmount: null,
      tag: { id: "t-op", name: "Utilities / Oil", shortName: "Oil", parentId: null }, entity: { id: P, name: "Personal", slug: "personal" },
    },
  ]);
  m.db.tag.findMany.mockResolvedValue([]);
  m.db.scheduledBill.findMany.mockResolvedValue([]);
  m.db.appSetting.findUnique.mockImplementation(async (a: { where: { key: string } }) => {
    const v = st.settings.get(a.where.key);
    return v === undefined ? null : { value: v };
  });
  m.db.appSetting.findMany.mockImplementation(async (a: { where: { key: { in: string[] } } }) => a.where.key.in.filter((k) => st.settings.has(k)).map((k) => ({ key: k, value: st.settings.get(k)! })));
  m.db.appSetting.upsert.mockImplementation(async (a: { where: { key: string }; create: { value: string } }) => {
    st.settings.set(a.where.key, a.create.value);
    return {};
  });
  m.db.auditLog.create.mockResolvedValue({});
  m.db.transaction.findFirst.mockImplementation(async (a: { where: { id: string } }) => (st.rows as Row[]).find((r) => r.id === a.where.id) ?? null);
  m.db.transaction.findMany.mockImplementation(async (a: { where: { id?: { in: string[] } } }) => {
    const rows = st.rows as Row[];
    return a.where.id ? rows.filter((r) => a.where.id!.in.includes(r.id)).map((r) => ({ id: r.id })) : rows;
  });
});

const mark = (id: string) => setMcCarthyNotOil({ entityId: P, transactionId: id, notOil: true });
const excludedIds = async () => {
  const r = await loadSeasonalEnergy({ now: NOW });
  expect(r.failed).toBe(false);
  return new Set(r.sites[0]!.oil!.facts.excluded.map((x) => x.id));
};

describe("descriptorOf / payeeKey", () => {
  it("first non-empty of normalized, raw, description; blank strings skipped; digit runs of 5+ dropped, 4 kept", () => {
    expect(descriptorOf({ payeeNormalized: "  ", payeeRaw: "B", description: "C" })).toBe("B");
    expect(descriptorOf({ payeeNormalized: null, payeeRaw: null, description: "C" })).toBe("C");
    expect(descriptorOf({})).toBe("");
    expect(payeeKey("MCCARTHY HEATING OIL SERV 860-4432839 CT")).toBe("mccarthy heating oil serv 860 ct");
    expect(payeeKey("check 1234 shop")).toBe("check 1234 shop");
    expect(payeeKey("shop 12345")).toBe("shop");
    expect(payeeKey("abc12345def")).toBe("abc def"); // a dropped run separates the words it sat between
  });
  it("digit stripping cannot make different suppliers alike (letters still decide) and keeps the whole-word prefix rule", () => {
    expect(payeesAlike(payeeKey("Valero 12345678"), payeeKey("McCarthy Heating Oil 12345678"))).toBe(false);
    expect(payeesAlike(payeeKey("McCarthy Heating Oil"), payeeKey("McCarthy Heating Oil Serv 860-4432839 CT"))).toBe(true);
    expect(payeesAlike(payeeKey("McCarthy Heating"), payeeKey("McCarthy Heating Oil"))).toBe(true);
    expect(payeesAlike(payeeKey("McCarthy Heat"), payeeKey("McCarthy Heating Oil"))).toBe(false); // mid-word
    // a descriptor that is ONLY a reference number has an empty key and never matches anything
    expect(payeeKey("12345678")).toBe("");
    expect(payeesAlike(payeeKey("12345678"), payeeKey("87654321"))).toBe(false);
  });
});

describe("pending -> posted through action -> loader -> buildSiteEnergy (all three text columns populated)", () => {
  it("the three live pending shapes: Barclay Oct 9 and Heating & Electric Oct 8 x2 inherit when posted as the account's usual text", async () => {
    const H = U(10);
    const B = U(11);
    const p1 = mk(U(501), B, 103675, day(38), "Mccarthy Heating Oil", true);
    const p2 = mk(U(502), H, 152950, day(37), "Mccarthy Heating Oil", true);
    const p3 = mk(U(503), H, 18080, day(37), "Mccarthy Heating Oil", true);
    st.rows = [p1, p2, p3];
    for (const p of [p1, p2, p3]) expect(await mark(p.id)).toEqual({ success: true });
    expect(await excludedIds()).toEqual(new Set([p1.id, p2.id, p3.id]));
    // the bank posts them: new ids, one day later; Heating & Electric rows read "... Ser"
    st.rows = [mk(U(601), B, 103675, day(39), "Mccarthy Heating Oil", false), mk(U(602), H, 152950, day(38), "Mccarthy Heating Oil Ser", false), mk(U(603), H, 18080, day(38), "Mccarthy Heating Oil Ser", false)];
    expect(await excludedIds()).toEqual(new Set([U(601), U(602), U(603)]));
    // stored entries are still the three original slots (no new cap slots were needed)
    expect(JSON.parse(st.settings.get(`oil_not_heating:${P}`)!)).toHaveLength(3);
  });

  it("window edges through the loader: the posted row 5 days after inherits, 6 days after does not", async () => {
    for (const [offset, inherits] of [[0, true], [1, true], [5, true], [6, false]] as const) {
      st.rows = [mk(U(701), U(10), 50000, day(20), "Mccarthy Heating Oil", true)];
      st.settings = new Map();
      await mark(U(701));
      st.rows = [mk(U(702), U(10), 50000, day(20 + offset), "Mccarthy Heating Oil Ser", false)];
      expect((await excludedIds()).has(U(702)), `offset ${offset}`).toBe(inherits);
    }
  });

  it("different account, different cents, different supplier, differing reference digits: only the reference digits are tolerated", async () => {
    st.rows = [mk(U(801), U(10), 50000, day(20), "Mccarthy Heating Oil 860-4432839", true)];
    await mark(U(801));
    const cases: Array<[Row, boolean]> = [
      [mk(U(802), U(10), 50000, day(21), "Mccarthy Heating Oil 860-9999999", false), true],
      [mk(U(803), U(11), 50000, day(21), "Mccarthy Heating Oil", false), false],
      [mk(U(804), U(10), 50001, day(21), "Mccarthy Heating Oil", false), false],
      [mk(U(805), U(10), 50000, day(21), "Valero Fuel 860-4432839", false), false],
    ];
    for (const [row, inherits] of cases) {
      st.rows = [row];
      expect((await excludedIds()).has(row.id), row.payeeRaw!).toBe(inherits);
    }
  });


  it("the longer-descriptor-first direction: a pending '... Oil Ser' mark is inherited by the posted '... Oil' row (all three columns populated)", async () => {
    st.rows = [mk(U(901), U(10), 61000, day(15), "Mccarthy Heating Oil Ser", true)];
    await mark(U(901));
    st.rows = [mk(U(902), U(10), 61000, day(16), "Mccarthy Heating Oil", false)];
    expect((await excludedIds()).has(U(902))).toBe(true);
  });

  it("2,000 worlds of re-id: every mark lands on exactly one posted twin of its own charge, never on a different charge", async () => {
    const r = rng(20261011);
    let checked = 0;
    for (let w = 0; w < 2000; w++) {
      st.settings = new Map();
      const n = ri(r, 1, 5);
      const charges = Array.from({ length: n }, (_, i) => ({
        acct: r() < 0.5 ? U(10) : U(11),
        cents: r() < 0.4 ? 77700 : ri(r, 1, 9) * 10000 + 5 + i * 100 + (r() < 0.5 ? 0 : 1),
        day: ri(r, 0, 9),
        desc: ["Mccarthy Heating Oil", "Mccarthy Heating Oil Serv 860-4432839 CT", "Mccarthy Heating & Oil"][ri(r, 0, 2)]!,
      }));
      const pend = charges.map((c) => mk(newId(), c.acct, c.cents, day(c.day), c.desc, true));
      st.rows = pend;
      const marked: number[] = [];
      for (let i = 0; i < n; i++) if (r() < 0.6) { expect(await mark(pend[i]!.id)).toEqual({ success: true }); marked.push(i); }
      // posted: new ids, +0/+1 day, descriptor possibly longer ("... Ser"), reference digits possibly different
      const posted = charges.map((c) => mk(newId(), c.acct, c.cents, day(c.day + ri(r, 0, 1)), r() < 0.3 ? `${c.desc.replace(/\d{5,}/g, "11111111")} Ser` : c.desc.replace(/\d{5,}/g, String(ri(r, 10000000, 99999999))), false));
      void posted.length;
      st.rows = [...posted].sort(() => r() - 0.5);
      const ex = await excludedIds();
      const groups = new Map<string, number[]>();
      charges.forEach((c, i) => groups.set(`${c.acct}|${c.cents}`, [...(groups.get(`${c.acct}|${c.cents}`) ?? []), i]));
      for (const [, idxs] of groups) {
        const nm = idxs.filter((i) => marked.includes(i)).length;
        const ne = idxs.filter((i) => ex.has(posted[i]!.id)).length;
        const span = Math.max(...idxs.map((i) => charges[i]!.day)) - Math.min(...idxs.map((i) => charges[i]!.day));
        if (idxs.length === 1) expect(ne, `world ${w}`).toBe(nm); // unambiguous: every mark found its row, no unmarked row excluded
        else if (span <= 3) expect(ne, `world ${w}`).toBeLessThanOrEqual(nm);
        else expect(ne, `world ${w}`).toBeLessThanOrEqual(nm);
        checked++;
      }
      // a posted row is never excluded unless its charge's account+cents has a mark
      for (const p of posted) {
        if (ex.has(p.id)) {
          const ci = posted.indexOf(p);
          expect(marked.some((mi) => charges[mi]!.acct === charges[ci]!.acct && charges[mi]!.cents === charges[ci]!.cents), `world ${w}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });
});
