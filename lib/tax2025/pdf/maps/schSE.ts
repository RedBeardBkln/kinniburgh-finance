// Field-to-line map for Schedule SE (Form 1040), TY2025, task T2b. All 27 fields are
// claimed exactly once. Every printed money line has an engine key (se.<line>, the
// engine's prefix is `se`, not `schse`; see lib/tax2025/line-catalog.ts SE and
// lib/tax2025/rules/se-medicare.ts): 1a-1b farm, 2 Schedule C profit, 3, 4a-4c, 5a-5b,
// 6, 7 (the 2025 maximum; pre-printed, not filled), 8a-8d, 9, 10, 11, 12 (to Schedule 2 line 4), 13 (to
// Schedule 1 line 15) and the Part II optional-method lines 14-17.
//
// The name is the person with self-employment income: the map uses the taxpayer name
// (household.taxpayer), so the view's header.taxpayerName must be the Schedule C owner
// (the owner of EK Consulting). SSN is never stored (`ssn`). The minister Form 4361 box
// (A) is `not_modeled`.

import { blanks, money } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormMap } from "@/lib/tax2025/pdf/types";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";

export const schSEMap: FormMap = {
  formId: "f1040sse",
  engineFormId: "schse",
  lines: [
    // ── Part I: self-employment tax ──
    money(`${P1}f1_3[0]`, "se.1a"),
    money(`${P1}f1_4[0]`, "se.1b"),
    money(`${P1}f1_5[0]`, "se.2"),
    money(`${P1}f1_6[0]`, "se.3"),
    money(`${P1}f1_7[0]`, "se.4a"),
    money(`${P1}f1_8[0]`, "se.4b"),
    money(`${P1}f1_9[0]`, "se.4c"),
    money(`${P1}Line5a_ReadOrder[0].f1_10[0]`, "se.5a"),
    money(`${P1}f1_11[0]`, "se.5b"),
    money(`${P1}f1_12[0]`, "se.6"),
    money(`${P1}Line8a_ReadOrder[0].f1_14[0]`, "se.8a"),
    money(`${P1}f1_15[0]`, "se.8b"),
    money(`${P1}f1_16[0]`, "se.8c"),
    money(`${P1}f1_17[0]`, "se.8d"),
    money(`${P1}f1_18[0]`, "se.9"),
    money(`${P1}f1_19[0]`, "se.10"),
    money(`${P1}f1_20[0]`, "se.11"),
    money(`${P1}f1_21[0]`, "se.12"),
    money(`${P1}f1_22[0]`, "se.13"),
    // ── Part II: optional methods ──
    money(`${P2}f2_2[0]`, "se.15"),
    money(`${P2}f2_3[0]`, "se.16"),
    money(`${P2}f2_4[0]`, "se.17"),
  ],
  tables: [],
  header: [{ field: `${P1}f1_1[0]`, source: "household.taxpayer" }],
  blank: [
    ...blanks("ssn", `${P1}f1_2[0]`),
    // A. minister / Form 4361 box
    ...blanks("not_modeled", `${P1}c1_1[0]`),
    // Line 7 (the $176,100 maximum) and line 14 (the optional-method maximum) are PRE-PRINTED on the form: the
    // fields are read-only, 1-pt-wide dummy widgets laid over the printed constant (maps tester D1). Nothing is
    // written into them; the engine still computes se.7 / se.14 and the printed constant matches it.
    ...blanks("not_modeled", `${P1}f1_13[0]`, `${P2}f2_1[0]`),
  ],
};
