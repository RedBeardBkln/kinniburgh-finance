import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 }); // fills real IRS forms
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFCheckBox, PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { copiesOf } from "@/lib/tax2025/pdf/copies";
import { F8949_PART_I_BOXES, F8949_PART_II_BOXES, f8949RowField, f8949TotalField } from "@/lib/tax2025/pdf/f8949-layout";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { f8949Map } from "@/lib/tax2025/pdf/maps/f8949";
import { schDMap } from "@/lib/tax2025/pdf/maps/schD";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import type { FormMap } from "@/lib/tax2025/pdf/types";
import { handleFormRequest, handlePacketRequest, type PdfRouteDeps } from "@/lib/tax2025-pdf-route";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { build, salesFacts } from "./fixtures/tax2025-pdf-schd.fixture";

// TESTER (independent of the Coder's tests): a GEOMETRY oracle for the Schedule D / Form 8949 maps. The numbers below were
// read on 2026-10-04 from the blank IRS PDFs with pdf.js (text positions of the printed line numbers, the (d)(e)(g)(h) /
// (a)..(h) column headers and the box labels) and compared with the widget rectangles. They do not use the catalog's XFA
// "speak" text, so a catalog/speak mix-up cannot hide a wrong-line mapping.

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function rects(file: string): Promise<Map<string, Rect>> {
  const pdf = await PDFDocument.load(readFileSync(join(process.cwd(), "data", "forms", "2025", file)), { ignoreEncryption: true });
  const out = new Map<string, Rect>();
  for (const f of pdf.getForm().getFields()) {
    const w = f.acroField.getWidgets()[0];
    if (!w) continue;
    const r = w.getRectangle();
    out.set(f.getName(), { x: r.x, y: r.y, w: r.width, h: r.height });
  }
  return out;
}

function near(actual: number, expected: number, tol: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
}

