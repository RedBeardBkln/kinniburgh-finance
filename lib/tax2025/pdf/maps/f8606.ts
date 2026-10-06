// Field-to-line map for Form 8606 (Nondeductible IRAs), TY2025. All 45 AcroForm fields of the blank are claimed exactly once
// (completeness test). Names are the full AcroForm names from data/forms/2025/catalog/f8606.fields.json.
//
// ONE FORM PER PERSON. The IRS says a married couple files a separate Form 8606 for each spouse ("If you file a joint return,
// enter only the name and SSN of the spouse whose information is being reported", 2025 Form 8606 instructions). The map is
// written against the taxpayer-A line keys (f8606a.1, .2, .3, .14); `copies` produces one sheet per person that has a Form 8606
// to file, and for taxpayer B re-keys that person's lines as the A keys inside the copy's view (FormCopy.lines), so
// fillForm and the review's read-back (copies.ts viewForCopy) work unchanged. The file names are f8606-a.pdf / f8606-b.pdf.
//
// What prints (the form's own flow box after line 3: "In 2025, did you take a distribution from a traditional IRA, or make a
// Roth IRA conversion? No: Enter the amount from line 3 on line 14. Do not complete the rest of Part I."):
//   * the person's NAME (the household name of that person; only that spouse's name, never the household names);
//   * line 1 (nondeductible contributions for 2025), line 2 (basis from earlier years: prints "0" only on the owner's
//     statement), line 3 (1 + 2) and line 14 (total basis for 2025 and earlier years).
// Left blank: SSN, the stand-alone address block, lines 4-13 and 15a-15c (only with an IRA distribution or a Roth
// conversion, which the engine blocks rather than figures), Parts II and III (Roth conversions and Roth distributions) and the
// paid-preparer block. The line-10 decimal is two digit boxes (f1_18, f1_19), blank with the rest of lines 4-13.
//
// The form is OMITTED from the packet when the engine reports it is not required (engineFormId "f8606" ->
// Ty2025Return.formsRequired: a nondeductible contribution to a traditional IRA).
//
// XFA quirk: the speak text of f1_09, f2_01, f2_04 and f2_07 is the section header, not the line; the rect positions and the
// printed layout decide (data/forms/2025/line-labels.json has the printed line of every field, found independently).

import { blanks, money, notedBlanks } from "@/lib/tax2025/pdf/maps/dsl";
import type { FormCopy, FormMap, LineRef, MapLine, PdfLine, PdfReturnView } from "@/lib/tax2025/pdf/types";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";
const f1 = (n: string): string => `${P1}f1_${n}[0]`;
const f2 = (n: string): string => `${P2}f2_${n}[0]`;

/** The answer key the copy's view carries for the name on the form. */
export const F8606_NAME_ANSWER = "f8606.name";
/** The per-person answers the adapter sets (the household name of each questionnaire person); copies move one into F8606_NAME_ANSWER. */
export const f8606NameAnswerOf = (slot: "a" | "b"): string => `f8606.${slot}.name`;

/** The lines the map prints, as taxpayer-A keys; `n` is the printed line. */
const PRINTED = [
  { n: "1", field: f1("09") },
  { n: "2", field: f1("10") },
  { n: "3", field: f1("11") },
  { n: "14", field: f1("23") },
] as const;

const lines: MapLine[] = [
  { kind: "text", field: f1("01"), answer: F8606_NAME_ANSWER, label: "Name on Form 8606" },
  // Lines 1, 2, 3 and 14 print "0" when computed as zero (line 2 is 0 by the owner's statement; the form wants an explicit entry).
  ...PRINTED.map((p) => money(p.field, `f8606a.${p.n}` as LineRef, { zero: "print" })),
];

const NOTE_LINES_4_13 =
  "Form 8606 lines 4-13 and 15a-15c are completed only with a distribution from a traditional IRA or a Roth conversion, which this app does not fill in. With no distribution and no conversion (your statements) the form says to enter the amount from line 3 on line 14 and stop; with one, fill those lines in yourself from the 2025 Form 8606 instructions.";
const NOTE_PARTS_II_III =
  "Form 8606 Part II (conversions from traditional IRAs to Roth IRAs) and Part III (distributions from Roth IRAs) apply only with a Roth conversion or a Roth IRA distribution, which this app does not fill in.";

/** Copy for one person: their lines re-keyed as the taxpayer-A lines the map reads. */
function copyFor(slot: "a" | "b", view: PdfReturnView): FormCopy | null {
  const first = view.lines[`f8606${slot}.1`];
  // No line at all or "no Form 8606 for this person": nothing to file for them (a blocked line still gets a sheet: the blanks are the point).
  if (first === undefined || first.status === "not_applicable") return null;
  const mapped: Partial<Record<LineRef, PdfLine>> = {};
  for (const p of PRINTED) {
    const src = view.lines[`f8606${slot}.${p.n}` as LineRef];
    if (src !== undefined) mapped[`f8606a.${p.n}` as LineRef] = src;
  }
  const name = view.answers[f8606NameAnswerOf(slot)];
  return {
    suffix: slot,
    // The label is the cover / index note for the sheet: line 2 is the owner's answer (the app holds no 2024 Form 8606 to check it against).
    label: `Taxpayer ${slot.toUpperCase()}: Part I lines 1-3 and 14 (line 2 is your answer from the 2024 Form 8606 line 14)`,
    answers: { [F8606_NAME_ANSWER]: typeof name === "string" ? name : null },
    tables: {},
    lines: mapped,
  };
}

/** One sheet per person with a Form 8606 to file; none when neither person has one (a blank form is then filed once). */
export function f8606Copies(view: PdfReturnView): FormCopy[] {
  return (["a", "b"] as const).flatMap((slot) => {
    const c = copyFor(slot, view);
    return c === null ? [] : [c];
  });
}

export const f8606Map: FormMap = {
  formId: "f8606",
  engineFormId: "f8606",
  lines,
  tables: [],
  // The name is per person (an answer supplied by the copy), never the household names.
  header: [],
  copies: f8606Copies,
  blank: [
    ...blanks("ssn", f1("02")),
    // the stand-alone address block (home address, apartment, city, three foreign-address boxes): only for a form filed by itself
    ...notedBlanks(
      "contact_address",
      "Form 8606 address block: it is for a Form 8606 filed by itself; filed with the return it stays blank.",
      f1("03"),
      f1("04"),
      f1("05"),
      f1("06"),
      f1("07"),
      f1("08")
    ),
    // lines 4-9, 10 (two digit boxes), 11-13
    ...notedBlanks("owner_statement_na", NOTE_LINES_4_13, ...["12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22"].map(f1)),
    // page 2: 15a-15c
    ...notedBlanks("owner_statement_na", NOTE_LINES_4_13, f2("01"), f2("02"), f2("03")),
    // Part II (16-18) and Part III (19-25c)
    ...notedBlanks("owner_statement_na", NOTE_PARTS_II_III, ...["04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15"].map(f2)),
    // paid preparer use only (self-prepared)
    ...blanks("preparer", f2("16"), `${P2}c2_1[0]`, f2("17"), f2("18"), f2("19"), f2("20"), f2("21")),
  ],
};
