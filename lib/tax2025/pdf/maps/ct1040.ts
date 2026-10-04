// Field-to-line map for the Connecticut CT-1040 (TY2025), task T5. The CT PDF is FLAT
// (no form fields), so every field named here is one this app adds over a calibrated box
// (lib/tax2025/pdf/ct-overlay.ts, data/forms/2025/geometry/ct1040.json). The completeness
// test checks that this map claims all 96 of them exactly once.
//
//   page 1  lines 1-16 (CT AGI, tax, credits, use tax), names, filing status MFJ
//   page 2  line 17, withholding schedule 18a-18e (Column A employer ID, B CT wages,
//           C CT tax withheld), 18 total, 19-20, 21-30 (balance split into 22 / 26)
//   page 3  Schedule 1 additions (line 38) and subtractions (line 50) totals
//   page 4  Schedule 3 property tax credit rows 60-62 and line 68, Schedule 4 line 69
//
// Rules this map encodes:
//   - engine keys (rules/ct.ts, payments.ts): ct1040.1 / additions / subtractions / ctAgi /
//     6 / 9 / 10 / 11 / 15 / 18 / 19 / 20 / 27 / 28 / balance. Lines the engine does not emit
//     yet use the pending keys (pending-line-keys.ts) and fill automatically once it does.
//   - Line 15 and Schedule 4 line 69 print "0" when use tax is answered 0 (the printed
//     instruction: "If no tax is due, enter 0"); an unanswered question stays BLANK with a
//     blocking item (never invented).
//   - ct1040.balance is signed (positive = due): it prints on line 26 (tax due) when
//     positive and on line 22 (overpayment) when negative, before any penalty or interest.
//   - Schedule 3 rows come from the engine's own qualifying bills (ct-property-tax.ts): the
//     primary residence and up to two vehicles. Other real estate (56 Arbor Rd) is never listed.
//   - The form has no employer-name column in the withholding schedule, so the cover lists
//     the rows in order (coverList), and Column A holds the employer ID only when the facts
//     carry it.
//   - Identity: names only. SSN, signatures, bank, PIN and address areas have no overlay
//     field at all.

import type { FormMap, MapBlank, MapLine, MapTable } from "@/lib/tax2025/pdf/types";

const f = (suffix: string): string => `ct1040.${suffix}`;

const lines: MapLine[] = [
  // ── Page 1 ──
  { kind: "money", field: f("l1"), line: "ct1040.1", expected: true },
  { kind: "money", field: f("l2"), line: "ct1040.additions" },
  { kind: "money", field: f("l3"), line: "ct1040.3" },
  { kind: "money", field: f("l4"), line: "ct1040.subtractions" },
  { kind: "money", field: f("l5"), line: "ct1040.ctAgi", expected: true },
  { kind: "money", field: f("l6"), line: "ct1040.6", expected: true },
  { kind: "money", field: f("l7"), line: "ct1040.7" },
  { kind: "money", field: f("l8"), line: "ct1040.8", zero: "print" }, // "If Line 7 is greater than Line 6, enter 0"
  { kind: "money", field: f("l9"), line: "ct1040.9" },
  { kind: "money", field: f("l10"), line: "ct1040.10" },
  { kind: "money", field: f("l11"), line: "ct1040.11" },
  { kind: "money", field: f("l12"), line: "ct1040.12", zero: "print" }, // "If less than zero, enter 0"
  { kind: "money", field: f("l13"), line: "ct1040.13" },
  { kind: "money", field: f("l14"), line: "ct1040.14", zero: "print" }, // "If less than zero, enter 0"
  { kind: "money", field: f("l15"), line: "ct1040.15", zero: "print", expected: true }, // "If no tax is due, enter 0"
  { kind: "money", field: f("l16"), line: "ct1040.16", zero: "print" },
  // ── Page 2 ──
  { kind: "money", field: f("l17"), line: "ct1040.17", zero: "print" },
  { kind: "money", field: f("l18"), line: "ct1040.18" }, // total CT income tax withheld
  { kind: "money", field: f("l19"), line: "ct1040.19" },
  { kind: "money", field: f("l20"), line: "ct1040.20" },
  { kind: "money", field: f("l21"), line: "ct1040.21", zero: "print" },
  { kind: "money", field: f("l22"), line: "ct1040.balance", sign: "refund" }, // overpayment: the negative balance
  { kind: "money", field: f("l26"), line: "ct1040.balance", sign: "owed" }, // tax due: the positive balance
  { kind: "money", field: f("l27"), line: "ct1040.27" },
  { kind: "money", field: f("l28"), line: "ct1040.28" },
  // ── Page 3: Schedule 1 totals ──
  { kind: "money", field: f("l38"), line: "ct1040.additions" },
  { kind: "money", field: f("l50"), line: "ct1040.subtractions" },
  // ── Page 4: Schedule 3 line 68 and Schedule 4 line 69 ──
  { kind: "money", field: f("l68"), line: "ct1040.11" },
  { kind: "money", field: f("l69"), line: "ct1040.15", zero: "print" },
  // ── Filing status: the engine is MFJ-only, so only that box exists ──
  { kind: "check", field: f("fsMfj"), choice: "filingStatus", equals: "mfj", required: true, label: "CT-1040 filing status" },
];

