// "Convert to recurring expense" on /budgets: the real action over the in-memory budget db (one locked transaction,
// create + end line together, duplicate reuse, refusals roll back) and the pure preview helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D, budgetRow, createFakeBudgetDb, type FakeRecurring } from "./budget-fake-db";
import {
  ancestorTags,
  convertBlockReason,
  convertPreview,
  defaultParentId,
  type ConvertTag,
} from "@/lib/budget-convert-recurring";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  current: { db: null as unknown },
}));
vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/lib/db", () => ({
  get db() {
    return m.current.db;
  },
}));

import { convertBudgetLineToRecurring } from "@/actions/budgets";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const E = uuid(1);
const OTHER_E = uuid(2);
const A1 = uuid(100);
const A2 = uuid(101);
const T = { root: uuid(10), subs: uuid(11), ring: uuid(12), food: uuid(13), loose: uuid(14) };

const TAGS: ConvertTag[] = [
  { id: T.root, name: "Memberships", shortName: "Memberships", parentId: null },
  { id: T.subs, name: "Memberships / Subs", shortName: "Subs", parentId: T.root },
  { id: T.ring, name: "Memberships / Subs / Ring", shortName: "Ring", parentId: T.subs },
  { id: T.food, name: "Food", shortName: "Food", parentId: null },
  { id: T.loose, name: "Loose", shortName: "Loose", parentId: null },
];

function world(opts: { recurring?: FakeRecurring[]; ringFrequency?: string; ringBudgeted?: string | null; onlyRing?: boolean } = {}) {
  const ring = budgetRow({
    entityId: E,
    tagId: T.ring,
    period: "2026-10",
    accountId: A2,
    budgeted: opts.ringBudgeted === null ? null : D(opts.ringBudgeted ?? "21.97"),
    payDay: 27,
    frequency: opts.ringFrequency ?? "monthly",
  });
  const rows = opts.onlyRing
    ? [ring]
    : [
        ring,
        budgetRow({ entityId: E, tagId: T.root, period: "2026-10", accountId: A1, budgeted: null }),
        budgetRow({ entityId: E, tagId: T.food, period: "2026-10", accountId: A1, budgeted: D("500") }),
        budgetRow({ entityId: E, tagId: T.ring, period: "2026-11", accountId: A2, budgeted: D("21.97") }),
        budgetRow({ entityId: E, tagId: T.food, period: "2026-11", accountId: A1, budgeted: D("500") }),
      ];
  const fake = createFakeBudgetDb({
    rows,
    tags: TAGS,
    entities: [{ id: E, name: "Personal", slug: "personal" }],
    accounts: [
      { id: A1, nickname: "Checking", entityId: E },
      { id: A2, nickname: "Card", entityId: E },
    ],
    bills: [{ id: "bill-ring", budgetTagId: T.ring, budgetEntityId: E, active: true }],
    recurring: opts.recurring ?? [],
  });
  m.current.db = fake.db;
  return fake;
}

