// Fit-text (ty2025-ct1040-derived-lines, step 8): Form 8949 column (a) and the CT-1040 Schedule 3 description must not
// be clipped. Pure tests of lib/tax2025/pdf/fit-text.ts with the real Helvetica metrics, plus fills of the real forms.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { ADDRESS_FIT, BROKER_FIT, fitCell, fitText, lineCount, type FitKind } from "@/lib/tax2025/pdf/fit-text";
import { f8949RowField } from "@/lib/tax2025/pdf/f8949-layout";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { ct1040Map } from "@/lib/tax2025/pdf/maps/ct1040";
import { f8949Map } from "@/lib/tax2025/pdf/maps/f8949";
import type { PdfTableRow } from "@/lib/tax2025/pdf/types";
import { viewWith } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";
import { DEFAULT_FILL_OPTIONS } from "./tax2025-pdf-harness";

/** The real field widths (pt): 8949 column (a) and the CT-1040 Schedule 3 description box (data/forms/2025/geometry/ct1040.json). */
const F8949_A_WIDTH = 136.05;
const CT_DESC_WIDTH = 148.19;

const ROBINHOOD_FULL = "Robinhood Markets Inc as agent for Robinhood Securities LLC - see attached statement";
const ROBINHOOD_SHORT = "Robinhood Markets Inc - see attached statement";
const TAIL = " - see attached statement";

let font: PDFFont;
beforeAll(async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  font = await doc.embedFont(StandardFonts.Helvetica);
});

describe("fit-text: Form 8949 column (a)", () => {
  it("the real full description (84 characters) needs three lines at the form's 8 pt: that is the clipping defect", () => {
    expect(ROBINHOOD_FULL).toHaveLength(84);
    expect(lineCount(font, ROBINHOOD_FULL, 8, F8949_A_WIDTH)).toBe(3);
    expect(lineCount(font, ROBINHOOD_FULL, 7, F8949_A_WIDTH)).toBe(3);
  });

  it("the shortened description stays within an N-character budget derived from the field width and font", () => {
    const usable = F8949_A_WIDTH - 2;
    const emPerChar = font.widthOfTextAtSize(ROBINHOOD_SHORT, 1) / ROBINHOOD_SHORT.length; // measured average glyph width of the sample, in em
    const budget = Math.floor((BROKER_FIT.maxLines * usable) / (8 * emPerChar));
    expect(budget).toBeGreaterThan(60);
    expect(ROBINHOOD_SHORT.length).toBeLessThanOrEqual(budget);
    // and it really does fit on two lines at 8 pt
    expect(lineCount(font, ROBINHOOD_SHORT, 8, F8949_A_WIDTH)).toBeLessThanOrEqual(2);
  });

  it("the Robinhood row: drop the ' as agent for ...' clause, keep the form's 8 pt, flag it as changed", () => {
    const r = fitCell(font, "broker_name", ROBINHOOD_FULL, F8949_A_WIDTH);
    expect(r.text).toBe(ROBINHOOD_SHORT);
    expect(r.fontSize).toBe(8);
    expect(r.lines).toBeLessThanOrEqual(2);
    expect(r.changed).toBe(true);
    expect(r.truncated).toBe(false);
  });

  it("a short name is untouched (no change, form size)", () => {
    for (const name of ["Broker 1 - see attached statement", "Robinhood Markets, Inc. - see attached statement"]) {
      const r = fitCell(font, "broker_name", name, F8949_A_WIDTH);
      expect(r.text).toBe(name);
      expect(r.changed).toBe(false);
      expect(r.fontSize).toBe(8);
    }
  });

  const NAMES = [
    ROBINHOOD_FULL,
    `FIDELITY BROKERAGE SERVICES LLC${TAIL}`,
    `Charles Schwab & Co., Inc.${TAIL}`,
    `Interactive Brokers LLC${TAIL}`,
    `Robinhood Markets, Inc. / Other Broker LLC${TAIL}`,
    `${"Pathological Brokerage Holdings ".repeat(4).trim()}${TAIL}`,
  ];
  it("a table of broker names: each fits maxLines at some size at or above the 6 pt floor, with the tail kept; shortened ones are flagged", () => {
    expect(NAMES[NAMES.length - 1]?.length).toBeGreaterThan(120);
    for (const name of NAMES) {
      const r = fitCell(font, "broker_name", name, F8949_A_WIDTH);
      expect(r.fontSize, name).toBeGreaterThanOrEqual(6);
      expect(lineCount(font, r.text, r.fontSize, F8949_A_WIDTH), name).toBeLessThanOrEqual(BROKER_FIT.maxLines);
      expect(r.text.endsWith(TAIL), `${name}: the tail survives`).toBe(true);
      expect(r.changed, name).toBe(r.text !== name);
    }
    const pathological = fitCell(font, "broker_name", NAMES[NAMES.length - 1] ?? "", F8949_A_WIDTH);
    expect(pathological.truncated).toBe(true);
    expect(pathological.text).toContain("...");
    expect(pathological.text.startsWith("Pathological")).toBe(true);
  });

  it("is deterministic", () => {
    for (const name of NAMES) expect(fitCell(font, "broker_name", name, F8949_A_WIDTH)).toEqual(fitCell(font, "broker_name", name, F8949_A_WIDTH));
  });
});

