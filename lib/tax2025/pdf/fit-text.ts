// Fit a text value into a fixed-size PDF text field without clipping it (ty2025-ct1040-derived-lines, step 8).
//
// Two printed cells overflowed their boxes:
//   - Form 8949 column (a): the summary row `${broker} - see attached statement` is wrapped by the viewer inside a
//     136 pt x 24 pt multi-line box; at the form's 8 pt only TWO lines are visible (pdf.js clips the third at every size
//     from 8 pt down to 6.5 pt), so the full 81-character Robinhood description lost its tail.
//   - CT-1040 Schedule 3 description: a 148 pt single-line box clipped "27 OLD BARRY ROAD, WATERFORD, CT 06385".
//
// The fix is deterministic and never silent: try the full text at the form's own size first, then smaller sizes, then a
// recognisable shortening (drop the " as agent for <x>" clause of a broker name; keep the street part of an address),
// and as the last resort truncate on a word boundary with "...". The caller adds an advisory open item with the FULL
// text whenever the printed text differs from it, so the cover keeps what the cell cannot show.
//
// Pure given a font: metrics come from the embedded Helvetica (`widthOfTextAtSize`), line breaking from pdf-lib's own
// `layoutMultilineText`, the same function the field appearance uses, so what is measured is what is drawn.

import { TextAlignment, layoutMultilineText, type PDFFont } from "pdf-lib";

/** The kinds of cell the map can ask to be fitted. */
export type FitKind = "broker_name" | "address";

export interface FitResult {
  /** The text to write. */
  text: string;
  /** The font size to draw it at (points). */
  fontSize: number;
  /** Number of lines it takes at that size and width. */
  lines: number;
  /** The text differs from the one asked for (shortened or truncated): the full text must be kept elsewhere. */
  changed: boolean;
  /** The text was cut with "..." (the last resort). */
  truncated: boolean;
}

/** One candidate: a head (the part that may be trimmed) and a tail (kept whole), tried at each size in order. */
export interface FitAttempt {
  head: string;
  tail: string;
  sizes: readonly number[];
}

export interface FitOptions {
  /** Width of the field rectangle in points. */
  fieldWidth: number;
  /** Most lines that are fully visible in the field. */
  maxLines: number;
  /** pdf-lib pads the text 1 pt on each side. */
  padding?: number;
}

/** Lines a text takes at `size` inside `fieldWidth` (the same layout call the field appearance makes). */
export function lineCount(font: PDFFont, text: string, size: number, fieldWidth: number, padding = 1): number {
  const width = fieldWidth - 2 * padding;
  // The bounds height is irrelevant to the line breaking.
  const layout = layoutMultilineText(text, { alignment: TextAlignment.Left, font, fontSize: size, bounds: { x: 0, y: 0, width, height: 1000 } });
  return layout.lines.length;
}

function truncateHead(font: PDFFont, head: string, tail: string, size: number, o: FitOptions): string {
  const words = head.trim().split(/\s+/);
  while (words.length > 1) {
    words.pop();
    const candidate = `${words.join(" ")}...${tail}`;
    if (lineCount(font, candidate, size, o.fieldWidth, o.padding) <= o.maxLines) return candidate;
  }
  // One word left: cut characters.
  let chars = (words[0] ?? "").length;
  while (chars > 1) {
    chars -= 1;
    const candidate = `${(words[0] ?? "").slice(0, chars)}...${tail}`;
    if (lineCount(font, candidate, size, o.fieldWidth, o.padding) <= o.maxLines) return candidate;
  }
  return `...${tail}`;
}

/** Try each attempt at each of its sizes, in order; fall back to truncating the last attempt's head at its smallest size. */
export function fitText(font: PDFFont, original: string, attempts: readonly FitAttempt[], o: FitOptions): FitResult {
  for (const a of attempts) {
    const text = `${a.head}${a.tail}`;
    for (const size of a.sizes) {
      const lines = lineCount(font, text, size, o.fieldWidth, o.padding);
      if (lines <= o.maxLines) return { text, fontSize: size, lines, changed: text !== original, truncated: false };
    }
  }
  const last = attempts[attempts.length - 1];
  if (last === undefined) return { text: original, fontSize: 8, lines: lineCount(font, original, 8, o.fieldWidth, o.padding), changed: false, truncated: false };
  const size = last.sizes[last.sizes.length - 1] ?? 8;
  const text = truncateHead(font, last.head, last.tail, size, o);
  return { text, fontSize: size, lines: lineCount(font, text, size, o.fieldWidth, o.padding), changed: true, truncated: true };
}

// ── The two cell kinds ──────────────────────────────────────────────────────────

export const SEE_STATEMENT_TAIL = " - see attached statement";
/** The tail of an agent clause in a payer name: "Robinhood Markets Inc as agent for Robinhood Securities LLC". */
const AGENT_CLAUSE = /\s+as agent for\b.*$/i;

/** Form 8949 column (a): the box holds two visible lines at 8 pt. */
export const BROKER_FIT = { maxLines: 2, fullSizes: [8, 7.5, 7], shortSizes: [8, 7.5, 7, 6.5, 6] } as const;
/** CT-1040 Schedule 3 description: a single line. */
export const ADDRESS_FIT = { maxLines: 1, fullSizes: [8, 7.5, 7, 6.5], streetSizes: [8, 6.5] } as const;

/** The broker name of a 8949 summary cell: everything before " - see attached statement" (the whole text when it has no such tail). */
function splitBroker(text: string): { head: string; tail: string } {
  return text.endsWith(SEE_STATEMENT_TAIL) ? { head: text.slice(0, -SEE_STATEMENT_TAIL.length), tail: SEE_STATEMENT_TAIL } : { head: text, tail: "" };
}

export function brokerAttempts(text: string): FitAttempt[] {
  const { head, tail } = splitBroker(text);
  const attempts: FitAttempt[] = [{ head, tail, sizes: BROKER_FIT.fullSizes }];
  const short = head.replace(AGENT_CLAUSE, "").trim();
  if (short !== "" && short !== head) attempts.push({ head: short, tail, sizes: BROKER_FIT.shortSizes });
  else attempts.push({ head, tail, sizes: BROKER_FIT.shortSizes });
  return attempts;
}

export function addressAttempts(text: string): FitAttempt[] {
  const attempts: FitAttempt[] = [{ head: text, tail: "", sizes: ADDRESS_FIT.fullSizes }];
  const street = (text.split(",")[0] ?? "").trim();
  if (street !== "" && street !== text) attempts.push({ head: street, tail: "", sizes: ADDRESS_FIT.streetSizes });
  else attempts.push({ head: text, tail: "", sizes: ADDRESS_FIT.streetSizes });
  return attempts;
}

/** Fit `text` into a field of `fieldWidth` points as the given kind of cell. */
export function fitCell(font: PDFFont, kind: FitKind, text: string, fieldWidth: number): FitResult {
  if (kind === "broker_name") return fitText(font, text, brokerAttempts(text), { fieldWidth, maxLines: BROKER_FIT.maxLines });
  return fitText(font, text, addressAttempts(text), { fieldWidth, maxLines: ADDRESS_FIT.maxLines });
}
