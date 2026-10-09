import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { applyDismissals, detectRecurring, type DetectionBundle, type Series, type TxRow } from "@/lib/recurring-detect";

// Follow-up (2): the same payee on two accounts. The add action's "already recorded" check is by the series'
// display name, which now carries the account nickname, so each series can be added once and only once.

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockDb = vi.hoisted(() => ({
  recurringExpense: { findFirst: vi.fn(), create: vi.fn() },
  budget: { findFirst: vi.fn() },
  scheduledBill: { findFirst: vi.fn() },
  appSetting: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const inputMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const runMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/upcoming-ledger-input", () => ({ loadUpcomingLedgerInput: inputMock }));
vi.mock("@/lib/recurring-detect-build", () => ({ fetchDetectionData: fetchMock, runDetection: runMock }));

import { addSuggestedRecurringExpense } from "@/actions/recurring-suggestions";

const ENTITY = "11111111-1111-4111-8111-111111111111";
const KEY_CARD = `${ENTITY}|acct-card|out|maintenance fee`;
const KEY_SLUSH = `${ENTITY}|acct-slush|out|maintenance fee`;

function fee(account: "card" | "slush", over: Partial<Series> = {}): Series {
  const card = account === "card";
  return {
    key: card ? KEY_CARD : KEY_SLUSH,
    entityId: ENTITY,
    accountId: card ? "acct-card" : "acct-slush",
    kind: "outflow",
    payee: card ? "Maintenance Fee (Credit Cards)" : "Maintenance Fee (Slush Funds)",
    baseName: "Maintenance Fee",
    accountName: card ? "Credit Cards" : "Slush Funds",
    cadence: "monthly",
    typicalDay: card ? 3 : 5,
    dayRule: "usually around the 3rd",
    typicalAmount: new Decimal("15.00"),
    minAmount: new Decimal("15.00"),
    maxAmount: new Decimal("15.00"),
    amountMode: "fixed",
    occurrences: 6,
    firstSeen: new Date("2026-04-03T00:00:00Z"),
    lastSeen: new Date("2026-09-03T00:00:00Z"),
    nextExpected: new Date("2026-10-03T00:00:00Z"),
    confidence: "high",
    why: ["Seen 6 times"],
    dominantTagId: null,
    tagShare: 0,
    stale: false,
    suppressedBy: null,
    ...over,
  };
}

const created: string[] = [];
const createdDays: (number | null)[] = [];

function bundle(over: Partial<DetectionBundle> = {}): DetectionBundle {
  return { suggestions: [fee("card"), fee("slush")], dismissed: [], flags: [], suppressed: [], suppressedCount: 0, staleCount: 0, ...over };
}

function load(b: DetectionBundle) {
  inputMock.mockResolvedValue({ input: { from: new Date("2026-10-08T00:00:00Z"), days: 30, entityId: ENTITY } });
  fetchMock.mockResolvedValue({ rows: [], dismissed: [] });
  runMock.mockReturnValue({ result: {}, bundle: b });
}

beforeEach(() => {
  vi.clearAllMocks();
  created.length = 0;
  createdDays.length = 0;
  authMock.mockResolvedValue({ user: { id: "user-1" } });
  load(bundle());
  // A stand-in for the table: a row exists once its name has been created.
  mockDb.recurringExpense.findFirst.mockImplementation(async (args: { where: { name?: string } }) =>
    args.where.name !== undefined && created.includes(args.where.name) ? { id: "existing" } : null
  );
  mockDb.recurringExpense.create.mockImplementation(async (args: { data: { name: string; dueDay: number | null } }) => {
    created.push(args.data.name);
    createdDays.push(args.data.dueDay);
    return { id: "new" };
  });
  mockDb.budget.findFirst.mockResolvedValue(null);
  mockDb.scheduledBill.findFirst.mockResolvedValue(null);
});

describe("adding a same-payee series from each account", () => {
  it("both can be added, each under its own account-qualified name", async () => {
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_CARD })).toEqual({ success: true });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_SLUSH })).toEqual({ success: true });
    expect(created).toEqual(["Maintenance Fee (Credit Cards)", "Maintenance Fee (Slush Funds)"]);
    expect(mockDb.recurringExpense.create).toHaveBeenCalledTimes(2);
    // Server-derived values only: the day and amount come from each series.
    expect(mockDb.recurringExpense.create.mock.calls[0]?.[0].data).toMatchObject({ amountCents: 1500, dueDay: 3 });
    expect(mockDb.recurringExpense.create.mock.calls[1]?.[0].data).toMatchObject({ amountCents: 1500, dueDay: 5 });
  });

  it("adding the same one twice says 'Already recorded' and writes once", async () => {
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_CARD })).toEqual({ success: true });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_CARD })).toEqual({ error: "Already recorded" });
    expect(mockDb.recurringExpense.create).toHaveBeenCalledTimes(1);
  });

  it("adding one does not block the other, and the other can still be refused on its own second add", async () => {
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_SLUSH });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_CARD })).toEqual({ success: true });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_SLUSH })).toEqual({ error: "Already recorded" });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_CARD })).toEqual({ error: "Already recorded" });
    expect(mockDb.recurringExpense.create).toHaveBeenCalledTimes(2);
  });

  it("the already-recorded check is by the account-qualified name, per entity", async () => {
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_CARD });
    const lookups = mockDb.recurringExpense.findFirst.mock.calls.map((c) => c[0].where);
    expect(lookups[0]).toEqual({ entityId: ENTITY, name: "Maintenance Fee (Credit Cards)" });
  });

  it("a series with a single payee keeps the plain name", async () => {
    load(bundle({ suggestions: [fee("card", { payee: "Maintenance Fee", accountName: "Credit Cards" })] }));
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_CARD });
    expect(created).toEqual(["Maintenance Fee"]);
  });

  it("a suppressed series (recorded earlier under its own name) is refused as 'Already recorded' while the other stays addable", async () => {
    load(bundle({ suggestions: [fee("slush")], suppressed: [fee("card")], suppressedCount: 1 }));
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_CARD })).toEqual({ error: "Already recorded" });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_SLUSH })).toEqual({ success: true });
    expect(created).toEqual(["Maintenance Fee (Slush Funds)"]);
  });
});

