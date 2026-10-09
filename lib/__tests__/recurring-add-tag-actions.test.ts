import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Decimal } from "@prisma/client/runtime/library";
import { applyDismissals, detectRecurring, type DetectionBundle, type Series, type TxRow } from "@/lib/recurring-detect";
import { collectModelledRefs } from "@/lib/upcoming-ledger";
import { seriesMarker } from "@/lib/recurring-series-marker";

// Follow-up: link each suggestion to a budget tag (and let the owner rename it) when it is added.
// The server action must (a) accept only {entityId, seriesKey, tagId?, name?}, (b) validate the tag and the name,
// (c) still re-derive every amount / frequency / day from the series, and (d) stay idempotent per SERIES, even renamed.

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockDb = vi.hoisted(() => ({
  recurringExpense: { findFirst: vi.fn(), create: vi.fn() },
  budget: { findFirst: vi.fn() },
  scheduledBill: { findFirst: vi.fn() },
  tag: { findUnique: vi.fn() },
  appSetting: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const inputMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const runMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/upcoming-ledger-input", () => ({ loadUpcomingLedgerInput: inputMock }));
vi.mock("@/lib/recurring-detect-build", () => ({ fetchDetectionData: fetchMock, runDetection: runMock }));

import { addSuggestedRecurringExpense } from "@/actions/recurring-suggestions";

const ENTITY = "11111111-1111-4111-8111-111111111111";
const TAG_STREAMING = "33333333-3333-4333-8333-333333333333";
const TAG_OTHER = "44444444-4444-4444-8444-444444444444";
const KEY = `${ENTITY}|acct-1|out|netflix`;

function series(over: Partial<Series> = {}): Series {
  return {
    key: KEY,
    entityId: ENTITY,
    accountId: "acct-1",
    kind: "outflow",
    payee: "Netflix",
    baseName: "Netflix",
    accountName: null,
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

function load(b: DetectionBundle) {
  inputMock.mockResolvedValue({ input: { from: new Date("2026-10-08T00:00:00Z"), days: 30, entityId: ENTITY } });
  fetchMock.mockResolvedValue({ rows: [], dismissed: [] });
  runMock.mockReturnValue({ result: {}, bundle: b });
}

const createdData = () => mockDb.recurringExpense.create.mock.calls[0]?.[0].data;

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "user-1" } });
  load(bundle());
  mockDb.recurringExpense.findFirst.mockResolvedValue(null);
  mockDb.recurringExpense.create.mockResolvedValue({ id: "new" });
  mockDb.budget.findFirst.mockResolvedValue(null);
  mockDb.scheduledBill.findFirst.mockResolvedValue(null);
  mockDb.tag.findUnique.mockResolvedValue({ id: TAG_STREAMING });
});

