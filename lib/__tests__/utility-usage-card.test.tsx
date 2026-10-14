// utility-usage-upload, step 7: the Seasonal card's usage parts. View shaping (history by year, the "usage on file" sentence,
// oil / firewood tables), the card rendered for each usage status, and the pure rules of the upload form (a preview is good
// only for the exact text and mapping it was computed with). All figures are synthetic.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { Decimal } from "@prisma/client/runtime/library";
(globalThis as unknown as { React: typeof React }).React = React;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/actions/seasonal-settings", () => ({ addOilPrice: vi.fn(), removeOilPrice: vi.fn(), setMcCarthyNotOil: vi.fn() }));
vi.mock("@/actions/utility-usage", () => ({ previewUtilityUsage: vi.fn(), saveUtilityUsage: vi.fn(), addUtilityUsageMonth: vi.fn(), archiveUtilityUsage: vi.fn() }));

import { buildSiteEnergy, type EnergyEntityRef, type SeasonalLineRef } from "@/lib/seasonal-energy";
import type { UsageRow, UsageStatus } from "@/lib/seasonal-energy-usage";
import { fmtQty, toUiSite } from "@/lib/seasonal-energy-view";
import { SeasonalCard } from "@/components/forecast/seasonal-card";
import { formKey, saveBlockedReason } from "@/lib/utility-usage-form";
import { parseUsageText, type ParseOk } from "@/lib/utility-usage-parse";

const NOW = new Date("2026-10-10T15:00:00Z");
const ent: EnergyEntityRef = { id: "E-SV", name: "Sudden Valley Property Management, LLC", slug: "sudden-valley" };
const lines: SeasonalLineRef[] = [
  { entityId: "E-SV", tagId: "t1", tagName: "Arbor Retreat / Electricity", kind: "electric" },
  { entityId: "E-SV", tagId: "t2", tagName: "Arbor Retreat / Oil", kind: "oil" },
  { entityId: "E-SV", tagId: "t3", tagName: "Arbor Retreat / Firewood", kind: "firewood" },
];

let seq = 0;
const row = (kind: UsageRow["kind"], period: string, qty: number, cost: number | null, occurredOn = `${period}-01`, note: string | null = null, unit?: string): UsageRow => ({
  id: `row-${++seq}`,
  kind,
  period,
  occurredOn,
  quantity: new Decimal(qty),
  unit: unit ?? (kind === "electric" ? "kwh" : kind === "oil" ? "gal" : "cord"),
  cost: cost === null ? null : new Decimal(cost),
  note,
});
const CURVE = [900, 850, 700, 600, 520, 500, 540, 560, 530, 600, 720, 860];
const electric = (): UsageRow[] =>
  Array.from({ length: 24 }, (_, i) => {
    const t = 2026 * 12 + 8 - (23 - i);
    const p = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
    const k = CURVE[(t % 12)]!;
    return row("electric", p, k, 18 + 0.14 * k, undefined, i === 3 ? "solar credit 12 kWh" : null);
  });
const oil = (): UsageRow[] => [row("oil", "2025-10", 200, null, "2025-10-15"), row("oil", "2026-02", 150.5, null, "2026-02-10")];
const wood = (): UsageRow[] => [row("firewood", "2024-10", 2, 500, "2024-10-05"), row("firewood", "2025-11", 2, 700, "2025-11-02"), row("firewood", "2026-01", 1, 100, "2026-01-05")];

