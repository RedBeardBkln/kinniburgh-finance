import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { applyDismissals, detectRecurring, type DetectResult, type DetectionBundle, type Series, type TxRow } from "@/lib/recurring-detect";
import { buildUpcomingLedger, qualifiersDiffer, stripTrailingQualifier, trailingQualifier, type LearnedSeriesRow, type ModelledRef } from "@/lib/upcoming-ledger";
import { collapseLearned, toUiDetection, toUiLedger, type UiContext } from "@/lib/upcoming-ledger-view";

// Follow-ups to the recurring-detection task: (1) one row per learned series, (2) the same payee on two accounts,
// (3) past-due "expected, not posted yet" wording. Fixtures mirror what was read live (Maintenance Fee, $15, on the
// Credit Cards account around the 3rd and on the Slush Funds account around the 4th-5th); nicknames only, no numbers.

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const TODAY = d("2026-10-08");
const E1 = "ent-1";
const E2 = "ent-2";
const CARD = "acct-card";
const SLUSH = "acct-slush";

function months(day: number, n: number, lastYm = "2026-09"): string[] {
  const [y, m] = lastYm.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1 - i, day)).toISOString().slice(0, 10));
  return out;
}

function rows(
  dates: string[],
  amount: number,
  over: Partial<TxRow> & { payee?: string } = {}
): TxRow[] {
  return dates.map((date) => ({
    entityId: E1,
    accountId: CARD,
    accountType: "checking",
    accountName: "Credit Cards",
    payee: "maintenance fee",
    amount: new Decimal(-amount),
    postedAt: d(date),
    tagIds: [],
    ...over,
  }));
}

/** The live case: the same $15 fee on two accounts of one entity. */
function feeOnTwoAccounts(extra: { cardTags?: string[]; slushTags?: string[] } = {}): TxRow[] {
  return [
    ...rows(months(3, 6), 15, { accountId: CARD, accountName: "Credit Cards", tagIds: extra.cardTags ?? [] }),
    ...rows(months(5, 6), 15, { accountId: SLUSH, accountName: "Slush Funds", tagIds: extra.slushTags ?? [] }),
  ];
}

function ref(over: Partial<ModelledRef> & Pick<ModelledRef, "label">): ModelledRef {
  return {
    source: "recurring_expense",
    sourceId: "ref-1",
    entityId: E1,
    accountId: null, // RecurringExpense has no accountId
    direction: "outflow",
    tagKey: null,
    monthly: new Decimal(15),
    day: 3,
    cadence: "monthly",
    expectedAmount: new Decimal(15),
    ...over,
  };
}

const detect = (r: TxRow[], modelled: ModelledRef[] = [], today = TODAY): DetectResult => detectRecurring({ rows: r, modelled, today });
const names = (r: DetectResult) => r.suggestions.map((s) => s.payee).sort();

describe("trailing qualifier helpers", () => {
  it("reads and strips a trailing parenthesis, ignores a middle one", () => {
    expect(trailingQualifier("Maintenance Fee (Credit Cards)")).toBe("credit cards");
    expect(stripTrailingQualifier("Maintenance Fee (Credit Cards)")).toBe("Maintenance Fee");
    expect(trailingQualifier("Fee (A) extra")).toBeNull();
    expect(trailingQualifier("Plain Fee")).toBeNull();
    expect(trailingQualifier("Fee ()")).toBeNull();
  });
  it("two names differ only when both carry a different qualifier", () => {
    expect(qualifiersDiffer("Fee (Credit Cards)", "Fee (Slush Funds)")).toBe(true);
    expect(qualifiersDiffer("Fee (Credit Cards)", "Fee (credit  cards)")).toBe(false);
    expect(qualifiersDiffer("Fee (Credit Cards)", "Fee")).toBe(false);
  });
});

