// carry-forward-seasonal-energy, step 2 (owner information 2026-10-10): McCarthy rows the owner marks "not heating oil",
// and the "check these McCarthy charges" list. Tags on McCarthy rows are not reliable, so the model lists suspicious rows
// (a tag other than Oil, or an amount far from the typical payment), keeps counting them until the owner marks them, and
// leaves marked rows out of every figure. No transaction id or amount is hard-coded in the module under test.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  buildSiteEnergy,
  ENERGY_SITE_FACTS,
  oilEstimate,
  oilFacts,
  type EnergyEntityRef,
  type EnergyPayment,
  type RawEnergyTx,
  type SeasonalLineRef,
} from "@/lib/seasonal-energy";
import type { OilPriceEntry } from "@/lib/seasonal-energy-prices";

const NOW = new Date("2026-10-10T00:00:00Z");
const PERSONAL = ENERGY_SITE_FACTS["personal"]!;
const OIL_TAG = "Utilities / Oil";
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

function row(id: string, date: string, outflow: string, tagPaths: string[], over: Partial<EnergyPayment> = {}): EnergyPayment {
  return { id, date: D(date), amount: new Decimal(outflow).negated(), payee: "mccarthy heating oil", account: "Acct", fromOtherEntity: null, tagPaths, ...over };
}
const price = (id: string, effectiveOn: string, pricePerGal: string): OilPriceEntry => ({ id, effectiveOn, pricePerGal });
const entries = [price("a", "2025-11-01", "4.00"), price("b", "2026-06-01", "3.50")];

// The shape of the real history on 2026-10-10: a repair charge on a Personal card, the Oct 8 fill split over two rows
// with different tags, rows on the EK Consulting card, and the yearly service.
const history = () => [
  row("t-fill", "2026-10-08", "1529.50", [OIL_TAG]),
  row("t-fill-b", "2026-10-08", "180.80", ["Home & Property / Home Repair"]),
  row("t-repair", "2026-10-09", "1036.75", []),
  row("t-jan", "2026-01-26", "1225.25", [OIL_TAG], { fromOtherEntity: "Eric Kinniburgh Consulting, LLC" }),
  row("t-dec", "2025-12-02", "679.65", [OIL_TAG], { fromOtherEntity: "Eric Kinniburgh Consulting, LLC" }),
  row("t-apr", "2026-04-05", "804.60", [OIL_TAG]),
  row("t-svc", "2026-09-11", "292.46", ["Home & Property / Home Repair"]),
];

