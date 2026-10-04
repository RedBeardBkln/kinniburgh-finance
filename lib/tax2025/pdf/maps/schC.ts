// Field-to-line map for Schedule C (Form 1040), TY2025, for Eric Kinniburgh Consulting,
// LLC, task T2b. All 105 fields are claimed exactly once. Every printed money line has an
// engine key (schc.<line>, see lib/tax2025/line-catalog.ts SCHC and
// lib/tax2025/rules/schedule-c.ts): income 1-7, expenses 8-27b (the GL-code map builds
// each line from the books), 28, 29, 30, 31, Part III 35-42 and line 48.
//
// Behaviour worth knowing:
//   - Line 9 (car and truck) is a computed confirmed $0 (owner: no business mileage in
//     2025), so it prints BLANK (the IRS convention: a blank is zero) and Part IV
//     (vehicle information, lines 43-47) is blank by owner statement.
//   - Line 30 prints the engine's in-force amount; when it comes from an undecided
//     default (simplified home-office method, decision X1) the field tooltip says
//     "default, undecided: ...". The two square-footage text boxes under line 30
//     are text answers (answers["schC.homeSqft"], answers["schC.officeSqft"]) and stay
//     blank until an adapter supplies them.
//   - Part V (other expenses, lines 1-9 of the table + line 48 total): rows come from the
//     view table "schc.otherExpenses" (columns "label", "amount" in whole dollars; built
//     from Ty2025Return.scheduleC.otherExpenseItems). More than 9 items: the last row
//     becomes "Other (see statement)" with the sum of the rest (cover continuation list).
//     No item data: the rows stay blank and only the engine's line 48 total prints.
//   - Accounting method (F) and "materially participate" (G) are only checked when an
//     answer exists (answers["schC.accountingMethod"] = cash | accrual | other,
//     answers["schC.materialParticipation"] = yes | no); otherwise both stay unchecked
//     and an advisory "answer needed" item is raised. The principal business (A) and the
//     business code (B) are text answers that stay blank until supplied.
//   - Proprietor name (box top left) is household.taxpayer: the view's
//     header.taxpayerName must be the owner of EK Consulting. Business name (C) is the
//     entity name. EIN (D), business address (E) and SSN are never stored.

import { blanks, ids, money } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormMap, MapTable } from "@/lib/tax2025/pdf/types";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";
const L817 = `${P1}Lines8-17[0].`;
const L1827 = `${P1}Lines18-27[0].`;

/** Part V "Other expenses": 9 rows of (business expense, amount); each row is one GL account mapped to line 27b. */
const PART_V_ROWS: ReadonlyArray<Readonly<Record<string, string>>> = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
  label: `${P2}PartVTable[0].Item${n}[0].f2_${15 + (n - 1) * 2}[0]`,
  amount: `${P2}PartVTable[0].Item${n}[0].f2_${16 + (n - 1) * 2}[0]`,
}));

const partV: MapTable = {
  table: "schc.otherExpenses",
  rows: PART_V_ROWS,
  amountColumn: "amount",
  labelColumn: "label",
  overflow: "summary_row_and_statement",
};

