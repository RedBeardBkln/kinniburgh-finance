import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Decimal } from "@prisma/client/runtime/library";
import type { DetectionBundle, Series } from "@/lib/recurring-detect";

// Mocks at the db / auth / loader boundary (repo convention: no integrated DB tests).
const authMock = vi.hoisted(() => vi.fn());
const revalidate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));

const mockDb = vi.hoisted(() => ({
  recurringExpense: { findFirst: vi.fn(), create: vi.fn() },
  budget: { findFirst: vi.fn() },
  scheduledBill: { findFirst: vi.fn() },
  appSetting: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

// The detector itself is covered elsewhere; here the three read boundaries are stubbed.
const inputMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const runMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/upcoming-ledger-input", () => ({ loadUpcomingLedgerInput: inputMock }));
vi.mock("@/lib/recurring-detect-build", () => ({ fetchDetectionData: fetchMock, runDetection: runMock }));

import { addSuggestedRecurringExpense, dismissSuggestion, restoreSuggestion } from "@/actions/recurring-suggestions";

const ENTITY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TAG = "33333333-3333-4333-8333-333333333333";
const KEY = `${ENTITY}|acct-1|out|netflix`;

function series(over: Partial<Series> = {}): Series {
  return {
    key: KEY,
    entityId: ENTITY,
    accountId: "acct-1",
    kind: "outflow",
    payee: "Netflix",
    cadence: "monthly",
    typicalDay: 5,
    dayRule: "usually around the 5th",
    typicalAmount: new Decimal("28.70"),
    minAmount: new Decimal("28.70"),
    maxAmount: new Decimal("28.70"),
    amountMode: "fixed",
    occurrences: 6,
    firstSeen: new Date("2026-04-05T00:00:00Z"),
    lastSeen: new Date("2026-09-05T00:00:00Z"),
    nextExpected: new Date("2026-10-05T00:00:00Z"),
    confidence: "high",
    why: ["Seen 6 times"],
    dominantTagId: null,
    tagShare: 0,
    stale: false,
    suppressedBy: null,
    ...over,
  };
}

function bundle(over: Partial<DetectionBundle> = {}): DetectionBundle {
  return { suggestions: [series()], dismissed: [], flags: [], suppressed: [], suppressedCount: 0, staleCount: 0, ...over };
}

function setLoaded(b: DetectionBundle | null) {
  if (b === null) {
    inputMock.mockRejectedValue(new Error("db down"));
    return;
  }
  inputMock.mockResolvedValue({ input: { from: new Date("2026-10-08T00:00:00Z"), days: 30, entityId: ENTITY } });
  fetchMock.mockResolvedValue({ rows: [], dismissed: [] });
  runMock.mockReturnValue({ result: {}, bundle: b });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user-1" } });
  setLoaded(bundle());
  mockDb.recurringExpense.findFirst.mockResolvedValue(null);
  mockDb.recurringExpense.create.mockResolvedValue({ id: "new" });
  mockDb.budget.findFirst.mockResolvedValue(null);
  mockDb.scheduledBill.findFirst.mockResolvedValue(null);
  mockDb.appSetting.findUnique.mockResolvedValue(null);
  mockDb.appSetting.upsert.mockResolvedValue({});
});

describe("addSuggestedRecurringExpense", () => {
  it("creates exactly one RecurringExpense from server-derived values", async () => {
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY });
    expect(res).toEqual({ success: true });
    expect(mockDb.recurringExpense.create).toHaveBeenCalledTimes(1);
    const data = mockDb.recurringExpense.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      entityId: ENTITY,
      name: "Netflix",
      amountCents: 2870,
      frequency: "monthly",
      dueDay: 5,
      tagId: null,
    });
    expect((data.nextDueDate as Date).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(data.notes).toBe("Added from a recurring pattern in your transactions.");
    expect(revalidate).toHaveBeenCalledWith("/forecast");
    expect(revalidate).toHaveBeenCalledWith("/");
    expect(revalidate).toHaveBeenCalledWith("/budgets");
  });

  it("maps annual to 'annually', leaves dueDay empty for non-monthly, and notes a varying amount", async () => {
    setLoaded(bundle({ suggestions: [series({ cadence: "annual", typicalDay: 5, amountMode: "varies" })] }));
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY });
    const data = mockDb.recurringExpense.create.mock.calls[0]?.[0].data;
    expect(data.frequency).toBe("annually");
    expect(data.dueDay).toBeNull();
    expect(data.notes).toContain("The amount varies");
  });

  it("links the tag only at >= 60% share and only when nothing else already uses it", async () => {
    setLoaded(bundle({ suggestions: [series({ dominantTagId: TAG, tagShare: 0.6 })] }));
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY });
    expect(mockDb.recurringExpense.create.mock.calls[0]?.[0].data.tagId).toBe(TAG);

    vi.clearAllMocks();
    setLoaded(bundle({ suggestions: [series({ dominantTagId: TAG, tagShare: 0.59 })] }));
    mockDb.recurringExpense.findFirst.mockResolvedValue(null);
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY });
    expect(mockDb.recurringExpense.create.mock.calls[0]?.[0].data.tagId).toBeNull();

    vi.clearAllMocks();
    setLoaded(bundle({ suggestions: [series({ dominantTagId: TAG, tagShare: 0.9 })] }));
    mockDb.recurringExpense.findFirst.mockResolvedValue(null);
    mockDb.budget.findFirst.mockResolvedValue({ id: "budget-using-it" });
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY });
    expect(mockDb.recurringExpense.create.mock.calls[0]?.[0].data.tagId).toBeNull();
  });

  it("a suppressed (already recorded) series, a missing one and an existing name create nothing", async () => {
    setLoaded(bundle({ suggestions: [], suppressed: [series({ suppressedBy: { kind: "name", label: "Netflix", source: "recurring_expense" } })] }));
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY })).toEqual({ error: "Already recorded" });

    setLoaded(bundle({ suggestions: [] }));
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY })).toEqual({ error: "That pattern is no longer detected." });

    setLoaded(bundle());
    mockDb.recurringExpense.findFirst.mockResolvedValue({ id: "exists" });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY })).toEqual({ error: "Already recorded" });
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
  });

  it("refuses a deposit series, an unavailable detection and a key that does not belong to the entity", async () => {
    setLoaded(bundle({ suggestions: [series({ kind: "inflow" })] }));
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY })).toHaveProperty("error");
    setLoaded(null);
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY })).toEqual({ error: "Recurring-pattern checks are unavailable right now." });
    inputMock.mockResolvedValue({ input: { from: new Date("2026-10-08T00:00:00Z"), days: 30 } });
    fetchMock.mockRejectedValue(new Error("boom"));
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY })).toEqual({ error: "Recurring-pattern checks are unavailable right now." });
    expect(await addSuggestedRecurringExpense({ entityId: OTHER, seriesKey: KEY })).toEqual({ error: "Invalid request" });
    expect(await addSuggestedRecurringExpense({ entityId: "not-a-uuid", seriesKey: KEY })).toEqual({ error: "Invalid request" });
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
  });

  it("a dismissed series can still be added", async () => {
    setLoaded(bundle({ suggestions: [], dismissed: [series()] }));
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY })).toEqual({ success: true });
  });
});

