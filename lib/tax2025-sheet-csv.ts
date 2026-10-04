// CSV export of the return review sheet (Phase 1c). Pure; built from the SheetModel so the
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
//   - the DRAFT label is the FIRST row (then the header row) and the closing notice row repeats it;
//   - overrides (T9b): `amount` is the EFFECTIVE amount (the override value for an overridden
//     line) and the status cell says "Owner override" ("Advisor override" for a row recorded earlier). The first 12 columns keep
//     their meaning (override_amount = the pinned whole dollars, override_by, override_at as
//     YYYY-MM-DD in America/New_York, override_reason = the reason text); the columns after them
//     are appended: computed_amount (what the engine computed), override_authority,
//     override_version, override_stale, override_note (the same sentence the sheet, the PDF field
//     note and the cover print) and depends_on_override (lines this one depends on that were
//     overridden and NOT recomputed). Every text cell goes through csvText.

import { overrideNote, type SheetFormGroup, type SheetLine, type SheetModel } from "@/lib/tax2025-sheet";

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
  "computed_amount",
  "override_authority",
  "override_version",
  "override_stale",
  "override_note",
  "depends_on_override",
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
    csvText(l.statusLabel),
    csvText(provenanceText(l)),
    csvText(citationReasonText(l)),
    ov === null ? "" : csvNumber(ov.nowAmount),
    ov === null ? "" : csvText(ov.by),
    ov === null ? "" : csvText(ov.atDate),
    ov === null ? "" : csvText(ov.reason),
    ov === null ? "" : csvNumber(ov.computedAmount),
    ov === null ? "" : csvText(ov.authorityLabel),
    ov === null ? "" : csvNumber(ov.version),
    ov === null ? "" : csvText(ov.stale ? "yes" : "no"),
    ov === null ? "" : csvText(overrideNote(ov)),
    l.dependsOnOverridden.length === 0 ? "" : csvText(l.dependsOnOverridden.map((d) => d.text).join("; ")),
  ].join(",");
}

function rowsOf(groups: readonly SheetFormGroup[]): string[] {
  return groups.flatMap((g) => g.lines.map(sheetCsvRow));
}

function noticeText(model: SheetModel): string {
  const base = `${model.draftLabel}. Engine ${model.engineVersion}, generated ${model.generatedAtDisplay}. Lines with an empty amount are NOT zero: they are not computed.`;
  const o = model.summary.overrides;
  if (o.lineCount === 0) return base;
  return `${base} ${o.lineCount} override(s) in force (see the override_* columns); ${o.totalsNotRecomputed ? "totals are NOT recomputed and lines that depend on an override are flagged in depends_on_override." : "no total depends on them."}`;
}

/** The whole CSV text (CRLF line endings, trailing newline). */
export function sheetToCsv(model: SheetModel): string {
  const width = SHEET_CSV_COLUMNS.length;
  // FIRST row: the DRAFT label (padded to the column count so every row still parses to the same number of cells), then the header.
  const draftRow = [csvText(model.draftLabel), ...Array.from({ length: width - 1 }, () => "")].join(",");
  const rows: string[] = [draftRow, SHEET_CSV_COLUMNS.join(","), ...rowsOf(model.federal), ...rowsOf(model.connecticut)];
  // A closing row so the framing travels with the file (amount column stays empty).
  const notice = Array.from({ length: width }, () => "");
  notice[0] = csvText("DRAFT NOTICE");
  notice[7] = csvText(noticeText(model));
  rows.push(notice.join(","));
  return `${rows.join("\r\n")}\r\n`;
}

export function sheetCsvFilename(model: SheetModel): string {
  return `ty${model.taxYear}-return-review-sheet-DRAFT.csv`;
}
