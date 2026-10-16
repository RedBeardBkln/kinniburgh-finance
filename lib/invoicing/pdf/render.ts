// Draws the invoice PDF with pdf-lib (already a dependency; Helvetica only). Server only. Nothing is persisted: callers stream the bytes.
//
// Every string written to the PDF passes `safeText` (lib/tax2025/pdf/safe-text.ts: SSN-like text is refused and replaced by a neutral
// placeholder, everything else is made WinAnsi-safe so a non-Latin client name can never abort the render). ONE scoped exception:
// the owner-typed bank / ACH instruction lines (the owner-approved remit-to exception, 2026-10-15) go through `sanitizeWinAnsi`
// only, because a routing number is nine digits and `safeText` would refuse it. That bypass exists in exactly one function
// (`sanitizeBankLine`) and a guard test pins it. No other string takes that path.

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { safeText } from "@/lib/tax2025/pdf/safe-text";
import { sanitizeWinAnsi } from "@/lib/tax2025/pdf/winansi";
import { buildPdfModel, LAYOUT, rightRowH, type PdfInput, type PdfModel } from "@/lib/invoicing/pdf/model";

const LOGO_MAX_W = 150;
const LOGO_MAX_H = 56;

export interface RenderOptions {
  logo?: { bytes: Uint8Array; mime: string } | null;
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

export async function renderInvoicePdf(rawInput: PdfInput, opts: RenderOptions = {}): Promise<RenderResult> {
  const { input, refused } = cleanInput(rawInput);
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const measure = (text: string, size: number, isBold?: boolean) => (isBold ? bold : regular).widthOfTextAtSize(text, size);

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

  const logoHeight = logoImage ? Math.min(LOGO_MAX_H, (logoImage.height * Math.min(LOGO_MAX_W / logoImage.width, LOGO_MAX_H / logoImage.height, 1))) + 8 : 0;
  const model = buildPdfModel(input, measure, logoHeight);
  drawModel(doc, model, input, { regular, bold }, logoImage);
  const pageCount = doc.getPageCount();
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${pageCount}`;
    const w = regular.widthOfTextAtSize(label, 9);
    p.drawText(label, { x: LAYOUT.pageW / 2 - w / 2, y: LAYOUT.margin - 20, size: 9, font: regular, color: rgb(0.4, 0.4, 0.4) });
  });
  return { bytes: await doc.save(), pageCount, refusedCount: refused };
}

type Fonts = { regular: PDFFont; bold: PDFFont };

function drawModel(doc: PDFDocument, model: PdfModel, input: PdfInput, fonts: Fonts, logo: Awaited<ReturnType<PDFDocument["embedPng"]>> | null): void {
  const L = LAYOUT;
  const gray = rgb(0.35, 0.35, 0.35);
  const black = rgb(0, 0, 0);
  const rightX = L.pageW - L.margin;
  const colQty = 372;
  const colRate = 440;

  const text = (page: PDFPage, s: string, x: number, y: number, size = L.textSize, bold = false, color = black) => {
    if (s === "") return;
    page.drawText(s, { x, y, size, font: bold ? fonts.bold : fonts.regular, color });
  };
  const textRight = (page: PDFPage, s: string, xRight: number, y: number, size = L.textSize, bold = false) => {
    const w = (bold ? fonts.bold : fonts.regular).widthOfTextAtSize(s, size);
    page.drawText(s, { x: xRight - w, y, size, font: bold ? fonts.bold : fonts.regular, color: black });
  };

  model.pages.forEach((pg, pageIndex) => {
    const page = doc.addPage([L.pageW, L.pageH]);
    let y = L.pageH - L.margin;

    if (model.watermark) {
      const label = model.watermark;
      page.drawText(label, { x: 150, y: 250, size: 110, font: fonts.bold, color: rgb(0.85, 0.85, 0.85), rotate: degrees(45), opacity: 0.6 });
    }

    if (pg.showFullHeader) {
      let leftX = L.margin;
      if (logo) {
        const scale = Math.min(LOGO_MAX_W / logo.width, LOGO_MAX_H / logo.height, 1);
        const w = logo.width * scale;
        const h = logo.height * scale;
        page.drawImage(logo, { x: L.margin, y: y - h, width: w, height: h });
        y -= h + 8;
        leftX = L.margin;
      }
      // The document label ("INVOICE", 18 pt) sits at the top right; the detail rows start below it. Without a logo, `y` is still at
      // the top margin, so push the rows down (otherwise the invoice number is printed on top of the label).
      const headTop = Math.min(y, L.pageH - L.margin - 26);
      model.headerLeft.forEach((line, i) => text(page, line, leftX, headTop - i * L.lineH, i < model.headerLeftBold ? 12 : L.textSize, i < model.headerLeftBold));
      textRight(page, input.documentLabel.toUpperCase(), rightX, L.pageH - L.margin - 4, 18, true);
      // Labels end to the left of the widest value, so a long value ("Net 30 days, due 2026-11-15") never touches its label.
      const labelRightX = rightX - model.headerRightLayout.valueW - 10;
      let ry = headTop;
      model.headerRight.forEach((row) => {
        textRight(page, `${row.label}:`, labelRightX, ry, 9);
        row.valueLines.forEach((v, vi) => textRight(page, v, rightX, ry - vi * L.lineH, L.textSize, true));
        ry -= rightRowH(row);
      });
      y = headTop - Math.max(model.headerLeft.length * L.lineH, headTop - ry) - 18;
    } else {
      text(page, `${input.documentLabel} ${input.displayNumber ?? "draft"} (continued)`, L.margin, y - 12, 11, true);
      y -= L.contHeaderH;
    }

    // The rest of the page is a flow of items placed by buildPdfModel (the paginator guarantees each fits above the bottom margin).
    for (const it of pg.items) {
      switch (it.kind) {
        case "gap":
          y -= it.height;
          break;
        case "billLabel":
          text(page, "Bill to", L.margin, y, 9, true, gray);
          y -= it.height;
          break;
        case "billLine":
          text(page, it.text, L.margin, y, L.textSize, it.bold);
          y -= it.height;
          break;
        case "titleLine":
          text(page, it.text, L.margin, y, 12, true);
          y -= it.height;
          break;
        case "tableHead":
          page.drawLine({ start: { x: L.margin, y: y + 4 }, end: { x: rightX, y: y + 4 }, thickness: 0.5, color: gray });
          text(page, "Description", L.margin, y - 10, 9, true, gray);
          text(page, "Qty", colQty, y - 10, 9, true, gray);
          textRight(page, "Rate", colRate + 40, y - 10, 9, true);
          textRight(page, "Amount", rightX, y - 10, 9, true);
          page.drawLine({ start: { x: L.margin, y: y - L.tableHeaderH + 6 }, end: { x: rightX, y: y - L.tableHeaderH + 6 }, thickness: 0.5, color: gray });
          y -= it.height;
          break;
        case "row": {
          const row = it.row;
          let ly = y - 8;
          row.descriptionLines.forEach((line) => {
            text(page, line, L.margin, ly, L.descSize);
            ly -= L.lineH;
          });
          if (row.detailLine) text(page, row.detailLine, L.margin, ly, 8.5, false, gray);
          text(page, row.quantity, colQty, y - 8, L.textSize);
          textRight(page, row.unitPrice, colRate + 40, y - 8, L.textSize);
          textRight(page, row.total, rightX, y - 8, L.textSize);
          y -= it.height;
          break;
        }
        case "totals": {
          y -= 10;
          const labelX = rightX - 180;
          for (const t of model.totals) {
            textRight(page, t.label, labelX + 100, y, L.textSize, t.bold === true);
            textRight(page, t.value, rightX, y, L.textSize, t.bold === true);
            y -= L.lineH + 2;
          }
          y -= 10;
          break;
        }
        case "sectionLabel":
          text(page, it.text, L.margin, y, 9, true, gray);
          y -= it.height;
          break;
        case "line":
          text(page, it.text, L.margin, y, L.textSize, it.style === "bold", it.style === "gray" ? gray : black);
          y -= it.height;
          break;
      }
    }
    void pageIndex;
  });
}