describe("end to end with the real detector", () => {
  const rowsOf = (accountId: string, accountName: string, day: number): TxRow[] =>
    [4, 5, 6, 7, 8, 9].map((m) => ({
      entityId: ENTITY,
      accountId,
      accountType: "checking",
      accountName,
      payee: "maintenance fee",
      amount: new Decimal(-15),
      postedAt: new Date(Date.UTC(2026, m - 1, day)),
      tagIds: [],
    }));
  const history = [...rowsOf("acct-card", "Credit Cards", 3), ...rowsOf("acct-slush", "Slush Funds", 5)];

  // The detector sees what the action has created so far, exactly as the next page load would.
  function useRealDetector() {
    runMock.mockImplementation(() => {
      const modelled = created.map((name, i) => ({
        source: "recurring_expense" as const,
        sourceId: `rec-${i}`,
        entityId: ENTITY,
        accountId: null,
        label: name,
        direction: "outflow" as const,
        tagKey: null,
        monthly: new Decimal(15),
        day: createdDays[i] ?? null,
        cadence: "monthly" as const,
        expectedAmount: new Decimal(15),
      }));
      const result = detectRecurring({ rows: history, modelled, today: new Date("2026-10-08T00:00:00Z") });
      return { result, bundle: applyDismissals(result, []) };
    });
  }

  it("each series is hidden only after its own add; the other is still offered; a repeat is 'Already recorded'", async () => {
    useRealDetector();
    const offered = detectRecurring({ rows: history, modelled: [], today: new Date("2026-10-08T00:00:00Z") }).suggestions;
    expect(offered.map((k) => k.payee).sort()).toEqual(["Maintenance Fee (Credit Cards)", "Maintenance Fee (Slush Funds)"]);

    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_CARD })).toEqual({ success: true });
    // The Credit Cards one is now recorded (so it is suppressed and refused); the Slush Funds one is not.
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_CARD })).toEqual({ error: "Already recorded" });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_SLUSH })).toEqual({ success: true });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY_SLUSH })).toEqual({ error: "Already recorded" });
    expect(created).toEqual(["Maintenance Fee (Credit Cards)", "Maintenance Fee (Slush Funds)"]);
  });
});
