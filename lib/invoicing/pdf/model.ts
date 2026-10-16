// Page model of the invoice PDF (plan task 1.8, section 9). PURE: given the document content and a text-measuring function it decides
// the wrapped text, the pagination and what goes on which page. The renderer (render.ts) only draws this model with pdf-lib.
//
// Layout rules pinned by tests: the page content is a FLOW of items (bill-to lines, title lines, the table header, rows, the totals
// box, payment lines, notes, terms, footer lines) paginated by one function. Nothing is ever drawn below the bottom margin:
//  - a row (or any other unit) that does not fit the room left on a page moves to a continuation page, INCLUDING the first table row on
//    page 1 (page 1 may then carry only the header and the bill-to block);
//  - the table header is repeated on every page that has rows;
//  - the last block (totals, payment lines, notes, terms, footer) is kept together: on the current page when it fits, else on a page of
//    its own when it fits one page, so in ordinary use the totals are on the last page;
//  - a last block taller than a whole page (notes, terms and footer near their 2,000-character caps) flows line by line onto
//    continuation pages (a section label never ends a page alone), so the totals are then on the page where the block starts;
//  - every page is numbered.

export interface PdfLine {
  description: string;
  /** Exact decimal text, e.g. "7.25". */
  quantity: string;
  unit: string | null;
  unitPriceCents: number;
  /** Text such as "10% off" or "$5.00 off", or null. */
  discountText: string | null;
  totalCents: number;
  workDate: string | null;
}

export interface PdfInput {
  /** "draft" renders a DRAFT watermark and no number; "void" renders a diagonal VOID. */
  status: "draft" | "issued" | "void";
  displayNumber: string | null;
  title: string | null;
  poNumber: string | null;
  business: { name: string; dbaName: string | null; addressLines: string[]; einText: string | null };
  billTo: { name: string; addressLines: string[] };
  issueDate: string | null;
  /** The printed payment terms (for example "Due upon receipt") or a due date when terms have days. */
  dueText: string;
  lines: PdfLine[];
  subtotalCents: number;
  discountCents: number;
  discountLabel: string | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  notes: string | null;
  termsText: string | null;
  footerText: string | null;
  remit: { payableTo: string | null; mailingLines: string[]; bankLines: string[] };
  /** "Invoice" for now; quotes reuse the model later (task 1.11). */
  documentLabel: string;
}

export interface PdfRow {
  descriptionLines: string[];
  quantity: string;
  unitPrice: string;
  total: string;
  detailLine: string | null;
  height: number;
}

/** One unit of the page flow, drawn top to bottom in order. `height` is what the paginator reserves for it. */
export type PdfItem =
  | { kind: "gap"; height: number }
  | { kind: "billLabel"; height: number }
  | { kind: "billLine"; text: string; bold: boolean; height: number }
  | { kind: "titleLine"; text: string; height: number }
  | { kind: "tableHead"; height: number }
  | { kind: "row"; row: PdfRow; height: number }
  | { kind: "totals"; height: number }
  | { kind: "sectionLabel"; text: string; height: number }
  | { kind: "line"; text: string; style: "normal" | "bold" | "gray"; height: number };

export interface PdfPage {
  items: PdfItem[];
  /** The rows of `items`, in order (kept for callers that only need the table). */
  rows: PdfRow[];
  /** Page 1 only: the business / number block (and the logo). */
  showFullHeader: boolean;
  /** The totals box is on this page. */
  showTotals: boolean;
}

export interface PdfModel {
  pages: PdfPage[];
  /** Height reserved for the business / number block on page 1 (the flow items of page 1 must fit in the rest of the page). */
  headerBlockH: number;
  /** Wrapped to the column left of the right-hand block; the first `headerLeftBold` lines are the (bold, 12 pt) business name. */
  headerLeft: string[];
  headerLeftBold: number;
  /** `valueLines` is `value` wrapped to `headerRightLayout.valueW` (a long value never runs into its label). */
  headerRight: { label: string; value: string; valueLines: string[] }[];
  /** Column geometry of the right-hand block: values are right-aligned at the margin, labels end `valueW + 10` pt to its left. */
  headerRightLayout: { labelW: number; valueW: number };
  /** Wrapped to the page width; the first `billToBold` lines are the client name. */
  billToLines: string[];
  billToBold: number;
  titleLines: string[];
  totals: { label: string; value: string; bold?: boolean }[];
  paymentLines: string[];
  notesLines: string[];
  termsLines: string[];
  footerLines: string[];
  watermark: "DRAFT" | "VOID" | null;
}

