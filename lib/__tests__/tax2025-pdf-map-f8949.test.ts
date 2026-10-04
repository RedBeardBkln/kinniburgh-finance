import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 }); // each case fills real IRS forms
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { copiesOf, fillFormCopies, viewForCopy } from "@/lib/tax2025/pdf/copies";
import {
  F8949_PART_I_BOXES,
  F8949_PART_II_BOXES,
  F8949_ROWS_PER_PAGE,
  F8949_ROW_COLUMNS,
  f8949RowField,
  f8949TotalField,
} from "@/lib/tax2025/pdf/f8949-layout";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { f8949Copies, f8949Map } from "@/lib/tax2025/pdf/maps/f8949";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import type { PdfReturnView, PdfTableRow } from "@/lib/tax2025/pdf/types";
import { handleFormRequest, type PacketExportAudit, type PdfRouteDeps } from "@/lib/tax2025-pdf-route";
import { buildCoverModel } from "@/lib/tax2025/pdf/cover";
import { DEFAULT_FILL_OPTIONS, assertMapComplete, loadCatalog, readAllFields, type FieldValue } from "./tax2025-pdf-harness";
import { build, realFacts, salesFacts, type SaleRow } from "./fixtures/tax2025-pdf-schd.fixture";
import { viewWith } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";

// Golden tests of Form 8949 (summary rows, Exception 2). The real household: short box A with a $5.99 wash sale goes to Form 8949
// (one summary row, code MW), long box D is clean (basis reported, no adjustment) and goes straight to Schedule D line 8a, so it
// has NO 8949 copy. Numbers are the engine's own cells (see tax2025-pdf-map-schd.test.ts).

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";
const BROKER = "Robinhood Markets, Inc. - see attached statement";
const NAMES = "Eric and Eva";

const real = build(realFacts());

function checkboxes(): string[] {
  return [...F8949_PART_I_BOXES.map((_, i) => `${P1}c1_1[${i}]`), ...F8949_PART_II_BOXES.map((_, i) => `${P2}c2_1[${i}]`)];
}

/** Read every field of one copy (the copy's own derived view is filled with the unchanged fillForm). */
async function readCopy(view: PdfReturnView, index: number): Promise<{ fields: Map<string, FieldValue>; label: string; suffix: string }> {
  const copies = copiesOf(f8949Map, view);
  const copy = copies[index];
  if (!copy) throw new Error(`no copy ${index}`);
  const result = await fillForm("f8949", viewForCopy(view, copy), f8949Map, { ...DEFAULT_FILL_OPTIONS, stamp: false });
  return { fields: await readAllFields(result.bytes), label: copy.label, suffix: copy.suffix };
}

/** Assert a copy read-back: the listed fields have the given value, every other field is empty / unchecked. */
function expectExactly(fields: Map<string, FieldValue>, expected: Readonly<Record<string, FieldValue>>): void {
  for (const name of Object.keys(expected)) expect(fields.has(name), `field ${name} exists`).toBe(true);
  for (const [name, value] of fields) {
    const want = expected[name];
    if (want !== undefined) expect(value, name).toBe(want);
    else expect(value, `${name} must be empty / unchecked`).toBe(typeof value === "boolean" ? false : "");
  }
}