describe("Schedule D map: every money field sits on the printed line (row) and column the key names (pdf.js geometry oracle)", () => {
  // printed line -> bottom y of its cells on the page (the line number's text baseline is within the cell's vertical band)
  const COL_X: Record<string, number> = { d: 288, e: 360, g: 432, h: 504 };
  const TABLE_ROW_Y: Record<string, [string, number]> = {
    "1a": ["Page1", 504],
    "1b": ["Page1", 480],
    "2": ["Page1", 456],
    "3": ["Page1", 432],
    "8a": ["Page1", 216],
    "8b": ["Page1", 192],
    "9": ["Page1", 168],
    "10": ["Page1", 144],
  };
  // single-amount lines: page, x of the cell, bottom y (line number text is at the same y; checked against pdf.js text)
  const SINGLE: Record<string, [string, number, number]> = {
    "4": ["Page1", 504, 420],
    "5": ["Page1", 504, 408],
    "6": ["Page1", 507, 384],
    "7": ["Page1", 504, 360],
    "11": ["Page1", 504, 120],
    "12": ["Page1", 504, 108],
    "13": ["Page1", 504, 96],
    "14": ["Page1", 507, 72],
    "15": ["Page1", 504, 48],
    "16": ["Page2", 489.6, 696],
    "18": ["Page2", 489.6, 528],
    "19": ["Page2", 489.6, 492],
    "21": ["Page2", 492.6, 360],
  };

  it("all 43 money cells: key line -> row, key column -> x", async () => {
    const R = await rects("f1040sd.pdf");
    const money = schDMap.lines.filter((l) => l.kind === "money");
    expect(money).toHaveLength(43);
    for (const l of money) {
      if (l.kind !== "money") continue;
      const r = R.get(l.field);
      expect(r, l.field).toBeDefined();
      if (!r) continue;
      const key = String(l.line).replace(/^schd\./, "");
      const [line, col] = key.split(".") as [string, string | undefined];
      const table = TABLE_ROW_Y[line];
      if (table && col) {
        expect(l.field.startsWith(`topmostSubform[0].${table[0]}[0].`), `${key} page`).toBe(true);
        near(r.y, table[1], 0.6, `${key} row y`);
        near(r.x, COL_X[col] ?? -999, 0.6, `${key} column x`);
      } else {
        const s = SINGLE[key];
        expect(s, `${key} is a known single-amount line`).toBeDefined();
        if (!s) continue;
        expect(l.field.startsWith(`topmostSubform[0].${s[0]}[0].`), `${key} page`).toBe(true);
        near(r.x, s[1], 0.6, `${key} x`);
        near(r.y, s[2], 0.6, `${key} y`);
      }
    }
  });

  it("the cells the map blanks (1a g, 8a g) are the read-only shaded cells; Yes/No boxes sit beside the right text", async () => {
    const R = await rects("f1040sd.pdf");
    const blanks = schDMap.blank.filter((b) => "field" in b && b.reason === "form_na").map((b) => ("field" in b ? b.field : ""));
    expect(blanks).toHaveLength(2);
    near(R.get(blanks[0] ?? "")?.y ?? -1, 504, 0.6, "1a (g) row");
    near(R.get(blanks[0] ?? "")?.x ?? -1, 432, 0.6, "1a (g) column");
    near(R.get(blanks[1] ?? "")?.y ?? -1, 216, 0.6, "8a (g) row");
    near(R.get(blanks[1] ?? "")?.x ?? -1, 432, 0.6, "8a (g) column");
    // (yes box x, yes y, no y) per question; Yes is always the upper / left one
    const pairs: Array<[string, string, string, number, number]> = [
      ["schd.qof", `${P1}c1_1[0]`, `${P1}c1_1[1]`, 662, 662],
      ["schd.l17", `${P2}c2_1[0]`, `${P2}c2_1[1]`, 578, 566],
      ["schd.l20", `${P2}c2_2[0]`, `${P2}c2_2[1]`, 458, 422],
      ["schd.l22", `${P2}c2_3[0]`, `${P2}c2_3[1]`, 278, 242],
    ];
    for (const [choice, yes, no, yesY, noY] of pairs) {
      const yesLine = schDMap.lines.find((l) => l.kind === "check" && l.field === yes);
      const noLine = schDMap.lines.find((l) => l.kind === "check" && l.field === no);
      expect(yesLine?.kind === "check" && yesLine.choice === choice && yesLine.equals === "yes", `${choice} yes entry`).toBe(true);
      expect(noLine?.kind === "check" && noLine.choice === choice && noLine.equals === "no", `${choice} no entry`).toBe(true);
      near(R.get(yes)?.y ?? -1, yesY, 4.1, `${choice} Yes y`);
      near(R.get(no)?.y ?? -1, noY, 4.1, `${choice} No y`);
    }
    // QOF: Yes box is to the left of the No box (the printed "Yes" text is at x 508.8, "No" at 552)
    expect((R.get(`${P1}c1_1[0]`)?.x ?? 0) < (R.get(`${P1}c1_1[1]`)?.x ?? 0)).toBe(true);
  });
});

