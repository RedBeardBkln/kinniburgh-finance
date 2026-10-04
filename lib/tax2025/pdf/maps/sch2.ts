// Field-to-line map for Schedule 2 (Form 1040), TY2025, task T2a. All 63 fields are
// claimed exactly once. Every printed money line has an engine key (sch2.<line>, see
// lib/tax2025/line-catalog.ts SCH2); line 10 is "Reserved for future use" (no key, no
// field value). Eric's return uses lines 2 (AMT screen), 4 (SE tax), 11 (Additional
// Medicare Tax) and 12 (NIIT) plus the totals 3, 7, 21; the rare lines are
// not_applicable zeros (blank) or not_yet_computed (blank + advisory), never 0.
//
// Left blank on purpose: SSN (`ssn`); the "type" texts of 1y, 17a and 17z, the
// Form 4255 box groups of 1e/1f, the line 4 exemption boxes and its "specify" text,
// the line 8 "Form 5329 not required" box, and the reserved line 10 (`not_modeled`).

import { blanks, ids, money } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormMap } from "@/lib/tax2025/pdf/types";

const P1 = "form1[0].Page1[0].";
const P2 = "form1[0].Page2[0].";

export const sch2Map: FormMap = {
  formId: "f1040s2",
  lines: [
    // ── Part I: tax ──
    money(`${P1}Line1a_ReadOrder[0].f1_03[0]`, "sch2.1a"),
    money(`${P1}f1_04[0]`, "sch2.1b"),
    money(`${P1}f1_05[0]`, "sch2.1c"),
    money(`${P1}f1_06[0]`, "sch2.1d"),
    money(`${P1}f1_07[0]`, "sch2.1e"),
    money(`${P1}f1_08[0]`, "sch2.1f"),
    money(`${P1}f1_10[0]`, "sch2.1y"), // amount of 1y (f1_09 is the "type" text)
    money(`${P1}f1_11[0]`, "sch2.1z"),
    money(`${P1}f1_12[0]`, "sch2.2"),
    money(`${P1}f1_13[0]`, "sch2.3"),
    // ── Part II: other taxes ──
    money(`${P1}f1_15[0]`, "sch2.4"),
    money(`${P1}f1_16[0]`, "sch2.5"),
    money(`${P1}f1_17[0]`, "sch2.6"),
    money(`${P1}f1_18[0]`, "sch2.7"),
    money(`${P1}f1_19[0]`, "sch2.8"),
    money(`${P1}f1_20[0]`, "sch2.9"),
    money(`${P1}f1_22[0]`, "sch2.11"),
    money(`${P1}f1_23[0]`, "sch2.12"),
    money(`${P1}f1_24[0]`, "sch2.13"),
    money(`${P1}f1_25[0]`, "sch2.14"),
    money(`${P1}f1_26[0]`, "sch2.15"),
    money(`${P1}f1_27[0]`, "sch2.16"),
    money(`${P2}Line17a_ReadOrder[0].f2_02[0]`, "sch2.17a"), // amount of 17a (f2_01 is the "type, form number" text)
    money(`${P2}f2_03[0]`, "sch2.17b"),
    money(`${P2}f2_04[0]`, "sch2.17c"),
    money(`${P2}f2_05[0]`, "sch2.17d"),
    money(`${P2}f2_06[0]`, "sch2.17e"),
    money(`${P2}f2_07[0]`, "sch2.17f"),
    money(`${P2}f2_08[0]`, "sch2.17g"),
    money(`${P2}f2_09[0]`, "sch2.17h"),
    money(`${P2}f2_10[0]`, "sch2.17i"),
    money(`${P2}f2_11[0]`, "sch2.17j"),
    money(`${P2}f2_12[0]`, "sch2.17k"),
    money(`${P2}f2_13[0]`, "sch2.17l"),
    money(`${P2}f2_14[0]`, "sch2.17m"),
    money(`${P2}f2_15[0]`, "sch2.17n"),
    money(`${P2}f2_16[0]`, "sch2.17o"),
    money(`${P2}f2_17[0]`, "sch2.17p"),
    money(`${P2}f2_18[0]`, "sch2.17q"),
    money(`${P2}f2_20[0]`, "sch2.17z"), // amount of 17z (f2_19 is the "type" text)
    money(`${P2}f2_21[0]`, "sch2.18"),
    money(`${P2}f2_22[0]`, "sch2.19"),
    money(`${P2}f2_23[0]`, "sch2.20"),
    money(`${P2}f2_24[0]`, "sch2.21"),
  ],
  tables: [],
  header: [{ field: `${P1}f1_01[0]`, source: "household.names" }],
  blank: [
    ...blanks("ssn", `${P1}f1_02[0]`),
    ...blanks(
      "not_modeled",
      // 1y "type" text
      `${P1}f1_09[0]`,
      // 1e and 1f Form 4255 check boxes (4 each)
      ...[0, 1, 2, 3].map((i) => `${P1}Line1e_ReadOrder[0].c1_1[${i}]`),
      ...[0, 1, 2, 3].map((i) => `${P1}Line1f_ReadOrder[0].c1_2[${i}]`),
      // 4 exemption boxes (4361, 4029, other) and the "specify" text
      ...ids(`${P1}Line4_ReadOrder[0].`, "c1_3", "c1_4", "c1_5", "f1_14"),
      // 8 "Form 5329 not required" box, 10 reserved
      `${P1}Line8_ReadOrder[0].c1_6[0]`,
      `${P1}f1_21[0]`,
      // 17a "type, form number" and 17z "type" texts
      `${P2}Line17a_ReadOrder[0].Line17_ReadOrder[0].f2_01[0]`,
      `${P2}Line17z_ReadOrder[0].f2_19[0]`,
    ),
  ],
};