describe("Form 8949 map: completeness and speak text", () => {
  it("claims every one of the 202 fields exactly once", () => {
    expect(loadCatalog("f8949").fields).toHaveLength(202);
    assertMapComplete(f8949Map);
  });

  it("layout: 2 x 11 rows x 8 cells, two Totals rows (d e g h mapped, f blank by design), 12 box checkboxes, SSN and name fields", () => {
    const rowCells = f8949Map.tables.filter((t) => t.table === "f8949.partI" || t.table === "f8949.partII");
    expect(rowCells).toHaveLength(2);
    for (const t of rowCells) {
      expect(t.rows).toHaveLength(F8949_ROWS_PER_PAGE);
      for (const r of t.rows) expect(Object.keys(r)).toEqual([...F8949_ROW_COLUMNS]);
      expect(t.overflow).toBe("none");
    }
    const checks = f8949Map.lines.filter((l) => l.kind === "check");
    expect(checks).toHaveLength(12);
    expect(f8949Map.blank.filter((b) => "field" in b && b.reason === "ssn")).toHaveLength(2);
    expect(f8949Map.blank.filter((b) => "field" in b && b.reason === "form_na").map((b) => ("field" in b ? b.field : ""))).toEqual([
      f8949TotalField("I", "f"),
      f8949TotalField("II", "f"),
    ]);
    expect(f8949Map.header.map((h) => h.field)).toEqual([`${P1}f1_01[0]`, `${P2}f2_01[0]`]);
    // 8 header/checkbox fields + 88 row fields + 5 totals per page
    expect(8 + 88 + 5).toBe(101);
  });

  it("every one of the 176 row cells and 8 Totals cells has the IRS text of its row and column", () => {
    const speak = new Map(loadCatalog("f8949").fields.map((f) => [f.name, f.speak ?? ""]));
    const columnText: Readonly<Record<string, RegExp>> = {
      a: /\(a\) Description of property/,
      b: /\(b\) Date acquired/,
      c: /\(c\) Date sold or disposed of/,
      d: /\(d\) Proceeds \(sales price\)/,
      e: /\(e\) Cost or other basis/,
      f: /\(f\) Code\(s\) from instructions/,
      g: /\(g\) Amount of adjustment/,
      h: /\(h\) Gain or \(loss\)\. Subtract column \(e\) from column \(d\)/,
    };
    let n = 0;
    for (const part of ["I", "II"] as const) {
      for (let r = 1; r <= F8949_ROWS_PER_PAGE; r++) {
        for (const c of F8949_ROW_COLUMNS) {
          const text = speak.get(f8949RowField(part, r, c));
          expect(text, `Part ${part} row ${r} (${c})`).toMatch(new RegExp(`Row: ${r}\\.`));
          expect(text, `Part ${part} row ${r} (${c})`).toMatch(columnText[c] as RegExp);
          n += 1;
        }
      }
      const totalText: Readonly<Record<string, RegExp>> = {
        d: /^2\. Totals\. Add the amounts in columns \(d\), \(e\), \(g\), and \(h\)/,
        e: /^2\. Totals\. \(e\) Cost or other basis/,
        f: /^2\. Totals\..*\(f\) Code\(s\)/,
        g: /^2\. Totals\..*\(g\) Amount of adjustment/,
        h: /^2\. Totals\. \(h\) Gain or \(loss\)/,
      };
      for (const c of ["d", "e", "f", "g", "h"] as const) {
        expect(speak.get(f8949TotalField(part, c)), `Part ${part} totals (${c})`).toMatch(totalText[c] as RegExp);
        n += 1;
      }
    }
    expect(n).toBe(176 + 10);
  });

  it("box checkboxes: A B C G H I and D E F J K L in field order, on-values 1-6", () => {
    const boxes = loadCatalog("f8949").fields.filter((f) => f.type === "checkbox");
    expect(boxes.map((f) => f.onValue)).toEqual(["1", "2", "3", "4", "5", "6", "1", "2", "3", "4", "5", "6"]);
    const pat: ReadonlyArray<RegExp> = [/Part I\. Short-Term/, /\(B\) Short-term transactions reported on Form\(s\) 1099-B showing basis was not reported/, /\(C\) Short-term transactions, other than digital asset/, /\(G\) Short-term.*1099-D A showing basis was reported/, /\(H\) Short-term.*not reported/, /\(I\) Short-term digital asset/];
    pat.forEach((p, i) => expect(boxes[i]?.speak, `Part I box ${F8949_PART_I_BOXES[i]}`).toMatch(p));
    const pat2: ReadonlyArray<RegExp> = [/Part I I\. Long-Term/, /\(E\) Long-term transactions reported on Form\(s\) 1099-B showing basis was not reported/, /\(F\) Long-term transactions, other than digital asset/, /\(J\) Long-term.*1099-D A showing basis was reported/, /\(K\) Long-term.*not reported/, /\(L\) Long-term digital asset/];
    pat2.forEach((p, i) => expect(boxes[6 + i]?.speak, `Part II box ${F8949_PART_II_BOXES[i]}`).toMatch(p));
    // the first box of each Part is described together with the Part heading; the form's own order is A B C G H I / D E F J K L
    expect(boxes[0]?.speak).toMatch(/\(A\) Short-term transactions reported on Form\(s\) 1099-B showing basis was reported to the I R S/);
    expect(boxes[6]?.speak).toMatch(/\(D\) Long-term transactions reported on Form\(s\) 1099-B showing basis was reported to the I R S/);
  });
});

