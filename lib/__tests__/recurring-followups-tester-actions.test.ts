import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { applyDismissals, detectRecurring, type TxRow } from "@/lib/recurring-detect";
import { toUiDetection } from "@/lib/upcoming-ledger-view";
import { seriesMarker, seriesKeyFromNotes, visibleNotes } from "@/lib/recurring-series-marker";
import { validateRecurringName } from "@/lib/recurring-name";

// Tester: the add action against a STATEFUL fake table + the REAL detector (and the real collectModelledRefs), fuzzed.
// Properties: every add is idempotent, hides exactly its own series (whatever it was renamed / tagged), never any other,
// the written amount / frequency / day equal what the review list showed, and the client cannot influence them.

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

interface Row {
  id: string;
  entityId: string;
  name: string;
  amountCents: number;
  frequency: string;
  dueDay: number | null;
  nextDueDate: Date | null;
  tagId: string | null;
  notes: string | null;
}
const table = vi.hoisted(() => ({ rows: [] as unknown[], tags: new Set<string>(), writes: 0 }));

const mockDb = vi.hoisted(() => ({
  recurringExpense: { findFirst: vi.fn(), create: vi.fn() },
  budget: { findFirst: vi.fn() },
  scheduledBill: { findFirst: vi.fn() },
  tag: { findUnique: vi.fn() },
  appSetting: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const inputMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/upcoming-ledger-input", () => ({ loadUpcomingLedgerInput: inputMock }));
vi.mock("@/lib/recurring-detect-build", async (orig) => ({ ...(await orig<typeof import("@/lib/recurring-detect-build")>()), fetchDetectionData: fetchMock }));

import { addSuggestedRecurringExpense } from "@/actions/recurring-suggestions";

const ENTITY = "11111111-1111-4111-8111-111111111111";
const TODAY = new Date("2026-10-08T00:00:00Z");

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
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

let history: TxRow[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  table.rows = [];
  table.writes = 0;
  authMock.mockResolvedValue({ user: { id: "u1" } });
  mockDb.tag.findUnique.mockImplementation(async (a: { where: { id: string } }) => (table.tags.has(a.where.id) ? { id: a.where.id } : null));
  mockDb.budget.findFirst.mockResolvedValue(null);
  mockDb.scheduledBill.findFirst.mockResolvedValue(null);
  mockDb.recurringExpense.findFirst.mockImplementation(async (a: { where: { entityId: string; name?: string; tagId?: string; notes?: { contains: string } } }) => {
    const w = a.where;
    const hit = (table.rows as Row[]).find(
      (r) =>
        r.entityId === w.entityId &&
        (w.name === undefined || r.name === w.name) &&
        (w.tagId === undefined || r.tagId === w.tagId) &&
        (w.notes === undefined || (r.notes ?? "").includes(w.notes.contains))
    );
    return hit ? { id: hit.id } : null;
  });
  mockDb.recurringExpense.create.mockImplementation(async (a: { data: Omit<Row, "id"> }) => {
    table.writes += 1;
    const row: Row = { id: `rec-${table.writes}`, ...a.data };
    (table.rows as Row[]).push(row);
    return { id: row.id };
  });
  inputMock.mockImplementation(async () => ({
    input: {
      from: TODAY,
      days: 30,
      entityId: ENTITY,
      recurring: (table.rows as Row[]).map((r) => ({ id: r.id, entityId: r.entityId, name: r.name, amountCents: r.amountCents, frequency: r.frequency, dueDay: r.dueDay, nextDueDate: r.nextDueDate, tagId: r.tagId, notes: r.notes })),
    },
  }));
  fetchMock.mockImplementation(async () => ({ rows: history, dismissed: [] }));
});

// distinctive-word payees, a unique amount each, so the (pre-existing) name / amount+day heuristics never confuse payees
const PAYEES = [
  { payee: "netflix", amount: 22.49 }, { payee: "spotify", amount: 11.99 }, { payee: "maintenance fee", amount: 15 },
  { payee: "gymclub", amount: 49 }, { payee: "waterco", amount: 38.4 }, { payee: "cloudbox", amount: 2.99 + 4 },
];
const ACCOUNTS = [
  { id: "acct-card", name: "Credit Cards" }, { id: "acct-slush", name: "Slush Funds" }, { id: "acct-chk", name: "Primary Checking" },
];

function months(day: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 8 - i, day)).toISOString().slice(0, 10)).reverse();
}