describe("tag choice", () => {
  it("links the tag the owner chose, even when other recurring expenses already use it", async () => {
    mockDb.recurringExpense.findFirst.mockResolvedValue(null);
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: TAG_STREAMING });
    expect(res).toEqual({ success: true });
    expect(createdData().tagId).toBe(TAG_STREAMING);
    expect(mockDb.tag.findUnique).toHaveBeenCalledWith({ where: { id: TAG_STREAMING }, select: { id: true } });
    // The legacy "nothing else uses it" probe is NOT applied to an explicit choice (several expenses may share a tag).
    expect(mockDb.recurringExpense.findFirst.mock.calls.some((c) => c[0].where.tagId !== undefined)).toBe(false);
  });

  it("'No tag' (null) links nothing, even when the series has a dominant tag at 90%", async () => {
    load(bundle({ suggestions: [series({ dominantTagId: TAG_STREAMING, tagShare: 0.9 })] }));
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null });
    expect(res).toEqual({ success: true });
    expect(createdData().tagId).toBeNull();
    expect(mockDb.tag.findUnique).not.toHaveBeenCalled();
  });

  it("a tag id that no longer exists is refused before anything is read or written", async () => {
    mockDb.tag.findUnique.mockResolvedValue(null);
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: TAG_OTHER });
    expect(res).toEqual({ error: "That budget category no longer exists." });
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
    expect(inputMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a malformed tag id is an invalid request", async () => {
    for (const tagId of ["not-a-uuid", "", "1", "33333333-3333-4333-8333-33333333333g"]) {
      const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId });
      expect(res).toEqual({ error: "Invalid request" });
    }
    expect(mockDb.tag.findUnique).not.toHaveBeenCalled();
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
  });

  it("tags are household-wide: validity is existence only (the Tag model has no archived or entity column)", () => {
    // If a column is ever added, this fails and the action's validation (and its tests) must grow with it.
    const schema = readFileSync(resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
    const tagModel = /model Tag \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(tagModel).toContain("model Tag {");
    expect(tagModel).not.toMatch(/archivedAt|entityId|deletedAt|active\b/);
    // And the lookup is by id alone: no entity filter is invented.
    const src = readFileSync(resolve(__dirname, "../../actions/recurring-suggestions.ts"), "utf8");
    expect(src).toMatch(/db\.tag\.findUnique\(\{ where: \{ id: chosenTagId \}/);
  });

  it("without a tagId (older callers) the server's own >= 60% / nothing-else-uses-it rule still applies", async () => {
    load(bundle({ suggestions: [series({ dominantTagId: TAG_STREAMING, tagShare: 0.7 })] }));
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY });
    expect(createdData().tagId).toBe(TAG_STREAMING);
  });

  it("says so when the chosen category already has a budget line or a scheduled bill", async () => {
    mockDb.budget.findFirst.mockResolvedValue({ id: "b1" });
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: TAG_STREAMING });
    expect(res).toMatchObject({ success: true });
    expect((res as { notice?: string }).notice).toMatch(/already has a budget line or a scheduled bill/);
    expect((res as { notice?: string }).notice).not.toMatch(/\$|should|recommend/i);
    // The row is still created: the notice informs, it does not block.
    expect(mockDb.recurringExpense.create).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    load(bundle());
    mockDb.recurringExpense.findFirst.mockResolvedValue(null);
    mockDb.recurringExpense.create.mockResolvedValue({ id: "n" });
    mockDb.budget.findFirst.mockResolvedValue(null);
    mockDb.scheduledBill.findFirst.mockResolvedValue({ id: "s1" });
    mockDb.tag.findUnique.mockResolvedValue({ id: TAG_STREAMING });
    const res2 = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: TAG_STREAMING });
    expect((res2 as { notice?: string }).notice).toBeTruthy();
  });

  it("no notice when the category is used by nothing else", async () => {
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: TAG_STREAMING });
    expect(res).toEqual({ success: true });
  });
});

describe("name", () => {
  it("is trimmed and whitespace-collapsed, and replaces the default name", async () => {
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null, name: "  Netflix   family \t plan  " });
    expect(res).toEqual({ success: true });
    expect(createdData().name).toBe("Netflix family plan");
  });

  it("falls back to the suggestion's display name (account suffix included) when none is sent", async () => {
    load(bundle({ suggestions: [series({ payee: "Maintenance Fee (Credit Cards)" })] }));
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null });
    expect(createdData().name).toBe("Maintenance Fee (Credit Cards)");
  });

  it("accepts exactly 80 characters and refuses 81 or none", async () => {
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null, name: "a".repeat(80) })).toEqual({ success: true });
    for (const name of ["a".repeat(81), "", "   ", "​​"]) {
      const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null, name });
      expect(res).toEqual({ error: "Give it a name (1 to 80 characters)." });
    }
    expect(mockDb.recurringExpense.create).toHaveBeenCalledTimes(1);
  });

  it("refuses HTML and control characters", async () => {
    for (const name of ["<b>Netflix</b>", "Netflix <script>", "a > b", "bad\u0000name"]) {
      const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null, name });
      expect(res).toEqual({ error: "The name cannot contain < or > or control characters." });
    }
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
  });

  it("refuses SSN-, EIN- and account-number-like names without echoing them", async () => {
    for (const name of ["Netflix 123-45-6789", "EIN 12-3456789", "Card 4111 1111 1111 1111", "Acct 123456789012", "123456789"]) {
      const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null, name });
      expect(res).toEqual({ error: "That name looks like it contains an ID or account number; remove it." });
      expect(JSON.stringify(res)).not.toMatch(/\d{4}/);
    }
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
  });

  it("is validated before any database or loader call", async () => {
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: TAG_STREAMING, name: "<x>" });
    expect(mockDb.tag.findUnique).not.toHaveBeenCalled();
    expect(inputMock).not.toHaveBeenCalled();
  });

  it("a non-string name is an invalid request", async () => {
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null, name: 5 as unknown as string });
    expect(res).toEqual({ error: "Invalid request" });
  });
});

