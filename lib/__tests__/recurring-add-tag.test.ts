import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { detectRecurring, type DetectResult, type Series, type TxRow } from "@/lib/recurring-detect";
import {
  buildUpcomingLedger,
  collectModelledRefs,
  type ModelledRef,
  type UpcomingLedgerInput,
  type UpcomingRecurringRow,
} from "@/lib/upcoming-ledger";
import { seriesKeyFromNotes, seriesMarker, visibleNotes } from "@/lib/recurring-series-marker";
import { suggestedTagId, TAG_LINK_MIN_SHARE } from "@/lib/recurring-add-step";
import { toTagOptions, toUiDetection } from "@/lib/upcoming-ledger-view";
import { applyDismissals } from "@/lib/recurring-detect";

// Follow-up: tagging an added suggestion makes several RecurringExpenses share one tag. These tests pin that
// (2a) the ledger never merges records of the same kind that share a tag, (2b) a RecurringExpense that carries a tag
// suppresses a detected series only when its name / amount+day / own series match, and (2c) two series the owner tagged
// the same survive side by side.

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const TODAY = d("2026-10-08");
const E = "ent-1";
const ACCT = "acct-1";
const STREAMING = "tag-streaming";
const FEES = "tag-fees";

function months(day: number, n = 6, lastYm = "2026-09"): string[] {
  const [y, m] = lastYm.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1 - i, day)).toISOString().slice(0, 10));
  return out;
}

function rows(payee: string, dates: string[], amount: number, over: Partial<TxRow> = {}): TxRow[] {
  return dates.map((date) => ({
    entityId: E,
    accountId: ACCT,
    accountType: "checking",
    accountName: "Primary",
    payee,
    amount: new Decimal(-amount),
    postedAt: d(date),
    tagIds: [],
    ...over,
  }));
}

function ref(over: Partial<ModelledRef> & Pick<ModelledRef, "label">): ModelledRef {
  return {
    source: "recurring_expense",
    sourceId: "ref-1",
    entityId: E,
    accountId: null,
    direction: "outflow",
    tagKey: null,
    monthly: new Decimal(15),
    day: 5,
    cadence: "monthly",
    expectedAmount: new Decimal(15),
    ...over,
  };
}

const detect = (r: TxRow[], modelled: ModelledRef[] = [], today = TODAY): DetectResult => detectRecurring({ rows: r, modelled, today });
const payees = (s: Series[]) => s.map((x) => x.payee).sort();

// Netflix ($15.49 on the 5th) and HBO Max ($9.99 on the 12th), both tagged "Streaming" in the history.
const streamingHistory = [
  ...rows("netflix", months(5), 15.49, { tagIds: [STREAMING] }),
  ...rows("hbo max", months(12), 9.99, { tagIds: [STREAMING] }),
];
const NETFLIX = `${E}|${ACCT}|out|netflix`;
const HBO = `${E}|${ACCT}|out|hbo max`;