describe("fit-text: CT-1040 Schedule 3 description", () => {
  const ADDRESS = "27 OLD BARRY ROAD, WATERFORD, CT 06385";

  it("the real 38-character address is wider than the box at 8 pt (the l60d defect) and fits one line at 6.5 pt", () => {
    expect(ADDRESS).toHaveLength(38);
    const usable = CT_DESC_WIDTH - 2;
    expect(font.widthOfTextAtSize(ADDRESS, 8)).toBeGreaterThan(usable);
    expect(font.widthOfTextAtSize(ADDRESS, 6.5)).toBeLessThanOrEqual(usable);
    const r = fitCell(font, "address", ADDRESS, CT_DESC_WIDTH);
    expect(r.text).toBe(ADDRESS); // nothing shortened, only a smaller font
    expect(r.changed).toBe(false);
    expect(r.fontSize).toBeLessThan(8);
    expect(r.fontSize).toBeGreaterThanOrEqual(ADDRESS_FIT.fullSizes[ADDRESS_FIT.fullSizes.length - 1] ?? 6.5);
    expect(lineCount(font, r.text, r.fontSize, CT_DESC_WIDTH)).toBe(1);
  });

  it("a 90-character address falls back to the street part (flagged)", () => {
    const long = `1234 NORTH EXTRAORDINARILY LONG AND WINDING COUNTRY ROAD EXTENSION, WATERFORD, CONNECTICUT 06385`;
    expect(long.length).toBeGreaterThan(90);
    const r = fitCell(font, "address", long, CT_DESC_WIDTH);
    expect(r.changed).toBe(true);
    expect(r.text.startsWith("1234 NORTH")).toBe(true);
    expect(r.text).not.toContain("WATERFORD");
    expect(lineCount(font, r.text, r.fontSize, CT_DESC_WIDTH)).toBe(1);
  });

  it("a street that is itself too long is cut with '...' (last resort)", () => {
    const street = "A".repeat(10) + " " + "WORD ".repeat(40);
    const r = fitCell(font, "address", `${street}, TOWN`, CT_DESC_WIDTH);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("...")).toBe(true);
    expect(lineCount(font, r.text, r.fontSize, CT_DESC_WIDTH)).toBe(1);
  });
});

describe("fit-text: generic behaviour", () => {
  it("fitText returns the first attempt/size that fits and truncates the head only", () => {
    const attempts = [{ head: "word ".repeat(60).trim(), tail: " [x]", sizes: [8, 6] as const }];
    const r = fitText(font, "original", attempts, { fieldWidth: 100, maxLines: 1 });
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("... [x]")).toBe(true);
    expect(r.fontSize).toBe(6);
    const easy = fitText(font, "ok", [{ head: "ok", tail: "", sizes: [8] }], { fieldWidth: 100, maxLines: 1 });
    expect(easy).toMatchObject({ text: "ok", fontSize: 8, changed: false, truncated: false });
  });
});

