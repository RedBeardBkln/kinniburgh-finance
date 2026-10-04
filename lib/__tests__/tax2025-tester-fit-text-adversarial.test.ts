// Tester probes for fit-text (ty2025-ct1040-derived-lines): real line WIDTHS (not just line counts) after fitting,
// unbroken long tokens, non-ASCII and SSN-like payers through the full fillForm path.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { PDFDocument, StandardFonts, TextAlignment, layoutMultilineText, type PDFFont } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { fitCell } from "@/lib/tax2025/pdf/fit-text";
import { f8949RowField } from "@/lib/tax2025/pdf/f8949-layout";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { ct1040Map } from "@/lib/tax2025/pdf/maps/ct1040";
import { f8949Map } from "@/lib/tax2025/pdf/maps/f8949";
import type { PdfTableRow } from "@/lib/tax2025/pdf/types";
import { viewWith } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";
import { DEFAULT_FILL_OPTIONS } from "./tax2025-pdf-harness";

const F8949_A_WIDTH = 136.05;
const CT_DESC_WIDTH = 148.19;
const TAIL = " - see attached statement";

let font: PDFFont;
beforeAll(async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  font = await doc.embedFont(StandardFonts.Helvetica);
});

/** Widest laid-out line (pt) and the number of lines, using pdf-lib's own layout. */
function measure(text: string, size: number, fieldWidth: number): { lines: number; widest: number } {
  const layout = layoutMultilineText(text, { alignment: TextAlignment.Left, font, fontSize: size, bounds: { x: 0, y: 0, width: fieldWidth - 2, height: 1000 } });
  return { lines: layout.lines.length, widest: Math.max(...layout.lines.map((l) => font.widthOfTextAtSize(l.text, size))) };
}

describe("tester: fit-text real line widths", () => {
  const brokerNames = [
    "Robinhood Markets Inc as agent for Robinhood Securities LLC",
    "Charles Schwab & Co., Inc.",
    "A".repeat(90), // one unbroken token
    "Supercalifragilisticexpialidocious-Brokerage-Holdings-International-Group-LLC",
    "W".repeat(60),
    "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega",
    "Multi Payer One LLC; Multi Payer Two LLC; Multi Payer Three LLC; Multi Payer Four LLC",
  ];
  // An unbroken token wider than the box (no spaces) is never a silent clip: fit-text checks the widest laid-out line, not only the line count.
  for (const name of brokerNames) {
    it(`8949 col (a): no line wider than the box, <= 2 lines: ${name.slice(0, 40)}`, () => {
      const text = `${name}${TAIL}`;
      const r = fitCell(font, "broker_name", text, F8949_A_WIDTH);
      const m = measure(r.text, r.fontSize, F8949_A_WIDTH);
      expect(m.lines, `lines for ${r.text}`).toBeLessThanOrEqual(2);
      expect(m.widest, `widest line ${r.text}`).toBeLessThanOrEqual(F8949_A_WIDTH - 2 + 0.01);
    });
  }
  const addresses = [
    "27 OLD BARRY ROAD, WATERFORD, CT 06385",
    "1234 NORTH EXTRAORDINARILY LONG AND WINDING COUNTRY ROAD EXTENSION, WATERFORD, CONNECTICUT 06385",
    "A".repeat(80),
    "W".repeat(40) + ", TOWN",
    "2019 Toyota Highlander XLE Hybrid All-Wheel-Drive Limited Platinum Edition",
  ];
  for (const a of addresses) {
    it(`CT l60d: no overflow on one line: ${a.slice(0, 40)}`, () => {
      const r = fitCell(font, "address", a, CT_DESC_WIDTH);
      const m = measure(r.text, r.fontSize, CT_DESC_WIDTH);
      expect(m.lines).toBe(1);
      expect(m.widest, `widest ${r.text}`).toBeLessThanOrEqual(CT_DESC_WIDTH - 2 + 0.01);
    });
  }
});

