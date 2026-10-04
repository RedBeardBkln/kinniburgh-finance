// Field-to-line map for Form 8960 (Net Investment Income Tax, individuals), TY2025. All 38 fields are claimed
// exactly once. Names are the full AcroForm names from data/forms/2025/catalog/f8960.fields.json.
//
//   - Every printed money line of Parts I-III for an individual has an engine key (rules/form-8960.ts): f1_3 is
//     line 1 ... f1_21 is line 11, f1_22 is line 12 (key f8960.nii), f1_23 ... f1_26 are lines 13-16 and f1_27 is
//     line 17 (key f8960.niit, which Schedule 2 line 12 repeats).
//   - Lines the form says to enter 0 on (12, 15) and the tax lines (16, 17) print "0" when computed as zero; every
//     other zero prints blank (IRS convention, stated on the cover). A negative amount prints with a leading minus
//     (line 4a is a loss: -9,010).
//   - Left blank on purpose: the SSN / EIN field; the three election boxes (the section 6013(g) / 6013(h) elections
//     matter only with a nonresident-alien spouse, the Regulations section 1.1411-10(g) election only with
//     controlled-foreign-corporation or qualified-electing-fund stock); and the eight Parts IV and V fields (lines
//     18a-21, estates and trusts only).
//   - The form is OMITTED from the packet when the engine reports it is not required (engineFormId "f8960" ->
//     Ty2025Return.formsRequired: MAGI over the threshold and investment income).

import { blanks, money, notedBlanks } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormMap, MapLine } from "@/lib/tax2025/pdf/types";
import type { LineKey } from "@/lib/tax2025/types";

const P = "topmostSubform[0].Page1[0].";

interface Printed {
  key: LineKey;
  n: number;
  zero?: true;
}

const PRINTED: readonly Printed[] = [
  { key: "f8960.1", n: 3 },
  { key: "f8960.2", n: 4 },
  { key: "f8960.3", n: 5 },
  { key: "f8960.4a", n: 6 },
  { key: "f8960.4b", n: 7 },
  { key: "f8960.4c", n: 8 },
  { key: "f8960.5a", n: 9 },
  { key: "f8960.5b", n: 10 },
  { key: "f8960.5c", n: 11 },
  { key: "f8960.5d", n: 12 },
  { key: "f8960.6", n: 13 },
  { key: "f8960.7", n: 14 },
  { key: "f8960.8", n: 15 },
  { key: "f8960.9a", n: 16 },
  { key: "f8960.9b", n: 17 },
  { key: "f8960.9c", n: 18 },
  { key: "f8960.9d", n: 19 },
  { key: "f8960.10", n: 20 },
  { key: "f8960.11", n: 21 },
  { key: "f8960.nii", n: 22, zero: true },
  { key: "f8960.13", n: 23 },
  { key: "f8960.14", n: 24 },
  { key: "f8960.15", n: 25, zero: true },
  { key: "f8960.16", n: 26, zero: true },
  { key: "f8960.niit", n: 27, zero: true },
];

const lines: MapLine[] = PRINTED.map((p) => money(`${P}f1_${p.n}[0]`, p.key, p.zero ? { zero: "print" } : {}));

export const f8960Map: FormMap = {
  formId: "f8960",
  engineFormId: "f8960",
  lines,
  tables: [],
  header: [{ field: `${P}f1_1[0]`, source: "household.names" }],
  blank: [
    ...blanks("ssn", `${P}f1_2[0]`),
    // the three election boxes
    ...notedBlanks(
      "not_modeled",
      "Form 8960 election boxes (section 6013(g), section 6013(h), Regulations section 1.1411-10(g)): left unchecked; they matter only with a nonresident-alien spouse or controlled-foreign-corporation / qualified-electing-fund stock (nothing in the return indicates one; the owner states none for foreign corporations).",
      `${P}PartI[0].c1_1[0]`,
      `${P}PartI[0].c1_2[0]`,
      `${P}PartI[0].c1_3[0]`
    ),
    // Parts IV and V: lines 18a-21 are for estates and trusts
    ...blanks("form_na", ...[28, 29, 30, 31, 32, 33, 34, 35].map((n) => `${P}f1_${n}[0]`)),
  ],
};
