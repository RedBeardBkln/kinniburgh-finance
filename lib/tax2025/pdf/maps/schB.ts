// Field-to-line map for Schedule B (Form 1040), TY2025 (task T3). Every one of the
// form's 72 fields is claimed exactly once (completeness test). Field names are the
// full AcroForm names from data/forms/2025/catalog/f1040sb.fields.json.
//
//   - Part I: 14 interest payer rows (name + amount); Part II: 15 dividend payer rows.
//     Rows come from the facts through the adapter (view.tables["schb.interest" |
//     "schb.dividends"], cells { payer, amount }). More payers than rows: rows 1..N-1 as
//     given, the last row reads "Other (see statement)" with the sum of the rest, and the
//     cover carries a continuation list of every payer (fill.ts overflow policy), so the
//     printed rows always add up to the engine's total (lines 2 and 6).
//   - Lines 2, 3, 4, 6 are engine lines (schb.2 / .3 / .4 / .6).
//   - Part III (foreign accounts and trusts): the answers do not exist yet (the facts carry
//     no attestation), so every Yes/No box stays UNCHECKED and an "Answer needed" item is
//     raised. They fill when the view's answers carry foreignAccounts / foreignTrust of
//     "yes" | "no".
//   - Your social security number is blank by design; the line 7b foreign-country text lines are `owner_statement_na` (the
//     foreign-account answer is "no", so there is no country to list).

import type { FormMap, MapBlank, MapLine, MapTable } from "@/lib/tax2025/pdf/types";

const P = "topmostSubform[0].Page1[0].";
const SEVEN_B_NOTE = "line 7b: the names of the foreign countries where a financial account is located (only if Form 114 is required); none, on your answer that you have no foreign financial account";

function rowFields(first: number, count: number, firstNameField: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < count; i++) {
    const nameN = first + 2 * i;
    const name = i === 0 ? firstNameField : `${P}f1_${String(nameN).padStart(2, "0")}[0]`;
    rows.push({ payer: name, amount: `${P}f1_${String(nameN + 1).padStart(2, "0")}[0]` });
  }
  return rows;
}

const interestTable: MapTable = {
  table: "schb.interest",
  // f1_03/f1_04 ... f1_29/f1_30: "Line 1 of 14" ... "Line 14 of 14" (the first name field is inside Line1_ReadOrder).
  rows: rowFields(3, 14, `${P}Line1_ReadOrder[0].f1_03[0]`),
  amountColumn: "amount",
  labelColumn: "payer",
  overflow: "summary_row_and_statement",
};

const dividendTable: MapTable = {
  table: "schb.dividends",
  // f1_34/f1_35 ... f1_62/f1_63: "Line 1 of 15" ... "Line 15 of 15" (the first name field is inside ReadOrderControl).
  rows: rowFields(34, 15, `${P}ReadOrderControl[0].f1_34[0]`),
  amountColumn: "amount",
  labelColumn: "payer",
  overflow: "summary_row_and_statement",
};

const lines: MapLine[] = [
  { kind: "money", field: `${P}f1_31[0]`, line: "schb.2", expected: true }, // line 2, total interest (sum of line 1)
  { kind: "money", field: `${P}f1_32[0]`, line: "schb.3" }, // line 3, excludable savings-bond interest (Form 8815)
  { kind: "money", field: `${P}f1_33[0]`, line: "schb.4" }, // line 4, taxable interest, to 1040 line 2b
  { kind: "money", field: `${P}f1_64[0]`, line: "schb.6", expected: true }, // line 6, total ordinary dividends, to 1040 line 3b
  // Part III. Yes/No questions: both boxes of a question stay unchecked until an attestation exists.
  { kind: "check", field: `${P}TagcorrectingSubform[0].c1_1[0]`, choice: "foreignAccounts", equals: "yes", required: true, label: "Schedule B line 7a foreign financial account (yes/no)" },
  { kind: "check", field: `${P}TagcorrectingSubform[0].c1_1[1]`, choice: "foreignAccounts", equals: "no", required: true, label: "Schedule B line 7a foreign financial account (yes/no)" },
  // 7a second question: FinCEN 114 required? Only asked when the first answer is yes, so no open item of its own.
  { kind: "check", field: `${P}c1_2[0]`, choice: "fincenRequired", equals: "yes", label: "Schedule B line 7a FinCEN 114 required (yes/no)" },
  { kind: "check", field: `${P}c1_2[1]`, choice: "fincenRequired", equals: "no", label: "Schedule B line 7a FinCEN 114 required (yes/no)" },
  { kind: "check", field: `${P}c1_3[0]`, choice: "foreignTrust", equals: "yes", required: true, label: "Schedule B line 8 foreign trust (yes/no)" },
  { kind: "check", field: `${P}c1_3[1]`, choice: "foreignTrust", equals: "no", required: true, label: "Schedule B line 8 foreign trust (yes/no)" },
];

const blank: MapBlank[] = [
  { field: `${P}f1_02[0]`, reason: "ssn" },
  // 7b: names of the foreign countries (only if FinCEN 114 is required): none on the owners' foreign-account answer.
  { field: `${P}f1_65[0]`, reason: "owner_statement_na", note: SEVEN_B_NOTE },
  { field: `${P}f1_66[0]`, reason: "owner_statement_na", note: SEVEN_B_NOTE },
];

export const schBMap: FormMap = {
  formId: "f1040sb",
  engineFormId: "schb",
  lines,
  tables: [interestTable, dividendTable],
  header: [{ field: `${P}f1_01[0]`, source: "household.names" }],
  blank,
};