function scenario(r: () => number): TxRow[] {
  const rows: TxRow[] = [];
  const payees = [...PAYEES].sort(() => r() - 0.5).slice(0, int(r, 2, 4));
  const tagPool = ["11111111-1111-4111-8111-aaaaaaaaaaa1", "11111111-1111-4111-8111-aaaaaaaaaaa2"];
  for (const p of payees) {
    const accts = [...ACCOUNTS].sort(() => r() - 0.5).slice(0, int(r, 1, 3));
    const tag = r() < 0.5 ? pick(r, tagPool) : null;
    accts.forEach((a, i) => {
      for (const date of months(2 + i * 5 + int(r, 0, 1), 7))
        rows.push({ entityId: ENTITY, accountId: a.id, accountType: "checking", accountName: a.name, payee: p.payee, amount: new Decimal(-p.amount), postedAt: new Date(`${date}T00:00:00Z`), tagIds: tag ? [tag] : [] });
    });
  }
  return rows;
}

describe("tester: add-loop fuzz with the real detector", () => {
  it("each add is idempotent, hides exactly its own series, and writes only server-derived money", async () => {
    const { collectModelledRefs } = await import("@/lib/upcoming-ledger");
    const r = rng(20261009);
    let adds = 0;
    let multiAccount = 0;
    for (let round = 0; round < 60; round++) {
      history = scenario(r);
      table.rows = [];
      table.tags = new Set(["11111111-1111-4111-8111-aaaaaaaaaaa1", "11111111-1111-4111-8111-aaaaaaaaaaa2"]);
      const tagIds = [...table.tags];
      const run = async () => {
        const { input } = await inputMock();
        return detectRecurring({ rows: history, modelled: collectModelledRefs(input), today: TODAY });
      };

      let state = await run();
      const names0 = state.suggestions.map((s) => s.payee);
      // naming: a suffix exactly when another active series of the same payee exists in the entity
      for (const s of [...state.suggestions, ...state.suppressed]) {
        const same = [...state.suggestions, ...state.suppressed].filter((x) => x.baseName === s.baseName);
        if (same.length > 1) {
          expect(s.payee).toBe(`${s.baseName} (${s.accountName})`);
          multiAccount += 1;
        } else expect(s.payee).toBe(s.baseName);
        expect(s.payee).not.toMatch(/\d{4,}/); // nicknames only, never a number
      }
      expect(new Set(names0).size).toBe(names0.length); // display names unique

      const order = state.suggestions.filter((s) => s.kind === "outflow").map((s) => s.key).sort(() => r() - 0.5);
      for (const key of order) {
        const before = await run();
        const beforeKeys = new Set(before.suggestions.map((s) => s.key));
        if (!beforeKeys.has(key)) continue; // hidden already by a legitimate name overlap: out of scope for this property
        const series = before.suggestions.find((s) => s.key === key)!;
        const ui = toUiDetection(applyDismissals(before, []), { [ENTITY]: "Personal" }, "2026-10-08").suggestions.find((u) => u.key === key)!;

        const mode = pick(r, ["default", "rename", "tag", "rename+tag", "notag"] as const);
        const req: { entityId: string; seriesKey: string; tagId?: string | null; name?: string } = { entityId: ENTITY, seriesKey: key };
        if (mode.includes("rename")) req.name = `Custom ${adds} ${series.baseName.length}`;
        if (mode.includes("tag")) req.tagId = pick(r, tagIds);
        if (mode === "notag") req.tagId = null;
        // hostile extras the client must not be able to use
        const hostile = { ...req, amountCents: 1, frequency: "weekly", dueDay: 31, nextDueDate: "2001-01-01", notes: "pwn", cadence: "weekly" };

        const rowsBefore = (table.rows as Row[]).length;
        const res = await addSuggestedRecurringExpense(hostile as never);
        expect(res, JSON.stringify({ key, mode, typ: series.typicalAmount.toString(), cad: series.cadence, day: series.typicalDay, name: req.name })).toMatchObject({ success: true });
        adds += 1;
        const row = (table.rows as Row[])[rowsBefore]!;
        expect((table.rows as Row[]).length).toBe(rowsBefore + 1);

        // server-derived money == what the review list displayed
        expect(row.amountCents).toBe(ui.amountCents);
        expect(row.frequency).toBe(ui.recurringFrequency);
        expect(row.amountCents).not.toBe(1);
        expect(row.notes).not.toContain("pwn");
        expect(row.dueDay).toBe(series.cadence === "monthly" ? series.typicalDay : null);
        expect(row.name).toBe(req.name ?? series.payee);
        expect(seriesKeyFromNotes(row.notes)).toBe(key);
        expect(visibleNotes(row.notes) ?? "").not.toContain("[pattern:");
        expect(row.notes!.length).toBeLessThanOrEqual(500);
        // no account number / PII in the marker: the key is uuid|account id|out|canonical payee
        expect(seriesMarker(key)).toBe(`[pattern:${key}]`);

        // exactly this series disappears; every other suggestion survives with an unchanged display name
        const after = await run();
        const afterKeys = new Set(after.suggestions.map((s) => s.key));
        expect(afterKeys.has(key)).toBe(false);
        expect(after.suppressed.some((s) => s.key === key)).toBe(true);
        for (const k of beforeKeys) if (k !== key) expect(afterKeys.has(k), JSON.stringify({ added: key, mode, req, lost: k, sup: after.suppressed.find((s) => s.key === k)?.suppressedBy, rec: (table.rows as Row[]).map((x) => [x.name, x.tagId, x.amountCents, x.dueDay]) })).toBe(true);
        for (const s of after.suggestions) expect(s.payee).toBe(before.suggestions.find((b) => b.key === s.key)!.payee);

        // a repeat is refused and writes nothing, even though the first row may carry another name
        const again = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: key, name: "Another name" });
        expect(again).toEqual({ error: "Already recorded" });
        expect((table.rows as Row[]).length).toBe(rowsBefore + 1);
      }
      state = await run();
      expect(state.suggestions.filter((s) => s.kind === "outflow")).toEqual([]);
    }
    expect(adds).toBeGreaterThan(100);
    expect(multiAccount).toBeGreaterThan(20);
  });

  it("an older unsuffixed record hides both same-payee series (documented), a new qualified record hides only its own", async () => {
    const { collectModelledRefs } = await import("@/lib/upcoming-ledger");
    history = [...ACCOUNTS.slice(0, 2).flatMap((a, i) => months(3 + i * 2, 7).map((date) => ({ entityId: ENTITY, accountId: a.id, accountType: "checking", accountName: a.name, payee: "maintenance fee", amount: new Decimal(-15), postedAt: new Date(`${date}T00:00:00Z`), tagIds: [] })))];
    const base = { id: "x", entityId: ENTITY, amountCents: 1500, frequency: "monthly", dueDay: 3, nextDueDate: null, tagId: null };
    const sugg = (rows: unknown[]) => detectRecurring({ rows: history, modelled: collectModelledRefs({ from: TODAY, days: 30, entityId: ENTITY, recurring: rows as never }), today: TODAY }).suggestions.map((s) => s.payee).sort();
    expect(sugg([])).toEqual(["Maintenance Fee (Credit Cards)", "Maintenance Fee (Slush Funds)"]);
    expect(sugg([{ ...base, name: "Maintenance Fee" }])).toEqual([]);
    expect(sugg([{ ...base, name: "Maintenance Fee (Credit Cards)" }])).toEqual(["Maintenance Fee (Slush Funds)"]);
    expect(sugg([{ ...base, name: "Maintenance Fee (Slush Funds)" }])).toEqual(["Maintenance Fee (Credit Cards)"]);
    expect(sugg([{ ...base, name: "Maintenance Fee (Credit Cards)" }, { ...base, id: "y", name: "Maintenance Fee (Slush Funds)" }])).toEqual([]);
  });
});

