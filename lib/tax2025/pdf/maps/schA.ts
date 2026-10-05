// Field-to-line map for Schedule A (Form 1040), TY2025, task T2b. All 33 fields are
// claimed exactly once. Every printed money line has an engine key (scha.<line>, see
// lib/tax2025/line-catalog.ts SCHA; the engine's rule is lib/tax2025/rules/schedule-a.ts):
// medical 1-4, SALT 5a-5e (the $40,000 cap is the engine's, line 5e is the capped
// amount), other taxes 6, 7, mortgage 8a/8b/8c/8e, 9, 10, charity 11/12/13/14,
// casualty 15, other 16, total 17. Printed line "8d" is "Reserved for future use".
//
// Whether to itemize at all (strictly greater than the standard deduction; a tie is the
// standard deduction) is the engine's call (Form 1040 line 12e); the packet omits this
// form when the standard deduction wins (inclusion rule, plan 5.2 C7).
//
// Left blank on purpose: SSN (`ssn`); the line 6 / 16 "type" texts and the line 8b payee text (`zero_line_entry`: entries beside
// an amount that is zero, with `follows`: an advisory item and a review finding if the amount is ever non-zero, hand-entries.ts);
// the reserved line 8d (`form_na`); the line 5a "elect general sales tax" box (the engine uses state income tax paid, so the box
// stays unchecked), the line 8 "not all used to buy/build/improve" box and line 18 "itemize although below the standard
// deduction" (`not_modeled`).

import { blanks, entryBlanks, money } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormMap } from "@/lib/tax2025/pdf/types";

const P1 = "form1[0].Page1[0].";

export const schAMap: FormMap = {
  formId: "f1040sa",
  engineFormId: "scha",
  lines: [
    // ── Medical and dental ──
    money(`${P1}f1_3[0]`, "scha.1"),
    money(`${P1}Line2_ReadOrder[0].f1_4[0]`, "scha.2"),
    money(`${P1}f1_5[0]`, "scha.3"),
    money(`${P1}f1_6[0]`, "scha.4"),
    // ── Taxes you paid (SALT) ──
    money(`${P1}f1_7[0]`, "scha.5a"),
    money(`${P1}f1_8[0]`, "scha.5b"),
    money(`${P1}f1_9[0]`, "scha.5c"),
    money(`${P1}f1_10[0]`, "scha.5d"),
    money(`${P1}f1_11[0]`, "scha.5e"),
    money(`${P1}f1_13[0]`, "scha.6"), // amount of 6 (f1_12 is the "type" text)
    money(`${P1}f1_14[0]`, "scha.7"),
    // ── Interest you paid ──
    money(`${P1}f1_15[0]`, "scha.8a"),
    money(`${P1}f1_17[0]`, "scha.8b"), // amount of 8b (Line8b_ReadOrder.f1_16 is the payee text)
    money(`${P1}f1_18[0]`, "scha.8c"),
    money(`${P1}f1_20[0]`, "scha.8e"),
    money(`${P1}f1_21[0]`, "scha.9"),
    money(`${P1}f1_22[0]`, "scha.10"),
    // ── Gifts to charity ──
    money(`${P1}f1_23[0]`, "scha.11"),
    money(`${P1}f1_24[0]`, "scha.12"),
    money(`${P1}f1_25[0]`, "scha.13"),
    money(`${P1}f1_26[0]`, "scha.14"),
    // ── Casualty and theft, other itemized, total ──
    money(`${P1}f1_27[0]`, "scha.15"),
    money(`${P1}f1_29[0]`, "scha.16"), // amount of 16 (f1_28 is the "type" text)
    money(`${P1}f1_30[0]`, "scha.17"),
  ],
  tables: [],
  header: [{ field: `${P1}f1_1[0]`, source: "household.names" }],
  blank: [
    ...blanks("ssn", `${P1}f1_2[0]`),
    // 5a sales-tax election box, 8 box, 18 box
    ...blanks("not_modeled", `${P1}c1_1[0]`, `${P1}Line8_ReadOrder[0].c1_2[0]`, `${P1}Line18_ReadOrder[0].c1_3[0]`),
    ...entryBlanks("line 6: the words that say what kind of other tax it is (\"List type\")", ["scha.6"], `${P1}f1_12[0]`),
    ...entryBlanks("line 8b: the name, identifying number and address of the person paid mortgage interest not reported on Form 1098", ["scha.8b"], `${P1}Line8b_ReadOrder[0].f1_16[0]`),
    // 8d is reserved for future use
    ...blanks("form_na", `${P1}f1_19[0]`),
    ...entryBlanks("line 16: the words that say what kind of other itemized deduction it is (\"List type\")", ["scha.16"], `${P1}f1_28[0]`),
  ],
};
