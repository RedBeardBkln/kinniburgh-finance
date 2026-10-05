// Field-to-line map for Form 1040 (TY2025), task T2a. EVERY one of the form's 199
// AcroForm fields is claimed exactly once (the completeness test guards it): a printed
// money line (engine key from lib/tax2025/line-catalog.ts), a checkbox answer, a name
// field, or an explicit BLANK with a reason.
//
// Field names are the full AcroForm names from data/forms/2025/catalog/f1040.fields.json;
// the IRS "speak" text next to each name there is the printed line (the mapping below
// was written from it and spot-checked against it in the tests).
//
// Blank policy (plan 6.4-6.6):
//   - SSN, bank/routing/account, designee, PINs, signatures, paid preparer, address,
//     phone, email, occupation: never stored by the app, always blank (reasons below).
//   - Dependents (the whole table, the "more than four" box): owner statement, no
//     dependents ever -> `owner_statement_na`.
//   - Presidential Election Campaign boxes: the owners' choice, never presumed; blank.
//   - Digital assets Y/N: both boxes stay unchecked until an attestation exists
//     (answers.digitalAssets = "yes" | "no"); an advisory open item is raised.
//   - Filing status: five separate checkboxes, exactly one is checked (MFJ = the box
//     whose on-value is /2). The answer key is answers.filingStatus.
//   - Age 65+ / blind boxes (12d, you and spouse): required checks on the booleans
//     answers.age65Taxpayer / blindTaxpayer / age65Spouse / blindSpouse. Until an answer
//     exists the box stays unchecked and an "Answer needed" item is raised, because the
//     boxes change the standard deduction the engine prints on 12e (31,500 assumes none).
//   - Type / code entries beside an amount that is zero for this return (1h "Enter type", the 4c / 5c boxes and
//     "(specify)" codes) are `zero_line_entry` with `follows`: blank while the line is zero, an advisory item and a
//     review finding if the line ever carries an amount (hand-entries.ts). The line 16 boxes and code are
//     `owner_statement_na` (no child's income, no lump-sum distribution, no other tax: the questionnaire statements).
//     The "other tax year" header row (f1_01-f1_03) is `form_na`: this is a calendar-year return.
//   - Everything else the engine/answers do not model (12a-12c, "check if" boxes on lines
//     3c-7b (except the "Schedule D not required" box, which follows the engine), 27b-c, 35a, deceased/combat-zone header)
//     is `not_modeled`: left blank, counted on the cover, and the boxes with a decision attached carry a `note` so the cover
//     LISTS each one.

import { blanks, entryBlanks, ids, money, notedBlanks } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormMap } from "@/lib/tax2025/pdf/types";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";
const FS = `${P1}Checkbox_ReadOrder[0].`;