describe("Form 8949 golden: the real household (box A with a wash sale; box D is clean and goes to Schedule D line 8a)", () => {
  it("one summary copy, Part I box A: every field read back, the long-term Part is unused and blank", async () => {
    expect(real.ret.scheduleD?.categories.map((c) => [c.box, c.routing])).toEqual([
      ["A", "form_8949_summary"],
      ["D", "schedule_d_direct"],
    ]);
    const copies = copiesOf(f8949Map, real.view);
    expect(copies).toHaveLength(1);
    const { fields, label, suffix } = await readCopy(real.view, 0);
    expect(suffix).toBe("a-1");
    expect(label).toBe("Part I box A (1 summary row); Part II not used (left blank)");
    expectExactly(fields, {
      [`${P1}f1_01[0]`]: NAMES,
      [`${P2}f2_01[0]`]: NAMES,
      [`${P1}c1_1[0]`]: true, // box A
      [f8949RowField("I", 1, "a")]: BROKER,
      [f8949RowField("I", 1, "d")]: "5,872",
      [f8949RowField("I", 1, "e")]: "5,286",
      [f8949RowField("I", 1, "f")]: "MW",
      [f8949RowField("I", 1, "g")]: "6", // the wash sale as a POSITIVE adjustment
      [f8949RowField("I", 1, "h")]: "593", // 592.80 rounded once from cents
      [f8949TotalField("I", "d")]: "5,872",
      [f8949TotalField("I", "e")]: "5,286",
      [f8949TotalField("I", "g")]: "6",
      [f8949TotalField("I", "h")]: "593",
    });
    // columns (b) and (c) (dates) stay blank on a summary row; no box other than A is checked
    expect(fields.get(f8949RowField("I", 1, "b"))).toBe("");
    expect(fields.get(f8949RowField("I", 1, "c"))).toBe("");
    for (const box of checkboxes().filter((b) => b !== `${P1}c1_1[0]`)) expect(fields.get(box), box).toBe(false);
    // SSN fields and the Totals (f) cells are blank by design
    expect(fields.get(`${P1}f1_02[0]`)).toBe("");
    expect(fields.get(`${P2}f2_02[0]`)).toBe("");
  });

  it("the totals row equals Schedule D line 1b (d, e, g, h) and the row's (h) = (d) - (e) + (g) from cents", () => {
    const tot = real.view.tables["f8949.totalsI"]?.[0]?.cells;
    const l = (k: string): number | null => real.view.lines[k as keyof typeof real.view.lines]?.amount ?? null;
    expect(tot).toMatchObject({ box: "A", d: l("schd.1b.d"), e: l("schd.1b.e"), g: l("schd.1b.g"), h: l("schd.1b.h") });
    const row = real.view.tables["f8949.partI"]?.[0]?.cells;
    expect(row?.["h"]).toBe(593);
    // 5,872 - 5,286 + 6 = 592 on the rounded cells: the exact cents are 592.80, so the engine's (h) is 593 and the form is NOT recomputed here
    expect(real.view.openItems.some((i) => i.id.startsWith("adapter:f8949.rounding"))).toBe(false);
    expect(real.view.tables["f8949.partII"]).toEqual([]);
  });

  it("the packet holds exactly one 8949 file named NN-f8949-a-1.pdf, after Schedule D, and the cover lists the sheet", async () => {
    const packet = await buildPacket(real.view, { maps: FORM_MAPS });
    const names = packet.files.filter((f) => f.formId === "f8949").map((f) => f.name);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\d\d-f8949-a-1\.pdf$/);
    const entry = packet.forms.find((f) => f.formId === "f8949");
    expect(entry?.included).toBe(true);
    expect(entry?.note).toContain(`${names[0]}: Part I box A (1 summary row); Part II not used (left blank)`);
    const model = buildCoverModel({ view: real.view, forms: packet.forms, fillItems: packet.openItems, continuations: packet.continuations, stamp: true });
    const text = model.blocks.map((b) => (b.kind === "kv" ? b.label : b.kind === "spacer" ? "" : b.text)).join("\n");
    expect(text).toContain("NOTE for f8949: 1 sheet(s)");
    // the engine's attached-statement item is on the cover
    expect(text).toContain("see attached statement");
  });
});

