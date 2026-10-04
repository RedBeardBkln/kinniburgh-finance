// CSV export of the CPA review sheet (Phase 1c). Pure; built from the SheetModel so the
// file and the page can never disagree. One row per emitted line (federal, then
// Connecticut), in catalog order.
//
// Rules pinned by lib/__tests__/tax2025-sheet.test.ts:
//   - RFC 4180 quoting: a cell with a comma, quote, CR or LF is wrapped in quotes and
//     inner quotes are doubled;
//   - formula-injection guard: a TEXT cell that starts with = + - @ (or a tab / CR) is
//     prefixed with a single quote so a spreadsheet never evaluates it;
//   - the amount column is written from the whole-dollar number ONLY when the line
//     carries an amount (digits and an optional leading minus, exempt from the guard);
//     a line without an amount has an EMPTY amount cell, never 0;
//   - the override columns are reserved: empty unless an override note was supplied.

import {
  SHEET_STATUS_LABELS,
  overrideNote,
  type SheetFormGroup,
  type SheetLine,
  type SheetModel,
} from "@/lib/tax2025-sheet";

export const SHEET_CSV_COLUMNS = [
  "form",
  "line_id",
  "line_key",
  "label",
  "amount",
  "status",
  "provenance",
  "citation_reason",
  "override_amount",
  "override_by",
  "override_at",
  "override_reason",
] as const;

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Guard + RFC 4180 quoting for a TEXT cell. */
export function csvText(value: string): string {
  const guarded = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** A numeric cell (whole dollars): digits with an optional leading minus; never guarded, never quoted. */
export function csvNumber(value: number | null): string {
  return value === null ? "" : Number.isInteger(value) ? String(value) : "";
}

function provenanceText(l: SheetLine): string {
  return l.chips.map((c) => `${c.kind === "derived" || c.kind === "decision" ? "" : `${c.kind.replace(/_/g, " ")}: `}${c.label}`).join("; ");
}

function citationReasonText(l: SheetLine): string {
  const parts: string[] = [];
  if (l.reason !== null && l.reason.trim() !== "") parts.push(l.reason.trim());
  if (l.citations.length > 0) {
    parts.push(`Sources: ${l.citations.map((c) => (c.url !== null ? `${c.id} ${c.url}` : c.id)).join(" ; ")}`);
  }
  return parts.join(" | ");
}

export function sheetCsvRow(l: SheetLine): string {
  const ov = l.override;
  return [
    csvText(l.form),
    csvText(l.formLine),
    csvText(l.key),
    csvText(l.label),
    csvNumber(l.amount),
    csvText(SHEET_STATUS_LABELS[l.status]),
    csvText(provenanceText(l)),
    csvText(citationReasonText(l)),
    ov === null ? "" : csvNumber(ov.now),
    ov === null ? "" : csvText(ov.by),
    ov === null ? "" : csvText(ov.at),
    ov === null ? "" : csvText(overrideNote(ov)),
  ].join(",");
}

function rowsOf(groups: readonly SheetFormGroup[]): string[] {
  return groups.flatMap((g) => g.lines.map(sheetCsvRow));
}

/** The whole CSV text (CRLF line endings, trailing newline). */
export function sheetToCsv(model: SheetModel): string {
  const rows: string[] = [SHEET_CSV_COLUMNS.join(","), ...rowsOf(model.federal), ...rowsOf(model.connecticut)];
  // A closing row so the framing travels with the file (amount column stays empty).
  rows.push(
    [csvText("DRAFT NOTICE"), "", "", "", "", "", "", csvText(`${model.draftLabel}. Engine ${model.engineVersion}, generated ${model.generatedAtDisplay}. Lines with an empty amount are NOT zero: they are not computed.`), "", "", "", ""].join(",")
  );
  return `${rows.join("\r\n")}\r\n`;
}

export function sheetCsvFilename(model: SheetModel): string {
  return `ty${model.taxYear}-cpa-review-sheet-DRAFT.csv`;
}
