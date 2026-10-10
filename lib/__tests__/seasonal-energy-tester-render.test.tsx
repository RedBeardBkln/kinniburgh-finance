// TESTER (carry-forward-seasonal-energy, step 2): renders the real Seasonal bills card from a fixture shaped like the live
// books (2026-10-10) and checks what the owner would read: gated lines carry no number of their own, the McCarthy check
// list is complete and each row has its toggle, no account / phone-like digit runs, observational wording.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { Decimal } from "@prisma/client/runtime/library";
(globalThis as unknown as { React: typeof React }).React = React;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/actions/seasonal-settings", () => ({ addOilPrice: vi.fn(), removeOilPrice: vi.fn(), setMcCarthyNotOil: vi.fn() }));

import { buildSiteEnergy, type EnergyEntityRef, type RawEnergyTx, type SeasonalLineRef } from "@/lib/seasonal-energy";
import { toUiSite, CHECK_TITLE, EXCLUDED_TITLE } from "@/lib/seasonal-energy-view";
import { SeasonalCard } from "@/components/forecast/seasonal-card";
import type { OilPriceEntry } from "@/lib/seasonal-energy-prices";

const NOW = new Date("2026-10-10T15:00:00Z");
const ents: EnergyEntityRef[] = [
  { id: "E-P", name: "Personal", slug: "personal" },
  { id: "E-SV", name: "Sudden Valley Property Management, LLC", slug: "sudden-valley" },
  { id: "E-EK", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting" },
];
const lines: SeasonalLineRef[] = [
  { entityId: "E-P", tagId: "t1", tagName: "Utilities / Electric (Eversource)", kind: "electric" },
  { entityId: "E-P", tagId: "t2", tagName: "Utilities / Oil", kind: "oil" },
  { entityId: "E-P", tagId: "t3", tagName: "Utilities / Firewood", kind: "firewood" },
];
const tx = (id: string, iso: string, amount: string, entityId: string, payee: string, account: string, tags: string[] = []): RawEnergyTx => ({
  id,
  date: new Date(`${iso}T00:00:00Z`),
  amount: new Decimal(amount),
  entityId,
  payee,
  account,
  tagPaths: tags,
});
const OIL = "Utilities / Oil";
const REPAIR = "Home & Property / Home Repair";
const MC = "mccarthy heating oil serv 860 4432839 ct";
const txs: RawEnergyTx[] = [
  ...[["2025-11-12", "-235.66"], ["2025-12-09", "-445.42"], ["2026-01-09", "-665.09"], ["2026-02-09", "-583.22"], ["2026-04-09", "-63.60"], ["2026-05-09", "-161.51"], ["2026-08-11", "-41.49"], ["2026-09-14", "-247.89"]].map(
    ([d, a], i) => tx(`e${i}`, d!, a!, "E-P", "eversource web pay", "Primary Checking", ["Utilities / Electric (Eversource)"])
  ),
  tx("m1", "2025-10-31", "-292.46", "E-EK", MC, "Capital One", [REPAIR]),
  tx("m2", "2025-12-02", "-679.65", "E-EK", MC, "Capital One", [OIL]),
  tx("m3", "2026-01-26", "-1225.25", "E-EK", MC, "Capital One", [OIL]),
  tx("m4", "2026-04-05", "-804.60", "E-P", MC, "Barclay", []),
  tx("m5", "2026-05-11", "-783.14", "E-P", MC, "Heating & Electric", [REPAIR]),
  tx("m6", "2026-09-11", "-292.46", "E-P", MC, "Heating & Electric", [REPAIR]),
  tx("m7", "2026-10-08", "-1529.50", "E-P", MC, "Heating & Electric", [OIL]),
  tx("m8", "2026-10-09", "-1036.75", "E-P", MC, "Barclay", []),
  tx("w1", "2026-01-08", "-315.00", "E-P", "check 227", "Primary Checking", ["Utilities / Firewood"]),
  tx("w2", "2026-02-20", "-315.00", "E-P", "check 234", "Primary Checking", ["Utilities / Firewood"]),
];

function html(opts: { prices?: OilPriceEntry[]; excluded?: string[] } = {}) {
  const site = buildSiteEnergy({
    entity: ents[0]!,
    lines,
    txs,
    entities: ents,
    priceEntries: opts.prices ?? [],
    flatMonthly: { electric: new Decimal(172), oil: new Decimal(308), firewood: new Decimal(80) },
    replaceDraws: false,
    draws: { oil: [{ date: "2026-12-16", amount: new Decimal(2000) }], firewood: [{ date: "2026-12-14", amount: new Decimal(315) }] },
    excludedOilIds: new Set(opts.excluded ?? []),
    now: NOW,
  });
  return renderToStaticMarkup(<SeasonalCard sites={[toUiSite(site, NOW, { pricesCorrupt: false })]} />);
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("Seasonal bills card from live-shaped books (gated oil and firewood)", () => {
  const h = html();
  const t = text(h);

  it("electric shows a 12-row table with the live numbers and low confidence", () => {
    expect(t).toContain("About $3,312.09 over the next 12 months");
    expect(t).toContain("Estimate (low confidence)");
    expect(t).toContain("~$128.62");
    expect(t).toContain("~$573.72");
    expect(t).toMatch(/missed by about \$145\.26 on average \(a flat \$172\.00 would have missed by \$195\.84\)/);
  });

  it("oil is gated: names what to enter, shows the budget figure, and no oil estimate number is rendered", () => {
    expect(t).toMatch(/No heating-oil price has been entered/);
    expect(t).toContain("The budget figure ($308.00 a month) stays in use.");
    const oil = t.slice(t.indexOf("Oil Using the budget figure"));
    expect(oil).toContain("Using the budget figure");
    expect(oil.slice(0, oil.indexOf("Heating oil price per gallon"))).not.toMatch(/~\$/);
  });

  it("the check list holds exactly the uncertain McCarthy rows (count taken from the page) and each row has its button", () => {
    expect(t).toContain(`${CHECK_TITLE} (`);
    const rows = (h.match(/Not heating oil<\/button>/g) ?? []).length;
    const m = t.match(/Check these McCarthy charges \((\d+)\)/);
    expect(m).not.toBeNull();
    expect(rows).toBe(Number(m![1]));
    // the untagged Oct 9 repair is in the list and counted (not hidden)
    expect(t).toMatch(/Oct 9, 2026 .*\$1,036\.75/);
    expect(t).toContain("Not tagged Utilities / Oil");
  });

  it("the EK-card rows are labelled 'by mistake' and nothing is said to be changed or moved", () => {
    expect(t).toMatch(/paid on the Eric Kinniburgh Consulting, LLC card by mistake; read here, nothing changed/);
    expect(t).toMatch(/charged to another entity's card by mistake/);
  });

  it("the furnace service is shown as a yearly item and offered as an annual item, not counted", () => {
    expect(t).toContain("yearly furnace service: a yearly item, not counted as oil");
    expect(t).toMatch(/Suggestion: the yearly furnace service \(\$292\.46, paid Oct 31, 2025 and Sep 11, 2026\)/);
    expect(t).toMatch(/Last 12 months, as paid: \$6,058\.89 in 6 payments \(the yearly furnace service left out\)/);
  });

  it("firewood is gated with its two purchases, hand draws are shown as used as they are", () => {
    expect(t).toMatch(/2 purchases in 1 heating season found/);
    expect(t).toContain("Your entered draws are always used as they are.");
    expect(t).toContain("Nothing is projected after Dec 16, 2026");
  });

  it("no account number, phone or id-like digit run is rendered (5+ digits in a row)", () => {
    expect(t).not.toMatch(/\d{5,}/);
    expect(t).not.toMatch(/860|4432839/);
    expect(h).not.toMatch(/data-[a-z-]*=".*\b[0-9a-f]{8}-[0-9a-f]{4}/); // no uuid in data attributes
  });

  it("wording is observational: no advice verbs and no CPA claims", () => {
    expect(t).not.toMatch(/\b(you should|we recommend|recommended|CPA|accountant)\b/i);
    expect(t).toContain("Not a guarantee, and not advice.");
  });
});

describe("with two owner prices the oil line becomes an estimate, still labelled, with the sensitivity sentence", () => {
  const prices: OilPriceEntry[] = [
    { id: "p1", effectiveOn: "2025-11-01", pricePerGal: "3.80" },
    { id: "p2", effectiveOn: "2026-10-01", pricePerGal: "3.50" },
  ];
  const t = text(html({ prices }));
  it("headline, table, basis, sensitivity", () => {
    expect(t).toMatch(/About \$[\d,]+\.\d\d a year \(\$[\d,]+\.\d\d a month\) at \$3\.50 a gallon/);
    expect(t).toMatch(/Each \+\$0\.50 per gallon adds about \$[\d,]+\.\d\d over the last 12 months of use/);
    expect(t).toContain("spread evenly (payments do not show gallons)");
    expect(t).toMatch(/Estimate \(low confidence\)/);
  });
  it("a price older than the oldest counted payment keeps the line gated and names the date to enter", () => {
    const t2 = text(html({ prices: [{ id: "p1", effectiveOn: "2026-02-01", pricePerGal: "3.80" }, { id: "p2", effectiveOn: "2026-10-01", pricePerGal: "3.50" }] }));
    expect(t2).toMatch(/older than your first price entry \(2026-02-01\)/);
    expect(t2).toMatch(/Enter the price in force on or before 2025-12-02/);
  });
  it("the unconfirmed rows are called out in the basis while they are counted", () => {
    expect(t).toMatch(/\d+ of the \d+ payments counted (is|are) unconfirmed/);
  });
});

describe("marking rows moves them to the left-out list with a 'Count it again' button", () => {
  const t = html({ excluded: ["m8"] });
  const tt = text(t);
  it("the Oct 9 repair leaves the check list and the totals", () => {
    expect(tt).toContain(EXCLUDED_TITLE);
    expect(tt).toMatch(/Left out of the oil history \(you marked it not heating oil\) \(1\)/);
    expect((t.match(/Count it again<\/button>/g) ?? []).length).toBe(1);
    expect(tt).toMatch(/Last 12 months, as paid: \$5,022\.14 in 5 payments/); // 6,058.89 - 1,036.75
  });
});

describe("payments list and gated electric (Sudden Valley shape)", () => {
  it("the McCarthy payments list holds neither marked rows nor check-list rows (they have their own lists)", () => {
    const base = text(html());
    const marked = text(html({ excluded: ["m8"] }));
    expect(base).toMatch(/McCarthy payments, last 12 months \(5\)/);
    expect(marked).toMatch(/McCarthy payments, last 12 months \(5\)/);
  });

  it("a gated Electric line (5 months) shows the reason and the budget figure and NO number of its own", () => {
    const svLines: SeasonalLineRef[] = [{ entityId: "E-SV", tagId: "s1", tagName: "Arbor Retreat / Electricity", kind: "electric" }];
    const svTxs = [["2026-05-08", "-79.81"], ["2026-06-09", "-70.97"], ["2026-07-13", "-127.11"], ["2026-08-11", "-237.43"], ["2026-09-14", "-237.58"]].map(([d, a], i) =>
      tx(`s${i}`, d!, a!, "E-SV", "eversource", "JCSB operating", ["Arbor Retreat / Electricity"])
    );
    const site = buildSiteEnergy({ entity: ents[1]!, lines: svLines, txs: [...svTxs, ...txs], entities: ents, priceEntries: [], flatMonthly: { electric: new Decimal(100) }, replaceDraws: false, now: NOW });
    const out = renderToStaticMarkup(<SeasonalCard sites={[toUiSite(site, NOW, { pricesCorrupt: false })]} />);
    const t = text(out);
    expect(t).toContain("Only 5 different months of Eversource payments were found; at least 6 are needed");
    expect(t).toContain("The budget figure ($100.00 a month) stays in use.");
    expect(t).toContain("Using the budget figure");
    expect(t).not.toMatch(/About \$|~\$|Estimate \(/);
    expect(t).toMatch(/short-term rental since Apr 2026/);
    expect(t).not.toMatch(/solar/i); // the Personal house's solar statement is not carried to Sudden Valley
    expect(t).not.toMatch(/McCarthy/); // and none of the Personal / EK oil rows reach it
  });
});

describe("view-model: a gated line carries no number of its own", () => {
  it("every gated UiSeasonalLine has headline null, basis null, an empty table and a reason", () => {
    const site = buildSiteEnergy({ entity: ents[0]!, lines, txs: txs.filter((t) => !t.id.startsWith("e")), entities: ents, priceEntries: [], flatMonthly: { electric: new Decimal(172), oil: new Decimal(308), firewood: new Decimal(80) }, replaceDraws: false, now: NOW });
    const ui = toUiSite(site, NOW, { pricesCorrupt: false });
    expect(ui.lines.map((l) => [l.kind, l.status])).toEqual([["electric", "gated"], ["oil", "gated"], ["firewood", "gated"]]);
    for (const l of ui.lines) {
      expect(l.headline, l.kind).toBeNull();
      expect(l.basis, l.kind).toBeNull();
      expect(l.table, l.kind).toEqual([]);
      expect(l.confidence, l.kind).toBeNull();
      expect(l.reason, l.kind).toBeTruthy();
    }
  });
});
