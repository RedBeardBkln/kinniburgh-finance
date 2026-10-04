// Field-to-line map for Form 8959 (Additional Medicare Tax), TY2025 (task T3). All 26
// fields are claimed exactly once. Names are the full AcroForm names from
// data/forms/2025/catalog/f8959.fields.json; f1_3 is line 1 ... f1_26 is line 24 (the
// form numbers its two header fields f1_1 / f1_2).
//
//   - Every printed line has an engine key (f8959.1 ... f8959.24); the railroad (RRTA) and
//     the Form 4137 / 8919 lines are "none" groups, not applicable for this household,
//     and print blank.
//   - Lines the form says to enter 0 on when the result is zero or less (6, 11, 12, 22) and
//     the totals (18, 24) print "0".
//   - The form is OMITTED from the packet when the engine reports it is not required
//     (engineFormId "f8959" -> Ty2025Return.formsRequired).

import type { LineKey } from "@/lib/tax2025/types";
import type { FormMap, MapLine } from "@/lib/tax2025/pdf/types";

const P = "topmostSubform[0].Page1[0].";

// Printed line -> field index (f1_<n>) and engine key; `zero` lines print "0" when computed as zero.
interface Printed {
  key: LineKey;
  n: number;
  zero?: true;
  expected?: true;
}

const PRINTED: readonly Printed[] = [
  { key: "f8959.1", n: 3, expected: true },
  { key: "f8959.2", n: 4 },
  { key: "f8959.3", n: 5 },
  { key: "f8959.4", n: 6 },
  { key: "f8959.5", n: 7 },
  { key: "f8959.6", n: 8, zero: true },
  { key: "f8959.7", n: 9 },
  { key: "f8959.8", n: 10 },
  { key: "f8959.9", n: 11 },
  { key: "f8959.10", n: 12 },
  { key: "f8959.11", n: 13, zero: true },
  { key: "f8959.12", n: 14, zero: true },
  { key: "f8959.13", n: 15 },
  { key: "f8959.14", n: 16 },
  { key: "f8959.15", n: 17 },
  { key: "f8959.16", n: 18 },
  { key: "f8959.17", n: 19 },
  { key: "f8959.18", n: 20, zero: true, expected: true },
  { key: "f8959.19", n: 21 },
  { key: "f8959.20", n: 22 },
  { key: "f8959.21", n: 23 },
  { key: "f8959.22", n: 24, zero: true },
  { key: "f8959.23", n: 25 },
  { key: "f8959.24", n: 26, zero: true, expected: true },
];

const lines: MapLine[] = PRINTED.map((p): MapLine => {
  const entry: MapLine = { kind: "money", field: `${P}f1_${p.n}[0]`, line: p.key };
  if (p.zero) entry.zero = "print";
  if (p.expected) entry.expected = true;
  return entry;
});

export const f8959Map: FormMap = {
  formId: "f8959",
  engineFormId: "f8959",
  lines,
  tables: [],
  header: [{ field: `${P}f1_1[0]`, source: "household.names" }],
  blank: [{ field: `${P}f1_2[0]`, reason: "ssn" }],
};