describe("tester: name validation matrix", () => {
  const bad = [
    "", "   ", "x".repeat(81), "<b>x</b>", "a>b", "＜b＞x", "nul\u0000", "bell\u0007x", "del\u007fx", "123-45-6789", "123 45 6789", "123456789", "12-3456789",
    "4111 1111 1111 1111", "4111-1111-1111-1111", "1234567890123456", "acct 000123456789",
    "１２３-４５-６７８９", // full-width digits (NFKC folds them)
    "123​-45-6789", // zero-width space inside an SSN
    "123­-45-6789", // soft hyphen
  ];
  for (const b of bad) {
    it(`refuses ${JSON.stringify(b).slice(0, 40)}`, () => {
      const res = validateRecurringName(b);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(JSON.stringify(res)).not.toContain("6789"); // never echoed
    });
  }
  const good = ["Netflix", "Maintenance Fee (Credit Cards)", "Gym 24/7", "Mom's phone", "x".repeat(80), "Café ☕", "  spaced   out  "];
  for (const g of good) {
    it(`accepts ${JSON.stringify(g).slice(0, 40)}`, () => {
      const res = validateRecurringName(g);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(g.normalize("NFKC").replace(/\s+/g, " ").trim());
        expect(res.value.length).toBeLessThanOrEqual(80);
      }
    });
  }
  it("non-strings are refused", () => {
    for (const v of [null, undefined, 5, {}, [], ["a"]]) expect(validateRecurringName(v).ok).toBe(false);
  });
});

