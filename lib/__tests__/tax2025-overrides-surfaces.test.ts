import { vi } from "vitest";
vi.setConfig({ testTimeout: 90000 }); // fills real IRS forms
import { describe, expect, it } from "vitest";
import { PDFName, PDFDocument, PDFHexString } from "pdf-lib";
import { applyOverrides, formatOverrideNote, lineSnapshot, type EffectiveReturn, type OverrideRow } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { buildSheetModel, type SheetLine, type SheetModel } from "@/lib/tax2025-sheet";
import { sheetToCsv } from "@/lib/tax2025-sheet-csv";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { buildCoverModel, type CoverBlock } from "@/lib/tax2025/pdf/cover";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { formatDollars } from "@/lib/tax2025/pdf/format";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { formInclusion, resolveFieldValue } from "@/lib/tax2025/pdf/policy";
import type { FormMap, MapMoneyLine, PdfReturnView } from "@/lib/tax2025/pdf/types";
import type { LineKey, Ty2025Return } from "@/lib/tax2025/types";
import { emptyFacts, fullFacts, fullFacts1b } from "./tax2025-fixtures";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";

// THE acceptance test of the overrides wiring: with an override on a COMPUTED line and on a
// BLOCKED line, the review sheet, the CSV and the PDF packet agree on the value, the note,
// the dependents flag, the totals-not-recomputed notice and the blocking count; clearing
// restores the computed state everywhere.

const NOW = new Date("2026-10-13T16:30:00Z");
const OPTS = { generatedAt: "2026-10-13T16:00:00.000Z", generatedBy: "Test User" } as const;

// The complete household fixture, minus the owner's "no 2025 residential clean energy credit" statement: that one
// answer is missing, so Schedule 3 line 5a is "not yet computed" and exactly one blocking item (none:solar_credit) names it.
const facts = fullFacts();
delete facts.statedNone.solar_credit;
const ret = computeTy2025Return(facts);

const COMPUTED: LineKey = "sch1.3"; // Schedule C profit on Schedule 1 (computed 50,000)
const BLOCKED: LineKey = "sch3.5a"; // residential clean energy credit: the owner has not stated "none" yet