function site(usage: UsageRow[]) {
  return buildSiteEnergy({
    entity: ent,
    lines,
    txs: [],
    entities: [ent],
    priceEntries: [{ id: "p1", effectiveOn: "2026-01-01", pricePerGal: "4.0000" }],
    flatMonthly: { electric: new Decimal(100), oil: new Decimal(240), firewood: new Decimal(80) },
    replaceDraws: false,
    usage,
    now: NOW,
  });
}
const html = (usage: UsageRow[], status: UsageStatus = "ok") => renderToStaticMarkup(<SeasonalCard sites={[toUiSite(site(usage), NOW, { pricesCorrupt: false, usageStatus: status })]} />);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("fmtQty", () => {
  it("drops trailing zeros, keeps 3 decimals at most and groups thousands", () => {
    expect(fmtQty(new Decimal("850"))).toBe("850");
    expect(fmtQty(new Decimal("850.500"))).toBe("850.5");
    expect(fmtQty(new Decimal("1234567.1234"))).toBe("1,234,567.123");
    expect(fmtQty(new Decimal("0"))).toBe("0");
    expect(fmtQty(new Decimal("100"))).toBe("100");
    expect(fmtQty(new Decimal("-5.25"))).toBe("-5.25");
  });
});

describe("toUiSite: usage history", () => {
  const ui = toUiSite(site([...electric(), ...oil(), ...wood()]), NOW, { pricesCorrupt: false });

  it("groups each kind by year, newest first, with one cell per month and the total", () => {
    const e = ui.usageHistory.find((h) => h.kind === "electric")!;
    expect(e.count).toBe(24);
    expect(e.unit).toBe("kWh");
    expect(e.years.map((y) => y.year)).toEqual([2026, 2025, 2024]);
    const y2026 = e.years[0]!;
    expect(y2026.cells).toHaveLength(12);
    expect(y2026.cells.slice(0, 9).every((c) => c !== null)).toBe(true);
    expect(y2026.cells.slice(9)).toEqual([null, null, null]); // October to December 2026 are not in yet
    expect(y2026.rows).toHaveLength(9);
    const y2024 = e.years[2]!;
    expect(y2024.rows.map((r) => r.date)).toEqual(["Oct 2024", "Nov 2024", "Dec 2024"]);
    expect(y2024.rows.every((r) => /kWh$/.test(r.quantity))).toBe(true);
    expect(y2024.rows[0]!.cost).toMatch(/^\$/);
  });

  it("an oil month with two deliveries shows the month total and each delivery in the year list", () => {
    const rows = [...oil(), row("oil", "2026-02", 50, null, "2026-02-25")];
    const u = toUiSite(site(rows), NOW, { pricesCorrupt: false });
    const h = u.usageHistory.find((x) => x.kind === "oil")!;
    const y = h.years.find((x) => x.year === 2026)!;
    expect(y.cells[1]).toBe("200.5");
    expect(y.rows.map((r) => r.quantity)).toEqual(["150.5 gal", "50 gal"]);
    expect(y.rows[0]!.date).toMatch(/Feb 10, 2026/);
  });

  it("firewood rows keep the unit as entered", () => {
    const h = ui.usageHistory.find((x) => x.kind === "firewood")!;
    expect(h.years.flatMap((y) => y.rows.map((r) => r.quantity))).toEqual(expect.arrayContaining(["2 cords", "1 cord"]));
  });

  it("a site with no rows has no history and the kinds the form can offer", () => {
    const u = toUiSite(site([]), NOW, { pricesCorrupt: false });
    expect(u.usageHistory).toEqual([]);
    expect(u.usageKinds.map((k) => k.kind)).toEqual(["electric", "oil", "firewood"]);
    expect(u.usageStatus).toBe("ok");
    expect(u.lines.every((l) => !l.usage)).toBe(true);
  });
});