describe("(2b) a tagged RecurringExpense does not suppress by the tag alone", () => {
  it("baseline: both streaming series are offered", () => {
    expect(payees(detect(streamingHistory).suggestions)).toEqual(["Hbo Max", "Netflix"]);
  });

  it("Netflix recorded under 'Streaming' (tag + matching name): HBO Max is still offered", () => {
    const r = detect(streamingHistory, [
      ref({ label: "Netflix", tagKey: `${E}|${STREAMING}`, monthly: new Decimal("15.49"), day: 5, expectedAmount: new Decimal("15.49") }),
    ]);
    expect(payees(r.suggestions)).toEqual(["Hbo Max"]);
    expect(r.suppressed.map((s) => s.payee)).toEqual(["Netflix"]);
    expect(r.suppressed[0]?.suppressedBy?.kind).toBe("name");
  });

  it("a recurring expense whose tag matches but whose name, amount and day do not hides nothing", () => {
    const r = detect(streamingHistory, [
      ref({ label: "Cable box rental", tagKey: `${E}|${STREAMING}`, monthly: new Decimal("49.00"), day: 20, expectedAmount: new Decimal("49.00") }),
    ]);
    expect(payees(r.suggestions)).toEqual(["Hbo Max", "Netflix"]);
    expect(r.suppressedCount).toBe(0);
  });

  it("the same record as a scheduled bill or a budget line still suppresses by the tag (unchanged)", () => {
    for (const source of ["scheduled_bill", "budget_line"] as const) {
      const r = detect(streamingHistory, [
        ref({ source, label: "Cable box rental", tagKey: `${E}|${STREAMING}`, monthly: new Decimal("49.00"), day: 20, expectedAmount: new Decimal("49.00") }),
      ]);
      expect(r.suggestions).toHaveLength(0);
      expect(r.suppressed.map((s) => s.suppressedBy?.kind)).toEqual(["tag", "tag"]);
    }
  });

  it("a record added from a pattern and then renamed hides ITS series only (by the series key), not the same-tag sibling", () => {
    const r = detect(streamingHistory, [
      ref({ label: "Streaming TV", tagKey: `${E}|${STREAMING}`, seriesKey: NETFLIX, monthly: new Decimal("15.49"), day: 5, expectedAmount: new Decimal("15.49") }),
    ]);
    expect(payees(r.suggestions)).toEqual(["Hbo Max"]);
    expect(r.suppressed[0]?.payee).toBe("Netflix");
    expect(r.suppressed[0]?.suppressedBy).toMatchObject({ kind: "series", label: "Streaming TV", source: "recurring_expense" });
  });

  it("the renamed record hides its series even when the amount has since moved and the day differs", () => {
    const r = detect(streamingHistory, [
      ref({ label: "Streaming TV", seriesKey: NETFLIX, monthly: new Decimal("22.00"), day: 27, expectedAmount: new Decimal("22.00") }),
    ]);
    expect(r.suppressed.map((s) => s.payee)).toEqual(["Netflix"]);
  });

  it("both added (each renamed, same tag): both hidden, each by its own record", () => {
    const r = detect(streamingHistory, [
      ref({ sourceId: "a", label: "TV A", tagKey: `${E}|${STREAMING}`, seriesKey: NETFLIX, monthly: new Decimal("15.49"), day: 5 }),
      ref({ sourceId: "b", label: "TV B", tagKey: `${E}|${STREAMING}`, seriesKey: HBO, monthly: new Decimal("9.99"), day: 12, expectedAmount: new Decimal("9.99") }),
    ]);
    expect(r.suggestions).toHaveLength(0);
    const byPayee = Object.fromEntries(r.suppressed.map((s) => [s.payee, s.suppressedBy?.label]));
    expect(byPayee).toEqual({ Netflix: "TV A", "Hbo Max": "TV B" });
  });

  it("a record's series key never matches a series of another entity", () => {
    const r = detect(streamingHistory, [ref({ label: "Streaming TV", seriesKey: `other-entity|${ACCT}|out|netflix`, monthly: null, day: null, expectedAmount: null })]);
    expect(payees(r.suggestions)).toEqual(["Hbo Max", "Netflix"]);
  });
});

describe("(2b) history matching for the flags uses the record's own series", () => {
  it("HBO Max's record (sharing the tag with the busier Netflix) is judged on HBO Max's payments, not Netflix's", () => {
    // Netflix 8 rows around the 5th, HBO Max 4 rows around the 10th; both tagged Streaming (Netflix is 'dominant').
    const hist = [
      ...rows("netflix", months(5, 8), 15.49, { tagIds: [STREAMING] }),
      ...rows("hbo max", months(10, 4), 9.99, { tagIds: [STREAMING] }),
    ];
    const hbo = ref({
      sourceId: "hbo-rec",
      label: "HBO Max",
      tagKey: `${E}|${STREAMING}`,
      seriesKey: HBO,
      day: 10,
      monthly: new Decimal("9.99"),
      expectedAmount: new Decimal("9.99"),
    });
    // Oct 20: HBO Max has not posted on its ~10th (grace over); Netflix has not posted on its 5th either.
    const r = detect(hist, [hbo], d("2026-10-20"));
    const forHbo = r.flags.filter((f) => f.modelled?.sourceId === "hbo-rec");
    expect(forHbo.map((f) => f.type)).toEqual(["late"]);
    expect(forHbo[0]?.text).toContain("HBO Max");
    expect(forHbo[0]?.text).toContain("10th");
    expect(forHbo[0]?.text).not.toContain("5th");
  });
});