let seq = 0;
function pin(r: Ty2025Return, key: LineKey, valueCents: number, over: Partial<OverrideRow> = {}): OverrideRow {
  const l = r.lines[key];
  if (!l) throw new Error(`fixture has no ${key}`);
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(9000 + seq).padStart(12, "0")}`,
    taxYear: 2025,
    targetKind: "line",
    targetKey: key,
    version: 1,
    valueKind: "money_cents",
    valueCents,
    valueText: null,
    computedSnapshot: lineSnapshot(l, r.engineVersion),
    authority: "cpa",
    reason: "Per the CPA call on the 12th",
    setByName: "Eric Kinniburgh",
    setAt: new Date("2026-10-13T02:30:00Z"),
    archivedAt: null,
    ...over,
  };
}

interface Surfaces {
  eff: EffectiveReturn;
  sheet: SheetModel;
  csvRows: string[][];
  view: PdfReturnView;
  coverText: string;
}

/** Minimal RFC 4180 parser (the CSV cells contain commas, quotes and newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function coverTextOf(blocks: CoverBlock[]): string {
  return blocks.map((b) => (b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text)).join("\n");
}

function surfaces(rows: OverrideRow[]): Surfaces {
  const eff = applyOverrides(ret, rows);
  const sheet = buildSheetModel({ ret, documents: [], now: NOW, effective: eff });
  const csvRows = parseCsv(sheetToCsv(sheet));
  const view = toPdfReturnView(ret, facts, { ...OPTS, overrides: { effective: eff, formatNote: formatOverrideNote } });
  const cover = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
  return { eff, sheet, csvRows, view, coverText: coverTextOf(cover.blocks) };
}

const sheetLine = (s: SheetModel, key: LineKey): SheetLine => {
  const l = [...s.federal, ...s.connecticut].flatMap((g) => g.lines).find((x) => x.key === key);
  if (!l) throw new Error(`sheet has no ${key}`);
  return l;
};
const csvRow = (s: Surfaces, key: LineKey): string[] => {
  const r = s.csvRows.find((x) => x[2] === key);
  if (!r) throw new Error(`csv has no ${key}`);
  return r;
};

const HEADER = ["form", "line_id", "line_key", "label", "amount", "status", "provenance", "citation_reason", "override_amount", "override_by", "override_at", "override_reason", "computed_amount", "override_authority", "override_version", "override_stale", "override_note", "depends_on_override"];
const COL = (name: string): number => HEADER.indexOf(name);

function mapOf(formId: string): FormMap {
  const m = FORM_MAPS.find((x) => x.formId === formId);
  if (!m) throw new Error(`no map ${formId}`);
  return m;
}
function moneyEntry(map: FormMap, key: LineKey): MapMoneyLine {
  const e = map.lines.find((l): l is MapMoneyLine => l.kind === "money" && l.line === key);
  if (!e) throw new Error(`${map.formId} maps no ${key}`);
  return e;
}

/** The text a filled PDF carries in one field, and the field's /TU note. */
async function fieldOf(formId: string, view: PdfReturnView, fieldName: string): Promise<{ text: string; tooltip: string | null }> {
  const result = await fillForm(formId, view, mapOf(formId), { ...DEFAULT_FILL_OPTIONS, stamp: false });
  const all = await readAllFields(result.bytes);
  const doc = await PDFDocument.load(result.bytes);
  const field = doc.getForm().getFields().find((f) => f.getName() === fieldName);
  const tu = field?.acroField.dict.lookup(PDFName.of("TU"));
  const tooltip = tu instanceof PDFHexString ? tu.decodeText() : null;
  const v = all.get(fieldName);
  return { text: typeof v === "string" ? v : "", tooltip };
}

describe("fixture sanity", () => {
  it("one line is computed and one is blocked, and the blocked line's item names only that line", () => {
    expect(ret.lines[COMPUTED]?.status).toBe("computed");
    expect(ret.lines[COMPUTED]?.amount).toBe(50_000);
    expect(ret.lines[BLOCKED]?.amount).toBeNull();
    expect(ret.openItems.find((i) => i.id === "none:solar_credit")?.lineKeys).toEqual([BLOCKED]);
  });
});

describe("a computed line and a blocked line are overridden: sheet, CSV and PDF packet agree", () => {
  const rows = [pin(ret, COMPUTED, 6_000_000), pin(ret, BLOCKED, 40_000)];
  const s = surfaces(rows);
  const note = (key: LineKey): string => formatOverrideNote(s.eff.applied.lines.find((l) => l.targetKey === key)!);

  it("the same effective amount on the sheet, in the CSV and in the PDF view, for both lines", () => {
    expect(sheetLine(s.sheet, COMPUTED).amount).toBe(60_000);
    expect(sheetLine(s.sheet, BLOCKED).amount).toBe(400);
    expect(csvRow(s, COMPUTED)[COL("amount")]).toBe("60000");
    expect(csvRow(s, BLOCKED)[COL("amount")]).toBe("400");
    expect(csvRow(s, COMPUTED)[COL("status")]).toBe("CPA override");
    expect(s.view.lines[COMPUTED]).toMatchObject({ status: "overridden", amount: 60_000 });
    expect(s.view.lines[BLOCKED]).toMatchObject({ status: "overridden", amount: 400 });
  });

  it("the same note string (who, when in ET, why, the computed value it replaced) on all three surfaces and the cover", () => {
    expect(note(COMPUTED)).toBe("CPA override: was $50,000 computed, now $60,000, by Eric Kinniburgh (per CPA) on 2026-10-12, reason: Per the CPA call on the 12th");
    expect(sheetLine(s.sheet, COMPUTED).override?.note).toBe(note(COMPUTED));
    expect(csvRow(s, COMPUTED)[COL("override_note")]).toBe(note(COMPUTED));
    expect(s.view.lines[COMPUTED]?.override?.note).toBe(note(COMPUTED));
    expect(s.coverText).toContain(note(COMPUTED));
    // the blocked line says what it replaced
    expect(note(BLOCKED)).toContain("was not yet computed, now $400");
    expect(sheetLine(s.sheet, BLOCKED).override?.note).toBe(note(BLOCKED));
    expect(csvRow(s, BLOCKED)[COL("override_note")]).toBe(note(BLOCKED));
    expect(s.coverText).toContain(note(BLOCKED));
  });

  it("the blocked line prints a value: no line_blank item, a PDF field text and the note as the field's tooltip", async () => {
    const entry = moneyEntry(mapOf("f1040s3"), BLOCKED);
    const decision = resolveFieldValue("f1040s3", s.view.lines[BLOCKED], entry);
    expect(decision.write).toBe(formatDollars(400));
    expect(decision.items).toEqual([]);
    const filled = await fieldOf("f1040s3", s.view, entry.field);
    expect(filled.text).toBe(formatDollars(400));
    expect(filled.tooltip).toBe(note(BLOCKED));
  });

  it("the computed line's PDF field shows the override, with the SAME value the sheet and CSV show", async () => {
    const entry = moneyEntry(mapOf("f1040s1"), COMPUTED);
    const filled = await fieldOf("f1040s1", s.view, entry.field);
    expect(filled.text).toBe(formatDollars(60_000));
    expect(filled.tooltip).toBe(note(COMPUTED));
  });

  it("the blocked line's engine item moves to the resolved list on the sheet and the cover; the blocking counts agree everywhere", () => {
    expect(s.sheet.summary.overrides.resolvedByOverride.map((r) => r.id)).toEqual(["none:solar_credit"]);
    expect(s.view.resolvedByOverride.map((r) => r.id)).toEqual(["none:solar_credit"]);
    expect(s.coverText).toContain("Resolved by CPA override (no longer blocking) (1)");
    expect(s.sheet.openItems.some((i) => i.id === "none:solar_credit")).toBe(false);
    expect(s.view.openItems.some((i) => i.id === "none:solar_credit")).toBe(false);
    const viewBlocking = s.view.openItems.filter((i) => i.severity === "blocking").length;
    expect(s.sheet.summary.blockingItemCount).toBe(s.eff.headline.blockingItemCount);
    expect(viewBlocking).toBe(s.eff.headline.blockingItemCount);
    expect(s.eff.headline.blockingItemCount).toBe(ret.headline.blockingItemCount - 1);
    expect(s.coverText).toContain(`Open items for CPA (${viewBlocking} blocking,`);
  });

  it("dependents are flagged (not recomputed) on all three surfaces", () => {
    const dep = "f1040.9";
    expect(sheetLine(s.sheet, dep).dependsOnOverridden.map((d) => d.key)).toContain(COMPUTED);
    expect(csvRow(s, dep)[COL("depends_on_override")]).toContain("Schedule 1 3");
    expect(s.view.lines[dep]?.dependsOnOverridden).toContain("Schedule 1 line 3");
    expect(s.coverText).toContain("Totals NOT recomputed for these overrides");
    expect(s.coverText).toContain("Form 1040 line 9 depends on Schedule 1 line 3");
    // the override itself is not a dependent of itself, and the engine's own value is not changed on the dependent
    expect(sheetLine(s.sheet, COMPUTED).dependsOnOverridden).toEqual([]);
    expect(sheetLine(s.sheet, dep).amount).toBe(ret.lines[dep]?.amount);
  });

  it("the totals-not-recomputed notice is on the sheet, in the CSV and on the cover", () => {
    expect(s.sheet.summary.overrides.totalsNotRecomputed).toBe(true);
    expect(s.sheet.summary.completenessText).toContain("Totals are NOT recomputed");
    expect(s.sheet.summary.complete).toBe(false);
    const notice = s.csvRows[s.csvRows.length - 1]!;
    expect(notice[0]).toBe("DRAFT NOTICE");
    expect(notice[7]).toContain("2 override(s) in force");
    expect(notice[7]).toContain("totals are NOT recomputed");
    expect(s.view.overrideNotice.totalsNotRecomputed).toBe(true);
    expect(s.coverText).toContain("Totals are NOT recomputed for the overrides listed");
    expect(s.coverText).toContain("OVERRIDES: 2 CPA / owner override(s) are in force");
    // the headline rows that depend on an override say so
    expect(s.sheet.summary.federal[0]?.dependsOnOverride).toBe(true);
    expect(s.view.overrideNotice.headlineMarks.some((m) => m.label === "Federal AGI" && m.dependsOnOverride)).toBe(true);
  });

  it("clearing both overrides restores the computed state on every surface: no marks, the base values and blocking count", () => {
    const cleared = surfaces([]);
    expect(sheetLine(cleared.sheet, COMPUTED).amount).toBe(50_000);
    expect(sheetLine(cleared.sheet, BLOCKED).amount).toBeNull();
    expect(sheetLine(cleared.sheet, BLOCKED).override).toBeNull();
    expect(csvRow(cleared, COMPUTED)[COL("amount")]).toBe("50000");
    expect(csvRow(cleared, BLOCKED)[COL("amount")]).toBe("");
    expect(csvRow(cleared, BLOCKED)[COL("status")]).toBe("not yet computed");
    for (const r of cleared.csvRows.slice(2, -1)) expect(r.slice(COL("override_amount"))).toEqual(["", "", "", "", "", "", "", "", "", ""]);
    expect(cleared.view.lines[COMPUTED]?.status).toBe("computed");
    expect(cleared.view.lines[BLOCKED]?.amount).toBeNull();
    expect(cleared.view.overrides).toEqual([]);
    expect(cleared.view.overrideNotice).toEqual({ totalsNotRecomputed: false, dependents: [], headlineMarks: [], engineChanged: [], count: 0 });
    expect(cleared.sheet.summary.blockingItemCount).toBe(ret.headline.blockingItemCount);
    expect(cleared.sheet.summary.overrides.lineCount).toBe(0);
    expect(cleared.coverText).not.toContain("Totals NOT recomputed");
    expect(cleared.coverText).not.toContain("OVERRIDES:");
    // and the packet is the same as one built with no override layer at all
    const plain = toPdfReturnView(ret, facts, OPTS);
    expect(cleared.view.fingerprint).toBe(plain.fingerprint);
  });

  it("the PDF fingerprint changes with the override, and with a changed reason or authority", () => {
    const base = s.view.fingerprint;
    expect(base).not.toBe(toPdfReturnView(ret, facts, OPTS).fingerprint);
    const fp = (over: Partial<OverrideRow>): string => surfaces([pin(ret, COMPUTED, 6_000_000, { id: "00000000-0000-4000-8000-0000000000e1", ...over }), pin(ret, BLOCKED, 40_000, { id: "00000000-0000-4000-8000-0000000000e2", ...over })]).view.fingerprint;
    const again = fp({});
    expect(fp({})).toBe(again);
    expect(fp({ reason: "A different reason" })).not.toBe(again);
    expect(fp({ authority: "owner" })).not.toBe(again);
  });
});

describe("F9: a pinned line brings its form into the packet even when the engine says the form is not needed", () => {
  const golden1b = computeTy2025Return(fullFacts1b());
  const f1b = fullFacts1b();
  const KEY: LineKey = "sch3.8";
  const plainView = toPdfReturnView(golden1b, f1b, OPTS);

  it("fixture: the engine says Schedule 3 is not required, so the packet omits it", () => {
    expect(plainView.formsRequired?.sch3?.required).toBe(false);
    expect(formInclusion(mapOf("f1040s3"), plainView).include).toBe(false);
  });

  it("with a pin on a Schedule 3 line it is included, with the reason", () => {
    const eff = applyOverrides(golden1b, [pin(golden1b, KEY, 120_000)]);
    const view = toPdfReturnView(golden1b, f1b, { ...OPTS, overrides: { effective: eff, formatNote: formatOverrideNote } });
    expect(view.lines[KEY]?.status).toBe("overridden");
    expect(formInclusion(mapOf("f1040s3"), view)).toEqual({ include: true, reason: expect.stringContaining("a recorded override sets line 8") });
  });
});

describe("CT-1040 (a flat form with our own overlay fields): a CT pin prints", () => {
  it("a pin on ct1040.6 shows in the overlay field and its tooltip, and ct1040.s1.* lines are overridable", async () => {
    const golden1b = computeTy2025Return(fullFacts1b());
    const f1b = fullFacts1b();
    const eff = applyOverrides(golden1b, [pin(golden1b, "ct1040.6", 700_000), pin(golden1b, "ct1040.s1.31", 25_000)]);
    const view = toPdfReturnView(golden1b, f1b, { ...OPTS, overrides: { effective: eff, formatNote: formatOverrideNote } });
    const entry = moneyEntry(mapOf("ct1040"), "ct1040.6");
    const filled = await fieldOf("ct1040", view, entry.field);
    expect(filled.text).toBe(formatDollars(7000));
    expect(filled.tooltip).toContain("CPA override: was");
    expect(view.lines["ct1040.s1.31"]?.status).toBe("overridden");
    // the CT Schedule 1 line feeds the additions total, which feeds CT AGI and the CT tax: all flagged, none recomputed
    expect(view.lines["ct1040.additions"]?.dependsOnOverridden).toContain("CT-1040 line Sch 1 line 31");
    expect(view.lines["ct1040.ctAgi"]?.dependsOnOverridden).toContain("CT-1040 line Sch 1 line 31");
  });
});

describe("an unreadable override never changes a number silently", () => {
  it("is reported (blocking) on the sheet and the cover and the line keeps its computed value", () => {
    const bad = pin(ret, COMPUTED, 6_000_050); // cents: not whole dollars
    const s = surfaces([bad]);
    expect(sheetLine(s.sheet, COMPUTED).amount).toBe(50_000);
    expect(s.sheet.summary.overrides.invalid).toHaveLength(1);
    expect(s.sheet.summary.blockingItemCount).toBe(ret.headline.blockingItemCount + 1);
    expect(s.coverText).toContain("A recorded override could not be read");
  });
});

describe("blocked return: the whole thing still builds", () => {
  it("an all-missing return with one pin builds the sheet, the CSV and the cover", () => {
    const blocked = computeTy2025Return(emptyFacts());
    const eff = applyOverrides(blocked, [pin(blocked, "sch3.1", 250_000)]);
    const sheet = buildSheetModel({ ret: blocked, documents: [], now: NOW, effective: eff });
    expect(sheetToCsv(sheet)).toContain("CPA override");
    const view = toPdfReturnView(blocked, emptyFacts(), { ...OPTS, overrides: { effective: eff, formatNote: formatOverrideNote } });
    expect(buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true }).blocks.length).toBeGreaterThan(10);
  });
});
