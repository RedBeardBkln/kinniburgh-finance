// Derive the year a Document REFERENCES from what its extraction read
// (document-year-from-extraction). Pure and client-safe: no DB, no I/O, no
// "use server". Never guesses: returns null whenever the data is missing,
// malformed, inconsistent or implausible, and callers only ever write the
// result into a Document whose taxYear is currently NULL (a year the owner
// chose, or one set by another path, always wins).
//
// Conventions (deliberately identical to the three existing statement sites in
// actions/bank-statements.ts, which are NOT refactored onto this helper:
// finalizeStatementUpload (single mode), confirmBankStatement and
// retryStatementExtraction, each `taxYear: periodEnd.getUTCFullYear()`):
//   - a statement-like document belongs to the calendar year of its period END
//     (a 2024-12-28 .. 2025-01-27 statement is 2025);
//   - an annual tax form belongs to the taxYear printed on it.
// Those three sites take a `Date` from a different extractor
// (lib/bank-statement-extract.ts, stored on BankStatement.extractionData), not
// from Document.extractionData, so this helper's input does not fit without an
// adapter; they also overwrite an already-set year unconditionally, which this
// helper's callers never do. Keep the periodEnd-year convention in sync if it
// ever changes.
//
// Where the data lives: `period` ("YYYY-MM") is on the TOP level of the stored
// extraction object, NOT inside `data` (lib/doc-extract.ts prompts); we read the
// top level first and accept `data.period` defensively. `periodStart` /
// `periodEnd` / `taxYear` live in `data`.

import { isValidPriorYear } from "@/lib/tax-year-range";
import { resolveEffectiveExtraction } from "@/lib/extraction-effective";

/** Statement-like types: the year of the period END. */
const STATEMENT_DOC_TYPES: ReadonlySet<string> = new Set([
  "bank_statement",
  "statement",
  "credit_card_statement",
  "mortgage_statement",
  "utility_bill",
]);

/** Annual tax forms: `data.taxYear` as printed on the form. */
const ANNUAL_TAX_DOC_TYPES: ReadonlySet<string> = new Set([
  "w2",
  "1099",
  "k1",
  "mortgage_interest",
  "form_1098",
  "property_tax",
  "tax_return",
]);

// Everything else (insurance_policy, policy, other, extension, unknown) has no
// reliable single year and always derives null.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The year of a strict YYYY-MM-DD string that is a real calendar date, else null. No Date-in-local-time. */
function yearOfStrictDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const t = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC maps years 0..99 to 1900..1999; the round-trip check also rejects that.
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) return null;
  return year;
}

/** The year of a strict YYYY-MM string (month 01..12), else null. */
function yearOfStrictPeriod(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return m ? Number(m[1]) : null;
}

function plausible(year: number | null, currentYear: number): number | null {
  return year !== null && isValidPriorYear(year, currentYear) ? year : null;
}

function deriveStatementYear(top: Record<string, unknown>, data: Record<string, unknown> | null, currentYear: number): number | null {
  const endYear = data ? yearOfStrictDate(data.periodEnd) : null;
  if (data && endYear !== null) {
    // periodStart after periodEnd means the extraction contradicts itself.
    // Both are strict YYYY-MM-DD here, so string comparison is date order.
    const start = data.periodStart;
    const end = data.periodEnd;
    if (typeof start === "string" && typeof end === "string" && yearOfStrictDate(start) !== null && start > end) {
      return null;
    }
    return plausible(endYear, currentYear);
  }
  // periodEnd absent or invalid: fall back to the "YYYY-MM" period string
  // (top level first, then data.period defensively).
  const periodYear = yearOfStrictPeriod(top.period) ?? (data ? yearOfStrictPeriod(data.period) : null);
  return plausible(periodYear, currentYear);
}

function deriveAnnualTaxYear(data: Record<string, unknown> | null, currentYear: number): number | null {
  if (!data) return null;
  const y = data.taxYear;
  // Only an actual integer number: never coerce "2025" or truncate 2025.5.
  if (typeof y !== "number" || !Number.isInteger(y)) return null;
  return plausible(y, currentYear);
}

/**
 * The calendar year a document refers to, from its (already effective) extraction
 * object, or null when it cannot be told reliably. `docType` is the RAW
 * Document.docType; the classified names (credit_card_statement, form_1098) are
 * also accepted.
 */
export function deriveDocumentTaxYear(
  docType: string,
  extractionData: unknown,
  currentYear: number = new Date().getUTCFullYear()
): number | null {
  if (!isRecord(extractionData)) return null;
  const data = isRecord(extractionData.data) ? extractionData.data : null;
  if (STATEMENT_DOC_TYPES.has(docType)) return deriveStatementYear(extractionData, data, currentYear);
  if (ANNUAL_TAX_DOC_TYPES.has(docType)) return deriveAnnualTaxYear(data, currentYear);
  return null;
}

export interface YearFillSource {
  docType: string;
  extractionData: unknown;
  extractionCorrections: unknown;
  extractionConfirmedAt: Date | null;
}

/**
 * Same as deriveDocumentTaxYear but over the EFFECTIVE data: the owner's
 * corrections (a corrected taxYear, or a corrected null) win over the AI value.
 */
export function deriveEffectiveDocumentTaxYear(
  row: YearFillSource,
  currentYear: number = new Date().getUTCFullYear()
): number | null {
  const effective = resolveEffectiveExtraction({
    docType: row.docType,
    extractionData: row.extractionData,
    extractionCorrections: row.extractionCorrections,
    extractionConfirmedAt: row.extractionConfirmedAt,
  });
  return deriveDocumentTaxYear(row.docType, effective.extractionData, currentYear);
}

export interface YearFillPlan {
  fills: { id: string; year: number }[];
  /** Yearless documents whose extraction does not say a reliable year. */
  skippedNoYear: number;
}

/**
 * Single source for "which yearless documents can be filled, and with what":
 * used by BOTH the /documents page (the count) and the server action (the writes).
 * The caller passes only rows whose taxYear is already null.
 */
export function planYearFill(
  rows: ReadonlyArray<YearFillSource & { id: string }>,
  currentYear: number = new Date().getUTCFullYear()
): YearFillPlan {
  const fills: { id: string; year: number }[] = [];
  let skippedNoYear = 0;
  for (const row of rows) {
    const year = deriveEffectiveDocumentTaxYear(row, currentYear);
    if (year === null) skippedNoYear += 1;
    else fills.push({ id: row.id, year });
  }
  return { fills, skippedNoYear };
}

/** Confirm-dialog text for the /documents "fill in missing years" control. */
export function buildYearFillConfirmMessage(count: number): string {
  const docs = `${count} document${count === 1 ? "" : "s"}`;
  return (
    `Fill in the year on ${docs} that currently ${count === 1 ? "has" : "have"} no year?\n\n` +
    "The year comes from what was already read from each document (a statement's period end date, " +
    "a tax form's tax year). It only touches documents with no year and never changes a year that is " +
    "already set. It does not re-read any document and makes no AI calls. Documents with no readable " +
    "year are left as they are.\n\n" +
    "This applies to your whole vault, not just the documents currently shown."
  );
}
