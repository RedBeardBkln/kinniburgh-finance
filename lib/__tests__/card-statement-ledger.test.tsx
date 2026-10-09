import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Decimal } from "@prisma/client/runtime/library";
import {
  buildUpcomingLedger,
  type UpcomingCardEstimateRow,
  type UpcomingCardRow,
  type UpcomingLedgerInput,
} from "@/lib/upcoming-ledger";
import { toUiLedger, type UiContext } from "@/lib/upcoming-ledger-view";
import { Disclosures } from "@/components/upcoming/upcoming-parts";
import { UpcomingAgenda } from "@/components/upcoming/upcoming-agenda";
import { detectRecurring } from "@/lib/recurring-detect";

(globalThis as unknown as { React: typeof React }).React = React;

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);
const FROM = d("2026-10-09");
const P = "ent-personal";
const EK = "ent-ekc";

const barclay = (over: Partial<UpcomingCardRow> = {}): UpcomingCardRow => ({
  id: "card-b",
  nickname: "Barclay",
  entityId: P,
  ccDueDate: d("2026-10-05"),
  ccStatementBalance: "623.19",
  ...over,
});

const est = (over: Partial<UpcomingCardEstimateRow> = {}): UpcomingCardEstimateRow => ({
  cardId: "card-b",
  entityId: P,
  nickname: "Barclay",
  dueDate: d("2026-11-05"),
  amount: new Decimal("2914.91"),
  confidence: "high",
  why: "estimated from this cycle's charges so far; the statement closes in about 2 days",
  kind: "cycle_to_date",
  ...over,
});

const build = (over: Partial<UpcomingLedgerInput> = {}) => buildUpcomingLedger({ from: FROM, days: 60, ...over });

const ctx = (over: Partial<UiContext> = {}): UiContext => ({
  days: 60,
  bucketSlug: "personal",
  isAggregate: false,
  entityNameById: { [P]: "Personal", [EK]: "EK Consulting" },
  entitySlugById: { [P]: "personal", [EK]: "ek-consulting" },
  accountNameById: {},
  includeTransfers: false,
  ...over,
});

describe("card statements in the ledger: paid-statement check", () => {
  it("with no check supplied the past-due row and its wording are exactly as before", () => {
    const l = build({ cards: [barclay()] });
    expect(l.pastDue).toHaveLength(1);
    expect(l.pastDue[0]!.notes).toEqual(["Past its due date; it may already be paid"]);
    expect(l.pastDue[0]!.paymentCheck).toBeUndefined();
    expect(l.paidCards).toEqual([]);
    // identical with the new optional inputs explicitly empty
    const explicit = build({ cards: [barclay({ paid: undefined })], cardEstimates: [] });
    expect(explicit.items).toEqual(l.items);
    expect(explicit.pastDue).toEqual(l.pastDue);
    expect(explicit.totals).toEqual(l.totals);
  });

  it("a statement found PAID leaves the past-due box and the totals and shows as a paid line", () => {
    const l = build({
      cards: [barclay({ paid: { date: d("2026-10-04"), amount: new Decimal("623.19"), via: "a payment received on the card" } })],
    });
    expect(l.pastDue).toEqual([]);
    expect(l.items).toEqual([]);
    expect(l.totals.outflow.toFixed(2)).toBe("0.00");
    expect(l.paidCards).toHaveLength(1);
    expect(l.paidCards[0]!.notes).toEqual(["Paid Oct 4 (a payment received on the card); not counted"]);
    expect(iso(l.paidCards[0]!.date)).toBe("2026-10-05");
  });

  it("an early-paid statement with a FUTURE due date is also removed from the items and totals", () => {
    const l = build({
      cards: [barclay({ ccDueDate: d("2026-10-20"), paid: { date: d("2026-10-08"), amount: new Decimal("623.19"), via: "a payment received on the card" } })],
    });
    expect(l.items).toEqual([]);
    expect(l.totals.outflow.toFixed(2)).toBe("0.00");
    expect(l.paidCards).toHaveLength(1);
  });

  it("when the check ran and found nothing, the row says no payment was found (never 'unpaid')", () => {
    const l = build({ cards: [barclay({ paid: null })] });
    expect(l.pastDue).toHaveLength(1);
    expect(l.pastDue[0]!.paymentCheck).toBe("none_found");
    expect(l.pastDue[0]!.notes[0]).toContain("no payment was found in your synced transactions");
    expect(l.pastDue[0]!.notes[0]).not.toMatch(/unpaid|accruing/i);
    expect(l.paidCards).toEqual([]);
  });

  it("an unpaid statement due in the window stays a scheduled counted item", () => {
    const l = build({ cards: [barclay({ ccDueDate: d("2026-10-12"), ccStatementBalance: "792.68", paid: null })] });
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ tier: "scheduled", kind: "card" });
    expect(l.totals.outflow.toFixed(2)).toBe("792.68");
    expect(l.totals.outflowEstimated.toFixed(2)).toBe("0.00");
  });
});