// ── The real forms ──────────────────────────────────────────────────────────────

function fontSizeOf(da: string | undefined): number {
  const m = /([\d.]+)\s+Tf/.exec(da ?? "");
  return m ? Number(m[1]) : NaN;
}

describe("fit-text applied by fillForm", () => {
  it("Form 8949: the Robinhood row is written shortened at >= 7 pt, wraps to at most two lines, and the cover gets the full text", async () => {
    const row: PdfTableRow = { cells: { box: "A", a: ROBINHOOD_FULL, b: null, c: null, d: 5872, e: 5286, f: "MW", g: 6, h: 592 } };
    const view = viewWith({ tables: { "f8949.partI": [row], "f8949.partII": [], "f8949.totalsI": [], "f8949.totalsII": [] } });
    const result = await fillForm("f8949", view, f8949Map, DEFAULT_FILL_OPTIONS);
    const doc = await PDFDocument.load(result.bytes);
    const field = doc.getForm().getTextField(f8949RowField("I", 1, "a"));
    const text = field.getText() ?? "";
    expect(text).toBe(ROBINHOOD_SHORT);
    const size = fontSizeOf(field.acroField.getDefaultAppearance());
    expect(size).toBeGreaterThanOrEqual(7);
    expect(lineCount(font, text, size, field.acroField.getWidgets()[0]?.getRectangle().width ?? 0)).toBeLessThanOrEqual(2);
    const item = result.openItems.find((i) => i.id.startsWith("fill:f8949:fit:"));
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toContain(ROBINHOOD_FULL);
  });

  it("Form 8949: a short broker is written as is at the form's size with no item", async () => {
    const row: PdfTableRow = { cells: { box: "A", a: "Broker 1 - see attached statement", b: null, c: null, d: 100, e: 50, f: "M", g: null, h: 50 } };
    const view = viewWith({ tables: { "f8949.partI": [row], "f8949.partII": [], "f8949.totalsI": [], "f8949.totalsII": [] } });
    const result = await fillForm("f8949", view, f8949Map, DEFAULT_FILL_OPTIONS);
    const doc = await PDFDocument.load(result.bytes);
    const field = doc.getForm().getTextField(f8949RowField("I", 1, "a"));
    expect(field.getText()).toBe("Broker 1 - see attached statement");
    expect(fontSizeOf(field.acroField.getDefaultAppearance())).toBe(8);
    expect(result.openItems.some((i) => i.id.startsWith("fill:f8949:fit:"))).toBe(false);
  });

  it("CT-1040 Schedule 3: the full address is written in a smaller font so it is not clipped", async () => {
    const view = viewWith({ lines: {}, tables: { "ct.propertyTax": [{ cells: { description: "27 OLD BARRY ROAD, WATERFORD, CT 06385", amount: 6000 } }] } });
    const result = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
    const doc = await PDFDocument.load(result.bytes);
    const field = doc.getForm().getTextField("ct1040.l60d");
    expect(field.getText()).toBe("27 OLD BARRY ROAD, WATERFORD, CT 06385");
    const size = fontSizeOf(field.acroField.getDefaultAppearance());
    const width = field.acroField.getWidgets()[0]?.getRectangle().width ?? 0;
    expect(font.widthOfTextAtSize("27 OLD BARRY ROAD, WATERFORD, CT 06385", size)).toBeLessThanOrEqual(width - 2);
    expect(result.openItems.some((i) => i.id.startsWith("fill:ct1040:fit:"))).toBe(false);
  });

  it("the fit kinds named by the maps exist", () => {
    const kinds: FitKind[] = [...Object.values(f8949Map.tables.find((t) => t.table === "f8949.partI")?.fit ?? {}), ...Object.values(ct1040Map.tables.find((t) => t.table === "ct.propertyTax")?.fit ?? {})];
    expect(kinds.sort()).toEqual(["address", "broker_name"]);
  });
});