describe("toUiSite: the usage sentence and the estimates built on usage", () => {
  it("says how many months are on file and that they are used", () => {
    const u = toUiSite(site(electric()), NOW, { pricesCorrupt: false });
    const l = u.lines.find((x) => x.kind === "electric")!;
    expect(l.usage).toEqual({ used: true, text: "24 months of kWh on file (Oct 2024 to Sep 2026): used for the monthly shape." });
    expect(l.status).toBe("estimate");
    expect(l.table).toHaveLength(12);
    expect(l.table[0]!.source).toMatch(/your kWh history \(2 years\)/);
  });

  it("a gated line says why the rows are not used yet and which figure stays", () => {
    const rows = electric().filter((r) => r.period !== "2026-03" && r.period !== "2025-03");
    const l = toUiSite(site(rows), NOW, { pricesCorrupt: false }).lines.find((x) => x.kind === "electric")!;
    expect(l.usage!.used).toBe(false);
    expect(l.usage!.text).toMatch(/not used yet\. .*missing Mar/);
    expect(l.usage!.text).toMatch(/budget figure stays in use/);
    expect(l.status).toBe("gated");
    expect(l.table).toEqual([]);
  });

  it("oil by usage shows twelve different monthly figures and the +$0.50 line in gallons a year", () => {
    const l = toUiSite(site(oil()), NOW, { pricesCorrupt: false }).lines.find((x) => x.kind === "oil")!;
    expect(l.status).toBe("estimate");
    expect(new Set(l.table.map((r) => r.amount)).size).toBeGreaterThan(2);
    expect(l.table[0]!.source).toMatch(/oil deliveries/);
    expect(l.extra.join(" ")).toMatch(/gallons a year from your delivery history/);
    expect(l.headline).toMatch(/on average\) at \$4\.0000 a gallon\.$/);
  });

  it("firewood by usage shows an estimate table and marks purchases covered by the upload", () => {
    const l = toUiSite(site(wood()), NOW, { pricesCorrupt: false }).lines.find((x) => x.kind === "firewood")!;
    expect(l.status).toBe("estimate");
    expect(l.badge).toBe("Estimate (low confidence)");
    expect(l.table).toHaveLength(12);
    expect(l.usage!.text).toMatch(/3 firewood purchases on file/);
  });

  it("an electric row before solar goes live is counted as kept, not used", () => {
    const personal: EnergyEntityRef = { id: "E-P", name: "Personal", slug: "personal" };
    const rows = [row("electric", "2022-12", 800, null), row("electric", "2023-04", 400, null)];
    const s = buildSiteEnergy({
      entity: personal,
      lines: [{ entityId: "E-P", tagId: "t", tagName: "Utilities / Electric (Eversource)", kind: "electric" }],
      txs: [],
      entities: [personal],
      priceEntries: [],
      flatMonthly: {},
      replaceDraws: false,
      usage: rows,
      now: NOW,
    });
    const l = toUiSite(s, NOW, { pricesCorrupt: false }).lines[0]!;
    expect(l.usage!.text).toMatch(/1 row is from before solar went live: kept, not used/);
  });
});

