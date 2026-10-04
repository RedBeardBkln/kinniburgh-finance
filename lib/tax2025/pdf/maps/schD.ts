// Field-to-line map for Schedule D (Form 1040), TY2025. All 55 AcroForm fields of the blank are claimed
// exactly once (completeness test). Field names are the full AcroForm names from
// data/forms/2025/catalog/f1040sd.fields.json; the IRS "speak" text there names the line AND the column.
//
//   - The eight transaction lines 1a 1b 2 3 (Part I) and 8a 8b 9 10 (Part II) each have four cells in field
//     order (d) proceeds, (e) cost or other basis, (g) adjustments, (h) gain or (loss); the engine keys are
//     `schd.<line>.<column>`. Lines 1a and 8a have NO engine key for (g) by design: the form says the
//     direct-entry rows have no adjustments (adjustments go through Form 8949), so those two cells are blank
//     by design (reason form_na).
//   - Lines 4 5 11 12 (other forms), 6 and 14 (carryover, the positive amount: the form pre-prints the
//     parentheses), 7 15 16 (subtotals; a computed zero prints as 0), 13 (capital gain distributions),
//     18 19 (28% / unrecaptured section 1250 worksheets), 21 (loss deduction, positive amount).
//   - Yes/No boxes: the page 1 QOF question (answers["schd.qof"], from the owner's "capital_special_rates"
//     none-group statement, never guessed) and lines 17, 20, 22 (answers "schd.l17" / "schd.l20" / "schd.l22",
//     derived by the adapter from the engine's detail). An unanswered QOF box stays unchecked and raises
//     "Answer needed"; 17 / 20 / 22 are only set where the form asks the question.
//   - Name from the household names; the social security number is never filled.
//   - Figures printed on Form 1040 line 7a come from the Schedule D rule (f1040.7a); that map entry is in maps/f1040.ts.

import { blanks, money } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormMap, LineRef, MapLine } from "@/lib/tax2025/pdf/types";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";

type Col = "d" | "e" | "g" | "h";

/** [line id, table, row element, number of its first field: f1_<n>] for the eight transaction lines. */
const TRANSACTION_ROWS = [
  ["1a", "Table_PartI[0]", "Row1a[0]", 3],
  ["1b", "Table_PartI[0]", "Row1b[0]", 7],
  ["2", "Table_PartI[0]", "Row2[0]", 11],
  ["3", "Table_PartI[0]", "Row3[0]", 15],
  ["8a", "Table_PartII[0]", "Row8a[0]", 23],
  ["8b", "Table_PartII[0]", "Row8b[0]", 27],
  ["9", "Table_PartII[0]", "Row9[0]", 31],
  ["10", "Table_PartII[0]", "Row10[0]", 35],
] as const;

const COLS: readonly Col[] = ["d", "e", "g", "h"];

const transactionLines: MapLine[] = [];
const directEntryBlanks: string[] = [];
for (const [id, table, row, first] of TRANSACTION_ROWS) {
  COLS.forEach((col, i) => {
    const field = `${P1}${table}.${row}.f1_${first + i}[0]`;
    if ((id === "1a" || id === "8a") && col === "g") {
      directEntryBlanks.push(field);
      return;
    }
    // `schd.<line>.<col>` is a real engine key for every cell except the two blanked above.
    transactionLines.push(money(field, `schd.${id}.${col}` as LineRef));
  });
}

const lines: MapLine[] = [
  ...transactionLines,
  // Part I: lines 4-7
  money(`${P1}f1_19[0]`, "schd.4"),
  money(`${P1}f1_20[0]`, "schd.5"),
  money(`${P1}f1_21[0]`, "schd.6"), // the positive carryover amount; the parentheses are pre-printed
  money(`${P1}f1_22[0]`, "schd.7", { zero: "print" }),
  // Part II: lines 11-15
  money(`${P1}f1_39[0]`, "schd.11"),
  money(`${P1}f1_40[0]`, "schd.12"),
  money(`${P1}f1_41[0]`, "schd.13"),
  money(`${P1}f1_42[0]`, "schd.14"), // the positive carryover amount
  money(`${P1}f1_43[0]`, "schd.15", { zero: "print" }),
  // Part III (page 2)
  money(`${P2}f2_1[0]`, "schd.16", { zero: "print" }),
  money(`${P2}f2_2[0]`, "schd.18"),
  money(`${P2}f2_3[0]`, "schd.19"),
  money(`${P2}f2_4[0]`, "schd.21"), // the positive loss deduction; the parentheses are pre-printed
  // Yes / No boxes (on-value 1 = Yes, 2 = No on every pair)
  { kind: "check", field: `${P1}c1_1[0]`, choice: "schd.qof", equals: "yes", required: true, label: "Schedule D: disposed of an investment in a qualified opportunity fund (yes/no)" },
  { kind: "check", field: `${P1}c1_1[1]`, choice: "schd.qof", equals: "no", required: true, label: "Schedule D: disposed of an investment in a qualified opportunity fund (yes/no)" },
  { kind: "check", field: `${P2}c2_1[0]`, choice: "schd.l17", equals: "yes", label: "Schedule D line 17 (lines 15 and 16 both gains)" },
  { kind: "check", field: `${P2}c2_1[1]`, choice: "schd.l17", equals: "no", label: "Schedule D line 17 (lines 15 and 16 both gains)" },
  { kind: "check", field: `${P2}c2_2[0]`, choice: "schd.l20", equals: "yes", label: "Schedule D line 20 (lines 18 and 19 both zero, no Form 4952)" },
  { kind: "check", field: `${P2}c2_2[1]`, choice: "schd.l20", equals: "no", label: "Schedule D line 20 (lines 18 and 19 both zero, no Form 4952)" },
  { kind: "check", field: `${P2}c2_3[0]`, choice: "schd.l22", equals: "yes", label: "Schedule D line 22 (qualified dividends on Form 1040 line 3a)" },
  { kind: "check", field: `${P2}c2_3[1]`, choice: "schd.l22", equals: "no", label: "Schedule D line 22 (qualified dividends on Form 1040 line 3a)" },
];

export const schDMap: FormMap = {
  formId: "f1040sd",
  engineFormId: "schd",
  lines,
  tables: [],
  header: [{ field: `${P1}f1_1[0]`, source: "household.names" }],
  blank: [
    ...blanks("ssn", `${P1}f1_2[0]`),
    // (g) of lines 1a and 8a: adjustments are never entered on the direct-entry rows (they go through Form 8949).
    ...blanks("form_na", ...directEntryBlanks),
  ],
};