describe("(2c) two series the owner tagged the same", () => {
  const feeRows = (acct: string, name: string, day: number): TxRow[] =>
    rows("maintenance fee", months(day), 15, { accountId: acct, accountName: name, tagIds: [FEES] });
  const history = [...feeRows("acct-cc", "Credit Cards", 3), ...feeRows("acct-sf", "Slush Funds", 5)];
  const CC = `${E}|acct-cc|out|maintenance fee`;
  const SF = `${E}|acct-sf|out|maintenance fee`;

  it("baseline: both fees are offered under account-qualified names", () => {
    expect(payees(detect(history).suggestions)).toEqual(["Maintenance Fee (Credit Cards)", "Maintenance Fee (Slush Funds)"]);
  });

  it("adding one (tagged 'Bank Fees') never hides the other, with the suffixed name", () => {
    const r = detect(history, [ref({ label: "Maintenance Fee (Credit Cards)", tagKey: `${E}|${FEES}`, seriesKey: CC, day: 3 })]);
    expect(payees(r.suggestions)).toEqual(["Maintenance Fee (Slush Funds)"]);
  });

  it("adding one with the suffix REMOVED from the name still hides only its own account's series", () => {
    const r = detect(history, [ref({ label: "Bank fee", tagKey: `${E}|${FEES}`, seriesKey: CC, day: 3 })]);
    expect(r.suppressed.map((s) => s.payee)).toEqual(["Maintenance Fee (Credit Cards)"]);
    expect(payees(r.suggestions)).toEqual(["Maintenance Fee (Slush Funds)"]);
  });

  it("a plain 'Maintenance Fee' name (suffix dropped) made from one account does not hide the other account's series", () => {
    const r = detect(history, [ref({ label: "Maintenance Fee", tagKey: `${E}|${FEES}`, seriesKey: CC, day: 3 })]);
    expect(r.suppressed.map((s) => s.payee)).toEqual(["Maintenance Fee (Credit Cards)"]);
    expect(payees(r.suggestions)).toEqual(["Maintenance Fee (Slush Funds)"]);
  });

  it("adding both: both hidden, nothing offered", () => {
    const r = detect(history, [
      ref({ sourceId: "a", label: "Maintenance Fee (Credit Cards)", tagKey: `${E}|${FEES}`, seriesKey: CC, day: 3 }),
      ref({ sourceId: "b", label: "Maintenance Fee (Slush Funds)", tagKey: `${E}|${FEES}`, seriesKey: SF, day: 5 }),
    ]);
    expect(r.suggestions).toHaveLength(0);
    expect(r.suppressedCount).toBe(2);
  });
});

// ── The ledger (2a, 2c) ───────────────────────────────────────────────────────

function recurring(over: Partial<UpcomingRecurringRow> & Pick<UpcomingRecurringRow, "id" | "name" | "amountCents">): UpcomingRecurringRow {
  return { entityId: E, frequency: "monthly", dueDay: 5, nextDueDate: null, tagId: STREAMING, notes: null, ...over };
}

function ledgerOf(input: Partial<UpcomingLedgerInput>) {
  return buildUpcomingLedger({ from: d("2026-10-01"), days: 31, entityId: E, ...input });
}

