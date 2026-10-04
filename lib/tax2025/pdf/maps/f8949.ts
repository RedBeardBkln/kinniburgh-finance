// Field-to-line map for Form 8949 (TY2025). All 202 AcroForm fields of the blank are claimed exactly once
// (completeness test): the two Part box checkbox groups, 2 x 11 rows x 8 cells, the two Totals rows, the
// names, and explicit blanks (SSN, the unused (f) cell of each Totals row).
//
// What the packet files, and why this form needs COPIES:
//   - One sheet carries ONE box per Part (the checkboxes are a choice), so every (information return, box)
//     category the engine routes through Form 8949 needs its own sheet (Part I boxes A B C G H I, Part II
//     boxes D E F J K L). A Part I box and a Part II box share one sheet when both exist (page 1 holds the
//     short-term box, page 2 the long-term box); the unused page of a sheet is left blank and the cover says so.
//   - The rows are the engine's Exception 2 summary rows (one per broker per box: "<broker> - see attached
//     statement", code M, plus W with wash sales, columns (b) and (c) blank). Never one row per transaction.
//   - More than 11 rows in one box continue on another sheet of the same box (IRS: use as many Forms 8949 as
//     needed). The "Other (see statement)" summary-row overflow of the other tables is NOT valid here: the IRS
//     forbids a summary total without the statement, so MapTable.overflow is "none" and `copies` splits instead.
//   - Totals row: when a box fits on one sheet the Totals are the engine's own Schedule D line totals (the
//     numbers that go to lines 1b / 2 / 3 / 8b / 9 / 10, rounded once from cents); when a box spans sheets each
//     sheet's Totals are the sums of the whole-dollar rows printed on it (the adapter raises an advisory item
//     when printed rows and the Schedule D line differ by rounding).
//   - Lines 1a / 8a of Schedule D (clean category, basis reported, no adjustment) never come here.
//
// Field names are the full AcroForm names from data/forms/2025/catalog/f8949.fields.json.

import {
  F8949_BOX_CELL,
  F8949_PART_I_ANSWER,
  F8949_PART_II_ANSWER,
  F8949_PART_I_BOXES,
  F8949_PART_II_BOXES,
  F8949_ROWS_PER_PAGE,
  F8949_ROW_COLUMNS,
  F8949_TOTAL_COLUMNS,
  f8949RowField,
  f8949TotalField,
  type F8949Part,
} from "@/lib/tax2025/pdf/f8949-layout";
import type {
  FormCopy,
  FormMap,
  MapBlank,
  MapLine,
  MapTable,
  PdfReturnView,
  PdfTableRow,
  TableKey,
} from "@/lib/tax2025/pdf/types";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";

function rowTable(part: F8949Part, table: TableKey): MapTable {
  const rows: Array<Record<string, string>> = [];
  for (let r = 1; r <= F8949_ROWS_PER_PAGE; r++) {
    const row: Record<string, string> = {};
    for (const c of F8949_ROW_COLUMNS) row[c] = f8949RowField(part, r, c);
    rows.push(row);
  }
  return { table, rows, amountColumn: "d", labelColumn: "a", overflow: "none" };
}

function totalsTable(part: F8949Part, table: TableKey): MapTable {
  const row: Record<string, string> = {};
  for (const c of F8949_TOTAL_COLUMNS) row[c] = f8949TotalField(part, c);
  return { table, rows: [row], amountColumn: "d", labelColumn: "d", overflow: "none" };
}

const boxLines = (field: (i: number) => string, choice: string, boxes: readonly string[]): MapLine[] =>
  boxes.map((box, i): MapLine => ({ kind: "check", field: field(i), choice, equals: box }));

const lines: MapLine[] = [
  ...boxLines((i) => `${P1}c1_1[${i}]`, F8949_PART_I_ANSWER, F8949_PART_I_BOXES),
  ...boxLines((i) => `${P2}c2_1[${i}]`, F8949_PART_II_ANSWER, F8949_PART_II_BOXES),
];

const blank: MapBlank[] = [
  { field: `${P1}f1_02[0]`, reason: "ssn" },
  { field: `${P2}f2_02[0]`, reason: "ssn" },
  // Each Totals row also has a cell under column (f): the form does not total codes.
  { field: f8949TotalField("I", "f"), reason: "form_na" },
  { field: f8949TotalField("II", "f"), reason: "form_na" },
];

// ── Copies ────────────────────────────────────────────────────────────────────

