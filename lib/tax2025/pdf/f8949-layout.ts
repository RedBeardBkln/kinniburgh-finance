// Layout constants of the 2025 Form 8949 shared by the adapter (which builds the table rows) and
// maps/f8949.ts (which maps the fields and splits the rows over copies). Pure; no engine types.
//
// The blank has two pages, each with 11 transaction rows of 8 fields and a Totals row:
//   Part I  (page 1): boxes A B C G H I  = checkboxes c1_1[0..5]; rows f1_03..f1_90; totals f1_91..f1_95
//   Part II (page 2): boxes D E F J K L  = checkboxes c2_1[0..5]; rows f2_03..f2_90; totals f2_91..f2_95
// Row columns, in field order: (a) description, (b) date acquired, (c) date sold, (d) proceeds, (e) cost or
// other basis, (f) code(s), (g) amount of adjustment, (h) gain or (loss). The Totals row has five cells in the
// same order as (d) (e) (f) (g) (h); (f) is not totalled and is never filled.

export const F8949_ROWS_PER_PAGE = 11;

/** Checkbox order of Part I: c1_1[0] .. c1_1[5]. */
export const F8949_PART_I_BOXES = ["A", "B", "C", "G", "H", "I"] as const;
/** Checkbox order of Part II: c2_1[0] .. c2_1[5]. */
export const F8949_PART_II_BOXES = ["D", "E", "F", "J", "K", "L"] as const;

export const F8949_ROW_COLUMNS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
/** The money columns of the Totals row (the form also has an unused (f) cell). */
export const F8949_TOTAL_COLUMNS = ["d", "e", "g", "h"] as const;

/** Name of the table cell that says which box a row (or totals row) belongs to. */
export const F8949_BOX_CELL = "box";

/** Answer keys the box checkboxes read (set per copy by maps/f8949.ts). */
export const F8949_PART_I_ANSWER = "f8949.partIBox";
export const F8949_PART_II_ANSWER = "f8949.partIIBox";

export type F8949Part = "I" | "II";

export function f8949PartOfBox(box: string): F8949Part | null {
  if ((F8949_PART_I_BOXES as readonly string[]).includes(box)) return "I";
  if ((F8949_PART_II_BOXES as readonly string[]).includes(box)) return "II";
  return null;
}

/** Full AcroForm name of a row cell (row 1..11, column a..h). */
export function f8949RowField(part: F8949Part, row: number, column: (typeof F8949_ROW_COLUMNS)[number]): string {
  const page = part === "I" ? 1 : 2;
  const n = 3 + 8 * (row - 1) + F8949_ROW_COLUMNS.indexOf(column);
  const table = part === "I" ? "Table_Line1_Part1[0]" : "Table_Line1_Part2[0]";
  return `topmostSubform[0].Page${page}[0].${table}.Row${row}[0].f${page}_${String(n).padStart(2, "0")}[0]`;
}

/** Full AcroForm name of a Totals-row cell; `column` is d, e, f, g or h. */
export function f8949TotalField(part: F8949Part, column: "d" | "e" | "f" | "g" | "h"): string {
  const page = part === "I" ? 1 : 2;
  const n = 91 + ["d", "e", "f", "g", "h"].indexOf(column);
  return `topmostSubform[0].Page${page}[0].f${page}_${String(n)}[0]`;
}