const loc = { entityId: E, tagId: T.ring, period: "2026-10" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T16:00:00Z"));
  m.auth.mockReset();
  m.auth.mockResolvedValue({ user: { id: "user-1" } });
  m.revalidatePath.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("convertBudgetLineToRecurring", () => {
  it("requires a session before any database work", async () => {
    const { state } = world();
    m.auth.mockResolvedValue(null);
    await expect(convertBudgetLineToRecurring(loc, { parentTagId: T.root })).rejects.toThrow("Unauthorized");
    expect(state.transactions).toBe(0);
  });

  it("creates the recurring expense under the parent and ends the line from the month on, in one transaction", async () => {
    const { state } = world();
    const res = await convertBudgetLineToRecurring(loc, { parentTagId: T.root });
    expect(res).toEqual({ success: true, created: true, removedMonths: 2 });
    expect(state.recurring).toEqual([
      expect.objectContaining({ entityId: E, name: "Ring", amountCents: 2197, frequency: "monthly", dueDay: 27, tagId: T.root }),
    ]);
    expect(state.committed.filter((r) => r.tagId === T.ring)).toEqual([]);
    expect(state.committed.filter((r) => r.tagId === T.food).length).toBe(2);
    expect(state.bills[0]?.active).toBe(false);
    expect(state.transactions).toBe(1);
    expect(state.audit.map((a) => a.changeType)).toContain("budget_end_line");
  });

  it("reuses an existing recurring expense of the same name under the parent (no duplicate)", async () => {
    const existing: FakeRecurring = {
      id: "re-1", entityId: E, name: " ring ", amountCents: 2126, frequency: "monthly", dueDay: null, tagId: T.root, notes: "[pattern:x]",
    };
    const { state } = world({ recurring: [existing] });
    const res = await convertBudgetLineToRecurring(loc, { parentTagId: T.root });
    expect(res).toEqual({ success: true, created: false, removedMonths: 2 });
    expect(state.recurring).toEqual([existing]);
    expect(state.committed.filter((r) => r.tagId === T.ring)).toEqual([]);
  });

  it("a same-named expense in another entity or under another tag is not a duplicate", async () => {
    const { state } = world({
      recurring: [
        { id: "a", entityId: OTHER_E, name: "Ring", amountCents: 1, frequency: "monthly", dueDay: null, tagId: T.root, notes: null },
        { id: "b", entityId: E, name: "Ring", amountCents: 1, frequency: "monthly", dueDay: null, tagId: T.food, notes: null },
      ],
    });
    const res = await convertBudgetLineToRecurring(loc, { parentTagId: T.root });
    expect(res).toMatchObject({ success: true, created: true });
    expect(state.recurring.length).toBe(3);
  });

  it("accepts any ancestor, refuses a tag that is not an ancestor", async () => {
    const ok = world();
    expect(await convertBudgetLineToRecurring(loc, { parentTagId: T.subs })).toMatchObject({ success: true });
    expect(ok.state.recurring[0]?.tagId).toBe(T.subs);

    const { state } = world();
    const res = await convertBudgetLineToRecurring(loc, { parentTagId: T.food });
    expect(res).toEqual({ error: "Choose a parent category of this line." });
    expect(state.recurring).toEqual([]);
    expect(state.committed.filter((r) => r.tagId === T.ring).length).toBe(2);
  });

  it("refuses a non-monthly line, an auto-sum line and a line with linked recurring expenses, writing nothing", async () => {
    for (const [opts, msg] of [
      [{ ringFrequency: "weekly" }, /Only a monthly line/],
      [{ ringBudgeted: null }, /Set an amount/],
      [
        { recurring: [{ id: "x", entityId: E, name: "Cam", amountCents: 500, frequency: "monthly", dueDay: null, tagId: T.ring, notes: null }] },
        /already takes its amount from recurring expenses/,
      ],
    ] as const) {
      const { state } = world(opts as Parameters<typeof world>[0]);
      const before = state.recurring.length;
      const res = await convertBudgetLineToRecurring(loc, { parentTagId: T.root });
      expect("error" in res && res.error).toMatch(msg);
      expect(state.recurring.length).toBe(before);
      expect(state.committed.filter((r) => r.tagId === T.ring).length).toBeGreaterThan(0);
    }
  });

  it("when ending the line is refused (only line left), the new recurring expense is rolled back too", async () => {
    const { state } = world({ onlyRing: true });
    const res = await convertBudgetLineToRecurring(loc, { parentTagId: T.root });
    expect(res).toMatchObject({ error: expect.stringMatching(/only line left/) });
    expect(state.recurring).toEqual([]);
    expect(state.committed.length).toBe(1);
    expect(state.bills[0]?.active).toBe(true);
  });

  it("a line not on the month's budget is refused as stale", async () => {
    world();
    const res = await convertBudgetLineToRecurring({ ...loc, tagId: T.loose }, { parentTagId: T.root });
    expect(res).toMatchObject({ error: expect.stringMatching(/Refresh the page/) });
  });

  it("rejects bad input before opening a transaction", async () => {
    const { state } = world();
    expect(await convertBudgetLineToRecurring(loc, { parentTagId: "nope" })).toEqual({ error: "Choose a parent category" });
    expect(await convertBudgetLineToRecurring({ ...loc, period: "2026-13" }, { parentTagId: T.root })).toEqual({ error: "Invalid budget line" });
    expect(state.transactions).toBe(0);
  });
});

describe("convert helpers (pure)", () => {
  it("ancestors are nearest first; the default is the nearest ancestor with a budget line", () => {
    const anc = ancestorTags(T.ring, TAGS);
    expect(anc.map((t) => t.id)).toEqual([T.subs, T.root]);
    expect(defaultParentId(anc, new Set([T.root]))).toBe(T.root);
    expect(defaultParentId(anc, new Set())).toBe(T.subs);
    expect(ancestorTags(T.food, TAGS)).toEqual([]);
  });

  it("ancestorTags survives a cycle", () => {
    const loop: ConvertTag[] = [
      { id: "a", name: "a", shortName: "a", parentId: "b" },
      { id: "b", name: "b", shortName: "b", parentId: "a" },
    ];
    expect(ancestorTags("a", loop).map((t) => t.id)).toEqual(["b"]);
  });

  it("block reasons mirror the server", () => {
    const line = { tagId: T.ring, frequency: "monthly", budgetedRaw: 21.97, recurringCount: 0 };
    expect(convertBlockReason(line, TAGS)).toBeNull();
    expect(convertBlockReason({ ...line, tagId: T.food }, TAGS)).toMatch(/no parent/);
    expect(convertBlockReason({ ...line, frequency: "annual" }, TAGS)).toMatch(/monthly/);
    expect(convertBlockReason({ ...line, budgetedRaw: null }, TAGS)).toMatch(/Set an amount/);
    expect(convertBlockReason({ ...line, recurringCount: 1 }, TAGS)).toMatch(/Move them/);
  });

  it("preview: duplicate, parent already on recurring, parent on a stored figure, no parent line", () => {
    const parent = TAGS[0] as ConvertTag;
    const dup = convertPreview({
      lineShortName: "Ring",
      lineBudgeted: 21.97,
      parent,
      parentLine: { budgeted: 147.27, additionalAmountCents: 0, recurringMonthlySumCents: 14727 },
      recurring: [{ name: "Ring", tagId: T.root, amountCents: 2126, frequency: "monthly" }],
    });
    expect(dup.duplicate?.amountCents).toBe(2126);
    expect(dup.parentEffect).toBeNull();

    const onRecurring = convertPreview({
      lineShortName: "Ring", lineBudgeted: 21.97, parent,
      parentLine: { budgeted: 100, additionalAmountCents: 0, recurringMonthlySumCents: 10000 }, recurring: [],
    });
    expect(onRecurring.amountCents).toBe(2197);
    expect(onRecurring.parentEffect).toBe("The Memberships budget goes from $100.00 to $121.97.");

    const stored = convertPreview({
      lineShortName: "Ring", lineBudgeted: 21.97, parent,
      parentLine: { budgeted: 60, additionalAmountCents: 500, recurringMonthlySumCents: 0 }, recurring: [],
    });
    expect(stored.parentEffect).toMatch(/\$26\.97 instead of \$60\.00/);

    const none = convertPreview({ lineShortName: "Ring", lineBudgeted: 21.97, parent, parentLine: null, recurring: [] });
    expect(none.parentEffect).toMatch(/no budget line this month/);
  });
});