describe("Form 8949 copies: one sheet per box, a Part I box and a Part II box share a sheet", () => {
  // A (wash sale), B (no basis reported), D (wash sale), E (no basis reported): every box goes through Form 8949.
  const rows: SaleRow[] = [
    { box: "A", proceedsCents: 100_040, costCents: 90_020, washSaleCents: 1_010 },
    { box: "B", proceedsCents: 250_070, costCents: 200_030 },
    { box: "D", proceedsCents: 300_000, costCents: 250_000, washSaleCents: 20_000 },
    { box: "E", proceedsCents: 120_025, costCents: 100_015 },
  ];
  const mixed = build(salesFacts(rows));

  it("the engine's Schedule D cells for this fixture (hand-computed from cents)", () => {
    const l = (k: string): number | null => mixed.view.lines[k as keyof typeof mixed.view.lines]?.amount ?? null;
    // 1b: A  1,000.40 / 900.20 / +10.10 -> 110.30      2: B  2,500.70 / 2,000.30 -> 500.40
    expect([l("schd.1b.d"), l("schd.1b.e"), l("schd.1b.g"), l("schd.1b.h")]).toEqual([1000, 900, 10, 110]);
    expect([l("schd.2.d"), l("schd.2.e"), l("schd.2.h")]).toEqual([2501, 2000, 500]);
    // 8b: D  3,000 / 2,500 / +200 -> 700               9: E  1,200.25 / 1,000.15 -> 200.10
    expect([l("schd.8b.d"), l("schd.8b.e"), l("schd.8b.g"), l("schd.8b.h")]).toEqual([3000, 2500, 200, 700]);
    expect([l("schd.9.d"), l("schd.9.e"), l("schd.9.h")]).toEqual([1200, 1000, 200]);
    // line 7 = round(110.30 + 500.40) = 611, line 15 = round(700 + 200.10) = 900, line 16 from the exact cents = round(1,510.80) = 1,511
    expect([l("schd.7"), l("schd.15"), l("schd.16")]).toEqual([611, 900, 1511]);
  });

  it("two copies: A + D then B + E; every field of both read back", async () => {
    const copies = copiesOf(f8949Map, mixed.view);
    expect(copies.map((c) => c.suffix)).toEqual(["ad-1", "be-2"]);
    expect(copies.map((c) => c.label)).toEqual([
      "Part I box A (1 summary row); Part II box D (1 summary row)",
      "Part I box B (1 summary row); Part II box E (1 summary row)",
    ]);
    const first = await readCopy(mixed.view, 0);
    expectExactly(first.fields, {
      [`${P1}f1_01[0]`]: NAMES,
      [`${P2}f2_01[0]`]: NAMES,
      [`${P1}c1_1[0]`]: true, // box A
      [`${P2}c2_1[0]`]: true, // box D
      [f8949RowField("I", 1, "a")]: BROKER,
      [f8949RowField("I", 1, "d")]: "1,000",
      [f8949RowField("I", 1, "e")]: "900",
      [f8949RowField("I", 1, "f")]: "MW",
      [f8949RowField("I", 1, "g")]: "10",
      [f8949RowField("I", 1, "h")]: "110",
      [f8949TotalField("I", "d")]: "1,000",
      [f8949TotalField("I", "e")]: "900",
      [f8949TotalField("I", "g")]: "10",
      [f8949TotalField("I", "h")]: "110",
      [f8949RowField("II", 1, "a")]: BROKER,
      [f8949RowField("II", 1, "d")]: "3,000",
      [f8949RowField("II", 1, "e")]: "2,500",
      [f8949RowField("II", 1, "f")]: "MW",
      [f8949RowField("II", 1, "g")]: "200",
      [f8949RowField("II", 1, "h")]: "700",
      [f8949TotalField("II", "d")]: "3,000",
      [f8949TotalField("II", "e")]: "2,500",
      [f8949TotalField("II", "g")]: "200",
      [f8949TotalField("II", "h")]: "700",
    });
    const second = await readCopy(mixed.view, 1);
    expectExactly(second.fields, {
      [`${P1}f1_01[0]`]: NAMES,
      [`${P2}f2_01[0]`]: NAMES,
      [`${P1}c1_1[1]`]: true, // box B
      [`${P2}c2_1[1]`]: true, // box E
      [f8949RowField("I", 1, "a")]: BROKER,
      [f8949RowField("I", 1, "d")]: "2,501",
      [f8949RowField("I", 1, "e")]: "2,000",
      [f8949RowField("I", 1, "f")]: "M", // no wash sale: code M only, and no adjustment amount (a zero (g) is blank)
      [f8949RowField("I", 1, "h")]: "500",
      [f8949TotalField("I", "d")]: "2,501",
      [f8949TotalField("I", "e")]: "2,000",
      [f8949TotalField("I", "h")]: "500",
      [f8949RowField("II", 1, "a")]: BROKER,
      [f8949RowField("II", 1, "d")]: "1,200",
      [f8949RowField("II", 1, "e")]: "1,000",
      [f8949RowField("II", 1, "f")]: "M",
      [f8949RowField("II", 1, "h")]: "200",
      [f8949TotalField("II", "d")]: "1,200",
      [f8949TotalField("II", "e")]: "1,000",
      [f8949TotalField("II", "h")]: "200",
    });
  });

  it("the Totals of all copies equal Schedule D lines 1b / 2 / 8b / 9 in every column", () => {
    const l = (k: string): number | null => mixed.view.lines[k as keyof typeof mixed.view.lines]?.amount ?? null;
    const byBox = new Map<string, Record<string, string | number | null>>();
    for (const t of [...(mixed.view.tables["f8949.totalsI"] ?? []), ...(mixed.view.tables["f8949.totalsII"] ?? [])]) byBox.set(String(t.cells["box"]), { ...t.cells });
    const lineOf: Readonly<Record<string, string>> = { A: "1b", B: "2", D: "8b", E: "9" };
    for (const [box, line] of Object.entries(lineOf)) {
      const tot = byBox.get(box);
      for (const c of ["d", "e", "g", "h"] as const) {
        const want = l(`schd.${line}.${c}`);
        expect(tot?.[c] ?? 0, `box ${box} (${c}) vs Schedule D line ${line}`).toBe(want ?? 0);
      }
    }
  });

  it("the packet writes NN-f8949-ad-1.pdf and NN-f8949-be-2.pdf in order, the cover note lists both sheets", async () => {
    const packet = await buildPacket(mixed.view, { maps: FORM_MAPS });
    const names = packet.files.filter((f) => f.formId === "f8949").map((f) => f.name);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^\d\d-f8949-ad-1\.pdf$/);
    expect(names[1]).toMatch(/^\d\d-f8949-be-2\.pdf$/);
    const seq = (n: string | undefined): number => Number((n ?? "").slice(0, 2));
    expect(seq(names[1])).toBe(seq(names[0]) + 1);
    const note = packet.forms.find((f) => f.formId === "f8949")?.note ?? "";
    expect(note).toContain("2 sheet(s)");
    expect(note).toContain("Part I box B (1 summary row); Part II box E (1 summary row)");
  });
});

