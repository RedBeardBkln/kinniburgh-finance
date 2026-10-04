// Pure rules for naming a document (retirement-contribution-document-type, part B).
// No DB, no server imports, no I/O: safe in a client component.
//
// Two jobs:
//   1. validate a name the owner typed in the /documents "Rename" control;
//   2. when a document's tax year changes, refresh its AUTO-GENERATED name for
//      the new year (a property tax bill the AI read as 2024 is named
//      "Property Tax Bill (2024)"; correcting the year to 2025 must not leave
//      "(2024)" in the name) - and NEVER touch a name the owner typed.
//
// "Auto-generated" means: the name is exactly what generateDocumentName
// (lib/doc-naming.ts) produces for one of the years the document could have been
// named for, from one of the readings it could have been named from. A name that
// differs in any way (the owner renamed it) is not auto and is left alone.

import { documentTypeLabel, generateDocumentName } from "@/lib/doc-naming";

export const DOCUMENT_NAME_MAX = 200;

export type DocumentNameValidation = { ok: true; name: string } | { ok: false; error: string };

/** Trims; 1-200 characters. The same limits the rename action's zod schema enforces. */
export function validateDocumentName(raw: unknown): DocumentNameValidation {
  if (typeof raw !== "string") return { ok: false, error: "Enter a name for the document." };
  const name = raw.trim();
  if (name === "") return { ok: false, error: "Enter a name for the document." };
  if (name.length > DOCUMENT_NAME_MAX) {
    return { ok: false, error: `The name can be at most ${DOCUMENT_NAME_MAX} characters.` };
  }
  return { ok: true, name };
}

type DataObject = Record<string, unknown>;

/** The name generateDocumentName gives `data` when the document is "for" `year` (null = no year). */
function autoNameFor(docType: string, year: number | null, data: DataObject): string {
  // generateDocumentName reads only `data` (and the doc type string passed first).
  return generateDocumentName(docType, year, { docType: "other", data: { ...data, taxYear: year } });
}

export interface AutoNameRefreshInput {
  docType: string;
  /** The document's current name (null/blank = never named). */
  documentName: string | null;
  /**
   * Every year the old name could have been generated for: the year the document
   * was filed under and the year its reading said before the change. null = none.
   */
  oldYears: readonly (number | null | undefined)[];
  /** The year after the change; null (cleared) never renames anything. */
  newYear: number | null;
  /** The reading(s) (`extractionData.data`) the old name could have been generated from: the AI's, and the corrected one. */
  dataVariants: readonly DataObject[];
}

/**
 * The refreshed name when `documentName` is auto-generated and the year changed,
 * else null (leave the name alone). Never returns the same name it was given.
 */
export function refreshAutoNameForYear(input: AutoNameRefreshInput): string | null {
  const { docType, newYear } = input;
  if (newYear === null || !Number.isInteger(newYear)) return null;

  const variants: readonly DataObject[] = input.dataVariants.length > 0 ? input.dataVariants : [{}];
  const current = (input.documentName ?? "").trim();

  // Never named: nothing to refresh (the list shows the upload note in that case, which a new name would hide).
  if (current === "") return null;

  // The bare type label ("Property Tax Bill") is the placeholder name.
  if (current === documentTypeLabel(docType)) {
    const next = autoNameFor(docType, newYear, variants[0] ?? {});
    return next === current ? null : next;
  }

  const oldYears: (number | null)[] = [];
  for (const y of input.oldYears) {
    const year = typeof y === "number" && Number.isInteger(y) ? y : null;
    if (!oldYears.includes(year)) oldYears.push(year);
  }
  if (!oldYears.includes(null)) oldYears.push(null);

  for (const data of variants) {
    for (const oldYear of oldYears) {
      if (oldYear === newYear) continue;
      if (autoNameFor(docType, oldYear, data) !== current) continue;
      const next = autoNameFor(docType, newYear, data);
      return next === current ? null : next;
    }
  }
  return null;
}