describe("SeasonalCard renders the usage block by status", () => {
  it("ok: the history table, one Remove per row, the add form and the usage sentence", () => {
    const h = html([...electric(), ...oil()]);
    const t = text(h);
    expect(t).toContain("Usage history");
    expect(t).toContain("Electricity: 24 rows on file (kWh)");
    expect(t).toContain("24 months of kWh on file (Oct 2024 to Sep 2026): used for the monthly shape.");
    expect((h.match(/aria-label="Remove (?!the price)/g) ?? []).length).toBe(26); // 24 electric + 2 oil rows (the price list has its own Remove)
    expect(h).toContain('data-testid="usage-upload-form"');
    expect(t).toContain("Add history");
    expect(t).toContain("Upload file");
    expect(t).toContain("One month");
    expect(t).toContain("kWh you were billed for each month, bought from the grid");
    expect(t).toContain("A saved row is never deleted, only archived.");
    // the preview button is disabled until there is text, and there is no Save yet
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>Preview<\/button>/);
    expect(h.slice(h.indexOf('data-testid="usage-upload-form"'))).not.toMatch(/>Save<\/button>/);
  });

  it("ok with no rows: says nothing is uploaded yet and still offers the form", () => {
    const h = html([]);
    expect(text(h)).toContain("No usage uploaded yet");
    expect(h).toContain('data-testid="usage-upload-form"');
  });

  it("not_set_up: one muted line, no form, no Remove, and the rest of the card is unchanged", () => {
    const off = html([], "not_set_up");
    expect(text(off)).toContain("Usage history is not set up yet");
    expect(off).toContain('data-testid="usage-unavailable"');
    expect(off).not.toContain("usage-upload-form");
    expect(off).not.toMatch(/aria-label="Remove (?!the price)/);
    // every line block above the usage section is identical to the card with the table available but no rows
    const noRows = html([], "ok");
    const upToUsage = (s: string) => s.slice(0, s.search(/<section id="usage-history-[^"]*"|<p class="text-xs text-muted-foreground" data-testid="usage-unavailable"/));
    expect(upToUsage(off)).toBe(upToUsage(noRows));
  });

  it("failed: says it could not be read, and still shows the payments-based estimates", () => {
    const h = html([], "failed");
    expect(text(h)).toContain("Usage history could not be read right now");
    expect(h).not.toContain("usage-upload-form");
  });

  it("wording is observational: no advice, no account-like digit runs", () => {
    const t = text(html([...electric(), ...oil(), ...wood()]));
    expect(t).not.toMatch(/you should|we recommend|consider switching/i);
    expect(t).not.toMatch(/\b\d{9,}\b/);
  });
});

describe("the upload form's rules (pure)", () => {
  const text0 = "Month,kWh\n2024-04,400\n2024-05,380\n";
  const parsed = (t: string, mapping?: Parameters<typeof parseUsageText>[0]["mapping"]) => {
    const p = parseUsageText({ kind: "electric", text: t, today: "2026-10-10", mapping, site: { solarLiveFrom: null } });
    if (!p.ok) throw new Error(p.error);
    return p as ParseOk;
  };

  it("Save is blocked without a preview, with a stale preview, with a mapping problem, with no rows and with errors", () => {
    const p = parsed(text0);
    const key = formKey("electric", text0, p.mapping, "cord");
    const base = { preview: p, previewKey: key, currentKey: key, pending: false, skipBad: false };
    expect(saveBlockedReason({ ...base, preview: null, previewKey: null })).toMatch(/Preview the text first/);
    expect(saveBlockedReason(base)).toBeNull();
    // the text changes
    expect(saveBlockedReason({ ...base, currentKey: formKey("electric", text0 + "x", p.mapping, "cord") })).toMatch(/Something changed since the preview/);
    // the mapping changes
    expect(saveBlockedReason({ ...base, currentKey: formKey("electric", text0, ["month", "ignore"], "cord") })).toMatch(/Something changed/);
    // the utility changes
    expect(saveBlockedReason({ ...base, currentKey: formKey("oil", text0, p.mapping, "cord") })).toMatch(/Something changed/);
    expect(saveBlockedReason({ ...base, pending: true })).toBe("Working...");
    const noMap = parsed("A,B\n2024-04,400\n");
    expect(saveBlockedReason({ ...base, preview: noMap })).toMatch(/month/);
    const bad = parsed("Month,kWh\n2024-04,400\n2024-05,oops\n");
    const badKey = formKey("electric", "x", bad.mapping, "cord");
    const bb = { preview: bad, previewKey: badKey, currentKey: badKey, pending: false, skipBad: false };
    expect(saveBlockedReason(bb)).toMatch(/1 row has an error/);
    expect(saveBlockedReason({ ...bb, skipBad: true })).toBeNull();
  });

  it("the unit only matters for firewood", () => {
    expect(formKey("electric", "t", null, "cord")).toBe(formKey("electric", "t", null, "face_cord"));
    expect(formKey("firewood", "t", null, "cord")).not.toBe(formKey("firewood", "t", null, "face_cord"));
  });

  it("the form component uses these rules for its Save button", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/forecast/usage-upload-form.tsx", "utf8");
    expect(src).toMatch(/saveBlockedReason\(/);
    expect(src).toMatch(/disabled=\{!canSave\}/);
    expect(src).toMatch(/formKey\(/);
  });
});
