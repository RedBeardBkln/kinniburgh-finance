import { describe, it, expect } from "vitest";
import { buildCarryScreen } from "@/lib/tax-facts/carry-screen";
import { resolveCarryForward, type CarryRow } from "@/lib/tax-facts/carry-forward";

const T = new Date("2026-10-07T15:00:00Z");

function row(o: Partial<CarryRow> & { factKey: string }): CarryRow {
  return {
    version: 1,
    category: "household",
    label: o.factKey,
    taxYear: 2025,
    valueKind: "text",
    valueCents: null,
    valueText: "val",
    carryPolicy: "reconfirm",
    changeKind: "established",
    sourceKind: "owner_statement",
    confirmedAt: T,
    ...o,
  };
}

const FIXTURE: CarryRow[] = [
  row({ factKey: "a.stable", carryPolicy: "stable" }),
  row({ factKey: "b.reconfirm", carryPolicy: "reconfirm" }),
  row({ factKey: "c.derived", carryPolicy: "derived", valueKind: "money_cents", valueCents: 123456, valueText: null, sourceKind: "derived" }),
  row({ factKey: "d.year", carryPolicy: "year_specific", valueKind: "money_cents", valueCents: 5000, valueText: null }),
  row({ factKey: "e.open", category: "open_item", valueKind: "open_item", carryPolicy: "stable" }),
  row({ factKey: "f.retired", version: 1 }),
  row({ factKey: "f.retired", version: 2, taxYear: 2026, changeKind: "retired" }),
  row({ factKey: "g.resolved", category: "open_item", valueKind: "open_item", carryPolicy: "stable" }),
  row({ factKey: "g.resolved", category: "open_item", valueKind: "open_item", carryPolicy: "stable", version: 2, taxYear: 2026, changeKind: "resolved" }),
  row({ factKey: "h.future", taxYear: 2027 }),
  row({ factKey: "i.reconf2026", version: 1 }),
  row({ factKey: "i.reconf2026", version: 2, taxYear: 2026, changeKind: "reconfirmed" }),
  row({ factKey: "j.decision", category: "decision", valueKind: "choice", valueText: "simplified", sourceKind: "decision", carryPolicy: "reconfirm" }),
];

const keys = (xs: { factKey: string }[]) => xs.map((x) => x.factKey);