describe("Form 8949 map: row, column, Totals and box cells sit where the form prints them (pdf.js geometry oracle)", () => {
  const COL_X = { a: 36, b: 172.8, c: 223.2, d: 273.6, e: 338.4, f: 403.2, g: 446.4, h: 511.2 } as const;
  const ROW1_BOTTOM = { I: 372, II: 408 } as const; // bottom y of row 1's single-line cells; each next row is 24 lower
  const TOTALS_Y = { I: 72, II: 108 } as const;
  const BOX_Y = { I: [530.2, 518.2, 506.3, 494.2, 482.2, 470.2], II: [566.2, 554.2, 542.2, 530.2, 518.2, 506.2] } as const;

  it("176 row cells: row n is the n-th row down, column letters left to right, Part I = page 1 (short-term), Part II = page 2 (long-term)", async () => {
    const R = await rects("f8949.pdf");
    let n = 0;
    for (const part of ["I", "II"] as const) {
      for (let row = 1; row <= 11; row++) {
        for (const col of ["a", "b", "c", "d", "e", "f", "g", "h"] as const) {
          const name = f8949RowField(part, row, col);
          const r = R.get(name);
          expect(r, name).toBeDefined();
          if (!r) continue;
          expect(name.includes(part === "I" ? "Page1[0]" : "Page2[0]"), `${name} page`).toBe(true);
          near(r.x, COL_X[col], 0.9, `${name} column ${col}`);
          near(r.y, ROW1_BOTTOM[part] - 24 * (row - 1), 0.6, `${name} row ${row}`);
          n += 1;
        }
      }
    }
    expect(n).toBe(176);
  });

  it("Totals cells: below row 11 of the right page, (d)(e)(g)(h) columns, the (f) cell is the unused one", async () => {
    const R = await rects("f8949.pdf");
    for (const part of ["I", "II"] as const) {
      for (const col of ["d", "e", "f", "g", "h"] as const) {
        const r = R.get(f8949TotalField(part, col));
        expect(r, `${part} ${col}`).toBeDefined();
        near(r?.x ?? -1, COL_X[col], 0.9, `totals ${part} ${col} x`);
        near(r?.y ?? -1, TOTALS_Y[part], 0.6, `totals ${part} ${col} y`);
        expect(r?.y ?? 999, "below row 11").toBeLessThan(ROW1_BOTTOM[part] - 24 * 10);
      }
    }
  });

  it("box checkboxes: Part I A B C G H I top-to-bottom on page 1, Part II D E F J K L top-to-bottom on page 2, on-values 1..6 in that order", async () => {
    const R = await rects("f8949.pdf");
    const pdf = await PDFDocument.load(readFileSync(join(process.cwd(), "data", "forms", "2025", "f8949.pdf")), { ignoreEncryption: true });
    const form = pdf.getForm();
    expect([...F8949_PART_I_BOXES]).toEqual(["A", "B", "C", "G", "H", "I"]);
    expect([...F8949_PART_II_BOXES]).toEqual(["D", "E", "F", "J", "K", "L"]);
    for (const [part, page, boxes] of [
      ["I", "Page1[0].c1_1", F8949_PART_I_BOXES],
      ["II", "Page2[0].c2_1", F8949_PART_II_BOXES],
    ] as const) {
      boxes.forEach((box, i) => {
        const name = `topmostSubform[0].${page}[${i}]`;
        near(R.get(name)?.y ?? -1, BOX_Y[part][i] ?? -1, 0.6, `box ${box} y`);
        const field = form.getField(name);
        expect(field instanceof PDFCheckBox, name).toBe(true);
        expect(String((field as PDFCheckBox).acroField.getOnValue()?.asString()), `${box} on-value`).toBe(`/${i + 1}`);
        const entry = f8949Map.lines.find((l) => l.kind === "check" && l.field === name);
        expect(entry?.kind === "check" && entry.equals, `map entry for box ${box}`).toBe(box);
      });
    }
  });
});

describe("Form 8949 Totals when two categories feed one Schedule D line (1099-B box A and 1099-DA box G both through Form 8949)", () => {
  const rows = [
    { box: "A" as const, proceedsCents: 100_000, costCents: 90_000, washSaleCents: 500 },
    { box: "G" as const, form: "1099-DA" as const, payer: "Coinbase", proceedsCents: 200_000, costCents: 150_000, washSaleCents: 700 },
  ];

  it("each sheet's Totals row equals the sum of ITS OWN row (A: 1000/900/5/105, G: 2000/1500/7/507); Schedule D line 1b is the combined 3000/2400/12/612", () => {
    const { view } = build(salesFacts(rows));
    const copies = copiesOf(f8949Map, view);
    expect(copies.map((c) => c.suffix)).toEqual(["a-1", "g-2"]);
    const own = (c: (typeof copies)[number]): Record<string, number | string | null> => {
      const r = c.tables["f8949.partI"]?.[0]?.cells ?? {};
      return { d: r["d"] ?? null, e: r["e"] ?? null, g: r["g"] ?? null, h: r["h"] ?? null };
    };
    const totals = (c: (typeof copies)[number]): Record<string, number | string | null> => {
      const t = c.tables["f8949.totalsI"]?.[0]?.cells ?? {};
      return { d: t["d"] ?? null, e: t["e"] ?? null, g: t["g"] ?? null, h: t["h"] ?? null };
    };
    // the rows are right ...
    expect(own(copies[0]!)).toEqual({ d: 1000, e: 900, g: 5, h: 105 });
    expect(own(copies[1]!)).toEqual({ d: 2000, e: 1500, g: 7, h: 507 });
    // ... and the Totals of each sheet must be that sheet's own sum.
    // (D1, fixed in round 2: before, both Totals rows printed the COMBINED line 1b 3000/2400/12/612.)
    expect(totals(copies[0]!)).toEqual({ d: 1000, e: 900, g: 5, h: 105 });
    expect(totals(copies[1]!)).toEqual({ d: 2000, e: 1500, g: 7, h: 507 });
  });
});

