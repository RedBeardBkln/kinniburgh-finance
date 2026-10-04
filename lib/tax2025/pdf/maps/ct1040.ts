// Field-to-line map for the Connecticut CT-1040 (TY2025), task T5. The CT PDF is FLAT
// (no form fields), so every field named here is one this app adds over a calibrated box
// (lib/tax2025/pdf/ct-overlay.ts, data/forms/2025/geometry/ct1040.json). The completeness
// test checks that this map claims all 96 of them exactly once.
//
//   page 1  lines 1-16 (CT AGI, tax, credits, use tax), names, filing status MFJ
//   page 2  line 17, withholding schedule 18a-18e (Column A employer ID, B CT wages,
//           C CT tax withheld), 18 total, 19-20d, 21-30 (overpayment 22 / tax due 26)
//   page 3  Schedule 1: every additions line 31-37 (incl. 36a), the line 38 total, every
//           subtractions line 39-49 (incl. 48a-48d) and the line 50 total
//   page 4  Schedule 3 property tax credit rows 60-62, lines 63 / 65 / 67 / 68, Schedule 4 lines 69b / 69
//
// Rules this map encodes:
//   - engine keys (rules/ct.ts, ct-credits.ts, ct-settlement.ts, payments.ts and the derive spine in return.ts):
//     ct1040.1 / 3 / additions / subtractions / ctAgi / 6 ... 30 and the Schedule 3 / 4 detail keys, plus the
//     Schedule 1 detail keys ct1040.s1.* (rules/ct-schedule1.ts). A detail line that is zero stays blank (like the
//     totals 38 / 50); one that is blocked stays blank and the cover lists it as a blocking item. No pending keys.
//   - Line 15 and Schedule 4 line 69 print "0" when use tax is answered 0 (the printed
//     instruction: "If no tax is due, enter 0"); an unanswered question stays BLANK with a
//     blocking item (never invented). Lines 8, 12, 14, 16, 17 and 21 also print "0" (the form says to enter 0).
//   - Lines 22 (overpayment) and 26 (tax due) are their own engine lines (ct1040.22 / ct1040.26): at most one is
//     non-zero and a zero prints blank. Line 25 (refund) is informational: the owner's elections on lines 23, 24
//     and 24a are never guessed, so 23 / 24 / 24a stay blank and 25 stays blank with an advisory item stating line 22.
//   - Schedule 3 rows come from the engine's own qualifying bills (ct-property-tax.ts): the
//     primary residence and up to two vehicles. Other real estate (56 Arbor Rd) is never listed. When the credit is
//     fully phased out (or line 10 is 0) the adapter leaves the whole schedule blank and says why on the cover.
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
  { kind: "money", field: f("l20a"), line: "ct1040.20a" },
  { kind: "money", field: f("l20b"), line: "ct1040.20b" },
  { kind: "money", field: f("l20c"), line: "ct1040.20c" },
  { kind: "money", field: f("l20d"), line: "ct1040.20d" },
  { kind: "money", field: f("l21"), line: "ct1040.21", zero: "print" },
  { kind: "money", field: f("l22"), line: "ct1040.22" }, // overpayment: line 21 more than line 17 (blank when 0)
  { kind: "money", field: f("l25"), line: "ct1040.25" }, // refund: informational while the owner has not made the 23 / 24 / 24a elections
  { kind: "money", field: f("l26"), line: "ct1040.26" }, // tax due: line 17 more than line 21 (blank when 0)
  { kind: "money", field: f("l27"), line: "ct1040.27" },
  { kind: "money", field: f("l28"), line: "ct1040.28" },
  { kind: "money", field: f("l29"), line: "ct1040.29" },
  { kind: "money", field: f("l30"), line: "ct1040.30" },
  // ── Page 3: Schedule 1 detail lines and totals ──
  { kind: "money", field: f("l31"), line: "ct1040.s1.31" },
  { kind: "money", field: f("l32"), line: "ct1040.s1.32" },
  { kind: "money", field: f("l33"), line: "ct1040.s1.33" },
  { kind: "money", field: f("l34"), line: "ct1040.s1.34" },
  { kind: "money", field: f("l35"), line: "ct1040.s1.35" },
  { kind: "money", field: f("l36"), line: "ct1040.s1.36" },
  { kind: "money", field: f("l36a"), line: "ct1040.s1.36a" },
  { kind: "money", field: f("l37"), line: "ct1040.s1.37" },
  { kind: "money", field: f("l38"), line: "ct1040.additions" },
  { kind: "money", field: f("l39"), line: "ct1040.s1.39" },
  { kind: "money", field: f("l40"), line: "ct1040.s1.40" },
  { kind: "money", field: f("l41"), line: "ct1040.s1.41" },
  { kind: "money", field: f("l42"), line: "ct1040.s1.42" },
  { kind: "money", field: f("l43"), line: "ct1040.s1.43" },
  { kind: "money", field: f("l44"), line: "ct1040.s1.44" },
  { kind: "money", field: f("l45"), line: "ct1040.s1.45" },
  { kind: "money", field: f("l46"), line: "ct1040.s1.46" },
  { kind: "money", field: f("l47"), line: "ct1040.s1.47" },
  { kind: "money", field: f("l48"), line: "ct1040.s1.48" },
  { kind: "money", field: f("l48a"), line: "ct1040.s1.48a" },
  { kind: "money", field: f("l48b"), line: "ct1040.s1.48b" },
  { kind: "money", field: f("l48c"), line: "ct1040.s1.48c" },
  { kind: "money", field: f("l48d"), line: "ct1040.s1.48d" },
  { kind: "money", field: f("l49"), line: "ct1040.s1.49" },
  { kind: "money", field: f("l50"), line: "ct1040.subtractions" },
  // ── Page 4: Schedule 3 lines 63 / 65 / 67 / 68 and Schedule 4 lines 69b / 69 ──
  { kind: "money", field: f("l63"), line: "ct1040.s3.63" },
  { kind: "money", field: f("l65"), line: "ct1040.s3.65" },
  { kind: "money", field: f("l67"), line: "ct1040.s3.67" },
  { kind: "money", field: f("l68"), line: "ct1040.11" },
  { kind: "money", field: f("l69b"), line: "ct1040.s4.69b" },
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
  // The description cell is one 148 pt line: "27 OLD BARRY ROAD, WATERFORD, CT 06385" needs a smaller font.
  fit: { description: "address" },
};

/**
 * Boxes with no engine line: left blank for the CPA to key (still editable). Each group carries a note, so the
 * cover LISTS them (a blank here is "not decided by the app", never a computed zero).
 */
const NOT_MODELED_GROUPS: ReadonlyArray<{ note: string; lines: readonly string[] }> = [
  { note: "line 18f: additional CT withholding from Schedule CT-1040WH", lines: ["18f"] },
  { note: "lines 23, 24, 24a: the owner's irrevocable overpayment elections (apply to 2026 estimated tax, CHET, charities); line 25 shows the refund relationship", lines: ["23", "24", "24a"] },
  { note: "Schedule 4 lines 69a, 69c, 69d (use tax at other rates; the engine figures only the 6.35% general rate, line 69b)", lines: ["69a", "69c", "69d"] },
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