describe("Form 8949 copies: sheet splitting rules", () => {
  const rowOf = (box: string, i: number, d: number | null = 100 + i): PdfTableRow => ({ cells: { box, a: `Broker ${i} - see attached statement`, b: null, c: null, d, e: 50, f: "M", g: null, h: d === null ? null : d - 50 } });
  const many = (box: string, n: number): PdfTableRow[] => Array.from({ length: n }, (_, i) => rowOf(box, i + 1));
  const viewOf = (p1: PdfTableRow[], p2: PdfTableRow[]): PdfReturnView => viewWith({ tables: { "f8949.partI": p1, "f8949.partII": p2, "f8949.totalsI": [], "f8949.totalsII": [] } });

  it("no rows: no copy (the packet files one blank sheet only when the engine verdict includes the form)", async () => {
    expect(f8949Copies(viewOf([], []))).toEqual([]);
    const blankView = viewWith({ formsRequired: { f8949: { required: "blocking", reason: "undecided" } } });
    const sheets = await fillFormCopies("f8949", blankView, f8949Map, DEFAULT_FILL_OPTIONS);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.copy).toBeNull();
    const fields = await readAllFields(sheets[0]?.result.bytes ?? new Uint8Array());
    // a blank sheet carries only the two name fields: no rows, no box checked, nothing in any total
    const names = new Set([`${P1}f1_01[0]`, `${P2}f2_01[0]`]);
    for (const [name, v] of fields) if (!names.has(name)) expect(v, name).toBe(typeof v === "boolean" ? false : "");
  });

  it("exactly 11 rows fit one sheet; 12 rows need a second sheet of the same box (b-1, b-2)", () => {
    expect(f8949Copies(viewOf(many("B", 11), [])).map((c) => c.suffix)).toEqual(["b-1"]);
    const twelve = f8949Copies(viewOf(many("B", 12), []));
    expect(twelve.map((c) => c.suffix)).toEqual(["b-1", "b-2"]);
    expect(twelve.map((c) => c.tables["f8949.partI"]?.length)).toEqual([11, 1]);
    expect(twelve.map((c) => c.answers["f8949.partIBox"])).toEqual(["B", "B"]);
    expect(twelve[1]?.label).toBe("Part I box B (1 summary row, sheet 2 of 2 for this box); Part II not used (left blank)");
  });

  it("a multi-sheet box: each sheet's Totals are the sums of the whole-dollar rows printed on it", () => {
    const copies = f8949Copies(viewOf(many("A", 13), []));
    const sums = (rows: PdfTableRow[] | undefined, col: string): number => (rows ?? []).reduce((a, r) => a + Number(r.cells[col] ?? 0), 0);
    for (const c of copies) {
      const rows = c.tables["f8949.partI"];
      const total = c.tables["f8949.totalsI"]?.[0]?.cells;
      expect(total?.["d"]).toBe(sums(rows, "d"));
      expect(total?.["e"]).toBe(sums(rows, "e"));
      expect(total?.["h"]).toBe(sums(rows, "h"));
      expect(total?.["g"]).toBeNull(); // nothing adjusted: blank, not 0
    }
  });

  it("Part I boxes and Part II boxes pair up in order; a Part II-only copy has no Part I box", () => {
    expect(f8949Copies(viewOf(many("A", 1), many("D", 1))).map((c) => c.suffix)).toEqual(["ad-1"]);
    expect(f8949Copies(viewOf([...many("B", 1), ...many("A", 1)], many("E", 1))).map((c) => c.suffix)).toEqual(["ae-1", "b-2"]);
    const partIIOnly = f8949Copies(viewOf([], many("F", 1)));
    expect(partIIOnly.map((c) => c.suffix)).toEqual(["f-1"]);
    expect(partIIOnly[0]?.answers).toEqual({ "f8949.partIIBox": "F" });
    // Form 1099-DA boxes: G / H / I and J / K / L
    expect(f8949Copies(viewOf(many("G", 1), many("K", 1))).map((c) => c.suffix)).toEqual(["gk-1"]);
  });

  it("a row with a box that is not a box of its Part is a defect (never dropped silently)", () => {
    expect(() => f8949Copies(viewOf(many("D", 1), []))).toThrow(/not a Part I box/);
    expect(() => f8949Copies(viewOf([], [{ cells: { a: "x" } }]))).toThrow(/not a Part II box/);
  });

  it("box checkboxes use the real on-values: G is the 4th box of Part I (on-value 4), K the 5th of Part II", async () => {
    const view = viewOf(many("G", 1), many("K", 1));
    const { fields } = await readCopy(view, 0);
    expect(fields.get(`${P1}c1_1[3]`)).toBe(true);
    expect(fields.get(`${P2}c2_1[4]`)).toBe(true);
    for (const b of checkboxes().filter((x) => x !== `${P1}c1_1[3]` && x !== `${P2}c2_1[4]`)) expect(fields.get(b), b).toBe(false);
  });

  it("11 rows fill every row of the page and a 12th row on one sheet throws instead of summarising (no 'Other (see statement)')", async () => {
    const eleven = f8949Copies(viewOf(many("A", 11), []))[0];
    if (!eleven) throw new Error("no copy");
    const result = await fillForm("f8949", viewForCopy(viewOf(many("A", 11), []), eleven), f8949Map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    for (let r = 1; r <= 11; r++) expect(fields.get(f8949RowField("I", r, "a")), `row ${r}`).toBe(`Broker ${r} - see attached statement`);
    expect(result.continuations).toEqual([]);
    await expect(fillForm("f8949", viewOf(many("A", 12), []), f8949Map, DEFAULT_FILL_OPTIONS)).rejects.toThrow(/does not overflow/);
  });

  it("duplicate or malformed copy suffixes are refused", () => {
    const bad = { ...f8949Map, copies: () => [{ suffix: "a-1", label: "x", answers: {}, tables: {} }, { suffix: "a-1", label: "y", answers: {}, tables: {} }] };
    expect(() => copiesOf(bad, viewOf([], []))).toThrow(/used twice/);
    const odd = { ...f8949Map, copies: () => [{ suffix: "../x", label: "x", answers: {}, tables: {} }] };
    expect(() => copiesOf(odd, viewOf([], []))).toThrow(/file-name token/);
  });
});