describe("the client cannot influence the money", () => {
  it("amount, frequency, day, date, notes and cadence in the request are ignored; name and tag are the only extras honoured", async () => {
    const evil = {
      entityId: ENTITY,
      seriesKey: KEY,
      tagId: TAG_STREAMING,
      name: "Streaming TV",
      amountCents: 1,
      frequency: "weekly",
      dueDay: 31,
      cadence: "annual",
      typicalAmount: "0.01",
      nextDueDate: "2000-01-01",
      notes: "[pattern:someone-else]",
    };
    const res = await addSuggestedRecurringExpense(evil as unknown as { entityId: string; seriesKey: string });
    expect(res).toEqual({ success: true });
    const data = createdData();
    expect(data.amountCents).toBe(2870);
    expect(data.frequency).toBe("monthly");
    expect(data.dueDay).toBe(5);
    expect(data.name).toBe("Streaming TV");
    expect(data.tagId).toBe(TAG_STREAMING);
    expect(data.notes).toBe(`Added from a recurring pattern in your transactions. ${seriesMarker(KEY)}`);
    expect((data.nextDueDate as Date).toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("a series key that was not detected still creates nothing, whatever tag and name are sent", async () => {
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: `${ENTITY}|acct-1|out|forged`, tagId: TAG_STREAMING, name: "Forged" });
    expect(res).toEqual({ error: "That pattern is no longer detected." });
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
  });

  it("a series key for another entity is refused", async () => {
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: "22222222-2222-4222-8222-222222222222|a|out|x", tagId: null });
    expect(res).toEqual({ error: "Invalid request" });
  });

  it("unauthenticated: throws before any validation, lookup or write", async () => {
    authMock.mockResolvedValue(null);
    await expect(addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: TAG_STREAMING, name: "x" })).rejects.toThrow("Unauthorized");
    expect(mockDb.tag.findUnique).not.toHaveBeenCalled();
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
  });

  it("the stored notes fit the 500-character limit even for the longest accepted series key", async () => {
    const longKey = `${ENTITY}|` + "a".repeat(300 - ENTITY.length - 1);
    expect(longKey).toHaveLength(300);
    load(bundle({ suggestions: [series({ key: longKey, amountMode: "varies" })] }));
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: longKey, tagId: null });
    expect(res).toEqual({ success: true });
    expect(createdData().notes.length).toBeLessThanOrEqual(500);
    expect(createdData().notes).toContain(seriesMarker(longKey));
  });
});

describe("idempotency per series, even renamed", () => {
  it("asks for the series marker as well as the default name", async () => {
    await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null });
    const wheres = mockDb.recurringExpense.findFirst.mock.calls.map((c) => c[0].where);
    expect(wheres).toContainEqual({ entityId: ENTITY, name: "Netflix" });
    expect(wheres).toContainEqual({ entityId: ENTITY, notes: { contains: `[pattern:${KEY}]` } });
  });

  it("a row carrying the series marker blocks a second add, whatever its name is now", async () => {
    mockDb.recurringExpense.findFirst.mockImplementation(async (args: { where: { notes?: { contains: string } } }) =>
      args.where.notes?.contains === `[pattern:${KEY}]` ? { id: "renamed-row" } : null
    );
    const res = await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null, name: "Totally different" });
    expect(res).toEqual({ error: "Already recorded" });
    expect(mockDb.recurringExpense.create).not.toHaveBeenCalled();
  });

  it("the same series twice, the second under another name: one row", async () => {
    const stored: { name: string; notes: string }[] = [];
    mockDb.recurringExpense.create.mockImplementation(async (args: { data: { name: string; notes: string } }) => {
      stored.push({ name: args.data.name, notes: args.data.notes });
      return { id: "x" };
    });
    mockDb.recurringExpense.findFirst.mockImplementation(async (args: { where: { name?: string; notes?: { contains: string } } }) => {
      const hit = stored.find((r) => (args.where.name !== undefined && r.name === args.where.name) || (args.where.notes && r.notes.includes(args.where.notes.contains)));
      return hit ? { id: "x" } : null;
    });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null, name: "Streaming TV" })).toEqual({ success: true });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null, name: "Netflix again" })).toEqual({ error: "Already recorded" });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: KEY, tagId: null })).toEqual({ error: "Already recorded" });
    expect(stored).toHaveLength(1);
  });
});