describe("same payee on two accounts: display names", () => {
  it("each series is named after its account, the key stays account-specific and no number appears", () => {
    const r = detect(feeOnTwoAccounts());
    expect(names(r)).toEqual(["Maintenance Fee (Credit Cards)", "Maintenance Fee (Slush Funds)"]);
    const [a, b] = r.suggestions as [Series, Series];
    expect(a.baseName).toBe("Maintenance Fee");
    expect(b.baseName).toBe("Maintenance Fee");
    expect(a.key).not.toBe(b.key);
    expect(a.key).toContain(CARD + "|") ;
    expect(new Set(r.suggestions.map((s) => s.accountName))).toEqual(new Set(["Credit Cards", "Slush Funds"]));
    for (const s of r.suggestions) expect(s.payee).not.toMatch(/\d{4,}/);
  });

  it("no suffix when only one series has that payee", () => {
    const r = detect(rows(months(3, 6), 15));
    expect(names(r)).toEqual(["Maintenance Fee"]);
    expect((r.suggestions[0] as Series).baseName).toBe("Maintenance Fee");
  });

  it("no suffix when the same payee is in two different entities (a name only has to be unique per entity)", () => {
    const r = detect([
      ...rows(months(3, 6), 15, { entityId: E1, accountId: CARD, accountName: "Credit Cards" }),
      ...rows(months(5, 6), 15, { entityId: E2, accountId: SLUSH, accountName: "Slush Funds" }),
    ]);
    expect(names(r)).toEqual(["Maintenance Fee", "Maintenance Fee"]);
  });

  it("no suffix when different payees sit on different accounts, or when the nickname is unknown", () => {
    const r1 = detect([
      ...rows(months(3, 6), 15, { accountId: CARD, accountName: "Credit Cards" }),
      ...rows(months(5, 6), 15, { accountId: SLUSH, accountName: "Slush Funds", payee: "account service charge" }),
    ]);
    expect(names(r1)).toEqual(["Account Service Charge", "Maintenance Fee"]);
    const r2 = detect(feeOnTwoAccounts().map((t) => ({ ...t, accountName: undefined })));
    expect(names(r2)).toEqual(["Maintenance Fee", "Maintenance Fee"]);
  });

  it("a stale second series does not force a suffix on the live one", () => {
    const r = detect([
      ...rows(months(3, 6), 15, { accountId: CARD, accountName: "Credit Cards" }),
      ...rows(months(5, 6, "2026-03"), 15, { accountId: SLUSH, accountName: "Slush Funds" }),
    ]);
    expect(names(r)).toEqual(["Maintenance Fee"]);
  });
});