const withholding: MapTable = {
  table: "ct.withholding",
  rows: ["a", "b", "c", "d", "e"].map((r) => ({
    ein: f(`l18${r}A`), // Column A: employer's federal ID number
    wages: f(`l18${r}B`), // Column B: Connecticut wages, tips, etc.
    withheld: f(`l18${r}`), // Column C: Connecticut income tax withheld
  })),
  amountColumn: "withheld",
  // The overflow row's note goes where the form has a text box in that row (Column A).
  labelColumn: "ein",
  overflow: "summary_row_and_statement",
  coverList: true,
};

const propertyTax: MapTable = {
  table: "ct.propertyTax",
  rows: ["60", "61", "62"].map((r) => ({ description: f(`l${r}d`), amount: f(`l${r}`) })),
  amountColumn: "amount",
  labelColumn: "description",
  overflow: "summary_row_and_statement",
};

/**
 * Boxes with no engine line: left blank for the CPA to key (still editable). Each group carries a note, so the
 * cover LISTS them (a blank here is "not decided by the app", never a computed zero).
 */
const NOT_MODELED_GROUPS: ReadonlyArray<{ note: string; lines: readonly string[] }> = [
  { note: "line 18f: additional CT withholding from Schedule CT-1040WH", lines: ["18f"] },
  { note: "lines 20a-20d: refundable credits (CT-EITC, claim of right, pass-through entity, historic home)", lines: ["20a", "20b", "20c", "20d"] },
  { note: "lines 23, 24, 24a, 25: the owner's refund / overpayment elections", lines: ["23", "24", "24a", "25"] },
  { note: "lines 29, 30: CT-2210 interest and the total amount due", lines: ["29", "30"] },
  {
    // only the totals 38 and 50 are engine lines
    note: "Schedule 1 detail lines 31-37 and 39-49 (the engine states only the totals, lines 38 and 50)",
    lines: ["31", "32", "33", "34", "35", "36", "36a", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "48a", "48b", "48c", "48d", "49"],
  },
  { note: "Schedule 3 lines 63, 65, 67 (property tax credit worksheet; the engine states them only in its explanation text)", lines: ["63", "65", "67"] },
  { note: "Schedule 4 lines 69a-69d (use tax detail; only the total, line 69, is an engine line)", lines: ["69a", "69b", "69c", "69d"] },
];

const blank: MapBlank[] = NOT_MODELED_GROUPS.flatMap((g) =>
  g.lines.map((l): MapBlank => ({ field: f(`l${l}`), reason: "not_modeled", note: `CT-1040 ${g.note}` })),
);

export const ct1040Map: FormMap = {
  formId: "ct1040",
  engineFormId: "ct1040",
  lines,
  tables: [withholding, propertyTax],
  header: [
    { field: f("firstName"), source: "household.taxpayerFirst" },
    { field: f("lastName"), source: "household.taxpayerLast" },
    { field: f("spouseFirstName"), source: "household.spouseFirst" },
    { field: f("spouseLastName"), source: "household.spouseLast" },
  ],
  blank,
};