describe("tester: KNOWN LOW defect pinned - the name check is keyed to the DEFAULT name only", () => {
  it("a row the owner renamed to ANOTHER series' qualified name blocks that other series' add, whatever name the owner now picks", async () => {
    const card = `${ENTITY}|acct-card|out|maintenance fee`;
    const slush = `${ENTITY}|acct-slush|out|maintenance fee`;
    history = [
      ...months(3, 7).map((date) => ({ entityId: ENTITY, accountId: "acct-card", accountType: "checking", accountName: "Credit Cards", payee: "maintenance fee", amount: new Decimal(-15), postedAt: new Date(`${date}T00:00:00Z`), tagIds: [] })),
      ...months(5, 7).map((date) => ({ entityId: ENTITY, accountId: "acct-slush", accountType: "checking", accountName: "Slush Funds", payee: "maintenance fee", amount: new Decimal(-15), postedAt: new Date(`${date}T00:00:00Z`), tagIds: [] })),
    ];
    // the Credit Cards series was added earlier and the owner typed the Slush Funds name on it
    (table.rows as Row[]).push({ id: "x", entityId: ENTITY, name: "Maintenance Fee (Slush Funds)", amountCents: 1500, frequency: "monthly", dueDay: 3, nextDueDate: null, tagId: null, notes: `Added. ${seriesMarker(card)}` });
    const { collectModelledRefs } = await import("@/lib/upcoming-ledger");
    const { input } = await inputMock();
    const offeredNow = detectRecurring({ rows: history, modelled: collectModelledRefs(input), today: TODAY }).suggestions.map((s) => s.key);
    expect(offeredNow).toEqual([slush]); // the detector still offers it
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: slush, name: "Slush bank fee" });
    // the Slush Funds series is still offered by the detector, yet the add is refused as 'Already recorded'
    expect(res).toEqual({ error: "Already recorded" });
    expect(table.writes).toBe(0);
  });
});

describe("tester: action guards", () => {
  const key = `${ENTITY}|acct-card|out|netflix`;
  it("unauthenticated throws before anything is read", async () => {
    authMock.mockResolvedValue(null);
    await expect(addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: key })).rejects.toThrow("Unauthorized");
    expect(mockDb.tag.findUnique).not.toHaveBeenCalled();
    expect(inputMock).not.toHaveBeenCalled();
    authMock.mockResolvedValue({ user: {} });
    await expect(addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: key })).rejects.toThrow("Unauthorized");
  });
  it("a name problem is reported before any db or loader call; an unknown tag before the detector", async () => {
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: key, name: "123-45-6789" })).toMatchObject({ error: expect.stringContaining("ID or account number") });
    expect(mockDb.tag.findUnique).not.toHaveBeenCalled();
    expect(inputMock).not.toHaveBeenCalled();
    table.tags = new Set();
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: key, tagId: "11111111-1111-4111-8111-bbbbbbbbbbbb" })).toEqual({ error: "That budget category no longer exists." });
    expect(inputMock).not.toHaveBeenCalled();
    expect(table.writes).toBe(0);
  });
  it("malformed input, foreign-entity key, oversized name and non-uuid tag are 'Invalid request' with no write", async () => {
    for (const bad of [
      { entityId: "nope", seriesKey: key },
      { entityId: ENTITY, seriesKey: "22222222-2222-4222-8222-222222222222|a|out|x" },
      { entityId: ENTITY, seriesKey: key, name: "x".repeat(501) },
      { entityId: ENTITY, seriesKey: key, tagId: "not-a-uuid" },
      { entityId: ENTITY, seriesKey: "" },
      { entityId: ENTITY, seriesKey: "x".repeat(301) },
    ]) {
      expect(await addSuggestedRecurringExpense(bad as never)).toEqual({ error: "Invalid request" });
    }
    expect(table.writes).toBe(0);
  });
  it("deposits cannot be added", async () => {
    history = months(1, 7).map((date) => ({ entityId: ENTITY, accountId: "acct-chk", accountType: "checking", accountName: "Primary Checking", payee: "acme consulting", amount: new Decimal(2500), postedAt: new Date(`${date}T00:00:00Z`), tagIds: [] }));
    const inflow = detectRecurring({ rows: history, modelled: [], today: TODAY }).suggestions.find((s) => s.kind === "inflow");
    expect(inflow).toBeTruthy();
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: inflow!.key });
    expect(res).toEqual({ error: "Only recurring expenses can be added here." });
    expect(table.writes).toBe(0);
  });
});
