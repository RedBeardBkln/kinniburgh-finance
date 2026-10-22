// Draws the invoice PDF with pdf-lib in the LaunchTime Solutions design (invoice-template/: gold #D7B418 rule and labels, Roboto Slab
// headings, Roboto body text). The fonts are embedded (subset) from data/invoicing/fonts; when they cannot be read the same layout is
// drawn in the standard Helvetica fonts, so a missing file never blocks an invoice. Server only. Nothing is persisted: callers stream
// the bytes.
//
// Every string written to the PDF passes `safeText` (lib/tax2025/pdf/safe-text.ts: SSN-like text is refused and replaced by a neutral
// placeholder, everything else is made WinAnsi-safe so a non-Latin client name can never abort the render). ONE scoped exception:
// the owner-typed bank / ACH instruction lines (the owner-approved remit-to exception, 2026-10-15) go through `sanitizeWinAnsi`
// only, because a routing number is nine digits and `safeText` would refuse it. That bypass exists in exactly one function
// (`sanitizeBankLine`) and a guard test pins it. No other string takes that path.

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, degrees, rgb, setCharacterSpacing, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { safeText } from "@/lib/tax2025/pdf/safe-text";
import { sanitizeWinAnsi } from "@/lib/tax2025/pdf/winansi";
import { buildPdfModel, LAYOUT, rightRowH, TITLE_BLOCK_H, type Face, type PairCell, type PdfInput, type PdfModel } from "@/lib/invoicing/pdf/model";
import { loadBrandAssets, type BrandFonts } from "@/lib/invoicing/pdf/brand";

const LOGO_MAX_W = 150;
const LOGO_MAX_H = 54;

/** The template's colours (invoice.template.html :root). */
const C = {
  gold: rgb(215 / 255, 180 / 255, 24 / 255),
  goldText: rgb(122 / 255, 98 / 255, 0),
  ink: rgb(32 / 255, 29 / 255, 22 / 255),
  muted: rgb(107 / 255, 100 / 255, 90 / 255),
  line: rgb(228 / 255, 221 / 255, 208 / 255),
  strong: rgb(185 / 255, 175 / 255, 156 / 255),
  watermark: rgb(0.85, 0.85, 0.85),
};

export interface RenderOptions {
  logo?: { bytes: Uint8Array; mime: string } | null;
  /** The brand fonts; omitted = read from data/invoicing/fonts, null = the standard Helvetica fonts. */
  fonts?: BrandFonts | null;
}

export interface RenderResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Strings that looked like an SSN and were replaced (never echoed). */
  refusedCount: number;
}

/** The ONLY place a string bypasses safeText: owner-typed bank / ACH lines. WinAnsi-safe, nothing else. */
function sanitizeBankLine(raw: string): string {
  return sanitizeWinAnsi(raw);
}

/** Runs every free string of the input through safeText (bank lines through the scoped exception) and counts refusals. */
export function cleanInput(input: PdfInput): { input: PdfInput; refused: number } {
  let refused = 0;
  const c = (s: string): string => {
    const r = safeText(s);
    if (r.refused) refused += 1;
    return r.text;
  };
  const cn = (s: string | null): string | null => (s === null ? null : c(s));
  const cleaned: PdfInput = {
    ...input,
    displayNumber: cn(input.displayNumber),
    title: cn(input.title),
    poNumber: cn(input.poNumber),
    business: {
      name: c(input.business.name),
      dbaName: cn(input.business.dbaName),
      addressLines: input.business.addressLines.map(c),
      einText: input.business.einText, // formatted EIN printed only when the owner turned it on; an EIN is not SSN-shaped (2-7 digits)
    },
    billTo: { name: c(input.billTo.name), addressLines: input.billTo.addressLines.map(c) },
    issueDate: cn(input.issueDate),
    dueText: c(input.dueText),
    lines: input.lines.map((l) => ({ ...l, description: c(l.description), unit: cn(l.unit), discountText: cn(l.discountText), workDate: cn(l.workDate) })),
    discountLabel: cn(input.discountLabel),
    notes: cn(input.notes),
    termsText: cn(input.termsText),
    footerText: cn(input.footerText),
    remit: {
      payableTo: cn(input.remit.payableTo),
      mailingLines: input.remit.mailingLines.map(c),
      bankLines: input.remit.bankLines.map(sanitizeBankLine),
    },
    documentLabel: c(input.documentLabel),
  };
  return { input: cleaned, refused };
}

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; slab: PDFFont; slabMedium: PDFFont; slabBold: PDFFont };