describe("Form 8949: thirteen brokers in one box spill onto a second sheet through the real engine and adapter", () => {
  const brokers: SaleRow[] = Array.from({ length: 13 }, (_, i) => ({ box: "B" as const, proceedsCents: 10_000, costCents: 5_000, payer: `Broker ${String(i + 1).padStart(2, "0")}` }));
  const wide = build(salesFacts(brokers));

  it("13 summary rows -> two sheets (11 + 2); each sheet's Totals match its rows and together equal Schedule D line 2", async () => {
    const copies = copiesOf(f8949Map, wide.view);
    expect(copies.map((c) => c.suffix)).toEqual(["b-1", "b-2"]);
    const first = await readCopy(wide.view, 0);
    const second = await readCopy(wide.view, 1);
    expect(first.fields.get(`${P1}c1_1[1]`)).toBe(true);
    expect(second.fields.get(`${P1}c1_1[1]`)).toBe(true);
    expect(first.fields.get(f8949TotalField("I", "d"))).toBe("1,100");
    expect(first.fields.get(f8949TotalField("I", "e"))).toBe("550");
    expect(first.fields.get(f8949TotalField("I", "h"))).toBe("550");
    expect(second.fields.get(f8949TotalField("I", "d"))).toBe("200");
    expect(second.fields.get(f8949TotalField("I", "h"))).toBe("100");
    expect(first.fields.get(f8949RowField("I", 11, "a"))).toBe("Broker 11 - see attached statement");
    expect(first.fields.get(f8949RowField("I", 12 - 1, "f"))).toBe("M");
    expect(second.fields.get(f8949RowField("I", 2, "a"))).toBe("Broker 13 - see attached statement");
    expect(second.fields.get(f8949RowField("I", 3, "a"))).toBe("");
    // Schedule D line 2 = 13 x (100 / 50 / 50)
    const l = (k: string): number | null => wide.view.lines[k as keyof typeof wide.view.lines]?.amount ?? null;
    expect([l("schd.2.d"), l("schd.2.e"), l("schd.2.h")]).toEqual([1300, 650, 650]);
    expect(1_100 + 200).toBe(l("schd.2.d"));
    expect(550 + 100).toBe(l("schd.2.h"));
    // Part II is unused on both sheets
    for (const box of checkboxes().filter((b) => b.includes("Page2"))) expect(first.fields.get(box), box).toBe(false);
    const packet = await buildPacket(wide.view, { maps: FORM_MAPS });
    expect(packet.files.filter((f) => f.formId === "f8949").map((f) => f.name.replace(/^\d\d-/, ""))).toEqual(["f8949-b-1.pdf", "f8949-b-2.pdf"]);
  });
});

