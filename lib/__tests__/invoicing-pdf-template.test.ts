// The LaunchTime Solutions invoice template (invoice-template/) as drawn by lib/invoicing/pdf: the brand fonts are embedded (subset),
// the standard fonts are the fallback, bank lines "Label: value" print as a label / value pair, right-aligned figures end exactly at the
// right margin, the template's sections are all there, and the default logo and fonts ship with the PDF route.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import { buildPdfModel, splitBankLine, type PdfInput } from "@/lib/invoicing/pdf/model";
import { renderInvoicePdf } from "@/lib/invoicing/pdf/render";
import { loadBrandAssets } from "@/lib/invoicing/pdf/brand";

// Renders real PDFs and reads them back with pdfjs (the guard test pins this timeout).
vi.setConfig({ testTimeout: 30_000 });

type Item = { str: string; x: number; y: number; w: number };

async function textItems(bytes: Uint8Array): Promise<Item[][]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }).promise;
  const pages: Item[][] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.flatMap((it) => ("str" in it && it.str.trim() !== "" ? [{ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, w: it.width as number }] : [])));
  }
  return pages;
}

async function fontNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const names = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Font")) {
      const base = obj.get(PDFName.of("BaseFont"));
      if (base instanceof PDFName) names.add(base.decodeText().replace(/^[A-Z]{6}\+/, "").replace(/-\d+$/, "")); // pdf-lib tags a subset "Name-1234"
    }
  }
  return [...names].sort();
}

function input(over: Partial<PdfInput> = {}): PdfInput {
  return {
    status: "issued",
    displayNumber: "3100",
    title: "Greek Yogurt SOW",
    poNumber: null,
    business: { name: "Eric Kinniburgh Consulting, LLC", dbaName: "LaunchTime Solutions", addressLines: ["1 Test Road", "Testville, CT 00000"], einText: null },
    billTo: { name: "Sample Client LLC", addressLines: ["2 Client Way", "Clientown, NY 11111"] },
    issueDate: "2026-10-08",
    dueText: "Due upon receipt",
    lines: [
      { description: "Project Fee", quantity: "1", unit: null, unitPriceCents: 500000, discountText: null, totalCents: 500000, workDate: null },
      { description: "Ice Pack", quantity: "7", unit: "ea", unitPriceCents: 333, discountText: null, totalCents: 2331, workDate: null },
    ],
    subtotalCents: 502331,
    discountCents: 250000,
    discountLabel: "Discount",
    totalCents: 252331,
    paidCents: 0,
    balanceCents: 252331,
    notes: null,
    termsText: null,
    footerText: "Thank you for your business!",
    remit: { payableTo: "Eric Kinniburgh Consulting, LLC", mailingLines: ["1 Test Road, Testville, CT 00000"], bankLines: ["Bank name: Test Bank", "Routing #: 021000021", "Account type: Checking"] },
    documentLabel: "Invoice",
    ...over,
  };
}

describe("brand fonts", () => {
  it("the Roboto / Roboto Slab files ship in data/invoicing and are small WinAnsi subsets", async () => {
    const brand = await loadBrandAssets();
    expect(brand.fonts).not.toBeNull();
    for (const bytes of Object.values(brand.fonts!)) expect(bytes.length).toBeLessThan(60_000);
    expect(brand.logo?.mime).toBe("image/png");
  });

  it("an invoice embeds the template fonts (subset), not the standard ones", async () => {
    const names = await fontNames((await renderInvoicePdf(input())).bytes);
    expect(names).toEqual(expect.arrayContaining(["Roboto-Regular", "Roboto-Medium", "RobotoSlab-Regular", "RobotoSlab-SemiBold", "RobotoSlab-Medium", "Roboto-Italic"]));
    expect(names.some((n) => n.startsWith("Helvetica"))).toBe(false);
  });

  it("without the font files the same layout is drawn in Helvetica (never blocks the invoice)", async () => {
    const r = await renderInvoicePdf(input(), { fonts: null });
    expect(r.pageCount).toBe(1);
    expect((await fontNames(r.bytes)).every((n) => n.startsWith("Helvetica"))).toBe(true);
    const text = (await textItems(r.bytes)).flat().map((i) => i.str).join("|");
    expect(text).toContain("AMOUNT DUE");
  });

  it("a corrupt font file falls back to Helvetica", async () => {
    const brand = (await loadBrandAssets()).fonts!;
    const r = await renderInvoicePdf(input(), { fonts: { ...brand, regular: Uint8Array.from([0, 1, 2, 3]) } });
    expect(r.pageCount).toBe(1);
    expect((await fontNames(r.bytes)).every((n) => n.startsWith("Helvetica"))).toBe(true);
  });
});