describe("(2a) the ledger keeps every record of the same kind that shares a tag", () => {
  it("Netflix and HBO Max, both tagged 'Streaming': both appear with their own amounts and both are counted", () => {
    const ledger = ledgerOf({
      recurring: [
        recurring({ id: "netflix", name: "Netflix", amountCents: 1549, dueDay: 5 }),
        recurring({ id: "hbo", name: "HBO Max", amountCents: 999, dueDay: 12 }),
      ],
    });
    const shown = ledger.items.filter((i) => i.source === "recurring_expense");
    expect(shown.map((i) => [i.label, i.amount?.toFixed(2), i.date?.toISOString().slice(0, 10)])).toEqual([
      ["Netflix", "-15.49", "2026-10-05"],
      ["HBO Max", "-9.99", "2026-10-12"],
    ]);
    expect(ledger.totals.outflow.toFixed(2)).toBe("25.48");
    expect(ledger.heldBack).toHaveLength(0);
    for (const i of shown) {
      expect(i.alsoRecordedAs).toEqual([]);
      expect(i.discrepancies).toEqual([]);
    }
  });

  it("three records sharing a tag, mixed frequencies: each keeps its own cadence and amount", () => {
    const ledger = ledgerOf({
      recurring: [
        recurring({ id: "a", name: "Service A", amountCents: 1000, dueDay: 2 }),
        recurring({ id: "b", name: "Service B", amountCents: 2000, dueDay: 20 }),
        recurring({ id: "c", name: "Service C", amountCents: 500, frequency: "weekly", dueDay: null, nextDueDate: d("2026-10-01") }),
      ],
    });
    const byLabel = new Map<string, number>();
    for (const i of ledger.items) byLabel.set(i.label, (byLabel.get(i.label) ?? 0) + 1);
    expect(byLabel.get("Service A")).toBe(1);
    expect(byLabel.get("Service B")).toBe(1);
    expect(byLabel.get("Service C")).toBeGreaterThanOrEqual(4);
    expect(ledger.heldBack).toHaveLength(0);
  });

  it("two series tagged the same and named with their accounts both survive (2c)", () => {
    const ledger = ledgerOf({
      recurring: [
        recurring({ id: "cc", name: "Maintenance Fee (Credit Cards)", amountCents: 1500, dueDay: 3, tagId: FEES }),
        recurring({ id: "sf", name: "Maintenance Fee (Slush Funds)", amountCents: 1500, dueDay: 5, tagId: FEES }),
      ],
    });
    expect(ledger.items.map((i) => i.label)).toEqual(["Maintenance Fee (Credit Cards)", "Maintenance Fee (Slush Funds)"]);
    expect(ledger.totals.outflow.toFixed(2)).toBe("30.00");
    expect(ledger.heldBack).toHaveLength(0);
  });

  it("an untagged same-named manual record is still held back against a tagged one (different obligations are not created by tagging)", () => {
    const ledger = ledgerOf({
      recurring: [
        recurring({ id: "tagged", name: "Netflix", amountCents: 1549 }),
        recurring({ id: "manual", name: "Netflix", amountCents: 1549, tagId: null }),
      ],
    });
    expect(ledger.items.filter((i) => i.source === "recurring_expense")).toHaveLength(1);
    expect(ledger.heldBack).toHaveLength(1);
  });

  it("DIFFERENT kinds sharing a tag still merge by precedence: a scheduled Budget line absorbs the recurring expenses as alternates", () => {
    const ledger = ledgerOf({
      budgets: [
        {
          id: "bud",
          tagId: STREAMING,
          tagName: "Streaming",
          entityId: E,
          accountId: ACCT,
          period: "2026-10",
          budgeted: "30",
          payDay: 7,
          frequency: "monthly",
          payDayOfWeek: null,
          biweeklyAnchorDate: null,
          payMonth: null,
          annualAmountDue: null,
        },
      ],
      recurring: [
        recurring({ id: "netflix", name: "Netflix", amountCents: 1549 }),
        recurring({ id: "hbo", name: "HBO Max", amountCents: 999, dueDay: 12 }),
      ],
    });
    expect(ledger.items.map((i) => i.source)).toEqual(["budget_line"]);
    expect(ledger.items[0]?.alsoRecordedAs.map((a) => a.sourceId).sort()).toEqual(["hbo", "netflix"]);
  });
});