describe("end to end with the real detector: renamed and tagged records", () => {
  const TODAY = new Date("2026-10-08T00:00:00Z");
  const rowsOf = (payee: string, day: number, amount: number, tag: string | null): TxRow[] =>
    [4, 5, 6, 7, 8, 9].map((m) => ({
      entityId: ENTITY,
      accountId: "acct-1",
      accountType: "checking",
      accountName: "Primary",
      payee,
      amount: new Decimal(-amount),
      postedAt: new Date(Date.UTC(2026, m - 1, day)),
      tagIds: tag ? [tag] : [],
    }));
  const history = [...rowsOf("netflix", 5, 15.49, TAG_STREAMING), ...rowsOf("hbo max", 12, 9.99, TAG_STREAMING)];
  const NETFLIX = `${ENTITY}|acct-1|out|netflix`;
  const HBO = `${ENTITY}|acct-1|out|hbo max`;

  const created: { name: string; notes: string; tagId: string | null; amountCents: number; frequency: string; dueDay: number | null; id: string }[] = [];

  function useRealDetector() {
    runMock.mockImplementation(() => {
      const input = {
        from: TODAY,
        days: 30,
        entityId: ENTITY,
        recurring: created.map((c) => ({
          id: c.id,
          entityId: ENTITY,
          name: c.name,
          amountCents: c.amountCents,
          frequency: c.frequency,
          dueDay: c.dueDay,
          nextDueDate: null,
          tagId: c.tagId,
          notes: c.notes,
        })),
      };
      const result = detectRecurring({ rows: history, modelled: collectModelledRefs(input), today: TODAY });
      return { result, bundle: applyDismissals(result, []) };
    });
  }

  beforeEach(() => {
    created.length = 0;
    mockDb.recurringExpense.create.mockImplementation(async (args: { data: { name: string; notes: string; tagId: string | null; amountCents: number; frequency: string; dueDay: number | null } }) => {
      created.push({ ...args.data, id: `rec-${created.length}` });
      return { id: "x" };
    });
    mockDb.recurringExpense.findFirst.mockImplementation(async (args: { where: { name?: string; notes?: { contains: string } } }) => {
      const hit = created.find((r) => (args.where.name !== undefined && r.name === args.where.name) || (args.where.notes && r.notes.includes(args.where.notes.contains)));
      return hit ? { id: hit.id } : null;
    });
    inputMock.mockResolvedValue({ input: { from: TODAY, days: 30, entityId: ENTITY } });
    fetchMock.mockResolvedValue({ rows: [], dismissed: [] });
    useRealDetector();
  });

  it("Netflix added under 'Streaming' with a new name: the HBO Max series is still offered and still addable under the same tag", async () => {
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: NETFLIX, tagId: TAG_STREAMING, name: "TV subscription A" })).toEqual({ success: true });
    // Same series again (the stored name no longer says Netflix): refused.
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: NETFLIX, tagId: TAG_STREAMING })).toEqual({ error: "Already recorded" });
    // HBO Max is a different series under the SAME tag: not hidden, can be added.
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: HBO, tagId: TAG_STREAMING, name: "TV subscription B" })).toEqual({ success: true });
    expect(await addSuggestedRecurringExpense({ entityId: ENTITY, seriesKey: HBO, tagId: TAG_STREAMING })).toEqual({ error: "Already recorded" });
    expect(created.map((c) => [c.name, c.tagId, c.amountCents])).toEqual([
      ["TV subscription A", TAG_STREAMING, 1549],
      ["TV subscription B", TAG_STREAMING, 999],
    ]);
  });
});
