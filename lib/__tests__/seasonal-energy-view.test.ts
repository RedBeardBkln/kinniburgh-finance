// carry-forward-seasonal-energy, step 2: the presentation shaping and the server-rendered card for /forecast
// (lib/seasonal-energy-view.ts, components/forecast/seasonal-card.tsx). A gated line carries no number of its own.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { Decimal } from "@prisma/client/runtime/library";

// The client leaves use the router and server actions; the card is rendered statically here.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/actions/seasonal-settings", () => ({ addOilPrice: vi.fn(), removeOilPrice: vi.fn(), setMcCarthyNotOil: vi.fn() }));

import { buildSiteEnergy, type EnergyEntityRef, type RawEnergyTx, type SeasonalLineRef } from "@/lib/seasonal-energy";
import { CHECK_TITLE, EXCLUDED_TITLE, fullDate, periodsFrom, toUiSite } from "@/lib/seasonal-energy-view";
import { SeasonalCard } from "@/components/forecast/seasonal-card";
import type { OilPriceEntry } from "@/lib/seasonal-energy-prices";

(globalThis as unknown as { React: typeof React }).React = React;

const NOW = new Date("2026-10-10T12:00:00Z");
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const P: EnergyEntityRef = { id: "ent-p", name: "Personal", slug: "personal" };
const SVE: EnergyEntityRef = { id: "ent-sv", name: "Sudden Valley Property Management, LLC", slug: "sudden-valley" };
const EKC: EnergyEntityRef = { id: "ent-ekc", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting" };
const L = (entityId: string, tagId: string, tagName: string, kind: SeasonalLineRef["kind"]): SeasonalLineRef => ({ entityId, tagId, tagName, kind });
const tx = (id: string, entityId: string, date: string, outflow: string, payee: string, tags: string[] = [], account = "Acct"): RawEnergyTx => ({
  id,
  date: D(date),
  amount: new Decimal(outflow).negated(),
  entityId,
  payee,
  account,
  tagPaths: tags,
});
const ELECTRIC = [["2025-11-19", "235.66"], ["2025-12-18", "445.42"], ["2026-01-20", "665.09"], ["2026-02-18", "583.22"], ["2026-04-13", "63.60"], ["2026-05-05", "161.51"], ["2026-08-06", "41.49"], ["2026-09-03", "247.89"]];
const electricTxs = () => ELECTRIC.map(([d, a], i) => tx(`e${i}`, "ent-p", d!, a!, "eversource", ["Utilities / Electric (Eversource)"]));

const personalSite = (over: { prices?: OilPriceEntry[]; excluded?: string[]; flat?: boolean } = {}) =>
  buildSiteEnergy({
    entity: P,
    lines: [L("ent-p", "t-ep", "Utilities / Electric (Eversource)", "electric"), L("ent-p", "t-op", "Utilities / Oil", "oil"), L("ent-p", "t-wp", "Utilities / Firewood", "firewood")],
    txs: [
      ...electricTxs(),
      tx("k1", "ent-ekc", "2025-12-02", "679.65", "mccarthy heating oil serv 860 4432839 ct", ["Utilities / Oil"], "Capital One"),
      tx("svc1", "ent-ekc", "2025-10-31", "292.46", "mccarthy heating oil serv860 4432839ct", [], "Capital One"),
      tx("svc2", "ent-p", "2026-09-11", "292.46", "mccarthy heating oil ser", ["Home & Property / Home Repair"], "Heating & Electric"),
      tx("o1", "ent-p", "2026-10-08", "1529.50", "mccarthy heating oil", ["Utilities / Oil"], "Heating & Electric"),
      tx("o2", "ent-p", "2026-10-09", "1036.75", "mccarthy heating oil", [], "Barclay"),
      tx("w1", "ent-p", "2026-01-08", "315", "check 227", ["Utilities / Firewood"], "Primary Checking"),
    ],
    entities: [P, SVE, EKC],
    priceEntries: over.prices ?? [],
    flatMonthly: over.flat === false ? {} : { electric: new Decimal("172"), oil: new Decimal("308"), firewood: new Decimal("80") },
    replaceDraws: false,
    draws: {
      oil: [{ date: "2026-12-16", amount: new Decimal("2000") }, { date: "2027-03-25", amount: new Decimal("2000") }],
      firewood: [{ date: "2026-12-14", amount: new Decimal("315") }],
    },
    excludedOilIds: new Set(over.excluded ?? []),
    now: NOW,
  });

describe("helpers", () => {
  it("periodsFrom starts at the current month and rolls the year", () => {
    expect(periodsFrom(NOW, 4)).toEqual(["2026-10", "2026-11", "2026-12", "2027-01"]);
    expect(periodsFrom(NOW, 12)[11]).toBe("2027-09");
  });
  it("fullDate formats a calendar date in UTC with the year (never shifted by New York time)", () => {
    expect(fullDate("2026-10-01")).toBe("Oct 1, 2026");
    expect(fullDate("2025-12-31")).toBe("Dec 31, 2025");
  });
});

describe("toUiSite: Personal today", () => {
  const ui = () => toUiSite(personalSite(), NOW, { pricesCorrupt: false });

  it("Electric is a low-confidence ESTIMATE with a 12-month table starting this month, the budget figure beside it and a basis", () => {
    const el = ui().lines.find((l) => l.kind === "electric")!;
    expect(el.status).toBe("estimate");
    expect(el.badge).toBe("Estimate (low confidence)");
    expect(el.reason).toBeNull();
    expect(el.table).toHaveLength(12);
    expect(el.table[0]).toMatchObject({ period: "2026-10", label: "Oct 2026", amount: "$128.62", budget: "$172.00", source: "season average (no payment seen that month)" });
    expect(el.table[3]).toMatchObject({ label: "Jan 2027", amount: "$573.72", range: "$235.66 to $665.09", source: "your payment that month plus the season average" });
    expect(el.headline).toMatch(/About \$[\d,]+\.\d\d over the next 12 months, in net dollars paid \(net of solar\)\./);
    expect(el.basis).toMatch(/solar/);
    expect(el.budgetNote).toBe("$172.00 a month");
    expect(el.payments).toHaveLength(8);
    expect(el.payments[0]).toMatchObject({ date: "Nov 2025", amount: "$235.66" });
  });

  it("the headline total is the sum of the twelve table rows", () => {
    const el = ui().lines.find((l) => l.kind === "electric")!;
    const sum = el.table.reduce((a, r) => a + Number(r.amount.replace(/[$,]/g, "")), 0);
    expect(el.headline).toContain(`$${sum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  });

  it("Oil (no prices) is gated: a reason, the budget figure, NO table and no estimate number", () => {
    const oil = ui().lines.find((l) => l.kind === "oil")!;
    expect(oil.status).toBe("gated");
    expect(oil.badge).toBe("Using the budget figure");
    expect(oil.table).toEqual([]);
    expect(oil.headline).toBeNull();
    expect(oil.basis).toBeNull();
    expect(oil.reason).toMatch(/No heating-oil price has been entered/);
    expect(oil.budgetNote).toBe("$308.00 a month");
    expect(oil.extra.join(" ")).toMatch(/Nothing is projected after Mar 25, 2027 \(your last entered draw\)/);
    expect(oil.extra.join(" ")).toMatch(/Hand-entered draws: Dec 16, 2026 \$2,000\.00; Mar 25, 2027 \$2,000\.00 \(\$4,000\.00 in all, against \$3,696\.00 a year in the budget\)/);
  });

  it("the furnace service is offered as an annual item and kept out of the oil figures", () => {
    const oil = ui().lines.find((l) => l.kind === "oil")!;
    const text = oil.extra.join(" ");
    expect(text).toMatch(/the yearly furnace service left out/);
    expect(text).toMatch(/Suggestion: the yearly furnace service \(\$292\.46, paid Oct 31, 2025 and Sep 11, 2026\) looks like a yearly item/);
    expect(text).toMatch(/kept out of the monthly oil figure/);
    // service rows sit in the payment list with their label, not in the check list
    expect(oil.payments.filter((p) => /yearly furnace service/.test(p.tag ?? "")).map((p) => p.date).sort()).toEqual(["Oct 31, 2025", "Sep 11, 2026"]);
    expect(oil.check.some((r) => r.amount === "$292.46")).toBe(false);
  });

  it("the EK Consulting card payments are labelled, and the untagged charge is listed under 'Check these McCarthy charges'", () => {
    const oil = ui().lines.find((l) => l.kind === "oil")!;
    expect(oil.payments.find((p) => p.date === "Dec 2, 2025")?.tag).toBe("paid on the Eric Kinniburgh Consulting, LLC card by mistake; read here, nothing changed");
    expect(oil.check.map((r) => [r.txId, r.amount])).toEqual([["o2", "$1,036.75"]]);
    expect(oil.check[0]!.notes[0]).toBe("Not tagged Utilities / Oil");
    expect(oil.extra.join(" ")).toMatch(/1 McCarthy charge is unconfirmed/);
    expect(oil.payments.some((p) => p.key === "o2")).toBe(false); // it is in the check list, not the plain list
    expect(oil.excluded).toEqual([]);
  });

  it("a marked row leaves the check list and appears under the excluded rows", () => {
    const oil = toUiSite(personalSite({ excluded: ["o2"] }), NOW, { pricesCorrupt: false }).lines.find((l) => l.kind === "oil")!;
    expect(oil.check).toEqual([]);
    expect(oil.excluded.map((r) => [r.txId, r.amount, r.date])).toEqual([["o2", "$1,036.75", "Oct 9, 2026"]]);
    expect(oil.extra.join(" ")).toMatch(/Last 12 months, as paid: \$2,209\.15 in 2 payments/); // 679.65 + 1529.50
  });

  it("Firewood is gated with its purchases, the budget figure and its draws", () => {
    const wood = ui().lines.find((l) => l.kind === "firewood")!;
    expect(wood.status).toBe("gated");
    expect(wood.table).toEqual([]);
    expect(wood.reason).toMatch(/1 purchase in 1 heating season/);
    expect(wood.payments.map((p) => p.amount)).toEqual(["$315.00"]);
    expect(wood.extra.join(" ")).toMatch(/Hand-entered draws: Dec 14, 2026 \$315\.00/);
  });

  it("the site notes carry the owner statements", () => {
    const notes = ui().notes.join(" ");
    expect(notes).toMatch(/solar/);
    expect(notes).toMatch(/charged to another entity's card by mistake/);
  });

  it("without a flat Budget figure the gated line says the budget and bill figures stay in use", () => {
    const site = toUiSite(personalSite({ flat: false }), NOW, { pricesCorrupt: false });
    expect(site.lines.find((l) => l.kind === "oil")!.budgetNote).toBeNull();
  });
});

describe("toUiSite: the oil estimate and the price list", () => {
  const prices: OilPriceEntry[] = [
    { id: "a", effectiveOn: "2025-10-01", pricePerGal: "4.0000" },
    { id: "b", effectiveOn: "2026-06-01", pricePerGal: "3.50", note: "invoice" },
    { id: "c", effectiveOn: "2026-08-01", pricePerGal: "9.00", removed: true },
  ];
  const ui = () => toUiSite(personalSite({ prices }), NOW, { pricesCorrupt: false });

  it("with two prices 6+ months apart the oil line is an estimate: a flat 12-month table, the sensitivity, the draws sentence", () => {
    const oil = ui().lines.find((l) => l.kind === "oil")!;
    expect(oil.status).toBe("estimate");
    expect(oil.table).toHaveLength(12);
    expect(new Set(oil.table.map((r) => r.amount)).size).toBe(1);
    expect(oil.table[0]!.source).toBe("spread evenly (payments do not show gallons)");
    expect(oil.extra.join(" ")).toMatch(/Each \+\$0\.50 per gallon adds about \$[\d,]+\.\d\d over the last 12 months of use \(about [\d,]+ gallons implied by your prices\)/);
    expect(oil.extra.join(" ")).toMatch(/Forecasts use your hand-entered draws, then this estimate for the months after Mar 25, 2027/);
    expect(oil.headline).toMatch(/a year \(\$[\d,]+\.\d\d a month\) at \$3\.50 a gallon\./);
    expect(oil.basis).toMatch(/1 of the \d payments counted is unconfirmed/);
  });

  it("the price list is newest first, hides removed entries, and keeps the note", () => {
    const op = ui().oilPrices!;
    expect(op.entityId).toBe("ent-p");
    expect(op.rows.map((r) => [r.id, r.price, r.date, r.note])).toEqual([
      ["b", "$3.50", "Jun 1, 2026", "invoice"],
      ["a", "$4.0000", "Oct 1, 2025", null],
    ]);
    expect(op.corrupt).toBe(false);
    expect(toUiSite(personalSite({ prices }), NOW, { pricesCorrupt: true }).oilPrices!.corrupt).toBe(true);
  });
});

describe("toUiSite: Sudden Valley", () => {
  const svSite = () =>
    buildSiteEnergy({
      entity: SVE,
      lines: [L("ent-sv", "t-esv", "Arbor Retreat / Electricity", "electric"), L("ent-sv", "t-osv", "Arbor Retreat / Oil", "oil")],
      txs: [
        ...[["2026-05-08", "79.81"], ["2026-06-09", "70.97"], ["2026-07-13", "127.11"], ["2026-08-11", "237.43"], ["2026-09-14", "237.58"]].map(([d, a], i) => tx(`s${i}`, "ent-sv", d!, a!, "eversource", ["Arbor Retreat / Electricity"], "JCSB operating")),
        ...electricTxs(),
        tx("o1", "ent-p", "2026-10-08", "1529.50", "mccarthy heating oil", ["Utilities / Oil"]),
      ],
      entities: [P, SVE, EKC],
      priceEntries: [],
      flatMonthly: { electric: new Decimal("100"), oil: new Decimal("240") },
      replaceDraws: false,
      now: NOW,
    });

  it("both lines are gated with reasons and their own flat figures; the payments are its own", () => {
    const ui = toUiSite(svSite(), NOW, { pricesCorrupt: false });
    expect(ui.entityName).toBe("Sudden Valley Property Management, LLC");
    const el = ui.lines.find((l) => l.kind === "electric")!;
    expect(el.status).toBe("gated");
    expect(el.reason).toMatch(/Only 5 different months/);
    expect(el.budgetNote).toBe("$100.00 a month");
    expect(el.payments.map((p) => p.amount)).toEqual(["$79.81", "$70.97", "$127.11", "$237.43", "$237.58"]);
    const oil = ui.lines.find((l) => l.kind === "oil")!;
    expect(oil.status).toBe("gated");
    expect(oil.payments).toEqual([]);
    expect(oil.check).toEqual([]);
    expect(ui.notes.join(" ")).toMatch(/short-term rental since Apr 2026/);
    expect(ui.notes.join(" ")).not.toMatch(/solar/i);
  });
});

describe("SeasonalCard (static render)", () => {
  const html = (site: ReturnType<typeof toUiSite>) => renderToStaticMarkup(React.createElement(SeasonalCard, { sites: [site] }));

  it("renders the estimate table with an estimate badge, the basis, the gated lines' reasons, the price form and the McCarthy lists", () => {
    const out = html(toUiSite(personalSite(), NOW, { pricesCorrupt: false }));
    expect(out).toContain("Seasonal bills");
    expect(out).toContain("Personal");
    expect(out).toContain("Estimate (low confidence)");
    expect(out).toContain("Using the budget figure");
    expect(out).toContain("Basis.");
    expect(out).toContain("No heating-oil price has been entered");
    expect(out).toContain('data-testid="oil-price-form"');
    expect(out).toContain(`${CHECK_TITLE} (1)`);
    expect(out).toContain('data-testid="mccarthy-check"');
    expect(out).toContain("Not heating oil");
    expect(out).not.toContain(EXCLUDED_TITLE); // nothing marked yet
    expect(out).toMatch(/Not a guarantee, and not advice/);
    // observational wording, nothing that tells the owner what to do with money
    expect(out).not.toMatch(/you should|we recommend|CPA|guarantee[sd]? savings/i);
  });

  it("shows the excluded list with its exact title and a 'Count it again' button once a row is marked", () => {
    const out = html(toUiSite(personalSite({ excluded: ["o2"] }), NOW, { pricesCorrupt: false }));
    expect(out).toContain(`${EXCLUDED_TITLE} (1)`);
    expect(out).toContain('data-testid="mccarthy-excluded"');
    expect(out).toContain("Count it again");
    expect(out).not.toContain(CHECK_TITLE);
  });

  it("a gated line shows no table", () => {
    const out = html(toUiSite(personalSite(), NOW, { pricesCorrupt: false }));
    // exactly one table: the Electric estimate (Oil and Firewood are gated)
    expect(out.match(/<table/g)).toHaveLength(1);
  });

  it("renders nothing for no sites", () => {
    expect(renderToStaticMarkup(React.createElement(SeasonalCard, { sites: [] }))).toBe("");
  });
});