describe("Form 1040 line 7a when Schedule D is filed and line 16 is exactly zero", () => {
  it("prints 0 (Schedule D line 16: 'enter -0- on Form 1040 line 7a')", async () => {
    // d - e + g = 0 exactly: proceeds 1000.00, basis 1001.00, wash sale 1.00
    const { view } = build(salesFacts([{ box: "A", proceedsCents: 100_000, costCents: 100_100, washSaleCents: 100 }]));
    expect(view.lines["schd.16"]?.amount).toBe(0);
    expect(view.lines["f1040.7a"]?.amount).toBe(0);
    const f1040 = FORM_MAPS.find((m) => m.formId === "f1040") as FormMap;
    const res = await fillForm("f1040", view, f1040, { ...DEFAULT_FILL_OPTIONS, stamp: false });
    const fields = await readAllFields(res.bytes);
    // (D2, fixed in round 2: 7a prints 0 when Schedule D is filed and line 16 is exactly 0.)
    expect(fields.get(`${P1}f1_70[0]`)).toBe("0");
  });
});

describe("failure surface: a throwing copies() is a blocking packet item; the single-form route is a 500 with no value in the body", () => {
  const boom: FormMap = { ...f8949Map, copies: () => { throw new Error("row with box X holds $123,456 and SSN 123-45-6789"); } };
  const { view } = build(salesFacts([{ box: "A", proceedsCents: 100_000, costCents: 90_000, washSaleCents: 500 }]));
  const user = { id: "u1", name: "Test User" };
  const deps = (maps: readonly FormMap[]): PdfRouteDeps => ({ buildView: async () => ({ view }), recordExport: async () => undefined, maps });

  it("packet: a throwing copies() leaves that form out with a BLOCKING item (class name only, never the message); the rest of the packet is built", async () => {
    const res = await handlePacketRequest({ year: "2025", stamp: null, user }, deps(FORM_MAPS.map((m) => (m.formId === "f8949" ? boom : m))));
    expect(res.status).toBe(200);
    const pk = await buildPacket(view, { stamp: false, maps: FORM_MAPS.map((m) => (m.formId === "f8949" ? boom : m)) });
    expect(pk.files.some((f) => f.formId === "f8949")).toBe(false);
    expect(pk.files.some((f) => f.formId === "f1040sd")).toBe(true);
    const item = pk.openItems.find((i) => i.id === "fill:f8949:build-failed");
    expect(item?.severity).toBe("blocking");
    expect(item?.message).toContain("Error");
    expect(item?.message).not.toContain("123");
    const entry = pk.forms.find((f) => f.formId === "f8949");
    expect(entry?.included).toBe(false);
    expect(entry?.reason).toContain("could not be built");
  });

  it("single-form route: 500 'The form could not be built.'", async () => {
    const res = await handleFormRequest({ year: "2025", stamp: null, user, form: "f8949" }, deps([boom]));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(JSON.stringify({ error: "The form could not be built." }));
  });

  it("with 13 brokers in one box the real copies() splits (never throws) and every sheet holds <= 11 rows", async () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({ box: "B" as const, proceedsCents: 100_000 + i, costCents: 90_000, payer: `Broker ${i + 1}` }));
    const many = build(salesFacts(rows)).view;
    const copies = copiesOf(f8949Map, many);
    expect(copies.map((c) => c.tables["f8949.partI"]?.length)).toEqual([11, 2]);
    const pk = await buildPacket(many, { stamp: false, maps: FORM_MAPS });
    expect(pk.files.map((f) => f.name).filter((n) => n.includes("8949"))).toEqual(["07-f8949-b-1.pdf", "08-f8949-b-2.pdf"]);
  });
});

