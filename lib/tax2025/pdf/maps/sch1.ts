// Field-to-line map for Schedule 1 (Form 1040), TY2025, task T2a. All 73 fields are
// claimed exactly once. Every printed money line has an engine key (sch1.<line>, see
// lib/tax2025/line-catalog.ts SCH1); the engine's none-groups make the rare lines
// not_applicable zeros (blank) or not_yet_computed (blank + advisory), never 0.
//
// Left blank on purpose:
//   - SSN (header) and the line 19b alimony recipient SSN: never stored (`ssn`).
//   - The one-line "type" texts of 8z and 24z, the 1099-K memo amount at the top of
//     page 1 (no engine key: it is a memo, not a return line), the 2b / 19c agreement
//     dates, the "check if" boxes of lines 4, 7, 14 and 20, the amount repaid on line 7
//     and the "Reserved for future use" line 22: `not_modeled`.

import { blanks, ids, money } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormMap } from "@/lib/tax2025/pdf/types";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";

export const sch1Map: FormMap = {
  formId: "f1040s1",
  lines: [
    // ── Part I: additional income ──
    money(`${P1}f1_04[0]`, "sch1.1"),
    money(`${P1}f1_05[0]`, "sch1.2a"),
    money(`${P1}f1_07[0]`, "sch1.3"),
    money(`${P1}f1_08[0]`, "sch1.4"),
    money(`${P1}f1_09[0]`, "sch1.5"),
    money(`${P1}f1_10[0]`, "sch1.6"),
    money(`${P1}f1_12[0]`, "sch1.7"),
    money(`${P1}Line8a_ReadOrder[0].f1_13[0]`, "sch1.8a"),
    money(`${P1}f1_14[0]`, "sch1.8b"),
    money(`${P1}f1_15[0]`, "sch1.8c"),
    money(`${P1}f1_16[0]`, "sch1.8d"),
    money(`${P1}f1_17[0]`, "sch1.8e"),
    money(`${P1}f1_18[0]`, "sch1.8f"),
    money(`${P1}f1_19[0]`, "sch1.8g"),
    money(`${P1}f1_20[0]`, "sch1.8h"),
    money(`${P1}f1_21[0]`, "sch1.8i"),
    money(`${P1}f1_22[0]`, "sch1.8j"),
    money(`${P1}f1_23[0]`, "sch1.8k"),
    money(`${P1}f1_24[0]`, "sch1.8l"),
    money(`${P1}f1_25[0]`, "sch1.8m"),
    money(`${P1}f1_26[0]`, "sch1.8n"),
    money(`${P1}f1_27[0]`, "sch1.8o"),
    money(`${P1}f1_28[0]`, "sch1.8p"),
    money(`${P1}f1_29[0]`, "sch1.8q"),
    money(`${P1}f1_30[0]`, "sch1.8r"),
    money(`${P1}f1_31[0]`, "sch1.8s"),
    money(`${P1}f1_32[0]`, "sch1.8t"),
    money(`${P1}f1_33[0]`, "sch1.8u"),
    money(`${P1}f1_34[0]`, "sch1.8v"),
    money(`${P1}f1_36[0]`, "sch1.8z"), // amount of 8z (f1_35 is the "type" text)
    money(`${P1}f1_37[0]`, "sch1.9"),
    money(`${P1}f1_38[0]`, "sch1.10"),
    // ── Part II: adjustments to income ──
    money(`${P2}f2_01[0]`, "sch1.11"),
    money(`${P2}f2_02[0]`, "sch1.12"),
    money(`${P2}f2_03[0]`, "sch1.13"),
    money(`${P2}f2_04[0]`, "sch1.14"),
    money(`${P2}f2_05[0]`, "sch1.15"),
    money(`${P2}f2_06[0]`, "sch1.16"),
    money(`${P2}f2_07[0]`, "sch1.17"),
    money(`${P2}f2_08[0]`, "sch1.18"),
    money(`${P2}f2_09[0]`, "sch1.19a"),
    money(`${P2}f2_12[0]`, "sch1.20"),
    money(`${P2}f2_13[0]`, "sch1.21"),
    money(`${P2}f2_15[0]`, "sch1.23"),
    money(`${P2}Line24a_ReadOrder[0].f2_16[0]`, "sch1.24a"),
    money(`${P2}f2_17[0]`, "sch1.24b"),
    money(`${P2}f2_18[0]`, "sch1.24c"),
    money(`${P2}f2_19[0]`, "sch1.24d"),
    money(`${P2}f2_20[0]`, "sch1.24e"),
    money(`${P2}f2_21[0]`, "sch1.24f"),
    money(`${P2}f2_22[0]`, "sch1.24g"),
    money(`${P2}f2_23[0]`, "sch1.24h"),
    money(`${P2}f2_24[0]`, "sch1.24i"),
    money(`${P2}f2_25[0]`, "sch1.24j"),
    money(`${P2}f2_26[0]`, "sch1.24k"),
    money(`${P2}f2_28[0]`, "sch1.24z"), // amount of 24z (f2_27 is the "type" text)
    money(`${P2}f2_29[0]`, "sch1.25"),
    money(`${P2}f2_30[0]`, "sch1.26"),
  ],
  tables: [],
  header: [{ field: `${P1}f1_01[0]`, source: "household.names" }],
  blank: [
    ...blanks("ssn", `${P1}f1_02[0]`, `${P2}Line19b_CombField[0].f2_10[0]`),
    ...blanks(
      "not_modeled",
      // 1099-K memo amount, 2b agreement date, line 4 check boxes, line 7 repaid box
      ...ids(P1, "f1_03", "f1_06", "c1_1", "c1_2"),
      `${P1}Line7_ReadOrder[0].c1_3[0]`,
      `${P1}Line7_ReadOrder[0].f1_11[0]`,
      // 8z and 24z "List type" texts
      `${P1}Line8z_ReadOrder[0].f1_35[0]`,
      `${P2}Line24z_ReadOrder[0].f2_27[0]`,
      // 14 and 20 check boxes, 19c agreement date, 22 reserved
      ...ids(P2, "c2_1", "c2_2", "f2_11", "f2_14"),
    ),
  ],
};