async function embedFonts(doc: PDFDocument, brand: BrandFonts | null): Promise<Fonts> {
  if (brand) {
    try {
      doc.registerFontkit(fontkit);
      // Ligatures off: every character is one glyph, so `widthOf` (a sum of per-character advances) is exactly the drawn width.
      const e = (bytes: Uint8Array) => doc.embedFont(bytes, { subset: true, features: { liga: false, clig: false, dlig: false, calt: false } });
      return {
        regular: await e(brand.regular),
        bold: await e(brand.medium),
        italic: await e(brand.italic),
        slab: await e(brand.slab),
        slabMedium: await e(brand.slabMedium),
        slabBold: await e(brand.slabSemiBold),
      };
    } catch {
      // fall through to the standard fonts: a bad font file never blocks the invoice
    }
  }
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold, italic: await doc.embedFont(StandardFonts.HelveticaOblique), slab: regular, slabMedium: bold, slabBold: bold };
}

// pdf-lib measures an embedded font by running the full fontkit layout on every call, which made wrapping a long description take
// seconds. Advances are cached per character instead (sanitised text is WinAnsi, one glyph per character, no ligatures, and pdf-lib
// draws without kerning), so the sum is the same width the page gets.
const advanceCache = new WeakMap<PDFFont, Map<string, number>>();
function widthOf(font: PDFFont, text: string, size: number): number {
  let cache = advanceCache.get(font);
  if (!cache) {
    cache = new Map();
    advanceCache.set(font, cache);
  }
  let units = 0;
  for (const ch of text) {
    let w = cache.get(ch);
    if (w === undefined) {
      w = font.widthOfTextAtSize(ch, 1000);
      cache.set(ch, w);
    }
    units += w;
  }
  return (units * size) / 1000;
}

function pick(fonts: Fonts, bold?: boolean, face?: Face): PDFFont {
  if (face === "slab") return bold ? fonts.slabBold : fonts.slab;
  if (face === "italic") return fonts.italic;
  return bold ? fonts.bold : fonts.regular;
}

