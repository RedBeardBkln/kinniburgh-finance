// Page model of the invoice PDF (plan task 1.8, section 9). PURE: given the document content and a text-measuring function it decides
// the wrapped text, the pagination and what goes on which page. The renderer (render.ts) only draws this model with pdf-lib.
//
// The look follows the LaunchTime Solutions invoice template (invoice-template/invoice.template.html): a gold rule across the top, the
// logo and the business block on the left, "INVOICE" and the number / date / terms on the right, "Bill to" and "Project" side by side,
// the item table, the totals ending in a large "Amount due", then "Terms" / "Mail checks to" beside "Bank / ACH details", and the
// footer message centred at the end. Section labels are small upper-case Roboto Slab; body text is Roboto.
//
// Layout rules pinned by tests: the page content is a FLOW of items (bill-to / project rows, the table header, rows, the totals box,
// payment rows, notes, terms, footer lines) paginated by one function. Nothing is ever drawn below the bottom margin:
//  - a row (or any other unit) that does not fit the room left on a page moves to a continuation page, INCLUDING the first table row on
//    page 1 (page 1 may then carry only the header and the bill-to block);
//  - the table header is repeated on every page that has rows;
//  - the last block (totals, payment rows, notes, terms, footer) is kept together: on the current page when it fits, else on a page of
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

/**
 * One cell of a two-column row (bill-to / project, terms / bank details). `label` is a small upper-case section label, `name` the
 * client or project name, `muted` ordinary grey text, `kv` one "Label: value" bank line (`key` is set on its first line only), `space`
 * a blank line between two groups of the same column.
 */
export interface PairCell {
  style: "label" | "name" | "muted" | "kv" | "space";
  text: string;
  key?: string;
}

/** One unit of the page flow, drawn top to bottom in order. `height` is what the paginator reserves for it. */
export type PdfItem =
  | { kind: "gap"; height: number }
  | { kind: "divider"; height: number }
  | { kind: "pair"; left: PairCell | null; right: PairCell | null; height: number }
  | { kind: "tableHead"; height: number }
  | { kind: "row"; row: PdfRow; height: number }
  | { kind: "totals"; height: number }
  | { kind: "sectionLabel"; text: string; height: number }
  | { kind: "line"; text: string; style: "normal" | "thanks"; height: number };

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
  /** Wrapped to the column left of the right-hand block; the first `headerLeftBold` lines are the business name (Roboto Slab). */
  headerLeft: string[];
  headerLeftBold: number;
  /** `valueLines` is `value` wrapped to `headerRightLayout.valueW` (a long value never runs into its label). */
  headerRight: { label: string; value: string; valueLines: string[] }[];
  /** Column geometry of the right-hand block: values are right-aligned at the margin, labels end `valueW + 10` pt to its left. */
  headerRightLayout: { labelW: number; valueW: number };
  /** Wrapped to the bill-to column; the first `billToBold` lines are the client name. */
  billToLines: string[];
  billToBold: number;
  titleLines: string[];
  /** The last entry is the amount still owed ("Amount due", or "Balance due" after a payment); it is drawn large. */
  totals: { label: string; value: string; bold?: boolean }[];
  /** The payment block as plain text (labels end with ":"), for callers and tests; the page draws `payment` in two columns. */
  paymentLines: string[];
  payment: { left: PairCell[]; right: PairCell[]; bankKeyW: number };
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
  rowPad: 8,
  tableHeaderH: 22,
  pageNumberReserve: 0, // the page number sits inside the bottom margin (y = margin - 20)
  contHeaderH: 38,
  descColW: 300,
  descSize: 10,
  textSize: 10,
  /** Small upper-case Roboto Slab labels ("BILL TO", "INVOICE NUMBER", the table header). */
  labelSize: 7.5,
  /**
   * Letter spacing (pt) of those labels and of the title. The template asks for .12em to .18em, but a PDF reader then extracts the text
   * as "I N V O I C E" (pdfjs inserts a space above about .1em), which breaks copy and search; .07em keeps the look and the words.
   */
  labelTrack: 0.55,
  titleTrack: 1.5,
  /** The business name on page 1 and the client / project names. */
  nameSize: 11.5,
  partyNameSize: 12,
  /** The document label at the top right ("INVOICE"). */
  titleSize: 22,
  /** The amount due at the end of the totals. */
  dueSize: 18,
  /** Gap between the two columns of a two-column block; each column is (content width - gap) / 2 wide. */
  colGap: 24,
  /** Width of the totals block at the right margin. */
  totalsW: 225,
  /** Bank-line labels ("Routing #") are at most this wide; a longer label wraps into the value. */
  bankKeyMaxW: 95,
  // A safety valve only: a description is at most 500 characters (validate.ts), at most about 18 lines even in the widest letters,
  // so this is never reached by validated input. If it ever is, the last line ends with "..." (nothing is cut silently).
  maxDescLines: 40,
  headerValueMaxW: 200,
  // Same kind of safety valve for the business block on page 1 (name, dba, 400-character address, EIN): 36 lines keeps that
  // unsplittable block well inside one page. Validated input is far below it; a hit ends the last kept line with "...".
  maxHeaderLeftLines: 36,
};

