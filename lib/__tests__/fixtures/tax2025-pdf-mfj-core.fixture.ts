// SYNTHETIC MFJ return for the 1040 + Schedules 1, 2, 3, A, C, SE golden tests (tasks
// T2a/T2b). Every name and number is invented ("Alex Example and Sam Q Example",
// "Example Consulting, LLC"); nothing here is read from, or resembles, the real return.
// Amounts are whole dollars exactly as the engine hands them to the PDF layer; they are
// roughly self-consistent (Schedule C profit 52,000 -> Schedule SE -> Schedule 1 line 15)
// but the tests only care about WHICH FIELD shows WHICH line, in hand-formatted text.
//
// Lines of the seven forms that are not listed in CORE_AMOUNTS are emitted as
// `not_applicable` zeros (what the engine does for a stated "none" group), so the golden
// tests also prove that a not-applicable line stays blank.

import { LINE_CATALOG } from "@/lib/tax2025/types";
import type { LineRef, PdfLine, PdfReturnView, PdfTableRow } from "@/lib/tax2025/pdf/types";
import { makeView, pdfLine } from "./tax2025-pdf-view.fixture";

/** Line-key prefixes of the seven forms of this fixture. */
export const CORE_PREFIXES = ["f1040.", "sch1.", "sch2.", "sch3.", "scha.", "schc.", "se."] as const;

/** Computed amounts (whole dollars). A listed 0 is a COMPUTED zero (prints blank except on zero:"print" lines). */
export const CORE_AMOUNTS: Readonly<Record<string, number>> = {
  // Form 1040
  "f1040.1a": 150000,
  "f1040.1z": 150000,
  "f1040.2b": 1200,
  "f1040.3a": 300,
  "f1040.3b": 800,
  "f1040.7a": 0,
  "f1040.8": 52000,
  "f1040.9": 204000,
  "f1040.10": 2315,
  "f1040.11a": 201685,
  "f1040.11b": 201685,
  "f1040.12e": 31800,
  "f1040.13a": 9937,
  "f1040.14": 41737,
  "f1040.15": 159948,
  "f1040.16": 24013,
  "f1040.17": 0,
  "f1040.18": 24013,
  "f1040.19": 0,
  "f1040.20": 150,
  "f1040.21": 150,
  "f1040.22": 23863,
  "f1040.23": 4844,
  "f1040.24": 28707,
  "f1040.25a": 21000,
  "f1040.25d": 21000,
  "f1040.26": 9000,
  "f1040.31": 3000,
  "f1040.32": 3000,
  "f1040.33": 33000,
  "f1040.34": 4293,
  "f1040.35a": 4293,
  "f1040.36": 0,
  "f1040.37": 0,
  // Schedule 1
  "sch1.3": 52000,
  "sch1.9": 0,
  "sch1.10": 52000,
  "sch1.13": 0,
  "sch1.15": 2315,
  "sch1.25": 0,
  "sch1.26": 2315,
  // Schedule 2
  "sch2.2": 0,
  "sch2.3": 0,
  "sch2.4": 4629,
  "sch2.7": 0,
  "sch2.11": 215,
  "sch2.12": 0,
  "sch2.21": 4844,
  // Schedule 3
  "sch3.1": 150,
  "sch3.8": 150,
  "sch3.10": 3000,
  "sch3.11": 0,
  "sch3.15": 3000,
  // Schedule A (itemizing: 31,800 > the 31,500 standard deduction)
  "scha.2": 201685,
  "scha.5a": 9000,
  "scha.5b": 6000,
  "scha.5c": 800,
  "scha.5d": 15800,
  "scha.5e": 15800,
  "scha.7": 15800,
  "scha.8a": 12000,
  "scha.8e": 12000,
  "scha.10": 12000,
  "scha.11": 4000,
  "scha.12": 0,
  "scha.14": 4000,
  "scha.17": 31800,
  // Schedule C (Example Consulting, LLC)
  "schc.1": 98000,
  "schc.2": 0,
  "schc.3": 98000,
  "schc.4": 0,
  "schc.5": 98000,
  "schc.6": 0,
  "schc.7": 98000,
  "schc.8": 1200,
  "schc.9": 0, // owner: no business mileage -> a computed confirmed 0 -> blank
  "schc.10": 0,
  "schc.11": 4500,
  "schc.13": 0,
  "schc.15": 2100,
  "schc.17": 3200,
  "schc.18": 1850,
  "schc.22": 640,
  "schc.23": 410,
  "schc.24a": 2750,
  "schc.24b": 975,
  "schc.25": 1320,
  "schc.26": 0,
  "schc.27b": 25555,
  "schc.28": 44500,
  "schc.29": 53500,
  "schc.30": 1500,
  "schc.31": 52000,
  "schc.48": 25555,
  // Schedule SE
  "se.2": 52000,
  "se.3": 52000,
  "se.4a": 48022,
  "se.4c": 48022,
  "se.6": 48022,
  "se.7": 176100,
  "se.8a": 150000,
  "se.8d": 150000,
  "se.9": 26100,
  "se.10": 3236,
  "se.11": 1393,
  "se.12": 4629,
  "se.13": 2315,
};