export const LAYOUT = {
  pageW: 612,
  pageH: 792,
  margin: 54,
  lineH: 13,
  rowPad: 6,
  tableHeaderH: 22,
  pageNumberReserve: 0, // the page number sits inside the bottom margin (y = margin - 20)
  contHeaderH: 38,
  descColW: 300,
  descSize: 10,
  textSize: 10,
  // A safety valve only: a description is at most 500 characters (validate.ts), at most about 18 lines even in the widest letters,
  // so this is never reached by validated input. If it ever is, the last line ends with "..." (nothing is cut silently).
  maxDescLines: 40,
  headerValueMaxW: 200,
  // Same kind of safety valve for the business block on page 1 (name, dba, 400-character address, EIN): 36 lines keeps that
  // unsplittable block well inside one page. Validated input is far below it; a hit ends the last kept line with "...".
  maxHeaderLeftLines: 36,
};

export type Measure = (text: string, size: number, bold?: boolean) => number;

/** Greedy word wrap with a hard break for words wider than the column. Never returns an empty list for non-empty text. */
export function wrapText(text: string, maxWidth: number, size: number, measure: Measure, bold = false): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      let w = word;
      // Hard-break a single over-long word.
      while (measure(w, size, bold) > maxWidth && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && measure(w.slice(0, cut), size, bold) > maxWidth) cut -= 1;
        if (current !== "") {
          out.push(current);
          current = "";
        }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const candidate = current === "" ? w : `${current} ${w}`;
      if (measure(candidate, size, bold) <= maxWidth) current = candidate;
      else {
        if (current !== "") out.push(current);
        current = w;
      }
    }
    if (current !== "") out.push(current);
  }
  return out.length > 0 ? out : [""];
}