describe("adapter: the Form 8949 view data", () => {
  it("builds rows only for categories routed through Form 8949, with the engine's rounding and cell-level blanks", () => {
    const partI = real.view.tables["f8949.partI"];
    expect(partI).toHaveLength(1);
    expect(partI?.[0]?.cells).toEqual({ box: "A", a: BROKER, b: null, c: null, d: 5872, e: 5286, f: "MW", g: 6, h: 593 });
    expect(real.view.tables["f8949.totalsI"]?.[0]?.cells).toEqual({ box: "A", d: 5872, e: 5286, g: 6, h: 593 });
  });

  it("a return without a Form 8949 category leaves the 8949 tables out of the view (and the fingerprint) entirely", () => {
    const golden = build(salesFacts([]));
    expect(golden.view.tables["f8949.partI"]).toBeUndefined();
    const clean = build(salesFacts([{ box: "D", proceedsCents: 100_000, costCents: 60_000 }]));
    expect(clean.ret.scheduleD?.form8949Required).toBe(false);
    expect(clean.view.tables["f8949.partI"]).toBeUndefined();
    expect(clean.view.tables["f8949.partII"]).toBeUndefined();
  });

  it("the table rows are part of the fingerprint: changing a wash sale changes it", () => {
    const a = build(salesFacts([{ box: "A", proceedsCents: 100_000, costCents: 60_000, washSaleCents: 100 }]));
    const b = build(salesFacts([{ box: "A", proceedsCents: 100_000, costCents: 60_000, washSaleCents: 200 }]));
    expect(a.view.fingerprint).not.toBe(b.view.fingerprint);
  });

  it("two brokers whose rounded rows differ from the Schedule D line by a dollar raise an advisory rounding item (rounded once from cents)", () => {
    // 0.60 + 0.60 of gain: each row rounds to 1, the line total 1.20 rounds to 1
    const rows: SaleRow[] = [
      { box: "B", proceedsCents: 10_060, costCents: 10_000, payer: "Alpha Broker" },
      { box: "B", proceedsCents: 10_060, costCents: 10_000, payer: "Beta Broker" },
    ];
    const { view } = build(salesFacts(rows));
    expect(view.tables["f8949.partI"]?.map((r) => r.cells["h"])).toEqual([1, 1]);
    expect(view.lines["schd.2.h"]?.amount).toBe(1);
    const item = view.openItems.find((i) => i.id === "adapter:f8949.rounding:B:h");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toMatch(/total \$2 but Schedule D line 2 shows \$1/);
    // the sheet's Totals are the engine's line total (1), not the rows' sum (2)
    expect(f8949Copies(view)[0]?.tables["f8949.totalsI"]?.[0]?.cells["h"]).toBe(1);
  });
});