describe("template sections", () => {
  it("prints every section of the template, in order, with whole words (letter spacing stays readable)", async () => {
    const items = (await textItems((await renderInvoicePdf(input())).bytes))[0]!;
    const strs = items.map((i) => i.str);
    for (const s of ["INVOICE", "INVOICE NUMBER", "ISSUE DATE", "TERMS", "BILL TO", "PROJECT", "Greek Yogurt SOW", "DESCRIPTION", "QTY", "RATE", "AMOUNT", "Subtotal", "Discount", "Total", "AMOUNT DUE", "MAIL CHECKS TO", "BANK / ACH DETAILS", "Thank you for your business!"]) {
      expect(strs, s).toContain(s);
    }
    const y = (s: string, from = 0) => items.slice(from).find((i) => i.str === s)!.y;
    expect(y("INVOICE")).toBeGreaterThan(y("BILL TO"));
    expect(y("BILL TO")).toBeGreaterThan(y("DESCRIPTION"));
    expect(y("DESCRIPTION")).toBeGreaterThan(y("AMOUNT DUE"));
    expect(y("AMOUNT DUE")).toBeGreaterThan(y("BANK / ACH DETAILS"));
    expect(y("BANK / ACH DETAILS")).toBeGreaterThan(y("Thank you for your business!"));
    // "Bill to" and "Project" sit side by side, as do "Terms" and "Bank / ACH details"
    expect(Math.abs(y("BILL TO") - y("PROJECT"))).toBeLessThan(0.5);
    const payTerms = items.filter((i) => i.str === "TERMS").sort((a, b) => a.y - b.y)[0]!;
    expect(Math.abs(payTerms.y - y("BANK / ACH DETAILS"))).toBeLessThan(0.5);
  });

  it("right-aligned figures end exactly at the right margin (the cached widths match the drawn glyphs)", async () => {
    const items = (await textItems((await renderInvoicePdf(input())).bytes))[0]!;
    for (const s of ["$5,000.00", "$23.31", "$5,023.31", "-$2,500.00", "$2,523.31", "3100", "2026-10-08", "INVOICE"]) {
      const it = items.filter((i) => i.str === s).sort((a, b) => b.x - a.x)[0]!;
      expect(it, s).toBeDefined();
      expect(Math.abs(it.x + it.w - 558), s).toBeLessThan(2); // "INVOICE" carries letter spacing after its last letter
    }
  });

  it("no project title: the Project column is left out", async () => {
    const strs = (await textItems((await renderInvoicePdf(input({ title: null }))).bytes)).flat().map((i) => i.str);
    expect(strs).not.toContain("PROJECT");
    expect(strs).toContain("BILL TO");
  });

  it("a payment shows the paid line and a large BALANCE DUE", async () => {
    const strs = (await textItems((await renderInvoicePdf(input({ paidCents: 52331, balanceCents: 200000 }))).bytes)).flat().map((i) => i.str);
    expect(strs).toEqual(expect.arrayContaining(["Paid", "-$523.31", "BALANCE DUE", "$2,000.00"]));
    expect(strs).not.toContain("AMOUNT DUE");
  });
});

describe("bank / ACH details", () => {
  it("splits 'Label: value' lines and leaves anything else whole", () => {
    expect(splitBankLine("Routing #: 021000021")).toEqual({ key: "Routing #", value: "021000021" });
    expect(splitBankLine("Bank location: 1 Main St. Provo, UT 84604")).toEqual({ key: "Bank location", value: "1 Main St. Provo, UT 84604" });
    expect(splitBankLine("Routing 021000021")).toBeNull();
    expect(splitBankLine("Wire: ")).toBeNull();
    expect(splitBankLine(`${"x".repeat(40)}: value`)).toBeNull();
  });

  it("a label / value line prints the label in its own column; the value (with a nine-digit routing number) is kept", async () => {
    const items = (await textItems((await renderInvoicePdf(input())).bytes))[0]!;
    const key = items.find((i) => i.str === "Routing #")!;
    const value = items.find((i) => i.str === "021000021")!;
    expect(Math.abs(key.y - value.y)).toBeLessThan(0.5);
    expect(value.x).toBeGreaterThan(key.x + key.w);
  });

  it("the model keeps the plain-text payment lines and puts the bank lines in the right-hand column", () => {
    const m = buildPdfModel(input(), (t) => t.length * 5);
    expect(m.paymentLines).toEqual(["Terms: Due upon receipt", "Mail checks to:", "  Eric Kinniburgh Consulting, LLC", "  1 Test Road, Testville, CT 00000", "Bank / ACH details:", "  Bank name: Test Bank", "  Routing #: 021000021", "  Account type: Checking"]);
    expect(m.payment.right[0]).toEqual({ style: "label", text: "Bank / ACH details" });
    expect(m.payment.right.slice(1).map((c) => c.key)).toEqual(["Bank name", "Routing #", "Account type"]);
    expect(buildPdfModel(input({ remit: { payableTo: null, mailingLines: [], bankLines: [] } }), (t) => t.length * 5).payment.right).toEqual([]);
  });
});

describe("deployment", () => {
  it("the PDF route ships data/invoicing (fonts and default logo are read from disk at run time)", () => {
    const cfg = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(cfg).toMatch(/"\/api\/invoicing\/\*\*": \["\.\/data\/invoicing\/\*\*\/\*"\]/);
  });
  it("the loader falls back to the template logo when no logo was uploaded", () => {
    const src = readFileSync(join(process.cwd(), "lib/invoicing/pdf-build.ts"), "utf8");
    expect(src).toMatch(/logo \?\?= \(await loadBrandAssets\(\)\)\.logo;/);
  });
});