describe("tester: fit-text through fillForm", () => {
  const row = (a: string): PdfTableRow => ({ cells: { box: "A", a, b: null, c: null, d: 100, e: 50, f: "M", g: null, h: 50 } });
  const view8949 = (a: string) => viewWith({ tables: { "f8949.partI": [row(a)], "f8949.partII": [], "f8949.totalsI": [], "f8949.totalsII": [] } });
  const textOf = async (bytes: Uint8Array, row_ = 1): Promise<string> => {
    const doc = await PDFDocument.load(bytes);
    return doc.getForm().getTextField(f8949RowField("I", row_, "a")).getText() ?? "";
  };

  it("non-ASCII payer: no throw, text written is Latin-1 only", async () => {
    const name = "Société Générale Ünïcode — Åland Ltd as agent for Çity Bank ★ Ω" + TAIL;
    const res = await fillForm("f8949", view8949(name), f8949Map, DEFAULT_FILL_OPTIONS);
    const text = await textOf(res.bytes);
    expect(text.length).toBeGreaterThan(0);
    for (const ch of text) expect(ch.codePointAt(0) ?? 0).toBeLessThan(0x100);
  });

  it("SSN-like text in a payer name is refused (not written) and never echoed into an item", async () => {
    const name = `Broker 123-45-6789 LLC as agent for X${TAIL}`;
    const res = await fillForm("f8949", view8949(name), f8949Map, DEFAULT_FILL_OPTIONS);
    expect(await textOf(res.bytes)).toBe("");
    expect(res.openItems.some((i) => /123-45-6789|123456789/.test(i.message))).toBe(false);
  });

  it("a digit run split across the dropped clause does not become SSN-like in the cell or an item", async () => {
    const name = `Broker 12345 as agent for 6789 LLC${TAIL}`;
    const res = await fillForm("f8949", view8949(name), f8949Map, DEFAULT_FILL_OPTIONS);
    const text = await textOf(res.bytes);
    expect(/\b\d{3}-?\d{2}-?\d{4}\b/.test(text)).toBe(false);
    for (const i of res.openItems) expect(/\b\d{3}-?\d{2}-?\d{4}\b/.test(i.message)).toBe(false);
  });

  it("an advisory carries the FULL text for a shortened and for a truncated cell", async () => {
    const long = `${"Pathological Brokerage Holdings ".repeat(5).trim()}${TAIL}`;
    const res = await fillForm("f8949", view8949(long), f8949Map, DEFAULT_FILL_OPTIONS);
    expect(res.openItems.find((i) => i.id.startsWith("fill:f8949:fit:"))?.message).toContain(long);
    const res2 = await fillForm("f8949", view8949(`Robinhood Markets Inc as agent for Robinhood Securities LLC${TAIL}`), f8949Map, DEFAULT_FILL_OPTIONS);
    expect(res2.openItems.find((i) => i.id.startsWith("fill:f8949:fit:"))?.message).toContain("Robinhood Securities LLC");
  });

  it("an unbroken token wider than the cell is truncated (never a silent clip) and the advisory carries the full text", async () => {
    const wide = `${"A".repeat(90)}${TAIL}`;
    const res = await fillForm("f8949", view8949(wide), f8949Map, DEFAULT_FILL_OPTIONS);
    const written = await textOf(res.bytes);
    expect(written).toContain("...");
    expect(written.endsWith(TAIL)).toBe(true);
    expect(written.length).toBeLessThan(wide.length);
    expect(res.openItems.find((i) => i.id.startsWith("fill:f8949:fit:"))?.message).toContain(wide);
    const addr = "W".repeat(40) + ", TOWN";
    const view = viewWith({ lines: {}, tables: { "ct.propertyTax": [{ cells: { description: addr, amount: 6000 } }] } });
    const ct = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
    const doc = await PDFDocument.load(ct.bytes);
    expect(doc.getForm().getTextField("ct1040.l60d").getText() ?? "").toContain("...");
    expect(ct.openItems.find((i) => i.id === "fill:ct1040:fit:ct1040.l60d")?.message).toContain(addr);
  });

  it("CT l60d with a long address: street part written, advisory carries the full address", async () => {
    const addr = "1234 NORTH EXTRAORDINARILY LONG AND WINDING COUNTRY ROAD EXTENSION, WATERFORD, CONNECTICUT 06385";
    const view = viewWith({ lines: {}, tables: { "ct.propertyTax": [{ cells: { description: addr, amount: 6000 } }] } });
    const res = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
    const doc = await PDFDocument.load(res.bytes);
    const written = doc.getForm().getTextField("ct1040.l60d").getText() ?? "";
    expect(written.startsWith("1234 NORTH")).toBe(true);
    expect(written).not.toContain("WATERFORD");
    expect(res.openItems.find((i) => i.id === "fill:ct1040:fit:ct1040.l60d")?.message).toContain(addr);
  });

  it("rows with different payers fit independently", async () => {
    const view = viewWith({
      tables: {
        "f8949.partI": [row(`Short Broker LLC${TAIL}`), row(`Robinhood Markets Inc as agent for Robinhood Securities LLC${TAIL}`)],
        "f8949.partII": [],
        "f8949.totalsI": [],
        "f8949.totalsII": [],
      },
    });
    const res = await fillForm("f8949", view, f8949Map, DEFAULT_FILL_OPTIONS);
    expect(await textOf(res.bytes, 1)).toBe(`Short Broker LLC${TAIL}`);
    expect(await textOf(res.bytes, 2)).toBe(`Robinhood Markets Inc${TAIL}`);
  });
});
