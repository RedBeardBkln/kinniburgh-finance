// Field-to-line map for Form 8995 (Qualified Business Income Deduction, simplified
// computation), TY2025 (task T3). All 33 fields are claimed exactly once. Names are the
// full AcroForm names from data/forms/2025/catalog/f8995.fields.json.
//
//   - Row 1i carries the only qualified trade or business: Eric Kinniburgh Consulting, LLC
//     (name from the view header "entity.ekcName"), column (c) = f8995.1i. Its taxpayer
//     identification number (column b) and the header TIN are BLANK by design (the app
//     stores no EIN/SSN). Rows ii-v are not used.
//   - Lines 2-17 are the engine's f8995.* keys. Lines the form says to enter 0 on when the
//     result is zero or less (4, 13) and the deduction itself (15) print "0".
//   - The form is included in a packet only when the engine reports it required
//     (engineFormId "f8995" -> Ty2025Return.formsRequired).

import type { FormMap, MapBlank, MapLine } from "@/lib/tax2025/pdf/types";

const P = "topmostSubform[0].Page1[0].";
const T = `${P}Table[0].`;

const lines: MapLine[] = [
  { kind: "money", field: `${T}Row1i[0].f1_05[0]`, line: "f8995.1i" },
  { kind: "money", field: `${P}Line2_ReadOrder[0].f1_18[0]`, line: "f8995.2" },
  { kind: "money", field: `${P}f1_19[0]`, line: "f8995.3" },
  { kind: "money", field: `${P}f1_20[0]`, line: "f8995.4", zero: "print" },
  { kind: "money", field: `${P}f1_21[0]`, line: "f8995.5" },
  { kind: "money", field: `${P}Line6_ReadOrder[0].f1_22[0]`, line: "f8995.6" },
  { kind: "money", field: `${P}f1_23[0]`, line: "f8995.7" },
  { kind: "money", field: `${P}f1_24[0]`, line: "f8995.8" },
  { kind: "money", field: `${P}f1_25[0]`, line: "f8995.9" },
  { kind: "money", field: `${P}f1_26[0]`, line: "f8995.10" },
  { kind: "money", field: `${P}f1_27[0]`, line: "f8995.11" },
  { kind: "money", field: `${P}f1_28[0]`, line: "f8995.12" },
  { kind: "money", field: `${P}f1_29[0]`, line: "f8995.13", zero: "print" },
  { kind: "money", field: `${P}f1_30[0]`, line: "f8995.14" },
  { kind: "money", field: `${P}f1_31[0]`, line: "f8995.15", zero: "print", expected: true },
  { kind: "money", field: `${P}f1_32[0]`, line: "f8995.16" },
  { kind: "money", field: `${P}f1_33[0]`, line: "f8995.17" },
];

const blank: MapBlank[] = [
  { field: `${P}f1_02[0]`, reason: "ssn" }, // header taxpayer identification number
  { field: `${T}Row1i[0].f1_04[0]`, reason: "ein" }, // row i column (b): EKC's TIN
  // Rows ii-v: the household has one qualified trade or business.
  { match: /\.Table\[0\]\.Row1(ii|iii|iv|v)\[0\]\.f1_\d+\[0\]$/, reason: "not_modeled" },
];

export const f8995Map: FormMap = {
  formId: "f8995",
  engineFormId: "f8995",
  lines,
  tables: [],
  header: [
    { field: `${P}f1_01[0]`, source: "household.names" },
    { field: `${T}Row1i[0].f1_03[0]`, source: "entity.ekcName" }, // row i column (a): trade, business or aggregation name
  ],
  blank,
};