describe("same payee on two accounts: each is suppressed only after its own add", () => {
  it("neither recorded: both are offered", () => {
    const r = detect(feeOnTwoAccounts(), []);
    expect(r.suggestions).toHaveLength(2);
    expect(r.suppressedCount).toBe(0);
  });

  it("recording the Credit Cards one hides only that one (by name)", () => {
    const r = detect(feeOnTwoAccounts(), [ref({ label: "Maintenance Fee (Credit Cards)" })]);
    expect(names(r)).toEqual(["Maintenance Fee (Slush Funds)"]);
    expect(r.suppressed.map((s) => s.payee)).toEqual(["Maintenance Fee (Credit Cards)"]);
    expect(r.suppressed[0]?.suppressedBy?.kind).toBe("name");
  });

  it("recording the Slush Funds one hides only that one", () => {
    const r = detect(feeOnTwoAccounts(), [ref({ label: "Maintenance Fee (Slush Funds)", day: 5 })]);
    expect(names(r)).toEqual(["Maintenance Fee (Credit Cards)"]);
    expect(r.suppressed.map((s) => s.payee)).toEqual(["Maintenance Fee (Slush Funds)"]);
  });

  it("recording both hides both", () => {
    const r = detect(feeOnTwoAccounts(), [
      ref({ label: "Maintenance Fee (Credit Cards)", sourceId: "r1" }),
      ref({ label: "Maintenance Fee (Slush Funds)", sourceId: "r2", day: 5 }),
    ]);
    expect(r.suggestions).toHaveLength(0);
    expect(r.suppressedCount).toBe(2);
  });

  it("a shared budget category does not let one add hide the other (tag rule is account-aware)", () => {
    const tag = `${E1}|tag-fees`;
    // A scheduled bill keeps the tag rule (a recurring expense no longer suppresses by tag alone: see
    // recurring-add-tag.test.ts); the account qualifier must still keep it from hiding the other account's series.
    const r = detect(feeOnTwoAccounts({ cardTags: ["tag-fees"], slushTags: ["tag-fees"] }), [
      ref({ label: "Maintenance Fee (Credit Cards)", tagKey: tag, source: "scheduled_bill" }),
    ]);
    expect(names(r)).toEqual(["Maintenance Fee (Slush Funds)"]);
    expect(r.suppressed[0]?.suppressedBy?.kind).toBe("tag");
  });

  it("the amount-and-day rule respects the account too", () => {
    // 'Bank Charge' shares no word with the series, so only $15 on about the same day could match it.
    const r = detect(feeOnTwoAccounts(), [ref({ label: "Bank Charge (Credit Cards)", day: 4, monthly: new Decimal(15) })]);
    expect(r.suppressed.map((s) => s.payee)).toEqual(["Maintenance Fee (Credit Cards)"]);
    expect(names(r)).toEqual(["Maintenance Fee (Slush Funds)"]);
  });

  it("an older record without a suffix still hides both (nothing says which account it was for)", () => {
    const r = detect(feeOnTwoAccounts(), [ref({ label: "Maintenance Fee" })]);
    expect(r.suggestions).toHaveLength(0);
  });

  it("a record qualified by something that is not an account nickname keeps the old behaviour", () => {
    const r = detect(rows(months(3, 6), 15, { payee: "amica home" }), [
      ref({ label: "Amica - Home insurance (Arbor Retreat)", source: "scheduled_bill", monthly: new Decimal(167.9), day: 3 }),
    ]);
    expect(r.suggestions).toHaveLength(0);
    expect(r.suppressed[0]?.suppressedBy?.kind).toBe("name");
  });

  it("a late flag for the Credit Cards record only looks at that account's rows", () => {
    // Slush Funds posted on Oct 5; Credit Cards did not post on Oct 3. Today Oct 20.
    const hist = [
      ...rows(months(3, 6), 15, { accountId: CARD, accountName: "Credit Cards" }),
      ...rows([...months(5, 6), "2026-10-05"], 15, { accountId: SLUSH, accountName: "Slush Funds" }),
    ];
    const r = detect(hist, [ref({ label: "Maintenance Fee (Credit Cards)" })], d("2026-10-20"));
    const late = r.flags.filter((f) => f.type === "late");
    expect(late).toHaveLength(1);
    expect(late[0]?.text).toContain("Maintenance Fee (Credit Cards)");
    expect(late[0]?.text).toContain("3rd");
  });
});

describe("ledger: two same-named records with different qualifiers are not duplicates", () => {
  it("both recurring expenses are counted, even when the first one is linked to a budget category", () => {
    const l = buildUpcomingLedger({
      from: TODAY,
      days: 30,
      recurring: [
        { id: "r1", entityId: E1, name: "Maintenance Fee (Credit Cards)", amountCents: 1500, frequency: "monthly", dueDay: 10, tagId: "tag-fees", nextDueDate: null },
        { id: "r2", entityId: E1, name: "Maintenance Fee (Slush Funds)", amountCents: 1500, frequency: "monthly", dueDay: 12, tagId: null, nextDueDate: null },
      ],
    });
    expect(l.items.map((i) => i.label).sort()).toEqual(["Maintenance Fee (Credit Cards)", "Maintenance Fee (Slush Funds)"]);
    expect(l.heldBack).toHaveLength(0);
    expect(l.totals.outflow.toFixed(2)).toBe("30.00");
  });
});

// ── (1) One row per learned series ───────────────────────────────────────────

