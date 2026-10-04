// Field-to-line map for Schedule 3 (Form 1040), TY2025, task T2a. All 37 fields are
// claimed exactly once. Every printed money line has an engine key (sch3.<line>, see
// lib/tax2025/line-catalog.ts SCH3); line 6e is "Reserved for future use" (no key).
// Form 5695 is dropped by the owner (solar credit already taken in 2022), so 5a / 5b
// print only if the engine ever emits a non-zero amount (a carryforward is an open item).
//
// Left blank on purpose: SSN (`ssn`); the "type" texts of 6z and 13z and the reserved
// line 6e (`not_modeled`).

import { blanks, money } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormMap } from "@/lib/tax2025/pdf/types";

const P1 = "topmostSubform[0].Page1[0].";

export const sch3Map: FormMap = {
  formId: "f1040s3",
  engineFormId: "sch3",
  lines: [
    // ── Part I: nonrefundable credits ──
    money(`${P1}f1_03[0]`, "sch3.1"),
    money(`${P1}f1_04[0]`, "sch3.2"),
    money(`${P1}f1_05[0]`, "sch3.3"),
    money(`${P1}f1_06[0]`, "sch3.4"),
    money(`${P1}f1_07[0]`, "sch3.5a"),
    money(`${P1}f1_08[0]`, "sch3.5b"),
    money(`${P1}Line6a_ReadOrder[0].f1_09[0]`, "sch3.6a"),
    money(`${P1}f1_10[0]`, "sch3.6b"),
    money(`${P1}f1_11[0]`, "sch3.6c"),
    money(`${P1}f1_12[0]`, "sch3.6d"),
    money(`${P1}f1_14[0]`, "sch3.6f"),
    money(`${P1}f1_15[0]`, "sch3.6g"),
    money(`${P1}f1_16[0]`, "sch3.6h"),
    money(`${P1}f1_17[0]`, "sch3.6i"),
    money(`${P1}f1_18[0]`, "sch3.6j"),
    money(`${P1}f1_19[0]`, "sch3.6k"),
    money(`${P1}f1_20[0]`, "sch3.6l"),
    money(`${P1}f1_21[0]`, "sch3.6m"),
    money(`${P1}f1_23[0]`, "sch3.6z"), // amount of 6z (Line6z_ReadOrder.f2_22 is the "type" text)
    money(`${P1}f1_24[0]`, "sch3.7"),
    money(`${P1}f1_25[0]`, "sch3.8"),
    // ── Part II: other payments and refundable credits ──
    money(`${P1}f1_26[0]`, "sch3.9"),
    money(`${P1}f1_27[0]`, "sch3.10"),
    money(`${P1}f1_28[0]`, "sch3.11"),
    money(`${P1}f1_29[0]`, "sch3.12"),
    money(`${P1}Line13_ReadOrder[0].f1_30[0]`, "sch3.13a"),
    money(`${P1}f1_31[0]`, "sch3.13b"),
    money(`${P1}f1_32[0]`, "sch3.13c"),
    money(`${P1}f1_33[0]`, "sch3.13d"),
    money(`${P1}f1_35[0]`, "sch3.13z"), // amount of 13z (Line13z_ReadOrder.f1_34 is the "type" text)
    money(`${P1}f1_36[0]`, "sch3.14"),
    money(`${P1}f1_37[0]`, "sch3.15"),
  ],
  tables: [],
  header: [{ field: `${P1}f1_01[0]`, source: "household.names" }],
  blank: [
    ...blanks("ssn", `${P1}f1_02[0]`),
    ...blanks(
      "not_modeled",
      // 6e reserved; 6z and 13z "type" texts
      `${P1}f1_13[0]`,
      `${P1}Line6z_ReadOrder[0].f2_22[0]`,
      `${P1}Line13z_ReadOrder[0].f1_34[0]`,
    ),
  ],
};