/** Height of the "INVOICE" title at the top right, above the number / date / terms rows. */
export const TITLE_BLOCK_H = 34;

/** Roboto Slab for labels, names and the large figures; Roboto for body text (`bold` = Roboto Medium); italic for the footer. */
export type Face = "slab" | "italic";
export type Measure = (text: string, size: number, bold?: boolean, face?: Face) => number;

/** Greedy word wrap with a hard break for words wider than the column. Never returns an empty list for non-empty text. */
export function wrapText(text: string, maxWidth: number, size: number, measure: Measure, bold = false, face?: Face): string[] {
  const m = (s: string) => measure(s, size, bold, face);
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
      while (m(w) > maxWidth && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && m(w.slice(0, cut)) > maxWidth) cut -= 1;
        if (current !== "") {
          out.push(current);
          current = "";
        }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const candidate = current === "" ? w : `${current} ${w}`;
      if (m(candidate) <= maxWidth) current = candidate;
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

/** Height of a pair row: a label row is a little taller (air above the text under it), a name row taller still. */
export function pairCellH(cell: PairCell | null): number {
  if (!cell) return 0;
  if (cell.style === "label") return LAYOUT.lineH + 2;
  if (cell.style === "name") return LAYOUT.lineH + 3;
  if (cell.style === "space") return 8;
  return LAYOUT.lineH;
}

/** Height of the totals unit: the gap above, one row per figure, then the rule and the large amount-due row (render.ts draws to it). */
export function totalsBlockH(count: number): number {
  return 10 + Math.max(0, count - 1) * (LAYOUT.lineH + 3) + 28;
}

/** Splits an owner-typed bank line "Routing #: 021000021" into a label and a value; a line without a short label stays whole. */
export function splitBankLine(line: string): { key: string; value: string } | null {
  const m = /^([^:]{1,30}):\s+(\S.*)$/.exec(line.trim());
  return m ? { key: m[1]!.trim(), value: m[2]! } : null;
}

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function buildPdfModel(input: PdfInput, measure: Measure, logoHeight = 0): PdfModel {
  const L = LAYOUT;
  const contentW = L.pageW - L.margin * 2;
  const colW = (contentW - L.colGap) / 2;
  const wrap = (t: string | null, w: number, size = L.textSize, bold = false) => (t && t.trim() !== "" ? wrapText(t, w, size, measure, bold) : []);
  /** One logical line wrapped to `w`; a line that already fits is returned untouched (inner spacing kept). */
  const fit = (t: string, w: number, size = L.textSize, bold = false, face?: Face): string[] =>
    measure(t, size, bold, face) <= w ? [t] : wrapText(t, w, size, measure, bold, face);
  const labelW = (t: string) => measure(t.toUpperCase(), L.labelSize, false, "slab") + L.labelTrack * (t.length - 1);

  // Right-hand block: "INVOICE" on top, then labels in one column and values right-aligned in another; a long value wraps inside its
  // own column.
  const headerRightRaw: { label: string; value: string }[] = [
    { label: `${input.documentLabel} number`, value: input.status === "draft" || !input.displayNumber ? "DRAFT" : input.displayNumber },
    { label: "Issue date", value: input.issueDate ?? "Not issued" },
    { label: "Terms", value: input.dueText },
  ];
  if (input.poNumber) headerRightRaw.push({ label: "PO number", value: input.poNumber });
  const metaLabelW = Math.max(...headerRightRaw.map((r) => labelW(r.label)));
  const valueW = Math.min(Math.max(...headerRightRaw.map((r) => measure(r.value, L.textSize))), L.headerValueMaxW);
  const headerRight: PdfModel["headerRight"] = headerRightRaw.map((r) => ({ ...r, valueLines: fit(r.value, valueW) }));
  const leftW = Math.max(150, contentW - (metaLabelW + 10 + valueW) - 24);

  const nameLines = fit(input.business.name, leftW, L.nameSize, true, "slab");
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

  // Bill to (left) and Project (right, only when the document has a title).
  const billToName = fit(input.billTo.name, colW, L.partyNameSize, true);
  const billToLines = [...billToName, ...input.billTo.addressLines.flatMap((l) => fit(l, colW))];
  const titleLines = wrap(input.title, colW, L.partyNameSize, true);
  const partyLeft: PairCell[] = [{ style: "label", text: "Bill to" }, ...billToLines.map((text, k): PairCell => ({ style: k < billToName.length ? "name" : "muted", text }))];
  const partyRight: PairCell[] = titleLines.length > 0 ? [{ style: "label", text: "Project" }, ...titleLines.map((text): PairCell => ({ style: "name", text }))] : [];

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

  // Payment block: "Terms" and "Mail checks to" in the left column, "Bank / ACH details" in the right one (only when supplied).
  const payLeft: PairCell[] = [{ style: "label", text: "Terms" }, ...fit(input.dueText, colW).map((text): PairCell => ({ style: "muted", text }))];
  const paymentLines: string[] = [`Terms: ${input.dueText}`];
  if (input.remit.mailingLines.length > 0 || input.remit.payableTo) {
    payLeft.push({ style: "space", text: "" }, { style: "label", text: "Mail checks to" });
    paymentLines.push("Mail checks to:");
    for (const l of [...(input.remit.payableTo ? [input.remit.payableTo] : []), ...input.remit.mailingLines]) {
      for (const text of fit(l, colW)) payLeft.push({ style: "muted", text });
      paymentLines.push(`  ${l}`);
    }
  }
  const payRight: PairCell[] = [];
  const bankParts = input.remit.bankLines.map((l) => ({ raw: l, kv: splitBankLine(l) }));
  const bankKeyW = Math.min(L.bankKeyMaxW, Math.max(0, ...bankParts.map((p) => (p.kv ? measure(p.kv.key, L.textSize) : 0))));
  if (bankParts.length > 0) {
    payRight.push({ style: "label", text: "Bank / ACH details" });
    paymentLines.push("Bank / ACH details:");
    for (const p of bankParts) {
      paymentLines.push(`  ${p.raw}`);
      if (p.kv && measure(p.kv.key, L.textSize) <= bankKeyW) {
        fit(p.kv.value, colW - bankKeyW - 10).forEach((text, k) => payRight.push(k === 0 ? { style: "kv", key: p.kv!.key, text } : { style: "kv", text }));
      } else {
        for (const text of fit(p.raw, colW)) payRight.push({ style: "muted", text });
      }
    }
  }

  const notesLines = wrap(input.notes, contentW);
  const termsLines = wrap(input.termsText, contentW);
  const footerLines = input.footerText && input.footerText.trim() !== "" ? wrapText(input.footerText, contentW, L.textSize, measure, false, "italic") : [];

  // Page 1 starts with the unsplittable business / number block; everything below it is a flow of items.
  const leftH = logoHeight + headerLeft.length * L.lineH + 2;
  const rightH = TITLE_BLOCK_H + headerRight.reduce((sum, r) => sum + rightRowH(r), 0);
  const headerBlockH = Math.max(leftH, rightH) + 14;
  const usable = L.pageH - L.margin * 2 - L.pageNumberReserve;
  const freshRoom = usable - L.contHeaderH;
  const totalsH = totalsBlockH(totals.length);

  type Entry = { item: PdfItem; keep?: boolean };
  /** Zips two columns into pair rows; a row holding a label (or a spacer) stays with the row under it. */
  const pairs = (left: PairCell[], right: PairCell[]): Entry[] =>
    Array.from({ length: Math.max(left.length, right.length) }, (_, k) => {
      const l = left[k] ?? null;
      const r = right[k] ?? null;
      const keep = [l, r].some((c) => c !== null && (c.style === "label" || c.style === "space"));
      return { item: { kind: "pair", left: l, right: r, height: Math.max(pairCellH(l), pairCellH(r)) }, keep };
    });

  const entries: Entry[] = [];
  entries.push({ item: { kind: "divider", height: 16 }, keep: true });
  entries.push(...pairs(partyLeft, partyRight));
  entries.push({ item: { kind: "gap", height: 12 }, keep: true });
  for (const row of rows) entries.push({ item: { kind: "row", row, height: row.height } });

  const lastBlock: Entry[] = [{ item: { kind: "totals", height: totalsH } }];
  lastBlock.push({ item: { kind: "gap", height: 10 }, keep: true }, { item: { kind: "divider", height: 16 }, keep: true });
  lastBlock.push(...pairs(payLeft, payRight));
  const section = (label: string | null, lines: string[], gap: number, style: "normal" | "thanks") => {
    if (lines.length === 0) return;
    lastBlock.push({ item: { kind: "gap", height: gap }, keep: true });
    if (label) lastBlock.push({ item: { kind: "sectionLabel", text: label, height: L.lineH + 2 }, keep: true });
    for (const text of lines) lastBlock.push({ item: { kind: "line", text, style, height: L.lineH } });
  };
  section("Notes", notesLines, 12, "normal");
  section("Terms and conditions", termsLines, 12, "normal");
  section(null, footerLines, 18, "thanks");
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
    // A row that starts a table segment on this page is preceded by the (repeated) table header, after any gap that leads the group.
    const withHead = (g: PdfItem[]): PdfItem[] => {
      const at = g.findIndex((it) => it.kind !== "gap");
      return at >= 0 && g[at]!.kind === "row" && !hasHead ? [...g.slice(0, at), headItem, ...g.slice(at)] : g;
    };
    let placed = withHead(group);
    // Page 1 may be left with only its header; a continuation page is never left empty (the group is placed even if too tall).
    const canBreak = cur.items.length > 0 || pages.length === 0;
    // The last block stays together when it fits one page: move all of it to a fresh page rather than splitting it.
    const keepLastTogether = group[0]!.kind === "totals" && lastBlockH > room && lastBlockH <= freshRoom;
    if ((sum(placed) > room || keepLastTogether) && canBreak) {
      startPage();
      // A gap or divider at the top of a page is dropped.
      while (group.length > 0 && (group[0]!.kind === "gap" || group[0]!.kind === "divider")) group = group.slice(1);
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
    headerRightLayout: { labelW: metaLabelW, valueW },
    billToLines,
    billToBold: billToName.length,
    titleLines,
    totals,
    paymentLines,
    payment: { left: payLeft, right: payRight, bankKeyW },
    notesLines,
    termsLines,
    footerLines,
    watermark: input.status === "void" ? "VOID" : input.status === "draft" ? "DRAFT" : null,
  };
}
