// Per-page DRAFT footer stamp (decision E1). It is page CONTENT, not a form field,
// so fields stay editable and the official form is not altered. A 6-pt grey line in
// the bottom margin of every page. The printed IRS footer sits above ~20 pt; this is
// drawn at 7 pt above the media-box bottom. (Visual confirmation per form is a live
// check, plan section 11.)

import { rgb, type PDFDocument, type PDFFont } from "pdf-lib";
import { sanitizeWinAnsi } from "@/lib/tax2025/pdf/winansi";

export const STAMP_FONT_SIZE = 6;
export const STAMP_BOTTOM_OFFSET = 7;
export const STAMP_LEFT_OFFSET = 36;

export function draftStampText(stampDate: string, fingerprint12: string): string {
  return `DRAFT computed by Banana Stand for CPA review - not filed - ${stampDate} - fp ${fingerprint12}`;
}

export const ALTERNATIVE_STAMP_TEXT = "ALTERNATIVE - not included in return totals";

/** Draw `text` at the bottom of every page of `doc`. */
export function stampPages(doc: PDFDocument, font: PDFFont, text: string): void {
  const safe = sanitizeWinAnsi(text);
  for (const page of doc.getPages()) {
    const box = page.getMediaBox();
    page.drawText(safe, {
      x: box.x + STAMP_LEFT_OFFSET,
      y: box.y + STAMP_BOTTOM_OFFSET,
      size: STAMP_FONT_SIZE,
      font,
      color: rgb(0.45, 0.45, 0.45),
    });
  }
}
