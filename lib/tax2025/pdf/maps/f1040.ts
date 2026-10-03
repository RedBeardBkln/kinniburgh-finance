// TRIAL field-to-line map for Form 1040 (TY2025), task T1 (engine core). It proves the
// map/fill/policy/completeness machinery end to end on the real form with the 17
// engine-keyed lines the plan names; the FULL 1040 map (every printed money line, the
// pending keys, the gap report) is task T2a and replaces this file.
//
// Field names are the full AcroForm names from data/forms/2025/catalog/f1040.fields.json
// (the IRS "speak" text next to each name there is the printed line). Every one of the
// form's 199 fields is claimed exactly once (see the completeness test): money lines,
// filing-status/digital-asset checkboxes and the four name fields are filled; SSN, bank,
// routing, designee, PIN, preparer, address, phone/email, occupation and the
// dependents table (owner statement: no dependents) are BLANK BY DESIGN; every other
// field is `not_modeled` until T2a.

import type { FormMap } from "@/lib/tax2025/pdf/types";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";
const FS = `${P1}Checkbox_ReadOrder[0].`;

export const f1040Map: FormMap = {
  formId: "f1040",
  lines: [
    // ── Page 1 income ──
    { kind: "money", field: `${P1}f1_47[0]`, line: "f1040.1a" },
    { kind: "money", field: `${P1}f1_59[0]`, line: "f1040.2b" },
    { kind: "money", field: `${P1}f1_61[0]`, line: "f1040.3b" },
    { kind: "money", field: `${P1}f1_72[0]`, line: "f1040.8" },
    { kind: "money", field: `${P1}f1_73[0]`, line: "f1040.9", zero: "print" },
    { kind: "money", field: `${P1}f1_74[0]`, line: "f1040.10" },
    { kind: "money", field: `${P1}f1_75[0]`, line: "f1040.11a", zero: "print", expected: true },
    // ── Page 2 tax and credits ──
    { kind: "money", field: `${P2}f2_02[0]`, line: "f1040.12" }, // printed line 12e
    { kind: "money", field: `${P2}f2_03[0]`, line: "f1040.13a" },
    { kind: "money", field: `${P2}f2_05[0]`, line: "f1040.14" },
    { kind: "money", field: `${P2}f2_06[0]`, line: "f1040.15", zero: "print", expected: true },
    { kind: "money", field: `${P2}f2_08[0]`, line: "f1040.16", zero: "print" },
    { kind: "money", field: `${P2}f2_16[0]`, line: "f1040.24", zero: "print", expected: true },
    // ── Payments, refund, amount owed ──
    { kind: "money", field: `${P2}f2_20[0]`, line: "f1040.25d" },
    { kind: "money", field: `${P2}f2_29[0]`, line: "f1040.33", zero: "print" },
    { kind: "money", field: `${P2}f2_30[0]`, line: "f1040.34" },
    { kind: "money", field: `${P2}f2_35[0]`, line: "f1040.37" },
    // ── Filing status: five separate checkboxes (no radio groups on IRS forms); exactly one is checked ──
    { kind: "check", field: `${FS}c1_8[0]`, choice: "filingStatus", equals: "single", required: true, label: "filing status" },
    { kind: "check", field: `${FS}c1_8[1]`, choice: "filingStatus", equals: "mfj", required: true, label: "filing status" },
    { kind: "check", field: `${FS}c1_8[2]`, choice: "filingStatus", equals: "mfs", required: true, label: "filing status" },
    { kind: "check", field: `${P1}c1_8[0]`, choice: "filingStatus", equals: "hoh", required: true, label: "filing status" },
    { kind: "check", field: `${P1}c1_8[1]`, choice: "filingStatus", equals: "qss", required: true, label: "filing status" },
    // ── Digital assets Y/N: both stay unchecked until an attestation exists (open item) ──
    { kind: "check", field: `${P1}c1_10[0]`, choice: "digitalAssets", equals: "yes", required: true, label: "digital assets (yes/no)" },
    { kind: "check", field: `${P1}c1_10[1]`, choice: "digitalAssets", equals: "no", required: true, label: "digital assets (yes/no)" },
  ],
  tables: [],
  header: [
    { field: `${P1}f1_14[0]`, source: "household.taxpayerFirst" },
    { field: `${P1}f1_15[0]`, source: "household.taxpayerLast" },
    { field: `${P1}f1_17[0]`, source: "household.spouseFirst" },
    { field: `${P1}f1_18[0]`, source: "household.spouseLast" },
  ],
  blank: [
    // Never stored by this app, always blank for the CPA.
    { field: `${P1}f1_16[0]`, reason: "ssn" },
    { field: `${P1}f1_19[0]`, reason: "ssn" },
    { field: `${FS}f1_28[0]`, reason: "ssn" },
    { field: `${P2}SSN_ReadOrder[0].f2_22[0]`, reason: "ssn" },
    { match: /\.Address_ReadOrder\[0\]\./, reason: "contact_address" },
    { match: /\.Page2\[0\]\.(f2_40|f2_42|f2_44|f2_45)\[0\]$/, reason: "contact_address" },
    { match: /\.Page2\[0\]\.(RoutingNo\[0\]\.f2_32|AccountNo\[0\]\.f2_33|c2_16)\[\d\]$/, reason: "bank" },
    { match: /\.Page2\[0\]\.(f2_41|f2_43|f2_39)\[0\]$/, reason: "signature_pin" },
    { match: /\.Page2\[0\]\.(c2_17\[[01]\]|f2_37\[0\]|f2_38\[0\]|f2_4[6-9]\[0\]|f2_50\[0\]|f2_51\[0\]|c2_18\[0\])$/, reason: "preparer" },
    // Owner statement: no dependents.
    { match: /\.(Table_Dependents|Dependents_ReadOrder)\[0\]\./, reason: "owner_statement_na" },
    // Lines and boxes the full map (T2a) will take over.
    {
      match:
        /\.Page1\[0\]\.(f1_(0[1-9]|1[0-3]|29|30|4[89]|5[0-8]|60|6[2-9]|70|71)|c1_([1-7]|9|3[2-9]|4[0-4]))\[0\]$/,
      reason: "not_modeled",
    },
    { match: /\.Page2\[0\]\.(f2_01|f2_04|f2_07|f2_09|f2_1[0-5]|f2_1[7-9]|f2_21|f2_2[3-8]|f2_31|f2_34|f2_36)\[0\]$/, reason: "not_modeled" },
    { match: /\.Page2\[0\]\.(c2_[1-9]|c2_1[0-4]|c2_15|Line28_ReadOrder\[0\]\.c2_14)\[0\]$/, reason: "not_modeled" },
  ],
};
