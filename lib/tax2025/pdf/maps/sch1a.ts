// Field-to-line map for Schedule 1-A (Form 1040), Additional Deductions, TY2025. All 54 fields are claimed
// exactly once (31 on page 1, 23 on page 2). Names are the full AcroForm names from
// data/forms/2025/catalog/f1040s1a.fields.json (they start `form1[0].`, not `topmostSubform[0].`).
//
// Every printed money line has an engine key (sch1a.<line>, rules/schedule-1a.ts), so this map only places values:
//   Part I   1, 3                      (2a-2e: blank, the owner states no Puerto Rico / Form 2555 / Form 4563 income)
//   Part II  4a-13   Part III 14a-21   Part IV 23-30 (22: VINs and per-loan interest, blank)   Part V 31-37   Part VI 38
// A part that is not used (no qualified tips, no overtime, no car loan, nobody born before 1961) has every one of its
// lines not_applicable, so it prints BLANK and the form follows its own caution ("fill out Part II only if ...").
//
// No line prints "0": the policy cannot tell "part used and 0" from "part not used". A part that is used and fully
// phased out therefore prints a blank deduction (13 / 21 / 30), which the cover already states means 0 (IRS
// convention). Lines the form skips (10-12 / 18-20 / 27-29 / 33-34 when the MAGI is not over the threshold) are
// not_applicable in the engine and print blank too; the capped amount is then on 13 / 21 / 30 / 35.
//
// The form is OMITTED from the packet when the engine reports it is not required (engineFormId "sch1a" ->
// Ty2025Return.formsRequired).

import { blanks, money, notedBlanks } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormMap, MapLine } from "@/lib/tax2025/pdf/types";
import type { LineKey } from "@/lib/tax2025/types";

const P1 = "form1[0].Page1[0].";
const P2 = "form1[0].Page2[0].";
const L22 = `${P2}Table_Line22[0].`;

const page1: readonly (readonly [number, LineKey])[] = [
  [3, "sch1a.1"],
  [9, "sch1a.3"],
  [10, "sch1a.4a"],
  [11, "sch1a.4b"],
  [12, "sch1a.4c"],
  [13, "sch1a.5"],
  [14, "sch1a.6"],
  [15, "sch1a.7"],
  [16, "sch1a.8"],
  [17, "sch1a.9"],
  [18, "sch1a.10"],
  [19, "sch1a.11"],
  [20, "sch1a.12"],
  [21, "sch1a.13"],
  [22, "sch1a.14a"],
  [23, "sch1a.14b"],
  [24, "sch1a.14c"],
  [25, "sch1a.15"],
  [26, "sch1a.16"],
  [27, "sch1a.17"],
  [28, "sch1a.18"],
  [29, "sch1a.19"],
  [30, "sch1a.20"],
  [31, "sch1a.21"],
];

const page2: readonly (readonly [number, LineKey])[] = [
  [7, "sch1a.23"],
  [8, "sch1a.24"],
  [9, "sch1a.25"],
  [10, "sch1a.26"],
  [11, "sch1a.27"],
  [12, "sch1a.28"],
  [13, "sch1a.29"],
  [14, "sch1a.30"],
  [15, "sch1a.31"],
  [16, "sch1a.32"],
  [17, "sch1a.33"],
  [18, "sch1a.34"],
  [19, "sch1a.35"],
  [20, "sch1a.36a"],
  [21, "sch1a.36b"],
  [22, "sch1a.37"],
  [23, "sch1a.38"],
];

const pad = (n: number): string => String(n).padStart(2, "0");

const lines: MapLine[] = [
  ...page1.map(([n, key]) => money(`${P1}f1_${pad(n)}[0]`, key)),
  ...page2.map(([n, key]) => money(`${P2}f2_${pad(n)}[0]`, key)),
];

export const sch1aMap: FormMap = {
  formId: "f1040s1a",
  engineFormId: "sch1a",
  lines,
  tables: [],
  header: [{ field: `${P1}f1_01[0]`, source: "household.names" }],
  blank: [
    ...blanks("ssn", `${P1}f1_02[0]`),
    // lines 2a-2e: the engine blocks line 3 unless the owner states no excluded income
    ...notedBlanks(
      "owner_statement_na",
      "Schedule 1-A lines 2a-2e: the owner states no Puerto Rico income, Form 2555 or Form 4563 exclusion, so line 3 equals line 1.",
      `${P1}f1_04[0]`,
      `${P1}f1_05[0]`,
      `${P1}f1_06[0]`,
      `${P1}f1_07[0]`,
      `${P1}f1_08[0]`
    ),
    // line 22: vehicle identification numbers and per-loan interest are never stored by the app
    ...notedBlanks(
      "not_modeled",
      "Schedule 1-A line 22: the vehicle identification number and the interest per loan are never stored by this app (the owner states no qualifying vehicle loan, so Part IV is blank); if one applies the CPA enters them.",
      `${L22}Line22a[0].VIN-1_Comb[0].f2_01[0]`,
      `${L22}Line22a[0].f2_02[0]`,
      `${L22}Line22a[0].f2_03[0]`,
      `${L22}Line22b[0].VIN-2_Comb[0].f2_04[0]`,
      `${L22}Line22b[0].f2_05[0]`,
      `${L22}Line22b[0].f2_06[0]`
    ),
  ],
};