const ctx = (over: Partial<UiContext> = {}): UiContext => ({
  days: 90,
  bucketSlug: "personal",
  isAggregate: false,
  entityNameById: { [E1]: "Personal", [E2]: "Sudden Valley" },
  entitySlugById: { [E1]: "personal", [E2]: "sudden-valley" },
  accountNameById: {},
  includeTransfers: false,
  ...over,
});

function learnedRow(over: Partial<LearnedSeriesRow>): LearnedSeriesRow {
  return {
    key: `${E1}|a|out|ring`,
    entityId: E1,
    accountId: null,
    payee: "Ring",
    kind: "outflow",
    cadence: "monthly",
    amount: 21.26,
    minAmount: 21.26,
    maxAmount: 21.26,
    amountMode: "fixed",
    confidence: "high",
    why: "Seen 6 times.",
    dates: [d("2026-11-06"), d("2026-12-06"), d("2027-01-06")], // the third is outside a 90-day window
    ...over,
  };
}

const ledgerFor = (learned: LearnedSeriesRow[], days = 90) => buildUpcomingLedger({ from: TODAY, days, learned });

describe("collapseLearned: one row per series", () => {
  it("a 90-day monthly series is ONE row with its next date, amount and cadence phrase", () => {
    const l = ledgerFor([learnedRow({})]);
    expect(l.learned).toHaveLength(2); // one dated item per occurrence: the builder's data is unchanged
    const c = collapseLearned(l.learned, ctx());
    expect(c.learnedSeries).toHaveLength(1);
    const row = c.learnedSeries[0];
    expect(row?.phrase).toBe("monthly, ~$21.26, next Nov 6");
    expect(row?.nextDateIso).toBe("2026-11-06");
    expect(row?.datesInWindow).toBe(2);
    expect(row?.amount).toBe("21.26");
    expect(c.learnedMonthly).toBe("21.26");
  });

  it("weekly and quarterly series use their monthly equivalent once, not one amount per date", () => {
    const l = ledgerFor([
      learnedRow({ key: "w", payee: "Weekly Co", cadence: "weekly", amount: 31, minAmount: 31, maxAmount: 31, dates: [d("2026-10-12"), d("2026-10-19"), d("2026-10-26"), d("2026-11-02")] }),
      learnedRow({ key: "q", payee: "Quarterly Co", cadence: "quarterly", amount: 90, minAmount: 90, maxAmount: 90, dates: [d("2026-11-20")] }),
    ]);
    const c = collapseLearned(l.learned, ctx());
    expect(c.learnedSeries.map((r) => r.phrase)).toEqual(["weekly, ~$31.00, next Oct 12", "quarterly, ~$90.00, next Nov 20"]);
    // 31 * 52 / 12 = 134.33 ; 90 / 3 = 30.00
    expect(c.learnedSeries.map((r) => r.monthly)).toEqual(["134.33", "30.00"]);
    expect(c.learnedMonthly).toBe("164.33");
    // The old item-level figure counted every date (4 x 31 + 90 = 214.00): it is still there, but it is not the block's figure.
    expect(l.learnedTotals.outflow.toFixed(2)).toBe("214.00");
  });

  it("the count, rows and figure agree and the block stays outside every total", () => {
    const l = ledgerFor([learnedRow({}), learnedRow({ key: "b", payee: "Beta", dates: [d("2026-10-20")] })]);
    const ui = toUiLedger(l, ctx());
    expect(ui.learnedSeries).toHaveLength(2);
    expect(ui.learned).toHaveLength(3);
    expect(ui.totals.outflow).toBe("0.00");
    expect(ui.items).toHaveLength(0);
    expect(ui.learnedMonthly).toBe("42.52");
  });

  it("rows follow the first date; a varies series keeps its per-series note but not the generic one", () => {
    const l = ledgerFor([
      learnedRow({ key: "late", payee: "Later", dates: [d("2026-12-01")] }),
      learnedRow({ key: "early", payee: "Earlier", amountMode: "varies", minAmount: 60, maxAmount: 90, amount: 75, dates: [d("2026-10-10")] }),
    ]);
    const c = collapseLearned(l.learned, ctx());
    expect(c.learnedSeries.map((r) => r.label)).toEqual(["Earlier", "Later"]);
    expect(c.learnedSeries[0]?.notes).toEqual(["Amount varies, about $60.00 to $90.00"]);
  });

  it("all-entities view: per-entity series counts, each row keeps its own entity", () => {
    const l = ledgerFor([
      learnedRow({ key: "p1", payee: "P One", dates: [d("2026-10-10")] }),
      learnedRow({ key: "p2", payee: "P Two", dates: [d("2026-10-11")] }),
      learnedRow({ key: "s1", payee: "S One", entityId: E2, dates: [d("2026-10-12")] }),
    ]);
    const c = collapseLearned(l.learned, ctx({ isAggregate: true }));
    expect(c.learnedEntityCounts).toEqual([
      { entityName: "Personal", count: 2 },
      { entityName: "Sudden Valley", count: 1 },
    ]);
    expect(c.learnedSeries.find((r) => r.label === "S One")?.entityName).toBe("Sudden Valley");
    expect(c.learnedSeries.find((r) => r.label === "S One")?.href).toContain("sudden-valley");
  });

  it("an empty ledger collapses to nothing", () => {
    const c = collapseLearned([], ctx());
    expect(c).toEqual({ learnedSeries: [], learnedMonthly: "0.00", learnedEntityCounts: [] });
  });
});