export async function renderInvoicePdf(rawInput: PdfInput, opts: RenderOptions = {}): Promise<RenderResult> {
  const { input, refused } = cleanInput(rawInput);
  const doc = await PDFDocument.create();
  const brandFonts = opts.fonts === undefined ? (await loadBrandAssets()).fonts : opts.fonts;
  const fonts = await embedFonts(doc, brandFonts);
  const measure = (text: string, size: number, bold?: boolean, face?: Face) => widthOf(pick(fonts, bold, face), text, size);

  doc.setTitle(`${input.documentLabel} ${input.displayNumber ?? "draft"}`);
  doc.setAuthor(input.business.name);
  doc.setCreator(input.business.name);
  doc.setProducer(input.business.name);
  doc.setSubject(`${input.documentLabel} for ${input.billTo.name}`);
  const stamp = input.issueDate ? new Date(`${input.issueDate}T00:00:00Z`) : new Date(0);
  doc.setCreationDate(stamp);
  doc.setModificationDate(stamp);

  let logoImage: Awaited<ReturnType<PDFDocument["embedPng"]>> | null = null;
  if (opts.logo) {
    try {
      logoImage = opts.logo.mime === "image/png" ? await doc.embedPng(opts.logo.bytes) : await doc.embedJpg(opts.logo.bytes);
    } catch {
      logoImage = null; // a bad logo never blocks the invoice
    }
  }

  const logoHeight = logoImage ? Math.min(LOGO_MAX_H, logoImage.height * Math.min(LOGO_MAX_W / logoImage.width, LOGO_MAX_H / logoImage.height, 1)) + 8 : 0;
  const model = buildPdfModel(input, measure, logoHeight);
  drawModel(doc, model, input, fonts, logoImage);
  const pageCount = doc.getPageCount();
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pageCount}`;
    const w = widthOf(fonts.regular, label, 8.5);
    p.drawText(label, { x: LAYOUT.pageW / 2 - w / 2, y: LAYOUT.margin - 20, size: 8.5, font: fonts.regular, color: C.muted });
  });
  return { bytes: await doc.save(), pageCount, refusedCount: refused };
}

function drawModel(doc: PDFDocument, model: PdfModel, input: PdfInput, fonts: Fonts, logo: Awaited<ReturnType<PDFDocument["embedPng"]>> | null): void {
  const L = LAYOUT;
  const rightX = L.pageW - L.margin;
  const contentW = rightX - L.margin;
  const colW = (contentW - L.colGap) / 2;
  const colQty = 372;
  const colRate = 440;
  const top = L.pageH - L.margin;

  // `track` is letter spacing (the PDF character-spacing operator, set around the one drawText and reset after it).
  const text = (page: PDFPage, s: string, x: number, y: number, size = L.textSize, font = fonts.regular, color: RGB = C.ink, track = 0) => {
    if (s === "") return;
    if (track !== 0) page.pushOperators(setCharacterSpacing(track));
    page.drawText(s, { x, y, size, font, color });
    if (track !== 0) page.pushOperators(setCharacterSpacing(0));
  };
  const textRight = (page: PDFPage, s: string, xRight: number, y: number, size = L.textSize, font = fonts.regular, color: RGB = C.ink, track = 0) =>
    text(page, s, xRight - widthOf(font, s, size) - track * (s.length - 1), y, size, font, color, track);
  const label = (page: PDFPage, s: string, x: number, y: number, color: RGB = C.goldText) => text(page, s.toUpperCase(), x, y, L.labelSize, fonts.slab, color, L.labelTrack);
  const labelRight = (page: PDFPage, s: string, xRight: number, y: number) => textRight(page, s.toUpperCase(), xRight, y, L.labelSize, fonts.slab, C.muted, L.labelTrack);
  const rule = (page: PDFPage, y: number, thickness: number, color: RGB, x0 = L.margin, x1 = rightX) => page.drawLine({ start: { x: x0, y }, end: { x: x1, y }, thickness, color });
  const cell = (page: PDFPage, c: PairCell | null, x: number, y: number) => {
    if (!c) return;
    switch (c.style) {
      case "label":
        label(page, c.text, x, y);
        break;
      case "name":
        text(page, c.text, x, y, L.partyNameSize, fonts.bold);
        break;
      case "muted":
        text(page, c.text, x, y, L.textSize, fonts.regular, C.muted);
        break;
      case "kv":
        if (c.key) text(page, c.key, x, y);
        text(page, c.text, x + model.payment.bankKeyW + 10, y, L.textSize, fonts.regular, C.muted);
        break;
      case "space":
        break;
    }
  };

  model.pages.forEach((pg) => {
    const page = doc.addPage([L.pageW, L.pageH]);
    let y = top;

    if (model.watermark) {
      page.drawText(model.watermark, { x: 150, y: 250, size: 110, font: fonts.bold, color: C.watermark, rotate: degrees(45), opacity: 0.6 });
    }
    // The gold band across the top of every page.
    page.drawRectangle({ x: L.margin, y: top + 14, width: contentW, height: 3, color: C.gold });

    if (pg.showFullHeader) {
      // Left: the logo, then the business block (name in Roboto Slab, the rest muted).
      let leftTop = top;
      if (logo) {
        const scale = Math.min(LOGO_MAX_W / logo.width, LOGO_MAX_H / logo.height, 1);
        const h = logo.height * scale;
        page.drawImage(logo, { x: L.margin, y: top - h, width: logo.width * scale, height: h });
        leftTop = top - h - 8;
      }
      model.headerLeft.forEach((line, i) => {
        const isName = i < model.headerLeftBold;
        text(page, line, L.margin, leftTop - 11 - i * L.lineH, isName ? L.nameSize : L.textSize, isName ? fonts.slabBold : fonts.regular, isName ? C.ink : C.muted);
      });
      // Right: "INVOICE", then the number / date / terms rows. Labels end to the left of the widest value, so a long value
      // ("Net 30 days, due 2026-11-15") never touches its label.
      textRight(page, input.documentLabel.toUpperCase(), rightX, top - 17, L.titleSize, fonts.slabMedium, C.ink, L.titleTrack);
      const labelRightX = rightX - model.headerRightLayout.valueW - 10;
      let ry = top - TITLE_BLOCK_H - 2;
      model.headerRight.forEach((row) => {
        labelRight(page, row.label, labelRightX, ry);
        row.valueLines.forEach((v, vi) => textRight(page, v, rightX, ry - vi * L.lineH));
        ry -= rightRowH(row);
      });
      y = top - model.headerBlockH;
    } else {
      text(page, `${input.documentLabel} ${input.displayNumber ?? "draft"} (continued)`, L.margin, y - 12, 11, fonts.slabBold);
      y -= L.contHeaderH;
    }

    // The rest of the page is a flow of items placed by buildPdfModel (the paginator guarantees each fits above the bottom margin).
    for (const it of pg.items) {
      switch (it.kind) {
        case "gap":
          y -= it.height;
          break;
        case "divider":
          rule(page, y, 0.75, C.line);
          y -= it.height;
          break;
        case "pair":
          cell(page, it.left, L.margin, y);
          cell(page, it.right, L.margin + colW + L.colGap, y);
          y -= it.height;
          break;
        case "tableHead": {
          const hy = y - 10;
          label(page, "Description", L.margin, hy, C.muted);
          label(page, "Qty", colQty, hy, C.muted);
          labelRight(page, "Rate", colRate + 40, hy);
          labelRight(page, "Amount", rightX, hy);
          rule(page, y - L.tableHeaderH + 6, 1.5, C.strong);
          y -= it.height;
          break;
        }
        case "row": {
          const row = it.row;
          let ly = y - 8;
          row.descriptionLines.forEach((line) => {
            text(page, line, L.margin, ly, L.descSize);
            ly -= L.lineH;
          });
          if (row.detailLine) text(page, row.detailLine, L.margin, ly, 8.5, fonts.regular, C.muted);
          text(page, row.quantity, colQty, y - 8);
          textRight(page, row.unitPrice, colRate + 40, y - 8);
          textRight(page, row.total, rightX, y - 8);
          rule(page, y - it.height + 4, 0.5, C.line);
          y -= it.height;
          break;
        }
        case "totals": {
          // Subtotal, discount, total and payments in plain rows; a strong rule; then the amount still owed, large.
          const labelX = rightX - L.totalsW;
          y -= 10;
          const rows = model.totals.slice(0, -1);
          const due = model.totals[model.totals.length - 1]!;
          for (const t of rows) {
            text(page, t.label, labelX, y);
            textRight(page, t.value, rightX, y);
            y -= L.lineH + 3;
          }
          rule(page, y + 8, 1.5, C.strong, labelX, rightX);
          const dueY = y - 12;
          text(page, due.label.toUpperCase(), labelX, dueY, 9.5, fonts.slab, C.ink, L.labelTrack);
          textRight(page, due.value, rightX, dueY, L.dueSize, fonts.slabBold);
          y -= 28;
          break;
        }
        case "sectionLabel":
          label(page, it.text, L.margin, y);
          y -= it.height;
          break;
        case "line":
          if (it.style === "thanks") {
            const w = widthOf(fonts.italic, it.text, L.textSize);
            text(page, it.text, L.pageW / 2 - w / 2, y, L.textSize, fonts.italic, C.muted);
          } else {
            text(page, it.text, L.margin, y);
          }
          y -= it.height;
          break;
      }
    }
  });
}