describe("buildCarryScreen", () => {
  const screen = buildCarryScreen(FIXTURE, 2026);
  const resolved = resolveCarryForward(FIXTURE, 2026);

  it("bucket membership equals resolveCarryForward exactly (nothing re-derived)", () => {
    expect(keys(screen.needsReconfirmation.items)).toEqual(keys(resolved.needsReconfirmation));
    expect(keys(screen.askFresh.items)).toEqual(keys(resolved.askFresh));
    expect(keys(screen.openItems.items)).toEqual(keys(resolved.openItems));
    expect(keys(screen.carried.items)).toEqual(keys(resolved.carried));
    expect(keys(screen.alreadyConfirmed.items)).toEqual(keys(resolved.alreadyConfirmedForYear));
    expect(keys(screen.needsReconfirmation.items)).toEqual(["b.reconfirm", "c.derived", "j.decision"]);
    expect(keys(screen.alreadyConfirmed.items)).toEqual(["i.reconf2026"]);
  });

  it("retired, resolved and future-only keys do not appear anywhere", () => {
    const all = [
      ...screen.needsReconfirmation.items,
      ...screen.askFresh.items,
      ...screen.openItems.items,
      ...screen.carried.items,
      ...screen.alreadyConfirmed.items,
    ].map((i) => i.factKey);
    for (const k of ["f.retired", "g.resolved", "h.future"]) expect(all).not.toContain(k);
  });

  it("every row says which year and version it came from", () => {
    for (const s of [screen.needsReconfirmation, screen.askFresh, screen.openItems, screen.carried, screen.alreadyConfirmed]) {
      for (const i of s.items) {
        expect(i.fromTaxYear).toBeGreaterThanOrEqual(2025);
        expect(i.fromVersion).toBeGreaterThanOrEqual(1);
        expect(i.carriedLabel).toContain(`TY${i.fromTaxYear}`);
        expect(i.provenanceLabel).toContain(`TY${i.fromTaxYear}`);
      }
    }
  });

  it("needs-confirmation rows offer still-true and changed; decision rows are flagged and are still one fact at a time", () => {
    for (const i of screen.needsReconfirmation.items) {
      expect(i.canStillTrue).toBe(true);
      expect(i.canChange).toBe(true);
      expect(i.canAnswer).toBe(false);
    }
    const d = screen.needsReconfirmation.items.find((i) => i.factKey === "j.decision");
    expect(d?.isDecision).toBe(true);
    expect(screen.needsReconfirmation.items.filter((i) => i.isDecision)).toHaveLength(1);
  });

  it("the derived row is labelled as an opening value", () => {
    const d = screen.needsReconfirmation.items.find((i) => i.factKey === "c.derived");
    expect(d?.carriedLabel).toContain("Opening value from the TY2025 closing figure");
  });

  it("an open item has no confirm or change action, only a link to resolve it", () => {
    const o = screen.openItems.items[0]!;
    expect(o.canStillTrue).toBe(false);
    expect(o.canChange).toBe(false);
    expect(o.canAnswer).toBe(false);
    expect(o.canSameAnswer).toBe(false);
    expect(o.resolveHref).toBe("/tax/facts");
  });

  it("ask-fresh rows are reference only: answer + same-answer, no still-true, nothing pre-carried", () => {
    const f = screen.askFresh.items[0]!;
    expect(f.referenceOnly).toBe(true);
    expect(f.canAnswer).toBe(true);
    expect(f.canSameAnswer).toBe(true);
    expect(f.canStillTrue).toBe(false);
    expect(f.carriedLabel).toContain("reference only");
    expect(f.carriedLabel).toContain("not carried");
  });

  it("carried (stable) and already-confirmed rows offer only 'It changed', never a confirmation", () => {
    for (const i of [...screen.carried.items, ...screen.alreadyConfirmed.items]) {
      expect(i.canChange).toBe(true);
      expect(i.canStillTrue).toBe(false);
      expect(i.canAnswer).toBe(false);
    }
  });

  it("counters", () => {
    expect(screen.needsConfirmationCount).toBe(3);
    expect(screen.askFreshCount).toBe(1);
    expect(screen.openItemCount).toBe(1);
    expect(screen.stillNeedYouCount).toBe(4);
    expect(screen.totalCount).toBe(3 + 1 + 1 + 1 + 1);
  });

  it("nothing is synthesised: a value is the stored one, an unanswered key is absent, no row gets a zero", () => {
    const byKey = new Map(FIXTURE.map((r) => [r.factKey, r]));
    for (const i of [...screen.needsReconfirmation.items, ...screen.askFresh.items, ...screen.carried.items]) {
      const src = byKey.get(i.factKey)!;
      expect(i.valueCents).toBe(src.valueCents);
      expect(i.valueText).toBe(src.valueText);
    }
    expect(buildCarryScreen([], 2026).totalCount).toBe(0);
    // a text fact never gains a cents value
    expect(screen.carried.items.every((i) => i.valueKind === "money_cents" || i.valueCents === null)).toBe(true);
  });

  it("is deterministic and does not mutate its input", () => {
    const copy = JSON.parse(JSON.stringify(FIXTURE)) as unknown[];
    const again = buildCarryScreen([...FIXTURE].reverse(), 2026);
    expect(keys(again.needsReconfirmation.items)).toEqual(keys(screen.needsReconfirmation.items));
    expect(JSON.parse(JSON.stringify(FIXTURE))).toEqual(copy);
  });

  it("a fact reconfirmed for 2026 leaves needs-confirmation for 2026 but is back in it for 2027", () => {
    const s27 = buildCarryScreen(FIXTURE, 2027);
    expect(keys(screen.needsReconfirmation.items)).not.toContain("i.reconf2026");
    expect(keys(s27.needsReconfirmation.items)).toContain("i.reconf2026");
  });

  it("a retired key that is re-established is back", () => {
    const rows = [
      ...FIXTURE,
      row({ factKey: "f.retired", version: 3, taxYear: 2026, changeKind: "established", carryPolicy: "stable" }),
    ];
    expect(keys(buildCarryScreen(rows, 2027).carried.items)).toContain("f.retired");
  });
});