interface Sheet {
  box: string;
  rows: PdfTableRow[];
  totals: PdfTableRow;
  /** 1-based page of this box and how many pages the box needs. */
  page: number;
  pages: number;
}

function sumCells(rows: readonly PdfTableRow[], column: string): number | null {
  let total = 0;
  let any = false;
  for (const r of rows) {
    const v = r.cells[column];
    if (typeof v === "number") {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

/** Group a part's rows by box (in checkbox order) and cut each box into sheets of at most 11 rows. */
function sheetsOf(
  part: F8949Part,
  rows: readonly PdfTableRow[] | undefined,
  totals: readonly PdfTableRow[] | undefined,
  order: readonly string[],
): Sheet[] {
  const byBox = new Map<string, PdfTableRow[]>();
  for (const r of rows ?? []) {
    const box = r.cells[F8949_BOX_CELL];
    if (typeof box !== "string" || !order.includes(box)) {
      throw new Error(`Form 8949 Part ${part}: a row has box "${String(box)}", which is not a Part ${part} box`);
    }
    byBox.set(box, [...(byBox.get(box) ?? []), r]);
  }
  const out: Sheet[] = [];
  for (const box of order) {
    const all = byBox.get(box);
    if (all === undefined || all.length === 0) continue;
    const pages = Math.ceil(all.length / F8949_ROWS_PER_PAGE);
    const given = (totals ?? []).find((t) => t.cells[F8949_BOX_CELL] === box);
    for (let p = 0; p < pages; p++) {
      const chunk = all.slice(p * F8949_ROWS_PER_PAGE, (p + 1) * F8949_ROWS_PER_PAGE);
      const cells: Record<string, string | number | null> = { [F8949_BOX_CELL]: box };
      for (const c of F8949_TOTAL_COLUMNS) {
        // One sheet: the engine's own Schedule D line total. Several sheets: this sheet's own sum (a blank zero stays blank).
        const sum = sumCells(chunk, c);
        cells[c] = pages === 1 && given !== undefined ? (given.cells[c] ?? null) : c === "g" && sum === 0 ? null : sum;
      }
      out.push({ box, rows: chunk, totals: { cells }, page: p + 1, pages });
    }
  }
  return out;
}

function describe(part: F8949Part, s: Sheet | undefined): string {
  if (s === undefined) return `Part ${part} not used (left blank)`;
  const n = s.rows.length;
  const where = s.pages > 1 ? `, sheet ${s.page} of ${s.pages} for this box` : "";
  return `Part ${part} box ${s.box} (${n} summary row${n === 1 ? "" : "s"}${where})`;
}

/** One sheet per Part I box page paired with one per Part II box page (page 1 = short-term, page 2 = long-term). */
export function f8949Copies(view: PdfReturnView): FormCopy[] {
  const one = sheetsOf("I", view.tables["f8949.partI"], view.tables["f8949.totalsI"], F8949_PART_I_BOXES);
  const two = sheetsOf("II", view.tables["f8949.partII"], view.tables["f8949.totalsII"], F8949_PART_II_BOXES);
  const n = Math.max(one.length, two.length);
  const copies: FormCopy[] = [];
  for (let i = 0; i < n; i++) {
    const a = one[i];
    const b = two[i];
    const answers: Record<string, string> = {};
    if (a) answers[F8949_PART_I_ANSWER] = a.box;
    if (b) answers[F8949_PART_II_ANSWER] = b.box;
    copies.push({
      suffix: `${(a?.box ?? "").toLowerCase()}${(b?.box ?? "").toLowerCase()}-${i + 1}`,
      label: `${describe("I", a)}; ${describe("II", b)}`,
      answers,
      tables: {
        "f8949.partI": a ? a.rows : [],
        "f8949.totalsI": a ? [a.totals] : [],
        "f8949.partII": b ? b.rows : [],
        "f8949.totalsII": b ? [b.totals] : [],
      },
    });
  }
  return copies;
}

export const f8949Map: FormMap = {
  formId: "f8949",
  engineFormId: "f8949",
  lines,
  tables: [
    rowTable("I", "f8949.partI"),
    totalsTable("I", "f8949.totalsI"),
    rowTable("II", "f8949.partII"),
    totalsTable("II", "f8949.totalsII"),
  ],
  header: [
    { field: `${P1}f1_01[0]`, source: "household.names" },
    { field: `${P2}f2_01[0]`, source: "household.names" },
  ],
  blank,
  copies: f8949Copies,
};