describe("recorded references for the detector", () => {
  it("two recurring expenses sharing a tag both become references, each with its own series key", () => {
    const refs = collectModelledRefs({
      from: d("2026-10-01"),
      days: 30,
      entityId: E,
      recurring: [
        recurring({ id: "netflix", name: "Streaming TV", amountCents: 1549, notes: `Added from a recurring pattern. ${seriesMarker(NETFLIX)}` }),
        recurring({ id: "hbo", name: "HBO Max", amountCents: 999, notes: null }),
      ],
    });
    expect(refs.map((r) => [r.sourceId, r.tagKey, r.seriesKey])).toEqual([
      ["netflix", `${E}|${STREAMING}`, NETFLIX],
      ["hbo", `${E}|${STREAMING}`, null],
    ]);
  });
});

// ── Marker + view helpers ─────────────────────────────────────────────────────

describe("series marker", () => {
  it("round-trips and is hidden from the displayed notes", () => {
    const notes = `Added from a recurring pattern in your transactions. The amount varies. ${seriesMarker(NETFLIX)}`;
    expect(seriesKeyFromNotes(notes)).toBe(NETFLIX);
    expect(visibleNotes(notes)).toBe("Added from a recurring pattern in your transactions. The amount varies.");
    expect(visibleNotes(seriesMarker(NETFLIX))).toBeNull();
    expect(visibleNotes("plain note")).toBe("plain note");
    expect(visibleNotes(null)).toBeNull();
    expect(seriesKeyFromNotes("no marker here")).toBeNull();
    expect(seriesKeyFromNotes(null)).toBeNull();
  });
  it("carries no account number: only ids and the lower-case payee", () => {
    expect(seriesMarker(NETFLIX)).toBe(`[pattern:${NETFLIX}]`);
    expect(seriesMarker(NETFLIX)).not.toMatch(/\d{5,}/);
  });
});

describe("tag suggestion and options", () => {
  const s = (over: Partial<Series>): Series =>
    ({
      key: NETFLIX, entityId: E, accountId: ACCT, kind: "outflow", payee: "Netflix", baseName: "Netflix", accountName: null, cadence: "monthly",
      typicalDay: 5, dayRule: "usually around the 5th", typicalAmount: new Decimal("15.49"), minAmount: new Decimal("15.49"), maxAmount: new Decimal("15.49"),
      amountMode: "fixed", occurrences: 6, firstSeen: d("2026-04-05"), lastSeen: d("2026-09-05"), nextExpected: d("2026-10-05"), confidence: "high",
      why: ["Seen 6 times"], dominantTagId: null, tagShare: 0, stale: false, suppressedBy: null, ...over,
    }) as Series;

  it("pre-selects only at >= 60%", () => {
    expect(TAG_LINK_MIN_SHARE).toBe(0.6);
    expect(suggestedTagId({ dominantTagId: STREAMING, tagShare: 0.6 })).toBe(STREAMING);
    expect(suggestedTagId({ dominantTagId: STREAMING, tagShare: 0.59 })).toBeNull();
    expect(suggestedTagId({ dominantTagId: null, tagShare: 0.9 })).toBeNull();
  });

  it("reaches the review list row", () => {
    const result: DetectResult = { suggestions: [s({ dominantTagId: STREAMING, tagShare: 0.8 })], suppressed: [], suppressedCount: 0, flags: [], staleCount: 0 };
    const ui = toUiDetection(applyDismissals(result, []), { [E]: "Personal" }, "2026-10-08");
    expect(ui.suggestions[0]?.suggestedTagId).toBe(STREAMING);
    const none: DetectResult = { ...result, suggestions: [s({ dominantTagId: STREAMING, tagShare: 0.4 })] };
    expect(toUiDetection(applyDismissals(none, []), { [E]: "Personal" }, "2026-10-08").suggestions[0]?.suggestedTagId).toBeNull();
  });

  it("options keep the order given and show the full hierarchy path", () => {
    expect(toTagOptions([{ id: "1", name: "Bills / Streaming" }, { id: "2", name: "Food & Drink / Groceries" }])).toEqual([
      { id: "1", label: "Bills / Streaming" },
      { id: "2", label: "Food & Drink / Groceries" },
    ]);
  });
});