describe("dismissSuggestion / restoreSuggestion", () => {
  it("dismiss writes the AppSetting JSON entry for the entity", async () => {
    expect(await dismissSuggestion({ entityId: ENTITY, seriesKey: KEY })).toEqual({ success: true });
    const call = mockDb.appSetting.upsert.mock.calls[0]?.[0];
    expect(call.where.key).toBe(`recurring_dismissed:${ENTITY}`);
    const parsed = JSON.parse(call.create.value);
    expect(parsed.v).toBe(1);
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0].k).toBe(KEY);
  });

  it("a corrupt stored value fails soft (treated as empty)", async () => {
    mockDb.appSetting.findUnique.mockResolvedValue({ value: "{{{ not json" });
    expect(await dismissSuggestion({ entityId: ENTITY, seriesKey: KEY })).toEqual({ success: true });
    expect(JSON.parse(mockDb.appSetting.upsert.mock.calls[0]?.[0].create.value).keys).toHaveLength(1);
  });

  it("restore removes only that series", async () => {
    const other = `${ENTITY}|acct-1|out|gym club`;
    mockDb.appSetting.findUnique.mockResolvedValue({
      value: JSON.stringify({ v: 1, keys: [{ k: KEY, at: "" }, { k: other, at: "" }] }),
    });
    expect(await restoreSuggestion({ entityId: ENTITY, seriesKey: KEY })).toEqual({ success: true });
    expect(JSON.parse(mockDb.appSetting.upsert.mock.calls[0]?.[0].create.value).keys.map((k: { k: string }) => k.k)).toEqual([other]);
  });

  it("rejects a key from another entity or a bad entity id without writing", async () => {
    expect(await dismissSuggestion({ entityId: OTHER, seriesKey: KEY })).toEqual({ error: "Invalid request" });
    expect(await restoreSuggestion({ entityId: "x", seriesKey: KEY })).toEqual({ error: "Invalid request" });
    expect(mockDb.appSetting.upsert).not.toHaveBeenCalled();
  });
});

describe("auth gate and write surface", () => {
  it("every action rejects without a session, before any read or write", async () => {
    authMock.mockResolvedValue(null);
    await expect(addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY })).rejects.toThrow("Unauthorized");
    await expect(dismissSuggestion({ entityId: ENTITY, seriesKey: KEY })).rejects.toThrow("Unauthorized");
    await expect(restoreSuggestion({ entityId: ENTITY, seriesKey: KEY })).rejects.toThrow("Unauthorized");
    expect(inputMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
    expect(mockDb.appSetting.upsert).not.toHaveBeenCalled();
  });

  const SRC = readFileSync(resolve(__dirname, "../../actions/recurring-suggestions.ts"), "utf8").replace(/\r\n/g, "\n");

  it("source: every export starts with `await requireAuth();` (not vacuous)", () => {
    const names = [...SRC.matchAll(/export async function (\w+)\s*\(([^)]*)\)[^{]*\{\n(.*)\n/g)];
    expect(names.map((m) => m[1])).toEqual(["addSuggestedRecurringExpense", "dismissSuggestion", "restoreSuggestion"]);
    for (const m of names) expect((m[3] as string).trim(), m[1]).toBe("await requireAuth();");
  });

  it("source: the client names a series only; no amount, no deleteMany / upsert / delete on recurringExpense", () => {
    expect(SRC).not.toMatch(/recurringExpense\.(deleteMany|upsert|delete|update|updateMany)\b/);
    expect(SRC).not.toMatch(/amountCents:\s*(input|parsed)/);
    expect(SRC).toMatch(/refSchema = z\.object\(\{\s*entityId: z\.string\(\)\.uuid\(\),\s*seriesKey: z\.string\(\)\.min\(1\)\.max\(300\),\s*\}\)/);
    expect(SRC).not.toMatch(/db.auditLog/);
  });
});