export const f1040Map: FormMap = {
  formId: "f1040",
  lines: [
    // ── Page 1: income (lines 1a-11a) ──
    money(`${P1}f1_47[0]`, "f1040.1a"),
    money(`${P1}f1_48[0]`, "f1040.1b"),
    money(`${P1}f1_49[0]`, "f1040.1c"),
    money(`${P1}f1_50[0]`, "f1040.1d"),
    money(`${P1}f1_51[0]`, "f1040.1e"),
    money(`${P1}f1_52[0]`, "f1040.1f"),
    money(`${P1}f1_53[0]`, "f1040.1g"),
    money(`${P1}f1_55[0]`, "f1040.1h"), // amount of 1h (f1_54 is the "type" text)
    money(`${P1}f1_56[0]`, "f1040.1i"),
    money(`${P1}f1_57[0]`, "f1040.1z"),
    money(`${P1}f1_58[0]`, "f1040.2a"),
    money(`${P1}f1_59[0]`, "f1040.2b"),
    money(`${P1}f1_60[0]`, "f1040.3a"),
    money(`${P1}f1_61[0]`, "f1040.3b"),
    money(`${P1}f1_62[0]`, "f1040.4a"),
    money(`${P1}f1_63[0]`, "f1040.4b"),
    money(`${P1}f1_65[0]`, "f1040.5a"),
    money(`${P1}f1_66[0]`, "f1040.5b"),
    money(`${P1}f1_68[0]`, "f1040.6a"),
    money(`${P1}f1_69[0]`, "f1040.6b"),
    // Blank when zero, EXCEPT with Schedule D filed and line 16 exactly 0 (the form says "enter -0-"): answers.schdLine16Zero
    { ...money(`${P1}f1_70[0]`, "f1040.7a"), zeroWhen: { choice: "schdLine16Zero", equals: true } },
    money(`${P1}f1_71[0]`, "f1040.7b"), // 7b "Amount" (see the 2025 instructions)
    money(`${P1}f1_72[0]`, "f1040.8"),
    money(`${P1}f1_73[0]`, "f1040.9", { zero: "print" }),
    money(`${P1}f1_74[0]`, "f1040.10"),
    money(`${P1}f1_75[0]`, "f1040.11a", { zero: "print", expected: true }),
    // ── Page 2: tax and credits (lines 11b-24) ──
    money(`${P2}f2_01[0]`, "f1040.11b"),
    money(`${P2}f2_02[0]`, "f1040.12e"), // printed line 12e
    money(`${P2}f2_03[0]`, "f1040.13a"),
    money(`${P2}f2_04[0]`, "f1040.13b"),
    money(`${P2}f2_05[0]`, "f1040.14"),
    money(`${P2}f2_06[0]`, "f1040.15", { zero: "print", expected: true }),
    money(`${P2}f2_08[0]`, "f1040.16", { zero: "print" }), // 16 "Amount" (f2_07 is the "specify" text)
    money(`${P2}f2_09[0]`, "f1040.17"),
    money(`${P2}f2_10[0]`, "f1040.18"),
    money(`${P2}f2_11[0]`, "f1040.19"),
    money(`${P2}f2_12[0]`, "f1040.20"),
    money(`${P2}f2_13[0]`, "f1040.21"),
    money(`${P2}f2_14[0]`, "f1040.22"),
    money(`${P2}f2_15[0]`, "f1040.23"),
    money(`${P2}f2_16[0]`, "f1040.24", { zero: "print", expected: true }),
    // ── Page 2: payments, refund, amount owed (lines 25a-38) ──
    money(`${P2}f2_17[0]`, "f1040.25a"),
    money(`${P2}f2_18[0]`, "f1040.25b"),
    money(`${P2}f2_19[0]`, "f1040.25c"),
    money(`${P2}f2_20[0]`, "f1040.25d"),
    money(`${P2}f2_21[0]`, "f1040.26"),
    money(`${P2}f2_23[0]`, "f1040.27a"),
    money(`${P2}f2_24[0]`, "f1040.28"),
    money(`${P2}f2_25[0]`, "f1040.29"),
    money(`${P2}f2_26[0]`, "f1040.30"),
    money(`${P2}f2_27[0]`, "f1040.31"),
    money(`${P2}f2_28[0]`, "f1040.32"),
    money(`${P2}f2_29[0]`, "f1040.33", { zero: "print" }),
    money(`${P2}f2_30[0]`, "f1040.34"),
    money(`${P2}f2_31[0]`, "f1040.35a"),
    money(`${P2}f2_34[0]`, "f1040.36"),
    money(`${P2}f2_35[0]`, "f1040.37"),
    money(`${P2}f2_36[0]`, "f1040.38"),
    // ── Filing status: five separate checkboxes (no radio groups on IRS forms); exactly one is checked ──
    { kind: "check", field: `${FS}c1_8[0]`, choice: "filingStatus", equals: "single", required: true, label: "filing status" },
    { kind: "check", field: `${FS}c1_8[1]`, choice: "filingStatus", equals: "mfj", required: true, label: "filing status" },
    { kind: "check", field: `${FS}c1_8[2]`, choice: "filingStatus", equals: "mfs", required: true, label: "filing status" },
    { kind: "check", field: `${P1}c1_8[0]`, choice: "filingStatus", equals: "hoh", required: true, label: "filing status" },
    { kind: "check", field: `${P1}c1_8[1]`, choice: "filingStatus", equals: "qss", required: true, label: "filing status" },
    // ── Line 7b "Schedule D not required": checked only when the engine says Exception 1 applies (answers.schdNotRequired = true) ──
    { kind: "check", field: `${P1}c1_43[0]`, choice: "schdNotRequired", equals: true, label: "line 7b: Schedule D not required" },
    // ── Digital assets Y/N: both stay unchecked until an attestation exists (open item) ──
    { kind: "check", field: `${P1}c1_10[0]`, choice: "digitalAssets", equals: "yes", required: true, label: "digital assets (yes/no)" },
    { kind: "check", field: `${P1}c1_10[1]`, choice: "digitalAssets", equals: "no", required: true, label: "digital assets (yes/no)" },
    // ── 12d: age 65 or older / blind (booleans; Phase 1b supplies them). Unanswered = unchecked + an open item ──
    { kind: "check", field: `${P2}c2_5[0]`, choice: "age65Taxpayer", equals: true, required: true, label: "12d: taxpayer was born before January 2, 1961 (65 or older)" },
    { kind: "check", field: `${P2}c2_6[0]`, choice: "blindTaxpayer", equals: true, required: true, label: "12d: taxpayer is blind" },
    { kind: "check", field: `${P2}c2_7[0]`, choice: "age65Spouse", equals: true, required: true, label: "12d: spouse was born before January 2, 1961 (65 or older)" },
    { kind: "check", field: `${P2}c2_8[0]`, choice: "blindSpouse", equals: true, required: true, label: "12d: spouse is blind" },
  ],
  tables: [],
  header: [
    { field: `${P1}f1_14[0]`, source: "household.taxpayerFirst" },
    { field: `${P1}f1_15[0]`, source: "household.taxpayerLast" },
    { field: `${P1}f1_17[0]`, source: "household.spouseFirst" },
    { field: `${P1}f1_18[0]`, source: "household.spouseLast" },
  ],
  blank: [
    // Social security numbers: never stored by this app.
    ...blanks("ssn", `${P1}f1_16[0]`, `${P1}f1_19[0]`, `${FS}f1_28[0]`, `${P2}SSN_ReadOrder[0].f2_22[0]`),
    // Owner statement: no dependents ever. The whole table (names, the dependents' SSN row, the lived-with-you,
    // student/disabled and credits boxes) and the "more than four dependents" box are blank for that reason.
    { match: /\.Page1\[0\]\.Table_Dependents\[0\]\./, reason: "owner_statement_na" },
    { match: /\.Page1\[0\]\.Dependents_ReadOrder\[0\]\./, reason: "owner_statement_na" },
    // Home address (domestic and foreign), phone, email, occupations: not stored.
    { match: /\.Page1\[0\]\.Address_ReadOrder\[0\]\./, reason: "contact_address" },
    ...blanks("contact_address", ...ids(P2, "f2_40", "f2_42", "f2_44", "f2_45")),
    // Direct deposit: routing, account, account type.
    ...blanks("bank", `${P2}RoutingNo[0].f2_32[0]`, `${P2}AccountNo[0].f2_33[0]`, `${P2}c2_16[0]`, `${P2}c2_16[1]`),
    // PINs (designee PIN, Identity Protection PINs): never stored.
    ...blanks("signature_pin", ...ids(P2, "f2_39", "f2_41", "f2_43")),
    // Third-party designee and paid preparer block.
    ...blanks("preparer", `${P2}c2_17[0]`, `${P2}c2_17[1]`, ...ids(P2, "f2_37", "f2_38", "f2_46", "f2_47", "f2_48", "f2_49", "f2_50", "f2_51", "c2_18")),
    // Not modeled by the engine or the answers: left for the CPA (see the header comment). The boxes that carry
    // a decision have a note, so the cover lists each one instead of only counting them.
    ...blanks(
      "not_modeled",
      // 301.9100-2, combat zone, deceased, other
      ...ids(P1, "c1_1", "c1_2", "f1_04", "c1_3", "f1_05", "f1_06", "f1_07", "f1_08", "f1_09", "f1_10", "c1_4", "f1_11", "f1_12", "f1_13"),
      // HOH/QSS qualifying child's name
      ...ids(P1, "f1_29"),
    ),
    // The "other tax year" row (", 2025, ending ..., 20__"): this is a calendar-year return, so the whole row has no entry.
    ...blanks("form_na", ...ids(P1, "f1_01", "f1_02", "f1_03")),
    ...entryBlanks("line 1h: the words that say what kind of other earned income it is (beside the amount)", ["f1040.1h"], ...ids(P1, "f1_54")),
    ...notedBlanks("not_modeled", "main home (and spouse's) in the U.S. more than half of 2025 box, top of page 1", ...ids(P1, "c1_5")),
    ...notedBlanks("not_modeled", "Presidential Election Campaign $3 boxes (the owners' choice; never presumed)", ...ids(P1, "c1_6", "c1_7")),
    ...notedBlanks("not_modeled", "treating a nonresident or dual-status alien spouse as a U.S. resident (election box and name)", ...ids(P1, "c1_9", "f1_30")),
    ...notedBlanks("not_modeled", "MFS/HOH 'lived apart from your spouse the last 6 months' / legally separated box", ...ids(P1, "c1_32")),
    ...notedBlanks("not_modeled", "line 3c: child's dividends included on line 3a / 3b boxes", ...ids(P1, "c1_33", "c1_34")),
    ...entryBlanks("line 4c: the IRA distribution boxes (rollover, qualified charitable distribution, other) and the code after \"specify\"", ["f1040.4a", "f1040.4b"], ...ids(P1, "c1_35", "c1_36", "c1_37", "f1_64")),
    ...entryBlanks("line 5c: the pension and annuity boxes (rollover, public safety officer, other) and the code after \"specify\"", ["f1040.5a", "f1040.5b"], ...ids(P1, "c1_38", "c1_39", "c1_40", "f1_67")),
    ...notedBlanks("not_modeled", "line 6c: lump-sum election method box (Social Security)", ...ids(P1, "c1_41")),
    ...notedBlanks("not_modeled", "line 6d: MFS lived apart the entire year box (Social Security)", ...ids(P1, "c1_42")),
    ...notedBlanks("not_modeled", "line 7b: 'includes child's capital gain or (loss)' box (Form 8814 is not modeled)", ...ids(P1, "c1_44")),
    ...notedBlanks("not_modeled", "line 12a: someone can claim you or your spouse as a dependent boxes", ...ids(P2, "c2_1", "c2_2")),
    ...notedBlanks("not_modeled", "line 12b: spouse itemizes on a separate return box", ...ids(P2, "c2_3")),
    ...notedBlanks("not_modeled", "line 12c: you were a dual-status alien box", ...ids(P2, "c2_4")),
    ...notedBlanks(
      "owner_statement_na",
      "line 16: the boxes for tax from Form 8814 (a child's income), Form 4972 (a lump-sum distribution) or another tax with its code (for example recapture of an education credit); none applies on your statements that there are no dependents, no pension or IRA distributions and no other taxes",
      ...ids(P2, "c2_9", "c2_10", "c2_11", "f2_07"),
    ),
    ...notedBlanks("not_modeled", "line 27b: clergy filing Schedule SE box", ...ids(P2, "c2_12")),
    ...notedBlanks("not_modeled", "line 27c: boxes to decline the EIC / additional child tax credit", ...ids(P2, "c2_13"), `${P2}Line28_ReadOrder[0].c2_14[0]`),
    ...notedBlanks("not_modeled", "line 35a: Form 8888 attached (split refund) box", ...ids(P2, "c2_15")),
  ],
};