export const schCMap: FormMap = {
  formId: "f1040sc",
  engineFormId: "schc",
  lines: [
    // ── Header answers (only when an answer exists) ──
    { kind: "text", field: `${P1}f1_3[0]`, answer: "schC.principalBusiness", label: "Schedule C line A principal business" },
    { kind: "text", field: `${P1}BComb[0].f1_4[0]`, answer: "schC.businessCode", label: "Schedule C line B business code" },
    { kind: "check", field: `${P1}c1_1[0]`, choice: "schC.accountingMethod", equals: "cash", required: true, label: "Schedule C accounting method (cash / accrual / other)" },
    { kind: "check", field: `${P1}c1_1[1]`, choice: "schC.accountingMethod", equals: "accrual", required: true, label: "Schedule C accounting method (cash / accrual / other)" },
    { kind: "check", field: `${P1}c1_1[2]`, choice: "schC.accountingMethod", equals: "other", required: true, label: "Schedule C accounting method (cash / accrual / other)" },
    { kind: "check", field: `${P1}c1_2[0]`, choice: "schC.materialParticipation", equals: "yes", required: true, label: "Schedule C material participation (yes / no)" },
    { kind: "check", field: `${P1}c1_2[1]`, choice: "schC.materialParticipation", equals: "no", required: true, label: "Schedule C material participation (yes / no)" },
    // ── Part I: income ──
    money(`${P1}f1_10[0]`, "schc.1"),
    money(`${P1}f1_11[0]`, "schc.2"),
    money(`${P1}f1_12[0]`, "schc.3"),
    money(`${P1}f1_13[0]`, "schc.4"),
    money(`${P1}f1_14[0]`, "schc.5"),
    money(`${P1}f1_15[0]`, "schc.6"),
    money(`${P1}f1_16[0]`, "schc.7"),
    // ── Part II: expenses ──
    money(`${L817}f1_17[0]`, "schc.8"),
    money(`${L817}f1_18[0]`, "schc.9"),
    money(`${L817}f1_19[0]`, "schc.10"),
    money(`${L817}f1_20[0]`, "schc.11"),
    money(`${L817}f1_21[0]`, "schc.12"),
    money(`${L817}f1_22[0]`, "schc.13"),
    money(`${L817}f1_23[0]`, "schc.14"),
    money(`${L817}f1_24[0]`, "schc.15"),
    money(`${L817}f1_25[0]`, "schc.16a"),
    money(`${L817}f1_26[0]`, "schc.16b"),
    money(`${L817}f1_27[0]`, "schc.17"),
    money(`${L1827}f1_28[0]`, "schc.18"),
    money(`${L1827}f1_29[0]`, "schc.19"),
    money(`${L1827}f1_30[0]`, "schc.20a"),
    money(`${L1827}f1_31[0]`, "schc.20b"),
    money(`${L1827}f1_32[0]`, "schc.21"),
    money(`${L1827}f1_33[0]`, "schc.22"),
    money(`${L1827}f1_34[0]`, "schc.23"),
    money(`${L1827}f1_35[0]`, "schc.24a"),
    money(`${L1827}f1_36[0]`, "schc.24b"),
    money(`${L1827}f1_37[0]`, "schc.25"),
    money(`${L1827}f1_38[0]`, "schc.26"),
    money(`${L1827}f1_40[0]`, "schc.27a"), // note: f1_40 is 27a and f1_39 is 27b in the form's own numbering
    money(`${L1827}f1_39[0]`, "schc.27b"),
    money(`${P1}f1_41[0]`, "schc.28"),
    money(`${P1}f1_42[0]`, "schc.29"),
    // ── Line 30: business use of home (amount; the sqft boxes are text answers) ──
    { kind: "text", field: `${P1}Line30_ReadOrder[0].f1_43[0]`, answer: "schC.homeSqft", label: "Schedule C line 30 total square footage of the home" },
    { kind: "text", field: `${P1}Line30_ReadOrder[0].f1_44[0]`, answer: "schC.officeSqft", label: "Schedule C line 30 square footage used for business" },
    money(`${P1}f1_45[0]`, "schc.30"),
    money(`${P1}f1_46[0]`, "schc.31"),
    // ── Part III: cost of goods sold (not_applicable / blank while the books show none) ──
    money(`${P2}f2_1[0]`, "schc.35"),
    money(`${P2}f2_2[0]`, "schc.36"),
    money(`${P2}f2_3[0]`, "schc.37"),
    money(`${P2}f2_4[0]`, "schc.38"),
    money(`${P2}f2_5[0]`, "schc.39"),
    money(`${P2}f2_6[0]`, "schc.40"),
    money(`${P2}f2_7[0]`, "schc.41"),
    money(`${P2}f2_8[0]`, "schc.42"),
    // ── Part V: line 48 total of the other-expense rows (the rows are the table below) ──
    money(`${P2}f2_33[0]`, "schc.48"),
  ],
  tables: [partV],
  header: [
    { field: `${P1}f1_1[0]`, source: "household.taxpayer" },
    { field: `${P1}f1_5[0]`, source: "entity.ekcName" },
  ],
  blank: [
    // SSN, EIN: never stored. Business address: not stored.
    ...blanks("ssn", `${P1}f1_2[0]`),
    ...blanks("ein", `${P1}DComb[0].f1_6[0]`),
    ...blanks("contact_address", ...ids(P1, "f1_7", "f1_8")),
    // Part IV (vehicle information, lines 43-47): owner statement, no business mileage in 2025.
    ...blanks(
      "owner_statement_na",
      ...ids(P2, "f2_9", "f2_10", "f2_11", "f2_12", "f2_13", "f2_14"),
      ...[0, 1].flatMap((i) => [5, 6, 7, 8].map((n) => `${P2}c2_${n}[${i}]`)),
    ),
    // Not modeled: F "other" specify text, H started-or-acquired, I and J (Form 1099 questions),
    // the line 1 statutory-employee box, line 32 loss boxes, line 33 and 34 inventory boxes.
    ...blanks(
      "not_modeled",
      `${P1}f1_9[0]`,
      `${P1}c1_3[0]`,
      `${P1}c1_4[0]`,
      `${P1}c1_4[1]`,
      `${P1}c1_5[0]`,
      `${P1}c1_5[1]`,
      `${P1}Line1_ReadOrder[0].c1_6[0]`,
      `${P1}c1_7[0]`,
      `${P1}c1_7[1]`,
      ...ids(P2, "c2_1", "c2_2", "c2_3"),
      `${P2}c2_4[0]`,
      `${P2}c2_4[1]`,
    ),
  ],
};