describe("card statements in the ledger: estimated next statements", () => {
  it("an estimate is a counted card item, tier estimated, with its basis", () => {
    const l = build({ cardEstimates: [est()] });
    expect(l.items).toHaveLength(1);
    const item = l.items[0]!;
    expect(item).toMatchObject({
      source: "card_statement",
      kind: "card",
      tier: "estimated",
      entityId: P,
      amountStatus: "known",
      label: "Barclay statement due",
    });
    expect(item.amount?.toFixed(2)).toBe("-2914.91");
    expect(item.sourceId).toBe("card-b:est:2026-11");
    expect(item.tierNote).toContain("estimated from this cycle's charges");
    expect(item.notes[0]).toBe("Estimate: the statement has not been issued yet");
    expect(item.notes.join(" ")).not.toMatch(/confidence/i); // the internal tier is never printed
    expect(iso(item.date)).toBe("2026-11-05");
  });

  it("estimates are counted in the totals and reported in outflowEstimated", () => {
    const l = build({
      cards: [barclay({ ccDueDate: d("2026-10-12"), ccStatementBalance: "792.68", paid: null })],
      cardEstimates: [est(), est({ dueDate: d("2026-12-05"), amount: new Decimal("700"), confidence: "low", kind: "typical_month", why: "typical month" })],
      days: 90,
    });
    expect(l.totals.outflow.toFixed(2)).toBe((792.68 + 2914.91 + 700).toFixed(2));
    expect(l.totals.outflowEstimated.toFixed(2)).toBe("3614.91");
    expect(l.biggest?.label).toBe("Barclay statement due");
  });

  it("an estimate outside the window, with no amount, or out of the entity scope is not placed", () => {
    expect(build({ days: 20, cardEstimates: [est()] }).items).toEqual([]); // Nov 5 is 27 days out
    expect(build({ cardEstimates: [est({ amount: new Decimal(0) })] }).items).toEqual([]);
    expect(build({ entityId: EK, cardEstimates: [est()] }).items).toEqual([]);
  });

  it("entity scoping: a Capital One (EK Consulting) estimate shows for EK Consulting and the aggregate only", () => {
    const cap = est({ cardId: "card-c", entityId: EK, nickname: "Capital One", dueDate: d("2026-11-12"), amount: new Decimal("72.56"), confidence: "medium" });
    expect(build({ entityId: EK, cardEstimates: [est(), cap] }).items.map((i) => i.label)).toEqual(["Capital One statement due"]);
    expect(build({ entityId: P, cardEstimates: [est(), cap] }).items.map((i) => i.label)).toEqual(["Barclay statement due"]);
    const all = build({ entityId: null, cardEstimates: [est(), cap] });
    expect(all.items).toHaveLength(2);
    expect(Object.keys(all.totalsByEntity).sort()).toEqual([EK, P]);
  });

  it("item ids stay unique, including an estimate next to the statement on file for the same card", () => {
    const l = build({
      days: 90,
      cards: [barclay({ ccDueDate: d("2026-10-12"), ccStatementBalance: "100", paid: null })],
      cardEstimates: [est(), est({ dueDate: d("2026-12-05"), kind: "typical_month" }), est({ dueDate: d("2026-12-05"), kind: "typical_month" })],
    });
    const ids = l.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it("estimates never reach the learned block or the learned total", () => {
    const l = build({ cardEstimates: [est()] });
    expect(l.learned).toEqual([]);
    expect(l.learnedTotals.count).toBe(0);
  });
});

describe("recurring detection does not offer the card payment itself (no double count)", () => {
  const rows = (payee: string, accountType = "checking") =>
    ["500", "800", "1200", "400", "900", "700", "623.19"].map((a, i) => ({
      entityId: P,
      accountId: "acct-cc",
      accountType,
      payee,
      amount: new Decimal(`-${a}`),
      postedAt: d(`2026-0${i + 3}-05`),
      tagIds: [] as string[],
    }));

  it.each(["barclays", "barclays bank delaware", "barclaycard us creditcard", "capital one crcardpmt", "capital one autopay pymt"])(
    "a monthly %s outflow is not suggested",
    (payee) => {
      const r = detectRecurring({ rows: rows(payee), modelled: [], today: d("2026-10-09") });
      expect(r.suggestions).toEqual([]);
    }
  );

  it("an ordinary monthly bill with similar amounts still IS suggested (the exclusion is not a blanket one)", () => {
    const r = detectRecurring({ rows: rows("acme water utility"), modelled: [], today: d("2026-10-09") });
    expect(r.suggestions.length).toBe(1);
  });
});

describe("card statement rendering", () => {
  const html = (input: Partial<UpcomingLedgerInput>, c: Partial<UiContext> = {}) => {
    const ui = toUiLedger(build(input), ctx(c));
    return {
      ui,
      disclosures: renderToStaticMarkup(<Disclosures ledger={ui} open />),
      agenda: renderToStaticMarkup(<UpcomingAgenda ledger={ui} bucketSlug="personal" horizon={60} showTransfers={false} />),
    };
  };

  it("without a check the original 'may already be paid' wording is kept verbatim", () => {
    const { disclosures, ui } = html({ cards: [barclay()] });
    expect(ui.pastDueChecked).toBe(false);
    expect(disclosures).toContain("Past due date, may already be paid (1)");
    expect(disclosures).toContain("The last statement on file is past its due date. It may already be paid; these are not in the totals.");
  });

  it("after a check that found nothing the box says 'no payment found yet'", () => {
    const { disclosures, ui } = html({ cards: [barclay({ paid: null })] });
    expect(ui.pastDueChecked).toBe(true);
    expect(disclosures).toContain("Past due date, no payment found yet (1)");
    expect(disclosures).not.toContain("may already be paid");
    expect(disclosures).toContain("A sync may be behind");
  });

  it("a paid statement is a muted 'already paid' line, not a past-due row", () => {
    const { disclosures } = html({
      cards: [barclay({ paid: { date: d("2026-10-04"), amount: new Decimal("623.19"), via: "a payment received on the card" } })],
    });
    expect(disclosures).toContain("Card statements already paid (1)");
    expect(disclosures).toContain("Paid Oct 4");
    expect(disclosures).not.toContain("Past due date");
  });

  it("an estimated statement carries the estimate badge and its basis in the agenda", () => {
    const { agenda } = html({ cardEstimates: [est()] });
    expect(agenda).toContain("Barclay statement due");
    expect(agenda).toContain("estimate");
    expect(agenda).toContain("estimated from this cycle&#x27;s charges so far");
  });
});