/** Part V rows: 8 items summing to schc.48 (25,555). */
export const PART_V_ITEMS: ReadonlyArray<readonly [string, number]> = [
  ["Software subscriptions", 9800],
  ["Professional dues", 1255],
  ["Bank and merchant fees", 2400],
  ["Telephone and internet", 3100],
  ["Education and training", 2200],
  ["Postage and delivery", 1800],
  ["Website and hosting", 3000],
  ["Subcontracted lab services", 2000],
];

export function partVRows(items: ReadonlyArray<readonly [string, number]> = PART_V_ITEMS): PdfTableRow[] {
  return items.map(([label, amount]) => ({ cells: { label, amount } }));
}

/** Every line of the seven forms: computed per CORE_AMOUNTS, everything else a not_applicable zero. */
export function coreLines(): Partial<Record<LineRef, PdfLine>> {
  const out: Partial<Record<LineRef, PdfLine>> = {};
  for (const meta of LINE_CATALOG) {
    if (!CORE_PREFIXES.some((p) => meta.key.startsWith(p))) continue;
    const amount = CORE_AMOUNTS[meta.key];
    out[meta.key] = pdfLine({
      key: meta.key,
      formLabel: meta.form,
      formLine: meta.formLine,
      label: meta.label,
      status: amount === undefined ? "not_applicable" : "computed",
      amount: amount ?? 0,
    });
  }
  return out;
}

/** Overrides one line of a lines map (returns a new map). */
export function withLine(
  lines: Partial<Record<LineRef, PdfLine>>,
  key: LineRef,
  patch: { status?: PdfLine["status"]; amount?: number | null; reason?: string | null },
): Partial<Record<LineRef, PdfLine>> {
  const meta = LINE_CATALOG.find((m) => m.key === key);
  if (!meta) throw new Error(`withLine: ${key} is not a LINE_KEY`);
  return {
    ...lines,
    [key]: pdfLine({
      key,
      formLabel: meta.form,
      formLine: meta.formLine,
      label: meta.label,
      status: patch.status ?? "computed",
      amount: patch.amount === undefined ? 0 : patch.amount,
      reason: patch.reason ?? null,
    }),
  };
}

/** The full MFJ fixture view: all seven forms' lines, the answers an adapter would supply, the Part V item table. */
export function coreView(over: Parameters<typeof makeView>[0] = {}): PdfReturnView {
  return makeView({
    lines: coreLines(),
    answers: {
      filingStatus: "mfj",
      "schC.accountingMethod": "cash",
      "schC.materialParticipation": "yes",
    },
    tables: { "schc.otherExpenses": partVRows() },
    ...over,
  });
}