describe("check these McCarthy charges", () => {
  it("a row tagged anything but Oil is listed, yet stays counted until the owner marks it", () => {
    const f = oilFacts(history(), NOW, PERSONAL, { oilTagName: OIL_TAG });
    expect(f.check.map((p) => p.id).sort()).toEqual(["t-fill-b", "t-repair"]);
    expect(f.counted).toHaveLength(6);
    expect(f.check.find((p) => p.id === "t-repair")!.checkWhy.join(" ")).toMatch(/not tagged Utilities \/ Oil/);
    expect(f.check.find((p) => p.id === "t-fill-b")!.checkWhy.join(" ")).toMatch(/tagged Home & Property \/ Home Repair, not Utilities \/ Oil/);
    // the owner-confirmed service amount has its own treatment and is never in the check list
    expect(f.check.some((p) => p.id === "t-svc")).toBe(false);
    expect(f.service?.dates).toEqual(["2026-09-11"]);
  });

  it("an amount far from the typical payment is listed even when it carries the Oil tag", () => {
    const rows = [
      row("a", "2026-01-01", "800", [OIL_TAG]),
      row("b", "2026-02-01", "820", [OIL_TAG]),
      row("c", "2026-03-01", "790", [OIL_TAG]),
      row("tiny", "2026-04-01", "60", [OIL_TAG]),
      row("huge", "2026-05-01", "2500", [OIL_TAG]),
      row("ok", "2026-06-01", "1700", [OIL_TAG]),
    ];
    const f = oilFacts(rows, NOW, PERSONAL, { oilTagName: OIL_TAG });
    expect(f.check.map((p) => p.id).sort()).toEqual(["huge", "tiny"]);
    expect(f.check.find((p) => p.id === "tiny")!.checkWhy[0]).toMatch(/far below the typical payment \(median \$/);
    expect(f.check.find((p) => p.id === "huge")!.checkWhy[0]).toMatch(/far above/);
  });

  it("fewer than 3 payments: no amount rule, and without the Oil tag name no tag rule", () => {
    const two = oilFacts([row("a", "2026-01-01", "800", [OIL_TAG]), row("b", "2026-02-01", "20", [OIL_TAG])], NOW, PERSONAL, { oilTagName: OIL_TAG });
    expect(two.check).toEqual([]);
    const noTag = oilFacts(history(), NOW, PERSONAL, {});
    expect(noTag.check.every((p) => p.checkWhy.every((w) => !/tagged/.test(w)))).toBe(true);
  });
});

describe("marking a row 'not heating oil'", () => {
  it("removes it from every figure and lists it under the excluded rows", () => {
    const base = oilFacts(history(), NOW, PERSONAL, { oilTagName: OIL_TAG });
    const marked = oilFacts(history(), NOW, PERSONAL, { oilTagName: OIL_TAG, excludedIds: new Set(["t-repair"]) });
    expect(marked.excluded.map((p) => p.id)).toEqual(["t-repair"]);
    expect(marked.counted.some((p) => p.id === "t-repair")).toBe(false);
    expect(marked.check.some((p) => p.id === "t-repair")).toBe(false);
    expect(base.trailingAsPaid.minus(marked.trailingAsPaid).toFixed(2)).toBe("1036.75");
    expect(marked.trailingCount).toBe(base.trailingCount - 1);
    expect(marked.payments.find((p) => p.id === "t-repair")?.excluded).toBe(true); // still listed, so 'count it again' has a row
  });

  it("an id that matches no payment changes nothing", () => {
    const a = oilFacts(history(), NOW, PERSONAL, { oilTagName: OIL_TAG });
    const b = oilFacts(history(), NOW, PERSONAL, { oilTagName: OIL_TAG, excludedIds: new Set(["nope"]) });
    expect(b.trailingAsPaid.toFixed(2)).toBe(a.trailingAsPaid.toFixed(2));
    expect(b.excluded).toEqual([]);
  });

  it("the estimate leaves a marked row out of the annual figure, the implied gallons and the sensitivity", () => {
    const withAll = oilEstimate({ payments: history(), entries, now: NOW, site: PERSONAL, oilTagName: OIL_TAG });
    const marked = oilEstimate({ payments: history(), entries, now: NOW, site: PERSONAL, oilTagName: OIL_TAG, excludedIds: new Set(["t-repair"]) });
    const without = oilEstimate({ payments: history().filter((p) => p.id !== "t-repair"), entries, now: NOW, site: PERSONAL, oilTagName: OIL_TAG });
    if (withAll.status !== "estimate" || marked.status !== "estimate" || without.status !== "estimate") throw new Error("expected estimates");
    expect(marked.annual.toFixed(2)).toBe(without.annual.toFixed(2));
    expect(marked.sensitivity.toFixed(2)).toBe(without.sensitivity.toFixed(2));
    expect(marked.impliedGallons.toFixed(0)).toBe(without.impliedGallons.toFixed(0));
    // the repair is after the latest price entry, so restating it at today's price leaves its amount unchanged
    expect(withAll.annual.minus(marked.annual).toFixed(2)).toBe("1036.75");
  });

  it("the basis says how many rows are unconfirmed and how many were left out", () => {
    const e = oilEstimate({ payments: history(), entries, now: NOW, site: PERSONAL, oilTagName: OIL_TAG });
    if (e.status !== "estimate") throw new Error("expected an estimate");
    expect(e.basis).toMatch(/2 of the 6 payments counted are unconfirmed/);
    expect(e.basis).toMatch(/Check these McCarthy charges/);
    expect(e.basis).toMatch(/counted until you mark them "not heating oil"/);
    const m = oilEstimate({ payments: history(), entries, now: NOW, site: PERSONAL, oilTagName: OIL_TAG, excludedIds: new Set(["t-repair"]) });
    if (m.status !== "estimate") throw new Error("expected an estimate");
    expect(m.basis).toMatch(/1 of the 5 payments counted is unconfirmed/);
    expect(m.basis).toMatch(/1 McCarthy charge you marked "not heating oil" is left out/);
    const clean = oilEstimate({
      payments: [row("x", "2026-04-05", "800", [OIL_TAG]), row("y", "2026-01-05", "900", [OIL_TAG]), row("z", "2025-12-05", "850", [OIL_TAG])],
      entries,
      now: NOW,
      site: PERSONAL,
      oilTagName: OIL_TAG,
    });
    if (clean.status !== "estimate") throw new Error("expected an estimate");
    expect(clean.basis).not.toMatch(/unconfirmed/);
  });

  it("marking every row leaves nothing to estimate from: gated, a reason, no number", () => {
    const all = new Set(history().map((p) => p.id));
    const e = oilEstimate({ payments: history(), entries, now: NOW, site: PERSONAL, oilTagName: OIL_TAG, excludedIds: all });
    expect(e.status).toBe("gated");
    expect(Object.keys(e).sort()).toEqual(["kind", "reason", "status"]);
    expect((e as { reason: string }).reason).toMatch(/No heating-oil payments/);
  });

  it("a marked row is not price history either: it never reaches the price coverage gate", () => {
    // A very old marked row must not demand a price entry before its date.
    const rows = [row("old", "2025-10-15", "500", [OIL_TAG]), row("new", "2026-04-05", "800", [OIL_TAG])];
    const e = oilEstimate({ payments: rows, entries: [price("a", "2026-01-01", "4"), price("b", "2026-08-01", "3.5")], now: NOW, site: PERSONAL, oilTagName: OIL_TAG });
    expect(e.status).toBe("gated");
    const f = oilEstimate({ payments: rows, entries: [price("a", "2026-01-01", "4"), price("b", "2026-08-01", "3.5")], now: NOW, site: PERSONAL, oilTagName: OIL_TAG, excludedIds: new Set(["old"]) });
    expect(f.status).toBe("estimate");
  });
});

describe("buildSiteEnergy passes the marks and the Oil tag name through", () => {
  const E_PERSONAL: EnergyEntityRef = { id: "ent-p", name: "Personal", slug: "personal" };
  const L_OIL: SeasonalLineRef = { entityId: "ent-p", tagId: "t-op", tagName: OIL_TAG, kind: "oil" };
  const tx = (id: string, date: string, outflow: string, tagPaths: string[]): RawEnergyTx => ({
    id,
    date: D(date),
    amount: new Decimal(outflow).negated(),
    entityId: "ent-p",
    payee: "mccarthy heating oil",
    account: "Heating & Electric",
    tagPaths,
  });
  const txs = [tx("tx-fill", "2026-10-08", "1529.50", [OIL_TAG]), tx("tx-repair", "2026-10-09", "1036.75", [])];

  it("unmarked: the untagged row is in the check list; marked: it is excluded and the totals drop", () => {
    const open = buildSiteEnergy({ entity: E_PERSONAL, lines: [L_OIL], txs, entities: [E_PERSONAL], priceEntries: [], flatMonthly: {}, replaceDraws: false, now: NOW });
    expect(open.oil!.facts.check.map((p) => p.id)).toEqual(["tx-repair"]);
    const marked = buildSiteEnergy({ entity: E_PERSONAL, lines: [L_OIL], txs, entities: [E_PERSONAL], priceEntries: [], flatMonthly: {}, replaceDraws: false, excludedOilIds: new Set(["tx-repair"]), now: NOW });
    expect(marked.oil!.facts.excluded.map((p) => p.id)).toEqual(["tx-repair"]);
    expect(marked.oil!.facts.trailingAsPaid.toFixed(2)).toBe("1529.50");
  });
});