/** Height of one right-hand header row: its wrapped value lines plus a little air between rows. */
export function rightRowH(row: { valueLines: string[] }): number {
  return Math.max(1, row.valueLines.length) * LAYOUT.lineH + LAYOUT.lineH * 0.4;
}

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function buildPdfModel(input: PdfInput, measure: Measure, logoHeight = 0): PdfModel {
  const L = LAYOUT;
  const contentW = L.pageW - L.margin * 2;
  const wrap = (t: string | null, w: number, size = L.textSize, bold = false) => (t && t.trim() !== "" ? wrapText(t, w, size, measure, bold) : []);
  /** One logical line wrapped to `w`; a line that already fits is returned untouched (inner spacing kept). */
  const fit = (t: string, w: number, size = L.textSize, bold = false): string[] => (measure(t, size, bold) <= w ? [t] : wrapText(t, w, size, measure, bold));

  // Right-hand block: labels in one column, values right-aligned in another, a long value wraps inside its own column.
  const headerRightRaw: { label: string; value: string }[] = [
    { label: `${input.documentLabel} number`, value: input.status === "draft" || !input.displayNumber ? "DRAFT" : input.displayNumber },
    { label: "Issue date", value: input.issueDate ?? "Not issued" },
    { label: "Terms", value: input.dueText },
  ];
  if (input.poNumber) headerRightRaw.push({ label: "PO number", value: input.poNumber });
  const labelW = Math.max(...headerRightRaw.map((r) => measure(`${r.label}:`, 9)));
  const valueW = Math.min(Math.max(...headerRightRaw.map((r) => measure(r.value, L.textSize, true))), L.headerValueMaxW);
  const headerRight: PdfModel["headerRight"] = headerRightRaw.map((r) => ({ ...r, valueLines: fit(r.value, valueW, L.textSize, true) }));
  const leftW = Math.max(150, contentW - (labelW + 10 + valueW) - 24);

  const nameLines = fit(input.business.name, leftW, 12, true);
  const headerLeft = [
    ...nameLines,
    ...[...(input.business.dbaName ? [`dba ${input.business.dbaName}`] : []), ...input.business.addressLines, ...(input.business.einText ? [`EIN ${input.business.einText}`] : [])].flatMap((l) => fit(l, leftW)),
  ];
  if (headerLeft.length > L.maxHeaderLeftLines) {
    headerLeft.length = L.maxHeaderLeftLines;
    let last = headerLeft[L.maxHeaderLeftLines - 1]!;
    while (last.length > 0 && measure(`${last}...`, L.textSize) > leftW) last = last.slice(0, -1);
    headerLeft[L.maxHeaderLeftLines - 1] = `${last}...`;
  }
  const billToName = fit(input.billTo.name, contentW, L.textSize, true);
  const billToLines = [...billToName, ...input.billTo.addressLines.flatMap((l) => fit(l, contentW))];
  const titleLines = wrap(input.title, contentW, 12, true);

  const rows: PdfRow[] = input.lines.map((l) => {
    let descLines = wrapText(l.description, L.descColW, L.descSize, measure);
    if (descLines.length > L.maxDescLines) {
      // Never cut silently: keep the first lines and end the last kept one with a visible ellipsis.
      descLines = descLines.slice(0, L.maxDescLines);
      let last = descLines[L.maxDescLines - 1]!;
      while (last.length > 0 && measure(`${last}...`, L.descSize) > L.descColW) last = last.slice(0, -1);
      descLines[L.maxDescLines - 1] = `${last}...`;
    }
    const detailParts: string[] = [];
    if (l.workDate) detailParts.push(`Work date ${l.workDate}`);
    if (l.discountText) detailParts.push(l.discountText);
    const detail = detailParts.length > 0 ? detailParts.join("  |  ") : null;
    const height = (descLines.length + (detail ? 1 : 0)) * L.lineH + L.rowPad;
    return {
      descriptionLines: descLines,
      quantity: `${l.quantity}${l.unit ? ` ${l.unit}` : ""}`,
      unitPrice: money(l.unitPriceCents),
      total: money(l.totalCents),
      detailLine: detail,
      height,
    };
  });

  const totals: PdfModel["totals"] = [{ label: "Subtotal", value: money(input.subtotalCents) }];
  if (input.discountCents > 0) totals.push({ label: input.discountLabel ?? "Discount", value: `-${money(input.discountCents)}` });
  totals.push({ label: "Total", value: money(input.totalCents), bold: true });
  if (input.paidCents > 0) totals.push({ label: "Paid", value: `-${money(input.paidCents)}` });
  totals.push({ label: input.paidCents > 0 ? "Balance due" : "Amount due", value: money(input.balanceCents), bold: true });

  const paymentLines: string[] = [];
  /** Wraps one payment-block line to the page width; an indented line keeps its two-space indent on every wrapped line. */
  const pushPayment = (line: string) => {
    if (measure(line, L.textSize) <= contentW) {
      paymentLines.push(line);
      return;
    }
    const indented = line.startsWith("  ");
    wrapText(indented ? line.slice(2) : line, contentW - measure("  ", L.textSize), L.textSize, measure).forEach((l, i) => paymentLines.push(indented || i > 0 ? `  ${l}` : l));
  };
  pushPayment(`Terms: ${input.dueText}`);
  if (input.remit.mailingLines.length > 0 || input.remit.payableTo) {
    pushPayment("Mail checks to:");
    if (input.remit.payableTo) pushPayment(`  ${input.remit.payableTo}`);
    for (const l of input.remit.mailingLines) pushPayment(`  ${l}`);
  }
  if (input.remit.bankLines.length > 0) {
    pushPayment("Bank / ACH details:");
    for (const l of input.remit.bankLines) pushPayment(`  ${l}`);
  }
  const notesLines = wrap(input.notes, contentW);
  const termsLines = wrap(input.termsText, contentW);
  const footerLines = wrap(input.footerText, contentW);

  // Page 1 starts with the unsplittable business / number block; everything below it is a flow of items.
  const leftH = headerLeft.length * L.lineH;
  const rightH = headerRight.reduce((sum, r) => sum + rightRowH(r), 0);
  const headerBlockH = 26 + logoHeight + Math.max(leftH, rightH) + 18;
  const usable = L.pageH - L.margin * 2 - L.pageNumberReserve;
  const freshRoom = usable - L.contHeaderH;
  const totalsH = 10 + totals.length * (L.lineH + 2) + 10;

  type Entry = { item: PdfItem; keep?: boolean };
  const entries: Entry[] = [];
  entries.push({ item: { kind: "billLabel", height: L.lineH }, keep: true });
  billToLines.forEach((text, k) => entries.push({ item: { kind: "billLine", text, bold: k < billToName.length, height: L.lineH } }));
  entries.push({ item: { kind: "gap", height: 6 }, keep: true });
  titleLines.forEach((text) => entries.push({ item: { kind: "titleLine", text, height: 15 } }));
  if (titleLines.length > 0) entries.push({ item: { kind: "gap", height: 8 }, keep: true });
  for (const row of rows) entries.push({ item: { kind: "row", row, height: row.height } });

  const lastBlock: Entry[] = [{ item: { kind: "totals", height: totalsH } }];
  for (const text of paymentLines) lastBlock.push({ item: { kind: "line", text, style: text.endsWith(":") && !text.startsWith(" ") ? "bold" : "normal", height: L.lineH } });
  const section = (label: string | null, lines: string[], gap: number, style: "normal" | "gray") => {
    if (lines.length === 0) return;
    lastBlock.push({ item: { kind: "gap", height: gap }, keep: true });
    if (label) lastBlock.push({ item: { kind: "sectionLabel", text: label, height: L.lineH }, keep: true });
    for (const text of lines) lastBlock.push({ item: { kind: "line", text, style, height: L.lineH } });
  };
  section("Notes", notesLines, 8, "normal");
  section("Terms", termsLines, 8, "normal");
  section(null, footerLines, 12, "gray");
  entries.push(...lastBlock);
  const lastBlockH = lastBlock.reduce((sum, en) => sum + en.item.height, 0);

  const sum = (items: readonly PdfItem[]) => items.reduce((t, it) => t + it.height, 0);
  const headItem: PdfItem = { kind: "tableHead", height: L.tableHeaderH };
  const pages: PdfPage[] = [];
  let cur: PdfPage = { items: [], rows: [], showFullHeader: true, showTotals: false };
  let room = usable - headerBlockH;
  let hasHead = false;
  const startPage = () => {
    pages.push(cur);
    cur = { items: [], rows: [], showFullHeader: false, showTotals: false };
    room = freshRoom;
    hasHead = false;
  };
  let e = 0;
  while (e < entries.length) {
    // A group is an entry plus the entries it must stay with (a section label and its first line, a gap and what follows it).
    let group: PdfItem[] = [];
    for (;;) {
      group.push(entries[e]!.item);
      if (entries[e]!.keep && e + 1 < entries.length) e += 1;
      else break;
    }
    e += 1;
    const first = group[0]!;
    // A row that starts a table segment on this page is preceded by the (repeated) table header, after any gap that leads the group.
    const withHead = (g: PdfItem[]): PdfItem[] => {
      const at = g.findIndex((it) => it.kind !== "gap");
      return at >= 0 && g[at]!.kind === "row" && !hasHead ? [...g.slice(0, at), headItem, ...g.slice(at)] : g;
    };
    let placed = withHead(group);
    // Page 1 may be left with only its header; a continuation page is never left empty (the group is placed even if too tall).
    const canBreak = cur.items.length > 0 || pages.length === 0;
    // The last block stays together when it fits one page: move all of it to a fresh page rather than splitting it.
    const keepLastTogether = first.kind === "totals" && lastBlockH > room && lastBlockH <= freshRoom;
    if ((sum(placed) > room || keepLastTogether) && canBreak) {
      startPage();
      // A gap at the top of a page is dropped.
      while (group.length > 0 && group[0]!.kind === "gap") group = group.slice(1);
      placed = withHead(group);
    }
    for (const it of placed) {
      cur.items.push(it);
      if (it.kind === "row") cur.rows.push(it.row);
      if (it.kind === "totals") cur.showTotals = true;
      if (it.kind === "tableHead" || it.kind === "row") hasHead = true;
    }
    room -= sum(placed);
  }
  pages.push(cur);

  return {
    pages,
    headerBlockH,
    headerLeft,
    headerLeftBold: nameLines.length,
    headerRight,
    headerRightLayout: { labelW, valueW },
    billToLines,
    billToBold: billToName.length,
    titleLines,
    totals,
    paymentLines,
    notesLines,
    termsLines,
    footerLines,
    watermark: input.status === "void" ? "VOID" : input.status === "draft" ? "DRAFT" : null,
  };
}