// ── (3) Past-due expected wording ────────────────────────────────────────────

function bundleOf(r: DetectResult): DetectionBundle {
  return applyDismissals(r, []);
}

describe("past-due expected wording", () => {
  // Six fixed monthly payments on the 6th, the last one Sep 6: next expected Oct 6 (high confidence, so the late
  // rule applies after 5 days of grace).
  const hist = rows(months(6, 6), 28.7, { payee: "streaming plus", accountName: "Primary" });
  const bundleAt = (today: string) => bundleOf(detect(hist, [], d(today)));
  const labelAt = (today: string) => toUiDetection(bundleAt(today), { [E1]: "Personal" }, today).suggestions[0]?.nextLabel;

  it("a future date keeps 'Next expected around'", () => {
    expect(labelAt("2026-10-02")).toBe("Next expected around Oct 6");
  });

  it("today is not 'before today': still 'Next expected'", () => {
    expect(labelAt("2026-10-06")).toBe("Next expected around Oct 6");
  });

  it("past the date, inside the grace window and not flagged: observational 'not posted yet'", () => {
    expect(bundleAt("2026-10-09").flags.filter((f) => f.type === "late")).toHaveLength(0);
    expect(labelAt("2026-10-09")).toBe("Expected around Oct 6, not posted yet");
    expect(labelAt("2026-10-07")).toBe("Expected around Oct 6, not posted yet");
  });

  it("once the existing late rule flags it, the existing label stays", () => {
    const b = bundleAt("2026-10-12");
    expect(b.flags.filter((f) => f.type === "late")).toHaveLength(1);
    expect(toUiDetection(b, { [E1]: "Personal" }, "2026-10-12").suggestions[0]?.nextLabel).toBe("Next expected around Oct 6");
  });

  it("without a 'today' every date reads 'Next expected' (callers that do not pass one are unchanged)", () => {
    expect(toUiDetection(bundleAt("2026-10-09"), { [E1]: "Personal" }).suggestions[0]?.nextLabel).toBe("Next expected around Oct 6");
  });

  it("a weak or yearly pattern still has no date at all", () => {
    const low = detect(rows(months(6, 3), 28.7, { payee: "tiny plan" }), [], d("2026-10-09"));
    expect(low.suggestions[0]?.confidence).toBe("low");
    expect(toUiDetection(bundleOf(low), { [E1]: "Personal" }, "2026-10-09").suggestions[0]?.nextLabel).toBeNull();
  });

  it("the wording is observational: no advice, no certainty", () => {
    const text = labelAt("2026-10-09") ?? "";
    expect(text).not.toMatch(/\b(late|overdue|missed|should|must|will)\b/i);
  });
});