describe("single-form route: a form filed in several copies comes back as a zip, one PDF per copy", () => {
  function deps(view: PdfReturnView): { deps: PdfRouteDeps; audits: PacketExportAudit[] } {
    const audits: PacketExportAudit[] = [];
    return {
      audits,
      deps: {
        buildView: async () => ({ view }),
        recordExport: async (a) => {
          audits.push(a);
        },
      },
    };
  }
  const user = { id: "u1", name: "Test User" };

  it("two copies -> application/zip with f8949-ad-1.pdf and f8949-be-2.pdf, audited once as form f8949", async () => {
    const mixed = build(
      salesFacts([
        { box: "A", proceedsCents: 100_040, costCents: 90_020, washSaleCents: 1_010 },
        { box: "B", proceedsCents: 250_070, costCents: 200_030 },
        { box: "D", proceedsCents: 300_000, costCents: 250_000, washSaleCents: 20_000 },
        { box: "E", proceedsCents: 120_025, costCents: 100_015 },
      ]),
    );
    const { deps: d, audits } = deps(mixed.view);
    const res = await handleFormRequest({ year: "2025", stamp: null, user, form: "f8949" }, d);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["f8949-ad-1.pdf", "f8949-be-2.pdf"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ kind: "form", forms: ["f8949"], fileCount: 2 });
  });

  it("one copy -> a plain application/pdf; no sales at all -> one blank sheet (an explicitly requested form is always filled)", async () => {
    const one = deps(real.view);
    const res = await handleFormRequest({ year: "2025", stamp: null, user, form: "f8949" }, one.deps);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(one.audits[0]).toMatchObject({ fileCount: 1 });
    const none = deps(build(salesFacts([])).view);
    const blank = await handleFormRequest({ year: "2025", stamp: null, user, form: "f8949" }, none.deps);
    expect(blank.headers.get("Content-Type")).toBe("application/pdf");
  });
});
