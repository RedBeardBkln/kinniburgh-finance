// TESTER-authored adversarial tests for actions/recurring-suggestions.ts (pipeline task: recurring-detection).
// Mocks at the auth / db / loader boundary like the Coder's file; these target gaps: injected client fields, the
// 200-entry dismissal cap through the real settings wrapper, per-entity setting keys, order of side effects.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import type { DetectionBundle, Series } from "@/lib/recurring-detect";

const authMock = vi.hoisted(() => vi.fn());
const revalidate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));
const mockDb = vi.hoisted(() => ({
  recurringExpense: { findFirst: vi.fn(), create: vi.fn() },
  budget: { findFirst: vi.fn() },
  scheduledBill: { findFirst: vi.fn() },
  appSetting: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
const inputMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const runMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/upcoming-ledger-input", () => ({ loadUpcomingLedgerInput: inputMock }));
vi.mock("@/lib/recurring-detect-build", () => ({ fetchDetectionData: fetchMock, runDetection: runMock }));

import { addSuggestedRecurringExpense, dismissSuggestion, restoreSuggestion } from "@/actions/recurring-suggestions";

const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const KEY = `${E1}|acct-1|out|netflix`;

function series(over: Partial<Series> = {}): Series {
  return {
    key: KEY,
    entityId: E1,
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
const bundle = (s: Series[]): DetectionBundle => ({ suggestions: s, dismissed: [], flags: [], suppressed: [], suppressedCount: 0, staleCount: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user-1" } });
  inputMock.mockResolvedValue({ input: { from: new Date("2026-10-08T00:00:00Z"), days: 30, entityId: E1 } });
  fetchMock.mockResolvedValue({ rows: [], dismissed: [] });
  runMock.mockReturnValue({ result: {}, bundle: bundle([series()]) });
  mockDb.recurringExpense.findFirst.mockResolvedValue(null);
  mockDb.recurringExpense.create.mockResolvedValue({ id: "new" });
  mockDb.budget.findFirst.mockResolvedValue(null);
  mockDb.scheduledBill.findFirst.mockResolvedValue(null);
  mockDb.appSetting.findUnique.mockResolvedValue(null);
  mockDb.appSetting.upsert.mockResolvedValue({});
});

describe("no way to inject an amount, name, date or frequency", () => {
  it("extra client fields are ignored: the row is built only from the server's own series", async () => {
    const evil = { entityId: E1, seriesKey: KEY, amountCents: 1, name: "HACK", frequency: "weekly", dueDay: 31, tagId: E2, nextDueDate: "2000-01-01", notes: "x" };
    const res = await addSuggestedRecurringExpense(evil as unknown as { entityId: string; seriesKey: string });
    expect(res).toEqual({ success: true });
    const data = mockDb.recurringExpense.create.mock.calls[0]?.[0].data;
    expect(data.amountCents).toBe(2870);
    expect(data.name).toBe("Netflix");
    expect(data.frequency).toBe("monthly");
    expect(data.dueDay).toBe(5);
    expect(data.tagId).toBeNull();
    expect(data.notes).toBe("Added from a recurring pattern in your transactions.");
    expect((data.nextDueDate as Date).toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("a key for a series the server did not detect (forged key, same entity prefix) creates nothing", async () => {
    const res = await addSuggestedRecurringExpense({ entityId: E1, seriesKey: `${E1}|acct-1|out|forged payee` });
    expect(res).toEqual({ error: "That pattern is no longer detected." });
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
  });

  it("amount rounds to whole cents from the median, never a float artifact", async () => {
    runMock.mockReturnValue({ result: {}, bundle: bundle([series({ typicalAmount: new Decimal("1234.56") })]) });
    await addSuggestedRecurringExpense({ entityId: E1, seriesKey: KEY });
    expect(mockDb.recurringExpense.create.mock.calls[0]?.[0].data.amountCents).toBe(123456);
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    inputMock.mockResolvedValue({ input: { from: new Date("2026-10-08T00:00:00Z"), days: 30 } });
    fetchMock.mockResolvedValue({ rows: [], dismissed: [] });
    runMock.mockReturnValue({ result: {}, bundle: bundle([series({ typicalAmount: new Decimal("0.29") })]) });
    mockDb.recurringExpense.findFirst.mockResolvedValue(null);
    mockDb.recurringExpense.create.mockResolvedValue({ id: "n" });
    await addSuggestedRecurringExpense({ entityId: E1, seriesKey: KEY });
    expect(mockDb.recurringExpense.create.mock.calls[0]?.[0].data.amountCents).toBe(29);
  });

  it("the only write on the add path is one recurringExpense.create (no audit row, no other model)", async () => {
    await addSuggestedRecurringExpense({ entityId: E1, seriesKey: KEY });
    expect(mockDb.recurringExpense.create).toHaveBeenCalledTimes(1);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockDb.appSetting.upsert).not.toHaveBeenCalled();
  });
});

describe("dismissal list", () => {
  const stored = (n: number, entity = E1) =>
    JSON.stringify({ v: 1, keys: Array.from({ length: n }, (_, i) => ({ k: `${entity}|acct-1|out|payee ${i}`, at: "2026-01-01T00:00:00Z" })) });

  it("is capped at 200: the 201st dismissal drops the OLDEST and keeps the new one", async () => {
    mockDb.appSetting.findUnique.mockResolvedValue({ value: stored(200) });
    expect(await dismissSuggestion({ entityId: E1, seriesKey: KEY })).toEqual({ success: true });
    const written = JSON.parse(mockDb.appSetting.upsert.mock.calls[0]?.[0].create.value);
    expect(written.keys).toHaveLength(200);
    expect(written.keys.at(-1).k).toBe(KEY);
    expect(written.keys[0].k).toBe(`${E1}|acct-1|out|payee 1`);
  });

  it("a stored list longer than 200 (hand-edited) is trimmed on the next write", async () => {
    mockDb.appSetting.findUnique.mockResolvedValue({ value: stored(350) });
    await dismissSuggestion({ entityId: E1, seriesKey: KEY });
    expect(JSON.parse(mockDb.appSetting.upsert.mock.calls[0]?.[0].create.value).keys.length).toBeLessThanOrEqual(200);
  });

  it("is keyed per entity: the read and the write use that entity's own setting key only", async () => {
    await dismissSuggestion({ entityId: E1, seriesKey: KEY });
    await dismissSuggestion({ entityId: E2, seriesKey: `${E2}|acct-1|out|netflix` });
    expect(mockDb.appSetting.findUnique.mock.calls.map((c) => c[0].where.key)).toEqual([`recurring_dismissed:${E1}`, `recurring_dismissed:${E2}`]);
    expect(mockDb.appSetting.upsert.mock.calls.map((c) => c[0].where.key)).toEqual([`recurring_dismissed:${E1}`, `recurring_dismissed:${E2}`]);
  });

  it("dismissing twice does not duplicate; restoring a key that is not dismissed is harmless", async () => {
    mockDb.appSetting.findUnique.mockResolvedValue({ value: JSON.stringify({ v: 1, keys: [{ k: KEY, at: "" }] }) });
    await dismissSuggestion({ entityId: E1, seriesKey: KEY });
    expect(JSON.parse(mockDb.appSetting.upsert.mock.calls[0]?.[0].create.value).keys).toHaveLength(1);
    mockDb.appSetting.findUnique.mockResolvedValue(null);
    expect(await restoreSuggestion({ entityId: E1, seriesKey: KEY })).toEqual({ success: true });
  });

  it("a seriesKey longer than 300 characters or empty is refused without a write", async () => {
    expect(await dismissSuggestion({ entityId: E1, seriesKey: `${E1}|` + "x".repeat(400) })).toEqual({ error: "Invalid request" });
    expect(await dismissSuggestion({ entityId: E1, seriesKey: "" })).toEqual({ error: "Invalid request" });
    expect(mockDb.appSetting.upsert).not.toHaveBeenCalled();
  });

  it("dismiss does not need the detector (no loader call, no recurringExpense write)", async () => {
    await dismissSuggestion({ entityId: E1, seriesKey: KEY });
    expect(inputMock).not.toHaveBeenCalled();
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
  });
});
